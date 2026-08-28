import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import { MediaRepository } from '../../worker/db/media';
import type { AppEnv } from '../../worker/env';
import { finalizedMediaObjectKey, mediaReservationObjectKey } from '../../worker/storage/media-keys';
import { getOrCreatePreview } from '../../worker/storage/previews';
import { exchangeEventEntry, withRecordingImages } from './helpers';

const testEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };
const origin = env.APP_ORIGIN;

function cookiesFrom(response: Response) {
  const value = response.headers.get('set-cookie') ?? '';
  const session = /candidary_session=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!session || !csrf) throw new Error(`Expected session and CSRF cookies, received: ${value}`);
  return { cookie: `candidary_session=${session}; candidary_csrf=${csrf}`, csrf };
}

async function guestAccess() {
  const created = await createApp().request('/api/events', {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      name: 'Maya & Theo', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      eventTimezone: 'America/Chicago', rsvpDeadlineDate: '2026-09-05',
    }),
  }, testEnv);
  const body = await created.json<any>();
  const exchange = await exchangeEventEntry(body.data.eventLink);
  const manager = cookiesFrom(created);
  // Photo delivery is permitted from creation but opens on the schedule, and
  // this event has not reached its own start, so the fixture opens it early as
  // a host would.
  const opened = await createApp().request(`/api/manage/events/${body.data.event.id}/photo-intake`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: manager.cookie,
      origin,
      'x-candidary-csrf': manager.csrf,
    },
    body: JSON.stringify({ action: 'open_early' }),
  }, testEnv);
  return {
    ...cookiesFrom(exchange),
    event: (await opened.json<any>()).data.event,
    eventLink: body.data.eventLink as string,
    manager,
  };
}

function writeHeaders(access: { cookie: string; csrf: string }) {
  return {
    'content-type': 'application/json',
    cookie: access.cookie,
    origin,
    'x-candidary-csrf': access.csrf,
  };
}

function uploadContent(
  access: Awaited<ReturnType<typeof guestAccess>>,
  media: { id: string },
  bytes: Uint8Array,
) {
  return createApp().request(`/api/event/${access.event.slug}/uploads/${media.id}/content`, {
    method: 'PUT',
    headers: {
      ...writeHeaders(access),
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }, testEnv);
}

/**
 * The durable row behind an upload.
 *
 * The upload responses are deliberate allowlists, so a claim about the object
 * key, the bytes, the reservation, or moderation has to be made against what
 * D1 actually holds rather than against the body the guest received. Reading it
 * here also keeps those claims honest: a field the guest never sees can still
 * be wrong, and this is the only place that would notice.
 */
async function mediaRow(mediaId: string) {
  const row = await testEnv.DB.prepare('SELECT * FROM media WHERE id = ?')
    .bind(mediaId).first<Record<string, any>>();
  if (!row) throw new Error(`Expected a durable media row for ${mediaId}.`);
  return row;
}

// The exact allowlists. Every guest-facing media body is compared against one
// of these key sets rather than spot-checked for a few absent fields, because a
// field that leaks back in is invisible to `not.toHaveProperty` on some other
// field.
const UPLOAD_MEDIA_KEYS = ['id', 'mimeType', 'uploadState'];
const GALLERY_MEDIA_KEYS = ['caption', 'guestName', 'id', 'previewAvailable'];
const CONTRIBUTION_MEDIA_KEYS = [
  'caption', 'createdAt', 'id', 'originalFilename', 'previewAvailable', 'uploadState',
];

function keysOf(value: unknown) {
  return Object.keys(value as object).sort();
}

/**
 * These bodies belong to exactly one signed-in reader. A shared cache keyed on
 * the URL alone would be free to hand one guest's contributions to the next, so
 * every one of them states both halves of that.
 */
function expectPrivateToOneReader(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
}

function png(width: number, height: number, size = 64) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

// The one Images fake, shared with the cover suites. The previous inline pair
// discarded every transform argument, so neither could support an assertion
// about the parameters a recipe actually requests.
function withImages(): AppEnv {
  return withRecordingImages({
    source: { width: 400, height: 300 },
    encode: () => ({ bytes: png(400, 300), width: 400, height: 300, contentType: 'image/webp' }),
  }).env;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
});

describe('upload initiation', () => {
  it('reserves quota and returns an authenticated same-origin upload ingress', async () => {
    const access = await guestAccess();
    const payload = {
      filename: 'our moment.png', mimeType: 'image/png', byteSize: 1024,
      idempotencyKey: 'upload-1', guestName: 'Avery', caption: 'From our table',
    };
    const first = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);
    const firstBody = await first.json<any>();
    const second = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);
    const secondBody = await second.json<any>();

    expect(first.status).toBe(201);
    expectPrivateToOneReader(first);
    // The reservation tells the queue what to upload and where, and nothing
    // else: no object key, no bucket generation, no byte or reservation
    // metadata, no guest name it already typed.
    expect(keysOf(firstBody.data))
      .toEqual(['alreadyDelivered', 'media', 'uploadUrl', 'uploadUrlExpiresAt']);
    expect(keysOf(firstBody.data.media)).toEqual(UPLOAD_MEDIA_KEYS);
    expect(firstBody.data.alreadyDelivered).toBe(false);
    expect(firstBody.data.uploadUrl)
      .toBe(`/api/event/${access.event.slug}/uploads/${firstBody.data.media.id}/content`);
    expect(firstBody.data.uploadUrl).not.toContain('X-Amz-Signature=');
    // The key is still derived from the event and the media id alone, and the
    // filename the guest chose never reaches R2 — it is simply no longer the
    // guest's business what it is.
    const reservedRow = await mediaRow(firstBody.data.media.id);
    expect(reservedRow.object_key).toBe(
      mediaReservationObjectKey(access.event.id, firstBody.data.media.id),
    );
    expect(reservedRow.object_key).not.toContain('our moment');
    // The expiry the queue is given is the row's own reservation window; the
    // idempotent retry reopened it, so the row now carries the second one.
    expect(Date.parse(firstBody.data.uploadUrlExpiresAt)).toBeGreaterThan(Date.now());
    expect(reservedRow.reservation_expires_at).toBe(secondBody.data.uploadUrlExpiresAt);
    expect(secondBody.data.media.id).toBe(firstBody.data.media.id);
    expect((await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()).reserved_media_count).toBe(1);
  });

  it('scopes an idempotency key to the actor instead of re-entering another guest row', async () => {
    const access = await guestAccess();
    const other = cookiesFrom(await exchangeEventEntry(access.eventLink));
    const payload = {
      filename: 'actor-scoped.png', mimeType: 'image/png', byteSize: 64,
      idempotencyKey: 'actor-scoped-key', guestName: 'Avery',
    };
    const first = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);
    const second = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(other), body: JSON.stringify(payload),
    }, testEnv);
    const firstMedia = (await first.json<any>()).data.media;
    const secondMedia = (await second.json<any>()).data.media;

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(secondMedia.id).not.toBe(firstMedia.id);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media WHERE event_id = ?')
      .bind(access.event.id).first<{ count: number }>())?.count).toBe(2);
  });

  it('rejects unsupported and oversized files before reserving quota', async () => {
    const access = await guestAccess();
    const unsupported = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'clip.gif', mimeType: 'image/gif', byteSize: 100, idempotencyKey: 'bad-1', guestName: 'Avery' }),
    }, testEnv);
    const oversized = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'huge.jpg', mimeType: 'image/jpeg', byteSize: 20 * 1024 * 1024 + 1, idempotencyKey: 'bad-2', guestName: 'Avery' }),
    }, testEnv);

    expect((await unsupported.json<any>()).code).toBe('FILE_TYPE_UNSUPPORTED');
    expect((await oversized.json<any>()).code).toBe('FILE_TOO_LARGE');
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media').first<{ count: number }>())?.count).toBe(0);
  });

  it('requires one trimmed guest-name field before reserving any file', async () => {
    const access = await guestAccess();
    const response = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'moment.jpg', mimeType: 'image/jpeg', byteSize: 100, idempotencyKey: 'nameless', guestName: '   ' }),
    }, testEnv);

    expect(response.status).toBe(422);
    expect((await response.json<any>()).fieldErrors).toEqual({ guestName: 'Your name is required.' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media').first<{ count: number }>())?.count).toBe(0);
  });

  it('rejects an unknown outer upload field instead of silently discarding it', async () => {
    const access = await guestAccess();
    const response = await createApp().request(`/api/event/${access.event.slug}/uploads/batch`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({
        guestName: 'Avery',
        files: [{
          filename: 'moment.png', mimeType: 'image/png', byteSize: 64,
          idempotencyKey: 'strict-outer',
        }],
        managerOnly: true,
      }),
    }, testEnv);

    expect(response.status).toBe(422);
    expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media')
      .first<{ count: number }>())?.count).toBe(0);
  });

  it('rejects an unknown nested upload-file field instead of silently discarding it', async () => {
    const access = await guestAccess();
    const response = await createApp().request(`/api/event/${access.event.slug}/uploads/batch`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({
        guestName: 'Avery',
        files: [{
          filename: 'moment.png', mimeType: 'image/png', byteSize: 64,
          idempotencyKey: 'strict-file', accountId: 'must-not-cross-the-wire',
        }],
      }),
    }, testEnv);

    expect(response.status).toBe(422);
    expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM media')
      .first<{ count: number }>())?.count).toBe(0);
  });

  it.each([
    ['phone.heic', 'image/x-heic', 'image/heic'],
    ['phone.heif', 'image/x-heif', 'image/heif'],
    ['burst.heic', 'image/x-heic-sequence', 'image/heic-sequence'],
    ['burst.heif', 'image/x-heif-sequence', 'image/heif-sequence'],
  ])('normalizes vendor phone MIME %s (%s)', async (filename, mimeType, expected) => {
    const access = await guestAccess();
    const response = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename, mimeType, byteSize: 100, idempotencyKey: `vendor-${expected}`, guestName: 'Avery' }),
    }, testEnv);

    expect(response.status).toBe(201);
    expect((await response.json<any>()).data.media.mimeType).toBe(expected);
  });

  it('reserves a batch in order and returns stable per-file success or failure', async () => {
    const access = await guestAccess();
    await env.DB.prepare('UPDATE events SET stored_media_count = 9999 WHERE id = ?').bind(access.event.id).run();
    const payload = {
      guestName: '  Avery  ',
      files: [
        { filename: 'phone.heic', mimeType: '', byteSize: 2048, idempotencyKey: 'batch-1' },
        { filename: 'second.jpg', mimeType: 'image/jpeg', byteSize: 2048, idempotencyKey: 'batch-2' },
        { filename: 'clip.gif', mimeType: 'image/gif', byteSize: 2048, idempotencyKey: 'batch-3' },
      ],
    };
    const send = () => createApp().request(`/api/event/${access.event.slug}/uploads/batch`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);

    const first = await send();
    const firstItems = (await first.json<any>()).data.items;
    const repeatedItems = (await (await send()).json<any>()).data.items;

    expect(first.status).toBe(201);
    expectPrivateToOneReader(first);
    expect(firstItems.map((item: any) => [item.idempotencyKey, item.status, item.error?.code])).toEqual([
      ['batch-1', 'accepted', undefined],
      ['batch-2', 'rejected', 'EVENT_MEDIA_LIMIT'],
      ['batch-3', 'rejected', 'FILE_TYPE_UNSUPPORTED'],
    ]);
    // Both batch shapes are exact. An accepted item still needing bytes carries
    // its writable path; a rejected one carries only the key it was asked about
    // and why it was refused, so a refusal cannot describe a row that does not
    // exist.
    expect(keysOf(firstItems[0]))
      .toEqual(['alreadyDelivered', 'idempotencyKey', 'media', 'status', 'uploadUrl', 'uploadUrlExpiresAt']);
    expect(keysOf(firstItems[0].media)).toEqual(UPLOAD_MEDIA_KEYS);
    expect(firstItems[0].media.mimeType).toBe('image/heic');
    expect(keysOf(firstItems[1])).toEqual(['error', 'idempotencyKey', 'status']);
    expect(keysOf(firstItems[1].error)).toEqual(['code', 'message']);
    // The trimmed guest name and the starting moderation state are the host's
    // to read, so they are proved on the row rather than in the guest's copy.
    expect(await mediaRow(firstItems[0].media.id)).toMatchObject({
      guest_name: 'Avery', publication_status: 'unpublished',
    });
    expect(repeatedItems[0].media.id).toBe(firstItems[0].media.id);
    expect((await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()).reserved_media_count).toBe(1);
  });

});

describe('upload finalization and private delivery', () => {
  it('keeps the exact guest claim-conflict answer when pause lands after reservation', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify({
        filename: 'pause-before-claim.png', mimeType: 'image/png', byteSize: 64,
        idempotencyKey: 'pause-before-claim', guestName: 'Avery',
      }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    await testEnv.DB.prepare('UPDATE events SET uploads_enabled = 0 WHERE id = ?')
      .bind(access.event.id).run();

    const response = await uploadContent(access, reserved, png(800, 600));

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      code: 'UPLOAD_FINALIZE_CONFLICT',
      message: 'This upload is already being secured. Wait a moment and try again.',
    });
    expect(await new MediaRepository(testEnv.DB).getById(reserved.id))
      .toMatchObject({ uploadState: 'reserved' });
    expect(await new MediaRepository(testEnv.DB).getPromotion(reserved.id))
      .toMatchObject({ state: 'pending' });
  });

  it('keeps the exact guest commit-conflict answer when pause lands after canonical PUT', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify({
        filename: 'pause-before-commit.png', mimeType: 'image/png', byteSize: 64,
        idempotencyKey: 'pause-before-commit', guestName: 'Avery',
      }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    const bucket = new Proxy(testEnv.CANONICAL_MEDIA_BUCKET, {
      get(target, property) {
        if (property === 'put') {
          return async (...args: Parameters<R2Bucket['put']>) => {
            const result = await target.put(...args);
            await testEnv.DB.prepare('UPDATE events SET uploads_enabled = 0 WHERE id = ?')
              .bind(access.event.id).run();
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const pausedEnv = { ...testEnv, CANONICAL_MEDIA_BUCKET: bucket } as AppEnv;
    const bytes = png(800, 600);

    const response = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}/content`,
      {
        method: 'PUT',
        headers: {
          ...writeHeaders(access), 'content-type': 'image/png', 'content-length': '64',
        },
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      },
      pausedEnv,
    );

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      code: 'UPLOAD_FINALIZE_CONFLICT',
      message: 'This upload changed while its bytes were being secured. Try again.',
    });
    expect(await new MediaRepository(testEnv.DB).getById(reserved.id))
      .toMatchObject({ uploadState: 'reserved' });
    expect(await new MediaRepository(testEnv.DB).getPromotion(reserved.id))
      .toMatchObject({ state: 'copying', finalPointerCommitted: false });
    expect(await new MediaRepository(testEnv.DB).getById(reserved.id))
      .not.toMatchObject({ objectBucketGeneration: 'canonical' });
    expect((await testEnv.DB.prepare(
      'SELECT reserved_media_count, stored_media_count FROM events WHERE id = ?',
    ).bind(access.event.id).first<Record<string, number>>()))
      .toEqual({ reserved_media_count: 1, stored_media_count: 0 });
  });

  it('keeps the canceled guest replay on the existing conflict code and message', async () => {
    const access = await guestAccess();
    const payload = {
      filename: 'canceled-guest.png', mimeType: 'image/png', byteSize: 64,
      idempotencyKey: 'canceled-guest', guestName: 'Avery',
    };
    const first = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);
    const reserved = (await first.json<any>()).data.media;
    const canceled = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}`,
      { method: 'DELETE', headers: writeHeaders(access), body: '{}' },
      testEnv,
    );
    const replay = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);

    expect(canceled.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(await replay.json<any>()).toMatchObject({
      code: 'UPLOAD_FINALIZE_CONFLICT',
      message: 'This photo was removed. Choose it again.',
    });
    expect(await new MediaRepository(testEnv.DB).getById(reserved.id))
      .toMatchObject({ uploadState: 'deleted' });
  });

  it('reopens an expired batch reservation with the same media id and finalizes the retry', async () => {
    const access = await guestAccess();
    const payload = {
      guestName: 'Avery',
      files: [{ filename: 'retry.png', mimeType: 'image/png', byteSize: 64, idempotencyKey: 'expired-retry' }],
    };
    const reserve = () => createApp().request(`/api/event/${access.event.slug}/uploads/batch`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(payload),
    }, testEnv);
    const firstMedia = (await (await reserve()).json<any>()).data.items[0].media;
    await env.DB.prepare('UPDATE media SET reservation_expires_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', firstMedia.id).run();
    const expired = await uploadContent(access, firstMedia, png(800, 600));
    expect((await expired.json<any>()).code).toBe('UPLOAD_RESERVATION_EXPIRED');

    const retriedMedia = (await (await reserve()).json<any>()).data.items[0].media;
    expect(retriedMedia).toMatchObject({ id: firstMedia.id, uploadState: 'reserved' });
    const delivered = await uploadContent(access, retriedMedia, png(800, 600));

    expect(delivered.status).toBe(200);
    expect((await delivered.json<any>()).data.media.uploadState).toBe('stored');
    expect((await env.DB.prepare('SELECT reserved_media_count, stored_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()))
      .toMatchObject({ reserved_media_count: 0, stored_media_count: 1 });
  });

  it('verifies R2 metadata and image headers, then finalizes idempotently', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'moment.png', mimeType: 'image/png', byteSize: 64, idempotencyKey: 'final-1', guestName: 'Avery' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    const first = await uploadContent(access, reserved, png(1600, 900));
    const firstBody = await first.json<any>();
    const repeated = await createApp().request(`/api/event/${access.event.slug}/uploads/${reserved.id}/finalize`, {
      method: 'POST', headers: writeHeaders(access), body: '{}',
    }, testEnv);

    const reservationKey = mediaReservationObjectKey(access.event.id, reserved.id);
    const finalKey = finalizedMediaObjectKey(access.event.id, reserved.id);

    expect(first.status).toBe(200);
    expectPrivateToOneReader(first);
    // The content PUT confirms the transfer and says nothing more. The measured
    // dimensions, the verified byte count, and the moderation state the host
    // will act on are all read back from D1.
    expect(keysOf(firstBody.data)).toEqual(['media']);
    expect(keysOf(firstBody.data.media)).toEqual(UPLOAD_MEDIA_KEYS);
    expect(firstBody.data.media).toMatchObject({ id: reserved.id, uploadState: 'stored' });
    expect(await mediaRow(reserved.id)).toMatchObject({
      publication_status: 'unpublished', width: 1600, height: 900, byte_size: 64,
      object_key: finalKey, object_bucket_generation: 'canonical',
    });
    expect(finalKey).not.toBe(reservationKey);
    expect(await env.MEDIA_BUCKET.head(reservationKey)).toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalKey)).not.toBeNull();
    expectPrivateToOneReader(repeated);
    // Finalize is the queue's confirmation, not a second delivery: an already
    // stored row answers with the same three fields and no writable URL.
    const repeatedBody = await repeated.json<any>();
    expect(keysOf(repeatedBody.data)).toEqual(['media']);
    expect(repeatedBody.data.media)
      .toEqual({ id: reserved.id, mimeType: 'image/png', uploadState: 'stored' });

    const ownContent = await createApp().request(`/api/media/${reserved.id}/content`, { headers: { cookie: access.cookie } }, withImages());
    expect(ownContent.status).toBe(200);
    expect(ownContent.headers.get('cache-control')).toBe('private, no-store');
    expect((await ownContent.arrayBuffer()).byteLength).toBe(64);
  });

  it('accepts exact authenticated bytes and rejects unauthenticated, delayed, or wrong-sized writes', async () => {
    const access = await guestAccess();
    const reserve = async (key: string, byteSize: number) => {
      const response = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
        method: 'POST', headers: writeHeaders(access),
        body: JSON.stringify({
          filename: `${key}.png`, mimeType: 'image/png', byteSize,
          idempotencyKey: key, guestName: 'Avery',
        }),
      }, testEnv);
      return (await response.json<any>()).data.media;
    };
    const bytes = png(800, 600);
    const media = await reserve('worker-ingress', bytes.byteLength);
    const reservationKey = mediaReservationObjectKey(access.event.id, media.id);
    const path = `/api/event/${access.event.slug}/uploads/${media.id}/content`;
    const unauthenticated = await createApp().request(path, {
      method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }, body: bytes,
    }, testEnv);
    expect(unauthenticated.status).toBe(401);
    expect(await testEnv.MEDIA_BUCKET.head(reservationKey)).toBeNull();

    const short = await createApp().request(path, {
      method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': String(bytes.byteLength - 1) }, body: bytes,
    }, testEnv);
    expect(short.status).toBe(422);
    expect(await testEnv.MEDIA_BUCKET.head(reservationKey)).toBeNull();

    const accepted = await createApp().request(path, {
      method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }, body: bytes,
    }, testEnv);
    expect(accepted.status).toBe(200);
    expectPrivateToOneReader(accepted);
    const stored = (await accepted.json<any>()).data.media;
    expect(keysOf(stored)).toEqual(UPLOAD_MEDIA_KEYS);
    expect(stored).toMatchObject({ id: media.id, uploadState: 'stored' });
    const storedRow = await mediaRow(media.id);
    expect(storedRow.byte_size).toBe(bytes.byteLength);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(storedRow.object_key as string))
      .toMatchObject({ size: bytes.byteLength });
    expect(await testEnv.MEDIA_BUCKET.head(reservationKey)).toBeNull();

    const delayed = await reserve('worker-ingress-delayed', bytes.byteLength);
    await testEnv.DB.prepare('UPDATE media SET reservation_expires_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', delayed.id).run();
    const delayedResponse = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${delayed.id}/content`,
      { method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }, body: bytes },
      testEnv,
    );
    expect(delayedResponse.status).toBe(409);
    // A refusal names a photo and a deadline, so it is no more cacheable than
    // the success it replaced.
    expectPrivateToOneReader(delayedResponse);
    expect((await delayedResponse.json<any>()).code).toBe('UPLOAD_RESERVATION_EXPIRED');
    expect(await testEnv.MEDIA_BUCKET.head(
      mediaReservationObjectKey(access.event.id, delayed.id),
    )).toBeNull();
  });

  it('cannot write after the reservation or event is deleted', async () => {
    const access = await guestAccess();
    const reserve = async (key: string) => {
      const response = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
        method: 'POST', headers: writeHeaders(access), body: JSON.stringify({
          filename: `${key}.png`, mimeType: 'image/png', byteSize: 64,
          idempotencyKey: key, guestName: 'Avery',
        }),
      }, testEnv);
      return (await response.json<any>()).data.media;
    };
    const deletedReservation = await reserve('worker-ingress-deleted-media');
    await testEnv.DB.prepare("UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), deletedReservation.id).run();
    const mediaWrite = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${deletedReservation.id}/content`,
      { method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': '64' }, body: png(800, 600) },
      testEnv,
    );
    expect(mediaWrite.status).toBe(409);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(
      finalizedMediaObjectKey(access.event.id, deletedReservation.id),
    )).toBeNull();

    const deletedEvent = await reserve('worker-ingress-deleted-event');
    await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), access.event.id).run();
    const eventWrite = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${deletedEvent.id}/content`,
      { method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': '64' }, body: png(800, 600) },
      testEnv,
    );
    expect(eventWrite.status).toBeGreaterThanOrEqual(400);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(
      finalizedMediaObjectKey(access.event.id, deletedEvent.id),
    )).toBeNull();
  });

  it('keeps a guest delete successful and durable when immediate R2 cleanup fails', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify({
        filename: 'delete.png', mimeType: 'image/png', byteSize: 64,
        idempotencyKey: 'guest-delete-ledger', guestName: 'Avery',
      }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    const deleteSpy = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete').mockRejectedValueOnce(new Error('R2 unavailable'));
    const deleted = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}`,
      { method: 'DELETE', headers: writeHeaders(access), body: '{}' },
      testEnv,
    );
    deleteSpy.mockRestore();

    expect(deleted.status).toBe(200);
    expectPrivateToOneReader(deleted);
    // The acknowledgement is exactly that: the row is gone for good, so there
    // is no longer a repository record worth serializing back to the guest.
    const deletedBody = await deleted.json<any>();
    expect(keysOf(deletedBody.data)).toEqual(['media']);
    expect(deletedBody.data.media).toEqual({ id: reserved.id, deleted: true });
    expect((await mediaRow(reserved.id)).upload_state).toBe('deleted');
    expect(await new MediaRepository(testEnv.DB).getPromotion(reserved.id)).not.toBeNull();
  });

  it('lets an exact buffered retry recover an ambiguous writer but fences different bytes', async () => {
    const access = await guestAccess();
    const initiate = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify({
        filename: 'ambiguous.png', mimeType: 'image/png', byteSize: 64,
        idempotencyKey: 'ambiguous-ingress', guestName: 'Avery',
      }),
    }, testEnv);
    const media = (await initiate.json<any>()).data.media;
    const path = `/api/event/${access.event.slug}/uploads/${media.id}/content`;
    const original = png(800, 600);
    const different = png(320, 240);
    const request = (body: Uint8Array) => createApp().request(path, {
      method: 'PUT',
      headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': '64' },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    }, testEnv);

    const digest = await crypto.subtle.digest('SHA-256', original);
    const digestHex = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    const finalObjectKey = finalizedMediaObjectKey(access.event.id, media.id);
    await testEnv.DB.prepare(`
      UPDATE media_object_promotions
      SET state = 'copying', final_pointer_committed = 0,
        claim_token = ?, lease_expires_at = ?, source_absent_since = NULL,
        source_etag = ?, source_mime_type = ?, source_byte_size = ?, source_sha256 = ?,
        source_width = 800, source_height = 600
      WHERE media_id = ?
    `).bind(
      crypto.randomUUID(),
      '2099-01-01T00:00:00.000Z',
      `buffer:${digestHex}`,
      'image/png',
      original.byteLength,
      digestHex,
      media.id,
    ).run();
    await testEnv.CANONICAL_MEDIA_BUCKET.put(finalObjectKey, original, {
      httpMetadata: { contentType: 'image/png' },
      sha256: digest,
    });

    const differentResponse = await request(different);
    expect(differentResponse.status).toBe(409);
    const recovered = await request(original);

    expect(recovered.status).toBe(200);
    expect((await recovered.json<any>()).data.media).toEqual({
      id: media.id, mimeType: 'image/png', uploadState: 'stored',
    });
    // The recovered row has to be pointing at the object the retry proved, and
    // that pointer is the durable row's, not the response's.
    expect(await mediaRow(media.id)).toMatchObject({
      upload_state: 'stored', object_key: finalObjectKey, object_bucket_generation: 'canonical',
    });
    expect((await testEnv.DB.prepare('SELECT stored_media_count FROM events WHERE id = ?')
      .bind(access.event.id).first<any>()).stored_media_count).toBe(1);
  });

  it('lets two identical buffered writers converge on one canonical object and one counter', async () => {
    const access = await guestAccess();
    const initiate = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify({
        filename: 'concurrent.png', mimeType: 'image/png', byteSize: 64,
        idempotencyKey: 'concurrent-ingress', guestName: 'Avery',
      }),
    }, testEnv);
    const media = (await initiate.json<any>()).data.media;
    const bytes = png(800, 600);
    let releaseFirstPut!: () => void;
    const firstPutCanFinish = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
    let firstPut = true;
    const originalPut = testEnv.CANONICAL_MEDIA_BUCKET.put.bind(testEnv.CANONICAL_MEDIA_BUCKET);
    const delayedBucket = new Proxy(testEnv.CANONICAL_MEDIA_BUCKET, {
      get(target, property, receiver) {
        if (property === 'put') {
          return async (...args: unknown[]) => {
            if (firstPut) {
              firstPut = false;
              await firstPutCanFinish;
            }
            return (originalPut as (...putArgs: unknown[]) => Promise<unknown>)(...args);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as R2Bucket;
    const delayedEnv = { ...testEnv, CANONICAL_MEDIA_BUCKET: delayedBucket } as AppEnv;
    const request = () => createApp().request(
      `/api/event/${access.event.slug}/uploads/${media.id}/content`,
      {
        method: 'PUT',
        headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': '64' },
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      },
      delayedEnv,
    );

    const first = request();
    await vi.waitFor(async () => {
      expect((await new MediaRepository(testEnv.DB).getPromotion(media.id))?.state).toBe('copying');
    });
    const second = await request();
    releaseFirstPut();
    const firstResponse = await first;

    expect([firstResponse.status, second.status]).toEqual([200, 200]);
    const current = await new MediaRepository(testEnv.DB).getById(media.id);
    expect(current).toMatchObject({
      uploadState: 'stored', objectKey: finalizedMediaObjectKey(access.event.id, media.id),
    });
    expect((await testEnv.DB.prepare('SELECT stored_media_count FROM events WHERE id = ?')
      .bind(access.event.id).first<any>()).stored_media_count).toBe(1);
  });

  it('treats single and batch idempotent replays of stored media as delivered without another writable URL', async () => {
    const access = await guestAccess();
    const file = {
      filename: 'replay.png', mimeType: 'image/png', byteSize: 64,
      idempotencyKey: 'stored-replay', guestName: 'Avery', caption: null,
    };
    const initiate = () => createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access), body: JSON.stringify(file),
    }, testEnv);
    const firstBody = (await (await initiate()).json<any>()).data;
    const temporaryKey = (await mediaRow(firstBody.media.id)).object_key as string;
    const finalized = await uploadContent(access, firstBody.media, png(800, 600));
    const stored = (await finalized.json<any>()).data.media;
    const storedKey = (await mediaRow(stored.id)).object_key as string;

    const replay = (await (await initiate()).json<any>()).data;
    const batch = await createApp().request(`/api/event/${access.event.slug}/uploads/batch`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ guestName: 'Avery', files: [{ ...file, guestName: undefined }] }),
    }, testEnv);
    const batchReplay = (await batch.json<any>()).data.items[0];

    // An already delivered reservation answers without the two writable-URL
    // keys at all, so the key sets themselves are the proof that no second
    // ingress was handed out.
    expect(keysOf(replay)).toEqual(['alreadyDelivered', 'media']);
    expect(replay).toEqual({
      alreadyDelivered: true,
      media: { id: stored.id, mimeType: 'image/png', uploadState: 'stored' },
    });
    expect(keysOf(batchReplay)).toEqual(['alreadyDelivered', 'idempotencyKey', 'media', 'status']);
    expect(batchReplay).toEqual({
      idempotencyKey: file.idempotencyKey,
      status: 'accepted',
      alreadyDelivered: true,
      media: { id: stored.id, mimeType: 'image/png', uploadState: 'stored' },
    });
    expect(storedKey).not.toBe(temporaryKey);
  });

  it('keeps finalized bytes immutable when the old upload key is overwritten with same-size data', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'immutable.png', mimeType: 'image/png', byteSize: 64, idempotencyKey: 'immutable-final', guestName: 'Avery' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    const original = png(1600, 900);
    const replacement = png(320, 240);
    expect(replacement.byteLength).toBe(original.byteLength);
    const finalized = await uploadContent(access, reserved, original);
    const stored = (await finalized.json<any>()).data.media;
    const storedKey = (await mediaRow(stored.id)).object_key as string;

    await env.MEDIA_BUCKET.put(
      mediaReservationObjectKey(access.event.id, reserved.id),
      replacement,
      { httpMetadata: { contentType: 'image/png' } },
    );
    const content = await createApp().request(`/api/media/${stored.id}/original`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);

    expect(new Uint8Array(await content.arrayBuffer())).toEqual(original);
    expect(new Uint8Array(await (await testEnv.CANONICAL_MEDIA_BUCKET.get(storedKey))!.arrayBuffer())).toEqual(original);
  });

  it('rejects a body larger than its declaration before claiming or writing canonical storage', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'small.png', mimeType: 'image/png', byteSize: 32, idempotencyKey: 'final-bad', guestName: 'Avery' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    const finalized = await uploadContent(access, reserved, png(20, 20, 64));
    expect(finalized.status).toBe(422);
    expect((await finalized.json<any>()).code).toBe('VALIDATION_FAILED');
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(
      finalizedMediaObjectKey(access.event.id, reserved.id),
    )).toBeNull();
    expect((await env.DB.prepare('SELECT upload_state FROM media WHERE id = ?').bind(reserved.id).first<any>()).upload_state).toBe('reserved');
    expect((await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()).reserved_media_count).toBe(1);
  });

  it('denies another guest access to pending media and denies old URLs after rejection', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'private.png', mimeType: 'image/png', byteSize: 64, idempotencyKey: 'privacy-1', guestName: 'Avery' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    await uploadContent(access, reserved, png(400, 300));

    // A second guest device scans the same printed entry: it gets its own
    // session, and must still not see somebody else's pending photo.
    const other = cookiesFrom(await exchangeEventEntry(access.eventLink));
    const previewEnv = withImages();
    const ownPreview = await createApp().request(`/api/media/${reserved.id}/preview`, { headers: { cookie: access.cookie } }, previewEnv);
    const pending = await createApp().request(`/api/media/${reserved.id}/preview`, { headers: { cookie: other.cookie } }, previewEnv);
    const guestOriginal = await createApp().request(`/api/media/${reserved.id}/original`, { headers: { cookie: access.cookie } }, testEnv);
    const managerOriginal = await createApp().request(`/api/media/${reserved.id}/original`, { headers: { cookie: access.manager.cookie } }, testEnv);
    expect(ownPreview.status).toBe(200);
    expect(pending.status).toBe(403);
    expect(guestOriginal.status).toBe(403);
    expect(managerOriginal.status).toBe(200);

    await env.DB.batch([
      env.DB.prepare("UPDATE media SET publication_status = 'published', published_at = ? WHERE id = ?").bind(new Date().toISOString(), reserved.id),
      env.DB.prepare('UPDATE events SET gallery_visible = 1 WHERE id = ?').bind(access.event.id),
    ]);
    const published = await createApp().request(`/api/media/${reserved.id}/preview`, { headers: { cookie: other.cookie } }, previewEnv);
    expect(published.status).toBe(200);

    await env.DB.prepare("UPDATE media SET publication_status = 'hidden' WHERE id = ?").bind(reserved.id).run();
    const hidden = await createApp().request(`/api/media/${reserved.id}/preview`, { headers: { cookie: other.cookie } }, previewEnv);
    expect(hidden.status).toBe(403);
  });

  it('transforms a preview without persisting a late-writing derivative', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'cache.png', mimeType: 'image/png', byteSize: 64, idempotencyKey: 'preview-cache', guestName: 'Avery' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    await uploadContent(access, reserved, png(400, 300));
    // The preview helper works from the durable record, which the guest's
    // three-field confirmation deliberately is not.
    const finalized = (await new MediaRepository(env.DB).getById(reserved.id))!;

    const transformedBytes = new TextEncoder().encode('deterministic-webp-preview');
    const recording = withRecordingImages({
      encode: () => ({
        bytes: transformedBytes, width: 1600, height: 1200, contentType: 'image/webp',
      }),
    });
    const previewEnv = recording.env;
    const transforms = () => recording.calls.length;
    const repository = new MediaRepository(env.DB);
    const first = await getOrCreatePreview(previewEnv, finalized);
    const second = await getOrCreatePreview(previewEnv, finalized);

    expect(await new Response(first.body).text()).toBe('deterministic-webp-preview');
    expect(await new Response(second.body).text()).toBe('deterministic-webp-preview');
    expect((await repository.getById(finalized.id))?.previewObjectKey).toBeNull();
    expect(await env.MEDIA_BUCKET.head(`events/${access.event.id}/previews/${finalized.id}.webp`)).toBeNull();
    expect(transforms()).toBe(2);
  });

  it('never copies an original into the preview cache when Images is unavailable', async () => {
    const access = await guestAccess();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ filename: 'metadata.png', mimeType: 'image/png', byteSize: 64, idempotencyKey: 'no-fallback', guestName: 'Avery' }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    await uploadContent(access, reserved, png(400, 300));
    const finalized = (await new MediaRepository(env.DB).getById(reserved.id))!;
    const noImagesEnv = {
      ...testEnv,
      IMAGES: undefined,
    } as unknown as AppEnv;

    await expect(getOrCreatePreview(noImagesEnv, finalized))
      .rejects.toMatchObject({ code: 'FILE_TYPE_UNSUPPORTED', status: 503 });
    expect(await env.MEDIA_BUCKET.head(`events/${access.event.id}/previews/${reserved.id}.webp`)).toBeNull();
  });
});

describe('guest media listings', () => {
  /** Reserves and delivers one photo, and answers with the id and the filename it sent. */
  async function deliver(
    access: Awaited<ReturnType<typeof guestAccess>>,
    key: string,
    caption: string | null,
    guestName = 'Avery',
  ) {
    const filename = `${key}.png`;
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({
        filename, mimeType: 'image/png', byteSize: 64, idempotencyKey: key, guestName, caption,
      }),
    }, testEnv);
    const media = (await initiated.json<any>()).data.media;
    const delivered = await uploadContent(access, media, png(800, 600));
    if (delivered.status !== 200) {
      throw new Error(`Delivery fixture failed: ${await delivered.text()}`);
    }
    return { id: media.id as string, filename };
  }

  async function publishGallery(access: Awaited<ReturnType<typeof guestAccess>>) {
    await env.DB.batch([
      env.DB.prepare("UPDATE media SET publication_status = 'published', published_at = ? WHERE event_id = ?")
        .bind(new Date().toISOString(), access.event.id),
      env.DB.prepare('UPDATE events SET gallery_visible = 1 WHERE id = ?').bind(access.event.id),
    ]);
  }

  it('gives one guest exactly four fields about another guest photo', async () => {
    const access = await guestAccess();
    const captioned = await deliver(access, 'first-dance', 'From our table');
    await publishGallery(access);
    const other = cookiesFrom(await exchangeEventEntry(access.eventLink));

    const response = await createApp().request(
      `/api/event/${access.event.slug}/gallery`,
      { headers: { cookie: other.cookie } },
      testEnv,
    );
    const body = await response.json<any>();

    expect(response.status).toBe(200);
    expectPrivateToOneReader(response);
    expect(keysOf(body.data)).toEqual(['media']);
    expect(body.data.media).toHaveLength(1);
    expect(keysOf(body.data.media[0])).toEqual(GALLERY_MEDIA_KEYS);
    expect(body.data.media[0]).toEqual({
      id: captioned.id,
      guestName: 'Avery',
      caption: 'From our table',
      previewAvailable: true,
    });
  });

  // The filename is the uploader's device talking, and an absent caption is
  // exactly when a projection that quietly substituted it would look most
  // helpful. The gallery renders `Shared photo` instead, so the name must not
  // reach the browser at all — not under `caption`, and not under any other key.
  it('never sends the original filename to the gallery, caption or no caption', async () => {
    const access = await guestAccess();
    const uncaptioned = await deliver(access, 'IMG-4471-avery-home-address', null);
    await publishGallery(access);
    const other = cookiesFrom(await exchangeEventEntry(access.eventLink));

    const response = await createApp().request(
      `/api/event/${access.event.slug}/gallery`,
      { headers: { cookie: other.cookie } },
      testEnv,
    );
    const raw = await response.text();
    const body = JSON.parse(raw);

    expect(response.status).toBe(200);
    expect(keysOf(body.data.media[0])).toEqual(GALLERY_MEDIA_KEYS);
    expect(body.data.media[0]).toEqual({
      id: uncaptioned.id,
      guestName: 'Avery',
      caption: null,
      previewAvailable: true,
    });
    expect(raw).not.toContain('IMG-4471');
    expect(raw).not.toContain(uncaptioned.filename);
  });

  it('shows a guest their own filename and transfer state, and nobody else theirs', async () => {
    const access = await guestAccess();
    const stored = await deliver(access, 'ours-delivered', 'Ours');
    const reserving = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({
        filename: 'ours-pending.png', mimeType: 'image/png', byteSize: 64,
        idempotencyKey: 'ours-pending', guestName: 'Avery', caption: null,
      }),
    }, testEnv);
    const pending = (await reserving.json<any>()).data.media;
    const other = cookiesFrom(await exchangeEventEntry(access.eventLink));

    const own = await createApp().request(
      `/api/event/${access.event.slug}/contributions`,
      { headers: { cookie: access.cookie } },
      testEnv,
    );
    const ownBody = await own.json<any>();
    const stranger = await createApp().request(
      `/api/event/${access.event.slug}/contributions`,
      { headers: { cookie: other.cookie } },
      testEnv,
    );

    expect(own.status).toBe(200);
    expectPrivateToOneReader(own);
    expect(keysOf(ownBody.data)).toEqual(['media']);
    for (const item of ownBody.data.media) {
      expect(keysOf(item)).toEqual(CONTRIBUTION_MEDIA_KEYS);
    }
    expect(ownBody.data.media.map((item: any) => [
      item.id, item.originalFilename, item.uploadState, item.previewAvailable, item.caption,
    ])).toEqual([
      [stored.id, 'ours-delivered.png', 'stored', true, 'Ours'],
      [pending.id, 'ours-pending.png', 'reserved', false, null],
    ]);
    expect(Date.parse(ownBody.data.media[0].createdAt)).not.toBeNaN();
    // A contributions list is one session's, and the session is the only thing
    // that decides whose. A second device on the same printed entry is a
    // different guest.
    expect((await stranger.json<any>()).data.media).toEqual([]);
  });
});

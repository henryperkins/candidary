import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import { MediaRepository } from '../../worker/db/media';
import type { AppEnv } from '../../worker/env';
import { finalizedMediaObjectKey } from '../../worker/storage/media-keys';
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
    expect(firstBody.data.media.objectKey).toMatch(new RegExp(`^events/${access.event.id}/uploads/`));
    expect(firstBody.data.media.objectKey).not.toContain('our moment');
    expect(firstBody.data.uploadUrl)
      .toBe(`/api/event/${access.event.slug}/uploads/${firstBody.data.media.id}/content`);
    expect(firstBody.data.uploadUrl).not.toContain('X-Amz-Signature=');
    expect(secondBody.data.media.id).toBe(firstBody.data.media.id);
    expect((await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()).reserved_media_count).toBe(1);
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
    expect(firstItems.map((item: any) => [item.idempotencyKey, item.status, item.error?.code])).toEqual([
      ['batch-1', 'accepted', undefined],
      ['batch-2', 'rejected', 'EVENT_MEDIA_LIMIT'],
      ['batch-3', 'rejected', 'FILE_TYPE_UNSUPPORTED'],
    ]);
    expect(firstItems[0].media).toMatchObject({ mimeType: 'image/heic', guestName: 'Avery', publicationStatus: 'unpublished' });
    expect(repeatedItems[0].media.id).toBe(firstItems[0].media.id);
    expect((await env.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>()).reserved_media_count).toBe(1);
  });

});

describe('upload finalization and private delivery', () => {
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

    expect(first.status).toBe(200);
    expect(firstBody.data.media).toMatchObject({ uploadState: 'stored', publicationStatus: 'unpublished', width: 1600, height: 900, byteSize: 64 });
    expect(firstBody.data.media.objectKey).toMatch(new RegExp(`^events/${access.event.id}/media/final/`));
    expect(firstBody.data.media.objectKey).not.toBe(reserved.objectKey);
    expect(await env.MEDIA_BUCKET.head(reserved.objectKey)).toBeNull();
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(firstBody.data.media.objectKey)).not.toBeNull();
    expect((await repeated.json<any>()).data.media.id).toBe(reserved.id);

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
    const path = `/api/event/${access.event.slug}/uploads/${media.id}/content`;
    const unauthenticated = await createApp().request(path, {
      method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }, body: bytes,
    }, testEnv);
    expect(unauthenticated.status).toBe(401);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();

    const short = await createApp().request(path, {
      method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': String(bytes.byteLength - 1) }, body: bytes,
    }, testEnv);
    expect(short.status).toBe(422);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();

    const accepted = await createApp().request(path, {
      method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }, body: bytes,
    }, testEnv);
    expect(accepted.status).toBe(200);
    const stored = (await accepted.json<any>()).data.media;
    expect(stored).toMatchObject({ uploadState: 'stored', byteSize: bytes.byteLength });
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(stored.objectKey)).toMatchObject({ size: bytes.byteLength });
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();

    const delayed = await reserve('worker-ingress-delayed', bytes.byteLength);
    await testEnv.DB.prepare('UPDATE media SET reservation_expires_at = ? WHERE id = ?')
      .bind('2020-01-01T00:00:00.000Z', delayed.id).run();
    const delayedResponse = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${delayed.id}/content`,
      { method: 'PUT', headers: { ...writeHeaders(access), 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }, body: bytes },
      testEnv,
    );
    expect(delayedResponse.status).toBe(409);
    expect((await delayedResponse.json<any>()).code).toBe('UPLOAD_RESERVATION_EXPIRED');
    expect(await testEnv.MEDIA_BUCKET.head(delayed.objectKey)).toBeNull();
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
    expect((await deleted.json<any>()).data.media.uploadState).toBe('deleted');
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
    expect((await recovered.json<any>()).data.media).toMatchObject({
      uploadState: 'stored', objectKey: finalObjectKey,
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
    const temporaryKey = firstBody.media.objectKey;
    const finalized = await uploadContent(access, firstBody.media, png(800, 600));
    const stored = (await finalized.json<any>()).data.media;

    const replay = (await (await initiate()).json<any>()).data;
    const batch = await createApp().request(`/api/event/${access.event.slug}/uploads/batch`, {
      method: 'POST', headers: writeHeaders(access),
      body: JSON.stringify({ guestName: 'Avery', files: [{ ...file, guestName: undefined }] }),
    }, testEnv);
    const batchReplay = (await batch.json<any>()).data.items[0];

    expect(replay).toMatchObject({ alreadyDelivered: true, media: { id: stored.id, uploadState: 'stored', objectKey: stored.objectKey } });
    expect(replay.uploadUrl).toBeUndefined();
    expect(replay.uploadUrlExpiresAt).toBeUndefined();
    expect(batchReplay).toMatchObject({
      idempotencyKey: file.idempotencyKey,
      status: 'accepted',
      alreadyDelivered: true,
      media: { id: stored.id, uploadState: 'stored', objectKey: stored.objectKey },
    });
    expect(batchReplay.uploadUrl).toBeUndefined();
    expect(batchReplay.uploadUrlExpiresAt).toBeUndefined();
    expect(stored.objectKey).not.toBe(temporaryKey);
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

    await env.MEDIA_BUCKET.put(reserved.objectKey, replacement, { httpMetadata: { contentType: 'image/png' } });
    const content = await createApp().request(`/api/media/${stored.id}/original`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);

    expect(new Uint8Array(await content.arrayBuffer())).toEqual(original);
    expect(new Uint8Array(await (await testEnv.CANONICAL_MEDIA_BUCKET.get(stored.objectKey))!.arrayBuffer())).toEqual(original);
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
    const finalizedResponse = await uploadContent(access, reserved, png(400, 300));
    const finalized = (await finalizedResponse.json<any>()).data.media;

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
    const finalizedResponse = await uploadContent(access, reserved, png(400, 300));
    const finalized = (await finalizedResponse.json<any>()).data.media;
    const noImagesEnv = {
      ...testEnv,
      IMAGES: undefined,
    } as unknown as AppEnv;

    await expect(getOrCreatePreview(noImagesEnv, finalized))
      .rejects.toMatchObject({ code: 'FILE_TYPE_UNSUPPORTED', status: 503 });
    expect(await env.MEDIA_BUCKET.head(`events/${access.event.id}/previews/${reserved.id}.webp`)).toBeNull();
  });
});

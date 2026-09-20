import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import {
  eventAccess,
  origin,
  resetDatabase,
  png,
  testEnv,
  trashMedia,
  uploadPending,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);
afterEach(() => {
  delete globalThis.__CANDIDARY_TEST_MEDIA_UPLOAD_RELEASE_OVERRIDE__;
});

type Access = Awaited<ReturnType<typeof eventAccess>>;

function mediaId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function seedStored(
  access: Access,
  index: number,
  options: {
    timelineAt?: string;
    guestName?: string;
    caption?: string | null;
    filename?: string;
    favoritedAt?: string | null;
    deletedAt?: string | null;
  } = {},
) {
  const session = await env.DB
    .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
    .bind(access.event.id)
    .first<{ id: string }>();
  if (!session) throw new Error('Expected a guest session for the seeded event.');
  const id = mediaId(index);
  await env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, width, height,
      guest_name, caption, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
      favorited_at, deleted_at
    ) VALUES (?, ?, ?, ?, 'canonical', ?, 'image/jpeg', 1024, 1024, 800, 600,
      ?, ?, ?, 'unpublished', ?, ?, ?, ?, NULL, ?, ?, ?)
  `).bind(
    id,
    access.event.id,
    session.id,
    `events/${access.event.id}/media/final/${id}`,
    options.filename ?? `seed-${index}.jpg`,
    options.guestName ?? 'Avery Stone',
    options.caption ?? null,
    options.deletedAt === null || options.deletedAt === undefined ? 'stored' : 'deleted',
    `seed-${index}`,
    '2026-09-19T00:00:00.000Z',
    '2026-09-19T00:00:00.000Z',
    '2026-09-19T00:00:00.000Z',
    options.timelineAt ?? '2026-09-19T10:00:00.000Z',
    options.favoritedAt ?? null,
    options.deletedAt ?? null,
  ).run();
  return id;
}

function gallery(access: Access, query = '') {
  return createApp().request(`/api/manage/events/${access.event.id}/gallery${query}`, {
    headers: { cookie: access.manager.cookie },
  }, testEnv);
}

function arrivals(access: Access, after: string | number, query = '') {
  const separator = query.length > 0 ? '&' : '?';
  return createApp().request(
    `/api/manage/events/${access.event.id}/gallery/arrivals${query}${separator}after=${after}`,
    { headers: { cookie: access.manager.cookie } },
    testEnv,
  );
}

async function reserveUpload(access: Access, key: string, guestName = 'Avery') {
  const response = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
    method: 'POST',
    headers: writeHeaders(access.guest),
    body: JSON.stringify({
      filename: `${key}.png`, mimeType: 'image/png', byteSize: png().byteLength,
      idempotencyKey: key, guestName, caption: null,
    }),
  }, testEnv);
  expect(response.status).toBe(201);
  return (await response.json<any>()).data.media as { id: string };
}

async function finalizeUpload(access: Access, mediaId: string) {
  const bytes = png();
  return createApp().request(`/api/event/${access.event.slug}/uploads/${mediaId}/content`, {
    method: 'PUT',
    headers: {
      ...writeHeaders(access.guest),
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  }, testEnv);
}

function album(access: Access) {
  return createApp().request(`/api/manage/events/${access.event.id}/album`, {
    headers: { cookie: access.manager.cookie },
  }, testEnv);
}

async function galleryIds(access: Access, query = ''): Promise<string[]> {
  const response = await gallery(access, query);
  if (response.status !== 200) {
    throw new Error(`Gallery read failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json<any>()).data.media
    .map((media: { id: string }) => media.id)
    .sort();
}

function decodeCursorPayload(cursor: string): unknown {
  const normalized = cursor.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
  return JSON.parse(atob(padded));
}

function unversionedCursor(timelineAt: string, id: string): string {
  return btoa(JSON.stringify({ timelineAt, id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function versionOneCursor(timelineAt: string, id: string): string {
  return btoa(JSON.stringify({ v: 1, timelineAt, id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

describe('host private gallery API', () => {
  it('counts a later delivery despite identical stored timestamps', async () => {
    const access = await eventAccess();
    await seedStored(access, 1);
    const first = await (await gallery(access, '?live=1')).json<any>();
    expect(first.data.snapshotSequence).toEqual(expect.any(Number));
    const laterId = await seedStored(access, 2, {
      timelineAt: '2026-09-18T10:00:00.000Z',
    });
    const response = await arrivals(access, first.data.snapshotSequence);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.count).toBe(1);
    const frozen = await (await gallery(
      access,
      `?live=1&snapshot=${first.data.snapshotSequence}`,
    )).json<any>();
    expect(frozen.data.media.map((row: { id: string }) => row.id)).not.toContain(laterId);
  });

  it('counts delivery when trash keeps the active total unchanged and ignores restoration', async () => {
    const access = await eventAccess();
    const restored = await uploadPending(access, 'restored-before-baseline');
    const removed = await uploadPending(access, 'removed-before-baseline');
    const baseline = await (await gallery(access, '?live=1')).json<any>();
    await trashMedia(access, restored.id);
    await trashMedia(access, removed.id);
    const delivered = await uploadPending(access, 'delivered-after-baseline');
    const restoredResponse = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${restored.id}/restore`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(restoredResponse.status).toBe(200);

    const summary = await (await arrivals(access, baseline.data.snapshotSequence)).json<any>();
    expect(summary.data.count).toBe(1);
    const accepted = await (await gallery(
      access,
      `?live=1&snapshot=${summary.data.snapshotSequence}`,
    )).json<any>();
    expect(accepted.data.media.map((row: { id: string }) => row.id).sort())
      .toEqual([delivered.id, restored.id].sort());
  });

  it('assigns a pending reservation only when delivery finalizes and does not advance on retry', async () => {
    const access = await eventAccess();
    const pending = await reserveUpload(access, 'pending-after-baseline');
    const baseline = await (await gallery(access, '?live=1')).json<any>();

    expect((await finalizeUpload(access, pending.id)).status).toBe(200);
    const delivered = await (await arrivals(access, baseline.data.snapshotSequence)).json<any>();
    expect(delivered.data.count).toBe(1);
    expect(delivered.data.snapshotSequence).toBe(baseline.data.snapshotSequence + 1);

    expect((await finalizeUpload(access, pending.id)).status).toBe(200);
    const retried = await (await arrivals(access, baseline.data.snapshotSequence)).json<any>();
    expect(retried.data).toEqual(delivered.data);
  });

  it('uses the same literal search and In album predicates for arrivals', async () => {
    const access = await eventAccess();
    const baseline = await (await gallery(access, '?live=1')).json<any>();
    const jose = await seedStored(access, 1, {
      guestName: 'Jose', filename: '100%_final.jpg', caption: 'First dance',
    });
    await seedStored(access, 2, { guestName: 'Maya', caption: 'Cake' });
    const picked = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${jose}/favorite`,
      {
        method: 'PUT', headers: writeHeaders(access.manager),
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );
    expect(picked.status).toBe(200);

    const after = baseline.data.snapshotSequence;
    expect((await (await arrivals(access, after, '?query=JOSE')).json<any>()).data.count).toBe(1);
    expect((await (await arrivals(access, after, '?query=100%_')).json<any>()).data.count).toBe(1);
    expect((await (await arrivals(access, after, '?query=missing')).json<any>()).data.count).toBe(0);
    expect((await (await arrivals(access, after, '?favorites=1')).json<any>()).data.count).toBe(1);
    expect((await (await arrivals(access, after, '?query=Maya&favorites=1')).json<any>()).data.count)
      .toBe(0);
  });

  it('returns a zero arrival summary at the captured marker', async () => {
    const access = await eventAccess();
    await seedStored(access, 1);
    const baseline = await (await gallery(access, '?live=1')).json<any>();
    const response = await arrivals(access, baseline.data.snapshotSequence);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data).toEqual({
      afterSequence: baseline.data.snapshotSequence,
      snapshotSequence: baseline.data.snapshotSequence,
      count: 0,
    });
  });

  it('keeps a live continuation on its first snapshot when new arrivals land', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { timelineAt: '2026-09-19T12:00:00.000Z' });
    await seedStored(access, 2, { timelineAt: '2026-09-19T10:00:00.000Z' });
    const first = await (await gallery(access, '?live=1&limit=1')).json<any>();
    expect(first.data.snapshotSequence).toEqual(expect.any(Number));
    const laterId = await seedStored(access, 3, { timelineAt: '2026-09-19T11:00:00.000Z' });

    const second = await (await gallery(
      access,
      `?live=1&limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`,
    )).json<any>();
    expect(second.data.snapshotSequence).toBe(first.data.snapshotSequence);
    expect(second.data.media.map((row: { id: string }) => row.id)).toEqual([mediaId(2)]);
    expect(second.data.media.map((row: { id: string }) => row.id)).not.toContain(laterId);
  });

  it('paginates a live Unicode search through a v3 cursor', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, {
      guestName: '李 Avery', timelineAt: '2026-09-19T12:00:00.000Z',
    });
    await seedStored(access, 2, {
      guestName: '李 Maya', timelineAt: '2026-09-19T11:00:00.000Z',
    });

    const first = await gallery(access, `?live=1&query=${encodeURIComponent('李')}&limit=1`);
    expect(first.status).toBe(200);
    const firstBody = await first.json<any>();
    expect(firstBody.data.snapshotSequence).toEqual(expect.any(Number));
    expect(firstBody.data.media.map((row: { id: string }) => row.id)).toEqual([mediaId(1)]);
    expect(firstBody.data.nextCursor).toEqual(expect.any(String));

    const second = await gallery(
      access,
      `?live=1&query=${encodeURIComponent('李')}&limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json<any>();
    expect(secondBody.data.snapshotSequence).toBe(firstBody.data.snapshotSequence);
    expect(secondBody.data.media.map((row: { id: string }) => row.id)).toEqual([mediaId(2)]);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it('rejects live cursor scope mismatches across event, query, filter, order, and snapshot', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other Event');
    await seedStored(access, 1, { guestName: 'Jose', timelineAt: '2026-09-19T12:00:00.000Z' });
    await seedStored(access, 2, { guestName: 'Jose', timelineAt: '2026-09-19T11:00:00.000Z' });
    const first = await (await gallery(access, '?live=1&query=Jose&limit=1')).json<any>();
    const cursor = encodeURIComponent(first.data.nextCursor);

    for (const response of [
      await gallery(access, `?live=1&query=Maya&limit=1&cursor=${cursor}`),
      await gallery(access, `?live=1&query=Jose&favorites=1&limit=1&cursor=${cursor}`),
      await gallery(access, `?live=1&query=Jose&order=earliest&limit=1&cursor=${cursor}`),
      await gallery(access, `?live=1&query=Jose&snapshot=0&limit=1&cursor=${cursor}`),
      await createApp().request(
        `/api/manage/events/${other.event.id}/gallery?live=1&query=Jose&limit=1&cursor=${cursor}`,
        { headers: { cookie: other.manager.cookie } }, testEnv,
      ),
    ]) {
      expect(response.status).toBe(422);
      expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('denies arrival reads to guests and foreign managers', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other Event');
    const guest = await createApp().request(
      `/api/manage/events/${access.event.id}/gallery/arrivals?after=0`,
      { headers: writeHeaders(access.guest) }, testEnv,
    );
    expect(guest.status).toBe(403);
    const foreign = await createApp().request(
      `/api/manage/events/${access.event.id}/gallery/arrivals?after=0`,
      { headers: { cookie: other.manager.cookie } }, testEnv,
    );
    expect(foreign.status).toBe(403);
    expect((await foreign.json<any>()).code).toBe('ROLE_FORBIDDEN');
  });

  it('rejects malformed and future sequences and invalid live values', async () => {
    const access = await eventAccess();
    await seedStored(access, 1);
    const baseline = await (await gallery(access, '?live=1')).json<any>();
    for (const response of [
      await arrivals(access, '-1'),
      await arrivals(access, '1.5'),
      await arrivals(access, 'nope'),
      await arrivals(access, baseline.data.snapshotSequence + 1),
      await gallery(access, '?live=0'),
      await gallery(access, '?live=true'),
      await gallery(access, '?live=1&snapshot=-1'),
      await gallery(access, `?live=1&snapshot=${baseline.data.snapshotSequence + 1}`),
    ]) {
      expect(response.status).toBe(422);
      expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('keeps v1/v2 cursors legacy-only and emits v3 for live reads', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { timelineAt: '2026-09-19T12:00:00.000Z' });
    await seedStored(access, 2, { timelineAt: '2026-09-19T11:00:00.000Z' });
    const legacy = await gallery(access, '?limit=1');
    const legacyBody = await legacy.json<any>();
    expect(decodeCursorPayload(legacyBody.data.nextCursor)).toMatchObject({ v: 2 });
    expect((await gallery(
      access,
      `?limit=1&cursor=${encodeURIComponent(legacyBody.data.nextCursor)}`,
    )).status).toBe(200);
    const v1 = versionOneCursor('2026-09-19T11:00:00.000Z', mediaId(2));
    expect((await gallery(
      access,
      `?limit=1&order=earliest&cursor=${encodeURIComponent(v1)}`,
    )).status).toBe(200);
    expect((await gallery(
      access,
      `?live=1&limit=1&cursor=${encodeURIComponent(legacyBody.data.nextCursor)}`,
    )).status).toBe(422);
    expect((await gallery(
      access,
      `?live=1&limit=1&order=earliest&cursor=${encodeURIComponent(v1)}`,
    )).status).toBe(422);

    const live = await (await gallery(access, '?live=1&limit=1')).json<any>();
    expect(decodeCursorPayload(live.data.nextCursor)).toMatchObject({
      v: 3,
      eventId: access.event.id,
      query: '',
      favorites: false,
      order: 'newest',
      snapshotSequence: live.data.snapshotSequence,
    });
    expect((await gallery(
      access,
      `?limit=1&cursor=${encodeURIComponent(live.data.nextCursor)}`,
    )).status).toBe(422);
  });

  it('refuses a private gallery read without a manager session', async () => {
    const access = await eventAccess();
    const missing = await createApp().request(
      `/api/manage/events/${access.event.id}/gallery`,
      {},
      testEnv,
    );
    expect(missing.status).toBe(401);
    expect((await missing.json<any>()).code).toBe('SESSION_REQUIRED');

    const guest = await createApp().request(
      `/api/manage/events/${access.event.id}/gallery`,
      { headers: writeHeaders(access.guest) },
      testEnv,
    );
    expect(guest.status).toBe(403);
    expect((await guest.json<any>()).code).toBe('ROLE_FORBIDDEN');
  });

  it('reports a stored photo as previewable even with no recorded preview object', async () => {
    const access = await eventAccess();
    const id = await seedStored(access, 1);

    // Nothing in the current pipeline writes this column: `getOrCreatePreview`
    // transforms the original on demand and keeps the result ephemeral on purpose.
    // Deriving availability from it reported false for every delivered photo and
    // left the host's Gallery rendering placeholders instead of their photographs.
    const row = await env.DB
      .prepare('SELECT preview_object_key FROM media WHERE id = ?')
      .bind(id)
      .first<{ preview_object_key: string | null }>();
    expect(row?.preview_object_key).toBeNull();

    const response = await gallery(access);
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.data.media).toEqual([
      expect.objectContaining({ id, previewAvailable: true }),
    ]);
  });

  it('returns the earliest-first gallery view and a chronological cursor', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { timelineAt: '2026-09-19T12:00:00.000Z' });
    await seedStored(access, 2, { timelineAt: '2026-09-19T11:00:00.000Z', favoritedAt: '2026-09-19T11:30:00.000Z' });
    await seedStored(access, 3, { timelineAt: '2026-09-19T11:00:00.000Z' });

    const first = await gallery(access, '?limit=2&order=earliest');
    expect(first.status).toBe(200);
    const firstBody = await first.json<any>();
    expect(firstBody.data.media.map((media: { id: string }) => media.id))
      .toEqual([mediaId(2), mediaId(3)]);
    expect(firstBody.data.nextCursor).toEqual(expect.any(String));
    expect(decodeCursorPayload(firstBody.data.nextCursor)).toEqual({
      v: 2,
      order: 'earliest',
      timelineAt: '2026-09-19T11:00:00.000Z',
      id: mediaId(3),
    });
    expect(firstBody.data.media[0]).toEqual({
      id: mediaId(2),
      originalFilename: 'seed-2.jpg',
      guestName: 'Avery Stone',
      caption: null,
      publicationStatus: 'unpublished',
      previewAvailable: true,
      width: 800,
      height: 600,
      receivedAt: '2026-09-19T00:00:00.000Z',
      timelineAt: '2026-09-19T11:00:00.000Z',
      timelineSource: 'received',
      isFavorite: true,
    });

    const second = await gallery(
      access,
      `?limit=2&order=earliest&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
    );
    const secondBody = await second.json<any>();
    expect(secondBody.data.media.map((media: { id: string }) => media.id)).toEqual([mediaId(1)]);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it('opens newest-first by default and walks the stream backwards from there', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { timelineAt: '2026-09-19T12:00:00.000Z' });
    await seedStored(access, 2, { timelineAt: '2026-09-19T11:00:00.000Z' });
    await seedStored(access, 3, { timelineAt: '2026-09-19T10:00:00.000Z' });

    // No `order` parameter: a host arriving the morning after lands on the last photo
    // of the night, not on the empty room.
    const first = await gallery(access, '?limit=2');
    const firstBody = await first.json<any>();
    expect(firstBody.data.media.map((media: { id: string }) => media.id))
      .toEqual([mediaId(1), mediaId(2)]);
    expect(decodeCursorPayload(firstBody.data.nextCursor)).toEqual({
      v: 2,
      order: 'newest',
      timelineAt: '2026-09-19T11:00:00.000Z',
      id: mediaId(2),
    });

    const second = await gallery(
      access,
      `?limit=2&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
    );
    const secondBody = await second.json<any>();
    expect(secondBody.data.media.map((media: { id: string }) => media.id)).toEqual([mediaId(3)]);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it('refuses an unknown order and a cursor cut for the other direction', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { timelineAt: '2026-09-19T12:00:00.000Z' });
    await seedStored(access, 2, { timelineAt: '2026-09-19T11:00:00.000Z' });

    expect((await gallery(access, '?order=oldest')).status).toBe(422);
    expect((await gallery(access, '?order=')).status).toBe(422);

    const newest = await gallery(access, '?limit=1');
    const cursor = (await newest.json<any>()).data.nextCursor;
    // The keyset predicate flips with the direction, so replaying this position against
    // earliest-first would return the side of the stream the host already read.
    const crossed = await gallery(
      access,
      `?limit=1&order=earliest&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(crossed.status).toBe(422);
    expect((await crossed.json<any>()).code).toBe('VALIDATION_FAILED');

    const replayed = await gallery(access, `?limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(replayed.status).toBe(200);
    expect((await replayed.json<any>()).data.media.map((media: { id: string }) => media.id))
      .toEqual([mediaId(2)]);
  });

  it('applies search and favorites and validates the parameter contract', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { guestName: 'Jose', timelineAt: '2026-09-19T10:00:00.000Z' });
    await seedStored(access, 2, { guestName: 'Maya', favoritedAt: '2026-09-19T11:00:00.000Z' });

    const searched = await gallery(access, '?query=JOSE');
    expect((await searched.json<any>()).data.media.map((media: { id: string }) => media.id))
      .toEqual([mediaId(1)]);
    const favorites = await gallery(access, '?favorites=1');
    expect((await favorites.json<any>()).data.media.map((media: { id: string }) => media.id))
      .toEqual([mediaId(2)]);

    expect((await gallery(access, '?favorites=0')).status).toBe(422);
    expect((await gallery(access, `?query=${'x'.repeat(121)}`)).status).toBe(422);
    expect((await gallery(access, '?cursor=not-a-cursor')).status).toBe(422);
    expect((await gallery(access, `?cursor=${encodeURIComponent(unversionedCursor(
      '2026-09-19T10:00:00.000Z',
      mediaId(1),
    ))}`)).status).toBe(422);
  });

  it('fails closed until every stored timeline sentinel for the event is repaired', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { timelineAt: '1970-01-01T00:00:00.000Z' });

    const invalid = await gallery(access, '?cursor=not-a-cursor');
    expect(invalid.status).toBe(422);
    expect((await invalid.json<any>()).code).toBe('VALIDATION_FAILED');

    const blocked = await gallery(access);
    expect(blocked.status).toBe(409);
    expect(await blocked.json<any>()).toMatchObject({
      code: 'MEDIA_STATE_CONFLICT',
      message: 'The private gallery is still preparing. Try again shortly.',
    });

    await env.DB.prepare(`
      UPDATE media SET timeline_at = COALESCE(stored_at, created_at)
      WHERE event_id = ? AND timeline_at = '1970-01-01T00:00:00.000Z'
    `).bind(access.event.id).run();

    const ready = await gallery(access);
    expect(ready.status).toBe(200);
    expect((await ready.json<any>()).data.media).toHaveLength(1);
  });

  it('removes a trashed photo from the timeline, search, and album, and returns it on restore', async () => {
    const access = await eventAccess();
    const jose = await uploadPending(access, 'trash-jose', 'First dance', 'Jose');
    const maya = await uploadPending(access, 'trash-maya', 'Cake', 'Maya');
    for (const id of [jose.id, maya.id]) {
      const picked = await createApp().request(
        `/api/manage/events/${access.event.id}/media/${id}/favorite`,
        {
          method: 'PUT',
          headers: writeHeaders(access.manager),
          body: JSON.stringify({ favorite: true }),
        },
        testEnv,
      );
      expect(picked.status).toBe(200);
    }
    expect((await (await album(access)).json<any>()).data.album)
      .toMatchObject({ photoCount: 2, retainedCount: 0 });

    const trashed = await trashMedia(access, jose.id);
    expect(trashed).toMatchObject({ id: jose.id, guestName: 'Jose' });

    expect(await galleryIds(access)).toEqual([maya.id]);
    expect(await galleryIds(access, '?query=jose')).toEqual([]);
    // The album keeps the slot and loses the photograph. Closing the gap would
    // rearrange the host's album around a photo they can still bring back.
    expect((await (await album(access)).json<any>()).data.album)
      .toMatchObject({ photoCount: 1, retainedCount: 1 });

    const restored = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${jose.id}/restore`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(restored.status).toBe(200);
    expect((await restored.json<any>()).data.media).toMatchObject({
      id: jose.id,
      uploadState: 'stored',
    });

    expect(await galleryIds(access)).toEqual([jose.id, maya.id].sort());
    expect(await galleryIds(access, '?query=jose')).toEqual([jose.id]);
    expect((await (await album(access)).json<any>()).data.album)
      .toMatchObject({ photoCount: 2, retainedCount: 0 });
  });

  it('writes and clears a favorite idempotently with CSRF and origin guards', async () => {
    const access = await eventAccess();
    const id = await seedStored(access, 1);

    const noCsrf = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${id}/favorite`,
      {
        method: 'PUT',
        headers: {
          cookie: access.manager.cookie,
          'content-type': 'application/json',
          origin,
        },
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json<any>()).code).toBe('CSRF_INVALID');

    const set = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${id}/favorite`,
      {
        method: 'PUT',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );
    expect(set.status).toBe(200);
    expect((await set.json<any>()).data.media.isFavorite).toBe(true);

    const repeated = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${id}/favorite`,
      {
        method: 'PUT',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );
    expect((await repeated.json<any>()).data.media.isFavorite).toBe(true);

    const cleared = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${id}/favorite`,
      {
        method: 'PUT',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ favorite: false }),
      },
      testEnv,
    );
    expect((await cleared.json<any>()).data.media.isFavorite).toBe(false);
  });

  it('refuses favorite writes for invalid bodies, guests, foreign, and removed media', async () => {
    const access = await eventAccess();
    const other = await eventAccess('Other Event');
    const id = await seedStored(access, 1);
    const removedId = await seedStored(access, 2, {
      deletedAt: '2026-09-19T12:00:00.000Z',
    });

    const invalid = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${id}/favorite`,
      {
        method: 'PUT',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ favorite: 'yes' }),
      },
      testEnv,
    );
    expect(invalid.status).toBe(422);

    const guest = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${id}/favorite`,
      {
        method: 'PUT',
        headers: writeHeaders(access.guest),
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );
    expect(guest.status).toBe(403);

    const foreign = await createApp().request(
      `/api/manage/events/${other.event.id}/media/${id}/favorite`,
      {
        method: 'PUT',
        headers: writeHeaders(other.manager),
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );
    expect(foreign.status).toBe(403);
    expect((await foreign.json<any>()).code).toBe('RESOURCE_FORBIDDEN');

    const removed = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${removedId}/favorite`,
      {
        method: 'PUT',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );
    expect(removed.status).toBe(409);
    expect((await removed.json<any>()).code).toBe('MEDIA_STATE_CONFLICT');
  });
});

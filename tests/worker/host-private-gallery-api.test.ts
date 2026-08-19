import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { eventAccess, origin, resetDatabase, testEnv, writeHeaders } from './helpers';

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
      ?, ?, 'stored', 'unpublished', ?, ?, ?, ?, NULL, ?, ?, ?)
  `).bind(
    id,
    access.event.id,
    session.id,
    `events/${access.event.id}/media/final/${id}`,
    options.filename ?? `seed-${index}.jpg`,
    options.guestName ?? 'Avery Stone',
    options.caption ?? null,
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

describe('host private gallery API', () => {
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

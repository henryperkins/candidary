import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_MAX_ENTRIES,
  ALBUM_TITLE_MAX_LENGTH,
} from '../../shared/constants';
import type { AlbumView } from '../../shared/contracts';
import { eventAccess, origin, resetDatabase, testEnv, writeHeaders } from './helpers';

beforeEach(resetDatabase);

type Access = Awaited<ReturnType<typeof eventAccess>>;
const NOW = '2026-08-23T00:00:00.000Z';

function mediaId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function seedStored(
  access: Access,
  index: number,
  options: {
    timelineAt?: string;
    favoritedAt?: string | null;
    publicationStatus?: 'unpublished' | 'published' | 'hidden';
    byteSize?: number;
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
    ) VALUES (?, ?, ?, ?, 'canonical', ?, 'image/jpeg', 1024, ?, 800, 600,
      'Avery Stone', NULL, 'stored', ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
  `).bind(
    id,
    access.event.id,
    session.id,
    `events/${access.event.id}/media/final/${id}`,
    `seed-${index}.jpg`,
    options.byteSize ?? 1024,
    options.publicationStatus ?? 'unpublished',
    `seed-${index}`,
    '2026-09-19T00:00:00.000Z',
    '2026-09-19T00:00:00.000Z',
    '2026-09-19T00:00:00.000Z',
    options.timelineAt ?? `2026-09-19T1${index}:00:00.000Z`,
    options.favoritedAt ?? null,
  ).run();
  return id;
}

async function seedLegacyFavorites(access: Access, count: number) {
  const session = await env.DB
    .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
    .bind(access.event.id)
    .first<{ id: string }>();
  if (!session) throw new Error('Expected a guest session for the legacy favorites fixture.');
  const first = 1_000;
  const last = first + count - 1;
  await env.DB.prepare(`
    WITH RECURSIVE seq(i) AS (
      SELECT ?1
      UNION ALL
      SELECT i + 1 FROM seq WHERE i < ?2
    )
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, width, height,
      guest_name, caption, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
      favorited_at, deleted_at
    )
    SELECT
      printf('00000000-0000-4000-8000-%012d', i), ?3, ?4,
      'events/' || ?3 || '/media/final/' || printf('00000000-0000-4000-8000-%012d', i),
      'canonical', 'legacy-' || i || '.jpg', 'image/jpeg', 1024, 1024, 800, 600,
      'Avery Stone', NULL, 'stored', 'unpublished', 'legacy-' || i,
      ?5, ?5, ?5, NULL, ?5, ?5, NULL
    FROM seq
  `).bind(first, last, access.event.id, session.id, NOW).run();
}

function getAlbum(access: Access) {
  return createApp().request(`/api/manage/events/${access.event.id}/album`, {
    headers: { cookie: access.manager.cookie },
  }, testEnv);
}

function write(access: Access, suffix: string, body: unknown, method = 'POST') {
  return createApp().request(`/api/manage/events/${access.event.id}/album${suffix}`, {
    method,
    headers: { ...writeHeaders(access.manager), 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  }, testEnv);
}

async function albumOf(access: Access): Promise<AlbumView> {
  const response = await getAlbum(access);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { album: AlbumView } };
  return body.data.album;
}

describe('album read', () => {
  it('is empty and unsaved before anything is picked', async () => {
    const access = await eventAccess();
    const album = await albumOf(access);
    expect(album).toMatchObject({
      revision: 0,
      saved: false,
      title: 'Album',
      description: '',
      coverMediaId: null,
      effectiveCoverMediaId: null,
      photoCount: 0,
      sectionCount: 0,
      totalBytes: 0,
    });
    expect(album.entries).toEqual([]);
  });

  it('appends picks that have no stored position, in timeline order', async () => {
    const access = await eventAccess();
    await seedStored(access, 2, { timelineAt: '2026-09-19T12:00:00.000Z', favoritedAt: '2026-09-20T00:00:00.000Z' });
    await seedStored(access, 1, { timelineAt: '2026-09-19T11:00:00.000Z', favoritedAt: '2026-09-20T00:00:00.000Z' });
    await seedStored(access, 3, { timelineAt: '2026-09-19T13:00:00.000Z' });

    const album = await albumOf(access);
    expect(album.photoCount).toBe(2);
    expect(album.totalBytes).toBe(2048);
    expect(album.entries.map((entry) => (entry.kind === 'photo' ? entry.photo.id : entry.id)))
      .toEqual([mediaId(1), mediaId(2)]);
  });

  it('drops a stored position whose photo is no longer picked', async () => {
    const access = await eventAccess();
    const kept = await seedStored(access, 1, { favoritedAt: '2026-09-20T00:00:00.000Z' });
    const dropped = await seedStored(access, 2, { favoritedAt: '2026-09-20T00:00:00.000Z' });

    const saved = await write(access, '', {
      revision: 0,
      entries: [{ kind: 'photo', mediaId: dropped }, { kind: 'photo', mediaId: kept }],
    }, 'PUT');
    expect(saved.status).toBe(200);

    const unpicked = await write(access, '/picks', { mediaIds: [dropped], picked: false });
    expect(unpicked.status).toBe(200);

    const album = await albumOf(access);
    expect(album.photoCount).toBe(1);
    expect(album.entries).toHaveLength(1);
    expect(album.entries[0]).toMatchObject({ kind: 'photo' });
  });
});

describe('album order', () => {
  it('stores metadata and order atomically with one revision increment', async () => {
    const access = await eventAccess();
    const first = await seedStored(access, 1, {
      favoritedAt: '2026-09-20T00:00:00.000Z',
      byteSize: 1200,
    });
    const second = await seedStored(access, 2, {
      favoritedAt: '2026-09-20T00:00:00.000Z',
      publicationStatus: 'published',
      byteSize: 3400,
    });

    const response = await write(access, '', {
      revision: 0,
      entries: [
        { kind: 'photo', mediaId: second },
        { kind: 'photo', mediaId: first },
      ],
      metadata: {
        title: '  The evening  ',
        description: 'The photographs we kept together.',
        coverMediaId: first,
      },
    }, 'PUT');
    expect(response.status).toBe(200);

    const album = await albumOf(access);
    expect(album).toMatchObject({
      revision: 1,
      saved: true,
      title: 'The evening',
      description: 'The photographs we kept together.',
      coverMediaId: first,
      effectiveCoverMediaId: first,
      photoCount: 2,
      sectionCount: 0,
      totalBytes: 4600,
    });
    expect(album.entries.map((entry) => entry.kind === 'photo' ? entry.photo.id : entry.id))
      .toEqual([second, first]);
    expect(await env.DB.prepare(`
      SELECT revision, publication_status FROM event_albums
      JOIN media ON media.id = ?
      WHERE event_albums.event_id = ?
    `).bind(second, access.event.id).first()).toEqual({
      revision: 1,
      publication_status: 'published',
    });
  });

  it('stores an explicit order and reads it back', async () => {
    const access = await eventAccess();
    const first = await seedStored(access, 1, { timelineAt: '2026-09-19T11:00:00.000Z', favoritedAt: '2026-09-20T00:00:00.000Z' });
    const second = await seedStored(access, 2, { timelineAt: '2026-09-19T12:00:00.000Z', favoritedAt: '2026-09-20T00:00:00.000Z' });

    const response = await write(access, '', {
      revision: 0,
      entries: [
        { kind: 'section', id: 'sec-1', heading: 'Ceremony' },
        { kind: 'photo', mediaId: second },
        { kind: 'photo', mediaId: first },
      ],
    }, 'PUT');
    expect(response.status).toBe(200);

    const album = await albumOf(access);
    expect(album.saved).toBe(true);
    expect(album.sectionCount).toBe(1);
    expect(album.entries.map((entry) => (entry.kind === 'section' ? entry.heading : entry.photo.id)))
      .toEqual(['Ceremony', second, first]);
  });

  it('refuses a write composed against a stale revision', async () => {
    const access = await eventAccess();
    await write(access, '', {
      revision: 0,
      entries: [],
      metadata: { title: 'First', description: 'Kept', coverMediaId: null },
    }, 'PUT');
    const stale = await write(access, '', {
      revision: 0,
      entries: [{ kind: 'section', id: 'sec-1', heading: 'Late' }],
      metadata: { title: 'Stale', description: 'Lost', coverMediaId: null },
    }, 'PUT');
    expect(stale.status).toBe(409);
    expect(await albumOf(access)).toMatchObject({
      revision: 1,
      title: 'First',
      description: 'Kept',
      entries: [],
    });
  });

  it('preserves metadata when a pre-0018 client omits it', async () => {
    const access = await eventAccess();
    const picked = await seedStored(access, 1, { favoritedAt: NOW });
    const modern = await write(access, '', {
      revision: 0,
      entries: [{ kind: 'photo', mediaId: picked }],
      metadata: { title: 'Keepsake', description: 'Still here', coverMediaId: picked },
    }, 'PUT');
    expect(modern.status).toBe(200);

    const legacy = await write(access, '', {
      revision: 1,
      entries: [{ kind: 'section', id: 'sec-1', heading: 'Later' }, { kind: 'photo', mediaId: picked }],
    }, 'PUT');
    expect(legacy.status).toBe(200);
    expect(await albumOf(access)).toMatchObject({
      revision: 2,
      title: 'Keepsake',
      description: 'Still here',
      coverMediaId: picked,
      effectiveCoverMediaId: picked,
    });
  });

  it.each([
    ['blank title', { title: '   ', description: '', coverMediaId: null }],
    ['overlong title', {
      title: 't'.repeat(ALBUM_TITLE_MAX_LENGTH + 1),
      description: '',
      coverMediaId: null,
    }],
    ['overlong description', {
      title: 'Album',
      description: 'd'.repeat(ALBUM_DESCRIPTION_MAX_LENGTH + 1),
      coverMediaId: null,
    }],
    ['partial metadata', { title: 'Album', description: '' }],
  ])('refuses %s', async (_name, metadata) => {
    const access = await eventAccess();
    const response = await write(access, '', { revision: 0, entries: [], metadata }, 'PUT');
    expect(response.status).toBe(422);
    expect((await albumOf(access)).revision).toBe(0);
  });

  it('falls back to the first live photo after the explicit cover is unpicked', async () => {
    const access = await eventAccess();
    const fallback = await seedStored(access, 1, { favoritedAt: NOW });
    const explicit = await seedStored(access, 2, { favoritedAt: NOW });
    await write(access, '', {
      revision: 0,
      entries: [
        { kind: 'photo', mediaId: fallback },
        { kind: 'photo', mediaId: explicit },
      ],
      metadata: { title: 'Album', description: '', coverMediaId: explicit },
    }, 'PUT');

    const response = await write(access, '/picks', { mediaIds: [explicit], picked: false });
    expect(response.status).toBe(200);
    expect(await albumOf(access)).toMatchObject({
      coverMediaId: null,
      effectiveCoverMediaId: fallback,
      photoCount: 1,
    });
  });

  it('falls back to the first live photo after the explicit cover is deleted', async () => {
    const access = await eventAccess();
    const fallback = await seedStored(access, 1, { favoritedAt: NOW });
    const explicit = await seedStored(access, 2, { favoritedAt: NOW });
    await write(access, '', {
      revision: 0,
      entries: [
        { kind: 'photo', mediaId: fallback },
        { kind: 'photo', mediaId: explicit },
      ],
      metadata: { title: 'Album', description: '', coverMediaId: explicit },
    }, 'PUT');

    await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = ?
    `).bind(NOW, explicit).run();

    expect(await albumOf(access)).toMatchObject({
      coverMediaId: null,
      effectiveCoverMediaId: fallback,
      photoCount: 1,
    });
  });

  it('refuses more entries than an album holds', async () => {
    const access = await eventAccess();
    const entries = Array.from({ length: ALBUM_MAX_ENTRIES + 1 }, (_, index) => ({
      kind: 'section' as const,
      id: `sec-${index}`,
      heading: `Section ${index}`,
    }));
    const response = await write(access, '', { revision: 0, entries }, 'PUT');
    expect(response.status).toBe(422);
  });

  it('refuses a section heading that is only whitespace', async () => {
    const access = await eventAccess();
    const response = await write(access, '', {
      revision: 0,
      entries: [{ kind: 'section', id: 'sec-1', heading: '   ' }],
    }, 'PUT');
    expect(response.status).toBe(422);
  });

  it('measures section headings by Unicode code point at the Worker boundary', async () => {
    const access = await eventAccess();
    const accepted = await write(access, '', {
      revision: 0,
      entries: [{ kind: 'section', id: 'sec-emoji', heading: '💍'.repeat(80) }],
    }, 'PUT');
    const refused = await write(access, '', {
      revision: 1,
      entries: [{ kind: 'section', id: 'sec-emoji', heading: '💍'.repeat(81) }],
    }, 'PUT');

    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(422);
  });
});

describe('album picks', () => {
  it('reports only the photos it actually changed', async () => {
    const access = await eventAccess();
    const already = await seedStored(access, 1, { favoritedAt: '2026-09-20T00:00:00.000Z' });
    const fresh = await seedStored(access, 2);

    const response = await write(access, '/picks', { mediaIds: [already, fresh], picked: true });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { changed: { id: string }[] } };
    expect(body.data.changed.map((item) => item.id)).toEqual([fresh]);
  });

  it('leaves an unrelated event alone', async () => {
    const access = await eventAccess();
    const other = await eventAccess();
    const foreign = await seedStored(other, 1);
    const response = await write(access, '/picks', { mediaIds: [foreign], picked: true });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { changed: unknown[] } };
    expect(body.data.changed).toEqual([]);
    expect((await albumOf(other)).photoCount).toBe(0);
  });

  it('refuses single and bulk picks when photos plus sections already fill the album', async () => {
    const access = await eventAccess();
    const sections = Array.from({ length: 40 }, (_, index) => ({
      kind: 'section' as const,
      id: `sec-${index}`,
      heading: `Section ${index + 1}`,
    }));
    expect((await write(access, '', { revision: 0, entries: sections }, 'PUT')).status).toBe(200);
    const session = await env.DB
      .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
      .bind(access.event.id)
      .first<{ id: string }>();
    if (!session) throw new Error('Expected a guest session for the capacity fixture.');
    await env.DB.prepare(`
      WITH RECURSIVE seq(i) AS (
        SELECT 1000
        UNION ALL
        SELECT i + 1 FROM seq WHERE i < 1459
      )
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, caption, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
        favorited_at, deleted_at
      )
      SELECT
        printf('00000000-0000-4000-8000-%012d', i), ?, ?,
        'events/' || ? || '/media/final/' || i, 'canonical',
        'capacity-' || i || '.jpg', 'image/jpeg', 1024, 1024, 800, 600,
        'Avery Stone', NULL, 'stored', 'unpublished', 'capacity-' || i,
        ?, ?, ?, NULL, ?, ?, NULL
      FROM seq
    `).bind(
      access.event.id,
      session.id,
      access.event.id,
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
    ).run();
    const bulkCandidate = await seedStored(access, 900);
    const singleCandidate = await seedStored(access, 901);

    const bulk = await write(access, '/picks', { mediaIds: [bulkCandidate], picked: true });
    const single = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${singleCandidate}/favorite`,
      {
        method: 'PUT',
        headers: { ...writeHeaders(access.manager), 'content-type': 'application/json', origin },
        body: JSON.stringify({ favorite: true }),
      },
      testEnv,
    );

    expect(bulk.status).toBe(409);
    expect((await bulk.json() as { code: string }).code).toBe('ALBUM_FULL');
    expect(single.status).toBe(409);
    expect((await single.json() as { code: string }).code).toBe('ALBUM_FULL');
    expect((await albumOf(access)).entries).toHaveLength(ALBUM_MAX_ENTRIES);
  });

  it('atomically admits at most the remaining slot across concurrent single and bulk picks', async () => {
    const access = await eventAccess();
    const sections = Array.from({ length: 40 }, (_, index) => ({
      kind: 'section' as const,
      id: `sec-${index}`,
      heading: `Section ${index + 1}`,
    }));
    expect((await write(access, '', { revision: 0, entries: sections }, 'PUT')).status).toBe(200);
    const session = await env.DB
      .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
      .bind(access.event.id)
      .first<{ id: string }>();
    if (!session) throw new Error('Expected a guest session for the capacity fixture.');
    await env.DB.prepare(`
      WITH RECURSIVE seq(i) AS (
        SELECT 2000
        UNION ALL
        SELECT i + 1 FROM seq WHERE i < 2458
      )
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, caption, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
        favorited_at, deleted_at
      )
      SELECT
        printf('00000000-0000-4000-8000-%012d', i), ?, ?,
        'events/' || ? || '/media/final/' || i, 'canonical',
        'capacity-' || i || '.jpg', 'image/jpeg', 1024, 1024, 800, 600,
        'Avery Stone', NULL, 'stored', 'unpublished', 'capacity-' || i,
        ?, ?, ?, NULL, ?, ?, NULL
      FROM seq
    `).bind(
      access.event.id,
      session.id,
      access.event.id,
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
    ).run();
    expect((await albumOf(access)).entries).toHaveLength(ALBUM_MAX_ENTRIES - 1);
    const bulkCandidate = await seedStored(access, 902);
    const singleCandidate = await seedStored(access, 903);

    const [bulk, single] = await Promise.all([
      write(access, '/picks', { mediaIds: [bulkCandidate], picked: true }),
      createApp().request(
        `/api/manage/events/${access.event.id}/media/${singleCandidate}/favorite`,
        {
          method: 'PUT',
          headers: { ...writeHeaders(access.manager), 'content-type': 'application/json', origin },
          body: JSON.stringify({ favorite: true }),
        },
        testEnv,
      ),
    ]);

    expect([bulk.status, single.status].sort()).toEqual([200, 409]);
    const refused = bulk.status === 409 ? bulk : single;
    expect((await refused.json() as { code: string }).code).toBe('ALBUM_FULL');
    expect((await albumOf(access)).entries).toHaveLength(ALBUM_MAX_ENTRIES);
  });

  it('atomically shares the final slot between a pick and a same-revision section save', async () => {
    const access = await eventAccess();
    const session = await env.DB
      .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
      .bind(access.event.id)
      .first<{ id: string }>();
    if (!session) throw new Error('Expected a guest session for the capacity fixture.');
    await env.DB.prepare(`
      WITH RECURSIVE seq(i) AS (
        SELECT 3000
        UNION ALL
        SELECT i + 1 FROM seq WHERE i < 3498
      )
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, caption, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
        favorited_at, deleted_at
      )
      SELECT
        printf('00000000-0000-4000-8000-%012d', i), ?, ?,
        'events/' || ? || '/media/final/' || i, 'canonical',
        'capacity-' || i || '.jpg', 'image/jpeg', 1024, 1024, 800, 600,
        'Avery Stone', NULL, 'stored', 'unpublished', 'capacity-' || i,
        ?, ?, ?, NULL, ?, ?, NULL
      FROM seq
    `).bind(
      access.event.id,
      session.id,
      access.event.id,
      NOW,
      NOW,
      NOW,
      NOW,
      NOW,
    ).run();
    expect((await albumOf(access)).entries).toHaveLength(ALBUM_MAX_ENTRIES - 1);
    const candidate = await seedStored(access, 905);

    const [pick, section] = await Promise.all([
      write(access, '/picks', { mediaIds: [candidate], picked: true }),
      write(access, '', {
        revision: 0,
        entries: [{ kind: 'section', id: 'last-slot', heading: 'Last slot' }],
        metadata: { title: 'Album', description: '', coverMediaId: null },
      }, 'PUT'),
    ]);

    expect([pick.status, section.status].sort()).toEqual([200, 409]);
    const refused = pick.status === 409 ? pick : section;
    expect((await refused.json() as { code: string }).code).toBe('ALBUM_FULL');
    expect((await albumOf(access)).entries.length).toBeLessThanOrEqual(ALBUM_MAX_ENTRIES);
  });
});

describe('album start', () => {
  it.each(['from-picks', 'empty'] as const)(
    'refuses %s without changing an unsaved legacy set above the album cap',
    async (start) => {
      const access = await eventAccess();
      await seedLegacyFavorites(access, ALBUM_MAX_ENTRIES + 1);

      const response = await write(access, '/start', { start });

      expect(response.status).toBe(409);
      expect(await response.json() as { code: string; message: string }).toMatchObject({
        code: 'ALBUM_FULL',
        message: expect.stringMatching(/remove picks in Library/iu),
      });
      expect(await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM media
        WHERE event_id = ? AND favorited_at IS NOT NULL
      `).bind(access.event.id).first<number>('count')).toBe(ALBUM_MAX_ENTRIES + 1);
      expect(await env.DB.prepare(`
        SELECT entries, saved_at FROM event_albums WHERE event_id = ?
      `).bind(access.event.id).first()).toEqual({ entries: '[]', saved_at: null });
    },
  );

  it('keeps earlier favorites and marks the album saved', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { favoritedAt: '2026-09-20T00:00:00.000Z' });
    const response = await write(access, '/start', { start: 'from-picks' });
    expect(response.status).toBe(200);

    const album = await albumOf(access);
    expect(album.saved).toBe(true);
    expect(album.photoCount).toBe(1);
  });

  it('stores the starting picks in timeline order so a later older pick appends', async () => {
    const access = await eventAccess();
    const later = await seedStored(access, 2, {
      timelineAt: '2026-09-19T12:00:00.000Z',
      favoritedAt: '2026-09-20T00:00:00.000Z',
    });
    const earlier = await seedStored(access, 1, {
      timelineAt: '2026-09-19T11:00:00.000Z',
      favoritedAt: '2026-09-20T00:00:00.000Z',
    });
    const pickedAfterStart = await seedStored(access, 3, {
      timelineAt: '2026-09-19T10:00:00.000Z',
    });

    expect((await write(access, '/start', { start: 'from-picks' })).status).toBe(200);
    expect((await write(access, '/picks', {
      mediaIds: [pickedAfterStart],
      picked: true,
    })).status).toBe(200);

    const album = await albumOf(access);
    expect(album.entries.map((entry) => entry.kind === 'photo' ? entry.photo.id : entry.id))
      .toEqual([earlier, later, pickedAfterStart]);
  });

  it('clears earlier favorites, reports them, and stays saved', async () => {
    const access = await eventAccess();
    const first = await seedStored(access, 1, { favoritedAt: '2026-09-20T00:00:00.000Z' });
    const second = await seedStored(access, 2, { favoritedAt: '2026-09-20T00:00:00.000Z' });

    const response = await write(access, '/start', { start: 'empty' });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { cleared: string[] } };
    expect([...body.data.cleared].sort()).toEqual([first, second].sort());

    const album = await albumOf(access);
    expect(album.saved).toBe(true);
    expect(album.photoCount).toBe(0);
  });

  it('restores a cleared album through the ordinary bulk pick path', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { favoritedAt: '2026-09-20T00:00:00.000Z' });
    const cleared = await write(access, '/start', { start: 'empty' });
    const body = await cleared.json() as { data: { cleared: string[] } };

    const restored = await write(access, '/picks', { mediaIds: body.data.cleared, picked: true });
    expect(restored.status).toBe(200);
    expect((await albumOf(access)).photoCount).toBe(1);
  });

  it('does not let a stale Start empty retry clear a pick added after reconciliation', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { favoritedAt: '2026-09-20T00:00:00.000Z' });
    const pickedAfterStart = await seedStored(access, 2);

    const winner = await write(access, '/start', { start: 'empty' });
    expect(winner.status).toBe(200);
    expect((await winner.json() as { data: { started: boolean; cleared: string[] } }).data)
      .toMatchObject({ started: true, cleared: [mediaId(1)] });
    expect((await write(access, '/picks', {
      mediaIds: [pickedAfterStart],
      picked: true,
    })).status).toBe(200);

    const staleRetry = await write(access, '/start', { start: 'empty' });
    expect(staleRetry.status).toBe(200);
    expect((await staleRetry.json() as {
      data: { started: boolean; cleared: string[]; album: AlbumView };
    }).data).toMatchObject({
      started: false,
      cleared: [],
      album: { saved: true, photoCount: 1 },
    });
    expect((await albumOf(access)).entries.map((entry) => (
      entry.kind === 'photo' ? entry.photo.id : entry.id
    ))).toEqual([pickedAfterStart]);
  });
});

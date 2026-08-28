import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_MAX_ENTRIES,
  ALBUM_TITLE_MAX_LENGTH,
} from '../../shared/constants';
import type { AlbumEntryView, AlbumView, PublicAlbumView } from '../../shared/contracts';
import { AlbumRepository } from '../../worker/db/album';
import {
  eventAccess,
  hostAccess,
  hostWriteHeaders,
  origin,
  resetDatabase,
  testEnv,
  trashMedia,
  uploadPending,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);

type Access = Awaited<ReturnType<typeof eventAccess>>;
const NOW = '2026-08-23T00:00:00.000Z';
const RECONCILIATION_RESTORE_UNTIL = '2026-09-01T00:00:00.000Z';
const RECONCILIATION_EXPIRED_RESTORE_UNTIL = '2026-08-24T00:00:00.000Z';

function mediaId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/**
 * The album row this entry occupies, named the way a host would name it: the
 * photograph, the photograph a retained slot is still holding a place for, or
 * the section divider itself. Written once because an album entry became a
 * three-way union the moment trash could stand in for a picture.
 */
function entryId(entry: AlbumEntryView): string {
  if (entry.kind === 'photo') return entry.photo.id;
  if (entry.kind === 'photo-retained') return entry.slot.mediaId;
  return entry.id;
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

interface ReconciliationPickSegment {
  count: number;
  version: 1 | null;
  retention?: 'recoverable' | 'expired-cleanup-pending';
}

/**
 * Builds provenance fixtures without giving timestamp ordering any information:
 * every created, stored, captured, timeline, and favorite instant is identical.
 */
async function seedReconciliationFixture(
  access: Access,
  options: {
    pickGeneration: number;
    segments?: ReconciliationPickSegment[];
    saved?: boolean;
  },
) {
  const session = await env.DB
    .prepare("SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1")
    .bind(access.event.id)
    .first<{ id: string }>();
  if (!session) throw new Error('Expected a guest session for the reconciliation fixture.');

  let firstIndex = 20_000;
  for (const segment of options.segments ?? []) {
    if (segment.count === 0) continue;
    const trashedAt = segment.retention ? NOW : null;
    const restoreUntil = segment.retention === 'expired-cleanup-pending'
      ? RECONCILIATION_EXPIRED_RESTORE_UNTIL
      : segment.retention === 'recoverable'
        ? RECONCILIATION_RESTORE_UNTIL
        : null;
    await env.DB.prepare(`
      WITH RECURSIVE seq(i) AS (
        SELECT 0
        UNION ALL
        SELECT i + 1 FROM seq WHERE i + 1 < ?1
      )
      INSERT INTO media (
        id, event_id, uploader_session_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, caption, upload_state, publication_status, idempotency_key,
        reservation_expires_at, created_at, stored_at, captured_at, timeline_at,
        favorited_at, deleted_at, trashed_at, restore_until, album_pick_version
      )
      SELECT
        printf('00000000-0000-4000-8000-%012d', ?2 + i), ?3, ?4,
        'events/' || ?3 || '/media/final/'
          || printf('00000000-0000-4000-8000-%012d', ?2 + i),
        'canonical', 'reconciliation-' || (?2 + i) || '.jpg', 'image/jpeg',
        1024, 1024, 800, 600, 'Avery Stone', NULL, 'stored', 'unpublished',
        'reconciliation-' || (?2 + i), ?5, ?5, ?5, ?5, ?5, ?5, ?6, ?6, ?7, ?8
      FROM seq
    `).bind(
      segment.count,
      firstIndex,
      access.event.id,
      session.id,
      NOW,
      trashedAt,
      restoreUntil,
      segment.version,
    ).run();
    firstIndex += segment.count;
  }

  await env.DB.prepare('UPDATE events SET album_pick_generation = ? WHERE id = ?')
    .bind(options.pickGeneration, access.event.id)
    .run();

  if (options.saved) {
    await env.DB.prepare(`
      INSERT INTO event_albums (
        event_id, entries, saved_at, revision, title, description,
        cover_media_id, created_at, updated_at
      ) VALUES (?, '[]', ?, 0, 'Album', '', NULL, ?, ?)
    `).bind(access.event.id, NOW, NOW, NOW).run();
  }
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
  const raw = await response.text();
  expect(raw).not.toContain('album_pick_version');
  expect(raw).not.toContain('albumPickVersion');
  const body = JSON.parse(raw) as { data: { album: AlbumView } };
  return body.data.album;
}

type AlbumStartChoice = 'from-picks' | 'empty';
type ExpectedReconciliation = NonNullable<AlbumView['reconciliation']>['kind'];

function expectedStartBody(
  choice: AlbumStartChoice,
  album: AlbumView,
  expectedReconciliation: ExpectedReconciliation,
) {
  return {
    start: choice,
    expectedReconciliation,
    expectedPickGeneration: album.pickGeneration,
    expectedRevision: album.revision,
  } as const;
}

function writeAsHost(
  access: Access,
  host: { cookie: string; csrf: string },
  body: unknown,
) {
  return createApp().request(`/api/manage/events/${access.event.id}/album/start`, {
    method: 'POST',
    headers: hostWriteHeaders(host),
    body: JSON.stringify(body),
  }, testEnv);
}

/** The four durable facts a refused Start must leave byte-for-byte unchanged. */
async function albumStartMutationState(access: Access) {
  const album = await env.DB.prepare(`
    SELECT entries, saved_at, revision
    FROM event_albums
    WHERE event_id = ?
  `).bind(access.event.id).first<{
    entries: string;
    saved_at: string | null;
    revision: number;
  }>();
  const favorites = await env.DB.prepare(`
    SELECT id, favorited_at, album_pick_version, deleted_at, trashed_at
    FROM media
    WHERE event_id = ? AND favorited_at IS NOT NULL
    ORDER BY id ASC
  `).bind(access.event.id).all<{
    id: string;
    favorited_at: string;
    album_pick_version: number | null;
    deleted_at: string | null;
    trashed_at: string | null;
  }>();
  return { album: album ?? null, favorites: favorites.results };
}

describe('album read', () => {
  it('uses the event name as a new Album title and preserves a customized title', async () => {
    const access = await eventAccess('Maya & Theo');

    expect((await albumOf(access)).title).toBe('Maya & Theo');

    const saved = await write(access, '', {
      revision: 0,
      entries: [],
      metadata: { title: 'The evening', description: '', coverMediaId: null },
    }, 'PUT');
    expect(saved.status).toBe(200);
    expect((await albumOf(access)).title).toBe('The evening');
  });

  it('is empty and unsaved before anything is picked', async () => {
    const access = await eventAccess();
    const album = await albumOf(access);
    // Exact rather than partial: an album a host has never touched is the one
    // read where every field of the contract should be visible at once.
    expect(album).toEqual({
      revision: 0,
      saved: false,
      pickGeneration: 0,
      reconciliation: null,
      title: 'Maya & Theo',
      description: '',
      coverMediaId: null,
      effectiveCoverMediaId: null,
      coverRetained: null,
      entries: [],
      photoCount: 0,
      retainedCount: 0,
      sectionCount: 0,
      totalBytes: 0,
    });
  });

  it('appends picks that have no stored position, in timeline order', async () => {
    const access = await eventAccess();
    await seedStored(access, 2, { timelineAt: '2026-09-19T12:00:00.000Z', favoritedAt: '2026-09-20T00:00:00.000Z' });
    await seedStored(access, 1, { timelineAt: '2026-09-19T11:00:00.000Z', favoritedAt: '2026-09-20T00:00:00.000Z' });
    await seedStored(access, 3, { timelineAt: '2026-09-19T13:00:00.000Z' });

    const album = await albumOf(access);
    expect(album.photoCount).toBe(2);
    expect(album.totalBytes).toBe(2048);
    expect(album.entries.map(entryId)).toEqual([mediaId(1), mediaId(2)]);
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

describe('album reconciliation', () => {
  const cases: Array<{
    name: string;
    pickGeneration: number;
    segments?: ReconciliationPickSegment[];
    saved?: boolean;
    reconciliation:
      | { kind: 'initialize' }
      | { kind: 'historical'; historicalPickCount: number }
      | { kind: 'over-capacity'; pickCount: number; historicalPickCount: number }
      | null;
    retainedCount?: number;
    retainedState?: 'recoverable' | 'expired-cleanup-pending';
  }> = [
    {
      name: 'a saved album',
      pickGeneration: 31,
      segments: [{ count: 1, version: 1 }],
      saved: true,
      reconciliation: null,
    },
    {
      name: 'an unsaved album with zero picks',
      pickGeneration: 32,
      reconciliation: null,
    },
    {
      name: 'one unversioned pick',
      pickGeneration: 33,
      segments: [{ count: 1, version: null }],
      reconciliation: { kind: 'historical', historicalPickCount: 1 },
    },
    {
      name: 'an under-cap cohort containing only version 1 picks',
      pickGeneration: 34,
      segments: [{ count: 2, version: 1 }],
      reconciliation: { kind: 'initialize' },
    },
    {
      name: 'an under-cap mixed cohort',
      pickGeneration: 35,
      segments: [{ count: 1, version: 1 }, { count: 1, version: null }],
      reconciliation: { kind: 'historical', historicalPickCount: 1 },
    },
    {
      name: 'exactly 500 version 1 picks',
      pickGeneration: 36,
      segments: [{ count: ALBUM_MAX_ENTRIES, version: 1 }],
      reconciliation: { kind: 'initialize' },
    },
    {
      name: '501 version 1 picks',
      pickGeneration: 37,
      segments: [{ count: ALBUM_MAX_ENTRIES + 1, version: 1 }],
      reconciliation: {
        kind: 'over-capacity',
        pickCount: ALBUM_MAX_ENTRIES + 1,
        historicalPickCount: 0,
      },
    },
    {
      name: '501 mixed picks',
      pickGeneration: 38,
      segments: [
        { count: ALBUM_MAX_ENTRIES, version: 1 },
        { count: 1, version: null },
      ],
      reconciliation: {
        kind: 'over-capacity',
        pickCount: ALBUM_MAX_ENTRIES + 1,
        historicalPickCount: 1,
      },
    },
    {
      name: 'a cohort that reaches 500 only with a retained historical pick',
      pickGeneration: 39,
      segments: [
        { count: ALBUM_MAX_ENTRIES - 1, version: 1 },
        { count: 1, version: null, retention: 'recoverable' },
      ],
      reconciliation: { kind: 'historical', historicalPickCount: 1 },
      retainedCount: 1,
      retainedState: 'recoverable',
    },
    {
      name: 'an expired cleanup-pending retained version 1 pick',
      pickGeneration: 40,
      segments: [{ count: 1, version: 1, retention: 'expired-cleanup-pending' }],
      reconciliation: { kind: 'initialize' },
      retainedCount: 1,
      retainedState: 'expired-cleanup-pending',
    },
  ];

  it.each(cases)('projects reconciliation for $name', async (fixture) => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, fixture);

    const album = await albumOf(access);

    expect(album).toMatchObject({
      pickGeneration: fixture.pickGeneration,
      reconciliation: fixture.reconciliation,
    });
    if (fixture.retainedCount !== undefined) {
      expect(album.retainedCount).toBe(fixture.retainedCount);
      expect(album.entries).toContainEqual({
        kind: 'photo-retained',
        slot: expect.objectContaining({ state: fixture.retainedState }),
      });
    }
  });

  it('keeps one coherent reconciliation observation across a concurrent unpick', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 0,
      segments: [{ count: 1, version: 1 }],
    });

    let finishMutation!: () => void;
    const mutationFinished = new Promise<void>((resolve) => { finishMutation = resolve; });
    let interleaved = false;
    const mutateAfterSnapshot = async () => {
      if (interleaved) return;
      interleaved = true;
      await env.DB.prepare(`
        UPDATE media
        SET favorited_at = NULL, album_pick_version = NULL
        WHERE id = ? AND event_id = ?
      `).bind(mediaId(20_000), access.event.id).run();
      finishMutation();
    };
    const interleavingDb = new Proxy(env.DB, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (sql: string) => {
          const observesGeneration = sql.includes('album_pick_generation');
          const observesPicks = sql.includes('historical_pick_count');
          const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'bind') {
                return (...values: unknown[]) => wrap(statementTarget.bind(...values));
              }
              if (statementProperty === 'all' && observesPicks) {
                return async (...args: unknown[]) => {
                  const result = await Reflect.apply(statementTarget.all, statementTarget, args);
                  await mutateAfterSnapshot();
                  return result;
                };
              }
              if (statementProperty === 'first' && observesGeneration && !observesPicks) {
                return async (...args: unknown[]) => {
                  await mutationFinished;
                  return Reflect.apply(statementTarget.first, statementTarget, args);
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementTarget) as unknown;
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
          return wrap(target.prepare(sql));
        };
      },
    });

    const album = await new AlbumRepository(interleavingDb).get(access.event.id, NOW);

    expect(interleaved).toBe(true);
    expect(album).toMatchObject({
      pickGeneration: 0,
      reconciliation: { kind: 'initialize' },
      photoCount: 1,
    });
    expect(await env.DB.prepare(`
      SELECT album_pick_generation FROM events WHERE id = ?
    `).bind(access.event.id).first<number>('album_pick_generation')).toBe(1);
    expect(await env.DB.prepare('SELECT favorited_at FROM media WHERE id = ?')
      .bind(mediaId(20_000)).first<string>('favorited_at')).toBeNull();
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
      coverRetained: null,
      photoCount: 2,
      retainedCount: 0,
      sectionCount: 0,
      totalBytes: 4600,
    });
    expect(album.entries.map(entryId)).toEqual([second, first]);
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
    expect(album.entries.map((entry) => (entry.kind === 'section' ? entry.heading : entryId(entry))))
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

  it('deduplicates duplicate album pick IDs while retaining the raw request ceiling', async () => {
    const access = await eventAccess();
    const id = await seedStored(access, 3);

    const response = await write(access, '/picks', {
      mediaIds: [id, id, id],
      picked: true,
    });

    expect(response.status).toBe(200);
    expect((await response.json() as { data: { changed: { id: string }[] } }).data.changed)
      .toEqual([expect.objectContaining({ id })]);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM media
      WHERE event_id = ? AND id = ? AND favorited_at IS NOT NULL
    `).bind(access.event.id, id).first<number>('count')).toBe(1);

    const oversized = await write(access, '/picks', {
      mediaIds: Array.from({ length: ALBUM_MAX_ENTRIES + 1 }, () => id),
      picked: true,
    });
    expect(oversized.status).toBe(422);
    expect((await oversized.json() as { code: string }).code).toBe('VALIDATION_FAILED');
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
  it('refuses from-picks without changing an unsaved legacy set above the album cap', async () => {
    const access = await eventAccess();
    await seedLegacyFavorites(access, ALBUM_MAX_ENTRIES + 1);

    const response = await write(access, '/start', { start: 'from-picks' });

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
  });

  it('lets Start empty clear and save an unsaved legacy set above the album cap', async () => {
    const access = await eventAccess();
    await seedLegacyFavorites(access, ALBUM_MAX_ENTRIES + 1);
    const expected = Array.from(
      { length: ALBUM_MAX_ENTRIES + 1 },
      (_, offset) => mediaId(1_000 + offset),
    );

    const response = await write(access, '/start', { start: 'empty' });

    expect(response.status).toBe(200);
    const result = (await response.json() as {
      data: { started: boolean; cleared: string[]; album: AlbumView };
    }).data;
    expect(result.started).toBe(true);
    expect([...result.cleared].sort()).toEqual(expected.sort());
    expect(result.album).toMatchObject({ saved: true, entries: [], photoCount: 0 });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM media
      WHERE event_id = ? AND favorited_at IS NOT NULL
    `).bind(access.event.id).first<number>('count')).toBe(0);
  });

  it('keeps earlier favorites and marks the album saved', async () => {
    const access = await eventAccess();
    await seedStored(access, 1, { favoritedAt: '2026-09-20T00:00:00.000Z' });
    const response = await write(access, '/start', { start: 'from-picks' });
    expect(response.status).toBe(200);

    const album = await albumOf(access);
    expect(album.saved).toBe(true);
    expect(album.photoCount).toBe(1);
  });

  it('starts a retained-only unsaved album from picks without losing its recovery slot', async () => {
    const access = await eventAccess();
    const media = await uploadPending(
      access,
      `retained-start-${crypto.randomUUID()}`,
      null,
      'Avery Stone',
    );
    await env.DB.prepare('UPDATE media SET favorited_at = ?, timeline_at = ? WHERE id = ?')
      .bind(NOW, '2026-09-19T11:00:00.000Z', media.id)
      .run();
    const trashed = await trashMedia(access, media.id);

    expect(await albumOf(access)).toMatchObject({
      saved: false,
      photoCount: 0,
      retainedCount: 1,
      entries: [{
        kind: 'photo-retained',
        slot: { mediaId: media.id, restoreUntil: trashed.restoreUntil, state: 'recoverable' },
      }],
    });

    const response = await write(access, '/start', { start: 'from-picks' });

    expect(response.status).toBe(200);
    expect((await response.json() as { data: { started: boolean; album: AlbumView } }).data)
      .toMatchObject({
        started: true,
        album: {
          saved: true,
          photoCount: 0,
          retainedCount: 1,
          entries: [{
            kind: 'photo-retained',
            slot: { mediaId: media.id, restoreUntil: trashed.restoreUntil, state: 'recoverable' },
          }],
        },
      });
    expect(await albumOf(access)).toMatchObject({
      saved: true,
      photoCount: 0,
      retainedCount: 1,
      entries: [{
        kind: 'photo-retained',
        slot: { mediaId: media.id, restoreUntil: trashed.restoreUntil, state: 'recoverable' },
      }],
    });
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
    expect(album.entries.map(entryId)).toEqual([earlier, later, pickedAfterStart]);
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
    expect((await albumOf(access)).entries.map(entryId)).toEqual([pickedAfterStart]);
  });
});

describe('album start expectedPickGeneration expectation triple', () => {
  it('requires all three new-client expectations rather than widening the legacy shape', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 10,
      segments: [{ count: 1, version: 1 }],
    });
    const album = await albumOf(access);
    const complete = expectedStartBody('from-picks', album, 'initialize');

    for (const omitted of [
      'expectedReconciliation',
      'expectedPickGeneration',
      'expectedRevision',
    ] as const) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[omitted];
      expect((await write(access, '/start', partial)).status).toBe(422);
    }
    expect(await albumStartMutationState(access)).toEqual({
      album: null,
      favorites: [expect.objectContaining({ id: mediaId(20_000) })],
    });
  });

  it.each(['from-picks', 'empty'] as const)(
    'a matching %s Start advances revision once, blocks the pre-Start PUT, then an ordinary save advances it once more',
    async (choice) => {
      const access = await eventAccess();
      await seedReconciliationFixture(access, {
        pickGeneration: 11,
        segments: [{ count: 1, version: 1 }],
      });
      const before = await albumOf(access);

      const response = await write(
        access,
        '/start',
        expectedStartBody(choice, before, 'initialize'),
      );

      expect(response.status).toBe(200);
      const result = (await response.json() as {
        data: { started: boolean; cleared: string[]; album: AlbumView };
      }).data;
      expect(result.started).toBe(true);
      expect(result.album).toMatchObject({ saved: true, revision: before.revision + 1 });
      expect(result.album.revision).toBeGreaterThan(before.revision);
      expect(result.cleared).toHaveLength(choice === 'empty' ? 1 : 0);

      const preStartEntries = result.album.entries;
      const staleSave = await write(access, '', {
        revision: before.revision,
        entries: [{ kind: 'section', id: 'stale-section', heading: 'Stale section' }],
      }, 'PUT');
      expect(staleSave.status).toBe(409);
      expect(await staleSave.json() as { code: string }).toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      expect(await albumOf(access)).toMatchObject({
        revision: before.revision + 1,
        entries: preStartEntries,
      });

      const ordinarySave = await write(access, '', {
        revision: before.revision + 1,
        entries: [],
        metadata: { title: 'After Start', description: '', coverMediaId: null },
      }, 'PUT');
      expect(ordinarySave.status).toBe(200);
      expect(await albumOf(access)).toMatchObject({
        revision: before.revision + 2,
        title: 'After Start',
      });
    },
  );

  it.each([
    { mismatch: 'category', choice: 'from-picks' },
    { mismatch: 'category', choice: 'empty' },
    { mismatch: 'generation', choice: 'from-picks' },
    { mismatch: 'generation', choice: 'empty' },
    { mismatch: 'revision', choice: 'from-picks' },
    { mismatch: 'revision', choice: 'empty' },
  ] as const)(
    'a stale $mismatch on $choice returns the canonical conflict without changing favorites, entries, saved state, or revision',
    async ({ mismatch, choice }) => {
      const access = await eventAccess();
      await seedReconciliationFixture(access, {
        pickGeneration: 20,
        segments: [{ count: 1, version: mismatch === 'category' ? null : 1 }],
      });
      const observed = await albumOf(access);
      const body = expectedStartBody(choice, observed, 'initialize');

      if (mismatch === 'generation') {
        await env.DB.prepare(`
          UPDATE events
          SET album_pick_generation = album_pick_generation + 1
          WHERE id = ?
        `).bind(access.event.id).run();
      } else if (mismatch === 'revision') {
        const concurrentSave = await write(access, '', {
          revision: observed.revision,
          entries: [{ kind: 'photo', mediaId: mediaId(20_000) }],
          metadata: { title: 'Cohost save', description: '', coverMediaId: null },
        }, 'PUT');
        expect(concurrentSave.status).toBe(200);
      }

      const beforeRequest = await albumStartMutationState(access);
      const response = await write(access, '/start', body);

      expect(response.status).toBe(409);
      expect(await response.json() as { code: string }).toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      expect(await albumStartMutationState(access)).toEqual(beforeRequest);
    },
  );

  it('conflicts on a same-count substitution even though the category and count are unchanged', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 30,
      segments: [{ count: 2, version: 1 }],
    });
    // Arrange the second identically-timestamped row as the unpicked replacement.
    await env.DB.prepare(`
      UPDATE media
      SET favorited_at = NULL, album_pick_version = NULL
      WHERE id = ? AND event_id = ?
    `).bind(mediaId(20_001), access.event.id).run();
    await env.DB.prepare('UPDATE events SET album_pick_generation = 30 WHERE id = ?')
      .bind(access.event.id)
      .run();
    const observed = await albumOf(access);
    expect(observed).toMatchObject({
      pickGeneration: 30,
      reconciliation: { kind: 'initialize' },
      photoCount: 1,
    });

    await env.DB.batch([
      env.DB.prepare(`
        UPDATE media
        SET favorited_at = NULL, album_pick_version = NULL
        WHERE id = ? AND event_id = ?
      `).bind(mediaId(20_000), access.event.id),
      env.DB.prepare(`
        UPDATE media
        SET favorited_at = ?, album_pick_version = 1
        WHERE id = ? AND event_id = ?
      `).bind(NOW, mediaId(20_001), access.event.id),
    ]);
    expect(await albumOf(access)).toMatchObject({
      pickGeneration: 32,
      reconciliation: { kind: 'initialize' },
      photoCount: 1,
    });
    const beforeRequest = await albumStartMutationState(access);

    const response = await write(
      access,
      '/start',
      expectedStartBody('from-picks', observed, 'initialize'),
    );

    expect(response.status).toBe(409);
    expect(await response.json() as { code: string }).toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(await albumStartMutationState(access)).toEqual(beforeRequest);
  });

  it('conflicts when an identically-timestamped retained historical pick is restored after the read', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 40,
      segments: [{ count: 1, version: null, retention: 'recoverable' }],
    });
    const observed = await albumOf(access);
    expect(observed).toMatchObject({
      pickGeneration: 40,
      reconciliation: { kind: 'historical', historicalPickCount: 1 },
      retainedCount: 1,
    });
    await env.DB.prepare(`
      UPDATE media
      SET deleted_at = NULL, trashed_at = NULL, restore_until = NULL
      WHERE id = ? AND event_id = ?
    `).bind(mediaId(20_000), access.event.id).run();
    const beforeRequest = await albumStartMutationState(access);

    const response = await write(
      access,
      '/start',
      expectedStartBody('from-picks', observed, 'historical'),
    );

    expect(response.status).toBe(409);
    expect(await response.json() as { code: string }).toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(await albumStartMutationState(access)).toEqual(beforeRequest);
  });

  it('allows exactly one concurrent first-save winner across opposite choices', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 50,
      segments: [{ count: 1, version: 1 }],
    });
    const observed = await albumOf(access);

    const responses = await Promise.all([
      write(access, '/start', expectedStartBody('from-picks', observed, 'initialize')),
      write(access, '/start', expectedStartBody('empty', observed, 'initialize')),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(loser).toBeDefined();
    expect(await loser!.json() as { code: string }).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS saved_count, MAX(revision) AS revision
      FROM event_albums
      WHERE event_id = ? AND saved_at IS NOT NULL
    `).bind(access.event.id).first()).toEqual({ saved_count: 1, revision: 1 });
  });

  it('allows exactly one winner when two account cohosts Start from the same Album view', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 60,
      segments: [{ count: 1, version: 1 }],
    });
    const owner = await hostAccess([access]);
    const cohost = await hostAccess();
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, ?, 'cohost', ?)
    `).bind(access.event.id, cohost.account.id, NOW).run();
    const observed = await albumOf(access);
    const body = expectedStartBody('from-picks', observed, 'initialize');

    const responses = await Promise.all([
      writeAsHost(access, owner, body),
      writeAsHost(access, cohost, body),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(loser).toBeDefined();
    expect(await loser!.json() as { code: string }).toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(await albumOf(access)).toMatchObject({ saved: true, revision: 1, photoCount: 1 });
  });

  it('refuses Start from picks at 501 while preserving the complete cohort', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 70,
      segments: [{ count: ALBUM_MAX_ENTRIES + 1, version: 1 }],
    });
    const observed = await albumOf(access);
    const beforeRequest = await albumStartMutationState(access);

    const response = await write(
      access,
      '/start',
      expectedStartBody('from-picks', observed, 'over-capacity'),
    );

    expect(response.status).toBe(409);
    expect(await response.json() as { code: string }).toMatchObject({ code: 'ALBUM_FULL' });
    expect(await albumStartMutationState(access)).toEqual(beforeRequest);
  });

  it('lets Start empty at 501 clear every active and retained favorite', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 80,
      segments: [
        { count: ALBUM_MAX_ENTRIES, version: 1 },
        { count: 1, version: null, retention: 'recoverable' },
      ],
    });
    const observed = await albumOf(access);

    const response = await write(
      access,
      '/start',
      expectedStartBody('empty', observed, 'over-capacity'),
    );

    expect(response.status).toBe(200);
    const result = (await response.json() as {
      data: { started: boolean; cleared: string[]; album: AlbumView };
    }).data;
    expect(result).toMatchObject({
      started: true,
      album: { saved: true, revision: 1, entries: [], retainedCount: 0 },
    });
    expect(result.cleared).toHaveLength(ALBUM_MAX_ENTRIES + 1);
    expect(result.cleared).toContain(mediaId(20_500));
    expect((await albumStartMutationState(access)).favorites).toEqual([]);
  });

  it('materializes active and retained picks together in deterministic timeline order', async () => {
    const access = await eventAccess();
    await seedReconciliationFixture(access, {
      pickGeneration: 90,
      segments: [
        { count: 1, version: 1 },
        { count: 1, version: 1, retention: 'recoverable' },
      ],
    });
    const observed = await albumOf(access);

    const response = await write(
      access,
      '/start',
      expectedStartBody('from-picks', observed, 'initialize'),
    );

    expect(response.status).toBe(200);
    const album = (await response.json() as { data: { album: AlbumView } }).data.album;
    expect(album.entries.map(entryId)).toEqual([mediaId(20_000), mediaId(20_001)]);
    expect(album.entries[1]).toMatchObject({
      kind: 'photo-retained',
      slot: { mediaId: mediaId(20_001) },
    });
  });

  it.each(['from-picks', 'empty'] as const)(
    'keeps the one-release legacy %s body explicitly unguarded and revision-stable for removal',
    async (choice) => {
      const access = await eventAccess();
      await seedLegacyFavorites(access, 1);
      const before = await albumOf(access);

      const response = await write(access, '/start', { start: choice });

      expect(response.status).toBe(200);
      const result = (await response.json() as {
        data: { started: boolean; album: AlbumView };
      }).data;
      expect(result.started).toBe(true);
      expect(result.album).toMatchObject({ saved: true, revision: before.revision });

      const unguardedRetry = await write(access, '/start', { start: choice });
      expect(unguardedRetry.status).toBe(200);
      expect((await unguardedRetry.json() as {
        data: { started: boolean; album: AlbumView };
      }).data).toMatchObject({ started: false, album: { revision: before.revision } });
    },
  );
});

// Recently deleted, read from the album. A trashed pick keeps its place as an
// opaque marker: closing the arrangement up around a photograph that is still
// recoverable would quietly rewrite the album, and Restore would have nowhere
// to put the picture back.
describe('album retained slots', () => {
  /**
   * A delivered, picked photograph made the way a guest makes one. Trash moves
   * the event's own capacity counters, so these rows have to be real counted
   * uploads rather than the direct inserts the ordering tests seed.
   */
  async function pickedUpload(access: Access, hour: number, caption: string | null = null) {
    const media = await uploadPending(
      access,
      `retained-${crypto.randomUUID()}`,
      caption,
      'Avery Stone',
    );
    await env.DB.prepare('UPDATE media SET favorited_at = ?, timeline_at = ? WHERE id = ?')
      .bind(NOW, `2026-09-19T${String(hour).padStart(2, '0')}:00:00.000Z`, media.id)
      .run();
    return media.id;
  }

  function managerPreview(access: Access) {
    return createApp().request(`/api/manage/events/${access.event.id}/album/preview`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
  }

  /** Enable the Album link and follow it the way a recipient's browser does. */
  async function recipientAlbum(access: Access) {
    const enabled = await createApp().request(
      `/api/manage/events/${access.event.id}/album/share`,
      { method: 'POST', headers: writeHeaders(access.manager) },
      testEnv,
    );
    expect(enabled.status).toBe(200);
    const share = (await enabled.json() as { data: { share: { url: string } } }).data.share;
    const exchanged = await createApp().request('/api/album-share/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ token: new URL(share.url).hash.slice(1) }),
    }, testEnv);
    expect(exchanged.status).toBe(200);
    const token = /candidary_album=([^;,]+)/u.exec(exchanged.headers.get('set-cookie') ?? '')?.[1];
    if (!token) throw new Error('Expected the narrow album cookie from the exchange.');
    return createApp().request(
      '/api/album-share',
      { headers: { cookie: `candidary_album=${token}` } },
      testEnv,
    );
  }

  async function publicAlbumOf(response: Response): Promise<PublicAlbumView> {
    expect(response.status).toBe(200);
    return (await response.json() as { data: { album: PublicAlbumView } }).data.album;
  }

  function restore(access: Access, id: string) {
    return createApp().request(
      `/api/manage/events/${access.event.id}/media/${id}/restore`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
  }

  it.each([
    {
      edge: 'one below the cap',
      used: ALBUM_MAX_ENTRIES - 1,
      expectedStatus: 200,
    },
    {
      edge: 'at the exact cap',
      used: ALBUM_MAX_ENTRIES,
      expectedStatus: 409,
    },
    {
      edge: 'one above the cap',
      used: ALBUM_MAX_ENTRIES + 1,
      expectedStatus: 409,
    },
  ] as const)(
    'enforces album capacity $edge with sections and a retained slot while timely restore stays unconditional',
    async ({ used, expectedStatus }) => {
      const access = await eventAccess();
      const sectionCount = 2;
      const retainedCount = 1;
      await seedReconciliationFixture(access, {
        pickGeneration: 0,
        segments: [{ count: used - sectionCount - retainedCount, version: 1 }],
      });
      const retained = await pickedUpload(access, 20);
      const sections = Array.from({ length: sectionCount }, (_, index) => ({
        kind: 'section' as const,
        id: `capacity-section-${index}`,
        heading: `Capacity section ${index + 1}`,
      }));
      await env.DB.prepare(`
        INSERT INTO event_albums (
          event_id, entries, saved_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?)
      `).bind(access.event.id, JSON.stringify(sections), NOW, NOW, NOW).run();
      await trashMedia(access, retained);
      const candidate = await uploadPending(access, `capacity-candidate-${used}`, null);

      const picked = await write(access, '/picks', { mediaIds: [candidate.id], picked: true });

      expect(picked.status).toBe(expectedStatus);
      if (expectedStatus === 409) {
        expect((await picked.json() as { code: string }).code).toBe('ALBUM_FULL');
      }
      const album = await albumOf(access);
      expect(album).toMatchObject({ retainedCount: 1, sectionCount });
      expect(album.entries).toHaveLength(used + (expectedStatus === 200 ? 1 : 0));

      if (used === ALBUM_MAX_ENTRIES) {
        expect((await restore(access, retained)).status).toBe(200);
        const restored = await albumOf(access);
        expect(restored).toMatchObject({
          photoCount: ALBUM_MAX_ENTRIES - sectionCount,
          retainedCount: 0,
          sectionCount,
        });
        expect(restored.entries).toHaveLength(ALBUM_MAX_ENTRIES);
      }
    },
  );

  /**
   * A save that omits a retained slot is refused rather than accepted.
   *
   * An omitted *active* pick is an ordinary edit — the resolver re-appends it in
   * timeline order and nothing is lost. An omitted retained slot is not: the
   * photo is invisible, so the host cannot have meant to move it, and letting the
   * save through would silently relocate it to the tail and send a timely Restore
   * back to the wrong position. The likeliest source is a client deployed before
   * `photo-retained` existed, which cannot serialize the marker at all.
   */
  it('refuses a save that drops a retained slot, and keeps the slot where it was', async () => {
    const access = await eventAccess();
    const kept = await pickedUpload(access, 10, 'Kept caption');
    const retained = await pickedUpload(access, 11, 'Trashed caption');
    expect((await write(access, '', {
      revision: 0,
      entries: [{ kind: 'photo', mediaId: retained }, { kind: 'photo', mediaId: kept }],
      metadata: { title: 'The evening', description: '', coverMediaId: kept },
    }, 'PUT')).status).toBe(200);
    await trashMedia(access, retained);

    const before = await albumOf(access);
    expect(before.entries.map(entryId)).toEqual([retained, kept]);

    const dropped = await write(access, '', {
      revision: before.revision,
      entries: [{ kind: 'photo', mediaId: kept }],
      metadata: { title: 'The evening', description: '', coverMediaId: kept },
    }, 'PUT');

    expect(dropped.status).toBe(409);
    expect((await dropped.json() as { code: string }).code).toBe('MEDIA_STATE_CONFLICT');
    const after = await albumOf(access);
    expect(after.revision).toBe(before.revision);
    expect(after.entries.map(entryId)).toEqual([retained, kept]);
  });

  it('accepts an ordinary save that removes sections without moving or clearing a retained slot', async () => {
    const access = await eventAccess();
    const first = await pickedUpload(access, 10, 'First caption');
    const retained = await pickedUpload(access, 11, 'Trashed caption');
    const last = await pickedUpload(access, 12, 'Last caption');
    expect((await write(access, '', {
      revision: 0,
      entries: [
        { kind: 'photo', mediaId: last },
        { kind: 'section', id: 'reset-section', heading: 'Reception' },
        { kind: 'photo', mediaId: retained },
        { kind: 'photo', mediaId: first },
      ],
      metadata: { title: 'The evening', description: '', coverMediaId: last },
    }, 'PUT')).status).toBe(200);
    await trashMedia(access, retained);
    const before = await albumOf(access);

    const saved = await write(access, '', {
      revision: before.revision,
      entries: [
        { kind: 'photo', mediaId: first },
        { kind: 'photo', mediaId: retained },
        { kind: 'photo', mediaId: last },
      ],
      metadata: { title: 'The evening', description: '', coverMediaId: last },
    }, 'PUT');

    expect(saved.status).toBe(200);
    const album = await albumOf(access);
    expect(album).toMatchObject({ photoCount: 2, retainedCount: 1, sectionCount: 0 });
    expect(album.entries.map(entryId)).toEqual([first, retained, last]);
  });

  it('stands an opaque marker in for a trashed pick and shows it to neither public audience', async () => {
    const access = await eventAccess();
    const kept = await pickedUpload(access, 10, 'Kept caption');
    const retained = await pickedUpload(access, 11, 'Trashed caption');
    expect((await write(access, '', {
      revision: 0,
      entries: [{ kind: 'photo', mediaId: kept }, { kind: 'photo', mediaId: retained }],
      metadata: { title: 'The evening', description: '', coverMediaId: kept },
    }, 'PUT')).status).toBe(200);

    const trashed = await trashMedia(access, retained);

    const album = await albumOf(access);
    expect(album).toMatchObject({
      photoCount: 1,
      retainedCount: 1,
      sectionCount: 0,
      coverMediaId: kept,
      effectiveCoverMediaId: kept,
      coverRetained: null,
    });
    expect(album.entries.map(entryId)).toEqual([kept, retained]);
    // Exactly the marker contract — identity, recovery, and ordering facts. No
    // caption, guest, filename, preview flag, or pick provenance crosses this
    // Manager-only boundary.
    expect(album.entries[1]).toEqual({
      kind: 'photo-retained',
      slot: {
        mediaId: retained,
        restoreUntil: trashed.restoreUntil,
        state: 'recoverable',
        timelineAt: '2026-09-19T11:00:00.000Z',
      },
    });
    expect(JSON.stringify(album.entries[1]))
      .not.toMatch(
        /Trashed caption|Avery Stone|retained-|previewAvailable|publicationStatus|album_pick_version/u,
      );

    const preview = await publicAlbumOf(await managerPreview(access));
    const recipient = await publicAlbumOf(await recipientAlbum(access));
    for (const projection of [preview, recipient]) {
      expect(projection.entries).toEqual([
        { kind: 'photo', photo: { id: kept, caption: null, previewAvailable: true } },
      ]);
      expect(projection.photoCount).toBe(1);
      expect(JSON.stringify(projection)).not.toContain(retained);
    }
    expect(preview).toEqual(recipient);
  });

  it('removes sections whose only following slots are retained, including adjacent and trailing headings', async () => {
    const access = await eventAccess();
    const first = await pickedUpload(access, 10);
    const retained = await pickedUpload(access, 11);
    const last = await pickedUpload(access, 12);
    expect((await write(access, '', {
      revision: 0,
      entries: [
        { kind: 'photo', mediaId: first },
        { kind: 'section', id: 'only-retained', heading: 'Only retained' },
        { kind: 'photo', mediaId: retained },
        { kind: 'section', id: 'adjacent-empty', heading: 'Adjacent empty' },
        { kind: 'section', id: 'last-live', heading: 'Last live' },
        { kind: 'photo', mediaId: last },
        { kind: 'section', id: 'trailing', heading: 'Trailing' },
      ],
      metadata: { title: 'The evening', description: '', coverMediaId: first },
    }, 'PUT')).status).toBe(200);
    await trashMedia(access, retained);

    const preview = await publicAlbumOf(await managerPreview(access));
    const recipient = await publicAlbumOf(await recipientAlbum(access));
    const expected = [
      { kind: 'photo' as const, photo: { id: first, caption: null, previewAvailable: true } },
      { kind: 'section' as const, id: 'last-live', heading: 'Last live' },
      { kind: 'photo' as const, photo: { id: last, caption: null, previewAvailable: true } },
    ];
    expect(preview.entries).toEqual(expected);
    expect(recipient.entries).toEqual(expected);
    expect(preview).toEqual(recipient);
    expect(preview.photoCount).toBe(2);
  });

  it('restores a trashed pick into the slot a reorder saved it into', async () => {
    const access = await eventAccess();
    const first = await pickedUpload(access, 10);
    const retained = await pickedUpload(access, 11);
    const last = await pickedUpload(access, 12);
    expect((await write(access, '', {
      revision: 0,
      entries: [
        { kind: 'photo', mediaId: first },
        { kind: 'photo', mediaId: retained },
        { kind: 'photo', mediaId: last },
      ],
    }, 'PUT')).status).toBe(200);

    await trashMedia(access, retained);

    // The host keeps arranging around the marker. That save has to round-trip
    // it unchanged, or a Restore afterwards would land somewhere else.
    const reordered = await write(access, '', {
      revision: (await albumOf(access)).revision,
      entries: [
        { kind: 'photo', mediaId: last },
        { kind: 'photo', mediaId: retained },
        { kind: 'photo', mediaId: first },
      ],
    }, 'PUT');
    expect(reordered.status).toBe(200);
    const arranged = await albumOf(access);
    expect(arranged.entries.map((entry) => entry.kind))
      .toEqual(['photo', 'photo-retained', 'photo']);
    expect(arranged.entries.map(entryId)).toEqual([last, retained, first]);

    expect((await restore(access, retained)).status).toBe(200);

    const album = await albumOf(access);
    expect(album.entries.map((entry) => entry.kind)).toEqual(['photo', 'photo', 'photo']);
    expect(album.entries.map(entryId)).toEqual([last, retained, first]);
    expect(album).toMatchObject({ photoCount: 3, retainedCount: 0, coverRetained: null });
  });

  it('converges repeated trash, replacement cover, and restore without duplicating the retained slot', async () => {
    const access = await eventAccess();
    const fallback = await pickedUpload(access, 10);
    const cover = await pickedUpload(access, 11);
    expect((await write(access, '', {
      revision: 0,
      entries: [{ kind: 'photo', mediaId: fallback }, { kind: 'photo', mediaId: cover }],
      metadata: { title: 'The evening', description: '', coverMediaId: cover },
    }, 'PUT')).status).toBe(200);

    const trashed = await trashMedia(access, cover);

    const retainedCover = await albumOf(access);
    expect(retainedCover).toMatchObject({
      // The chosen cover is still the chosen cover — a timely Restore puts that
      // photograph back at the top — but the album has to show a picture in the
      // meantime, so the effective cover falls to the first visible photo.
      coverMediaId: cover,
      effectiveCoverMediaId: fallback,
      coverRetained: { mediaId: cover, restoreUntil: trashed.restoreUntil, state: 'recoverable' },
      photoCount: 1,
      retainedCount: 1,
    });
    expect(await publicAlbumOf(await managerPreview(access)))
      .toMatchObject({ coverMediaId: fallback });

    const rechosen = await write(access, '', {
      revision: retainedCover.revision,
      entries: [{ kind: 'photo', mediaId: fallback }, { kind: 'photo', mediaId: cover }],
      metadata: { title: 'The evening', description: '', coverMediaId: fallback },
    }, 'PUT');
    expect(rechosen.status).toBe(200);
    // Choosing another cover is the one edit that intentionally gives up the
    // retained reference; the slot itself survives for Restore.
    expect(await albumOf(access)).toMatchObject({
      coverMediaId: fallback,
      effectiveCoverMediaId: fallback,
      coverRetained: null,
      photoCount: 1,
      retainedCount: 1,
    });

    expect((await restore(access, cover)).status).toBe(200);
    expect(await albumOf(access)).toMatchObject({
      coverMediaId: fallback,
      effectiveCoverMediaId: fallback,
      coverRetained: null,
      photoCount: 2,
      retainedCount: 0,
    });

    await trashMedia(access, cover);
    const repeatedTrash = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${cover}/trash`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(repeatedTrash.status).toBe(409);
    expect((await repeatedTrash.json() as { code: string }).code).toBe('MEDIA_STATE_CONFLICT');
    expect((await restore(access, cover)).status).toBe(200);
    const repeatedRestore = await restore(access, cover);
    expect(repeatedRestore.status).toBe(409);
    expect((await repeatedRestore.json() as { code: string }).code).toBe('MEDIA_STATE_CONFLICT');

    const converged = await albumOf(access);
    expect(converged.entries.map(entryId)).toEqual([fallback, cover]);
    expect(new Set(converged.entries.map(entryId)).size).toBe(2);
    expect(converged).toMatchObject({
      coverMediaId: fallback,
      effectiveCoverMediaId: fallback,
      coverRetained: null,
      photoCount: 2,
      retainedCount: 0,
    });
  });
});

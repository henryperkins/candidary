import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_EVENT_BYTES, MAX_EVENT_MEDIA } from '../../shared/constants';
import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-08-23T00:00:00.000Z';
const TRASHED_AT = '2026-08-23T12:00:00.000Z';
/** `TRASHED_AT` plus the 30-day recovery window, inside both event deadlines. */
const RESTORE_UNTIL = '2026-09-22T12:00:00.000Z';
const MANAGEMENT_EXPIRES_AT = '2026-10-01T00:00:00.000Z';
const PURGE_AFTER = '2026-11-01T00:00:00.000Z';

// The triggers speak for themselves; matching their exact text keeps a test
// from passing on some *other* constraint that happened to fire first.
const MARKERS_INVALID = /media recovery markers are invalid/u;
const CAPACITY_EXCEEDED = /event media capacity exceeded/u;
const RECOVERABLE_OWNER = /a recoverable photo owns this object/u;
const ACTIVE_HOLD = /an active export holds this source object/u;
const SOURCE_SUPPRESSED = /export source object is permanently suppressed/u;
const MUST_FREEZE_SOURCES = /a queued export must freeze its sources/u;
const HOLD_NOT_INTACT = /export source hold is not intact/u;
const HOLD_NOT_REACQUIRABLE = /export source hold cannot be reacquired/u;
const TARGET_SUPPRESSED = /media object write target is permanently suppressed/u;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedEvent(
  id = 'event-a',
  deadlines: { managementAccessExpiresAt?: string; purgeAfter?: string } = {},
) {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(
    id,
    id,
    NOW,
    deadlines.managementAccessExpiresAt ?? MANAGEMENT_EXPIRES_AT,
    deadlines.purgeAfter ?? PURGE_AFTER,
    NOW,
  ).run();
}

/** An event plus the one guest session every media row has to be owned by. */
async function seedEventWithSession(
  id = 'event-a',
  deadlines: { managementAccessExpiresAt?: string; purgeAfter?: string } = {},
) {
  await seedEvent(id, deadlines);
  await env.DB.prepare(`
    INSERT INTO event_access_tokens (
      id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
    ) VALUES (?, ?, 'guest', ?, 'ciphertext', ?, ?)
  `).bind(`token-${id}`, id, `token-digest-${id}`, NOW, NOW).run();
  await env.DB.prepare(`
    INSERT INTO event_sessions (
      id, secret_digest, event_id, access_token_id, role, csrf_digest, expires_at, created_at
    ) VALUES (?, ?, ?, ?, 'guest', 'csrf', ?, ?)
  `).bind(`session-${id}`, `session-digest-${id}`, id, `token-${id}`, NOW, NOW).run();
}

const canonicalKey = (eventId: string, mediaId: string) => `events/${eventId}/media/final/${mediaId}`;
const uploadKey = (eventId: string, mediaId: string) => `events/${eventId}/uploads/${mediaId}`;
const previewKey = (eventId: string, mediaId: string) => `events/${eventId}/previews/${mediaId}.webp`;

interface MediaFixture {
  id: string;
  eventId?: string;
  generation?: 'legacy' | 'canonical';
  objectKey?: string;
  previewObjectKey?: string | null;
  uploadState?: 'reserved' | 'stored' | 'failed' | 'deleted';
  byteSize?: number | null;
  deletedAt?: string | null;
  trashedAt?: string | null;
  restoreUntil?: string | null;
}

function insertMedia(fixture: MediaFixture) {
  const eventId = fixture.eventId ?? 'event-a';
  const generation = fixture.generation ?? 'canonical';
  const uploadState = fixture.uploadState ?? 'stored';
  const defaultKey = generation === 'canonical'
    ? canonicalKey(eventId, fixture.id)
    : uploadKey(eventId, fixture.id);
  return env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      preview_object_key, original_filename, mime_type, declared_byte_size, byte_size,
      width, height, guest_name, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, timeline_at,
      deleted_at, trashed_at, restore_until
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, 'image/jpeg', 12, ?, 4, 3, 'Avery Stone', ?, 'unpublished', ?,
      ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    fixture.id,
    eventId,
    `session-${eventId}`,
    fixture.objectKey ?? defaultKey,
    generation,
    fixture.previewObjectKey ?? null,
    `${fixture.id}.jpg`,
    fixture.byteSize === undefined ? 12 : fixture.byteSize,
    uploadState,
    `idem-${fixture.id}`,
    NOW,
    NOW,
    uploadState === 'stored' ? NOW : null,
    NOW,
    fixture.deletedAt ?? null,
    fixture.trashedAt ?? null,
    fixture.restoreUntil ?? null,
  ).run();
}

/** The same row an 0018 Worker writes, before the recovery columns exist. */
function insert0018Media(fixture: { id: string; uploadState?: 'reserved' | 'stored' }) {
  const uploadState = fixture.uploadState ?? 'stored';
  return env.DB.prepare(`
    INSERT INTO media (
      id, event_id, uploader_session_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, width, height,
      guest_name, upload_state, publication_status, idempotency_key,
      reservation_expires_at, created_at, stored_at, timeline_at
    ) VALUES (
      ?, 'event-a', 'session-event-a', ?, 'canonical', ?, 'image/jpeg', 12, ?, 4, 3,
      'Avery Stone', ?, 'unpublished', ?, ?, ?, ?, ?
    )
  `).bind(
    fixture.id,
    canonicalKey('event-a', fixture.id),
    `${fixture.id}.jpg`,
    uploadState === 'stored' ? 12 : null,
    uploadState,
    `idem-${fixture.id}`,
    NOW,
    NOW,
    uploadState === 'stored' ? NOW : null,
    NOW,
  ).run();
}

/** The exact three-marker write `MediaRepository.trashStored()` performs. */
function trashMediaRow(id: string, trashedAt = TRASHED_AT, restoreUntil = RESTORE_UNTIL) {
  return env.DB.prepare(`
    UPDATE media SET trashed_at = ?, deleted_at = ?, restore_until = ? WHERE id = ?
  `).bind(trashedAt, trashedAt, restoreUntil, id).run();
}

/** The exact three-marker clear `MediaRepository.restoreTrashed()` performs. */
function restoreMediaRow(id: string) {
  return env.DB.prepare(`
    UPDATE media SET trashed_at = NULL, deleted_at = NULL, restore_until = NULL WHERE id = ?
  `).bind(id).run();
}

function insertTombstone(fixture: {
  generation?: 'legacy' | 'canonical';
  objectKey: string;
  eventId?: string;
  mediaId: string;
  kind: 'source' | 'final' | 'preview' | 'export' | 'cover';
  suppressionStartedAt?: string | null;
}) {
  return env.DB.prepare(`
    INSERT INTO media_object_write_tombstones (
      bucket_generation, object_key, event_id, media_id, object_kind,
      suppression_started_at, next_check_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fixture.generation ?? 'legacy',
    fixture.objectKey,
    fixture.eventId ?? 'event-a',
    fixture.mediaId,
    fixture.kind,
    fixture.suppressionStartedAt ?? null,
    NOW,
    NOW,
    NOW,
  ).run();
}

function suppressTombstone(generation: 'legacy' | 'canonical', objectKey: string) {
  return env.DB.prepare(`
    UPDATE media_object_write_tombstones
    SET suppression_started_at = ?, updated_at = ?
    WHERE bucket_generation = ? AND object_key = ? AND suppression_started_at IS NULL
  `).bind(NOW, NOW, generation, objectKey).run();
}

interface ExportJobFixture {
  id: string;
  eventId: string;
  state?: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  kind?: 'complete' | 'album';
  mediaCount?: number;
  totalBytes?: number;
  guestbookEntryCount?: number | null;
}

function insertExportJob(fixture: ExportJobFixture) {
  const kind = fixture.kind ?? 'complete';
  return env.DB.prepare(`
    INSERT INTO export_jobs (
      id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
      kind, album_entries_json, guestbook_entry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fixture.id,
    fixture.eventId,
    fixture.state ?? 'queued',
    NOW,
    fixture.mediaCount ?? 1,
    fixture.totalBytes ?? 12,
    NOW,
    kind,
    kind === 'album' ? '[{"kind":"photo"}]' : null,
    // An album job is entry-backed by construction and carries no Guestbook
    // columns, which is exactly why the entryless rule names `kind`.
    fixture.guestbookEntryCount === undefined ? (kind === 'album' ? null : 0) : fixture.guestbookEntryCount,
  ).run();
}

function insertExportEntry(fixture: {
  jobId: string;
  mediaId: string;
  eventId?: string;
  objectKey?: string;
  generation?: 'legacy' | 'canonical';
  declaredByteSize?: number;
  byteSize?: number | null;
}) {
  const eventId = fixture.eventId ?? 'event-a';
  return env.DB.prepare(`
    INSERT INTO export_media_entries (
      export_job_id, media_id, object_key, object_bucket_generation,
      original_filename, mime_type, declared_byte_size, byte_size, width, height,
      guest_name, caption, publication_status, created_at, published_at, album_tail_position
    ) VALUES (
      ?, ?, ?, ?, ?, 'image/jpeg', ?, ?, 4, 3, 'Avery Stone', NULL, 'unpublished', ?, NULL, NULL
    )
  `).bind(
    fixture.jobId,
    fixture.mediaId,
    fixture.objectKey ?? canonicalKey(eventId, fixture.mediaId),
    fixture.generation ?? 'canonical',
    `${fixture.mediaId}.jpg`,
    fixture.declaredByteSize ?? 12,
    fixture.byteSize === undefined ? 12 : fixture.byteSize,
    NOW,
  ).run();
}

function setExportState(id: string, state: string) {
  return env.DB.prepare(`UPDATE export_jobs SET state = ? WHERE id = ?`).bind(state, id).run();
}

// ---------------------------------------------------------------------------

describe('migration 0019 over a populated 0018 database', () => {
  beforeEach(reset);

  it('refuses with no changes at all while an export Workflow is still running', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0019'));
    await seedEvent();
    await insertExportJob({ id: 'export-running', eventId: 'event-a', state: 'running' });

    await expect(applyD1Migrations(env.DB, [migrationOnly('0019')])).rejects.toThrow();

    const columns = await env.DB.prepare('PRAGMA table_info(media)').all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).not.toContain('trashed_at');
    expect(await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE name IN (
        '_media_recovery_0019_gate', 'media_trash_pair_insert', 'media_recovery_expiry'
      )
    `).first()).toBeNull();
    expect(await env.DB.prepare(`
      SELECT name FROM d1_migrations WHERE name = '0019_media_recovery.sql'
    `).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT state FROM export_jobs WHERE id = 'export-running'`).first())
      .toEqual({ state: 'running' });
  });

  it('applies once that Workflow has become terminal and the deployment reruns it', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0019'));
    await seedEvent();
    await insertExportJob({ id: 'export-running', eventId: 'event-a', state: 'running' });
    await expect(applyD1Migrations(env.DB, [migrationOnly('0019')])).rejects.toThrow();

    await setExportState('export-running', 'ready');
    await applyD1Migrations(env.DB, [migrationOnly('0019')]);

    expect(await env.DB.prepare(`
      SELECT name FROM d1_migrations WHERE name = '0019_media_recovery.sql'
    `).first()).toEqual({ name: '0019_media_recovery.sql' });
    expect(await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE name = '_media_recovery_0019_gate'
    `).first()).toBeNull();
  });

  it('leaves every existing photo active, at zero recoverable usage, and recoverable', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0019'));
    await seedEventWithSession();
    await insert0018Media({ id: 'media-stored' });
    await insert0018Media({ id: 'media-reserved', uploadState: 'reserved' });

    await applyD1Migrations(env.DB, [migrationOnly('0019')]);

    expect((await env.DB.prepare(`
      SELECT id, trashed_at, restore_until FROM media ORDER BY id
    `).all()).results).toEqual([
      { id: 'media-reserved', trashed_at: null, restore_until: null },
      { id: 'media-stored', trashed_at: null, restore_until: null },
    ]);
    expect(await env.DB.prepare(`
      SELECT recoverable_media_count, recoverable_bytes FROM events WHERE id = 'event-a'
    `).first()).toEqual({ recoverable_media_count: 0, recoverable_bytes: 0 });
    await expect(env.DB.prepare(`
      UPDATE events SET recoverable_media_count = -1 WHERE id = 'event-a'
    `).run()).rejects.toThrow();

    // A photo that predates the migration is a first-class recoverable one.
    await expect(trashMediaRow('media-stored')).resolves.toBeDefined();
    await expect(restoreMediaRow('media-stored')).resolves.toBeDefined();
  });

  it('installs the recovery, Recently deleted, and export source-hold indexes', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);

    const indexes = await env.DB.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'media_recovery_expiry', 'media_recently_deleted_page', 'export_media_entries_source_hold'
      ) ORDER BY name
    `).all<{ name: string; sql: string }>();

    expect(indexes.results.map(({ name }) => name)).toEqual([
      'export_media_entries_source_hold',
      'media_recently_deleted_page',
      'media_recovery_expiry',
    ]);
    expect(indexes.results[0]?.sql).toContain(
      'export_media_entries(media_id, object_bucket_generation, object_key, export_job_id)',
    );
    expect(indexes.results[1]?.sql).toContain('media(event_id, trashed_at DESC, id DESC)');
    expect(indexes.results[1]?.sql).toContain('WHERE trashed_at IS NOT NULL');
    expect(indexes.results[2]?.sql).toContain('media(restore_until, id)');
    expect(indexes.results[2]?.sql).toContain('WHERE trashed_at IS NOT NULL');
  });

  it('fails exactly the queued jobs whose frozen sources cannot be proven', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0019'));
    for (const suffix of [
      'entryless', 'count', 'bytes', 'suppressed', 'missing-tombstone', 'ok', 'album', 'ready',
    ]) {
      await seedEvent(`event-${suffix}`);
    }

    // A pre-0015 complete job: its pinned Workflow reads a live media query, so
    // no amount of backfilled rows could make its future source set safe.
    await insertExportJob({
      id: 'job-entryless', eventId: 'event-entryless', mediaCount: 0, totalBytes: 0,
      guestbookEntryCount: null,
    });
    // Frozen cardinality disagrees with the job.
    await insertExportJob({ id: 'job-count', eventId: 'event-count', mediaCount: 2, totalBytes: 12 });
    await insertExportEntry({ jobId: 'job-count', mediaId: 'media-count', eventId: 'event-count' });
    // Frozen byte sum disagrees with the job.
    await insertExportJob({ id: 'job-bytes', eventId: 'event-bytes', mediaCount: 1, totalBytes: 99 });
    await insertExportEntry({ jobId: 'job-bytes', mediaId: 'media-bytes', eventId: 'event-bytes' });
    // A frozen source that an 0018 deletion path already started suppressing.
    await insertExportJob({ id: 'job-suppressed', eventId: 'event-suppressed' });
    await insertExportEntry({
      jobId: 'job-suppressed', mediaId: 'media-suppressed', eventId: 'event-suppressed',
    });
    await insertTombstone({
      generation: 'canonical',
      objectKey: canonicalKey('event-suppressed', 'media-suppressed'),
      eventId: 'event-suppressed',
      mediaId: 'media-suppressed',
      kind: 'final',
      suppressionStartedAt: NOW,
    });
    // Count and bytes alone are not proof that the object is retained: 0019
    // requires the exact inventory row that every retirement path must fence.
    await insertExportJob({ id: 'job-missing-tombstone', eventId: 'event-missing-tombstone' });
    await insertExportEntry({
      jobId: 'job-missing-tombstone', mediaId: 'media-missing-tombstone',
      eventId: 'event-missing-tombstone',
    });
    // Consistent, and its byte sum falls back to the declared size.
    await insertExportJob({ id: 'job-ok', eventId: 'event-ok' });
    await insertExportEntry({
      jobId: 'job-ok', mediaId: 'media-ok', eventId: 'event-ok', byteSize: null,
    });
    await insertTombstone({
      generation: 'canonical', objectKey: canonicalKey('event-ok', 'media-ok'),
      eventId: 'event-ok', mediaId: 'media-ok', kind: 'final',
    });
    await insertExportJob({ id: 'job-album', eventId: 'event-album', kind: 'album' });
    await insertExportEntry({ jobId: 'job-album', mediaId: 'media-album', eventId: 'event-album' });
    await insertTombstone({
      generation: 'canonical', objectKey: canonicalKey('event-album', 'media-album'),
      eventId: 'event-album', mediaId: 'media-album', kind: 'final',
    });
    // Terminal jobs are never revalidated, entryless or not.
    await insertExportJob({
      id: 'job-ready', eventId: 'event-ready', state: 'ready', mediaCount: 0, totalBytes: 0,
      guestbookEntryCount: null,
    });

    await applyD1Migrations(env.DB, [migrationOnly('0019')]);

    expect((await env.DB.prepare(`
      SELECT id, state, error_code FROM export_jobs ORDER BY id
    `).all()).results).toEqual([
      { id: 'job-album', state: 'queued', error_code: null },
      { id: 'job-bytes', state: 'failed', error_code: 'EXPORT_SOURCE_REMOVED' },
      { id: 'job-count', state: 'failed', error_code: 'EXPORT_SOURCE_REMOVED' },
      { id: 'job-entryless', state: 'failed', error_code: 'EXPORT_SOURCE_REMOVED' },
      { id: 'job-missing-tombstone', state: 'failed', error_code: 'EXPORT_SOURCE_REMOVED' },
      { id: 'job-ok', state: 'queued', error_code: null },
      { id: 'job-ready', state: 'ready', error_code: null },
      { id: 'job-suppressed', state: 'failed', error_code: 'EXPORT_SOURCE_REMOVED' },
    ]);
  });
});

describe('migration 0019 recovery invariants', () => {
  beforeEach(reset);

  it('accepts both trash markers or neither, and nothing in between', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-a' });

    await expect(env.DB.prepare(`
      UPDATE media SET trashed_at = ?, deleted_at = ? WHERE id = 'media-a'
    `).bind(TRASHED_AT, TRASHED_AT).run()).rejects.toThrow(MARKERS_INVALID);
    await expect(env.DB.prepare(`
      UPDATE media SET restore_until = ? WHERE id = 'media-a'
    `).bind(RESTORE_UNTIL).run()).rejects.toThrow(MARKERS_INVALID);
    await expect(insertMedia({ id: 'media-half', trashedAt: TRASHED_AT, deletedAt: TRASHED_AT }))
      .rejects.toThrow(MARKERS_INVALID);

    await expect(trashMediaRow('media-a')).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      UPDATE media SET restore_until = NULL WHERE id = 'media-a'
    `).run()).rejects.toThrow(MARKERS_INVALID);
    await expect(restoreMediaRow('media-a')).resolves.toBeDefined();
  });

  it('lets only a stored row carry the pair, and only with deleted_at equal to it', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-reserved', uploadState: 'reserved', byteSize: null });

    for (const uploadState of ['reserved', 'failed', 'deleted'] as const) {
      await expect(insertMedia({
        id: `media-${uploadState}`,
        uploadState,
        deletedAt: TRASHED_AT,
        trashedAt: TRASHED_AT,
        restoreUntil: RESTORE_UNTIL,
      })).rejects.toThrow(MARKERS_INVALID);
    }
    await expect(env.DB.prepare(`
      UPDATE media SET trashed_at = ?, deleted_at = ?, restore_until = ? WHERE id = 'media-reserved'
    `).bind(TRASHED_AT, TRASHED_AT, RESTORE_UNTIL).run()).rejects.toThrow(MARKERS_INVALID);

    // `deleted_at` is the 0018 compatibility marker, so it must be that exact
    // instant: a different one, or none, is a shape no Worker can interpret.
    await insertMedia({ id: 'media-a' });
    await expect(env.DB.prepare(`
      UPDATE media SET trashed_at = ?, deleted_at = ?, restore_until = ? WHERE id = 'media-a'
    `).bind(TRASHED_AT, NOW, RESTORE_UNTIL).run()).rejects.toThrow(MARKERS_INVALID);
    await expect(env.DB.prepare(`
      UPDATE media SET trashed_at = ?, restore_until = ? WHERE id = 'media-a'
    `).bind(TRASHED_AT, RESTORE_UNTIL).run()).rejects.toThrow(MARKERS_INVALID);
  });

  it('requires a restore deadline strictly after the moment the photo was trashed', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-a' });

    await expect(trashMediaRow('media-a', TRASHED_AT, TRASHED_AT)).rejects.toThrow(MARKERS_INVALID);
    await expect(trashMediaRow('media-a', TRASHED_AT, NOW)).rejects.toThrow(MARKERS_INVALID);
    await expect(trashMediaRow('media-a', TRASHED_AT, '2026-08-23T12:00:00.001Z'))
      .resolves.toBeDefined();
  });

  it('clamps the restore deadline to Manager access and to event purge alike', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    // Purge is deliberately the earlier of the two here, so the clamp cannot be
    // passing on the Manager deadline alone.
    await seedEventWithSession('event-early-purge', { purgeAfter: '2026-09-01T00:00:00.000Z' });
    await insertMedia({ id: 'media-a' });
    await insertMedia({ id: 'media-early', eventId: 'event-early-purge' });

    await expect(trashMediaRow('media-a', TRASHED_AT, '2026-10-01T00:00:00.001Z'))
      .rejects.toThrow(MARKERS_INVALID);
    await expect(trashMediaRow('media-early', TRASHED_AT, '2026-09-15T00:00:00.000Z'))
      .rejects.toThrow(MARKERS_INVALID);

    // Trash close to a deadline still works; the deadline itself is allowed.
    await expect(trashMediaRow('media-a', TRASHED_AT, MANAGEMENT_EXPIRES_AT)).resolves.toBeDefined();
    await expect(trashMediaRow('media-early', TRASHED_AT, '2026-09-01T00:00:00.000Z'))
      .resolves.toBeDefined();
  });

  it('refuses to leave an active stored row wearing the 0018 exclusion marker', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0019'));
    await seedEventWithSession();

    // This genuinely predates 0019. The migration may preserve history, but a
    // post-0019 INSERT must never manufacture the same invalid shape.
    await insert0018Media({ id: 'media-old' });
    await env.DB.prepare(`
      UPDATE media SET deleted_at = ? WHERE id = 'media-old'
    `).bind(NOW).run();
    await applyD1Migrations(env.DB, [migrationOnly('0019')]);

    await expect(insertMedia({ id: 'media-new', deletedAt: NOW }))
      .rejects.toThrow(MARKERS_INVALID);

    await insertMedia({ id: 'media-a' });

    await expect(env.DB.prepare(`
      UPDATE media SET deleted_at = ? WHERE id = 'media-a'
    `).bind(TRASHED_AT).run()).rejects.toThrow(MARKERS_INVALID);

    // Grandfathered on OLD: the row that really crossed the migration boundary
    // stays writable, because 0019 cannot go back and fix history.
    await expect(env.DB.prepare(`
      UPDATE media SET deleted_at = ? WHERE id = 'media-old'
    `).bind(TRASHED_AT).run()).resolves.toBeDefined();
  });

  it('counts reserved, stored, and recoverable against one event ceiling', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEvent();

    const insertEventAtCapacity = (
      id: string,
      counters: { reservedCount: number; storedCount: number; recoverableCount: number;
        reservedBytes: number; storedBytes: number; recoverableBytes: number },
    ) => env.DB.prepare(`
      INSERT INTO events (
        id, slug, name, event_date, welcome_message,
        guest_access_expires_at, management_access_expires_at, purge_after, created_at,
        reserved_media_count, stored_media_count, recoverable_media_count,
        reserved_bytes, stored_bytes, recoverable_bytes
      ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, id, NOW, MANAGEMENT_EXPIRES_AT, PURGE_AFTER, NOW,
      counters.reservedCount, counters.storedCount, counters.recoverableCount,
      counters.reservedBytes, counters.storedBytes, counters.recoverableBytes,
    ).run();

    await expect(insertEventAtCapacity('event-count-overflow', {
      reservedCount: MAX_EVENT_MEDIA, storedCount: 1, recoverableCount: 0,
      reservedBytes: 0, storedBytes: 0, recoverableBytes: 0,
    })).rejects.toThrow(CAPACITY_EXCEEDED);
    await expect(insertEventAtCapacity('event-bytes-overflow', {
      reservedCount: 0, storedCount: 0, recoverableCount: 0,
      reservedBytes: MAX_EVENT_BYTES, storedBytes: 1, recoverableBytes: 0,
    })).rejects.toThrow(CAPACITY_EXCEEDED);

    await expect(env.DB.prepare(`
      UPDATE events SET reserved_media_count = 1, stored_media_count = ?, recoverable_media_count = 1
      WHERE id = 'event-a'
    `).bind(MAX_EVENT_MEDIA - 2).run()).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      UPDATE events SET recoverable_media_count = 2 WHERE id = 'event-a'
    `).run()).rejects.toThrow(CAPACITY_EXCEEDED);
    // An 0018 Worker writes only its own two columns and has never heard of
    // `recoverable_*`; enforcing the sum here is what keeps its reservation
    // arithmetic inside the same ceiling.
    await expect(env.DB.prepare(`
      UPDATE events SET reserved_media_count = 2 WHERE id = 'event-a'
    `).run()).rejects.toThrow(CAPACITY_EXCEEDED);

    await expect(env.DB.prepare(`
      UPDATE events SET reserved_bytes = 1, stored_bytes = ?, recoverable_bytes = 1
      WHERE id = 'event-a'
    `).bind(MAX_EVENT_BYTES - 2).run()).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      UPDATE events SET recoverable_bytes = 2 WHERE id = 'event-a'
    `).run()).rejects.toThrow(CAPACITY_EXCEEDED);
    await expect(env.DB.prepare(`
      UPDATE events SET stored_bytes = ? WHERE id = 'event-a'
    `).bind(MAX_EVENT_BYTES - 1).run()).rejects.toThrow(CAPACITY_EXCEEDED);

    expect(await env.DB.prepare(`
      SELECT reserved_media_count, stored_media_count, recoverable_media_count,
             reserved_bytes, stored_bytes, recoverable_bytes
      FROM events WHERE id = 'event-a'
    `).first()).toEqual({
      reserved_media_count: 1,
      stored_media_count: MAX_EVENT_MEDIA - 2,
      recoverable_media_count: 1,
      reserved_bytes: 1,
      stored_bytes: MAX_EVENT_BYTES - 2,
      recoverable_bytes: 1,
    });
  });

  it('makes a recoverable photo the owner of the pointers it still uses', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-a' });
    // The retired upload alias a completed promotion left behind.
    await insertTombstone({
      objectKey: uploadKey('event-a', 'media-a'), mediaId: 'media-a', kind: 'source',
    });
    await trashMediaRow('media-a');

    // The current pointer is the photograph. It may not be scheduled for deletion.
    await expect(suppressTombstone('canonical', canonicalKey('event-a', 'media-a')))
      .rejects.toThrow(RECOVERABLE_OWNER);

    // A key this row no longer points at is a different matter: the promotion
    // that moved the pointer still has to be able to settle its inventory, and a
    // retired alias is not something Restore needs back. Blocking it here is how
    // the promotion fence — and the event purge that waits on it — used to stall
    // for as long as a photo sat in Recently deleted.
    await expect(suppressTombstone('legacy', uploadKey('event-a', 'media-a')))
      .resolves.toBeDefined();
    await expect(suppressTombstone('legacy', previewKey('event-a', 'media-a')))
      .resolves.toBeDefined();

    // Export and cover objects are a different lifecycle and stay out of it.
    await expect(insertTombstone({
      objectKey: 'events/event-a/exports/attempt-1.zip',
      mediaId: 'media-a',
      kind: 'export',
      suppressionStartedAt: NOW,
    })).resolves.toBeDefined();
  });

  it('protects the recorded preview alias of a recoverable legacy row', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    // A grandfathered still-legacy row, which is the only shape that records a
    // `preview_object_key` — a canonical row's is always NULL.
    await env.DB.exec('DROP TRIGGER IF EXISTS media_stored_legacy_guard_insert;');
    await insertMedia({
      id: 'media-legacy',
      objectKey: uploadKey('event-a', 'media-legacy'),
      generation: 'legacy',
      previewObjectKey: 'events/event-a/previews/media-legacy-cached.webp',
    });
    // The 0015 inventory trigger already recorded every alias this row named.
    await trashMediaRow('media-legacy');

    await expect(suppressTombstone('legacy', uploadKey('event-a', 'media-legacy')))
      .rejects.toThrow(RECOVERABLE_OWNER);
    await expect(suppressTombstone('legacy', 'events/event-a/previews/media-legacy-cached.webp'))
      .rejects.toThrow(RECOVERABLE_OWNER);

    // Restore is what releases them again.
    await restoreMediaRow('media-legacy');
    await expect(suppressTombstone('legacy', 'events/event-a/previews/media-legacy-cached.webp'))
      .resolves.toBeDefined();
  });

  it('restores a promoted photo whose retired legacy alias is already suppressed', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-promoted' });
    await insertTombstone({
      objectKey: uploadKey('event-a', 'media-promoted'),
      mediaId: 'media-promoted',
      kind: 'source',
      suppressionStartedAt: NOW,
    });
    await trashMediaRow('media-promoted');

    // The exception is scoped to a restore that changes nothing else: a write
    // that also repoints the row is an ordinary revival and the retired alias
    // vetoes it again.
    await expect(env.DB.prepare(`
      UPDATE media SET trashed_at = NULL, deleted_at = NULL, restore_until = NULL, object_key = ?
      WHERE id = 'media-promoted'
    `).bind('events/event-a/media/final/media-promoted-v2').run())
      .rejects.toThrow(TARGET_SUPPRESSED);

    await expect(restoreMediaRow('media-promoted')).resolves.toBeDefined();

    expect(await env.DB.prepare(`
      SELECT upload_state, deleted_at, trashed_at, restore_until, object_key
      FROM media WHERE id = 'media-promoted'
    `).first()).toEqual({
      upload_state: 'stored',
      deleted_at: null,
      trashed_at: null,
      restore_until: null,
      object_key: canonicalKey('event-a', 'media-promoted'),
    });
  });

  it('still refuses an ordinary revival that the same retired alias would veto', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-gone', uploadState: 'deleted', deletedAt: NOW });
    // Exactly the alias that must not veto a Restore — and must still veto this.
    await insertTombstone({
      objectKey: uploadKey('event-a', 'media-gone'),
      mediaId: 'media-gone',
      kind: 'source',
      suppressionStartedAt: NOW,
    });

    await expect(env.DB.prepare(`
      UPDATE media SET upload_state = 'stored', deleted_at = NULL WHERE id = 'media-gone'
    `).run()).rejects.toThrow(TARGET_SUPPRESSED);
    expect(await env.DB.prepare(`
      SELECT upload_state, deleted_at FROM media WHERE id = 'media-gone'
    `).first()).toEqual({ upload_state: 'deleted', deleted_at: NOW });
  });

  it('refuses a restore whose own current pointer has entered suppression', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-a' });
    // Suppression has to win the race before the trash pair exists; afterwards
    // the recoverable-owner guard would have refused it.
    await suppressTombstone('canonical', canonicalKey('event-a', 'media-a'));
    await trashMediaRow('media-a');

    await expect(restoreMediaRow('media-a')).rejects.toThrow(TARGET_SUPPRESSED);
    expect(await env.DB.prepare(`
      SELECT trashed_at, restore_until FROM media WHERE id = 'media-a'
    `).first()).toEqual({ trashed_at: TRASHED_AT, restore_until: RESTORE_UNTIL });
  });

  it('returns a grandfathered still-legacy photo from Recently deleted', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    // 0015 fences creating a legacy stored row, so the only way one exists is
    // that it predates the fence — which is exactly the row Restore must serve.
    await insertMedia({
      id: 'media-legacy',
      generation: 'legacy',
      previewObjectKey: 'events/event-a/previews/media-legacy-v1.webp',
      deletedAt: TRASHED_AT,
      trashedAt: TRASHED_AT,
      restoreUntil: RESTORE_UNTIL,
    });

    await expect(restoreMediaRow('media-legacy')).resolves.toBeDefined();
    expect(await env.DB.prepare(`
      SELECT upload_state, object_bucket_generation, trashed_at FROM media WHERE id = 'media-legacy'
    `).first()).toEqual({
      upload_state: 'stored', object_bucket_generation: 'legacy', trashed_at: null,
    });

    // Its recorded preview is a pointer it still uses, so suppressing that one
    // does stop the next Restore.
    await suppressTombstone('legacy', 'events/event-a/previews/media-legacy-v1.webp');
    await trashMediaRow('media-legacy');
    await expect(restoreMediaRow('media-legacy')).rejects.toThrow(TARGET_SUPPRESSED);
  });

  it('keeps every 0015 rule the two replaced guards inherited', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-a' });
    await insertMedia({ id: 'media-reserved', generation: 'legacy', uploadState: 'reserved', byteSize: null });
    await insertMedia({
      id: 'media-legacy',
      generation: 'legacy',
      deletedAt: TRASHED_AT,
      trashedAt: TRASHED_AT,
      restoreUntil: RESTORE_UNTIL,
    });
    await restoreMediaRow('media-legacy');

    // A legacy row still cannot become stored, and a restored one still cannot
    // change the identity of the bytes it came back to.
    await expect(env.DB.prepare(`
      UPDATE media SET upload_state = 'stored', byte_size = 12 WHERE id = 'media-reserved'
    `).run()).rejects.toThrow(/legacy stored media creation is fenced/u);
    await expect(env.DB.prepare(`
      UPDATE media SET byte_size = 24 WHERE id = 'media-legacy'
    `).run()).rejects.toThrow(/legacy stored media creation is fenced/u);

    // A canonical row still has no recorded preview pointer of its own.
    await expect(env.DB.prepare(`
      UPDATE media SET preview_object_key = ? WHERE id = 'media-a'
    `).bind(previewKey('event-a', 'media-a')).run()).rejects.toThrow(TARGET_SUPPRESSED);
  });
});

describe('migration 0019 export source holds', () => {
  beforeEach(reset);

  it('blocks suppression of an object an active export has frozen', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-a' });
    await insertExportJob({ id: 'job-a', eventId: 'event-a' });
    await insertExportEntry({ jobId: 'job-a', mediaId: 'media-a' });

    await expect(suppressTombstone('canonical', canonicalKey('event-a', 'media-a')))
      .rejects.toThrow(ACTIVE_HOLD);
    // The hold is on exact bytes, not on the event: another object of the same
    // event is still free to go.
    await expect(insertTombstone({
      generation: 'canonical',
      objectKey: canonicalKey('event-a', 'media-unheld'),
      mediaId: 'media-unheld',
      kind: 'final',
      suppressionStartedAt: NOW,
    })).resolves.toBeDefined();

    await setExportState('job-a', 'running');
    await expect(suppressTombstone('canonical', canonicalKey('event-a', 'media-a')))
      .rejects.toThrow(ACTIVE_HOLD);

    // A terminal job holds nothing, and the janitor may finally proceed.
    await setExportState('job-a', 'ready');
    await expect(suppressTombstone('canonical', canonicalKey('event-a', 'media-a')))
      .resolves.toBeDefined();
  });

  it('blocks an insert that would create an already-suppressing tombstone under a hold', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEvent();
    await insertExportJob({ id: 'job-a', eventId: 'event-a' });
    await insertExportEntry({ jobId: 'job-a', mediaId: 'media-orphan' });

    await expect(insertTombstone({
      generation: 'canonical',
      objectKey: canonicalKey('event-a', 'media-orphan'),
      mediaId: 'media-orphan',
      kind: 'final',
      suppressionStartedAt: NOW,
    })).rejects.toThrow(ACTIVE_HOLD);
    await expect(insertTombstone({
      generation: 'canonical',
      objectKey: canonicalKey('event-a', 'media-orphan'),
      mediaId: 'media-orphan',
      kind: 'final',
    })).resolves.toBeDefined();
  });

  it('refuses to freeze a source that is already on its way out', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEvent();
    await insertExportJob({ id: 'job-a', eventId: 'event-a' });
    await insertTombstone({
      generation: 'canonical',
      objectKey: canonicalKey('event-a', 'media-suppressed'),
      mediaId: 'media-suppressed',
      kind: 'final',
      suppressionStartedAt: NOW,
    });

    await expect(insertExportEntry({ jobId: 'job-a', mediaId: 'media-suppressed' }))
      .rejects.toThrow(SOURCE_SUPPRESSED);
    // The same key in the other bucket generation is a different object.
    await expect(insertExportEntry({
      jobId: 'job-a', mediaId: 'media-suppressed', generation: 'legacy',
    })).resolves.toBeDefined();
  });

  it('refuses to queue a new complete export that freezes nothing', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEvent();
    await seedEvent('event-b');
    await seedEvent('event-c');

    await expect(insertExportJob({
      id: 'job-entryless', eventId: 'event-a', mediaCount: 0, totalBytes: 0,
      guestbookEntryCount: null,
    })).rejects.toThrow(MUST_FREEZE_SOURCES);
    await expect(insertExportJob({ id: 'job-frozen', eventId: 'event-a' })).resolves.toBeDefined();
    // An album job carries no Guestbook columns and is entry-backed anyway.
    await expect(insertExportJob({ id: 'job-album', eventId: 'event-b', kind: 'album' }))
      .resolves.toBeDefined();
    // Only the queued shape is refused; history stays readable.
    await expect(insertExportJob({
      id: 'job-legacy-failed', eventId: 'event-c', state: 'failed', mediaCount: 0, totalBytes: 0,
      guestbookEntryCount: null,
    })).resolves.toBeDefined();
  });

  it('proves the frozen snapshot again at the last boundary before an R2 read', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEvent();
    await seedEvent('event-mismatch');
    await seedEvent('event-missing-tombstone');
    await seedEvent('event-suppressed');

    await insertExportJob({ id: 'job-a', eventId: 'event-a' });
    await insertExportEntry({ jobId: 'job-a', mediaId: 'media-a' });
    await insertTombstone({
      generation: 'canonical', objectKey: canonicalKey('event-a', 'media-a'),
      mediaId: 'media-a', kind: 'final',
    });
    await expect(setExportState('job-a', 'running')).resolves.toBeDefined();

    await insertExportJob({ id: 'job-missing-tombstone', eventId: 'event-missing-tombstone' });
    await insertExportEntry({
      jobId: 'job-missing-tombstone', mediaId: 'media-missing-tombstone',
      eventId: 'event-missing-tombstone',
    });
    await expect(setExportState('job-missing-tombstone', 'running'))
      .rejects.toThrow(HOLD_NOT_INTACT);

    await insertExportJob({ id: 'job-mismatch', eventId: 'event-mismatch', mediaCount: 2 });
    await insertExportEntry({
      jobId: 'job-mismatch', mediaId: 'media-mismatch', eventId: 'event-mismatch',
    });
    await expect(setExportState('job-mismatch', 'running')).rejects.toThrow(HOLD_NOT_INTACT);

    // A queued job cannot normally reach a suppressed source — that is what the
    // hold is for — so the state is built through the one door the holds do not
    // guard, to prove the fence itself and not the door.
    await insertExportJob({ id: 'job-suppressed', eventId: 'event-suppressed', state: 'ready' });
    await insertExportEntry({
      jobId: 'job-suppressed', mediaId: 'media-suppressed', eventId: 'event-suppressed',
    });
    await insertTombstone({
      generation: 'canonical',
      objectKey: canonicalKey('event-suppressed', 'media-suppressed'),
      eventId: 'event-suppressed',
      mediaId: 'media-suppressed',
      kind: 'final',
      suppressionStartedAt: NOW,
    });
    await setExportState('job-suppressed', 'queued');
    await expect(setExportState('job-suppressed', 'running')).rejects.toThrow(HOLD_NOT_INTACT);
  });

  it('reacquires a hold on retry only while every frozen source is still there', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    for (const suffix of [
      'active', 'trashed', 'deleted', 'repointed', 'missing', 'missing-tombstone', 'expired',
    ]) {
      await seedEventWithSession(`event-${suffix}`);
      await insertExportJob({ id: `job-${suffix}`, eventId: `event-${suffix}`, state: 'failed' });
      await insertExportEntry({
        jobId: `job-${suffix}`, mediaId: `media-${suffix}`, eventId: `event-${suffix}`,
      });
    }
    for (const suffix of ['active', 'trashed', 'deleted', 'repointed', 'expired']) {
      await insertMedia({ id: `media-${suffix}`, eventId: `event-${suffix}` });
    }
    // Tombstones are permanent, so the corrupt legacy fixture has to be born
    // without inventory rather than deleting evidence after the fact.
    await env.DB.exec('DROP TRIGGER media_object_write_tombstone_inventory_insert;');
    await insertMedia({
      id: 'media-missing-tombstone', eventId: 'event-missing-tombstone',
    });
    await trashMediaRow('media-trashed');
    await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = 'media-deleted'
    `).bind(NOW).run();
    await env.DB.prepare(`
      UPDATE media SET object_key = ? WHERE id = 'media-repointed'
    `).bind('events/event-repointed/media/final/media-repointed-v2').run();
    await setExportState('job-expired', 'expired');

    // An accepted export keeps its bytes; a recoverable photo still has them.
    await expect(setExportState('job-active', 'queued')).resolves.toBeDefined();
    await expect(setExportState('job-trashed', 'queued')).resolves.toBeDefined();
    await expect(setExportState('job-expired', 'queued')).resolves.toBeDefined();

    await expect(setExportState('job-deleted', 'queued')).rejects.toThrow(HOLD_NOT_REACQUIRABLE);
    await expect(setExportState('job-repointed', 'queued')).rejects.toThrow(HOLD_NOT_REACQUIRABLE);
    await expect(setExportState('job-missing', 'queued')).rejects.toThrow(HOLD_NOT_REACQUIRABLE);
    await expect(setExportState('job-missing-tombstone', 'queued'))
      .rejects.toThrow(HOLD_NOT_REACQUIRABLE);
    expect((await env.DB.prepare(`
      SELECT id, state FROM export_jobs WHERE id IN (
        'job-deleted', 'job-repointed', 'job-missing', 'job-missing-tombstone'
      )
      ORDER BY id
    `).all()).results).toEqual([
      { id: 'job-deleted', state: 'failed' },
      { id: 'job-missing', state: 'failed' },
      { id: 'job-missing-tombstone', state: 'failed' },
      { id: 'job-repointed', state: 'failed' },
    ]);
  });

  it('refuses retry for a suppressed source, a broken snapshot, or a legacy entryless job', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    for (const suffix of ['suppressed', 'count', 'entryless']) {
      await seedEventWithSession(`event-${suffix}`);
    }

    await insertExportJob({ id: 'job-suppressed', eventId: 'event-suppressed', state: 'failed' });
    await insertExportEntry({
      jobId: 'job-suppressed', mediaId: 'media-suppressed', eventId: 'event-suppressed',
    });
    await insertMedia({ id: 'media-suppressed', eventId: 'event-suppressed' });
    // The job is terminal, so the janitor was free to start suppressing.
    await suppressTombstone('canonical', canonicalKey('event-suppressed', 'media-suppressed'));

    await insertExportJob({
      id: 'job-count', eventId: 'event-count', state: 'failed', mediaCount: 2,
    });
    await insertExportEntry({ jobId: 'job-count', mediaId: 'media-count', eventId: 'event-count' });
    await insertMedia({ id: 'media-count', eventId: 'event-count' });

    await insertExportJob({
      id: 'job-entryless', eventId: 'event-entryless', state: 'failed', mediaCount: 0,
      totalBytes: 0, guestbookEntryCount: null,
    });

    await expect(setExportState('job-suppressed', 'queued')).rejects.toThrow(HOLD_NOT_REACQUIRABLE);
    await expect(setExportState('job-count', 'queued')).rejects.toThrow(HOLD_NOT_REACQUIRABLE);
    await expect(setExportState('job-entryless', 'queued')).rejects.toThrow(HOLD_NOT_REACQUIRABLE);
  });
});

describe('migration 0019 under an 0018 Worker rollback', () => {
  beforeEach(reset);

  it('hides a recoverable photo from every ordinary read an 0018 Worker performs', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-active' });
    await insertMedia({ id: 'media-trashed' });
    await env.DB.prepare(`
      UPDATE media SET publication_status = 'published', published_at = ? WHERE id IN
        ('media-active', 'media-trashed')
    `).bind(NOW).run();
    await trashMediaRow('media-trashed');

    // The 0018 predicates verbatim: intake, guest gallery, and the byte read
    // behind the capacity meter all key on `deleted_at IS NULL`.
    expect((await env.DB.prepare(`
      SELECT id FROM media
      WHERE event_id = 'event-a' AND upload_state = 'stored' AND deleted_at IS NULL
      ORDER BY id
    `).all()).results).toEqual([{ id: 'media-active' }]);
    expect((await env.DB.prepare(`
      SELECT id FROM media
      WHERE event_id = 'event-a' AND upload_state = 'stored' AND deleted_at IS NULL
        AND publication_status = 'published'
    `).all()).results).toEqual([{ id: 'media-active' }]);
    expect(await env.DB.prepare(`
      SELECT count(*) AS count, COALESCE(sum(byte_size), 0) AS bytes FROM media
      WHERE event_id = 'event-a' AND upload_state = 'stored' AND deleted_at IS NULL
    `).first()).toEqual({ count: 1, bytes: 12 });

    // Its own delete path already refuses the row before it reaches R2.
    const deletion = await env.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ?
      WHERE id = 'media-trashed' AND deleted_at IS NULL
    `).bind(NOW).run();
    expect(deletion.meta.changes).toBe(0);
    expect(await env.DB.prepare(`
      SELECT upload_state, trashed_at, restore_until FROM media WHERE id = 'media-trashed'
    `).first()).toEqual({
      upload_state: 'stored', trashed_at: TRASHED_AT, restore_until: RESTORE_UNTIL,
    });
  });

  it('stops old deletion, promotion, and janitor paths from suppressing its aliases', async () => {
    await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
    await seedEventWithSession();
    await insertMedia({ id: 'media-trashed' });
    await insertTombstone({
      objectKey: uploadKey('event-a', 'media-trashed'), mediaId: 'media-trashed', kind: 'source',
    });
    await trashMediaRow('media-trashed');

    // Every alias is due, so the janitor's batch below really does reach this
    // row's current canonical pointer rather than only its retired upload key.
    await env.DB.prepare(
      'UPDATE media_object_write_tombstones SET next_check_at = ? WHERE media_id = ?',
    ).bind(NOW, 'media-trashed').run();

    // The 0018 tombstone janitor claims a batch of due keys by suppression. The
    // batch reaches this row's current canonical pointer, so the whole statement
    // aborts and nothing in it is suppressed — which is the point: an old Worker
    // cannot schedule the deletion of bytes a host has been promised back.
    await expect(env.DB.prepare(`
      UPDATE media_object_write_tombstones
      SET suppression_started_at = ?, updated_at = ?
      WHERE suppression_started_at IS NULL AND next_check_at <= ?
    `).bind(NOW, NOW, NOW).run()).rejects.toThrow(RECOVERABLE_OWNER);

    expect((await env.DB.prepare(`
      SELECT object_key, suppression_started_at FROM media_object_write_tombstones
      WHERE media_id = 'media-trashed' ORDER BY object_key
    `).all()).results).toEqual([
      { object_key: canonicalKey('event-a', 'media-trashed'), suppression_started_at: null },
      { object_key: previewKey('event-a', 'media-trashed'), suppression_started_at: null },
      { object_key: uploadKey('event-a', 'media-trashed'), suppression_started_at: null },
    ]);
  });
});

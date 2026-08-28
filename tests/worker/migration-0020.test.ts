import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { migrationOnly, migrationsUpTo } from './helpers';

const NOW = '2026-08-25T00:00:00.000Z';
const LEGACY_STARTED_AT = '2026-08-25T00:01:00.000Z';
const EXECUTION_STARTED_AT = '2026-08-25T00:02:00.000Z';
const PROGRESS_AT = '2026-08-25T00:03:00.000Z';
const COMPLETED_AT = '2026-08-25T00:04:00.000Z';
const EXPIRES_AT = '2026-08-26T00:04:00.000Z';
const CLOSED_AT = '2026-08-25T00:05:00.000Z';
const ADMITTED_AT = '2026-08-25T00:06:00.000Z';
const WORKER_VERSION_ID = '123e4567-e89b-42d3-a456-426614174000';

type ExportState = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

interface LegacyExportFixture {
  id: string;
  eventId?: string;
  state?: ExportState;
  kind?: 'complete' | 'album';
  mediaCount?: number;
  totalBytes?: number;
  attempt?: number;
  errorCode?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  expiresAt?: string | null;
  objectKey?: string | null;
  manifestObjectKey?: string | null;
  partCount?: number;
}

interface V2ExportFixture extends LegacyExportFixture {
  executionTransition?: number;
  executionStartedAt?: string | null;
  processedMediaCount?: number | null;
  processedBytes?: number | null;
  progressUpdatedAt?: string | null;
}

async function seedEvent(id = 'event-a') {
  await env.DB.prepare(`
    INSERT INTO events (
      id, slug, name, event_date, welcome_message,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) VALUES (?, ?, 'Maya & Theo', '2026-09-19', 'Welcome.', ?, ?, ?, ?)
  `).bind(
    id,
    id,
    '2026-09-30T00:00:00.000Z',
    '2026-10-31T00:00:00.000Z',
    '2026-11-30T00:00:00.000Z',
    NOW,
  ).run();
}

/** The exact column set available to a Worker that predates migration 0020. */
function insertLegacyExport(fixture: LegacyExportFixture) {
  const kind = fixture.kind ?? 'complete';
  return env.DB.prepare(`
    INSERT INTO export_jobs (
      id, event_id, state, snapshot_at, object_key, manifest_object_key, part_count,
      media_count, total_bytes, attempt, error_code, created_at, started_at,
      completed_at, expires_at, kind, album_entries_json, guestbook_entry_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fixture.id,
    fixture.eventId ?? 'event-a',
    fixture.state ?? 'queued',
    NOW,
    fixture.objectKey ?? null,
    fixture.manifestObjectKey ?? null,
    fixture.partCount ?? 0,
    fixture.mediaCount ?? 0,
    fixture.totalBytes ?? 0,
    fixture.attempt ?? 1,
    fixture.errorCode ?? null,
    NOW,
    fixture.startedAt ?? null,
    fixture.completedAt ?? null,
    fixture.expiresAt ?? null,
    kind,
    kind === 'album' ? '[]' : null,
    kind === 'complete' ? 0 : null,
  ).run();
}

function insertV2Export(fixture: V2ExportFixture) {
  const kind = fixture.kind ?? 'complete';
  return env.DB.prepare(`
    INSERT INTO export_jobs (
      id, event_id, state, snapshot_at, media_count, total_bytes, attempt,
      error_code, created_at, started_at, completed_at, expires_at, kind,
      album_entries_json, guestbook_entry_count, execution_protocol,
      execution_transition, execution_started_at, processed_media_count,
      processed_bytes, progress_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'attempt-v2', ?, ?, ?, ?, ?)
  `).bind(
    fixture.id,
    fixture.eventId ?? 'event-a',
    fixture.state ?? 'queued',
    NOW,
    fixture.mediaCount ?? 0,
    fixture.totalBytes ?? 0,
    fixture.attempt ?? 1,
    fixture.errorCode ?? null,
    NOW,
    fixture.startedAt ?? null,
    fixture.completedAt ?? null,
    fixture.expiresAt ?? null,
    kind,
    kind === 'album' ? '[]' : null,
    kind === 'complete' ? 0 : null,
    fixture.executionTransition ?? 0,
    fixture.executionStartedAt ?? null,
    fixture.processedMediaCount ?? null,
    fixture.processedBytes ?? null,
    fixture.progressUpdatedAt ?? null,
  ).run();
}

async function applyThrough0019() {
  await applyD1Migrations(env.DB, [...migrationsUpTo('0019'), migrationOnly('0019')]);
}

async function apply0020() {
  await applyD1Migrations(env.DB, [migrationOnly('0020')]);
}

async function applyFresh0020() {
  await applyD1Migrations(env.DB, [
    ...migrationsUpTo('0019'),
    migrationOnly('0019'),
    migrationOnly('0020'),
  ]);
}

async function closeExportProtocol() {
  return env.DB.prepare(`
    UPDATE export_protocol_admission
    SET state = 'closed', closed_at = ?
    WHERE singleton = 1 AND state = 'legacy-open'
  `).bind(CLOSED_AT).run();
}

async function openExportProtocol() {
  return env.DB.prepare(`
    UPDATE export_protocol_admission
    SET state = 'open', worker_version_id = ?, admitted_at = ?
    WHERE singleton = 1 AND state = 'closed'
  `).bind(WORKER_VERSION_ID, ADMITTED_AT).run();
}

async function executionRow(id: string) {
  return env.DB.prepare(`
    SELECT state, attempt, started_at, execution_protocol, execution_transition,
      execution_started_at, processed_media_count, processed_bytes, progress_updated_at
    FROM export_jobs WHERE id = ?
  `).bind(id).first();
}

async function claimV2(id: string) {
  await env.DB.prepare(`
    UPDATE export_jobs
    SET state = 'running', execution_transition = execution_transition + 1,
      execution_started_at = ?, processed_media_count = 0, processed_bytes = 0,
      progress_updated_at = ?
    WHERE id = ?
  `).bind(EXECUTION_STARTED_AT, PROGRESS_AT, id).run();
}

async function seedHeldSources(jobId: string, eventId: string, sourceBytes: readonly number[]) {
  const statements: D1PreparedStatement[] = [];
  for (const [index, bytes] of sourceBytes.entries()) {
    const mediaId = `${jobId}-media-${index + 1}`;
    const objectKey = `events/${eventId}/media/final/${mediaId}`;
    statements.push(
      env.DB.prepare(`
        INSERT INTO export_media_entries (
          export_job_id, media_id, object_key, object_bucket_generation,
          original_filename, mime_type, declared_byte_size, byte_size, width, height,
          guest_name, caption, publication_status, created_at, published_at
        ) VALUES (?, ?, ?, 'canonical', ?, 'image/jpeg', ?, ?, 4, 3,
          'Avery Stone', NULL, 'unpublished', ?, NULL)
      `).bind(jobId, mediaId, objectKey, `${mediaId}.jpg`, bytes, bytes, NOW),
      env.DB.prepare(`
        INSERT INTO media_object_write_tombstones (
          bucket_generation, object_key, event_id, media_id, object_kind,
          suppression_started_at, next_check_at, created_at, updated_at
        ) VALUES ('canonical', ?, ?, ?, 'final', NULL, ?, ?, ?)
      `).bind(objectKey, eventId, mediaId, NOW, NOW, NOW),
    );
  }
  await env.DB.batch(statements);
}

describe('migration 0020 over a populated 0019 database', () => {
  beforeEach(reset);

  it('installs a legacy-open singleton that can close and open exactly once', async () => {
    await applyFresh0020();

    expect(await env.DB.prepare(`
      SELECT singleton, state, closed_at, worker_version_id, admitted_at
      FROM export_protocol_admission
    `).first()).toEqual({
      singleton: 1,
      state: 'legacy-open',
      closed_at: null,
      worker_version_id: null,
      admitted_at: null,
    });

    for (const statement of [
      `UPDATE export_protocol_admission
        SET state = 'open', worker_version_id = '${WORKER_VERSION_ID}', admitted_at = '${ADMITTED_AT}'
        WHERE singleton = 1`,
      `UPDATE export_protocol_admission SET state = 'closed' WHERE singleton = 1`,
      `UPDATE export_protocol_admission
        SET state = 'closed', closed_at = '2026-08-25T24:00:00.000Z'
        WHERE singleton = 1`,
      `UPDATE export_protocol_admission
        SET state = 'closed', closed_at = '9999-99-99T00:00:00.000Z'
        WHERE singleton = 1`,
      `UPDATE export_protocol_admission
        SET state = 'closed', closed_at = 'not-a-timestamp'
        WHERE singleton = 1`,
      `DELETE FROM export_protocol_admission WHERE singleton = 1`,
      `INSERT OR REPLACE INTO export_protocol_admission
        (singleton, state, closed_at, worker_version_id, admitted_at)
        VALUES (1, 'legacy-open', NULL, NULL, NULL)`,
    ]) {
      await expect(env.DB.prepare(statement).run()).rejects.toThrow();
    }

    const closed = await closeExportProtocol();
    expect(closed.meta.changes).toBe(1);
    expect(await env.DB.prepare(`
      SELECT singleton, state, closed_at, worker_version_id, admitted_at
      FROM export_protocol_admission
    `).first()).toEqual({
      singleton: 1,
      state: 'closed',
      closed_at: CLOSED_AT,
      worker_version_id: null,
      admitted_at: null,
    });

    for (const versionId of [
      'worker-version-a',
      '123E4567-e89b-42d3-a456-426614174000',
      '123e4567-e89b-42d3-a456-42661417400g',
      '123e4567e89b-42d3-a456-426614174000',
    ]) {
      await expect(env.DB.prepare(`
        UPDATE export_protocol_admission
        SET state = 'open', worker_version_id = ?, admitted_at = ?
        WHERE singleton = 1 AND state = 'closed'
      `).bind(versionId, ADMITTED_AT).run()).rejects.toThrow();
    }
    await expect(env.DB.prepare(`
      UPDATE export_protocol_admission
      SET state = 'open', worker_version_id = ?, admitted_at = '2026-08-25T24:00:00.000Z'
      WHERE singleton = 1 AND state = 'closed'
    `).bind(WORKER_VERSION_ID).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_protocol_admission
      SET state = 'open', worker_version_id = ?, admitted_at = '9999-99-99T00:00:00.000Z'
      WHERE singleton = 1 AND state = 'closed'
    `).bind(WORKER_VERSION_ID).run()).rejects.toThrow();

    const opened = await openExportProtocol();
    expect(opened.meta.changes).toBe(1);
    expect(await env.DB.prepare(`
      SELECT singleton, state, closed_at, worker_version_id, admitted_at
      FROM export_protocol_admission
    `).first()).toEqual({
      singleton: 1,
      state: 'open',
      closed_at: CLOSED_AT,
      worker_version_id: WORKER_VERSION_ID,
      admitted_at: ADMITTED_AT,
    });

    await expect(env.DB.prepare(`
      UPDATE export_protocol_admission SET worker_version_id = 'worker-version-b'
      WHERE singleton = 1
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_protocol_admission
      SET state = 'closed', worker_version_id = NULL, admitted_at = NULL
      WHERE singleton = 1
    `).run()).rejects.toThrow();
  });

  it('linearizes closure against delayed legacy create and Retry admission', async () => {
    await applyFresh0020();
    await seedEvent();

    // If the frozen old request writes first, closure loses and the old
    // Workflow definition remains authoritative until that work is terminal.
    await insertLegacyExport({ id: 'job-create-first' });
    await expect(closeExportProtocol()).rejects.toThrow(/active legacy export/iu);
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed' WHERE id = 'job-create-first'
    `).run();

    await insertLegacyExport({ id: 'job-retry-first', state: 'failed' });
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1
      WHERE id = 'job-retry-first' AND state = 'failed'
    `).run();
    await expect(closeExportProtocol()).rejects.toThrow(/active legacy export/iu);
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed' WHERE id = 'job-retry-first'
    `).run();

    expect((await closeExportProtocol()).meta.changes).toBe(1);

    // If closure writes first, both delayed frozen-old admission paths lose.
    await expect(insertLegacyExport({ id: 'job-create-after-close' }))
      .rejects.toThrow(/export execution protocol is not admitted/iu);
    await insertLegacyExport({ id: 'job-retry-after-close', state: 'failed' });
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1
      WHERE id = 'job-retry-after-close' AND state = 'failed'
    `).run()).rejects.toThrow(/export execution protocol is not admitted/iu);
  });

  it('admits active work only for the protocol owned by the current gate state', async () => {
    await applyFresh0020();
    await seedEvent();

    await expect(insertLegacyExport({ id: 'legacy-before-close' })).resolves.toBeDefined();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed' WHERE id = 'legacy-before-close'
    `).run();
    await expect(insertV2Export({ id: 'v2-before-close' }))
      .rejects.toThrow(/export execution protocol is not admitted/iu);
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET execution_protocol = 'attempt-v2', state = 'queued',
        attempt = attempt + 1, execution_transition = execution_transition + 1,
        started_at = NULL, execution_started_at = NULL,
        processed_media_count = NULL, processed_bytes = NULL,
        progress_updated_at = NULL, completed_at = NULL, expires_at = NULL
      WHERE id = 'legacy-before-close'
    `).run()).rejects.toThrow(/export execution protocol is not admitted/iu);

    expect((await closeExportProtocol()).meta.changes).toBe(1);
    await expect(insertLegacyExport({ id: 'legacy-while-closed', state: 'running' }))
      .rejects.toThrow(/export execution protocol is not admitted/iu);
    await expect(insertV2Export({ id: 'v2-while-closed' }))
      .rejects.toThrow(/export execution protocol is not admitted/iu);

    expect((await openExportProtocol()).meta.changes).toBe(1);
    await expect(insertLegacyExport({ id: 'legacy-after-open' }))
      .rejects.toThrow(/export execution protocol is not admitted/iu);
    await expect(insertV2Export({ id: 'v2-after-open' })).resolves.toBeDefined();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', execution_transition = execution_transition + 1
      WHERE id = 'v2-after-open'
    `).run();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1
      WHERE id = 'legacy-before-close' AND state = 'failed'
    `).run()).rejects.toThrow(/export execution protocol is not admitted/iu);
    await env.DB.prepare(`
      UPDATE export_jobs SET execution_protocol = 'attempt-v2', state = 'queued',
        attempt = attempt + 1, execution_transition = execution_transition + 1,
        started_at = NULL, execution_started_at = NULL,
        processed_media_count = NULL, processed_bytes = NULL,
        progress_updated_at = NULL, completed_at = NULL, expires_at = NULL
      WHERE id = 'legacy-before-close'
    `).run();
    expect(await executionRow('legacy-before-close')).toMatchObject({
      state: 'queued', attempt: 2, execution_protocol: 'attempt-v2',
    });
  });

  it('backfills exact legacy defaults without rewriting state, attempt, starts, or artifacts', async () => {
    await applyThrough0019();
    await seedEvent('event-ready');
    await seedEvent('event-running');
    await insertLegacyExport({
      id: 'job-ready',
      eventId: 'event-ready',
      state: 'ready',
      mediaCount: 2,
      totalBytes: 30,
      attempt: 4,
      startedAt: LEGACY_STARTED_AT,
      completedAt: COMPLETED_AT,
      expiresAt: EXPIRES_AT,
      objectKey: 'exports/job-ready/archive.zip',
      manifestObjectKey: 'exports/job-ready/manifest.csv',
      partCount: 2,
    });
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO export_parts (
          id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
        ) VALUES ('part-1', 'job-ready', 1, 'exports/job-ready/part-1.zip', 1, 10, ?)
      `).bind(NOW),
      env.DB.prepare(`
        INSERT INTO export_parts (
          id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
        ) VALUES ('part-2', 'job-ready', 2, 'exports/job-ready/part-2.zip', 1, 20, ?)
      `).bind(NOW),
    ]);
    // This running row is deliberately admitted after 0019 and before 0020.
    await insertLegacyExport({
      id: 'job-running', eventId: 'event-running', state: 'running', attempt: 3,
      startedAt: LEGACY_STARTED_AT,
    });

    await apply0020();

    expect((await env.DB.prepare(`
      SELECT id, state, attempt, started_at, completed_at, expires_at,
        object_key, manifest_object_key, part_count, execution_protocol,
        execution_transition, execution_started_at, processed_media_count,
        processed_bytes, progress_updated_at
      FROM export_jobs ORDER BY id
    `).all()).results).toEqual([
      {
        id: 'job-ready', state: 'ready', attempt: 4, started_at: LEGACY_STARTED_AT,
        completed_at: COMPLETED_AT, expires_at: EXPIRES_AT,
        object_key: 'exports/job-ready/archive.zip',
        manifest_object_key: 'exports/job-ready/manifest.csv', part_count: 2,
        execution_protocol: 'legacy', execution_transition: 0,
        execution_started_at: null, processed_media_count: null,
        processed_bytes: null, progress_updated_at: null,
      },
      {
        id: 'job-running', state: 'running', attempt: 3,
        started_at: LEGACY_STARTED_AT, completed_at: null, expires_at: null,
        object_key: null, manifest_object_key: null, part_count: 0,
        execution_protocol: 'legacy', execution_transition: 0,
        execution_started_at: null, processed_media_count: null,
        processed_bytes: null, progress_updated_at: null,
      },
    ]);
    expect((await env.DB.prepare(`
      SELECT id, export_job_id, part_number, object_key, media_count, source_bytes
      FROM export_parts WHERE export_job_id = 'job-ready' ORDER BY part_number
    `).all()).results).toEqual([
      {
        id: 'part-1', export_job_id: 'job-ready', part_number: 1,
        object_key: 'exports/job-ready/part-1.zip', media_count: 1, source_bytes: 10,
      },
      {
        id: 'part-2', export_job_id: 'job-ready', part_number: 2,
        object_key: 'exports/job-ready/part-2.zip', media_count: 1, source_bytes: 20,
      },
    ]);
  });

  it('keeps pre-0020 Worker DML valid for legacy rows after the migration', async () => {
    await applyFresh0020();
    await seedEvent();
    await insertLegacyExport({ id: 'job-a' });

    const firstClaim = await env.DB.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ?, error_code = NULL
      WHERE id = ? AND state = 'queued' AND EXISTS (
        SELECT 1 FROM events
        WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
      )
    `).bind(LEGACY_STARTED_AT, 'job-a').run();
    expect(firstClaim.meta.changes).toBe(1);
    await env.DB.prepare(`UPDATE export_jobs SET state = 'ready' WHERE id = 'job-a'`).run();
    await env.DB.prepare(`UPDATE export_jobs SET state = 'expired' WHERE id = 'job-a'`).run();
    const retry = await env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1,
        object_key = NULL, manifest_object_key = NULL, part_count = 0,
        error_code = NULL, started_at = NULL, completed_at = NULL, expires_at = NULL
      WHERE id = 'job-a' AND state IN ('failed', 'expired')
    `).run();
    expect(retry.meta.changes).toBe(1);
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ? WHERE id = 'job-a'
    `).bind(EXECUTION_STARTED_AT).run();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', error_code = 'EXPORT_FAILED'
      WHERE id = 'job-a' AND state IN ('queued', 'running')
    `).run();

    expect(await executionRow('job-a')).toEqual({
      state: 'failed', attempt: 2, started_at: EXECUTION_STARTED_AT,
      execution_protocol: 'legacy', execution_transition: 0,
      execution_started_at: null, processed_media_count: null,
      processed_bytes: null, progress_updated_at: null,
    });
  });

  it('upgrades data seeded under 0018 through 0019 and 0020 unchanged', async () => {
    await applyD1Migrations(env.DB, migrationsUpTo('0019'));
    await seedEvent();
    await insertLegacyExport({
      id: 'job-0018', state: 'failed', attempt: 2, startedAt: LEGACY_STARTED_AT,
      completedAt: COMPLETED_AT, errorCode: 'EXPORT_FAILED',
    });

    await applyD1Migrations(env.DB, [migrationOnly('0019'), migrationOnly('0020')]);

    expect(await executionRow('job-0018')).toEqual({
      state: 'failed', attempt: 2, started_at: LEGACY_STARTED_AT,
      execution_protocol: 'legacy', execution_transition: 0,
      execution_started_at: null, processed_media_count: null,
      processed_bytes: null, progress_updated_at: null,
    });
  });
});

describe('migration 0020 progress tuple and bounds', () => {
  beforeEach(async () => {
    await reset();
    await applyFresh0020();
    await seedEvent();
  });

  it('accepts only an all-null or all-non-null progress tuple', async () => {
    const partialTuples: Array<[number | null, number | null, string | null]> = [
      [0, null, null],
      [null, 0, null],
      [null, null, PROGRESS_AT],
      [0, 0, null],
      [0, null, PROGRESS_AT],
      [null, 0, PROGRESS_AT],
    ];
    for (const [index, tuple] of partialTuples.entries()) {
      await expect(env.DB.prepare(`
        INSERT INTO export_jobs (
          id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
          kind, album_entries_json, guestbook_entry_count,
          processed_media_count, processed_bytes, progress_updated_at
        ) VALUES (?, 'event-a', 'failed', ?, 0, 0, ?, 'complete', NULL, 0, ?, ?, ?)
      `).bind(`job-partial-${index}`, NOW, NOW, ...tuple).run()).rejects.toThrow();
    }

    await expect(insertLegacyExport({ id: 'job-null', state: 'failed' })).resolves.toBeDefined();
    await expect(env.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
        kind, album_entries_json, guestbook_entry_count,
        processed_media_count, processed_bytes, progress_updated_at
      ) VALUES ('job-zero', 'event-a', 'failed', ?, 0, 0, ?, 'complete', NULL, 0, 0, 0, ?)
    `).bind(NOW, NOW, PROGRESS_AT).run()).resolves.toBeDefined();
  });

  it('requires non-negative progress bounded by the frozen totals', async () => {
    await env.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
        kind, album_entries_json, guestbook_entry_count,
        processed_media_count, processed_bytes, progress_updated_at
      ) VALUES ('job-progress', 'event-a', 'failed', ?, 3, 30, ?, 'complete', NULL, 0, 2, 20, ?)
    `).bind(NOW, NOW, PROGRESS_AT).run();

    for (const assignment of [
      'processed_media_count = -1',
      'processed_bytes = -1',
      'processed_media_count = 4',
      'processed_bytes = 31',
    ]) {
      await expect(env.DB.prepare(`
        UPDATE export_jobs SET ${assignment} WHERE id = 'job-progress'
      `).run()).rejects.toThrow();
    }
    expect(await env.DB.prepare(`
      SELECT processed_media_count, processed_bytes FROM export_jobs WHERE id = 'job-progress'
    `).first()).toEqual({ processed_media_count: 2, processed_bytes: 20 });
  });

  it('rechecks the bounds when either frozen total changes', async () => {
    await env.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, created_at,
        kind, album_entries_json, guestbook_entry_count,
        processed_media_count, processed_bytes, progress_updated_at
      ) VALUES ('job-progress', 'event-a', 'failed', ?, 3, 30, ?, 'complete', NULL, 0, 2, 20, ?)
    `).bind(NOW, NOW, PROGRESS_AT).run();

    await expect(env.DB.prepare(`
      UPDATE export_jobs SET media_count = 1 WHERE id = 'job-progress'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET total_bytes = 19 WHERE id = 'job-progress'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET media_count = 2, total_bytes = 20 WHERE id = 'job-progress'
    `).run()).resolves.toBeDefined();
    expect(await env.DB.prepare(`
      SELECT media_count, total_bytes FROM export_jobs WHERE id = 'job-progress'
    `).first()).toEqual({ media_count: 2, total_bytes: 20 });
  });
});

describe('migration 0020 attempt-v2 execution state machine', () => {
  beforeEach(async () => {
    await reset();
    await applyFresh0020();
    await closeExportProtocol();
    await openExportProtocol();
  });

  it('permits the exact claim, terminal, expiry, and retry lifecycle', async () => {
    await seedEvent();
    await insertV2Export({ id: 'job-a' });
    await claimV2('job-a');
    await env.DB.prepare(`
      UPDATE export_jobs SET progress_updated_at = ? WHERE id = 'job-a'
    `).bind(COMPLETED_AT).run();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'ready', execution_transition = execution_transition + 1,
        completed_at = ?, expires_at = ? WHERE id = 'job-a'
    `).bind(COMPLETED_AT, EXPIRES_AT).run();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'expired', execution_transition = execution_transition + 1
      WHERE id = 'job-a'
    `).run();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1,
        execution_transition = execution_transition + 1, started_at = NULL,
        execution_started_at = NULL, processed_media_count = NULL,
        processed_bytes = NULL, progress_updated_at = NULL,
        completed_at = NULL, expires_at = NULL
      WHERE id = 'job-a'
    `).run();

    expect(await executionRow('job-a')).toEqual({
      state: 'queued', attempt: 2, started_at: null,
      execution_protocol: 'attempt-v2', execution_transition: 4,
      execution_started_at: null, processed_media_count: null,
      processed_bytes: null, progress_updated_at: null,
    });
  });

  it('allows only the exact state graph and exactly one fence increment', async () => {
    await seedEvent();
    await insertV2Export({ id: 'job-a' });

    for (const sql of [
      `UPDATE export_jobs SET state = 'running', execution_started_at = '${EXECUTION_STARTED_AT}'
        WHERE id = 'job-a'`,
      `UPDATE export_jobs SET state = 'running', execution_transition = execution_transition + 2,
        execution_started_at = '${EXECUTION_STARTED_AT}' WHERE id = 'job-a'`,
      `UPDATE export_jobs SET execution_transition = execution_transition + 1 WHERE id = 'job-a'`,
      `UPDATE export_jobs SET attempt = attempt + 1,
        execution_transition = execution_transition + 1 WHERE id = 'job-a'`,
      `UPDATE export_jobs SET state = 'ready',
        execution_transition = execution_transition + 1 WHERE id = 'job-a'`,
    ]) {
      await expect(env.DB.prepare(sql).run()).rejects.toThrow();
    }
    expect(await executionRow('job-a')).toEqual({
      state: 'queued', attempt: 1, started_at: null,
      execution_protocol: 'attempt-v2', execution_transition: 0,
      execution_started_at: null, processed_media_count: null,
      processed_bytes: null, progress_updated_at: null,
    });

    await claimV2('job-a');
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET media_count = media_count + 1 WHERE id = 'job-a'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET total_bytes = total_bytes + 1 WHERE id = 'job-a'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1,
        execution_transition = execution_transition + 1,
        execution_started_at = NULL, processed_media_count = NULL,
        processed_bytes = NULL, progress_updated_at = NULL WHERE id = 'job-a'
    `).run()).rejects.toThrow();
  });

  it('owns the legacy and v2 start columns for the whole attempt', async () => {
    await seedEvent('event-legacy-start');
    await seedEvent('event-v2-start');
    await seedEvent('event-running-insert');

    await expect(insertV2Export({
      id: 'job-legacy-start', eventId: 'event-legacy-start', startedAt: LEGACY_STARTED_AT,
    })).rejects.toThrow();
    await expect(insertV2Export({
      id: 'job-v2-start', eventId: 'event-v2-start', executionStartedAt: EXECUTION_STARTED_AT,
    })).rejects.toThrow();
    await expect(insertV2Export({
      id: 'job-running-insert', eventId: 'event-running-insert', state: 'running',
      executionStartedAt: EXECUTION_STARTED_AT, processedMediaCount: 0,
      processedBytes: 0, progressUpdatedAt: PROGRESS_AT,
    })).rejects.toThrow();
    await expect(insertV2Export({
      id: 'job-attempt-insert', eventId: 'event-running-insert', attempt: 2,
    })).rejects.toThrow();
    await expect(insertV2Export({
      id: 'job-transition-insert', eventId: 'event-running-insert', executionTransition: 1,
    })).rejects.toThrow();

    await insertV2Export({ id: 'job-a', eventId: 'event-v2-start' });
    await claimV2('job-a');
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET execution_started_at = ? WHERE id = 'job-a'
    `).bind(COMPLETED_AT).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET started_at = ? WHERE id = 'job-a'
    `).bind(LEGACY_STARTED_AT).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'ready', execution_transition = execution_transition + 1,
        execution_started_at = NULL WHERE id = 'job-a'
    `).run()).rejects.toThrow();
  });

  it('requires complete totals for Ready and preserves partial progress on Failed', async () => {
    await seedEvent('event-ready');
    await seedEvent('event-failed');
    await insertV2Export({
      id: 'job-ready', eventId: 'event-ready', mediaCount: 2, totalBytes: 20,
    });
    await insertV2Export({
      id: 'job-failed', eventId: 'event-failed', mediaCount: 2, totalBytes: 20,
    });
    await seedHeldSources('job-ready', 'event-ready', [10, 10]);
    await seedHeldSources('job-failed', 'event-failed', [10, 10]);
    await claimV2('job-ready');
    await claimV2('job-failed');
    await env.DB.prepare(`
      UPDATE export_jobs SET processed_media_count = 1, processed_bytes = 10,
        progress_updated_at = ? WHERE id IN ('job-ready', 'job-failed')
    `).bind(COMPLETED_AT).run();

    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'ready', execution_transition = execution_transition + 1
      WHERE id = 'job-ready'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', execution_transition = execution_transition + 1,
        processed_bytes = 11 WHERE id = 'job-failed'
    `).run()).rejects.toThrow();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', execution_transition = execution_transition + 1
      WHERE id = 'job-failed'
    `).run();
    expect(await executionRow('job-failed')).toMatchObject({
      state: 'failed', execution_transition: 2,
      processed_media_count: 1, processed_bytes: 10, progress_updated_at: COMPLETED_AT,
    });

    await env.DB.prepare(`
      UPDATE export_jobs SET processed_media_count = 2, processed_bytes = 20,
        progress_updated_at = ? WHERE id = 'job-ready'
    `).bind(EXPIRES_AT).run();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'ready', execution_transition = execution_transition + 1
      WHERE id = 'job-ready'
    `).run();
    expect(await executionRow('job-ready')).toMatchObject({
      state: 'ready', execution_transition: 2,
      processed_media_count: 2, processed_bytes: 20, progress_updated_at: EXPIRES_AT,
    });
  });

  it('admits queued dispatch failure and exact failed-attempt Retry only', async () => {
    await seedEvent();
    await insertV2Export({ id: 'job-a' });
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', execution_transition = execution_transition + 1,
        error_code = 'EXPORT_DISPATCH_FAILED' WHERE id = 'job-a'
    `).run();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1,
        execution_transition = execution_transition + 1,
        processed_media_count = 0, processed_bytes = 0, progress_updated_at = ?
      WHERE id = 'job-a'
    `).bind(PROGRESS_AT).run()).rejects.toThrow();
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1,
        execution_transition = execution_transition + 1,
        started_at = NULL, execution_started_at = NULL,
        processed_media_count = NULL, processed_bytes = NULL, progress_updated_at = NULL
      WHERE id = 'job-a'
    `).run();
    expect(await executionRow('job-a')).toEqual({
      state: 'queued', attempt: 2, started_at: null,
      execution_protocol: 'attempt-v2', execution_transition: 2,
      execution_started_at: null, processed_media_count: null,
      processed_bytes: null, progress_updated_at: null,
    });
  });

  it('allows only one atomic terminal legacy-to-v2 retry and never a downgrade', async () => {
    await seedEvent('event-valid');
    await seedEvent('event-invalid');
    await insertLegacyExport({
      id: 'job-valid', eventId: 'event-valid', state: 'failed', attempt: 3,
      startedAt: LEGACY_STARTED_AT, completedAt: COMPLETED_AT,
    });
    await insertLegacyExport({
      id: 'job-invalid', eventId: 'event-invalid', state: 'failed', attempt: 3,
      startedAt: LEGACY_STARTED_AT,
    });
    await env.DB.prepare(`
      UPDATE export_jobs SET processed_media_count = 0, processed_bytes = 0,
        progress_updated_at = ? WHERE id IN ('job-valid', 'job-invalid')
    `).bind(PROGRESS_AT).run();

    await expect(env.DB.prepare(`
      UPDATE export_jobs SET execution_protocol = 'attempt-v2', state = 'queued',
        attempt = attempt + 1, execution_transition = execution_transition + 1
      WHERE id = 'job-invalid'
    `).run()).rejects.toThrow();
    await env.DB.prepare(`
      UPDATE export_jobs SET execution_protocol = 'attempt-v2', state = 'queued',
        attempt = attempt + 1, execution_transition = execution_transition + 1,
        started_at = NULL, execution_started_at = NULL,
        processed_media_count = NULL, processed_bytes = NULL,
        progress_updated_at = NULL, completed_at = NULL, expires_at = NULL
      WHERE id = 'job-valid'
    `).run();
    expect(await executionRow('job-valid')).toEqual({
      state: 'queued', attempt: 4, started_at: null,
      execution_protocol: 'attempt-v2', execution_transition: 1,
      execution_started_at: null, processed_media_count: null,
      processed_bytes: null, progress_updated_at: null,
    });

    await expect(env.DB.prepare(`
      UPDATE export_jobs SET execution_protocol = 'legacy' WHERE id = 'job-valid'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET execution_protocol = 'attempt-v2' WHERE id = 'job-invalid'
    `).run()).rejects.toThrow();
  });

  it('makes the exact pre-0020 claim, terminal, retry, and expiry SQL lose', async () => {
    await seedEvent('event-active');
    await seedEvent('event-ready');
    await insertV2Export({ id: 'job-active', eventId: 'event-active' });
    await insertV2Export({ id: 'job-ready', eventId: 'event-ready' });

    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ?, error_code = NULL
      WHERE id = ? AND state = 'queued' AND EXISTS (
        SELECT 1 FROM events
        WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
      )
    `).bind(LEGACY_STARTED_AT, 'job-active').run()).rejects.toThrow();

    await claimV2('job-active');
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'ready', error_code = 'ready:old'
      WHERE id = 'job-active' AND state = 'running'
    `).run()).rejects.toThrow();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', error_code = 'EXPORT_FAILED'
      WHERE id = 'job-active' AND state IN ('queued', 'running')
    `).run()).rejects.toThrow();

    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', execution_transition = execution_transition + 1,
        error_code = 'EXPORT_FAILED' WHERE id = 'job-active'
    `).run();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'queued', attempt = attempt + 1,
        object_key = NULL, manifest_object_key = NULL, part_count = 0,
        error_code = NULL, started_at = NULL, completed_at = NULL, expires_at = NULL
      WHERE id = 'job-active' AND state IN ('failed', 'expired')
    `).run()).rejects.toThrow();

    await claimV2('job-ready');
    await env.DB.prepare(`
      UPDATE export_jobs SET state = 'ready', execution_transition = execution_transition + 1,
        completed_at = ?, expires_at = ? WHERE id = 'job-ready'
    `).bind(COMPLETED_AT, EXPIRES_AT).run();
    await expect(env.DB.prepare(`
      UPDATE export_jobs SET state = 'expired'
      WHERE id = 'job-ready' AND state = 'ready' AND expires_at <= ?
    `).bind(EXPIRES_AT).run()).rejects.toThrow();

    expect(await executionRow('job-active')).toMatchObject({
      state: 'failed', attempt: 1, execution_protocol: 'attempt-v2', execution_transition: 2,
    });
    expect(await executionRow('job-ready')).toMatchObject({
      state: 'ready', attempt: 1, execution_protocol: 'attempt-v2', execution_transition: 2,
    });
  });
});

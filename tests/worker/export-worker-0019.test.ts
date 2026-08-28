import { beforeEach, describe, expect, it } from 'vitest';

import {
  createFrozen0019R2Sentinel,
  FROZEN_0019_EVENT_PURGE_QUEUED_EXPORTS_SQL,
  FROZEN_0019_EVENT_SOFT_DELETE_SQL,
  FROZEN_0019_MARK_EXPIRED_SQL,
  FROZEN_0019_MARK_FAILED_SQL,
  FROZEN_0019_MARK_READY_CLAIM_SQL,
  FROZEN_0019_RETRY_STATE_SQL,
  runFrozen0019CallbackPrelude,
  runFrozen0019ExpiredCleanup,
} from './fixtures/export-worker-0019';
import { resetDatabase, resetDatabaseWithExportProtocolLegacyOpen, testEnv } from './helpers';

const NOW = '2026-08-25T00:00:00.000Z';
const STARTED_AT = '2026-08-25T00:01:00.000Z';
const PROGRESS_AT = '2026-08-25T00:02:00.000Z';
const COMPLETED_AT = '2026-08-25T00:03:00.000Z';
const EXPIRES_AT = '2026-08-25T00:04:00.000Z';
const AFTER_EXPIRY = '2026-08-25T00:05:00.000Z';
const ONE_BYTE_SHA256 = '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7c74e5bcca01bf';

async function seedEvent(id: string) {
  await testEnv.DB.prepare(`
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

async function seedQueuedExport(input: {
  id: string;
  eventId: string;
  protocol: 'legacy' | 'attempt-v2';
  withSource?: boolean;
}) {
  const mediaCount = input.withSource ? 1 : 0;
  const totalBytes = input.withSource ? 3 : 0;
  await testEnv.DB.prepare(`
    INSERT INTO export_jobs (
      id, event_id, state, snapshot_at, media_count, total_bytes, attempt,
      created_at, guestbook_entry_count, guestbook_shared_count,
      guestbook_event_name, guestbook_event_date, guestbook_event_timezone,
      guestbook_prompt, guestbook_gallery_visible, execution_protocol
    ) VALUES (?, ?, 'queued', ?, ?, ?, 1, ?, 0, 0,
      'Maya & Theo', '2026-09-19', 'UTC', 'Leave us a note.', 1, ?)
  `).bind(
    input.id,
    input.eventId,
    NOW,
    mediaCount,
    totalBytes,
    NOW,
    input.protocol,
  ).run();

  if (!input.withSource) return;
  const mediaId = `${input.id}-media`;
  const objectKey = `events/${input.eventId}/media/final/${mediaId}`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(`
      INSERT INTO media_object_write_tombstones (
        bucket_generation, object_key, event_id, media_id, object_kind,
        next_check_at, created_at, updated_at
      ) VALUES ('canonical', ?, ?, ?, 'final', ?, ?, ?)
    `).bind(objectKey, input.eventId, mediaId, NOW, NOW, NOW),
    testEnv.DB.prepare(`
      INSERT INTO export_media_entries (
        export_job_id, media_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size,
        guest_name, publication_status, created_at
      ) VALUES (?, ?, ?, 'canonical', 'photo.jpg', 'image/jpeg', 3, 3,
        'Avery Stone', 'unpublished', ?)
    `).bind(input.id, mediaId, objectKey, NOW),
  ]);
}

async function claimV2(id: string) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET state = 'running', execution_transition = execution_transition + 1,
      execution_started_at = ?, processed_media_count = 0,
      processed_bytes = 0, progress_updated_at = ?
    WHERE id = ?
  `).bind(STARTED_AT, PROGRESS_AT, id).run();
}

async function completeProgress(id: string) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET processed_media_count = media_count, processed_bytes = total_bytes,
      progress_updated_at = ?
    WHERE id = ?
  `).bind(PROGRESS_AT, id).run();
}

async function failV2(id: string) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET state = 'failed', execution_transition = execution_transition + 1,
      error_code = 'EXPORT_FAILED', completed_at = ?
    WHERE id = ?
  `).bind(COMPLETED_AT, id).run();
}

async function readyV2(id: string) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET state = 'ready', execution_transition = execution_transition + 1,
      completed_at = ?, expires_at = ?
    WHERE id = ?
  `).bind(COMPLETED_AT, EXPIRES_AT, id).run();
}

describe('frozen pre-0020 export Worker compatibility evidence', () => {
  beforeEach(resetDatabase);

  it('stops a v2 queued callback before every R2 boundary', async () => {
    await seedEvent('event-v2-queued');
    await seedQueuedExport({
      id: 'job-v2-queued', eventId: 'event-v2-queued', protocol: 'attempt-v2',
    });
    const sentinel = createFrozen0019R2Sentinel();

    await expect(runFrozen0019CallbackPrelude({
      db: testEnv.DB,
      boundary: sentinel.boundary,
      jobId: 'job-v2-queued',
      claimStartedAt: STARTED_AT,
      sourceObjectKey: 'must-not-be-read',
    })).rejects.toThrow('export execution transition is invalid');
    expect(sentinel.operations).toEqual([]);
  });

  it('treats a v2 running callback as lost before every R2 boundary', async () => {
    await seedEvent('event-v2-running');
    await seedQueuedExport({
      id: 'job-v2-running', eventId: 'event-v2-running', protocol: 'attempt-v2',
    });
    await claimV2('job-v2-running');
    const sentinel = createFrozen0019R2Sentinel();

    expect(await runFrozen0019CallbackPrelude({
      db: testEnv.DB,
      boundary: sentinel.boundary,
      jobId: 'job-v2-running',
      claimStartedAt: STARTED_AT,
      sourceObjectKey: 'must-not-be-read',
    })).toBe('lost');
    expect(sentinel.operations).toEqual([]);
  });

  it('keeps a legacy callback operational through its expected first R2 read', async () => {
    await resetDatabaseWithExportProtocolLegacyOpen();
    await seedEvent('event-legacy');
    await seedQueuedExport({
      id: 'job-legacy', eventId: 'event-legacy', protocol: 'legacy',
    });
    const sentinel = createFrozen0019R2Sentinel();
    const sourceObjectKey = 'events/event-legacy/uploads/frozen-source.jpg';

    expect(await runFrozen0019CallbackPrelude({
      db: testEnv.DB,
      boundary: sentinel.boundary,
      jobId: 'job-legacy',
      claimStartedAt: STARTED_AT,
      sourceObjectKey,
    })).toBe('r2-boundary');
    expect(sentinel.operations).toEqual([{ kind: 'get', key: sourceObjectKey }]);
  });

  it('makes every frozen old terminal SQL statement lose against v2 ownership', async () => {
    for (const id of ['job-ready', 'job-failed', 'job-retry', 'job-expiry']) {
      const eventId = `event-${id}`;
      await seedEvent(eventId);
      await seedQueuedExport({ id, eventId, protocol: 'attempt-v2' });
      await claimV2(id);
    }
    await failV2('job-retry');
    await readyV2('job-expiry');

    await expect(testEnv.DB.prepare(FROZEN_0019_MARK_READY_CLAIM_SQL)
      .bind('ready:old', 'job-ready').run()).rejects.toThrow('export execution transition is invalid');
    await expect(testEnv.DB.prepare(FROZEN_0019_MARK_FAILED_SQL)
      .bind('EXPORT_FAILED', 'job-failed').run()).rejects.toThrow('export execution transition is invalid');
    await expect(testEnv.DB.prepare(FROZEN_0019_RETRY_STATE_SQL)
      .bind('job-retry').run()).rejects.toThrow('export execution transition is invalid');
    await expect(testEnv.DB.prepare(FROZEN_0019_MARK_EXPIRED_SQL)
      .bind('job-expiry', AFTER_EXPIRY).run()).rejects.toThrow('export execution transition is invalid');
  });

  it('makes the old queued purge batch lose while the v2 source hold survives', async () => {
    const eventId = 'event-purge';
    const jobId = 'job-purge';
    await seedEvent(eventId);
    await seedQueuedExport({ id: jobId, eventId, protocol: 'attempt-v2', withSource: true });

    await expect(testEnv.DB.batch([
      testEnv.DB.prepare(FROZEN_0019_EVENT_SOFT_DELETE_SQL).bind(NOW, eventId),
      testEnv.DB.prepare(FROZEN_0019_EVENT_PURGE_QUEUED_EXPORTS_SQL).bind(eventId),
    ])).rejects.toThrow('export execution transition is invalid');

    expect(await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(eventId).first()).toEqual({ deleted_at: null });
    expect(await testEnv.DB.prepare('SELECT state FROM export_jobs WHERE id = ?')
      .bind(jobId).first()).toEqual({ state: 'queued' });
    expect((await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(jobId).first<{ count: number }>())?.count).toBe(1);
    await expect(testEnv.DB.prepare(`
      UPDATE media_object_write_tombstones SET suppression_started_at = ?
      WHERE event_id = ? AND media_id = ?
    `).bind(NOW, eventId, `${jobId}-media`).run())
      .rejects.toThrow('an active export holds this source object');
  });

  it('documents that old expiry deletes v2 Ready inventory before its D1 write loses', async () => {
    const eventId = 'event-expiry-hazard';
    const jobId = 'job-expiry-hazard';
    const keys = [
      `events/${eventId}/exports/${jobId}/attempt-1/candidary-export-manifest.csv`,
      `events/${eventId}/exports/${jobId}/attempt-1/photos-001.zip`,
      `events/${eventId}/exports/${jobId}/attempt-1/guestbook.html`,
      `events/${eventId}/exports/${jobId}/attempt-1/guestbook-private.csv`,
    ];
    await seedEvent(eventId);
    await seedQueuedExport({ id: jobId, eventId, protocol: 'attempt-v2', withSource: true });
    await claimV2(jobId);
    await completeProgress(jobId);
    await readyV2(jobId);
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE export_jobs
        SET manifest_object_key = ?, part_count = 1,
          guestbook_html_object_key = ?, guestbook_html_bytes = 1,
          guestbook_html_sha256 = ?, guestbook_csv_object_key = ?,
          guestbook_csv_bytes = 1, guestbook_csv_sha256 = ?
        WHERE id = ?
      `).bind(keys[0], keys[2], ONE_BYTE_SHA256, keys[3], ONE_BYTE_SHA256, jobId),
      testEnv.DB.prepare(`
        INSERT INTO export_parts (
          id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
        ) VALUES ('hazard-part', ?, 1, ?, 1, 3, ?)
      `).bind(jobId, keys[1], COMPLETED_AT),
    ]);
    for (const key of keys) await testEnv.MEDIA_BUCKET.put(key, new Uint8Array([1]));

    await expect(runFrozen0019ExpiredCleanup({
      db: testEnv.DB,
      bucket: testEnv.MEDIA_BUCKET,
      now: AFTER_EXPIRY,
    })).rejects.toThrow('export execution transition is invalid');

    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
    expect(await testEnv.DB.prepare(`
      SELECT state, execution_transition, manifest_object_key,
        guestbook_html_object_key, guestbook_html_bytes, guestbook_html_sha256,
        guestbook_csv_object_key, guestbook_csv_bytes, guestbook_csv_sha256
      FROM export_jobs WHERE id = ?
    `).bind(jobId).first()).toEqual({
      state: 'ready',
      execution_transition: 2,
      manifest_object_key: keys[0],
      guestbook_html_object_key: keys[2],
      guestbook_html_bytes: 1,
      guestbook_html_sha256: ONE_BYTE_SHA256,
      guestbook_csv_object_key: keys[3],
      guestbook_csv_bytes: 1,
      guestbook_csv_sha256: ONE_BYTE_SHA256,
    });
    expect((await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_parts WHERE export_job_id = ?
    `).bind(jobId).first<{ count: number }>())?.count).toBe(1);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ExportsRepository,
  type ExpiredArtifactInventoryCandidate,
  type ExportExpiryCandidate,
  type ExportRunOwner,
  type ReadyExportInventory,
} from '../../worker/db/exports';
import {
  eventAccess,
  resetDatabase,
  seedExportJob,
  testEnv,
  uploadPending,
} from './helpers';

const SNAPSHOT_AT = '2026-08-25T10:00:00.000Z';
const STARTED_AT = '2026-08-25T10:01:00.000Z';
const PROGRESS_AT = '2026-08-25T10:02:00.000Z';
const COMPLETED_AT = '2026-08-25T10:03:00.000Z';
const EXPIRES_AT = '2026-08-25T11:00:00.000Z';
const AFTER_EXPIRY = '2026-08-25T12:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

type Access = Awaited<ReturnType<typeof eventAccess>>;
type UploadedMedia = Awaited<ReturnType<typeof uploadPending>>;

function sourceBytes(media: readonly UploadedMedia[]) {
  return media.reduce((sum, item) => sum + (item.byteSize ?? item.declaredByteSize), 0);
}

async function seedV2Queued(input: {
  access: Access;
  id: string;
  media: readonly UploadedMedia[];
  kind?: 'complete' | 'album';
}) {
  const kind = input.kind ?? 'album';
  const statements = [
    testEnv.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, kind, album_entries_json, state, snapshot_at,
        media_count, total_bytes, attempt, created_at,
        guestbook_entry_count, guestbook_shared_count, guestbook_event_name,
        guestbook_event_date, guestbook_event_timezone, guestbook_prompt,
        guestbook_gallery_visible, execution_protocol, execution_transition
      ) VALUES (
        ?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, 1, ?5,
        ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'attempt-v2', 0
      )
    `).bind(
      input.id,
      input.access.event.id,
      kind,
      kind === 'album' ? '[]' : null,
      SNAPSHOT_AT,
      input.media.length,
      sourceBytes(input.media),
      kind === 'complete' ? 0 : null,
      kind === 'complete' ? 0 : null,
      kind === 'complete' ? input.access.event.name : null,
      kind === 'complete' ? input.access.event.eventDate : null,
      kind === 'complete' ? input.access.event.eventTimezone : null,
      kind === 'complete' ? input.access.event.guestbookPrompt : null,
      kind === 'complete' ? Number(input.access.event.galleryVisible) : null,
    ),
    ...input.media.map((item, index) => testEnv.DB.prepare(`
      INSERT INTO export_media_entries (
        export_job_id, media_id, object_key, object_bucket_generation,
        original_filename, mime_type, declared_byte_size, byte_size, width, height,
        guest_name, caption, publication_status, created_at, published_at,
        album_tail_position
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    `).bind(
      input.id,
      item.id,
      item.objectKey,
      item.objectBucketGeneration,
      item.originalFilename,
      item.mimeType,
      item.declaredByteSize,
      item.byteSize,
      item.width,
      item.height,
      item.guestName,
      item.caption,
      item.publicationStatus,
      item.createdAt,
      item.publishedAt,
      kind === 'album' ? index + 1 : null,
    )),
  ];
  await testEnv.DB.batch(statements);
}

async function claimV2Direct(id: string, startedAt = STARTED_AT) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET state = 'running', execution_transition = execution_transition + 1,
      execution_started_at = ?2, processed_media_count = 0,
      processed_bytes = 0, progress_updated_at = ?2
    WHERE id = ?1 AND state = 'queued' AND execution_protocol = 'attempt-v2'
  `).bind(id, startedAt).run();
}

async function progressV2Direct(
  id: string,
  processedMediaCount: number,
  processedBytes: number,
  progressUpdatedAt = PROGRESS_AT,
) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET processed_media_count = ?2, processed_bytes = ?3, progress_updated_at = ?4
    WHERE id = ?1 AND state = 'running'
  `).bind(id, processedMediaCount, processedBytes, progressUpdatedAt).run();
}

async function failV2Direct(id: string) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET state = 'failed', execution_transition = execution_transition + 1,
      error_code = 'EXPORT_FAILED', completed_at = ?2
    WHERE id = ?1 AND state = 'running'
  `).bind(id, COMPLETED_AT).run();
}

async function retryV2Direct(id: string) {
  await testEnv.DB.prepare(`
    UPDATE export_jobs
    SET state = 'queued', attempt = attempt + 1,
      execution_transition = execution_transition + 1,
      object_key = NULL, manifest_object_key = NULL, part_count = 0,
      error_code = NULL, started_at = NULL, execution_started_at = NULL,
      processed_media_count = NULL, processed_bytes = NULL,
      progress_updated_at = NULL, completed_at = NULL, expires_at = NULL
    WHERE id = ?1 AND state IN ('failed', 'expired')
  `).bind(id).run();
  await testEnv.DB.prepare('DELETE FROM export_parts WHERE export_job_id = ?').bind(id).run();
}

function owner(id: string, executionStartedAt = STARTED_AT, attempt = 1): ExportRunOwner {
  return { id, executionProtocol: 'attempt-v2', attempt, executionStartedAt };
}

function albumInventory(access: Access, id: string, media: readonly UploadedMedia[]): ReadyExportInventory {
  return {
    manifestObjectKey: `events/${access.event.id}/exports/${id}/attempt-1/manifest.csv`,
    parts: media.map((item, index) => ({
      partNumber: index + 1,
      objectKey: `events/${access.event.id}/exports/${id}/attempt-1/photos-${index + 1}.zip`,
      mediaCount: 1,
      sourceBytes: item.byteSize ?? item.declaredByteSize,
    })),
    guestbook: null,
  };
}

async function seedReadyV2(access: Access, id: string) {
  const media = [
    await uploadPending(access, `${id}-first`, null),
    await uploadPending(access, `${id}-second`, null),
  ];
  await seedV2Queued({ access, id, media, kind: 'complete' });
  await claimV2Direct(id);
  await progressV2Direct(id, media.length, sourceBytes(media));
  const inventory = {
    objectKey: `events/${access.event.id}/exports/${id}/attempt-1/archive.zip`,
    manifestObjectKey: `events/${access.event.id}/exports/${id}/attempt-1/manifest.csv`,
    guestbookHtmlObjectKey: `events/${access.event.id}/exports/${id}/attempt-1/guestbook.html`,
    guestbookCsvObjectKey: `events/${access.event.id}/exports/${id}/attempt-1/guestbook.csv`,
    parts: media.map((item, index) => ({
      partNumber: index + 1,
      objectKey: `events/${access.event.id}/exports/${id}/attempt-1/photos-${index + 1}.zip`,
      mediaCount: 1,
      sourceBytes: item.byteSize ?? item.declaredByteSize,
    })),
  };
  await testEnv.DB.batch([
    testEnv.DB.prepare(`
      UPDATE export_jobs
      SET state = 'ready', execution_transition = execution_transition + 1,
        object_key = ?2, manifest_object_key = ?3, part_count = ?4,
        guestbook_html_object_key = ?5, guestbook_html_bytes = 11,
        guestbook_html_sha256 = ?6, guestbook_csv_object_key = ?7,
        guestbook_csv_bytes = 12, guestbook_csv_sha256 = ?8,
        completed_at = ?9, expires_at = ?10
      WHERE id = ?1 AND state = 'running'
    `).bind(
      id,
      inventory.objectKey,
      inventory.manifestObjectKey,
      inventory.parts.length,
      inventory.guestbookHtmlObjectKey,
      SHA_A,
      inventory.guestbookCsvObjectKey,
      SHA_B,
      COMPLETED_AT,
      EXPIRES_AT,
    ),
    ...inventory.parts.map((part) => testEnv.DB.prepare(`
      INSERT INTO export_parts (
        id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `${id}-part-${part.partNumber}`,
      id,
      part.partNumber,
      part.objectKey,
      part.mediaCount,
      part.sourceBytes,
      COMPLETED_AT,
    )),
  ]);
  const candidate: ExportExpiryCandidate = {
    id,
    executionProtocol: 'attempt-v2',
    attempt: 1,
    executionTransition: 2,
    expiresAt: EXPIRES_AT,
  };
  return { candidate, inventory };
}

async function executionRow(id: string) {
  return testEnv.DB.prepare(`
    SELECT state, attempt, started_at, execution_protocol, execution_transition,
      execution_started_at, processed_media_count, processed_bytes,
      progress_updated_at, error_code, completed_at, expires_at
    FROM export_jobs WHERE id = ?
  `).bind(id).first();
}

describe('attempt-v2 export repository', () => {
  beforeEach(resetDatabase);

  it('creates and maps complete and Album jobs as pristine attempt-v2 attempts', async () => {
    const completeAccess = await eventAccess();
    await uploadPending(completeAccess, 'v2-complete-create', null);
    const albumAccess = await eventAccess();
    const picked = await uploadPending(albumAccess, 'v2-album-create', null);
    const pickedAt = new Date(Date.now() - 60_000).toISOString();
    const snapshotAt = new Date(Date.now() + 60_000).toISOString();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE media SET created_at = ?1, stored_at = ?1, favorited_at = ?1 WHERE id = ?2
      `).bind(pickedAt, picked.id),
      testEnv.DB.prepare(`
        INSERT INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
        VALUES (?1, ?2, ?3, 1, ?3, ?3)
      `).bind(albumAccess.event.id, JSON.stringify([{ kind: 'photo', mediaId: picked.id }]), pickedAt),
    ]);
    const repository = new ExportsRepository(testEnv.DB);
    const complete = await repository.createActive({
      id: 'v2-complete', eventId: completeAccess.event.id, snapshotAt, createdAt: snapshotAt,
    });
    const album = await repository.createAlbumActive({
      id: 'v2-album', eventId: albumAccess.event.id, snapshotAt, createdAt: snapshotAt,
    });

    for (const job of [complete, album]) {
      expect.soft(await executionRow(job.id)).toMatchObject({
        state: 'queued', attempt: 1, started_at: null,
        execution_protocol: 'attempt-v2', execution_transition: 0,
        execution_started_at: null, processed_media_count: null,
        processed_bytes: null, progress_updated_at: null,
      });
      expect.soft(job).toMatchObject({
        executionProtocol: 'attempt-v2', executionTransition: 0,
        executionStartedAt: null, processedMediaCount: null,
        processedBytes: null, progressUpdatedAt: null,
      });
    }
  });

  it('claims, resumes, and loses only the exact attempt and execution start', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'claim-owner', null);
    await seedV2Queued({ access, id: 'claim-job', media: [media] });
    const repository = new ExportsRepository(testEnv.DB);
    const exactOwner = owner('claim-job');

    expect(await repository.claimRunning('claim-job', 1, STARTED_AT)).toMatchObject({
      status: 'claimed', owner: exactOwner,
      job: { state: 'running', executionTransition: 1, processedMediaCount: 0,
        processedBytes: 0, progressUpdatedAt: STARTED_AT },
    });
    const afterClaim = await executionRow('claim-job');
    expect(await repository.claimRunning('claim-job', 1, STARTED_AT)).toMatchObject({
      status: 'resumed', owner: exactOwner,
    });
    expect(await executionRow('claim-job')).toEqual(afterClaim);
    expect(await repository.claimRunning('claim-job', 2, STARTED_AT)).toMatchObject({ status: 'lost' });
    expect(await repository.claimRunning('claim-job', 1, PROGRESS_AT)).toMatchObject({ status: 'lost' });
  });

  it('classifies active, event-deleted, and lost assertions without writing', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'assert-owner', null);
    await seedV2Queued({ access, id: 'assert-job', media: [media] });
    await claimV2Direct('assert-job');
    const repository = new ExportsRepository(testEnv.DB);
    const exactOwner = owner('assert-job');

    expect(await repository.assertOwnedRunActive(exactOwner)).toMatchObject({
      status: 'active', job: { id: 'assert-job', state: 'running' },
    });
    await testEnv.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(COMPLETED_AT, access.event.id).run();
    expect(await repository.assertOwnedRunActive(exactOwner)).toMatchObject({ status: 'event-deleted' });
    expect(await repository.assertOwnedRunActive(owner('assert-job', PROGRESS_AT))).toMatchObject({
      status: 'lost',
    });
    expect(await repository.assertOwnedRunActive(owner('missing-job'))).toEqual({
      status: 'lost', job: null,
    });
    expect(await executionRow('assert-job')).toMatchObject({ state: 'running', execution_transition: 1 });
  });

  it('records absolute monotonic progress, preserves equal replay time, and fences reset', async () => {
    const access = await eventAccess();
    const media = [
      await uploadPending(access, 'progress-first', null),
      await uploadPending(access, 'progress-second', null),
    ];
    await seedV2Queued({ access, id: 'progress-job', media });
    await claimV2Direct('progress-job');
    const repository = new ExportsRepository(testEnv.DB);
    const exactOwner = owner('progress-job');

    expect(await repository.recordProgress(exactOwner, {
      processedMediaCount: 1, processedBytes: 64, progressUpdatedAt: PROGRESS_AT,
    })).toBe(true);
    expect(await repository.recordProgress(exactOwner, {
      processedMediaCount: 1, processedBytes: 64, progressUpdatedAt: COMPLETED_AT,
    })).toBe(true);
    expect(await executionRow('progress-job')).toMatchObject({ progress_updated_at: PROGRESS_AT });
    expect(await repository.recordProgress(exactOwner, {
      processedMediaCount: 0, processedBytes: 0, progressUpdatedAt: COMPLETED_AT,
    })).toBe(false);
    expect(await repository.recordProgress(owner('progress-job', STARTED_AT, 2), {
      processedMediaCount: 2, processedBytes: 128, progressUpdatedAt: COMPLETED_AT,
    })).toBe(false);
    expect(await repository.resetOwnedRunProgress(owner('progress-job', COMPLETED_AT), COMPLETED_AT))
      .toBe(false);
    expect(await repository.resetOwnedRunProgress(exactOwner, COMPLETED_AT)).toBe(true);
    expect(await executionRow('progress-job')).toMatchObject({
      processed_media_count: 0, processed_bytes: 0, progress_updated_at: COMPLETED_AT,
    });
  });

  it('requires progress equality for Ready and makes stale Ready writes exact zero-row no-ops', async () => {
    const access = await eventAccess();
    const media = [
      await uploadPending(access, 'ready-first', null),
      await uploadPending(access, 'ready-second', null),
    ];
    await seedV2Queued({ access, id: 'ready-job', media });
    await claimV2Direct('ready-job');
    const repository = new ExportsRepository(testEnv.DB);
    const inventory = albumInventory(access, 'ready-job', media);

    expect(await repository.markReady(
      owner('ready-job'), inventory, COMPLETED_AT, EXPIRES_AT,
    )).toMatchObject({ changed: false, job: { state: 'running' } });
    expect(await repository.listParts('ready-job')).toEqual([]);
    await progressV2Direct('ready-job', media.length, sourceBytes(media));
    expect(await repository.markReady(
      owner('ready-job', PROGRESS_AT), inventory, COMPLETED_AT, EXPIRES_AT,
    )).toMatchObject({ changed: false, job: { state: 'running' } });
    expect(await repository.markReady(
      owner('ready-job'), inventory, COMPLETED_AT, EXPIRES_AT,
    )).toMatchObject({
      changed: true,
      job: { state: 'ready', executionTransition: 2, processedMediaCount: 2, processedBytes: 128 },
    });
  });

  it('preserves partial progress on owned Failed and makes stale Failed a zero-row no-op', async () => {
    const access = await eventAccess();
    const media = [
      await uploadPending(access, 'failed-first', null),
      await uploadPending(access, 'failed-second', null),
    ];
    await seedV2Queued({ access, id: 'failed-job', media });
    await claimV2Direct('failed-job');
    await progressV2Direct('failed-job', 1, 64);
    const repository = new ExportsRepository(testEnv.DB);

    expect(await repository.markOwnedFailed(
      owner('failed-job', PROGRESS_AT), 'EXPORT_FAILED', COMPLETED_AT,
    )).toMatchObject({ changed: false, job: { state: 'running' } });
    expect(await repository.markOwnedFailed(
      owner('failed-job'), 'EXPORT_FAILED', COMPLETED_AT,
    )).toMatchObject({
      changed: true,
      job: {
        state: 'failed', executionTransition: 2, processedMediaCount: 1,
        processedBytes: 64, progressUpdatedAt: PROGRESS_AT, completedAt: COMPLETED_AT,
      },
    });
  });

  it('fences an initial dispatch failure to the exact pristine v2 attempt', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'initial-dispatch', null);
    await seedV2Queued({ access, id: 'initial-dispatch-job', media: [media] });

    expect(await new ExportsRepository(testEnv.DB).markInitialDispatchFailed(
      'initial-dispatch-job', 'EXPORT_WORKFLOW_DISPATCH_FAILED',
    )).toMatchObject({
      changed: true,
      job: {
        state: 'failed', attempt: 1, executionProtocol: 'attempt-v2',
        executionTransition: 1, executionStartedAt: null,
        processedMediaCount: null, processedBytes: null, progressUpdatedAt: null,
      },
    });
  });

  it('fences retry dispatch failure by exact attempt, pristine fields, and transition', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'retry-dispatch', null);
    await seedV2Queued({ access, id: 'retry-dispatch-job', media: [media] });
    await claimV2Direct('retry-dispatch-job');
    await failV2Direct('retry-dispatch-job');
    await retryV2Direct('retry-dispatch-job');
    const repository = new ExportsRepository(testEnv.DB);

    expect(await repository.markRetryDispatchFailed(
      'retry-dispatch-job', 1, 'EXPORT_WORKFLOW_DISPATCH_FAILED',
    )).toMatchObject({ changed: false });
    await testEnv.DB.prepare("UPDATE export_jobs SET manifest_object_key = 'not-pristine' WHERE id = ?")
      .bind('retry-dispatch-job').run();
    expect(await repository.markRetryDispatchFailed(
      'retry-dispatch-job', 2, 'EXPORT_WORKFLOW_DISPATCH_FAILED',
    )).toMatchObject({ changed: false });
    await testEnv.DB.prepare('UPDATE export_jobs SET manifest_object_key = NULL WHERE id = ?')
      .bind('retry-dispatch-job').run();
    expect(await repository.markRetryDispatchFailed(
      'retry-dispatch-job', 2, 'EXPORT_WORKFLOW_DISPATCH_FAILED',
    )).toMatchObject({
      changed: true,
      job: { state: 'failed', attempt: 2, executionTransition: 4 },
    });
  });

  it('retries v2 by advancing and resetting one transition', async () => {
    const v2Access = await eventAccess();
    const v2Media = await uploadPending(v2Access, 'retry-v2', null);
    await seedV2Queued({ access: v2Access, id: 'retry-v2-job', media: [v2Media] });
    await claimV2Direct('retry-v2-job');
    await progressV2Direct('retry-v2-job', 1, 64);
    await failV2Direct('retry-v2-job');
    expect(await new ExportsRepository(testEnv.DB).retry('retry-v2-job')).toMatchObject({
      state: 'queued', attempt: 2, executionProtocol: 'attempt-v2', executionTransition: 3,
      startedAt: null, executionStartedAt: null, processedMediaCount: null,
      processedBytes: null, progressUpdatedAt: null, completedAt: null, expiresAt: null,
    });
  });

  it('upgrades a valid terminal legacy photo job to v2 in one reset transition', async () => {
    const legacyAccess = await eventAccess();
    const legacyMedia = await uploadPending(legacyAccess, 'retry-legacy', null);
    await seedExportJob({
      id: 'retry-legacy-job', eventId: legacyAccess.event.id, snapshotAt: SNAPSHOT_AT,
      state: 'failed', attempt: 3, media: [legacyMedia],
    });
    expect(await new ExportsRepository(testEnv.DB).retry('retry-legacy-job')).toMatchObject({
      state: 'queued', attempt: 4, executionProtocol: 'attempt-v2', executionTransition: 1,
      startedAt: null, executionStartedAt: null, processedMediaCount: null,
      processedBytes: null, progressUpdatedAt: null, completedAt: null, expiresAt: null,
    });
  });

  it('rejects a source-less legacy snapshot without mutating it', async () => {
    const access = await eventAccess();
    await testEnv.DB.prepare(`
      INSERT INTO export_jobs (
        id, event_id, kind, state, snapshot_at, media_count, total_bytes,
        attempt, error_code, created_at, guestbook_entry_count
      ) VALUES ('invalid-legacy', ?, 'complete', 'failed', ?, 0, 0, 2,
        'EXPORT_FAILED', ?, NULL)
    `).bind(access.event.id, SNAPSHOT_AT, SNAPSHOT_AT).run();
    const before = await testEnv.DB.prepare('SELECT * FROM export_jobs WHERE id = ?')
      .bind('invalid-legacy').first();

    await expect(new ExportsRepository(testEnv.DB).retry('invalid-legacy'))
      .rejects.toMatchObject({ code: 'EXPORT_SOURCE_REMOVED' });
    expect(await testEnv.DB.prepare('SELECT * FROM export_jobs WHERE id = ?')
      .bind('invalid-legacy').first()).toEqual(before);
  });

  it('distinguishes a complete historical zero-photo Guestbook snapshot from missing source', async () => {
    const access = await eventAccess();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO export_jobs (
          id, event_id, kind, state, snapshot_at, media_count, total_bytes,
          attempt, error_code, created_at, completed_at,
          guestbook_entry_count, guestbook_shared_count, guestbook_event_name,
          guestbook_event_date, guestbook_event_timezone, guestbook_prompt,
          guestbook_gallery_visible, guestbook_html_object_key, guestbook_html_bytes,
          guestbook_html_sha256, guestbook_csv_object_key, guestbook_csv_bytes,
          guestbook_csv_sha256
        ) VALUES (
          'guestbook-legacy', ?, 'complete', 'failed', ?, 0, 0, 2,
          'EXPORT_FAILED', ?, ?, 1, 1, ?, ?, ?, ?, 1,
          'guestbook.html', 11, ?, 'guestbook.csv', 12, ?
        )
      `).bind(
        access.event.id, SNAPSHOT_AT, SNAPSHOT_AT, COMPLETED_AT,
        access.event.name, access.event.eventDate, access.event.eventTimezone,
        access.event.guestbookPrompt, SHA_A, SHA_B,
      ),
      testEnv.DB.prepare(`
        INSERT INTO export_guestbook_entries (
          export_job_id, source, source_id, source_rank, guest_name, body,
          created_at, source_state, guest_visibility, included_in_keepsake,
          media_id, original_filename
        ) VALUES (
          'guestbook-legacy', 'guest_note', 'note-1', 0, 'Avery', 'A memory',
          ?, 'approved', 'shared', 1, NULL, NULL
        )
      `).bind(SNAPSHOT_AT),
    ]);

    expect(await new ExportsRepository(testEnv.DB).retry('guestbook-legacy')).toMatchObject({
      state: 'queued', attempt: 3, executionProtocol: 'attempt-v2', executionTransition: 1,
      mediaCount: 0, totalBytes: 0, executionStartedAt: null,
      processedMediaCount: null, processedBytes: null, progressUpdatedAt: null,
      guestbookEntryCount: 1, guestbookHtmlObjectKey: null, guestbookCsvObjectKey: null,
    });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_guestbook_entries WHERE export_job_id = 'guestbook-legacy'
    `).first<number>('count')).toBe(1);
  });

  it('captures exact Ready inventory only after the guarded Expired transition', async () => {
    const access = await eventAccess();
    const { candidate, inventory } = await seedReadyV2(access, 'expiry-capture');
    const repository = new ExportsRepository(testEnv.DB);

    expect(await repository.listExpiredReady(AFTER_EXPIRY)).toEqual([candidate]);
    expect(await repository.markExpired(candidate, AFTER_EXPIRY)).toEqual({
      changed: true,
      job: expect.objectContaining({ state: 'expired', executionTransition: 3 }),
      cleanup: { ...candidate, executionTransition: 3, inventory },
    });
  });

  it('makes a stale expiry candidate a zero-row no-op', async () => {
    const access = await eventAccess();
    const { candidate } = await seedReadyV2(access, 'expiry-stale');
    const repository = new ExportsRepository(testEnv.DB);
    const stale = { ...candidate, attempt: candidate.attempt + 1 };

    expect(await repository.markExpired(stale, AFTER_EXPIRY)).toMatchObject({
      changed: false, job: { state: 'ready', executionTransition: 2 },
    });
    expect(await executionRow(candidate.id)).toMatchObject({ state: 'ready', execution_transition: 2 });
  });

  it('recovers retained Expired inventory and clears only the exact post-transition candidate', async () => {
    const access = await eventAccess();
    const { candidate, inventory } = await seedReadyV2(access, 'expiry-recovery');
    await testEnv.DB.prepare(`
      UPDATE export_jobs
      SET state = 'expired', execution_transition = execution_transition + 1
      WHERE id = ? AND state = 'ready'
    `).bind(candidate.id).run();
    const cleanup: ExpiredArtifactInventoryCandidate = {
      ...candidate, executionTransition: 3, inventory,
    };
    const repository = new ExportsRepository(testEnv.DB);

    expect(await repository.listExpiredWithInventory(100)).toEqual([cleanup]);
    expect(await repository.clearExpiredInventory({ ...cleanup, executionTransition: 2 })).toBe(false);
    expect(await repository.listParts(candidate.id)).toHaveLength(2);
    expect(await repository.clearExpiredInventory(cleanup)).toBe(true);
    expect(await repository.listParts(candidate.id)).toEqual([]);
    expect(await testEnv.DB.prepare(`
      SELECT object_key, manifest_object_key, part_count,
        guestbook_html_object_key, guestbook_html_bytes, guestbook_html_sha256,
        guestbook_csv_object_key, guestbook_csv_bytes, guestbook_csv_sha256
      FROM export_jobs WHERE id = ?
    `).bind(candidate.id).first()).toEqual({
      object_key: null, manifest_object_key: null, part_count: 0,
      guestbook_html_object_key: null, guestbook_html_bytes: null, guestbook_html_sha256: null,
      guestbook_csv_object_key: null, guestbook_csv_bytes: null, guestbook_csv_sha256: null,
    });
  });
});

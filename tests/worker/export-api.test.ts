import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { MAX_EVENT_BYTES } from '../../shared/constants';
import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { cleanupExpiredRecoverableMedia } from '../../worker/workflows/cleanup';
import {
  eventAccess, png, processExport, resetDatabase, seedExportJob, testEnv, trashMedia,
  resetDatabaseWithExportProtocolClosed, uploadPending, writeHeaders,
} from './helpers';

const managerExportKeys = [
  'attempt',
  'completedAt',
  'createdAt',
  'errorCode',
  'expiresAt',
  'guestbookEntryCount',
  'guestbookEventDate',
  'guestbookEventName',
  'guestbookEventTimezone',
  'guestbookGalleryVisible',
  'guestbookPrompt',
  'guestbookSharedCount',
  'id',
  'kind',
  'mediaCount',
  'partCount',
  'processedBytes',
  'processedMediaCount',
  'progressUpdatedAt',
  'snapshotAt',
  'startedAt',
  'state',
  'totalBytes',
].sort();

function expectManagerExport(value: Record<string, unknown>) {
  expect(Object.keys(value).sort()).toEqual(managerExportKeys);
}

async function failPristineExport(jobId: string, errorCode = 'EXPORT_TEST_FAILURE') {
  const result = await new ExportsRepository(testEnv.DB).markInitialDispatchFailed(jobId, errorCode);
  if (!result.changed || !result.job) throw new Error('Expected a pristine v2 export to fail.');
  return result.job;
}

async function expireReadyExport(jobId: string) {
  const repository = new ExportsRepository(testEnv.DB);
  const expiredAt = '2026-08-11T00:00:00.000Z';
  await testEnv.DB.prepare(`UPDATE export_jobs SET expires_at = ?2 WHERE id = ?1 AND state = 'ready'`)
    .bind(jobId, expiredAt).run();
  const candidate = (await repository.listExpiredReady('2026-08-12T00:00:00.000Z'))
    .find(({ id }) => id === jobId);
  if (!candidate) throw new Error('Expected a Ready export expiry candidate.');
  const result = await repository.markExpired(candidate, '2026-08-12T00:00:00.000Z');
  if (!result.changed) throw new Error('Expected the Ready export to expire.');
  return result.job;
}

async function failedExportWithArtifacts(
  access: Awaited<ReturnType<typeof eventAccess>>,
  label: string,
) {
  await uploadPending(access, label, null);
  const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
    method: 'POST', headers: writeHeaders(access.manager), body: '{}',
  }, testEnv);
  const job = (await created.json<any>()).data.export;
  const ready = await processExport(testEnv, job.id, new Date());
  const repository = new ExportsRepository(testEnv.DB);
  const parts = await repository.listParts(job.id);
  const keys = [
    ready!.manifestObjectKey,
    ...parts.map(({ objectKey }) => objectKey),
    ready!.guestbookHtmlObjectKey,
    ready!.guestbookCsvObjectKey,
  ].filter((key): key is string => Boolean(key));
  const terminal = await expireReadyExport(job.id);
  return { job: terminal, keys };
}

function signerFreeEnv() {
  return new Proxy(testEnv, {
    get(target, property, receiver) {
      if (property === 'R2_ACCESS_KEY_ID' || property === 'R2_SECRET_ACCESS_KEY') {
        throw new Error(`Export download read retired signer secret ${String(property)}.`);
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

const ALBUM_SNAPSHOT_SOURCE_AT = '2026-08-23T00:00:00.000Z';

async function setAlbumSnapshotSource(
  access: Awaited<ReturnType<typeof eventAccess>>,
  pickedIds: string[],
  entriesJson: string,
) {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`
      UPDATE media SET
        created_at = ?2,
        stored_at = ?2,
        favorited_at = CASE
        WHEN id IN (SELECT value FROM json_each(?1)) THEN ?2 ELSE NULL END
      WHERE event_id = ?3
    `).bind(JSON.stringify(pickedIds), ALBUM_SNAPSHOT_SOURCE_AT, access.event.id),
    testEnv.DB.prepare(`
      INSERT INTO event_albums (
        event_id, entries, saved_at, revision, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 1, ?3, ?3)
      ON CONFLICT(event_id) DO UPDATE SET
        entries = excluded.entries, saved_at = excluded.saved_at,
        revision = event_albums.revision + 1, updated_at = excluded.updated_at
    `).bind(access.event.id, entriesJson, ALBUM_SNAPSHOT_SOURCE_AT),
  ]);
}

async function seedHistoricalZeroPhotoComplete(
  access: Awaited<ReturnType<typeof eventAccess>>,
  id: string,
  state: 'failed' | 'expired' | 'ready',
) {
  const snapshotAt = '2026-08-10T09:00:00.000Z';
  const createdAt = '2026-08-10T10:00:00.000Z';
  const htmlKey = `events/${access.event.id}/exports/${id}/attempt-1/guestbook.html`;
  const csvKey = `events/${access.event.id}/exports/${id}/attempt-1/guestbook-private.csv`;
  const html = '<!doctype html><title>Historical guestbook</title>';
  const csv = 'entry_type,entry_id\r\n';
  await Promise.all([
    testEnv.MEDIA_BUCKET.put(htmlKey, html),
    testEnv.MEDIA_BUCKET.put(csvKey, csv),
  ]);
  await testEnv.DB.prepare(`
    INSERT INTO export_jobs (
      id, event_id, kind, state, snapshot_at, media_count, total_bytes, attempt,
      error_code, created_at, completed_at, expires_at,
      guestbook_html_object_key, guestbook_html_bytes, guestbook_html_sha256,
      guestbook_csv_object_key, guestbook_csv_bytes, guestbook_csv_sha256,
      guestbook_entry_count, guestbook_shared_count, guestbook_event_name,
      guestbook_event_date, guestbook_event_timezone, guestbook_prompt,
      guestbook_gallery_visible
    ) VALUES (
      ?1, ?2, 'complete', ?3, ?4, 0, 0, 1,
      ?5, ?6, ?7, ?8,
      ?9, ?10, ?11,
      ?12, ?13, ?14,
      0, 0, ?15,
      ?16, ?17, ?18,
      ?19
    )
  `).bind(
    id,
    access.event.id,
    state,
    snapshotAt,
    state === 'ready' ? null : 'EXPORT_FAILED',
    createdAt,
    '2026-08-10T10:05:00.000Z',
    state === 'expired' ? '2026-08-10T11:00:00.000Z' : '2099-08-10T11:00:00.000Z',
    htmlKey,
    new TextEncoder().encode(html).byteLength,
    'a'.repeat(64),
    csvKey,
    new TextEncoder().encode(csv).byteLength,
    'b'.repeat(64),
    access.event.name,
    access.event.eventDate,
    access.event.eventTimezone,
    access.event.guestbookPrompt,
    access.event.galleryVisible ? 1 : 0,
  ).run();
  return { id, htmlKey, csvKey };
}

describe('manager exports', () => {
  beforeEach(resetDatabase);

  it('pauses complete, album, and retry admission without mutation, dispatch, or deletion', async () => {
    await resetDatabaseWithExportProtocolClosed();
    const completeAccess = await eventAccess('Complete release gate');
    await uploadPending(completeAccess, 'release-gate-complete', null);
    const albumAccess = await eventAccess('Album release gate');
    const albumMedia = await uploadPending(albumAccess, 'release-gate-album', null);
    await setAlbumSnapshotSource(
      albumAccess,
      [albumMedia.id],
      JSON.stringify([{ kind: 'photo', mediaId: albumMedia.id }]),
    );
    const retryAccess = await eventAccess('Retry release gate');
    const retryMedia = await uploadPending(retryAccess, 'release-gate-retry', null);
    await seedExportJob({
      id: 'release-gate-retry',
      eventId: retryAccess.event.id,
      snapshotAt: '2026-08-24T00:00:00.000Z',
      createdAt: '2026-08-24T00:01:00.000Z',
      state: 'failed',
      media: [retryMedia],
    });
    const retainedKey = `events/${retryAccess.event.id}/exports/release-gate-retry/attempt-1/manifest.csv`;
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET manifest_object_key = ? WHERE id = 'release-gate-retry'
    `).bind(retainedKey).run();
    await testEnv.MEDIA_BUCKET.put(retainedKey, 'retained');

    const dispatched = vi.fn(async () => []);
    const deleted = vi.fn(testEnv.MEDIA_BUCKET.delete.bind(testEnv.MEDIA_BUCKET));
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch') return dispatched;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
      get(target, property, receiver) {
        if (property === 'delete') return deleted;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const guardedEnv = { ...testEnv, EXPORT_WORKFLOW: workflow, MEDIA_BUCKET: bucket };

    const complete = await createApp().request(
      `/api/manage/events/${completeAccess.event.id}/exports`,
      { method: 'POST', headers: writeHeaders(completeAccess.manager), body: '{}' },
      guardedEnv,
    );
    const album = await createApp().request(
      `/api/manage/events/${albumAccess.event.id}/exports`,
      {
        method: 'POST',
        headers: writeHeaders(albumAccess.manager),
        body: JSON.stringify({ kind: 'album' }),
      },
      guardedEnv,
    );
    const retry = await createApp().request(
      `/api/manage/events/${retryAccess.event.id}/exports/release-gate-retry/retry`,
      { method: 'POST', headers: writeHeaders(retryAccess.manager), body: '{}' },
      guardedEnv,
    );

    for (const response of [complete, album, retry]) {
      expect(response.status).toBe(503);
      expect(await response.json<any>()).toMatchObject({
        code: 'EXPORT_FAILED',
        message: 'Export preparation is temporarily paused for a release. Try again shortly.',
      });
    }
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_jobs
      WHERE event_id IN (?, ?)
    `).bind(completeAccess.event.id, albumAccess.event.id).first<number>('count')).toBe(0);
    expect(await new ExportsRepository(testEnv.DB).getById('release-gate-retry')).toMatchObject({
      state: 'failed',
      attempt: 1,
      manifestObjectKey: retainedKey,
    });
    expect(dispatched).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
    expect(await testEnv.MEDIA_BUCKET.head(retainedKey)).not.toBeNull();
  });

  it('projects only the deterministic latest job per kind with normalized Manager timestamps', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'latest-manager-projection', null);
    await testEnv.DB.prepare(`
      UPDATE media SET created_at = '2026-07-31T09:00:00.000Z',
        stored_at = '2026-07-31T09:00:00.000Z'
      WHERE id = ?
    `).bind(media.id).run();
    await seedExportJob({
      id: 'complete-history-a', eventId: access.event.id,
      snapshotAt: '2026-08-01T09:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
      state: 'failed', media: [media],
    });
    await seedExportJob({
      id: 'album-history-a', eventId: access.event.id,
      snapshotAt: '2026-08-02T09:00:00.000Z', createdAt: '2026-08-03T10:00:00.000Z',
      state: 'failed', kind: 'album', media: [media],
    });
    await seedExportJob({
      id: 'album-history-z', eventId: access.event.id,
      snapshotAt: '2026-08-03T09:00:00.000Z', createdAt: '2026-08-03T10:00:00.000Z',
      state: 'failed', kind: 'album', media: [media],
    });
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET started_at = '2026-08-03T10:05:00.000Z',
        completed_at = '2026-08-03T10:06:00.000Z'
      WHERE id = 'album-history-z'
    `).run();
    const repository = new ExportsRepository(testEnv.DB);
    const complete = await repository.createActive({
      id: 'complete-v2-z', eventId: access.event.id,
      snapshotAt: '2026-08-04T09:00:00.000Z', createdAt: '2026-08-04T10:00:00.000Z',
    });
    const claim = await repository.claimRunning(
      complete.id,
      complete.attempt,
      '2026-08-04T10:05:00.000Z',
    );
    if (claim.status === 'lost') throw new Error('Expected latest complete claim.');
    await repository.markOwnedFailed(
      claim.owner,
      'INTERNAL_PROVIDER_DETAIL',
      '2026-08-04T10:06:00.000Z',
    );

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const exports = (await response.json<any>()).data.exports;

    expect(exports.map(({ id }: { id: string }) => id))
      .toEqual(['complete-v2-z', 'album-history-z']);
    expect(exports[0]).toMatchObject({
      snapshotAt: '2026-08-04T09:00:00.000Z',
      createdAt: '2026-08-04T10:00:00.000Z',
      startedAt: '2026-08-04T10:05:00.000Z',
      completedAt: '2026-08-04T10:06:00.000Z',
      processedMediaCount: 0,
      processedBytes: 0,
      progressUpdatedAt: '2026-08-04T10:05:00.000Z',
      errorCode: 'EXPORT_FAILED',
    });
    expect(exports[1]).toMatchObject({
      createdAt: '2026-08-03T10:00:00.000Z',
      startedAt: '2026-08-03T10:05:00.000Z',
      completedAt: '2026-08-03T10:06:00.000Z',
      processedMediaCount: null,
      processedBytes: null,
      progressUpdatedAt: null,
    });
    expect(await repository.listForEvent(access.event.id)).toHaveLength(4);
  });

  it.each([
    ['EXPORT_SOURCE_MISSING', 'EXPORT_SOURCE_MISSING'],
    ['EXPORT_SOURCE_REMOVED', 'EXPORT_SOURCE_REMOVED'],
    ['EXPORT_EVENT_DELETED', 'EXPORT_EVENT_DELETED'],
    ['EXPORT_GUESTBOOK_SNAPSHOT_INVALID', 'EXPORT_GUESTBOOK_SNAPSHOT_INVALID'],
    ['EXPORT_SNAPSHOT_CHANGED', 'EXPORT_SNAPSHOT_CHANGED'],
    ['EXPORT_WORKFLOW_DISPATCH_FAILED', 'EXPORT_WORKFLOW_DISPATCH_FAILED'],
    ['EXPORT_FAILED', 'EXPORT_FAILED'],
    ['EXPORT_PART_LIMIT_EXCEEDED', 'EXPORT_FAILED'],
    ['provider stack: do not expose', 'EXPORT_FAILED'],
  ] as const)('projects stored export error %s as safe code %s', async (stored, projected) => {
    const access = await eventAccess();
    await seedExportJob({
      id: 'safe-error-job', eventId: access.event.id,
      snapshotAt: '2026-08-01T09:00:00.000Z', state: 'failed',
    });
    await testEnv.DB.prepare('UPDATE export_jobs SET error_code = ? WHERE id = ?')
      .bind(stored, 'safe-error-job').run();

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/safe-error-job`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );

    expect((await response.json<any>()).data.export.errorCode).toBe(projected);
  });

  it('refuses an older hidden retry before mutation, dispatch, or artifact deletion', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'latest-retry-source', null);
    await seedExportJob({
      id: 'older-failed', eventId: access.event.id,
      snapshotAt: '2026-08-01T09:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
      state: 'failed', media: [media],
    });
    await seedExportJob({
      id: 'newer-failed', eventId: access.event.id,
      snapshotAt: '2026-08-02T09:00:00.000Z', createdAt: '2026-08-02T10:00:00.000Z',
      state: 'failed', media: [media],
    });
    const oldKey = `events/${access.event.id}/exports/older-failed/attempt-1/manifest.csv`;
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET manifest_object_key = ?2 WHERE id = ?1
    `).bind('older-failed', oldKey).run();
    await testEnv.MEDIA_BUCKET.put(oldKey, 'older artifact');
    const dispatched = vi.fn(async () => []);
    const deleted = vi.fn(testEnv.MEDIA_BUCKET.delete.bind(testEnv.MEDIA_BUCKET));
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch') return dispatched;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
      get(target, property, receiver) {
        if (property === 'delete') return deleted;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/older-failed/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, EXPORT_WORKFLOW: workflow, MEDIA_BUCKET: bucket },
    );

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      code: 'EXPORT_ALREADY_ACTIVE',
      message: expect.stringMatching(/newer prepared export|refresh/iu),
    });
    expect(await new ExportsRepository(testEnv.DB).getById('older-failed')).toMatchObject({
      state: 'failed', attempt: 1, manifestObjectKey: oldKey,
    });
    expect(dispatched).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
    expect(await testEnv.MEDIA_BUCKET.head(oldKey)).not.toBeNull();
  });

  it('rejects a new notes-only complete export without creating a job or dispatching a Workflow', async () => {
    const access = await eventAccess();
    const guestSessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('note-only', ?, ?, 'Avery', 'A frozen note', 'approved',
        'note-only-key', '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z', NULL)
    `).bind(access.event.id, guestSessionId).run();

    const dispatched = vi.fn(async () => []);
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch') return dispatched;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_jobs WHERE event_id = ?
    `).bind(access.event.id).first<number>('count')).toBe(0);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it.each(['failed', 'expired'] as const)(
    'retries a valid historical zero-photo %s complete export to Ready at 0 / 0',
    async (state) => {
      const access = await eventAccess();
      const seeded = await seedHistoricalZeroPhotoComplete(access, `zero-${state}`, state);

      const listed = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
        headers: { cookie: access.manager.cookie },
      }, testEnv);
      expect((await listed.json<any>()).data.exports).toEqual([
        expect.objectContaining({ id: seeded.id, state, mediaCount: 0, totalBytes: 0 }),
      ]);

      const retried = await createApp().request(
        `/api/manage/events/${access.event.id}/exports/${seeded.id}/retry`,
        { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
        testEnv,
      );
      expect(retried.status).toBe(202);
      expect((await retried.json<any>()).data.export).toMatchObject({
        id: seeded.id, state: 'queued', attempt: 2, mediaCount: 0, totalBytes: 0,
      });
      expect(await testEnv.MEDIA_BUCKET.head(seeded.htmlKey)).toBeNull();
      expect(await testEnv.MEDIA_BUCKET.head(seeded.csvKey)).toBeNull();

      const ready = await processExport(testEnv, seeded.id, new Date('2026-08-12T00:00:00.000Z'));
      expect(ready).toMatchObject({
        state: 'ready', processedMediaCount: 0, processedBytes: 0,
        mediaCount: 0, totalBytes: 0, manifestObjectKey: null, partCount: 0,
      });
      expect(ready?.guestbookHtmlObjectKey).toBeTruthy();
      expect(ready?.guestbookCsvObjectKey).toBeTruthy();
    },
  );

  it('keeps a valid historical Ready zero-photo complete export downloadable', async () => {
    const access = await eventAccess();
    const seeded = await seedHistoricalZeroPhotoComplete(access, 'zero-ready', 'ready');

    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${seeded.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(download.status).toBe(200);
    expect((await download.json<any>()).data).toMatchObject({
      manifest: null,
      parts: [],
      printableGuestbook: { filename: 'guestbook.html' },
      privateGuestbook: { filename: 'guestbook-private.csv' },
    });
  });

  it('rejects an empty snapshot', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
  });

  it('atomically freezes only live album picks, canonical raw order, and deterministic tail positions', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'album-snapshot-first', 'First pick');
    const second = await uploadPending(access, 'album-snapshot-second', 'Second pick');
    const unpickedLegacy = await uploadPending(access, 'album-snapshot-unpicked', 'Unpicked legacy');
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T10:00:00.000Z', first.id),
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T11:00:00.000Z', second.id),
      testEnv.DB.prepare('UPDATE media SET object_key = ? WHERE id = ?')
        .bind(`events/${access.event.id}/media/${unpickedLegacy.id}`, unpickedLegacy.id),
    ]);
    const rawEntries = `[
      { "kind": "section", "id": "section-a", "heading": "Dinner" },
      { "kind": "photo", "mediaId": "${second.id}" },
      { "kind": "photo", "mediaId": "stale-id" },
      { "kind": "photo", "mediaId": "${first.id}" }
    ]`;
    await setAlbumSnapshotSource(access, [first.id, second.id], rawEntries);

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);

    expect(response.status).toBe(202);
    const job = (await response.json<any>()).data.export;
    expect(job).toMatchObject({ kind: 'album', mediaCount: 2, totalBytes: 128 });
    const frozen = await testEnv.DB.prepare(`
      SELECT kind, album_entries_json, guestbook_entry_count, guestbook_event_name
      FROM export_jobs WHERE id = ?
    `).bind(job.id).first<any>();
    expect(frozen).toEqual({
      kind: 'album',
      album_entries_json: JSON.stringify(JSON.parse(rawEntries)),
      guestbook_entry_count: null,
      guestbook_event_name: null,
    });
    expect((await testEnv.DB.prepare(`
      SELECT media_id, album_tail_position FROM export_media_entries
      WHERE export_job_id = ? ORDER BY album_tail_position
    `).bind(job.id).all()).results).toEqual([
      { media_id: first.id, album_tail_position: 1 },
      { media_id: second.id, album_tail_position: 2 },
    ]);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(0);
  });

  it('bounds album membership, bytes, and canonical validation by storage and pick transition times', async () => {
    const access = await eventAccess();
    const included = await uploadPending(access, 'album-boundary-included', null);
    const storedAfter = await uploadPending(access, 'album-boundary-stored-after', null);
    const pickedAfter = await uploadPending(access, 'album-boundary-picked-after', null);
    const boundary = '2026-08-23T12:00:00.000Z';
    await setAlbumSnapshotSource(
      access,
      [included.id, storedAfter.id, pickedAfter.id],
      JSON.stringify([
        { kind: 'photo', mediaId: storedAfter.id },
        { kind: 'photo', mediaId: included.id },
        { kind: 'photo', mediaId: pickedAfter.id },
      ]),
    );
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
          stored_at = '2026-08-23T10:00:00.000Z', favorited_at = '2026-08-23T11:00:00.000Z'
        WHERE id = ?
      `).bind(included.id),
      testEnv.DB.prepare(`
        UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
          stored_at = '2026-08-23T13:00:00.000Z', favorited_at = '2026-08-23T11:00:00.000Z',
          object_key = ?, byte_size = ?
        WHERE id = ?
      `).bind(`events/${access.event.id}/media/${storedAfter.id}`, MAX_EVENT_BYTES + 1, storedAfter.id),
      testEnv.DB.prepare(`
        UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
          stored_at = '2026-08-23T10:00:00.000Z', favorited_at = '2026-08-23T13:00:00.000Z',
          object_key = ?, byte_size = ?
        WHERE id = ?
      `).bind(`events/${access.event.id}/media/${pickedAfter.id}`, MAX_EVENT_BYTES + 1, pickedAfter.id),
    ]);

    const job = await new ExportsRepository(testEnv.DB).createAlbumActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    });

    expect(job).toMatchObject({ kind: 'album', mediaCount: 1, totalBytes: 64 });
    expect((await testEnv.DB.prepare(`
      SELECT media_id FROM export_media_entries WHERE export_job_id = ?
    `).bind(job.id).all()).results).toEqual([{ media_id: included.id }]);
  });

  it('classifies an album with only post-boundary transitions as empty', async () => {
    const access = await eventAccess();
    const after = await uploadPending(access, 'album-boundary-empty', null);
    const boundary = '2026-08-23T12:00:00.000Z';
    await setAlbumSnapshotSource(access, [after.id], '[]');
    await testEnv.DB.prepare(`
      UPDATE media SET created_at = '2026-08-23T09:00:00.000Z',
        stored_at = '2026-08-23T13:00:00.000Z', favorited_at = '2026-08-23T13:00:00.000Z',
        object_key = ?, byte_size = ?
      WHERE id = ?
    `).bind(`events/${access.event.id}/media/${after.id}`, MAX_EVENT_BYTES + 1, after.id).run();

    await expect(new ExportsRepository(testEnv.DB).createAlbumActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    })).rejects.toMatchObject({ code: 'EXPORT_EMPTY' });
  });

  it('freezes malformed and non-array historical album order as canonical empty order', async () => {
    for (const [index, raw] of ['{', '{"kind":"photo"}'].entries()) {
      const access = await eventAccess();
      const picked = await uploadPending(access, `album-malformed-order-${index}`, null);
      await setAlbumSnapshotSource(access, [picked.id], '[]');
      await testEnv.DB.prepare('PRAGMA ignore_check_constraints = ON').run();
      await testEnv.DB.prepare('UPDATE event_albums SET entries = ? WHERE event_id = ?')
        .bind(raw, access.event.id).run();
      await testEnv.DB.prepare('PRAGMA ignore_check_constraints = OFF').run();

      const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
        method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
      }, testEnv);

      expect(response.status).toBe(202);
      const job = (await response.json<any>()).data.export;
      expect(await testEnv.DB.prepare('SELECT album_entries_json FROM export_jobs WHERE id = ?')
        .bind(job.id).first<string>('album_entries_json')).toBe('[]');
      expect((await testEnv.DB.prepare(`
        SELECT media_id, album_tail_position FROM export_media_entries WHERE export_job_id = ?
      `).bind(job.id).all()).results).toEqual([
        { media_id: picked.id, album_tail_position: 1 },
      ]);
    }
  });

  it('refuses an empty album even when the event has complete-export content', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'album-empty-unpicked', 'Still delivered');
    await setAlbumSnapshotSource(access, [], '[]');

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<number>('count')).toBe(0);
  });

  it('rolls back the album job and its frozen order when picked-row insertion fails', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-snapshot-rollback', null);
    await setAlbumSnapshotSource(
      access,
      [picked.id],
      JSON.stringify([{ kind: 'photo', mediaId: picked.id }]),
    );
    await testEnv.DB.prepare(`
      CREATE TRIGGER fail_album_media_snapshot BEFORE INSERT ON export_media_entries
      BEGIN SELECT RAISE(ABORT, 'album snapshot insert failed'); END
    `).run();

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);

    expect(response.status).toBe(500);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_media_entries')
      .first<number>('count')).toBe(0);
  });

  it('rejects unknown export selectors and preserves the empty-object complete contract', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'complete-empty-object', null);
    const invalid = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ kind: 'complete', extra: true }),
    }, testEnv);
    expect(invalid.status).toBe(422);

    const complete = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(complete.status).toBe(202);
    expect((await complete.json<any>()).data.export).toMatchObject({ kind: 'complete' });
    expect(await testEnv.DB.prepare('SELECT album_entries_json FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<string | null>('album_entries_json')).toBeNull();
  });

  it('lists equal-time exports newest-first with a stable ID tie-breaker', async () => {
    const access = await eventAccess();
    const createdAt = '2026-08-23T12:00:00.000Z';
    // Both jobs are seeded terminal: only one job per event may be queued or
    // running at a time, and the ordering under test is over the whole history.
    for (const id of ['export-a', 'export-b']) {
      await seedExportJob({
        id, eventId: access.event.id, snapshotAt: createdAt, createdAt, state: 'failed',
      });
    }

    expect((await new ExportsRepository(testEnv.DB).listForEvent(access.event.id)).map(({ id }) => id))
      .toEqual(['export-b', 'export-a']);
  });

  it('refuses a legacy writable photo before creating or dispatching an export', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'legacy-writable-export', 'Legacy photo');
    await testEnv.DB.prepare('UPDATE media SET object_key = ? WHERE id = ?')
      .bind(`events/${access.event.id}/media/${media.id}`, media.id).run();
    let dispatches = 0;
    const guardedEnv = Object.create(testEnv) as typeof testEnv;
    Object.defineProperty(guardedEnv, 'EXPORT_WORKFLOW', {
      value: {
        async create() {
          dispatches += 1;
          return { id: 'unexpected-export-workflow' };
        },
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, guardedEnv);

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({
      code: 'EXPORT_MEDIA_UPGRADE_REQUIRED',
      message: 'Some photos need a storage upgrade before they can be exported. Try again after the upgrade is complete.',
    });
    expect(dispatches).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_jobs WHERE event_id = ?')
      .bind(access.event.id).first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_media_entries')
      .first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM export_guestbook_entries')
      .first<number>('count')).toBe(0);
  });

  it('discriminates active and oversized snapshots without leaving partial jobs', async () => {
    const activeAccess = await eventAccess();
    await uploadPending(activeAccess, 'active-export', null);
    const first = await createApp().request(`/api/manage/events/${activeAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(activeAccess.manager), body: '{}',
    }, testEnv);
    const second = await createApp().request(`/api/manage/events/${activeAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(activeAccess.manager), body: '{}',
    }, testEnv);
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect((await second.json<any>()).code).toBe('EXPORT_ALREADY_ACTIVE');

    const oversizedAccess = await eventAccess();
    const media = await uploadPending(oversizedAccess, 'oversized-export', 'Too large');
    await testEnv.DB.prepare('UPDATE media SET byte_size = ? WHERE id = ?')
      .bind(MAX_EVENT_BYTES + 1, media.id).run();
    const oversized = await createApp().request(`/api/manage/events/${oversizedAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(oversizedAccess.manager), body: '{}',
    }, testEnv);
    expect(oversized.status).toBe(409);
    expect((await oversized.json<any>()).code).toBe('EXPORT_LIMIT_EXCEEDED');
    expect(await testEnv.DB.prepare(`SELECT count(*) AS count FROM export_jobs WHERE event_id = ?`)
      .bind(oversizedAccess.event.id).first<number>('count')).toBe(0);
  });

  it('rolls back the queued job when immutable entry insertion fails', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'rollback-photo', null);
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('rollback-note', ?, ?, 'Avery', 'Rollback me', 'approved',
        'rollback-note-key', '2026-08-12T12:00:00.000Z', '2026-08-12T12:00:00.000Z', NULL)
    `).bind(access.event.id, sessionId).run();
    await testEnv.DB.prepare(`
      CREATE TRIGGER fail_guestbook_snapshot BEFORE INSERT ON export_guestbook_entries
      BEGIN SELECT RAISE(ABORT, 'snapshot insert failed'); END
    `).run();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(500);
    expect(await testEnv.DB.prepare(`SELECT count(*) AS count FROM export_jobs WHERE event_id = ?`)
      .bind(access.event.id).first<number>('count')).toBe(0);
    expect(await testEnv.DB.prepare(`SELECT count(*) AS count FROM export_guestbook_entries`)
      .first<number>('count')).toBe(0);
  });

  it('preserves more than 1,000 legacy notes without truncating the private snapshot', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'legacy-note-snapshot-photo', null);
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      WITH RECURSIVE notes(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM notes WHERE n < 1001
      )
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) SELECT printf('legacy-note-%04d', n), ?, ?, 'Legacy', printf('Note %d', n),
        CASE WHEN n % 2 = 0 THEN 'approved' ELSE 'pending' END,
        printf('legacy-key-%04d', n), '2026-08-12T12:00:00.000Z',
        CASE WHEN n % 2 = 0 THEN '2026-08-12T12:00:00.000Z' ELSE NULL END, NULL
      FROM notes
    `).bind(access.event.id, sessionId).run();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(202);
    const job = (await response.json<any>()).data.export;
    expect(job.guestbookEntryCount).toBe(1001);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(1001);
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(1);
  });

  it('exports unpublished originals in bounded parts with a manifest and manager-only URLs', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'exportable-a', 'Sunset toast');
    await uploadPending(access, 'exportable-b', 'Dance floor');

    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(created.status).toBe(202);
    const job = (await created.json<any>()).data.export;
    // Completion is dated from the clock the run actually sees. A literal here silently rots: the
    // download route refuses a job whose retention window has already elapsed, so a fixed date turns
    // this into a 409 the moment real time passes it.
    await processExport(testEnv, job.id, new Date(), 100);

    const status = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await status.json<any>()).data.export.state).toBe('ready');
    const repository = new ExportsRepository(testEnv.DB);
    const ready = await repository.getById(job.id);
    const parts = await repository.listParts(job.id);
    expect(ready).toMatchObject({ partCount: 2 });
    expect(parts.map(({ partNumber, mediaCount, sourceBytes }) => ({ partNumber, mediaCount, sourceBytes }))).toEqual([
      { partNumber: 1, mediaCount: 1, sourceBytes: 64 },
      { partNumber: 2, mediaCount: 1, sourceBytes: 64 },
    ]);
    const firstObject = await testEnv.MEDIA_BUCKET.get(parts[0]!.objectKey);
    const firstArchive = unzipSync(new Uint8Array(await firstObject!.arrayBuffer()));
    expect(Object.keys(firstArchive)).toEqual(['photos/001-exportable-a.png', 'media.csv']);
    expect(strFromU8(firstArchive['media.csv']!)).toContain('unpublished');
    const manifestObject = await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!);
    const manifest = await manifestObject!.text();
    expect(manifest).toContain('photos-001.zip');
    expect(manifest).toContain('photos-002.zip');
    expect(manifest).toContain('Sunset toast');
    expect(ready!.guestbookHtmlObjectKey).toContain('/attempt-1/guestbook.html');
    expect(ready!.guestbookCsvObjectKey).toContain('/attempt-1/guestbook-private.csv');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!))!.text())
      .toContain('No guestbook entries were shared at this snapshot.');

    const env = signerFreeEnv();
    const download = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, env);
    expect(download.status).toBe(200);
    const downloadData = (await download.json<any>()).data;
    expect(downloadData.manifest.url).toContain('/artifact/manifest');
    expect(downloadData.parts).toHaveLength(2);
    expect(downloadData.parts.every((part: any) => part.url.includes('/artifact/part/'))).toBe(true);
    expect(downloadData.printableGuestbook.filename).toBe('guestbook.html');
    expect(downloadData.privateGuestbook.filename).toBe('guestbook-private.csv');

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.guest), body: '{}',
    }, env);
    expect(denied.status).toBe(403);

    const artifact = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=0-9' },
    }, testEnv);
    expect(artifact.status).toBe(206);
    expect(artifact.headers.get('content-range')).toMatch(/^bytes 0-9\//u);
    expect(artifact.headers.get('content-length')).toBe('10');
    expect(artifact.headers.get('content-disposition')).toContain('attachment');
    expect(artifact.headers.get('cache-control')).toBe('private, no-store');
    expect(artifact.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await artifact.arrayBuffer()).byteLength).toBe(10);

    const suffix = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=-8' },
    }, testEnv);
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(8);

    const artifactDenied = await createApp().request(downloadData.parts[0].url, {}, testEnv);
    expect(artifactDenied.status).toBe(401);
    const unsatisfiable = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=999999999-' },
    }, testEnv);
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toMatch(/^bytes \*\//u);

    const other = await eventAccess();
    const crossEvent = await createApp().request(downloadData.manifest.url, {
      headers: { cookie: other.manager.cookie },
    }, env);
    expect(crossEvent.status).toBe(403);

    await testEnv.MEDIA_BUCKET.delete(ready!.manifestObjectKey!);
    const missing = await createApp().request(downloadData.manifest.url, {
      headers: { cookie: access.manager.cookie },
    }, env);
    expect(missing.status).toBe(409);
    expect(await missing.json<any>()).toMatchObject({ code: 'EXPORT_FAILED' });
  });

  it('does not stream changed export bytes after the conditional metadata read', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'conditional-export', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    const url = (await download.json<any>()).data.manifest.url as string;
    let replaced = false;
    const changingBucket = new Proxy(testEnv.MEDIA_BUCKET, {
      get(target, property) {
        if (property === 'get') {
          return async (...args: Parameters<R2Bucket['get']>) => {
            if (!replaced) {
              replaced = true;
              await target.put(ready!.manifestObjectKey!, 'changed-after-head');
            }
            return target.get(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(url, {
      headers: { cookie: access.manager.cookie },
    }, { ...testEnv, MEDIA_BUCKET: changingBucket });

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({ code: 'EXPORT_FAILED' });
  });

  it('uses an attempt-specific object key when retrying a failed job', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'attempt-specific-key', null);
    const jobId = crypto.randomUUID();
    // The seeded job carries the real row it froze, so retry can prove the source
    // is still there before it reacquires the hold.
    await seedExportJob({
      id: jobId, eventId: access.event.id, snapshotAt: '2026-07-21T12:00:00.000Z',
      createdAt: '2026-07-21T12:00:00.000Z', state: 'failed', media: [media],
    });
    const retry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${jobId}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(retry.status).toBe(202);
    expect((await retry.json<any>()).data.export.attempt).toBe(2);
  });

  it('keeps a found initial Workflow with unknown status on its one deterministic instance ID', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-failure', null);
    const createdRequests: Array<{ id: string; params: { jobId: string; attempt: number } }> = [];
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async (batch: typeof createdRequests) => {
            createdRequests.push(batch[0]!);
            throw new Error('simulated lost initial Workflow creation response');
          };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'unknown' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    const [job] = await new ExportsRepository(testEnv.DB).listForEvent(access.event.id);
    expect(job).toMatchObject({ state: 'queued', attempt: 1, errorCode: null });
    expect(createdRequests).toEqual([{
      id: job!.id,
      params: { jobId: job!.id, attempt: 1 },
    }]);
  });

  it.each(['errored', 'terminated'] as const)(
    'durably fails a pristine initial job whose only Workflow instance is %s before claim',
    async (terminal) => {
      const access = await eventAccess();
      await uploadPending(access, `initial-workflow-${terminal}`, null);
      const createdRequests: Array<{ id: string; params: { jobId: string; attempt: number } }> = [];
      const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
        get(target, property, receiver) {
          if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
          if (property === 'createBatch') {
            return async (batch: typeof createdRequests) => {
              createdRequests.push(batch[0]!);
              throw new Error('simulated lost terminal Workflow response');
            };
          }
          if (property === 'get') {
            return async (id: string) => ({ id, status: async () => ({ status: terminal }) });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
        method: 'POST', headers: writeHeaders(access.manager), body: '{}',
      }, { ...testEnv, EXPORT_WORKFLOW: workflow });

      expect(response.status).toBe(202);
      const body = await response.json<any>();
      expect(body.data.export).toMatchObject({ state: 'failed', attempt: 1 });
      const job = await new ExportsRepository(testEnv.DB).getById(body.data.export.id);
      expect(job).toMatchObject({
        state: 'failed', attempt: 1, errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED',
      });
      expect(createdRequests).toEqual([{
        id: job!.id,
        params: { jobId: job!.id, attempt: 1 },
      }]);
      expect((await testEnv.DB.prepare(`
        SELECT count(*) AS count FROM export_parts WHERE export_job_id = ?
      `).bind(job!.id).first<number>('count'))).toBe(0);
    },
  );

  it.each(['get', 'status'] as const)(
    'replays idempotent creation on the same initial ID after an unobservable %s outcome',
    async (unobservable) => {
      const access = await eventAccess();
      await uploadPending(access, `initial-workflow-unobservable-${unobservable}`, null);
      const createdRequests: Array<{ id: string; params: { jobId: string; attempt: number } }> = [];
      const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
        get(target, property, receiver) {
          if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
          if (property === 'createBatch') {
            return async (batch: typeof createdRequests) => {
              createdRequests.push(batch[0]!);
              if (createdRequests.length === 1) throw new Error('simulated unobservable createBatch result');
            };
          }
          if (property === 'get') {
            if (unobservable === 'get') {
              return async () => { throw new Error('simulated unobservable Workflow lookup'); };
            }
            return async (id: string) => ({
              id,
              status: async () => { throw new Error('simulated unobservable Workflow status'); },
            });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
        method: 'POST', headers: writeHeaders(access.manager), body: '{}',
      }, { ...testEnv, EXPORT_WORKFLOW: workflow });

      expect(response.status).toBe(202);
      const job = (await response.json<any>()).data.export;
      expect(job).toMatchObject({ state: 'queued', attempt: 1 });
      expect(createdRequests).toEqual([
        { id: job.id, params: { jobId: job.id, attempt: 1 } },
        { id: job.id, params: { jobId: job.id, attempt: 1 } },
      ]);
      expect((await new ExportsRepository(testEnv.DB).listForEvent(access.event.id))).toHaveLength(1);
      expect((await testEnv.DB.prepare(`
        SELECT count(*) AS count FROM export_parts WHERE export_job_id = ?
      `).bind(job.id).first<number>('count'))).toBe(0);
    },
  );

  it('fails a still-unobservable initial dispatch after replay so its snapshot can be retried', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-unobservable-replay', null);
    const createdIds: string[] = [];
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async (batch: Array<{ id: string }>) => {
            createdIds.push(batch[0]!.id);
            throw new Error('simulated unobservable Workflow creation');
          };
        }
        if (property === 'get') {
          return async () => { throw new Error('simulated unavailable Workflow lookup'); };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    const failed = (await response.json<any>()).data.export;
    expect(failed).toMatchObject({ state: 'failed', attempt: 1 });
    expect(await new ExportsRepository(testEnv.DB).getById(failed.id)).toMatchObject({
      state: 'failed', attempt: 1, errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED',
    });
    expect(createdIds).toEqual([failed.id, failed.id]);

    const retried = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${failed.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    expect((await retried.json<any>()).data.export).toMatchObject({
      state: 'queued', attempt: 2,
    });
    expect((await new ExportsRepository(testEnv.DB).listForEvent(access.event.id))).toHaveLength(1);
  });

  it('retries a terminal-before-claim initial job without duplicating its frozen snapshot', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-terminal-retry', null);
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async () => { throw new Error('simulated terminal initial Workflow'); };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'errored' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const initial = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });
    const failed = (await initial.json<any>()).data.export;
    const frozenBefore = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(failed.id).first<number>('count');

    const retry = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${failed.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(retry.status).toBe(202);
    expect((await retry.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(failed.id).first<number>('count')).toBe(frozenBefore);
  });

  it('adopts an initial Workflow whose creation response was lost', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-response-loss', null);
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async () => { throw new Error('simulated lost initial Workflow response'); };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'queued' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 1 });
  });

  it('does not overwrite an initial job that crossed from pristine queued to running', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'initial-workflow-running-race', null);
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'create') return async () => { throw new Error('non-idempotent create used'); };
        if (property === 'createBatch') {
          return async (batch: Array<{ id: string; params: { attempt: number } }>) => {
            const { id, params } = batch[0]!;
            await new ExportsRepository(testEnv.DB).claimRunning(
              id,
              params.attempt,
              '2026-08-23T12:00:01.000Z',
            );
            throw new Error('simulated lost initial Workflow response after claim');
          };
        }
        if (property === 'get') {
          return async (id: string) => ({ id, status: async () => ({ status: 'unknown' }) });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, { ...testEnv, EXPORT_WORKFLOW: workflow });

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'running', attempt: 1 });
  });

  it('keeps prior-attempt objects when the retry transition fails before commit', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-before-commit');
    const failingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') return async () => { throw new Error('simulated retry failure'); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, DB: failingDb },
    );

    expect(response.status).toBe(500);
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({ state: 'expired' });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('recovers the exact retry transition after its committed D1 response is lost', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-response-loss');
    let lost = false;
    const responseLossDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!lost) {
              lost = true;
              throw new Error('simulated lost retry response');
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, DB: responseLossDb },
    );

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('rediscovers an unrecorded current-attempt object before dispatching its retry', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'retry-lost-r2-response', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await failPristineExport(job.id);
    const orphan = `events/${access.event.id}/exports/${job.id}/attempt-1/lost-response.zip`;
    await testEnv.MEDIA_BUCKET.put(orphan, 'committed before the response was lost');

    const retried = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(retried.status).toBe(202);
    expect((await retried.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    expect(await testEnv.MEDIA_BUCKET.head(orphan)).toBeNull();
  });

  it('redrives a queued retry only after prior-attempt deletion succeeds', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-delete-redrive');
    let deleteAttempts = 0;
    const deletePriorAttempt = vi.fn(async (input: string | string[]) => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) throw new Error('simulated prior-attempt delete failure');
      return testEnv.MEDIA_BUCKET.delete(input);
    });
    const dispatched = vi.fn(async () => []);
    const bucket = new Proxy(testEnv.MEDIA_BUCKET, {
      get(target, property, receiver) {
        if (property === 'delete') return deletePriorAttempt;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch') return dispatched;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const retryEnv = { ...testEnv, MEDIA_BUCKET: bucket, EXPORT_WORKFLOW: workflow };
    const retry = () => createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      retryEnv,
    );

    const failedCleanup = await retry();
    expect(failedCleanup.status).toBe(500);
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
      state: 'queued', attempt: 2,
    });
    expect(dispatched).not.toHaveBeenCalled();
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();

    const recovered = await retry();
    expect(recovered.status).toBe(202);
    expect((await recovered.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    expect(dispatched).toHaveBeenCalledTimes(1);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('cleans prior-attempt objects before a failed Workflow creation, then redrives the queued retry', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-workflow-failure');
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch' || property === 'create') {
          return async () => { throw new Error('simulated Workflow creation failure'); };
        }
        if (property === 'get') {
          return async (id: string) => ({
            id,
            status: async () => ({ status: 'unknown' }),
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, EXPORT_WORKFLOW: workflow },
    );

    expect(response.status).toBe(500);
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
      state: 'queued', attempt: 2,
    });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();

    const recovered = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(recovered.status).toBe(202);
    expect((await recovered.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('adopts the deterministic retry Workflow after its creation response is lost', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-workflow-response-loss');
    let created = false;
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch' || property === 'create') {
          return async () => {
            if (created) throw new Error('simulated duplicate Workflow instance');
            created = true;
            throw new Error('simulated lost Workflow creation response');
          };
        }
        if (property === 'get') {
          return async (id: string) => ({
            id,
            status: async () => ({ status: created ? 'queued' : 'unknown' }),
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, EXPORT_WORKFLOW: workflow },
    );
    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it.each(['errored', 'terminated', 'complete'] as const)(
    'fails a terminal retry Workflow in %s state and advances the next retry',
    async (terminal) => {
      const access = await eventAccess();
      const { job } = await failedExportWithArtifacts(access, `retry-workflow-${terminal}`);
      const createdRequests: Array<{ id: string; params: { jobId: string; attempt: number } }> = [];
      const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
        get(target, property, receiver) {
          if (property === 'createBatch') {
            return async (batch: typeof createdRequests) => {
              createdRequests.push(batch[0]!);
              throw new Error(`simulated retained ${terminal} retry Workflow`);
            };
          }
          if (property === 'get') {
            return async (id: string) => ({ id, status: async () => ({ status: terminal }) });
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      const response = await createApp().request(
        `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
        { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
        { ...testEnv, EXPORT_WORKFLOW: workflow },
      );

      expect(response.status).toBe(202);
      const failed = (await response.json<any>()).data.export;
      expect(createdRequests).toEqual([{
        id: `${job.id}-2`,
        params: { jobId: job.id, attempt: 2 },
      }]);
      expect(failed).toMatchObject({
        id: job.id,
        state: 'failed',
        attempt: 2,
      });
      expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
        state: 'failed',
        attempt: 2,
        errorCode: 'EXPORT_WORKFLOW_DISPATCH_FAILED',
      });
      expect(await testEnv.DB.prepare(`
        SELECT count(*) AS count FROM export_parts WHERE export_job_id = ?
      `).bind(job.id).first<number>('count')).toBe(0);

      const next = await createApp().request(
        `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
        { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
        testEnv,
      );
      expect(next.status).toBe(202);
      expect((await next.json<any>()).data.export).toMatchObject({
        state: 'queued',
        attempt: 3,
      });
    },
  );

  it('keeps the running attempt when the retry claim wins the terminal dispatch failure fence', async () => {
    const access = await eventAccess();
    const { job } = await failedExportWithArtifacts(access, 'retry-workflow-claim-race');
    const workflow = new Proxy(testEnv.EXPORT_WORKFLOW, {
      get(target, property, receiver) {
        if (property === 'createBatch') {
          return async () => { throw new Error('simulated lost retry Workflow response'); };
        }
        if (property === 'get') {
          return async (id: string) => ({
            id,
            status: async () => {
              await new ExportsRepository(testEnv.DB).claimRunning(
                job.id,
                2,
                '2026-08-23T12:00:01.000Z',
              );
              return { status: 'errored' };
            },
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      { ...testEnv, EXPORT_WORKFLOW: workflow },
    );

    expect(response.status).toBe(202);
    expect((await response.json<any>()).data.export).toMatchObject({
      id: job.id,
      state: 'running',
      attempt: 2,
    });
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
      state: 'running',
      attempt: 2,
      errorCode: null,
    });
  });

  it('converges concurrent failed-job retries on one deterministic next attempt', async () => {
    const access = await eventAccess();
    const { job, keys } = await failedExportWithArtifacts(access, 'retry-concurrent');
    let waiting = 0;
    let release!: () => void;
    const bothAtTransition = new Promise<void>((resolve) => { release = resolve; });
    const synchronizedDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            waiting += 1;
            if (waiting === 2) release();
            await bothAtTransition;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = { ...testEnv, DB: synchronizedDb };
    const request = () => createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      env,
    );

    const responses = await Promise.all([request(), request()]);

    expect(responses.map(({ status }) => status)).toEqual([202, 202]);
    expect(await Promise.all(responses.map(async (response) => (
      (await response.json<any>()).data.export.attempt
    )))).toEqual([2, 2]);
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({
      state: 'queued', attempt: 2,
    });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
  });

  it('builds part bytes and source-size inventory from the immutable finalized object, not a replayed upload key', async () => {
    const access = await eventAccess();
    const original = png(1600, 900, 64);
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'immutable-export.png', mimeType: 'image/png', byteSize: original.byteLength,
        idempotencyKey: 'immutable-export', guestName: 'Avery', caption: null,
      }),
    }, testEnv);
    const reserved = (await initiated.json<any>()).data.media;
    // The reservation response is an allowlist of id, MIME, and state, so the
    // key the browser wrote to comes from the durable row while it still holds
    // it — after the commit that column names the immutable finalized object.
    const reservationObjectKey = await testEnv.DB.prepare('SELECT object_key FROM media WHERE id = ?')
      .bind(reserved.id).first<string>('object_key');
    const finalized = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${reserved.id}/content`,
      {
        method: 'PUT',
        headers: {
          ...writeHeaders(access.guest),
          'content-type': 'image/png',
          'content-length': String(original.byteLength),
        },
        body: original.buffer.slice(
          original.byteOffset,
          original.byteOffset + original.byteLength,
        ) as ArrayBuffer,
      },
      testEnv,
    );
    expect(finalized.status).toBe(200);
    const storedObjectKey = await testEnv.DB.prepare('SELECT object_key FROM media WHERE id = ?')
      .bind(reserved.id).first<string>('object_key');
    expect(storedObjectKey).not.toBe(reservationObjectKey);

    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.MEDIA_BUCKET.put(reservationObjectKey!, png(320, 240, 96), {
      httpMetadata: { contentType: 'image/png' },
    });
    const ready = await processExport(testEnv, job.id, new Date());
    const parts = await new ExportsRepository(testEnv.DB).listParts(job.id);
    const archiveObject = await testEnv.MEDIA_BUCKET.get(parts[0]!.objectKey);
    const archive = unzipSync(new Uint8Array(await archiveObject!.arrayBuffer()));
    const photo = archive['photos/001-immutable-export.png'];

    expect(ready?.state).toBe('ready');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.sourceBytes).toBe(original.byteLength);
    expect(photo).toEqual(original);
    expect(photo?.byteLength).toBe(parts[0]!.sourceBytes);
  });

  it('preserves frozen album order across parts and retries without live album or favorite reads', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'album-ordered-first', 'First by timeline');
    const second = await uploadPending(access, 'album-ordered-second', 'Second by timeline');
    const third = await uploadPending(access, 'album-ordered-third', 'Placed first');
    await testEnv.DB.batch([
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T10:00:00.000Z', first.id),
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T11:00:00.000Z', second.id),
      testEnv.DB.prepare('UPDATE media SET timeline_at = ? WHERE id = ?')
        .bind('2026-08-23T12:00:00.000Z', third.id),
    ]);
    await setAlbumSnapshotSource(access, [first.id, second.id, third.id], JSON.stringify([
      { kind: 'section', id: 'section-a', heading: 'Placed photos' },
      { kind: 'photo', mediaId: third.id },
      { kind: 'photo', mediaId: first.id },
    ]));
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);
    expect(created.status).toBe(202);
    const job = (await created.json<any>()).data.export;
    expect(job).toMatchObject({ kind: 'album', mediaCount: 3 });

    // Every live source changes before the Workflow reads. An implementation that re-opens
    // event_albums or favorited_at will now export only the wrong photo in the wrong order.
    await setAlbumSnapshotSource(
      access,
      [second.id],
      JSON.stringify([{ kind: 'photo', mediaId: second.id }]),
    );
    const runAt = new Date();
    const ready = await processExport(testEnv, job.id, runAt, 100);
    expect(ready).toMatchObject({
      kind: 'album', state: 'ready', partCount: 3,
      guestbookHtmlObjectKey: null, guestbookCsvObjectKey: null,
      guestbookEntryCount: null,
    });
    expect(Date.parse(ready!.expiresAt!) - runAt.getTime()).toBe(86_400_000);
    const repository = new ExportsRepository(testEnv.DB);
    const firstParts = await repository.listParts(job.id);
    const archivedNames: string[] = [];
    for (const part of firstParts) {
      const object = await testEnv.MEDIA_BUCKET.get(part.objectKey);
      const archive = unzipSync(new Uint8Array(await object!.arrayBuffer()));
      archivedNames.push(Object.keys(archive).find((name) => name.startsWith('photos/'))!);
    }
    expect(archivedNames).toEqual([
      'photos/001-album-ordered-third.png',
      'photos/001-album-ordered-first.png',
      'photos/001-album-ordered-second.png',
    ]);
    const firstManifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect([...firstManifest.matchAll(/,(album-ordered-(?:third|first|second)\.png),/gu)]
      .map((match) => match[1])).toEqual([
      'album-ordered-third.png', 'album-ordered-first.png', 'album-ordered-second.png',
    ]);

    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(download.status).toBe(200);
    const descriptors = (await download.json<any>()).data;
    expect(descriptors).toMatchObject({ printableGuestbook: null, privateGuestbook: null });
    expect(descriptors.parts).toHaveLength(3);
    const range = await createApp().request(descriptors.parts[1].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=0-7' },
    }, testEnv);
    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(8);

    await expireReadyExport(job.id);
    const retried = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    await setAlbumSnapshotSource(
      access,
      [first.id, third.id],
      JSON.stringify([{ kind: 'photo', mediaId: first.id }]),
    );
    const retryReady = await processExport(testEnv, job.id, new Date(), 100);
    const retryManifest = await (await testEnv.MEDIA_BUCKET.get(retryReady!.manifestObjectKey!))!.text();
    expect(retryManifest).toBe(firstManifest);
    expect(retryReady).toMatchObject({
      kind: 'album', attempt: 2, guestbookHtmlObjectKey: null, guestbookCsvObjectKey: null,
    });
  });

  it('enforces one queued or running export across kinds and refuses a conflicting retry cleanly', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-active-conflict', null);
    await setAlbumSnapshotSource(
      access,
      [picked.id],
      JSON.stringify([{ kind: 'photo', mediaId: picked.id }]),
    );
    const album = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: JSON.stringify({ kind: 'album' }),
    }, testEnv);
    expect(album.status).toBe(202);
    const albumJob = (await album.json<any>()).data.export;
    const completeConflict = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(completeConflict.status).toBe(409);
    expect((await completeConflict.json<any>()).code).toBe('EXPORT_ALREADY_ACTIVE');

    await failPristineExport(albumJob.id);
    const complete = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(complete.status).toBe(202);
    expect((await complete.json<any>()).data.export.kind).toBe('complete');

    const retryConflict = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${albumJob.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retryConflict.status).toBe(409);
    expect((await retryConflict.json<any>()).code).toBe('EXPORT_ALREADY_ACTIVE');
    expect(await new ExportsRepository(testEnv.DB).getById(albumJob.id)).toMatchObject({
      kind: 'album', state: 'failed', attempt: 1,
    });
  });

  it('keeps the cross-kind create conflict cause when the winner turns terminal after the batch', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-create-conflict-race', null);
    await setAlbumSnapshotSource(access, [picked.id], '[]');
    const boundary = '2026-08-23T12:00:00.000Z';
    const winnerId = 'complete-create-winner';
    // The winning job holds the real frozen row, because a queued job that froze
    // nothing is no longer a shape this schema will accept.
    await seedExportJob({
      id: winnerId, eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
      media: [picked],
    });
    let transitioned = false;
    const terminalAfterBatch = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (!transitioned) {
              transitioned = true;
              await target.prepare(`
                UPDATE export_jobs
                SET state = 'failed', execution_transition = execution_transition + 1
                WHERE id = ?
              `)
                .bind(winnerId).run();
            }
            return results;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(new ExportsRepository(terminalAfterBatch).createAlbumActive({
      id: 'album-create-loser', eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    })).rejects.toMatchObject({
      code: 'EXPORT_ALREADY_ACTIVE',
      message: 'An export is already being prepared for this event.',
    });
  });

  it('keeps the cross-kind retry conflict cause when the winner turns terminal after the batch', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-retry-conflict-race', null);
    await setAlbumSnapshotSource(access, [picked.id], '[]');
    const repository = new ExportsRepository(testEnv.DB);
    const boundary = '2026-08-23T12:00:00.000Z';
    const candidate = await repository.createAlbumActive({
      id: 'album-retry-candidate', eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    });
    await failPristineExport(candidate.id);
    const winnerId = 'complete-retry-winner';
    // The winning job holds the real frozen row, because a queued job that froze
    // nothing is no longer a shape this schema will accept.
    await seedExportJob({
      id: winnerId, eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
      media: [picked],
    });
    let transitioned = false;
    const terminalAfterBatch = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (!transitioned) {
              transitioned = true;
              await target.prepare(`
                UPDATE export_jobs
                SET state = 'failed', execution_transition = execution_transition + 1
                WHERE id = ?
              `)
                .bind(winnerId).run();
            }
            return results;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(new ExportsRepository(terminalAfterBatch).retry(candidate.id)).rejects.toMatchObject({
      code: 'EXPORT_ALREADY_ACTIVE',
      message: 'An export is already being prepared for this event.',
    });
  });

  it('returns only the Manager export allowlist from create, get, list, and retry', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'safe-manager-export', 'Visible caption');
    const app = createApp();
    const created = await app.request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const createdJob = (await created.json<any>()).data.export;
    expectManagerExport(createdJob);
    expect(createdJob.kind).toBe('complete');

    const fetched = await app.request(
      `/api/manage/events/${access.event.id}/exports/${createdJob.id}`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expectManagerExport((await fetched.json<any>()).data.export);

    const listed = await app.request(`/api/manage/events/${access.event.id}/exports`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const listedJobs = (await listed.json<any>()).data.exports;
    expect(listedJobs).toHaveLength(1);
    expectManagerExport(listedJobs[0]);

    await failPristineExport(createdJob.id, 'EXPORT_SOURCE_MISSING');
    const retried = await app.request(
      `/api/manage/events/${access.event.id}/exports/${createdJob.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    expectManagerExport((await retried.json<any>()).data.export);
  });

  it('cleans every object from repeated failed attempts and keeps deterministic prefixes', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'failure-cleanup-a', null);
    const missing = await uploadPending(access, 'failure-cleanup-b', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    expect((await testEnv.DB.prepare(`
      SELECT media_id, original_filename FROM export_media_entries
      WHERE export_job_id = ? ORDER BY created_at, media_id
    `).bind(job.id).all()).results).toHaveLength(2);
    await testEnv.CANONICAL_MEDIA_BUCKET.delete(missing.objectKey);

    const firstFailure = await processExport(testEnv, job.id, new Date(), 100);
    expect(firstFailure).toMatchObject({ state: 'failed', errorCode: 'EXPORT_SOURCE_MISSING' });
    expect((await testEnv.MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/exports/${job.id}/attempt-1/`,
    })).objects).toEqual([]);
    const retry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect((await retry.json<any>()).data.export.attempt).toBe(2);
    const secondFailure = await processExport(testEnv, job.id, new Date(), 100);
    expect(secondFailure).toMatchObject({ state: 'failed', attempt: 2, errorCode: 'EXPORT_SOURCE_MISSING' });
    expect((await testEnv.MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/exports/${job.id}/attempt-2/`,
    })).objects).toEqual([]);
  });

  it('lets the same serialized Workflow owner resume a Running attempt', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'same-owner-retry', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const repository = new ExportsRepository(testEnv.DB);
    const claimStartedAt = '2026-08-12T12:00:00.000Z';
    expect(await repository.claimRunning(job.id, job.attempt, claimStartedAt)).toMatchObject({
      status: 'claimed',
    });
    const attemptPrefix = `events/${access.event.id}/exports/${job.id}/attempt-1/`;
    const staleObjectKey = `${attemptPrefix}orphaned-before-step-retry`;
    await testEnv.MEDIA_BUCKET.put(staleObjectKey, 'stale');
    const failingCleanupBucket = new Proxy(testEnv.MEDIA_BUCKET, {
      get(target, property) {
        if (property === 'delete') {
          return async () => {
            throw new Error('attempt cleanup unavailable');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await expect(processExport(
      { ...testEnv, MEDIA_BUCKET: failingCleanupBucket },
      job.id,
      new Date('2026-08-12T12:00:30.000Z'),
      undefined,
      claimStartedAt,
    )).rejects.toThrow('attempt cleanup unavailable');
    expect(await repository.getById(job.id)).toMatchObject({
      state: 'running', startedAt: null, executionStartedAt: claimStartedAt,
    });

    const resumed = await processExport(
      testEnv,
      job.id,
      new Date('2026-08-12T12:01:00.000Z'),
      undefined,
      claimStartedAt,
    );

    expect(resumed).toMatchObject({
      state: 'ready', startedAt: null, executionStartedAt: claimStartedAt,
    });
    expect(await testEnv.MEDIA_BUCKET.get(staleObjectKey)).toBeNull();
  });

  it('lets only the distinct queued-to-running transition owner process one attempt', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'single-transition-owner', null);
    const repository = new ExportsRepository(testEnv.DB);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(created.status).toBe(202);
    const job = (await repository.getById((await created.json<any>()).data.export.id))!;
    const ownerStartedAt = '2026-08-12T12:00:00.000Z';
    expect(await repository.claimRunning(job.id, job.attempt, ownerStartedAt)).toMatchObject({
      status: 'claimed',
    });

    const duplicate = await processExport(
      testEnv,
      job.id,
      new Date('2026-08-12T12:01:00.000Z'),
      undefined,
      '2026-08-12T12:00:01.000Z',
    );

    expect(duplicate).toMatchObject({
      state: 'running', startedAt: null, executionStartedAt: ownerStartedAt,
    });
    expect(await repository.getById(job.id)).toMatchObject({
      state: 'running', startedAt: null, executionStartedAt: ownerStartedAt, errorCode: null,
    });
    expect((await testEnv.MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/exports/${job.id}/`,
    })).objects).toEqual([]);
  });

  it('returns an already-Ready job without trying to claim or process it again', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'already-ready', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const returned = await processExport(testEnv, job.id, new Date(Date.now() + 60_000));

    expect(returned).toEqual(ready);
  });

  it('keeps committed export objects when the markReady response is lost', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'ready-response-loss', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const responseLossDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error('simulated lost markReady response');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const ready = await processExport(
      { ...testEnv, DB: responseLossDb },
      job.id,
      new Date('2026-08-12T12:00:00.000Z'),
    );
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const keys = [
      ready!.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      ready!.guestbookHtmlObjectKey,
      ready!.guestbookCsvObjectKey,
    ].filter((key): key is string => Boolean(key));

    expect(ready).toMatchObject({ state: 'ready', partCount: 1 });
    expect(keys).toHaveLength(4);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('does not mutate winner parts when markReady loses the running-state transition', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'markready-winner-parts', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const snapshotAt = job.snapshotAt as string;
    const repository = new ExportsRepository(testEnv.DB);
    const claimed = await repository.claimRunning(job.id, job.attempt, snapshotAt);
    if (claimed.status === 'lost') throw new Error('Expected the Ready-race attempt to be claimed.');
    await repository.recordProgress(claimed.owner, {
      processedMediaCount: 1, processedBytes: 64, progressUpdatedAt: snapshotAt,
    });
    const winnerInventory = {
      manifestObjectKey: 'winner-manifest',
      parts: [{ partNumber: 1, objectKey: 'winner-part', mediaCount: 1, sourceBytes: 64 }],
      guestbook: {
        htmlObjectKey: 'winner-guestbook.html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'winner-guestbook.csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    };

    let interleaved = false;
    const interleavingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!interleaved) {
              interleaved = true;
              const winner = await repository.markReady(
                claimed.owner,
                winnerInventory,
                snapshotAt,
                new Date(Date.now() + 60_000).toISOString(),
              );
              expect(winner.changed).toBe(true);
            }
            return testEnv.DB.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const staleRepository = new ExportsRepository(interleavingDb);

    await expect(staleRepository.markReady(claimed.owner, {
      manifestObjectKey: 'stale-manifest',
      parts: [{ partNumber: 1, objectKey: 'stale-part', mediaCount: 1, sourceBytes: 64 }],
      // A complete job that froze Guestbook metadata owes complete Guestbook
      // inventory, so the loser arrives with a whole one and still loses.
      guestbook: {
        htmlObjectKey: 'stale-guestbook.html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'stale-guestbook.csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    }, snapshotAt, new Date(Date.now() + 120_000).toISOString()))
      .resolves.toMatchObject({ changed: false, job: { state: 'ready' } });

    expect(await repository.getById(job.id)).toMatchObject({
      state: 'ready', manifestObjectKey: 'winner-manifest', partCount: 1,
    });
    expect(await repository.listParts(job.id)).toMatchObject([{
      partNumber: 1, objectKey: 'winner-part',
    }]);
  });

  it('exports the immutable photo membership even when the live media row is later deleted', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'count-drift', 'Frozen caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    // Permanent deletion is the terminal state, not a lone `deleted_at`: since
    // 0019 that marker on a stored row means recoverable, and the trash-pair
    // invariant refuses to let a fixture invent a shape the runtime cannot reach.
    await testEnv.DB.prepare(`
      UPDATE media SET upload_state = 'deleted', deleted_at = ? WHERE id = ?
    `).bind(new Date().toISOString(), media.id).run();
    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', mediaCount: 1 });
    const manifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect(manifest).toContain(media.id);
  });

  it('never substitutes a reservation finalized after snapshot for a removed frozen photo', async () => {
    const access = await eventAccess();
    const frozen = await uploadPending(access, 'frozen-member', 'Frozen member caption');
    const replacementBytes = png();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'replacement-member.png', mimeType: 'image/png',
        byteSize: replacementBytes.byteLength,
        idempotencyKey: 'replacement-member', guestName: 'Avery', caption: null,
      }),
    }, testEnv);
    expect(initiated.status).toBe(201);
    const replacement = (await initiated.json<any>()).data.media;
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    // Host removal is now Recently deleted: the row leaves every live read while
    // its exact bytes stay, which is the case where an implementation that reads
    // live media instead of its frozen entries would reach for the replacement.
    await trashMedia(access, frozen.id);
    const finalized = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${replacement.id}/content`,
      {
        method: 'PUT',
        headers: {
          ...writeHeaders(access.guest),
          'content-type': 'image/png',
          'content-length': String(replacementBytes.byteLength),
        },
        body: replacementBytes.buffer.slice(
          replacementBytes.byteOffset,
          replacementBytes.byteOffset + replacementBytes.byteLength,
        ) as ArrayBuffer,
      },
      testEnv,
    );
    expect(finalized.status).toBe(200);

    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', mediaCount: 1, guestbookEntryCount: 1 });
    const csv = await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!))!.text();
    expect(csv).toContain(`photo_caption,${frozen.id}`);
    expect(csv).toContain(`,${frozen.id},1,photos/001-frozen-member.png\r\n`);
    const manifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect(manifest).toContain(frozen.id);
    expect(manifest).not.toContain(replacement.id);

    await expireReadyExport(job.id);
    const retried = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(retried.status).toBe(202);
    const retryReady = await processExport(testEnv, job.id, new Date());
    const retryManifest = await (await testEnv.MEDIA_BUCKET.get(retryReady!.manifestObjectKey!))!.text();
    const retryCsv = await (await testEnv.MEDIA_BUCKET.get(retryReady!.guestbookCsvObjectKey!))!.text();
    expect(retryManifest).toBe(manifest);
    expect(retryCsv).toBe(csv);
  });

  it('retries a failed export whose photo moved to Recently deleted, because its bytes stay', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'retry-after-trash', 'Kept caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    // Retry deletes the previous attempt's objects, so the artifact this run must
    // reproduce is read while it still exists.
    const firstManifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    await expireReadyExport(job.id);
    await trashMedia(access, media.id);

    const retry = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(retry.status).toBe(202);
    expect((await retry.json<any>()).data.export).toMatchObject({ state: 'queued', attempt: 2 });
    const retried = await processExport(testEnv, job.id, new Date());
    expect(retried).toMatchObject({ state: 'ready', attempt: 2, mediaCount: 1 });
    expect(await (await testEnv.MEDIA_BUCKET.get(retried!.manifestObjectKey!))!.text())
      .toBe(firstManifest);
  });

  it('refuses to retry a failed export whose photo was permanently deleted', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'retry-after-permanent-delete', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const keys = [
      ready!.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      ready!.guestbookHtmlObjectKey,
      ready!.guestbookCsvObjectKey,
    ].filter((key): key is string => Boolean(key));
    await expireReadyExport(job.id);
    // Guest self-deletion is permanent by design, and a terminal job holds
    // nothing, so this is the one removal that truly takes the source away.
    const removed = await createApp().request(
      `/api/event/${access.event.slug}/uploads/${media.id}`,
      { method: 'DELETE', headers: writeHeaders(access.guest) },
      testEnv,
    );
    expect(removed.status).toBe(200);

    const retry = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(retry.status).toBe(409);
    expect(await retry.json<any>()).toMatchObject({
      code: 'EXPORT_SOURCE_REMOVED',
      message: 'Some photos in this export are no longer available. Prepare the current collection instead.',
    });
    expect(await repository.getById(job.id)).toMatchObject({ state: 'expired', attempt: 1 });
    // A refused retry is not a cleanup: the previous attempt's artifact is still
    // the host's to download until it expires.
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('returns EXPORT_SOURCE_REMOVED when retry cannot prove the exact unsuppressed tombstone', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'retry-missing-tombstone', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await failPristineExport(job.id);

    // Tombstones are permanent in production. This deliberately corrupts a
    // terminal fixture to prove retry fails closed at its own boundary instead
    // of relying on the history that normally makes the row undeletable.
    await testEnv.DB.exec('DROP TRIGGER media_object_write_tombstone_permanent;');
    await testEnv.DB.prepare(`
      DELETE FROM media_object_write_tombstones
      WHERE bucket_generation = ? AND object_key = ?
    `).bind(media.objectBucketGeneration, media.objectKey).run();

    const retry = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(retry.status).toBe(409);
    expect(await retry.json<any>()).toMatchObject({ code: 'EXPORT_SOURCE_REMOVED' });
    expect(await new ExportsRepository(testEnv.DB).getById(job.id))
      .toMatchObject({ state: 'failed', attempt: 1 });
  });

  it('returns EXPORT_SOURCE_REMOVED when retry byte proof disagrees with the frozen job', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'retry-byte-proof', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await failPristineExport(job.id);
    await testEnv.DB.prepare(`
      UPDATE export_media_entries SET byte_size = COALESCE(byte_size, declared_byte_size) + 1
      WHERE export_job_id = ?
    `).bind(job.id).run();

    const retry = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(retry.status).toBe(409);
    expect(await retry.json<any>()).toMatchObject({ code: 'EXPORT_SOURCE_REMOVED' });
    expect(await new ExportsRepository(testEnv.DB).getById(job.id))
      .toMatchObject({ state: 'failed', attempt: 1 });
  });

  it('excludes a photo in Recently deleted from a new snapshot while the accepted job keeps it', async () => {
    const access = await eventAccess();
    const kept = await uploadPending(access, 'snapshot-kept', 'Still delivered');
    const removed = await uploadPending(access, 'snapshot-removed', 'Moved to Recently deleted');
    const accepted = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const acceptedJob = (await accepted.json<any>()).data.export;
    expect(acceptedJob).toMatchObject({ mediaCount: 2, totalBytes: 128 });

    await trashMedia(access, removed.id);

    expect((await testEnv.DB.prepare(`
      SELECT media_id FROM export_media_entries WHERE export_job_id = ? ORDER BY media_id
    `).bind(acceptedJob.id).all()).results).toEqual(
      [kept.id, removed.id].sort().map((media_id) => ({ media_id })),
    );
    // One job at a time per event, so the accepted one goes terminal before the
    // host can ask for the collection as it stands now.
    await failPristineExport(acceptedJob.id);
    const next = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);

    expect(next.status).toBe(202);
    const nextJob = (await next.json<any>()).data.export;
    expect(nextJob).toMatchObject({ mediaCount: 1, totalBytes: 64 });
    expect((await testEnv.DB.prepare(`
      SELECT media_id FROM export_media_entries WHERE export_job_id = ?
    `).bind(nextJob.id).all()).results).toEqual([{ media_id: kept.id }]);
  });

  it('keeps an expired recoverable photo until the export holding its source is terminal', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'held-source-cleanup', 'Held caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await trashMedia(access, media.id);
    // The server computes a deadline 30 days out, so the fixture moves the whole
    // pair into the past rather than the clock: cleanup, Restore, and the trash
    // listing all read the same two columns.
    await testEnv.DB.prepare(`
      UPDATE media SET trashed_at = ?1, deleted_at = ?1, restore_until = ?2 WHERE id = ?3
    `).bind('2026-06-01T12:00:00.000Z', '2026-06-02T12:00:00.000Z', media.id).run();

    expect(await cleanupExpiredRecoverableMedia(testEnv, new Date()))
      .toEqual({ terminalized: 0, held: 1 });
    const listed = await createApp().request(
      `/api/manage/events/${access.event.id}/media/trash`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect((await listed.json<any>()).data.media).toEqual([{
      id: media.id,
      originalFilename: 'held-source-cleanup.png',
      guestName: 'Avery',
      caption: 'Held caption',
      trashedAt: '2026-06-01T12:00:00.000Z',
      restoreUntil: '2026-06-02T12:00:00.000Z',
    }]);
    const restore = await createApp().request(
      `/api/manage/events/${access.event.id}/media/${media.id}/restore`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(restore.status).toBe(409);
    expect((await restore.json<any>()).code).toBe('MEDIA_STATE_CONFLICT');
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(media.objectKey)).not.toBeNull();

    await failPristineExport(job.id);

    expect(await cleanupExpiredRecoverableMedia(testEnv, new Date()))
      .toEqual({ terminalized: 1, held: 0 });
    expect(await testEnv.DB.prepare(`
      SELECT upload_state, trashed_at, restore_until FROM media WHERE id = ?
    `).bind(media.id).first()).toEqual({
      upload_state: 'deleted', trashed_at: null, restore_until: null,
    });
    expect(await testEnv.DB.prepare(`
      SELECT recoverable_media_count AS count, recoverable_bytes AS bytes FROM events WHERE id = ?
    `).bind(access.event.id).first()).toEqual({ count: 0, bytes: 0 });
  });

  it('refuses retry before deleting ready inventory and resets all six Guestbook fields after durable deletion', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'retry-inventory', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const frozenRows = await testEnv.DB.prepare(`
      SELECT source, source_id, body FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).all();
    const keys = [
      ready!.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      ready!.guestbookHtmlObjectKey,
      ready!.guestbookCsvObjectKey,
    ]
      .filter((key): key is string => Boolean(key));
    const readyRetry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(readyRetry.status).toBe(409);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();

    await expireReadyExport(job.id);
    const retry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(retry.status).toBe(202);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).toBeNull();
    expect((await new ExportsRepository(testEnv.DB).getById(job.id))).toMatchObject({
      state: 'queued', attempt: 2,
      guestbookHtmlObjectKey: null, guestbookHtmlBytes: null, guestbookHtmlSha256: null,
      guestbookCsvObjectKey: null, guestbookCsvBytes: null, guestbookCsvSha256: null,
      guestbookEntryCount: ready!.guestbookEntryCount,
      guestbookPrompt: ready!.guestbookPrompt,
    });
    expect((await testEnv.DB.prepare(`
      SELECT source, source_id, body FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).all()).results).toEqual(frozenRows.results);
  });

  it('keeps private-only entries out of printable HTML and in the private archive', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'private-note-snapshot-photo', null);
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(access.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('private-note', ?, ?, 'Taylor', 'For the hosts only', 'pending',
        'private-note-key', '2026-08-12T12:00:00.000Z', NULL, NULL)
    `).bind(access.event.id, sessionId).run();
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ guestbookEntryCount: 1, guestbookSharedCount: 0 });
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!))!.text())
      .toContain('No guestbook entries were shared at this snapshot.');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!))!.text())
      .not.toContain('For the hosts only');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!))!.text())
      .toContain('pending,author_only');
  });

  it('refuses partial Ready inventory and partial signed-download inventory', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'partial-inventory', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const repository = new ExportsRepository(testEnv.DB);
    const claimed = await repository.claimRunning(job.id, job.attempt, new Date().toISOString());
    if (claimed.status === 'lost') throw new Error('Expected the test attempt to be claimed.');
    await expect(repository.markReady(claimed.owner, {
      manifestObjectKey: null,
      parts: [],
      guestbook: {
        htmlObjectKey: 'html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('requires a manifest and parts');

    await repository.markOwnedFailed(claimed.owner, 'EXPORT_TEST_FAILURE', new Date().toISOString());
    await repository.retry(job.id);
    const ready = await processExport(testEnv, job.id, new Date());
    await testEnv.DB.prepare(`UPDATE export_jobs SET guestbook_csv_sha256 = NULL WHERE id = ?`)
      .bind(job.id).run();
    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${ready!.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(download.status).toBe(409);
    expect((await download.json<any>()).code).toBe('EXPORT_FAILED');

    const notesAccess = await eventAccess();
    const notesSeeded = await seedHistoricalZeroPhotoComplete(
      notesAccess,
      'partial-zero-photo',
      'failed',
    );
    const notesJob = await repository.retry(notesSeeded.id);
    const notesClaimed = await repository.claimRunning(
      notesJob.id,
      notesJob.attempt,
      new Date().toISOString(),
    );
    if (notesClaimed.status === 'lost') throw new Error('Expected the notes attempt to be claimed.');
    await expect(repository.markReady(notesClaimed.owner, {
      manifestObjectKey: null, parts: [], guestbook: null,
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('requires complete Guestbook inventory');
    await expect(repository.markReady(notesClaimed.owner, {
      manifestObjectKey: 'unexpected-manifest',
      parts: [],
      guestbook: {
        htmlObjectKey: 'html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('cannot contain photo inventory');
  });

  it('rejects every Guestbook field at album readiness and blocks direct Guestbook artifact routes', async () => {
    const access = await eventAccess();
    const picked = await uploadPending(access, 'album-guestbook-fields', null);
    await setAlbumSnapshotSource(access, [picked.id], '[]');
    const repository = new ExportsRepository(testEnv.DB);
    const boundary = '2026-08-23T12:00:00.000Z';
    const job = await repository.createAlbumActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt: boundary, createdAt: boundary,
    });
    const claimed = await repository.claimRunning(job.id, job.attempt, '2026-08-23T12:00:01.000Z');
    if (claimed.status === 'lost') throw new Error('Expected the Album attempt to be claimed.');
    const inventory = {
      manifestObjectKey: `events/${access.event.id}/exports/${job.id}/attempt-1/candidary-export-manifest.csv`,
      parts: [{
        partNumber: 1,
        objectKey: `events/${access.event.id}/exports/${job.id}/attempt-1/photos-001.zip`,
        mediaCount: 1,
        sourceBytes: 64,
      }],
      guestbook: null,
    };
    const guestbookFields: Array<[string, string | number]> = [
      ['guestbook_entry_count', 1],
      ['guestbook_shared_count', 1],
      ['guestbook_event_name', 'Maya & Theo'],
      ['guestbook_event_date', '2026-09-19'],
      ['guestbook_event_timezone', 'America/Chicago'],
      ['guestbook_prompt', 'Share a memory'],
      ['guestbook_gallery_visible', 1],
      ['guestbook_html_object_key', 'guestbook.html'],
      ['guestbook_html_bytes', 1],
      ['guestbook_html_sha256', 'a'.repeat(64)],
      ['guestbook_csv_object_key', 'guestbook.csv'],
      ['guestbook_csv_bytes', 1],
      ['guestbook_csv_sha256', 'b'.repeat(64)],
    ];
    for (const [column, value] of guestbookFields) {
      await testEnv.DB.prepare(`UPDATE export_jobs SET ${column} = ? WHERE id = ?`)
        .bind(value, job.id).run();
      await expect(repository.markReady(
        claimed.owner,
        inventory,
        '2026-08-23T12:00:02.000Z',
        '2026-08-24T12:00:02.000Z',
      )).rejects.toThrow('An album export cannot contain Guestbook data.');
      await testEnv.DB.prepare(`UPDATE export_jobs SET ${column} = NULL WHERE id = ?`)
        .bind(job.id).run();
    }

    await repository.recordProgress(claimed.owner, {
      processedMediaCount: 1,
      processedBytes: 64,
      progressUpdatedAt: '2026-08-23T12:00:01.500Z',
    });
    await repository.markReady(
      claimed.owner,
      inventory,
      '2026-08-23T12:00:02.000Z',
      '2026-08-24T12:00:02.000Z',
    );
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET guestbook_html_object_key = 'forged-guestbook.html' WHERE id = ?
    `).bind(job.id).run();
    const direct = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/artifact/printable-guestbook`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect(direct.status).toBe(404);
    expect(await direct.json<any>()).toMatchObject({ code: 'EXPORT_FAILED' });
  });

  it('keeps legacy photo-only rows downloadable with null Guestbook descriptors', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'legacy-download', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await processExport(testEnv, job.id, new Date());
    // A pre-0015 job froze no entries and carries no Guestbook columns at all.
    // 0019 refuses to create that shape again and fails any queued one it finds,
    // but it deliberately leaves an already-ready artifact alone, so the host who
    // still has one must be able to download it.
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        UPDATE export_jobs SET
          guestbook_entry_count = NULL, guestbook_shared_count = NULL,
          guestbook_event_name = NULL, guestbook_event_date = NULL,
          guestbook_event_timezone = NULL, guestbook_prompt = NULL,
          guestbook_gallery_visible = NULL, guestbook_html_object_key = NULL,
          guestbook_html_bytes = NULL, guestbook_html_sha256 = NULL,
          guestbook_csv_object_key = NULL, guestbook_csv_bytes = NULL,
          guestbook_csv_sha256 = NULL
        WHERE id = ?
      `).bind(job.id),
      testEnv.DB.prepare('DELETE FROM export_media_entries WHERE export_job_id = ?').bind(job.id),
    ]);
    const legacy = await new ExportsRepository(testEnv.DB).getById(job.id);
    expect(legacy).toMatchObject({
      state: 'ready',
      guestbookEntryCount: null,
      guestbookHtmlObjectKey: null,
      guestbookCsvObjectKey: null,
    });
    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data).toMatchObject({
      printableGuestbook: null,
      privateGuestbook: null,
    });
  });

  it('uses a domain refusal when an export belongs to another event', async () => {
    const first = await eventAccess();
    const second = await eventAccess();
    const jobId = crypto.randomUUID();
    await seedExportJob({
      id: jobId,
      eventId: second.event.id,
      snapshotAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const response = await createApp().request(
      `/api/manage/events/${first.event.id}/exports/${jobId}`,
      { headers: { cookie: first.manager.cookie } },
      testEnv,
    );

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('RESOURCE_FORBIDDEN');
  });
});

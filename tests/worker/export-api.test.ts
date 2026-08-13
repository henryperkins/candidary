import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { MAX_EVENT_BYTES } from '../../shared/constants';
import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, resetDatabase, testEnv, uploadPending, writeHeaders } from './helpers';

const managerExportKeys = [
  'attempt',
  'expiresAt',
  'guestbookEntryCount',
  'guestbookEventDate',
  'guestbookEventName',
  'guestbookEventTimezone',
  'guestbookGalleryVisible',
  'guestbookPrompt',
  'guestbookSharedCount',
  'id',
  'mediaCount',
  'partCount',
  'snapshotAt',
  'state',
  'totalBytes',
].sort();

function expectManagerExport(value: Record<string, unknown>) {
  expect(Object.keys(value).sort()).toEqual(managerExportKeys);
}

describe('manager exports', () => {
  beforeEach(resetDatabase);

  it('atomically creates a new-format notes-only job with frozen metadata and entries', async () => {
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

    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);

    expect(response.status).toBe(202);
    const job = (await response.json<any>()).data.export;
    expect(job).toMatchObject({
      mediaCount: 0,
      guestbookEntryCount: 1,
      guestbookSharedCount: 1,
      guestbookEventName: access.event.name,
      guestbookEventDate: access.event.eventDate,
      guestbookEventTimezone: access.event.eventTimezone,
      guestbookPrompt: access.event.guestbookPrompt,
      guestbookGalleryVisible: access.event.galleryVisible,
    });
    expect(job.snapshotAt).toBeTruthy();
    const rows = await testEnv.DB.prepare(`
      SELECT source, source_id, body, source_state, guest_visibility, included_in_keepsake
      FROM export_guestbook_entries WHERE export_job_id = ?
    `).bind(job.id).all();
    expect(rows.results).toEqual([{
      source: 'guest_note', source_id: 'note-only', body: 'A frozen note',
      source_state: 'approved', guest_visibility: 'shared', included_in_keepsake: 1,
    }]);

    await testEnv.DB.prepare(`
      UPDATE guest_messages SET body = 'Changed after snapshot', moderation_status = 'rejected'
      WHERE id = 'note-only'
    `).run();
    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', manifestObjectKey: null, partCount: 0 });
    expect(ready?.guestbookHtmlBytes).toBeGreaterThan(0);
    expect(ready?.guestbookHtmlSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(ready?.guestbookCsvBytes).toBeGreaterThan(0);
    expect(ready?.guestbookCsvSha256).toMatch(/^[a-f0-9]{64}$/u);
    const htmlObject = await testEnv.MEDIA_BUCKET.get(ready!.guestbookHtmlObjectKey!);
    const csvObject = await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!);
    expect(await htmlObject!.text()).toContain('A frozen note');
    expect(await csvObject!.text()).toContain('A frozen note');
    expect(await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!))!.text())
      .not.toContain('Changed after snapshot');
    expect(htmlObject!.httpMetadata).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      contentDisposition: 'attachment; filename="guestbook.html"',
    });

    const download = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/download`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );
    expect(download.status).toBe(200);
    const data = (await download.json<any>()).data;
    expect(data.manifest).toBeNull();
    expect(data.parts).toEqual([]);
    expect(data.printableGuestbook.filename).toBe('guestbook.html');
    expect(data.privateGuestbook.filename).toBe('guestbook-private.csv');
    expect(data.printableGuestbook.expiresAt).toBe(data.privateGuestbook.expiresAt);
    expect(data.printableGuestbook.url).toContain('X-Amz-Expires=900');
    expect(data.privateGuestbook.url).toContain('X-Amz-Expires=900');
  });

  it('rejects an empty snapshot', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
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

    const download = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(download.status).toBe(200);
    const downloadData = (await download.json<any>()).data;
    expect(downloadData.manifest.url).toContain('X-Amz-Expires=900');
    expect(downloadData.parts).toHaveLength(2);
    expect(downloadData.parts.every((part: any) => part.url.includes('X-Amz-Expires=900'))).toBe(true);
    expect(downloadData.printableGuestbook.filename).toBe('guestbook.html');
    expect(downloadData.privateGuestbook.filename).toBe('guestbook-private.csv');

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.guest), body: '{}',
    }, testEnv);
    expect(denied.status).toBe(403);
  });

  it('uses an attempt-specific object key when retrying a failed job', async () => {
    const access = await eventAccess();
    const repository = new ExportsRepository(testEnv.DB);
    const job = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id,
      snapshotAt: '2026-07-21T12:00:00.000Z', mediaCount: 1, totalBytes: 64,
      createdAt: '2026-07-21T12:00:00.000Z',
    });
    await repository.markFailed(job.id, 'EXPORT_SOURCE_MISSING');
    const retry = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/retry`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(retry.status).toBe(202);
    expect((await retry.json<any>()).data.export.attempt).toBe(2);
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

    await new ExportsRepository(testEnv.DB).markFailed(createdJob.id, 'EXPORT_SOURCE_MISSING');
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
    await testEnv.MEDIA_BUCKET.delete(missing.objectKey);

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

  it('lets only the queued-to-running transition owner process one attempt', async () => {
    const access = await eventAccess();
    const snapshotAt = new Date().toISOString();
    const repository = new ExportsRepository(testEnv.DB);
    const job = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt,
      mediaCount: 1, totalBytes: 64, createdAt: snapshotAt,
    });
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ? WHERE id = ?
    `).bind(snapshotAt, job.id).run();

    const duplicate = await processExport(testEnv, job.id, new Date());

    expect(duplicate).toMatchObject({ state: 'running', startedAt: snapshotAt });
    expect(await repository.getById(job.id)).toMatchObject({
      state: 'running', startedAt: snapshotAt, errorCode: null,
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

  it('does not mutate winner parts when markReady loses the running-state transition', async () => {
    const access = await eventAccess();
    const snapshotAt = new Date().toISOString();
    const repository = new ExportsRepository(testEnv.DB);
    const job = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt,
      mediaCount: 1, totalBytes: 64, createdAt: snapshotAt,
    });
    await testEnv.DB.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ? WHERE id = ?
    `).bind(snapshotAt, job.id).run();

    let interleaved = false;
    const interleavingDb = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!interleaved) {
              interleaved = true;
              await testEnv.DB.batch([
                testEnv.DB.prepare(`
                  UPDATE export_jobs SET state = 'ready', manifest_object_key = 'winner-manifest',
                    part_count = 1, completed_at = ?, expires_at = ?, error_code = NULL
                  WHERE id = ? AND state = 'running'
                `).bind(snapshotAt, new Date(Date.now() + 60_000).toISOString(), job.id),
                testEnv.DB.prepare(`
                  INSERT INTO export_parts (
                    id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
                  ) VALUES ('winner-part-id', ?, 1, 'winner-part', 1, 64, ?)
                `).bind(job.id, snapshotAt),
              ]);
            }
            return testEnv.DB.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const staleRepository = new ExportsRepository(interleavingDb);

    await expect(staleRepository.markReady(job.id, {
      manifestObjectKey: 'stale-manifest',
      parts: [{ partNumber: 1, objectKey: 'stale-part', mediaCount: 1, sourceBytes: 64 }],
      guestbook: null,
    }, snapshotAt, new Date(Date.now() + 120_000).toISOString()))
      .rejects.toThrow('Export job was not running.');

    expect(await repository.getById(job.id)).toMatchObject({
      state: 'ready', manifestObjectKey: 'winner-manifest', partCount: 1,
    });
    expect(await repository.listParts(job.id)).toMatchObject([{
      id: 'winner-part-id', partNumber: 1, objectKey: 'winner-part',
    }]);
  });

  it('keeps count-drift failure behavior without publishing partial artifacts', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'count-drift', 'Frozen caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.DB.prepare(`UPDATE media SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), media.id).run();
    const failed = await processExport(testEnv, job.id, new Date());
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'EXPORT_SNAPSHOT_CHANGED' });
    expect((await testEnv.MEDIA_BUCKET.list({
      prefix: `events/${access.event.id}/exports/${job.id}/attempt-1/`,
    })).objects).toEqual([]);
  });

  it('recomputes a count-equal photo plan but retains a frozen missing media ID', async () => {
    const access = await eventAccess();
    const frozen = await uploadPending(access, 'frozen-member', 'Frozen member caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.DB.prepare(`UPDATE media SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), frozen.id).run();
    const replacement = await uploadPending(access, 'replacement-member', null);
    await testEnv.DB.prepare(`UPDATE media SET created_at = '2026-08-12T11:00:00.000Z' WHERE id = ?`)
      .bind(replacement.id).run();

    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', mediaCount: 1, guestbookEntryCount: 1 });
    const csv = await (await testEnv.MEDIA_BUCKET.get(ready!.guestbookCsvObjectKey!))!.text();
    expect(csv).toContain(`photo_caption,${frozen.id}`);
    expect(csv).toContain(`,${frozen.id},,\r\n`);
    const manifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect(manifest).toContain(replacement.id);
    expect(manifest).not.toContain(frozen.id);
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

    await testEnv.DB.prepare(`UPDATE export_jobs SET state = 'failed' WHERE id = ?`).bind(job.id).run();
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
    await repository.claimRunning(job.id, new Date().toISOString());
    await expect(repository.markReady(job.id, {
      manifestObjectKey: null,
      parts: [],
      guestbook: {
        htmlObjectKey: 'html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('requires a manifest and parts');

    await testEnv.DB.prepare(`UPDATE export_jobs SET state = 'queued' WHERE id = ?`).bind(job.id).run();
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
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions WHERE event_id = ? AND role = 'guest' LIMIT 1
    `).bind(notesAccess.event.id).first<string>('id');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES ('partial-note', ?, ?, NULL, 'Partial note', 'pending',
        'partial-note-key', '2026-08-12T12:00:00.000Z', NULL, NULL)
    `).bind(notesAccess.event.id, sessionId).run();
    const notesCreated = await createApp().request(`/api/manage/events/${notesAccess.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(notesAccess.manager), body: '{}',
    }, testEnv);
    const notesJob = (await notesCreated.json<any>()).data.export;
    await repository.claimRunning(notesJob.id, new Date().toISOString());
    await expect(repository.markReady(notesJob.id, {
      manifestObjectKey: null, parts: [], guestbook: null,
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('requires complete Guestbook inventory');
    await expect(repository.markReady(notesJob.id, {
      manifestObjectKey: 'unexpected-manifest',
      parts: [],
      guestbook: {
        htmlObjectKey: 'html', htmlBytes: 1, htmlSha256: 'a'.repeat(64),
        csvObjectKey: 'csv', csvBytes: 1, csvSha256: 'b'.repeat(64),
      },
    }, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()))
      .rejects.toThrow('cannot contain photo inventory');
  });

  it('keeps legacy photo-only rows downloadable with null Guestbook descriptors', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'legacy-download', null);
    const snapshotAt = new Date().toISOString();
    const repository = new ExportsRepository(testEnv.DB);
    const legacy = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt,
      mediaCount: 1, totalBytes: 64, createdAt: snapshotAt,
    });
    expect(legacy).toMatchObject({
      guestbookEntryCount: null,
      guestbookHtmlObjectKey: null,
      guestbookCsvObjectKey: null,
    });
    const ready = await processExport(testEnv, legacy.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', guestbookEntryCount: null });
    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${legacy.id}/download`,
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
    const job = await new ExportsRepository(testEnv.DB).createActive({
      id: crypto.randomUUID(),
      eventId: second.event.id,
      snapshotAt: new Date().toISOString(),
      mediaCount: 1,
      totalBytes: 64,
      createdAt: new Date().toISOString(),
    });

    const response = await createApp().request(
      `/api/manage/events/${first.event.id}/exports/${job.id}`,
      { headers: { cookie: first.manager.cookie } },
      testEnv,
    );

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('RESOURCE_FORBIDDEN');
  });
});

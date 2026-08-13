import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { MAX_EVENT_BYTES } from '../../shared/constants';
import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, png, resetDatabase, testEnv, uploadPending, writeHeaders } from './helpers';

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
  await testEnv.DB.prepare(`
    UPDATE export_jobs SET state = 'failed', error_code = 'EXPORT_TEST_FAILURE' WHERE id = ?
  `).bind(job.id).run();
  return { job, keys };
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
    expect(data.printableGuestbook.url).toContain('/artifact/printable-guestbook');
    expect(data.privateGuestbook.url).toContain('/artifact/private-guestbook');
  });

  it('rejects an empty snapshot', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
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
    expect(await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM export_media_entries WHERE export_job_id = ?
    `).bind(job.id).first<number>('count')).toBe(0);
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
    expect(downloadData.manifest.url).toContain('/artifact/manifest');
    expect(downloadData.parts).toHaveLength(2);
    expect(downloadData.parts.every((part: any) => part.url.includes('/artifact/part/'))).toBe(true);
    expect(downloadData.printableGuestbook.filename).toBe('guestbook.html');
    expect(downloadData.privateGuestbook.filename).toBe('guestbook-private.csv');

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.guest), body: '{}',
    }, testEnv);
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
    expect(await new ExportsRepository(testEnv.DB).getById(job.id)).toMatchObject({ state: 'failed' });
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

  it('recovers a queued retry after Workflow creation fails without deleting prior-attempt objects early', async () => {
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
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();

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
    const stored = (await finalized.json<any>()).data.media;
    expect(stored.objectKey).not.toBe(reserved.objectKey);

    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.MEDIA_BUCKET.put(reserved.objectKey, png(320, 240, 96), {
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
    expect(await repository.claimRunning(job.id, claimStartedAt)).toMatchObject({ owned: true });
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
      state: 'running', startedAt: claimStartedAt,
    });

    const resumed = await processExport(
      testEnv,
      job.id,
      new Date('2026-08-12T12:01:00.000Z'),
      undefined,
      claimStartedAt,
    );

    expect(resumed).toMatchObject({ state: 'ready', startedAt: claimStartedAt });
    expect(await testEnv.MEDIA_BUCKET.get(staleObjectKey)).toBeNull();
  });

  it('lets only the distinct queued-to-running transition owner process one attempt', async () => {
    const access = await eventAccess();
    const snapshotAt = new Date().toISOString();
    const repository = new ExportsRepository(testEnv.DB);
    const job = await repository.createActive({
      id: crypto.randomUUID(), eventId: access.event.id, snapshotAt,
      mediaCount: 1, totalBytes: 64, createdAt: snapshotAt,
    });
    const ownerStartedAt = '2026-08-12T12:00:00.000Z';
    expect(await repository.claimRunning(job.id, ownerStartedAt)).toMatchObject({ owned: true });

    const duplicate = await processExport(
      testEnv,
      job.id,
      new Date('2026-08-12T12:01:00.000Z'),
      undefined,
      '2026-08-12T12:00:01.000Z',
    );

    expect(duplicate).toMatchObject({ state: 'running', startedAt: ownerStartedAt });
    expect(await repository.getById(job.id)).toMatchObject({
      state: 'running', startedAt: ownerStartedAt, errorCode: null,
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

  it('exports the immutable photo membership even when the live media row is later deleted', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'count-drift', 'Frozen caption');
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    await testEnv.DB.prepare(`UPDATE media SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), media.id).run();
    const ready = await processExport(testEnv, job.id, new Date());
    expect(ready).toMatchObject({ state: 'ready', mediaCount: 1 });
    const manifest = await (await testEnv.MEDIA_BUCKET.get(ready!.manifestObjectKey!))!.text();
    expect(manifest).toContain(media.id);
  });

  it('never substitutes a reservation finalized after snapshot for a deleted frozen photo', async () => {
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
    await testEnv.DB.prepare(`UPDATE media SET deleted_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), frozen.id).run();
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

    await testEnv.DB.prepare(`UPDATE export_jobs SET state = 'failed' WHERE id = ?`)
      .bind(job.id).run();
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

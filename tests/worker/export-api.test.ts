import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, resetDatabase, testEnv, uploadPending, writeHeaders } from './helpers';

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
  const keys = [ready!.manifestObjectKey, ...parts.map(({ objectKey }) => objectKey)]
    .filter((key): key is string => Boolean(key));
  await testEnv.DB.prepare(`
    UPDATE export_jobs SET state = 'failed', error_code = 'EXPORT_TEST_FAILURE' WHERE id = ?
  `).bind(job.id).run();
  return { job, keys };
}

describe('manager exports', () => {
  beforeEach(resetDatabase);

  it('rejects an empty snapshot', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EXPORT_EMPTY');
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

    const env = signerFreeEnv();
    const download = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, env);
    expect(download.status).toBe(200);
    const downloadData = (await download.json<any>()).data;
    expect(downloadData.manifest.url).toBe(
      `/api/manage/events/${access.event.id}/exports/${job.id}/artifacts/manifest`,
    );
    expect(downloadData.parts).toHaveLength(2);
    expect(downloadData.parts.map((part: any) => part.url)).toEqual([
      `/api/manage/events/${access.event.id}/exports/${job.id}/artifacts/parts/1`,
      `/api/manage/events/${access.event.id}/exports/${job.id}/artifacts/parts/2`,
    ]);

    const manifestDownload = await createApp().request(downloadData.manifest.url, {
      headers: { cookie: access.manager.cookie },
    }, env);
    expect(manifestDownload.status).toBe(200);
    expect(manifestDownload.headers.get('content-disposition'))
      .toBe('attachment; filename="candidary-export-manifest.csv"');
    expect(manifestDownload.headers.get('cache-control')).toBe('private, no-store');
    expect(await manifestDownload.text()).toBe(manifest);

    const partialDownload = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=0-7' },
    }, env);
    expect(partialDownload.status).toBe(206);
    expect(partialDownload.headers.get('accept-ranges')).toBe('bytes');
    expect(partialDownload.headers.get('content-range')).toMatch(/^bytes 0-7\/\d+$/u);
    expect((await partialDownload.arrayBuffer()).byteLength).toBe(8);

    const openEnded = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=8-' },
    }, env);
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('content-range')).toMatch(/^bytes 8-\d+\/\d+$/u);

    const suffix = await createApp().request(downloadData.parts[0].url, {
      headers: { cookie: access.manager.cookie, range: 'bytes=-8' },
    }, env);
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(8);

    for (const invalidRange of ['bytes=0-1,4-5', 'bytes=-0', 'bytes=999999-', 'items=0-1']) {
      const invalid = await createApp().request(downloadData.parts[0].url, {
        headers: { cookie: access.manager.cookie, range: invalidRange },
      }, env);
      expect(invalid.status, invalidRange).toBe(416);
      expect(invalid.headers.get('content-range'), invalidRange).toMatch(/^bytes \*\/\d+$/u);
      expect(await invalid.text()).toBe('');
    }

    const artifactDenied = await createApp().request(downloadData.manifest.url, {
      headers: { cookie: access.guest.cookie },
    }, env);
    expect(artifactDenied.status).toBe(403);

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.guest), body: '{}',
    }, env);
    expect(denied.status).toBe(403);

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
        if (property === 'createBatch') {
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
      new Date('2026-08-13T10:00:00.000Z'),
    );
    const repository = new ExportsRepository(testEnv.DB);
    const parts = await repository.listParts(job.id);
    const keys = [ready!.manifestObjectKey, ...parts.map(({ objectKey }) => objectKey)]
      .filter((key): key is string => Boolean(key));

    expect(ready).toMatchObject({ state: 'ready', partCount: 1 });
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
  });

  it('refuses a ready retry before deleting its committed objects', async () => {
    const access = await eventAccess();
    await uploadPending(access, 'ready-retry-preserved', null);
    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await created.json<any>()).data.export;
    const ready = await processExport(testEnv, job.id, new Date());
    const parts = await new ExportsRepository(testEnv.DB).listParts(job.id);
    const keys = [ready!.manifestObjectKey, ...parts.map(({ objectKey }) => objectKey)]
      .filter((key): key is string => Boolean(key));

    const response = await createApp().request(
      `/api/manage/events/${access.event.id}/exports/${job.id}/retry`,
      { method: 'POST', headers: writeHeaders(access.manager), body: '{}' },
      testEnv,
    );

    expect(response.status).toBe(409);
    expect(await response.json<any>()).toMatchObject({ code: 'EXPORT_ALREADY_ACTIVE' });
    for (const key of keys) expect(await testEnv.MEDIA_BUCKET.head(key)).not.toBeNull();
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

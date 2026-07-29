import { beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';

import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, resetDatabase, testEnv, uploadPending, writeHeaders } from './helpers';

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

    const download = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(download.status).toBe(200);
    const downloadData = (await download.json<any>()).data;
    expect(downloadData.manifest.url).toContain('X-Amz-Expires=900');
    expect(downloadData.parts).toHaveLength(2);
    expect(downloadData.parts.every((part: any) => part.url.includes('X-Amz-Expires=900'))).toBe(true);

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

import { beforeEach, describe, expect, it } from 'vitest';

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

  it('prepares a snapshot archive and exposes status and a temporary download URL', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'exportable', 'Sunset toast');
    await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
    }, testEnv);

    const created = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(created.status).toBe(202);
    const job = (await created.json<any>()).data.export;
    await processExport(testEnv, job.id, new Date('2026-07-21T13:00:00.000Z'));

    const status = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await status.json<any>()).data.export.state).toBe('ready');

    const download = await createApp().request(`/api/manage/events/${access.event.id}/exports/${job.id}/download`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    expect(download.status).toBe(200);
    expect((await download.json<any>()).data.url).toContain('X-Amz-Expires=900');
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
});

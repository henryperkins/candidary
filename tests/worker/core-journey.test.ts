import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, resetDatabase, testEnv, uploadPending, writeHeaders } from './helpers';

describe('complete private event journey', () => {
  beforeEach(resetDatabase);

  it('creates, contributes, moderates, publishes, and exports originals', async () => {
    const access = await eventAccess('Maya & Theo');
    const media = await uploadPending(access, 'first-look', 'The first look');
    const approved = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
    }, testEnv);
    expect(approved.status).toBe(200);

    const gallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await gallery.json<any>()).data.media.map((item: any) => item.id)).toEqual([media.id]);

    const requested = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await requested.json<any>()).data.export;
    await processExport(testEnv, job.id);
    const ready = await new ExportsRepository(testEnv.DB).getById(job.id);
    const object = await testEnv.MEDIA_BUCKET.get(ready!.objectKey!);
    const archive = unzipSync(new Uint8Array(await object!.arrayBuffer()));
    expect(Object.keys(archive)).toEqual(['photos/001-first-look.png', 'media.csv']);
    expect(strFromU8(archive['media.csv']!)).toContain('The first look');
  });
});

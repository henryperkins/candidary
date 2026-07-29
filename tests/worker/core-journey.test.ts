import { strFromU8, unzipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { eventAccess, resetDatabase, testEnv, uploadPending, writeHeaders } from './helpers';

describe('complete private event journey', () => {
  beforeEach(resetDatabase);

  it('creates, privately collects, optionally publishes, and exports originals', async () => {
    const access = await eventAccess('Maya & Theo');
    expect(await testEnv.DB.prepare('SELECT theme_config FROM events WHERE id = ?')
      .bind(access.event.id).first('theme_config'))
      .toBe('{"version":1,"presetId":"candidary-default","overrides":{}}');
    const media = await uploadPending(access, 'first-look', 'The first look');
    await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ galleryVisible: true, uploadsEnabled: true, moderationRequired: true }),
    }, testEnv);
    const published = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    expect(published.status).toBe(200);

    const gallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await gallery.json<any>()).data.media.map((item: any) => item.id)).toEqual([media.id]);

    const requested = await createApp().request(`/api/manage/events/${access.event.id}/exports`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const job = (await requested.json<any>()).data.export;
    await processExport(testEnv, job.id);
    const repository = new ExportsRepository(testEnv.DB);
    const ready = await repository.getById(job.id);
    const parts = await repository.listParts(job.id);
    expect(ready).toMatchObject({ state: 'ready', partCount: 1 });
    const object = await testEnv.MEDIA_BUCKET.get(parts[0]!.objectKey);
    const archive = unzipSync(new Uint8Array(await object!.arrayBuffer()));
    expect(Object.keys(archive)).toEqual(['photos/001-first-look.png', 'media.csv']);
    expect(strFromU8(archive['media.csv']!)).toContain('The first look');
    expect(await testEnv.MEDIA_BUCKET.head(ready!.manifestObjectKey!)).not.toBeNull();
  });
});

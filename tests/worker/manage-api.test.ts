import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import { MediaRepository } from '../../worker/db/media';
import {
  eventAccess,
  resetDatabase,
  secondGuest,
  testEnv,
  uploadPending,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);

describe('manager settings and private photo intake', () => {
  it('uploads and serves an event cover only to event sessions', async () => {
    const access = await eventAccess();
    const initiated = await createApp().request(`/api/manage/events/${access.event.id}/cover`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ filename: 'cover.png', mimeType: 'image/png', byteSize: 64 }),
    }, testEnv);
    expect(initiated.status).toBe(201);
    const upload = (await initiated.json<any>()).data;
    await testEnv.MEDIA_BUCKET.put(upload.objectKey, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2, 0]), { httpMetadata: { contentType: 'image/png' } });
    const finalized = await createApp().request(`/api/manage/events/${access.event.id}/cover/finalize`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ objectKey: upload.objectKey, mimeType: 'image/png' }),
    }, testEnv);
    expect(finalized.status).toBe(200);
    const cover = await createApp().request(`/api/event/${access.event.slug}/cover`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(cover.status).toBe(200);
    expect(cover.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps every delivery in intake, filters by guest name, and publishes separately', async () => {
    const access = await eventAccess();
    const avery = await uploadPending(access, 'review-1', null, 'Avery Stone');
    const jordan = await uploadPending(access, 'review-2', null, 'Jordan Lee');
    const all = await createApp().request(`/api/manage/events/${access.event.id}/media`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await all.json<any>()).data.media.map((item: any) => item.id)).toEqual(expect.arrayContaining([avery.id, jordan.id]));
    const filtered = await createApp().request(`/api/manage/events/${access.event.id}/media?guestName=avery`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await filtered.json<any>()).data.media.map((item: any) => item.id)).toEqual([avery.id]);

    const hiddenGallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await hiddenGallery.json<any>()).code).toBe('GALLERY_HIDDEN');

    await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ galleryVisible: true, uploadsEnabled: true, moderationRequired: true }),
    }, testEnv);
    const published = await createApp().request(`/api/manage/events/${access.event.id}/media/${avery.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    expect(published.status).toBe(200);
    expect((await published.json<any>()).data.media.publicationStatus).toBe('published');
    const gallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await gallery.json<any>()).data.media.map((item: any) => item.id)).toEqual([avery.id]);

    await createApp().request(`/api/manage/events/${access.event.id}/media/${avery.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'hide', expectedStatus: 'published' }),
    }, testEnv);
    const intakeAfterHide = await createApp().request(`/api/manage/events/${access.event.id}/media?status=hidden`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await intakeAfterHide.json<any>()).data.media.map((item: any) => item.id)).toEqual([avery.id]);
  });

  it('bulk-publishes only the selected unpublished items', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'bulk-1');
    const second = await uploadPending(access, 'bulk-2');
    const untouched = await uploadPending(access, 'bulk-3');
    const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ ids: [first.id, second.id], action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    expect(response.status).toBe(200);
    const rows = await env.DB.prepare('SELECT id, publication_status FROM media ORDER BY id').all<any>();
    const states = Object.fromEntries(rows.results.map((row: any) => [row.id, row.publication_status]));
    expect(states).toMatchObject({ [first.id]: 'published', [second.id]: 'published', [untouched.id]: 'unpublished' });
  });

  it('deletes the cached preview with an individual private original', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'delete-preview');
    const previewObjectKey = `events/${access.event.id}/previews/${media.id}.webp`;
    await testEnv.MEDIA_BUCKET.put(previewObjectKey, new Uint8Array([1, 2, 3]));
    await new MediaRepository(env.DB).setPreviewObjectKey(media.id, previewObjectKey);

    const deleted = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'delete', expectedStatus: 'unpublished' }),
    }, testEnv);

    expect(deleted.status).toBe(200);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();
    expect(await testEnv.MEDIA_BUCKET.head(previewObjectKey)).toBeNull();
  });
});

describe('access link rotation', () => {
  it('redisplays the active guest link without exposing it to guests', async () => {
    const access = await eventAccess();
    const response = await createApp().request(`/api/manage/events/${access.event.id}/links`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.guestLink).toBe(access.guestLink);

    const denied = await createApp().request(`/api/manage/events/${access.event.id}/links`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(denied.status).toBe(403);
  });

  it('rotates the guest link and invalidates every old guest session immediately', async () => {
    const access = await eventAccess();
    const rotated = await createApp().request(`/api/manage/events/${access.event.id}/links/guest/rotate`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const body = await rotated.json<any>();
    expect(body.data.guestLink).not.toBe(access.guestLink);

    const oldShell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await oldShell.json<any>()).code).toBe('TOKEN_REVOKED');

    const replacement = await secondGuest(body.data.guestLink);
    const newShell = await createApp().request(`/api/event/${access.event.slug}`, {
      headers: { cookie: replacement.cookie },
    }, testEnv);
    expect(newShell.status).toBe(200);
  });

  it('returns a one-time replacement management link and revokes the current manager session', async () => {
    const access = await eventAccess();
    const rotated = await createApp().request(`/api/manage/events/${access.event.id}/links/manager/rotate`, {
      method: 'POST', headers: writeHeaders(access.manager), body: '{}',
    }, testEnv);
    const body = await rotated.json<any>();
    expect(body.data.managementLink).not.toBe(access.managementLink);

    const oldManager = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await oldManager.json<any>()).code).toBe('TOKEN_REVOKED');
  });
});

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../worker/app';
import {
  eventAccess,
  resetDatabase,
  secondGuest,
  testEnv,
  uploadPending,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);

describe('manager settings and media moderation', () => {
  it('updates event toggles and exposes only approved media in the guest gallery', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'review-1');
    const pending = await createApp().request(`/api/manage/events/${access.event.id}/media?status=pending`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await pending.json<any>()).data.media.map((item: any) => item.id)).toContain(media.id);

    const hidden = await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ galleryVisible: false, uploadsEnabled: true, moderationRequired: true }),
    }, testEnv);
    expect(hidden.status).toBe(200);
    const hiddenGallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await hiddenGallery.json<any>()).code).toBe('GALLERY_HIDDEN');

    await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ galleryVisible: true, uploadsEnabled: true, moderationRequired: true }),
    }, testEnv);
    const approved = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
    }, testEnv);
    expect(approved.status).toBe(200);
    const gallery = await createApp().request(`/api/event/${access.event.slug}/gallery`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect((await gallery.json<any>()).data.media.map((item: any) => item.id)).toEqual([media.id]);
  });

  it('bulk-moderates only the selected pending items', async () => {
    const access = await eventAccess();
    const first = await uploadPending(access, 'bulk-1');
    const second = await uploadPending(access, 'bulk-2');
    const untouched = await uploadPending(access, 'bulk-3');
    const response = await createApp().request(`/api/manage/events/${access.event.id}/media/bulk`, {
      method: 'POST', headers: writeHeaders(access.manager),
      body: JSON.stringify({ ids: [first.id, second.id], action: 'approve', expectedStatus: 'pending' }),
    }, testEnv);
    expect(response.status).toBe(200);
    const rows = await env.DB.prepare('SELECT id, moderation_status FROM media ORDER BY id').all<any>();
    const states = Object.fromEntries(rows.results.map((row: any) => [row.id, row.moderation_status]));
    expect(states).toMatchObject({ [first.id]: 'approved', [second.id]: 'approved', [untouched.id]: 'pending' });
  });
});

describe('access link rotation', () => {
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


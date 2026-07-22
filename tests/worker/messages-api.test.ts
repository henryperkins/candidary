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

describe('guest notes and captions', () => {
  it('keeps a pending note private to its author until the manager approves it', async () => {
    const access = await eventAccess();
    const other = await secondGuest(access.guestLink);
    const created = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify({ guestName: 'Avery', body: 'What a perfect evening.' }),
    }, testEnv);
    const message = (await created.json<any>()).data.message;
    expect(message.moderationStatus).toBe('pending');

    const ownFeed = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const otherFeed = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      headers: { cookie: other.cookie },
    }, testEnv);
    expect((await ownFeed.json<any>()).data.items.map((item: any) => item.id)).toContain(message.id);
    expect((await otherFeed.json<any>()).data.items.map((item: any) => item.id)).not.toContain(message.id);

    const managerQueue = await createApp().request(`/api/manage/events/${access.event.id}/messages?status=pending`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    expect((await managerQueue.json<any>()).data.messages.map((item: any) => item.id)).toContain(message.id);
    await createApp().request(`/api/manage/events/${access.event.id}/messages/${message.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
    }, testEnv);
    const approvedFeed = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      headers: { cookie: other.cookie },
    }, testEnv);
    expect((await approvedFeed.json<any>()).data.items.map((item: any) => item.id)).toContain(message.id);
  });

  it('combines approved media captions with approved standalone notes chronologically', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'caption-1', 'The speeches had us crying.');
    await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
    }, testEnv);
    const note = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify({ guestName: 'Avery', body: 'And the dance floor was perfect.' }),
    }, testEnv);
    const noteId = (await note.json<any>()).data.message.id;
    await createApp().request(`/api/manage/events/${access.event.id}/messages/${noteId}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
    }, testEnv);

    const feed = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const items = (await feed.json<any>()).data.items;
    expect(items.map((item: any) => item.kind)).toEqual(['caption', 'message']);
    expect(items.map((item: any) => item.body)).toEqual([
      'The speeches had us crying.',
      'And the dance floor was perfect.',
    ]);
  });
});


import { beforeEach, describe, expect, it } from 'vitest';

import { GUEST_MESSAGE_PAGE_SIZE } from '../../shared/constants';
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
    const other = await secondGuest(access.eventLink);
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

  it('combines published media captions with approved standalone notes chronologically', async () => {
    const access = await eventAccess();
    const media = await uploadPending(access, 'caption-1', 'The speeches had us crying.');
    const published = await createApp().request(`/api/manage/events/${access.event.id}/media/${media.id}`, {
      method: 'PATCH', headers: writeHeaders(access.manager),
      body: JSON.stringify({ action: 'publish', expectedStatus: 'unpublished' }),
    }, testEnv);
    expect(published.status).toBe(200);
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

  it('uses a domain refusal when a note belongs to another event', async () => {
    const first = await eventAccess();
    const second = await eventAccess();
    const created = await createApp().request(`/api/event/${second.event.slug}/messages`, {
      method: 'POST',
      headers: writeHeaders(second.guest),
      body: JSON.stringify({ guestName: 'Avery', body: 'A note for the other event.' }),
    }, testEnv);
    const messageId = (await created.json<any>()).data.message.id;

    const response = await createApp().request(
      `/api/manage/events/${first.event.id}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: writeHeaders(first.manager),
        body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
      },
      testEnv,
    );

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('RESOURCE_FORBIDDEN');
  });

  it('replays one note idempotently and rejects a changed payload under the same key', async () => {
    const access = await eventAccess();
    const path = `/api/event/${access.event.slug}/messages`;
    const request = (body: string) => createApp().request(path, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        idempotencyKey: 'stable-note-key',
        guestName: 'Avery',
        body,
      }),
    }, testEnv);

    const first = await request('The first and only note.');
    const replay = await request('The first and only note.');
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    const firstBody = await first.json<any>();
    const replayBody = await replay.json<any>();
    expect(replayBody.data.replayed).toBe(true);
    expect(replayBody.data.message.id).toBe(firstBody.data.message.id);
    expect(await testEnv.DB.prepare(
      'SELECT COUNT(*) AS count FROM guest_messages WHERE event_id = ?',
    ).bind(access.event.id).first('count')).toBe(1);

    const conflict = await request('Different words under the same key.');
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json<any>();
    expect(conflictBody.code).toBe('MESSAGE_SUBMISSION_CONFLICT');
    expect(conflictBody.message).toBe('This note changed after an earlier send attempt. Send it again.');
  });

  it('returns a bounded chronological feed with an opaque earlier-page cursor', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(access.event.id).first<string>('id');
    expect(sessionId).toBeTruthy();
    const count = GUEST_MESSAGE_PAGE_SIZE + 2;
    await testEnv.DB.batch(Array.from({ length: count }, (_, index) => testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at
      ) VALUES (?, ?, ?, 'Avery', ?, 'pending', ?, ?)
    `).bind(
      crypto.randomUUID(),
      access.event.id,
      sessionId,
      `Note ${index}`,
      `key-${index}`,
      new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString(),
    )));

    const first = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const firstPage = (await first.json<any>()).data;
    expect(firstPage.items).toHaveLength(GUEST_MESSAGE_PAGE_SIZE);
    expect(firstPage.items[0].body).toBe('Note 2');
    expect(firstPage.items.at(-1).body).toBe(`Note ${count - 1}`);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await createApp().request(
      `/api/event/${access.event.slug}/messages?cursor=${encodeURIComponent(firstPage.nextCursor)}`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );
    const secondPage = (await second.json<any>()).data;
    expect(secondPage.items.map((item: any) => item.body)).toEqual(['Note 0', 'Note 1']);
    expect(secondPage.nextCursor).toBeNull();

    const invalid = await createApp().request(`/api/event/${access.event.slug}/messages?cursor=not-a-cursor`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(invalid.status).toBe(422);
    expect((await invalid.json<any>()).code).toBe('VALIDATION_FAILED');
  });
});

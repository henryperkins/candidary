import { beforeEach, describe, expect, it } from 'vitest';

import { GUEST_MESSAGE_PAGE_SIZE } from '../../shared/constants';
import { createApp } from '../../worker/app';
import { encodeGuestbookCursor } from '../../worker/http/guestbook-cursor';
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
  it('returns independently paginated shared and private streams for contract 2', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected a guest session fixture.');
    await testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at
      ) VALUES (?, ?, ?, 'Avery', 'Old private note', 'pending', 'private-old', ?)
    `).bind(
      '20000000-0000-4000-8000-000000000001',
      access.event.id,
      sessionId,
      '2026-09-19T19:00:00.000Z',
    ).run();
    await testEnv.DB.batch(Array.from({ length: GUEST_MESSAGE_PAGE_SIZE + 1 }, (_, index) => testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at
      ) VALUES (?, ?, ?, 'Avery', ?, 'approved', ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      access.event.id,
      sessionId,
      `Shared note ${index}`,
      `shared-${index}`,
      new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString(),
      new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString(),
    )));

    const response = await createApp().request(
      `/api/event/${access.event.slug}/messages?contract=2`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );

    expect(response.status).toBe(200);
    const data = (await response.json<any>()).data;
    expect(data.items).toHaveLength(GUEST_MESSAGE_PAGE_SIZE);
    expect(data.ownUnshared).toEqual([
      expect.objectContaining({
        id: '20000000-0000-4000-8000-000000000001',
        source: 'guest_note',
        visibility: 'author_only',
        isOwn: true,
      }),
    ]);
    expect(data.ownUnsharedCount).toBe(1);
    expect(data.ownUnsharedNextCursor).toBeNull();
    expect(data.nextCursor).toEqual(expect.any(String));

    const sharedContinuation = await createApp().request(
      `/api/event/${access.event.slug}/messages?contract=2&cursor=${encodeURIComponent(data.nextCursor)}`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );
    expect(sharedContinuation.status).toBe(200);
    const continued = (await sharedContinuation.json<any>()).data;
    expect(continued.ownUnshared).toEqual([]);
    expect(continued.ownUnsharedCount).toBe(1);
    expect(continued.ownUnsharedNextCursor).toBeNull();
  });

  it('advances only the requested contract-2 stream', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected a guest session fixture.');
    await testEnv.DB.batch(Array.from({ length: GUEST_MESSAGE_PAGE_SIZE + 2 }, (_, index) => testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at
      ) VALUES (?, ?, ?, 'Avery', ?, 'pending', ?, ?)
    `).bind(
      crypto.randomUUID(),
      access.event.id,
      sessionId,
      `Private note ${index}`,
      `private-page-${index}`,
      new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString(),
    )));

    const first = await createApp().request(
      `/api/event/${access.event.slug}/messages?contract=2`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );
    const firstPage = (await first.json<any>()).data;
    expect(firstPage.items).toEqual([]);
    expect(firstPage.ownUnshared).toHaveLength(GUEST_MESSAGE_PAGE_SIZE);
    expect(firstPage.ownUnsharedCount).toBe(GUEST_MESSAGE_PAGE_SIZE + 2);
    expect(firstPage.ownUnsharedNextCursor).toEqual(expect.any(String));

    const next = await createApp().request(
      `/api/event/${access.event.slug}/messages?contract=2&ownCursor=${encodeURIComponent(firstPage.ownUnsharedNextCursor)}`,
      { headers: { cookie: access.guest.cookie } },
      testEnv,
    );
    const nextPage = (await next.json<any>()).data;
    expect(nextPage.items).toEqual([]);
    expect(nextPage.nextCursor).toBeNull();
    expect(nextPage.ownUnshared).toHaveLength(2);
    expect(nextPage.ownUnsharedCount).toBe(GUEST_MESSAGE_PAGE_SIZE + 2);
    expect(nextPage.ownUnsharedNextCursor).toBeNull();
  });

  it('rejects contract-2 cursors for the wrong stream, session, or event', async () => {
    const access = await eventAccess();
    const otherGuest = await secondGuest(access.eventLink);
    const otherEvent = await eventAccess('Rowan & Sky');
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      ORDER BY created_at ASC LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected the first guest session fixture.');
    const sharedCursor = await encodeGuestbookCursor({
      version: 2,
      audience: 'guest',
      stream: 'shared',
      eventId: access.event.id,
      sessionId,
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 0,
      id: '70000000-0000-4000-8000-000000000001',
    }, testEnv.SESSION_HMAC_KEY);
    const requests = [
      createApp().request(
        `/api/event/${access.event.slug}/messages?contract=2&cursor=${encodeURIComponent(sharedCursor)}`,
        { headers: { cookie: otherGuest.cookie } }, testEnv,
      ),
      createApp().request(
        `/api/event/${otherEvent.event.slug}/messages?contract=2&cursor=${encodeURIComponent(sharedCursor)}`,
        { headers: { cookie: otherEvent.guest.cookie } }, testEnv,
      ),
      createApp().request(
        `/api/event/${access.event.slug}/messages?contract=2&ownCursor=${encodeURIComponent(sharedCursor)}`,
        { headers: { cookie: access.guest.cookie } }, testEnv,
      ),
      createApp().request(
        `/api/event/${access.event.slug}/messages?contract=2&cursor=${encodeURIComponent(sharedCursor)}&ownCursor=${encodeURIComponent(sharedCursor)}`,
        { headers: { cookie: access.guest.cookie } }, testEnv,
      ),
    ];
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(422);
      expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('keeps legacy first pages and continuations on version-1 ordering and cursor payloads', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected a guest session fixture.');
    await testEnv.DB.batch(Array.from({ length: 101 }, (_, index) => testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at
      ) VALUES (?, ?, ?, 'Avery', ?, 'approved', ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      access.event.id,
      sessionId,
      `Legacy ${index}`,
      `legacy-${index}`,
      new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString(),
      new Date(Date.UTC(2026, 8, 19, 20, 0, index)).toISOString(),
    )));

    const page = async (cursor?: string) => {
      const response = await createApp().request(
        `/api/event/${access.event.slug}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        { headers: { cookie: access.guest.cookie } },
        testEnv,
      );
      expect(response.status).toBe(200);
      return (await response.json<any>()).data;
    };
    const decodePayload = (cursor: string) => JSON.parse(atob(
      cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(cursor.length / 4) * 4, '='),
    ));
    const first = await page();
    expect(Object.keys(decodePayload(first.nextCursor)).sort()).toEqual(['createdAt', 'id']);
    const second = await page(first.nextCursor);
    expect(Object.keys(decodePayload(second.nextCursor)).sort()).toEqual(['createdAt', 'id']);
    const third = await page(second.nextCursor);
    expect(third.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items, ...third.items].map((item: any) => item.id)).size).toBe(101);
  });

  it('returns safe note projections from guest and Manager compatibility routes', async () => {
    const access = await eventAccess();
    const created = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        guestName: 'Avery',
        body: 'Safe response only.',
        idempotencyKey: 'never-return-this-key',
      }),
    }, testEnv);
    const createdData = (await created.json<any>()).data;
    expect(createdData.item).toMatchObject({
      source: 'guest_note', state: 'pending', visibility: 'author_only', isOwn: true,
    });
    expect(createdData.message).toEqual({
      id: createdData.item.id,
      kind: 'message',
      guestName: 'Avery',
      body: 'Safe response only.',
      createdAt: createdData.item.createdAt,
      moderationStatus: 'pending',
      mediaId: null,
    });

    const listed = await createApp().request(`/api/manage/events/${access.event.id}/messages?status=pending`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const listedBody = await listed.json<any>();
    expect(listedBody.data.messages).toEqual([{
      id: createdData.item.id,
      source: 'guest_note',
      guestName: 'Avery',
      body: 'Safe response only.',
      createdAt: createdData.item.createdAt,
      state: 'pending',
      visibility: 'author_only',
    }]);

    const patched = await createApp().request(
      `/api/manage/events/${access.event.id}/messages/${createdData.item.id}`,
      {
        method: 'PATCH',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ action: 'approve', expectedStatus: 'pending' }),
      },
      testEnv,
    );
    const patchedBody = await patched.json<any>();
    expect(patchedBody.data.item).toMatchObject({
      id: createdData.item.id,
      state: 'approved',
      visibility: 'shared',
    });
    expect(JSON.stringify([createdData, listedBody, patchedBody]))
      .not.toMatch(/guestSessionId|guest_session_id|idempotencyKey|idempotency_key/u);
  });

  it('serves all four Manager guestbook views and refuses a cursor bound to another view', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected a guest session fixture.');
    const rows = [
      ['80000000-0000-4000-8000-000000000001', 'pending', null],
      ['80000000-0000-4000-8000-000000000002', 'approved', null],
      ['80000000-0000-4000-8000-000000000003', 'rejected', null],
      ['80000000-0000-4000-8000-000000000004', 'rejected', '2026-09-19T21:00:00.000Z'],
    ] as const;
    await testEnv.DB.batch(rows.map(([id, state, deletedAt], index) => testEnv.DB.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at, deleted_at
      ) VALUES (?, ?, ?, 'Avery', ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      access.event.id,
      sessionId,
      `Manager route ${state}`,
      state,
      `manager-route-${index}`,
      `2026-09-19T20:00:0${index}.000Z`,
      state === 'approved' ? `2026-09-19T20:00:0${index}.000Z` : null,
      deletedAt,
    )));
    const expected = {
      'needs-review': '80000000-0000-4000-8000-000000000001',
      shared: '80000000-0000-4000-8000-000000000002',
      hidden: '80000000-0000-4000-8000-000000000003',
      deleted: '80000000-0000-4000-8000-000000000004',
    } as const;

    for (const [view, id] of Object.entries(expected)) {
      const response = await createApp().request(
        `/api/manage/events/${access.event.id}/guestbook?view=${view}&source=guest_note`,
        { headers: { cookie: access.manager.cookie } },
        testEnv,
      );
      expect([view, response.status]).toEqual([view, 200]);
      const data = (await response.json<any>()).data;
      expect(data.items.map((item: any) => item.id)).toEqual([id]);
      expect(data.summary).toMatchObject({
        needsReviewCount: 1,
        sharedCount: 1,
        hiddenCount: 1,
        deletedCount: 1,
      });
    }

    const wrongViewCursor = await encodeGuestbookCursor({
      version: 2,
      audience: 'manager',
      eventId: access.event.id,
      view: 'shared',
      source: 'guest_note',
      createdAt: '2026-09-19T20:00:00.000Z',
      sourceRank: 0,
      id: '80000000-0000-4000-8000-000000000002',
    }, testEnv.SESSION_HMAC_KEY);
    const rejected = await createApp().request(
      `/api/manage/events/${access.event.id}/guestbook?view=hidden&source=guest_note&cursor=${encodeURIComponent(wrongViewCursor)}`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect(rejected.status).toBe(422);
    expect((await rejected.json<any>()).code).toBe('VALIDATION_FAILED');
  });

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

  it('fails legacy caption visibility closed when the gallery is off', async () => {
    const access = await eventAccess();
    const other = await secondGuest(access.eventLink);
    const media = await uploadPending(access, 'legacy-gallery-off', 'Only the uploader may read this.');
    await testEnv.DB.prepare(`
      UPDATE media SET publication_status = 'published', published_at = created_at WHERE id = ?
    `).bind(media.id).run();
    await testEnv.DB.prepare('UPDATE events SET gallery_visible = 0 WHERE id = ?')
      .bind(access.event.id).run();

    const own = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    const others = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      headers: { cookie: other.cookie },
    }, testEnv);
    expect((await own.json<any>()).data.items).toContainEqual(expect.objectContaining({
      id: media.id,
      kind: 'caption',
      moderationStatus: 'rejected',
    }));
    expect((await others.json<any>()).data.items.map((item: any) => item.id)).not.toContain(media.id);
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

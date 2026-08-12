import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GUEST_MESSAGE_PAGE_SIZE, MAX_EVENT_GUEST_NOTES } from '../../shared/constants';
import { createApp } from '../../worker/app';
import { encodeGuestbookCursor } from '../../worker/http/guestbook-cursor';
import {
  eventAccess,
  batchD1Statements,
  resetDatabase,
  secondGuest,
  testEnv,
  uploadPending,
  withGuestMessageRateLimit,
  writeHeaders,
} from './helpers';

beforeEach(resetDatabase);
afterEach(() => vi.useRealTimers());

describe('guest notes and captions', () => {
  it('refuses at the event-and-trusted-IP edge boundary after auth but before body parsing', async () => {
    const access = await eventAccess();
    const edge = withGuestMessageRateLimit(() => false);

    const response = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: {
        ...writeHeaders(access.guest),
        'CF-Connecting-IP': '203.0.113.42',
        'X-Forwarded-For': '198.51.100.200',
      },
      body: 'not json at all',
    }, edge.env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json<any>()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(edge.keys).toHaveLength(1);
    expect(edge.keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(edge.keys[0]).not.toContain('203.0.113.42');
    expect(edge.keys[0]).not.toContain('198.51.100.200');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM guest_message_rate_events')
      .first('count')).toBe(0);
  });

  it('requires and normalizes the bounded idempotency key, body, and optional name', async () => {
    const access = await eventAccess();
    const path = `/api/event/${access.event.slug}/messages`;
    const send = (payload: unknown) => createApp().request(path, {
      method: 'POST',
      headers: { ...writeHeaders(access.guest), 'CF-Connecting-IP': '203.0.113.43' },
      body: JSON.stringify(payload),
    }, testEnv);

    for (const payload of [
      { body: 'Missing key.', guestName: null },
      { idempotencyKey: '   ', body: 'Blank key.', guestName: null },
      { idempotencyKey: 'k'.repeat(129), body: 'Long key.', guestName: null },
      { idempotencyKey: 'blank-body', body: '   ', guestName: null },
      { idempotencyKey: 'long-body', body: 'b'.repeat(501), guestName: null },
      { idempotencyKey: 'long-name', body: 'Hello.', guestName: 'n'.repeat(81) },
    ]) {
      const response = await send(payload);
      expect(response.status).toBe(422);
      expect((await response.json<any>()).code).toBe('VALIDATION_FAILED');
    }

    const normalized = await send({
      idempotencyKey: '  normalized-key  ',
      guestName: '   ',
      body: '  Safely trimmed.  ',
    });
    expect(normalized.status).toBe(201);
    expect((await normalized.json<any>()).data.item).toMatchObject({
      guestName: null,
      body: 'Safely trimmed.',
    });
    expect(await testEnv.DB.prepare(`
      SELECT idempotency_key, guest_name, body FROM guest_messages WHERE event_id = ?
    `).bind(access.event.id).first()).toEqual({
      idempotency_key: 'normalized-key',
      guest_name: null,
      body: 'Safely trimmed.',
    });
  });

  it('admits five new notes per session window and resets exactly at the fixed boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-12T12:00:01.000Z'));
    const access = await eventAccess();
    const send = (key: string) => createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: {
        ...writeHeaders(access.guest),
        'CF-Connecting-IP': '203.0.113.50',
      },
      body: JSON.stringify({ idempotencyKey: key, guestName: 'Avery', body: `Note ${key}.` }),
    }, testEnv);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await send(`session-${attempt}`)).status).toBe(201);
    }
    const refused = await send('session-6');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('899');
    expect((await refused.json<any>()).code).toBe('RATE_LIMITED');

    vi.setSystemTime(new Date('2026-08-12T12:15:00.000Z'));
    expect((await send('session-next-window')).status).toBe(201);
    const windows = await testEnv.DB.prepare(`
      SELECT window_started_at, COUNT(*) AS count
      FROM guest_message_rate_events WHERE event_id = ?
      GROUP BY window_started_at ORDER BY window_started_at
    `).bind(access.event.id).all<{ window_started_at: string; count: number }>();
    expect(windows.results).toEqual([
      { window_started_at: '2026-08-12T12:00:00.000Z', count: 5 },
      { window_started_at: '2026-08-12T12:15:00.000Z', count: 1 },
    ]);
  });

  it('keeps the 120-note trusted-IP budget across guest-session re-entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-12T12:05:00.000Z'));
    const access = await eventAccess();
    const ip = '203.0.113.51';
    const send = (
      guest: { cookie: string; csrf: string },
      key: string,
    ) => createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: { ...writeHeaders(guest), 'CF-Connecting-IP': ip },
      body: JSON.stringify({ idempotencyKey: key, guestName: null, body: `Note ${key}.` }),
    }, testEnv);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await send(access.guest, `first-session-${attempt}`)).status).toBe(201);
    }
    const storedScope = await testEnv.DB.prepare(`
      SELECT ip_scope_digest, window_started_at FROM guest_message_rate_events
      WHERE event_id = ? LIMIT 1
    `).bind(access.event.id).first<{ ip_scope_digest: string; window_started_at: string }>();
    if (!storedScope) throw new Error('Expected a stored trusted-IP scope.');
    expect(storedScope.ip_scope_digest).not.toContain(ip);
    await testEnv.DB.batch(Array.from({ length: 115 }, (_, index) => testEnv.DB.prepare(`
      INSERT INTO guest_message_rate_events (
        id, event_id, session_scope_digest, ip_scope_digest, window_started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), access.event.id, `other-session-${index}`,
      storedScope.ip_scope_digest, storedScope.window_started_at,
      '2026-08-12T12:05:00.000Z',
    )));

    const reentered = await secondGuest(access.eventLink);
    const refused = await send(reentered, 'reentered-session');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBe('600');
    expect((await refused.json<any>()).code).toBe('RATE_LIMITED');
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_message_rate_events
      WHERE event_id = ? AND ip_scope_digest = ? AND window_started_at = ?
    `).bind(
      access.event.id, storedScope.ip_scope_digest, storedScope.window_started_at,
    ).first('count')).toBe(120);
  });

  it('allows reads and exact replays after photo intake closes but refuses genuinely new notes', async () => {
    const access = await eventAccess();
    const path = `/api/event/${access.event.slug}/messages`;
    const send = (key: string, body: string) => createApp().request(path, {
      method: 'POST',
      headers: {
        ...writeHeaders(access.guest),
        'CF-Connecting-IP': '203.0.113.52',
      },
      body: JSON.stringify({ idempotencyKey: key, guestName: 'Avery', body }),
    }, testEnv);

    expect((await send('phase-replay', 'Created while open.')).status).toBe(201);
    await testEnv.DB.prepare(`
      UPDATE events SET uploads_enabled = 0, photos_open_from = NULL WHERE id = ?
    `).bind(access.event.id).run();

    expect((await send('phase-replay', 'Created while open.')).status).toBe(200);
    const changed = await send('phase-replay', 'Changed after closing.');
    expect(changed.status).toBe(409);
    expect((await changed.json<any>()).code).toBe('MESSAGE_SUBMISSION_CONFLICT');
    const refused = await send('phase-new', 'A genuinely new note.');
    expect(refused.status).toBe(409);
    expect((await refused.json<any>()).code).toBe('EVENT_PHASE_CONFLICT');

    const read = await createApp().request(`${path}?contract=2`, {
      headers: { cookie: access.guest.cookie },
    }, testEnv);
    expect(read.status).toBe(200);
    expect((await read.json<any>()).data.ownUnshared).toEqual([
      expect.objectContaining({ body: 'Created while open.' }),
    ]);
  });

  it('keeps the phase predicate inside the authoritative D1 creation batch', async () => {
    const access = await eventAccess();
    let raced = false;
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target.prepare(`
                UPDATE events SET uploads_enabled = 0, photos_open_from = NULL WHERE id = ?
              `).bind(access.event.id).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = Object.create(testEnv) as typeof testEnv;
    Object.defineProperty(env, 'DB', { value: db });

    const response = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: {
        ...writeHeaders(access.guest),
        'CF-Connecting-IP': '203.0.113.53',
      },
      body: JSON.stringify({
        idempotencyKey: 'phase-race', guestName: null, body: 'The pause wins.',
      }),
    }, env);

    expect(raced).toBe(true);
    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('EVENT_PHASE_CONFLICT');
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_messages WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(0);
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_message_rate_events WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(0);
  });

  it('counts soft-deleted rows toward the 1,000-note retained event cap', async () => {
    const access = await eventAccess();
    const sessionId = await testEnv.DB.prepare(`
      SELECT id FROM event_sessions
      WHERE event_id = ? AND role = 'guest' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(access.event.id).first<string>('id');
    if (!sessionId) throw new Error('Expected a guest session fixture.');
    await batchD1Statements(testEnv.DB, Array.from({ length: MAX_EVENT_GUEST_NOTES }, (_, index) => (
      testEnv.DB.prepare(`
        INSERT INTO guest_messages (
          id, event_id, guest_session_id, guest_name, body, moderation_status,
          idempotency_key, created_at, deleted_at
        ) VALUES (?, ?, ?, NULL, ?, 'rejected', ?, ?, ?)
      `).bind(
        crypto.randomUUID(), access.event.id, sessionId, `Retained ${index}`,
        `retained-${index}`, new Date(Date.UTC(2026, 7, 12, 0, 0, 0, index)).toISOString(),
        index % 2 === 0 ? '2026-08-12T01:00:00.000Z' : null,
      )
    )));

    const response = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: {
        ...writeHeaders(access.guest),
        'CF-Connecting-IP': '203.0.113.54',
      },
      body: JSON.stringify({
        idempotencyKey: 'over-event-cap', guestName: null, body: 'One note too many.',
      }),
    }, testEnv);

    expect(response.status).toBe(409);
    expect((await response.json<any>()).code).toBe('MESSAGE_EVENT_LIMIT');
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_messages WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(MAX_EVENT_GUEST_NOTES);
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_message_rate_events WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(0);
  });

  it('state-guards approve, reject, delete, and restore with compatible expected-state fields', async () => {
    const access = await eventAccess();
    const created = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        idempotencyKey: 'state-actions', guestName: 'Avery', body: 'Guard every transition.',
      }),
    }, testEnv);
    const id = (await created.json<any>()).data.item.id as string;
    const patch = (payload: unknown) => createApp().request(
      `/api/manage/events/${access.event.id}/messages/${id}`,
      { method: 'PATCH', headers: writeHeaders(access.manager), body: JSON.stringify(payload) },
      testEnv,
    );

    const approved = await patch({ action: 'approve', expectedState: 'pending' });
    expect(approved.status).toBe(200);
    expect((await approved.json<any>()).data.item).toMatchObject({ state: 'approved' });

    const stale = await patch({ action: 'reject', expectedState: 'pending' });
    expect(stale.status).toBe(409);
    expect((await stale.json<any>()).code).toBe('MESSAGE_STATE_CONFLICT');

    const rejectedCompat = await patch({ action: 'reject', expectedStatus: 'approved' });
    expect(rejectedCompat.status).toBe(200);
    expect((await rejectedCompat.json<any>()).data.item).toMatchObject({ state: 'rejected' });

    const contradictory = await patch({
      action: 'delete', expectedState: 'rejected', expectedStatus: 'approved',
    });
    expect(contradictory.status).toBe(422);
    expect((await contradictory.json<any>()).code).toBe('VALIDATION_FAILED');

    const deletedCompat = await patch({ action: 'delete', expectedStatus: 'rejected' });
    expect(deletedCompat.status).toBe(200);
    expect((await deletedCompat.json<any>()).data.item).toMatchObject({
      state: 'deleted', visibility: 'host_only',
    });

    const restored = await patch({ action: 'restore', expectedState: 'deleted' });
    expect(restored.status).toBe(200);
    expect((await restored.json<any>()).data.item).toMatchObject({
      state: 'rejected', visibility: 'author_only',
    });
    expect(await testEnv.DB.prepare(`
      SELECT moderation_status, approved_at, deleted_at FROM guest_messages WHERE id = ?
    `).bind(id).first()).toEqual({
      moderation_status: 'rejected', approved_at: null, deleted_at: null,
    });
  });

  it('hard-deletes through a minimal tombstone and refuses every stale replay without charging', async () => {
    const access = await eventAccess();
    const path = `/api/event/${access.event.slug}/messages`;
    const submit = (body: string) => createApp().request(path, {
      method: 'POST',
      headers: {
        ...writeHeaders(access.guest),
        'CF-Connecting-IP': '203.0.113.55',
      },
      body: JSON.stringify({ idempotencyKey: 'purged-note', guestName: 'Avery', body }),
    }, testEnv);
    const created = await submit('Remove this forever.');
    const item = (await created.json<any>()).data.item;
    const mutate = (payload: unknown) => createApp().request(
      `/api/manage/events/${access.event.id}/messages/${item.id}`,
      { method: 'PATCH', headers: writeHeaders(access.manager), body: JSON.stringify(payload) },
      testEnv,
    );
    expect((await mutate({ action: 'delete', expectedState: 'pending' })).status).toBe(200);

    const purged = await mutate({ action: 'purge', expectedState: 'deleted' });
    expect(purged.status).toBe(200);
    expect((await purged.json<any>()).data).toEqual({
      purged: { source: 'guest_note', id: item.id },
    });
    expect(await testEnv.DB.prepare('SELECT id FROM guest_messages WHERE id = ?')
      .bind(item.id).first()).toBeNull();
    const receipt = await testEnv.DB.prepare(`
      SELECT event_id, guest_session_id, idempotency_key, request_hmac, purged_at
      FROM guest_message_purge_receipts WHERE event_id = ?
    `).bind(access.event.id).first<any>();
    expect(receipt).toMatchObject({
      event_id: access.event.id,
      idempotency_key: 'purged-note',
      request_hmac: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      purged_at: expect.any(String),
    });
    expect(receipt.guest_session_id).toEqual(expect.any(String));

    const same = await submit('Remove this forever.');
    expect(same.status).toBe(410);
    expect((await same.json<any>()).code).toBe('MESSAGE_PURGED');
    const changed = await submit('Changed stale content.');
    expect(changed.status).toBe(409);
    expect((await changed.json<any>()).code).toBe('MESSAGE_SUBMISSION_CONFLICT');
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_message_rate_events WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(1);
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_messages WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(0);
  });

  it('rolls back the purge receipt when the guarded hard delete fails', async () => {
    const access = await eventAccess();
    const created = await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST', headers: writeHeaders(access.guest),
      body: JSON.stringify({
        idempotencyKey: 'atomic-purge', guestName: null, body: 'Keep me if deletion fails.',
      }),
    }, testEnv);
    const id = (await created.json<any>()).data.item.id as string;
    const mutate = (payload: unknown) => createApp().request(
      `/api/manage/events/${access.event.id}/messages/${id}`,
      { method: 'PATCH', headers: writeHeaders(access.manager), body: JSON.stringify(payload) },
      testEnv,
    );
    expect((await mutate({ action: 'delete', expectedState: 'pending' })).status).toBe(200);
    await testEnv.DB.prepare(`
      CREATE TRIGGER task3_refuse_message_purge
      BEFORE DELETE ON guest_messages
      BEGIN
        SELECT RAISE(ABORT, 'forced purge failure');
      END;
    `).run();

    const failed = await mutate({ action: 'purge', expectedState: 'deleted' });
    expect(failed.status).toBe(500);
    expect(await testEnv.DB.prepare('SELECT deleted_at FROM guest_messages WHERE id = ?')
      .bind(id).first('deleted_at')).toEqual(expect.any(String));
    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM guest_message_purge_receipts WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(0);
  });

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
      body: JSON.stringify({
        idempotencyKey: 'pending-private-note', guestName: 'Avery', body: 'What a perfect evening.',
      }),
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
      body: JSON.stringify({
        idempotencyKey: 'caption-combination-note',
        guestName: 'Avery',
        body: 'And the dance floor was perfect.',
      }),
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
      body: JSON.stringify({
        idempotencyKey: 'other-event-note', guestName: 'Avery', body: 'A note for the other event.',
      }),
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
    const edge = withGuestMessageRateLimit();
    const path = `/api/event/${access.event.slug}/messages`;
    const request = (body: string) => createApp().request(path, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        idempotencyKey: 'stable-note-key',
        guestName: 'Avery',
        body,
      }),
    }, edge.env);

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
    expect(await testEnv.DB.prepare(
      'SELECT COUNT(*) AS count FROM guest_message_rate_events WHERE event_id = ?',
    ).bind(access.event.id).first('count')).toBe(1);

    const conflict = await request('Different words under the same key.');
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json<any>();
    expect(conflictBody.code).toBe('MESSAGE_SUBMISSION_CONFLICT');
    expect(conflictBody.message).toBe('This note changed after an earlier send attempt. Send it again.');
    expect(await testEnv.DB.prepare(
      'SELECT COUNT(*) AS count FROM guest_message_rate_events WHERE event_id = ?',
    ).bind(access.event.id).first('count')).toBe(1);
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

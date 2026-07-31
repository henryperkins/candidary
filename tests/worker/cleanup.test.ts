import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { MediaRepository } from '../../worker/db/media';
import {
  cleanupAuthScratch,
  cleanupExpiredReservations,
  cleanupRsvpScratch,
  deleteEventData,
} from '../../worker/workflows/cleanup';
import worker from '../../worker/index';
import {
  eventAccess,
  importRoster,
  openRsvp,
  png,
  resetDatabase,
  testEnv,
  writeHeaders,
} from './helpers';

const ROSTER = [
  'household_key,household_label,invitee_name,plus_one_slots',
  'perkins,Perkins household,Henry Perkins,1',
  'rivera,Rivera household,Avery Rivera,0',
].join('\n');

type Access = Awaited<ReturnType<typeof eventAccess>>;

// Opens a real household session so a sweep or a purge is measured against the
// rows the product actually creates rather than hand-written fixtures.
async function householdSession(access: Access, firstName: string) {
  const response = await createApp().request(`/api/event/${access.event.slug}/rsvp/lookup`, {
    method: 'POST',
    headers: writeHeaders(access.guest),
    body: JSON.stringify({ firstName }),
  }, testEnv);
  const body = await response.json<any>();
  if (body.data?.status !== 'matched') {
    throw new Error(`Lookup fixture did not match: ${JSON.stringify(body)}`);
  }
  return body.data.household as { id: string; version: number };
}

async function rsvpReady(uploadsEnabled = true) {
  const access = await eventAccess('Maya & Theo', uploadsEnabled);
  await importRoster(access, ROSTER);
  await openRsvp(access);
  return access;
}

async function foreignKeyCheck() {
  return (await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results;
}

async function countRows(table: string, eventId: string) {
  const row = await testEnv.DB.prepare(`SELECT count(*) AS count FROM ${table} WHERE event_id = ?`)
    .bind(eventId).first<{ count: number }>();
  return row?.count ?? 0;
}

describe('lifecycle cleanup', () => {
  beforeEach(resetDatabase);

  it('removes expired reserved objects and releases event quota', async () => {
    const access = await eventAccess();
    const repository = new MediaRepository(testEnv.DB);
    const media = await repository.reserve({
      id: crypto.randomUUID(), eventId: access.event.id, uploaderSessionId: (await new AuthService(testEnv).resolve(access.guest.cookie.split('=')[1]!.split(';')[0])).session.id,
      objectKey: `events/${access.event.id}/media/stale`, originalFilename: 'stale.png', mimeType: 'image/png',
      declaredByteSize: 64, guestName: 'Avery', caption: null, idempotencyKey: 'stale',
      reservationExpiresAt: '2026-07-21T12:00:00.000Z', createdAt: '2026-07-21T11:45:00.000Z',
    });
    await testEnv.MEDIA_BUCKET.put(media.objectKey, png());
    expect(await cleanupExpiredReservations(testEnv, new Date('2026-07-21T12:01:00.000Z'))).toBe(1);
    expect(await testEnv.MEDIA_BUCKET.head(media.objectKey)).toBeNull();
    const event = await testEnv.DB.prepare('SELECT reserved_media_count FROM events WHERE id = ?').bind(access.event.id).first<any>();
    expect(event.reserved_media_count).toBe(0);
  });

  it('marks an event inaccessible, clears its prefix, then removes the row', async () => {
    const access = await eventAccess();
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/media/orphan`, png());
    await deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z'));
    const rows = await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` });
    expect(rows.objects).toHaveLength(0);
    // The row itself is gone, so nothing about the event survives the purge.
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    const tokens = await testEnv.DB.prepare('SELECT count(*) AS count FROM event_access_tokens WHERE event_id = ?').bind(access.event.id).first<any>();
    expect(tokens.count).toBe(0);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('purges an event that still holds stored media and a guest note', async () => {
    const access = await rsvpReady();
    const initiated = await createApp().request(`/api/event/${access.event.slug}/uploads`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({
        filename: 'keeper.png', mimeType: 'image/png', byteSize: 128,
        idempotencyKey: 'keeper', guestName: 'Avery', caption: null,
      }),
    }, testEnv);
    const media = (await initiated.json<any>()).data.media;
    await testEnv.MEDIA_BUCKET.put(media.objectKey, png(), { httpMetadata: { contentType: 'image/png' } });
    await createApp().request(`/api/event/${access.event.slug}/uploads/${media.id}/finalize`, {
      method: 'POST', headers: writeHeaders(access.guest), body: '{}',
    }, testEnv);
    await createApp().request(`/api/event/${access.event.slug}/messages`, {
      method: 'POST',
      headers: writeHeaders(access.guest),
      body: JSON.stringify({ guestName: 'Avery', body: 'A lovely evening.' }),
    }, testEnv);
    await householdSession(access, 'Henry Perkins');

    // `media` and `guest_messages` reference event sessions with ON DELETE
    // RESTRICT, so deleting the event without clearing them first would fail.
    await deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z'));

    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    for (const table of ['media', 'guest_messages', 'rsvp_households', 'rsvp_invitees', 'rsvp_sessions', 'event_entry_credentials']) {
      expect(await countRows(table, access.event.id), `${table} rows after purge`).toBe(0);
    }
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('keeps a soft-deleted event for a later pass when object deletion fails', async () => {
    const access = await eventAccess();
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/media/orphan`, png());
    const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('R2 unavailable'));

    await expect(deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z')))
      .rejects.toThrow();
    failing.mockRestore();

    // Marked deleted and revoked, but still discoverable — never a hard delete
    // that would strand objects nothing can find again.
    const event = await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(access.event.id).first<any>();
    expect(event.deleted_at).toBeTruthy();
    const tokens = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM event_access_tokens WHERE event_id = ? AND revoked_at IS NULL
    `).bind(access.event.id).first<any>();
    expect(tokens.count).toBe(0);

    // The next scheduled pass retries the same row rather than orphaning it.
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind('2026-07-21T11:00:00.000Z', access.event.id).run();
    const scheduled: Promise<unknown>[] = [];
    worker.scheduled!(
      { cron: '0 0 * * *', scheduledTime: Date.parse('2026-07-21T12:30:00.000Z') } as ScheduledController,
      testEnv,
      { waitUntil: (promise: Promise<unknown>) => scheduled.push(promise), passThroughOnException() {} } as unknown as ExecutionContext,
    );
    await Promise.all(scheduled);

    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect((await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` })).objects)
      .toHaveLength(0);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('sweeps expired and revoked RSVP sessions and stale rate windows in bounded passes', async () => {
    const access = await rsvpReady();
    const live = await householdSession(access, 'Henry Perkins');

    // One live session, plus more scratch than a single 100-row pass can drain.
    const statements = [];
    for (let index = 0; index < 120; index += 1) {
      statements.push(testEnv.DB.prepare(`
        INSERT INTO rsvp_sessions (
          id, secret_digest, csrf_digest, event_id, household_id,
          write_authority_deadline, expires_at, revoked_at, created_at
        ) VALUES (?, 'digest', 'csrf', ?, ?, ?, ?, ?, ?)
      `).bind(
        crypto.randomUUID(),
        access.event.id,
        live.id,
        '2026-07-21T12:00:00.000Z',
        index % 2 === 0 ? '2026-07-21T11:00:00.000Z' : '2027-01-01T00:00:00.000Z',
        index % 2 === 0 ? null : '2026-07-21T11:30:00.000Z',
        '2026-07-21T10:00:00.000Z',
      ));
      statements.push(testEnv.DB.prepare(`
        INSERT INTO rsvp_lookup_rate_limits (
          event_id, action, scope_digest, window_started_at, attempts
        ) VALUES (?, 'lookup_ip', ?, ?, 1)
      `).bind(
        access.event.id,
        `digest-${index}`,
        index === 0 ? '2026-07-21T12:00:00.000Z' : '2026-07-21T11:00:00.000Z',
      ));
    }
    await testEnv.DB.batch(statements);

    const swept = await cleanupRsvpScratch(testEnv, new Date('2026-07-21T12:15:00.000Z'));

    expect(swept).toEqual({ sessions: 120, rateLimits: 119 });
    // The live session and the current window are untouched.
    const sessions = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM rsvp_sessions WHERE event_id = ?
    `).bind(access.event.id).first<any>();
    expect(sessions.count).toBe(1);
    const windows = await testEnv.DB.prepare(`
      SELECT scope_digest, window_started_at FROM rsvp_lookup_rate_limits WHERE event_id = ?
    `).bind(access.event.id).all<any>();
    // The current window survives; every row older than one window is gone. The
    // real lookup above also charged its own current-window rows, which is why
    // this asserts the boundary rather than an exact row count.
    expect(windows.results.some((row: any) => row.scope_digest === 'digest-0')).toBe(true);
    expect(windows.results.every((row: any) => row.window_started_at >= '2026-07-21T12:00:00.000Z'))
      .toBe(true);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('revokes but never deletes household data when the printed entry is disabled', async () => {
    const access = await rsvpReady();
    await householdSession(access, 'Henry Perkins');

    const disabled = await createApp().request(
      `/api/manage/events/${access.event.id}/entry/disable`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({ confirmName: access.event.name }),
      },
      testEnv,
    );
    expect(disabled.status).toBe(200);

    const live = await testEnv.DB.prepare(`
      SELECT count(*) AS count FROM rsvp_sessions WHERE event_id = ? AND revoked_at IS NULL
    `).bind(access.event.id).first<any>();
    expect(live.count).toBe(0);
    expect(await countRows('rsvp_households', access.event.id)).toBe(2);
    expect(await countRows('rsvp_invitees', access.event.id)).toBe(3);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('keeps an archived household in the roster until the event is purged', async () => {
    const access = await rsvpReady();
    const listed = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/households`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    const household = (await listed.json<any>()).data.households
      .find((row: any) => row.householdKey === 'rivera');
    const current = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const rosterVersion = (await current.json<any>()).data.event.rsvpRosterVersion;

    const archived = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/households/${household.id}/archive`,
      {
        method: 'POST',
        headers: writeHeaders(access.manager),
        body: JSON.stringify({
          expectedVersion: household.version,
          expectedRosterVersion: rosterVersion,
        }),
      },
      testEnv,
    );
    expect(archived.status).toBe(200);

    expect(await countRows('rsvp_households', access.event.id)).toBe(2);
    const exported = await createApp().request(
      `/api/manage/events/${access.event.id}/rsvp/export.csv`,
      { headers: { cookie: access.manager.cookie } },
      testEnv,
    );
    expect(await exported.text()).toContain('rivera');

    await deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z'));
    expect(await countRows('rsvp_households', access.event.id)).toBe(0);
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it('deletes bounded expired auth scratch while retaining live boundary rows', async () => {
    const accountId = crypto.randomUUID();
    await testEnv.DB.prepare(`
      INSERT INTO host_accounts (id, email, password_hash, created_at)
      VALUES (?, 'host@example.com', 'hash', '2026-07-21T11:00:00.000Z')
    `).bind(accountId).run();
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        INSERT INTO host_registration_challenges (
          id, email, password_hash, browser_secret_digest, code_digest,
          expires_at, consumed_at, created_at, updated_at
        ) VALUES (?, ?, 'hash', 'browser', 'code', ?, ?, ?, ?)
      `).bind(
        'pending-consumed',
        'consumed@example.com',
        '2026-07-21T13:00:00.000Z',
        '2026-07-21T12:01:00.000Z',
        '2026-07-21T12:00:00.000Z',
        '2026-07-21T12:01:00.000Z',
      ),
      testEnv.DB.prepare(`
        INSERT INTO host_registration_challenges (
          id, email, password_hash, browser_secret_digest, code_digest,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, 'hash', 'browser', 'code', ?, ?, ?)
      `).bind(
        'pending-boundary',
        'boundary@example.com',
        '2026-07-21T12:15:00.000Z',
        '2026-07-21T12:00:00.000Z',
        '2026-07-21T12:00:00.000Z',
      ),
      testEnv.DB.prepare(`
        INSERT INTO host_login_challenges (
          id, account_id, purpose, secret_digest, expires_at, created_at
        ) VALUES ('login-expired', ?, 'verify', 'digest', ?, ?)
      `).bind(accountId, '2026-07-21T12:14:59.999Z', '2026-07-21T12:00:00.000Z'),
      testEnv.DB.prepare(`
        INSERT INTO host_login_challenges (
          id, account_id, purpose, secret_digest, expires_at, created_at
        ) VALUES ('login-boundary', ?, 'reset', 'digest', ?, ?)
      `).bind(accountId, '2026-07-21T12:15:00.000Z', '2026-07-21T12:00:00.000Z'),
      testEnv.DB.prepare(`
        INSERT INTO host_auth_rate_limits (
          scope_digest, action, window_started_at, attempts
        ) VALUES ('old', 'login', '2026-07-21T11:59:59.999Z', 1)
      `),
      testEnv.DB.prepare(`
        INSERT INTO host_auth_rate_limits (
          scope_digest, action, window_started_at, attempts
        ) VALUES ('boundary', 'login', '2026-07-21T12:00:00.000Z', 1)
      `),
    ]);

    const result = await cleanupAuthScratch(
      testEnv,
      new Date('2026-07-21T12:15:00.000Z'),
    );

    expect(result).toEqual({ registrations: 1, challenges: 1, rateLimits: 1 });
    expect(await testEnv.DB.prepare(`
      SELECT id FROM host_registration_challenges
    `).all()).toMatchObject({ results: [{ id: 'pending-boundary' }] });
    expect(await testEnv.DB.prepare(`
      SELECT id FROM host_login_challenges
    `).all()).toMatchObject({ results: [{ id: 'login-boundary' }] });
    expect(await testEnv.DB.prepare(`
      SELECT scope_digest FROM host_auth_rate_limits
    `).all()).toMatchObject({ results: [{ scope_digest: 'boundary' }] });
  });

  it('uses wall-clock execution time rather than nominal cron time for cleanup', async () => {
    const access = await eventAccess();
    const scheduledAt = new Date('2026-07-21T12:00:00.000Z');
    const executedAt = new Date('2026-07-21T12:10:00.000Z');
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind('2026-07-21T12:05:00.000Z', access.event.id).run();
    const scheduled: Promise<unknown>[] = [];
    const clock = vi.useFakeTimers();
    clock.setSystemTime(executedAt);

    worker.scheduled!({ cron: '0 0 * * *', scheduledTime: scheduledAt.getTime() } as ScheduledController,
      testEnv,
      { waitUntil: (promise: Promise<unknown>) => scheduled.push(promise), passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(scheduled);
    clock.useRealTimers();

    // A due event is purged outright by the run, so the proof it used wall-clock
    // time is that the row is gone rather than still waiting for the next pass.
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(access.event.id).first()).toBeNull();
    expect(await foreignKeyCheck()).toEqual([]);
  });
});

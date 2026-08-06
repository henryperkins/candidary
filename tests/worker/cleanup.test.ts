import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { MediaRepository } from '../../worker/db/media';
import { COVER_CLEANUP_ROWS_PER_CLASS } from '../../shared/constants';
import {
  cleanupAuthScratch,
  cleanupEventCovers,
  cleanupExpiredReservations,
  cleanupRsvpScratch,
  deleteEventData,
  scheduledCleanup,
} from '../../worker/workflows/cleanup';
import worker from '../../worker/index';
import {
  EVENT_COVER_TABLES,
  eventAccess,
  importRoster,
  openRsvp,
  png,
  resetDatabase,
  seedEventCoverGraph,
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

async function rsvpReady(openPhotosEarly = true) {
  const access = await eventAccess('Maya & Theo', openPhotosEarly);
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
    // The whole sweep is dated in the past, so photo delivery has to have been
    // open before the reservation this releases was ever taken.
    await testEnv.DB.prepare('UPDATE events SET photos_open_from = ? WHERE id = ?')
      .bind('2026-07-21T11:00:00.000Z', access.event.id).run();
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
  // Every cover table's `event_id` is ON DELETE RESTRICT, inverting the fifteen
  // CASCADE relationships this schema had before 0012. Without the explicit
  // child-before-parent order, the first event that ever owned a cover fails its
  // purge with a foreign-key error and the scheduled pass retries it forever.
  describe('event cover inventory', () => {
    // All four cover key shapes, so the claim that the existing
    // `events/{id}/` prefix already covers them is asserted rather than assumed.
    async function seedCoverObjects(eventId: string, setId: string, draftId: string) {
      const keys = [
        `events/${eventId}/cover/raw/${draftId}`,
        `events/${eventId}/cover/masters/master-a.webp`,
        `events/${eventId}/cover/previews/${draftId}/natural-1.webp`,
        `events/${eventId}/cover/rendered/${setId}/wide-expanded-1x.jpeg`,
      ];
      for (const key of keys) await testEnv.MEDIA_BUCKET.put(key, png());
      return keys;
    }

    async function coverPrefixKeys(eventId: string) {
      const listed = await testEnv.MEDIA_BUCKET.list({ prefix: `events/${eventId}/` });
      return listed.objects.map(({ key }) => key).sort();
    }

    it('deletes every cover row before the event and leaves no foreign-key violation', async () => {
      const access = await eventAccess();
      const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
      const keys = await seedCoverObjects(access.event.id, ids.renderSetId, ids.draftId);
      expect(await coverPrefixKeys(access.event.id)).toEqual([...keys].sort());

      await deleteEventData(testEnv, access.event.id, new Date('2026-08-04T12:00:00.000Z'));

      expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(access.event.id).first()).toBeNull();
      for (const table of EVENT_COVER_TABLES) {
        expect(await countRows(table, access.event.id), `${table} rows after purge`).toBe(0);
      }
      // The run has no event foreign key, so it never blocked this purge. It
      // survives with counters recomputed from what actually remains — zero —
      // because it is not yet expiry-eligible; ledger retention is the scheduled
      // cover sweep's job, not the purge's.
      expect(await testEnv.DB.prepare(`
        SELECT total_count, applied_count FROM event_cover_backfill_runs WHERE id = ?
      `).bind(ids.runId).first()).toEqual({ total_count: 0, applied_count: 0 });
      expect(await foreignKeyCheck()).toEqual([]);
      expect(await coverPrefixKeys(access.event.id)).toEqual([]);
    });

    it('removes an emptied backfill run only once it is also past its own expiry', async () => {
      const access = await eventAccess();
      const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
      await testEnv.DB.prepare('UPDATE event_cover_backfill_runs SET expires_at = ? WHERE id = ?')
        .bind('2026-08-01T00:00:00.000Z', ids.runId).run();

      await deleteEventData(testEnv, access.event.id, new Date('2026-08-04T12:00:00.000Z'));

      expect(await testEnv.DB.prepare('SELECT count(*) AS count FROM event_cover_backfill_runs')
        .first<{ count: number }>()).toEqual({ count: 0 });
      expect(await foreignKeyCheck()).toEqual([]);
    });

    // The fence has no event foreign key on purpose: it must outlive the row it
    // protected so a late dispatcher cannot do cover work for a purged event.
    it('leaves workflow fences to age out on their own schedule', async () => {
      const access = await eventAccess();
      await seedEventCoverGraph(testEnv.DB, access.event.id);
      await deleteEventData(testEnv, access.event.id, new Date('2026-08-04T12:00:00.000Z'));
      expect(await countRows('event_cover_workflow_fences', access.event.id)).toBe(1);
    });

    it('keeps a backfill run alive while another event still owns a job', async () => {
      const first = await eventAccess('First');
      const second = await eventAccess('Second');
      const shared = await seedEventCoverGraph(testEnv.DB, first.event.id);
      const other = await seedEventCoverGraph(testEnv.DB, second.event.id);
      // Re-home the second event's job onto the first run, so the run is shared.
      await testEnv.DB.prepare('UPDATE event_cover_backfill_jobs SET run_id = ? WHERE id = ?')
        .bind(shared.runId, other.jobId).run();
      await testEnv.DB.prepare('DELETE FROM event_cover_backfill_runs WHERE id = ?')
        .bind(other.runId).run();

      await deleteEventData(testEnv, first.event.id, new Date('2026-08-04T12:00:00.000Z'));

      const run = await testEnv.DB.prepare(`
        SELECT total_count, applied_count FROM event_cover_backfill_runs WHERE id = ?
      `).bind(shared.runId).first<{ total_count: number; applied_count: number }>();
      // Survives with counters recomputed from the one job that remains, rather
      // than decremented by hand or left claiming work that no longer exists.
      expect(run).toEqual({ total_count: 1, applied_count: 1 });
      expect(await foreignKeyCheck()).toEqual([]);
    });

    it('keeps every cover row when object deletion fails, and completes on a second pass', async () => {
      const access = await eventAccess();
      const ids = await seedEventCoverGraph(testEnv.DB, access.event.id);
      await seedCoverObjects(access.event.id, ids.renderSetId, ids.draftId);
      const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
        .mockRejectedValueOnce(new Error('R2 unavailable'));

      await expect(deleteEventData(testEnv, access.event.id, new Date('2026-08-04T12:00:00.000Z')))
        .rejects.toThrow();
      failing.mockRestore();

      const event = await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
        .bind(access.event.id).first<{ deleted_at: string | null }>();
      expect(event?.deleted_at).toBeTruthy();
      // Nothing is removed ahead of its object: the inventory is the only record
      // that the object exists, so it has to survive for the retry to find it.
      for (const table of EVENT_COVER_TABLES) {
        expect(await countRows(table, access.event.id), `${table} rows after failure`).toBeGreaterThan(0);
      }

      await deleteEventData(testEnv, access.event.id, new Date('2026-08-04T12:05:00.000Z'));
      expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
        .bind(access.event.id).first()).toBeNull();
      expect(await coverPrefixKeys(access.event.id)).toEqual([]);
      expect(await foreignKeyCheck()).toEqual([]);
    });
  });
});

/**
 * The bounded cover sweep.
 *
 * Every case here is really one of two questions: does an object leave R2 before
 * the only row that knows about it, and does a deadline release something that
 * some other owner is still entitled to? The second is why so many of these are
 * negative assertions — the sweep's job is as much about what it refuses to
 * collect as about what it collects.
 */
describe('bounded cover storage sweep', () => {
  const NOW = new Date('2026-08-10T12:00:00.000Z');
  const PAST = '2026-08-01T00:00:00.000Z';
  const FUTURE = '2026-08-20T00:00:00.000Z';
  const HEX = 'a'.repeat(64);

  let access: Access;

  beforeEach(async () => {
    await resetDatabase();
    access = await eventAccess();
  });

  const prefix = () => `events/${access.event.id}/cover`;

  async function put(key: string) {
    await testEnv.MEDIA_BUCKET.put(key, png());
    return key;
  }

  async function exists(key: string) {
    return await testEnv.MEDIA_BUCKET.head(key) !== null;
  }

  async function insertMaster(id: string, options: { cleanupAfter?: string | null } = {}) {
    const key = `${prefix()}/masters/${id}.webp`;
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_masters (
        id, event_id, object_key, mime_type, byte_size, width, height, sha256,
        normalization_version, normalization_rung, created_at, cleanup_after
      ) VALUES (?, ?, ?, 'image/webp', 900000, 2400, 1600, ?, 1, 1, ?, ?)
    `).bind(id, access.event.id, key, HEX, PAST, options.cleanupAfter ?? null).run();
    return put(key);
  }

  async function insertDraft(id: string, options: {
    state: string;
    expiresAt?: string;
    rawKey?: string | null;
    masterId?: string | null;
  }) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_drafts (
        id, event_id, source, state, draft_intent_id, request_sha256, draft_revision,
        raw_object_key, master_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, 'new_upload', ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).bind(
      id, access.event.id, options.state, `intent-${id}`, HEX,
      options.rawKey ?? null, options.masterId ?? null, PAST, PAST, options.expiresAt ?? PAST,
    ).run();
  }

  async function insertSet(id: string, options: {
    state: string;
    masterId: string;
    cleanupAfter?: string | null;
  }) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_sets (
        id, event_id, master_id, recipe_json, recipe_sha256, state, required_slots,
        created_at, cleanup_after
      ) VALUES (?, ?, ?, '{"effect":"natural"}', ?, ?, 12, ?, ?)
    `).bind(
      id, access.event.id, options.masterId, HEX, options.state, PAST,
      options.cleanupAfter ?? null,
    ).run();
  }

  async function insertRenderObject(id: string, setId: string, profile: string) {
    const key = `${prefix()}/rendered/${setId}/${profile}-1x.jpeg`;
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_render_objects (
        id, render_set_id, event_id, profile_id, density, format, object_key,
        content_type, byte_size, width, height, quality_rung, sha256, created_at
      ) VALUES (?, ?, ?, ?, '1x', 'jpeg', ?, 'image/jpeg', 120000, 620, 420, 1, ?, ?)
    `).bind(id, setId, access.event.id, profile, key, HEX, PAST).run();
    return put(key);
  }

  async function insertReceipt(operationId: string, options: {
    status: string;
    /** NOT NULL in the schema: every receipt carries the deadline its status earns. */
    expiresAt: string;
    draftId?: string | null;
    setId?: string | null;
    retryable?: number;
  }) {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, draft_id, render_set_id, request_sha256, action,
        expected_revision, status, workflow_instance_id, dependency_versions_json,
        completed_profiles, required_profiles, retryable, dispatch_state,
        dispatch_generation, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'publish', 0, ?, ?, '{"tonalEffect":1}', 0, 6, ?, 'confirmed', 1, ?, ?, ?)
    `).bind(
      access.event.id, operationId, options.draftId ?? null, options.setId ?? null, HEX,
      options.status, `instance-${operationId}`, options.retryable ?? 0, PAST, PAST,
      options.expiresAt,
    ).run();
  }

  async function insertBackfillJob(id: string, runId: string, options: {
    status: string;
    masterId?: string | null;
    setId?: string | null;
    referenceReleaseAt?: string | null;
    expiresAt?: string | null;
    runExpiresAt?: string | null;
  }) {
    await testEnv.DB.prepare(`
      INSERT OR IGNORE INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at, expires_at)
      VALUES (?, 'execute', 'executing', ?, ?, ?)
    `).bind(runId, PAST, PAST, options.runExpiresAt ?? null).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_backfill_jobs (
        id, run_id, event_id, expected_revision, legacy_key_fingerprint, master_id,
        render_set_id, workflow_instance_id, dispatch_state, dispatch_generation,
        status, dependency_versions_json, terminal_at, reference_release_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'confirmed', 1, ?, '{"tonalEffect":1}', ?, ?, ?, ?, ?)
    `).bind(
      id, runId, access.event.id, HEX, options.masterId ?? null, options.setId ?? null,
      `backfill-${id}`, options.status, PAST,
      options.referenceReleaseAt ?? null, options.expiresAt ?? null, PAST, PAST,
    ).run();
  }

  async function draftState(id: string) {
    return testEnv.DB.prepare('SELECT state, raw_object_key, draft_revision FROM event_cover_drafts WHERE id = ?')
      .bind(id).first<{ state: string; raw_object_key: string | null; draft_revision: number }>();
  }

  it('expires a stale draft and releases its raw bytes only once R2 absence is proven', async () => {
    const raw = await put(`${prefix()}/raw/draft-stale`);
    await insertDraft('draft-stale', { state: 'ready', expiresAt: PAST, rawKey: raw });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.draftsExpired).toBe(1);
    expect(await draftState('draft-stale')).toMatchObject({
      state: 'expired', raw_object_key: null, draft_revision: 2,
    });
    expect(await exists(raw)).toBe(false);
  });

  it('keeps the raw pointer charged when the object cannot be deleted', async () => {
    const raw = await put(`${prefix()}/raw/draft-stuck`);
    await insertDraft('draft-stuck', { state: 'failed', rawKey: raw });
    const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('R2 unavailable'));

    await cleanupEventCovers(testEnv, NOW);
    failing.mockRestore();

    // Still charged against the event aggregate, because the bytes are still there.
    expect((await draftState('draft-stuck'))?.raw_object_key).toBe(raw);
    expect(await exists(raw)).toBe(true);

    await cleanupEventCovers(testEnv, NOW);
    expect((await draftState('draft-stuck'))?.raw_object_key).toBeNull();
    expect(await exists(raw)).toBe(false);
  });

  it('never expires a publishing draft, whatever its own expiry says', async () => {
    await insertDraft('draft-publishing', { state: 'publishing', expiresAt: PAST });
    await insertReceipt('op-retryable', {
      status: 'failed', retryable: 1, expiresAt: FUTURE, draftId: 'draft-publishing',
    });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.draftsExpired).toBe(0);
    // Publication ownership is what returns it to `ready` — never a sweep.
    expect((await draftState('draft-publishing'))?.state).toBe('publishing');
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(1);
  });

  it('deletes a preview file before its inventory row', async () => {
    await insertDraft('draft-done', { state: 'published' });
    const key = await put(`${prefix()}/previews/draft-done/natural-1.webp`);
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_draft_previews (
        id, draft_id, event_id, effect_id, recipe_version, state, object_key,
        mime_type, byte_size, width, height, ladder_rung, sha256, retryable,
        created_at, updated_at
      ) VALUES ('preview-a', 'draft-done', ?, 'natural', 1, 'ready', ?, 'image/webp',
                90000, 1280, 853, 1, ?, 0, ?, ?)
    `).bind(access.event.id, key, HEX, PAST, PAST).run();

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.previewsDeleted).toBe(1);
    expect(await exists(key)).toBe(false);
    expect(await countRows('event_cover_draft_previews', access.event.id)).toBe(0);
  });

  it('expires terminal receipts and leaves a nonterminal one alone', async () => {
    await insertReceipt('op-applied', { status: 'applied', expiresAt: PAST });
    await insertReceipt('op-conflict', { status: 'conflict', expiresAt: PAST });
    await insertReceipt('op-rendering', { status: 'rendering', expiresAt: PAST });
    await insertReceipt('op-not-due', { status: 'applied', expiresAt: FUTURE });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.receiptsExpired).toBe(2);
    const remaining = await testEnv.DB.prepare(
      'SELECT operation_id FROM event_cover_publish_receipts WHERE event_id = ? ORDER BY operation_id',
    ).bind(access.event.id).all<{ operation_id: string }>();
    expect(remaining.results.map((row) => row.operation_id)).toEqual(['op-not-due', 'op-rendering']);
  });

  it('releases backfill references at reference_release_at, then the job, then an emptied run', async () => {
    const master = await insertMaster('master-job');
    await insertSet('set-job', { state: 'retired', masterId: 'master-job' });
    await insertBackfillJob('job-a', 'run-a', {
      status: 'applied', masterId: 'master-job', setId: 'set-job',
      referenceReleaseAt: PAST, expiresAt: PAST, runExpiresAt: PAST,
    });

    const first = await cleanupEventCovers(testEnv, NOW);
    expect(first.backfillJobsReleased).toBe(1);
    // Released and deleted in the same pass: the release runs before the delete,
    // and the delete requires both pointers to be null.
    expect(await countRows('event_cover_backfill_jobs', access.event.id)).toBe(0);
    expect(await testEnv.DB.prepare('SELECT id FROM event_cover_backfill_runs WHERE id = ?')
      .bind('run-a').first()).toBeNull();
    expect(master).toContain('master-job');
  });

  it('keeps a backfill job that has not reached its reference release', async () => {
    await insertMaster('master-held');
    await insertBackfillJob('job-held', 'run-held', {
      status: 'applied', masterId: 'master-held', referenceReleaseAt: FUTURE, expiresAt: FUTURE,
    });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.backfillJobsReleased).toBe(0);
    expect(await countRows('event_cover_backfill_jobs', access.event.id)).toBe(1);
  });

  it('sweeps rate rows and dispatch fences on their own recorded expiry', async () => {
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_rate_events (
        id, event_id, action, replay_key, request_sha256, window_start, created_at, expires_at
      ) VALUES ('rate-due', ?, 'publication', 'replay-a', ?, 1785196800, ?, ?),
               ('rate-live', ?, 'publication', 'replay-b', ?, 1785196800, ?, ?)
    `).bind(access.event.id, HEX, PAST, PAST, access.event.id, HEX, PAST, FUTURE).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_workflow_fences (
        workflow_binding, workflow_instance_id, event_id, dispatch_generation, state,
        created_at, updated_at, expires_at
      ) VALUES ('COVER_RENDER_WORKFLOW', 'instance-due', ?, 1, 'open', ?, ?, ?),
               ('COVER_BACKFILL_WORKFLOW', 'instance-live', ?, 1, 'open', ?, ?, ?)
    `).bind(access.event.id, PAST, PAST, PAST, access.event.id, PAST, PAST, FUTURE).run();

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary).toMatchObject({ rateEventsDeleted: 1, fencesDeleted: 1 });
    expect(await countRows('event_cover_rate_events', access.event.id)).toBe(1);
  });

  it('abandons an orphaned staging set but never the one the event points at', async () => {
    await insertMaster('master-orphan');
    await insertSet('set-orphan', { state: 'staging', masterId: 'master-orphan' });
    await insertSet('set-current', { state: 'ready', masterId: 'master-orphan' });
    await testEnv.DB.prepare('UPDATE events SET cover_render_set_id = ? WHERE id = ?')
      .bind('set-current', access.event.id).run();

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.setsAbandoned).toBe(1);
    // Discovery and deletion are different passes: the orphan gets the same
    // seven-day recovery window a retired set gets, so noticing it today does
    // not sweep it today.
    expect(summary.setsDeleted).toBe(0);
    expect(await testEnv.DB.prepare('SELECT state FROM event_cover_render_sets WHERE id = ?')
      .bind('set-orphan').first()).toEqual({ state: 'abandoned' });
    expect(await testEnv.DB.prepare('SELECT state FROM event_cover_render_sets WHERE id = ?')
      .bind('set-current').first()).toEqual({ state: 'ready' });
  });

  it('leaves a staging set alone while a receipt or a job still owns it', async () => {
    await insertMaster('master-owned');
    await insertSet('set-owned', { state: 'staging', masterId: 'master-owned' });
    await insertReceipt('op-owner', { status: 'rendering', expiresAt: FUTURE, setId: 'set-owned' });

    expect((await cleanupEventCovers(testEnv, NOW)).setsAbandoned).toBe(0);
    expect(await testEnv.DB.prepare('SELECT state FROM event_cover_render_sets WHERE id = ?')
      .bind('set-owned').first()).toEqual({ state: 'staging' });
  });

  it('deletes every render object before its set, and keeps a set it could not finish', async () => {
    await insertMaster('master-set');
    await insertSet('set-collectable', {
      state: 'retired', masterId: 'master-set', cleanupAfter: PAST,
    });
    const first = await insertRenderObject('object-a', 'set-collectable', 'wide-expanded');
    const second = await insertRenderObject('object-b', 'set-collectable', 'short-lookup');

    const failing = vi.spyOn(testEnv.MEDIA_BUCKET, 'delete')
      .mockRejectedValueOnce(new Error('R2 unavailable'));
    const partial = await cleanupEventCovers(testEnv, NOW);
    failing.mockRestore();

    expect(partial.renderObjectsDeleted).toBe(1);
    expect(partial.setsDeleted).toBe(0);
    // The set survives because one of its objects is still in the bucket, and the
    // row is the only record that the object is there at all.
    expect(await countRows('event_cover_render_sets', access.event.id)).toBe(1);

    const complete = await cleanupEventCovers(testEnv, NOW);
    expect(complete.setsDeleted).toBe(1);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);
    expect(await countRows('event_cover_render_objects', access.event.id)).toBe(0);
  });

  it('deletes a retired legacy original but never the key the event still serves', async () => {
    const displaced = await put(`${prefix()}/legacy-old.jpg`);
    const current = await put(`${prefix()}/legacy-current.jpg`);
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(current, access.event.id).run();
    await testEnv.DB.prepare(`
      INSERT INTO event_cover_retired_legacy_objects (
        id, event_id, object_key, key_fingerprint, reason, retired_at, cleanup_after
      ) VALUES ('retired-old', ?, ?, ?, 'replaced', ?, ?),
               ('retired-current', ?, ?, ?, 'backfilled', ?, ?)
    `).bind(
      access.event.id, displaced, HEX, PAST, PAST,
      access.event.id, current, HEX, PAST, PAST,
    ).run();

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.legacyObjectsDeleted).toBe(1);
    expect(await exists(displaced)).toBe(false);
    // An inventory row that disagrees with the event pointer is never acted on.
    expect(await exists(current)).toBe(true);
    expect(await countRows('event_cover_retired_legacy_objects', access.event.id)).toBe(1);
  });

  it('deletes a master last, nulling only the pointer of a draft that is over', async () => {
    const key = await insertMaster('master-collectable', { cleanupAfter: PAST });
    await insertDraft('draft-terminal', { state: 'expired', masterId: 'master-collectable' });

    const summary = await cleanupEventCovers(testEnv, NOW);

    expect(summary.mastersDeleted).toBe(1);
    expect(await exists(key)).toBe(false);
    expect(await countRows('event_cover_masters', access.event.id)).toBe(0);
    expect(await testEnv.DB.prepare('SELECT master_id FROM event_cover_drafts WHERE id = ?')
      .bind('draft-terminal').first()).toEqual({ master_id: null });
    expect(await foreignKeyCheck()).toEqual([]);
  });

  it.each([
    ['a live draft', async () => {
      await insertDraft('draft-live', { state: 'ready', expiresAt: FUTURE, masterId: 'master-kept' });
    }],
    ['a render set', async () => {
      await insertSet('set-kept', { state: 'active', masterId: 'master-kept' });
    }],
    ['a backfill job', async () => {
      await insertBackfillJob('job-kept', 'run-kept', { status: 'applied', masterId: 'master-kept' });
    }],
  ])('keeps a master %s still references', async (_name, seed) => {
    const key = await insertMaster('master-kept', { cleanupAfter: PAST });
    await seed();

    expect((await cleanupEventCovers(testEnv, NOW)).mastersDeleted).toBe(0);
    expect(await exists(key)).toBe(true);
    expect(await countRows('event_cover_masters', access.event.id)).toBe(1);
  });

  it('keeps the master the event still points at, however old its cleanup deadline', async () => {
    const key = await insertMaster('master-active', { cleanupAfter: PAST });
    await testEnv.DB.prepare('UPDATE events SET cover_object_key = ? WHERE id = ?')
      .bind(key, access.event.id).run();

    expect((await cleanupEventCovers(testEnv, NOW)).mastersDeleted).toBe(0);
    expect(await exists(key)).toBe(true);
  });

  it('reports a remainder when a class fills its per-pass bound', async () => {
    const statements = Array.from({ length: COVER_CLEANUP_ROWS_PER_CLASS + 5 }, (_unused, index) => (
      testEnv.DB.prepare(`
        INSERT INTO event_cover_rate_events (
          id, event_id, action, replay_key, request_sha256, window_start, created_at, expires_at
        ) VALUES (?, ?, 'reservation', ?, ?, 1785196800, ?, ?)
      `).bind(`rate-${index}`, access.event.id, `replay-${index}`, HEX, PAST, PAST)
    ));
    await testEnv.DB.batch(statements);

    const first = await cleanupEventCovers(testEnv, NOW);
    expect(first.rateEventsDeleted).toBe(COVER_CLEANUP_ROWS_PER_CLASS);
    expect(first.remainder).toBe(true);

    const second = await cleanupEventCovers(testEnv, NOW);
    expect(second.rateEventsDeleted).toBe(5);
    expect(second.remainder).toBe(false);
    expect(await countRows('event_cover_rate_events', access.event.id)).toBe(0);
  });

  it('runs inside the scheduled pass, ahead of the retention purge', async () => {
    await insertReceipt('op-swept', { status: 'applied', expiresAt: PAST });
    const other = await eventAccess('Nadia & Sam');
    await seedEventCoverGraph(testEnv.DB, other.event.id);
    await testEnv.DB.prepare('UPDATE events SET purge_after = ? WHERE id = ?')
      .bind(PAST, other.event.id).run();

    await scheduledCleanup(testEnv, NOW);

    // The sweep ran, and the purge that follows it still completed against an
    // event owning a row in every cover table.
    expect(await countRows('event_cover_publish_receipts', access.event.id)).toBe(0);
    expect(await testEnv.DB.prepare('SELECT id FROM events WHERE id = ?')
      .bind(other.event.id).first()).toBeNull();
    expect(await foreignKeyCheck()).toEqual([]);
  });
});

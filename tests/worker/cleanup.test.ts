import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../worker/auth/service';
import { MediaRepository } from '../../worker/db/media';
import {
  cleanupAuthScratch,
  cleanupExpiredReservations,
  deleteEventData,
} from '../../worker/workflows/cleanup';
import worker from '../../worker/index';
import { eventAccess, png, resetDatabase, testEnv } from './helpers';

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

  it('marks an event inaccessible before deleting its object prefix', async () => {
    const access = await eventAccess();
    await testEnv.MEDIA_BUCKET.put(`events/${access.event.id}/media/orphan`, png());
    await deleteEventData(testEnv, access.event.id, new Date('2026-07-21T12:00:00.000Z'));
    const rows = await testEnv.MEDIA_BUCKET.list({ prefix: `events/${access.event.id}/` });
    expect(rows.objects).toHaveLength(0);
    const event = await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?').bind(access.event.id).first<any>();
    expect(event.deleted_at).toBeTruthy();
    const tokens = await testEnv.DB.prepare('SELECT count(*) AS count FROM event_access_tokens WHERE event_id = ? AND revoked_at IS NULL').bind(access.event.id).first<any>();
    expect(tokens.count).toBe(0);
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

    expect(await testEnv.DB.prepare('SELECT deleted_at FROM events WHERE id = ?')
      .bind(access.event.id).first('deleted_at')).toBe(executedAt.toISOString());
  });
});

import type { AppEnv } from '../env';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import { AUTH_RATE_LIMIT_WINDOW_MS } from '../db/auth-rate-limits';

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function cleanupExpiredReservations(env: AppEnv, now = new Date()): Promise<number> {
  const media = new MediaRepository(env.DB);
  let cleaned = 0;
  for (;;) {
    const expired = await media.listExpiredReservations(now.toISOString());
    if (!expired.length) break;
    for (const item of expired) {
      await env.MEDIA_BUCKET.delete(item.objectKey);
      await media.failReservation(item.id);
      cleaned += 1;
    }
    if (expired.length < 100) break;
  }
  return cleaned;
}

export async function cleanupExpiredExports(env: AppEnv, now = new Date()): Promise<number> {
  const repository = new ExportsRepository(env.DB);
  const expired = await repository.expireReady(now.toISOString());
  for (const job of expired) {
    const parts = await repository.listParts(job.id);
    const keys = [job.objectKey, job.manifestObjectKey, ...parts.map(({ objectKey }) => objectKey)]
      .filter((key): key is string => Boolean(key));
    if (keys.length) await env.MEDIA_BUCKET.delete(keys);
  }
  return expired.length;
}

export async function cleanupAuthScratch(
  env: AppEnv,
  now = new Date(),
): Promise<{ registrations: number; challenges: number; rateLimits: number }> {
  const timestamp = now.toISOString();
  const rateLimitCutoff = new Date(now.getTime() - AUTH_RATE_LIMIT_WINDOW_MS).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM host_registration_challenges
      WHERE id IN (
        SELECT id FROM host_registration_challenges
        WHERE consumed_at IS NOT NULL OR expires_at < ?
        ORDER BY updated_at
        LIMIT 100
      )
    `).bind(timestamp),
    env.DB.prepare(`
      DELETE FROM host_login_challenges
      WHERE id IN (
        SELECT id FROM host_login_challenges
        WHERE expires_at < ?
        ORDER BY expires_at
        LIMIT 100
      )
    `).bind(timestamp),
    env.DB.prepare(`
      DELETE FROM host_auth_rate_limits
      WHERE rowid IN (
        SELECT rowid FROM host_auth_rate_limits
        WHERE window_started_at < ?
        ORDER BY window_started_at
        LIMIT 100
      )
    `).bind(rateLimitCutoff),
  ]);
  return {
    registrations: results[0]?.meta.changes ?? 0,
    challenges: results[1]?.meta.changes ?? 0,
    rateLimits: results[2]?.meta.changes ?? 0,
  };
}

export async function deleteEventData(env: AppEnv, eventId: string, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE events SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
  ]);
  await deletePrefix(env.MEDIA_BUCKET, `events/${eventId}/`);
}

export async function scheduledCleanup(env: AppEnv, now = new Date()): Promise<void> {
  await cleanupAuthScratch(env, now);
  await cleanupExpiredReservations(env, now);
  await cleanupExpiredExports(env, now);
  // Notification delivery is no longer part of this run. It has its own hourly
  // trigger and its own durable state, so a mail failure and a retention purge no
  // longer share a failure boundary in either direction.
  const purged = await env.DB.prepare(`
    SELECT id FROM events WHERE deleted_at IS NULL AND purge_after <= ? LIMIT 100
  `).bind(now.toISOString()).all<{ id: string }>();
  for (const event of purged.results) await deleteEventData(env, event.id, now);
}

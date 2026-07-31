import type { AppEnv } from '../env';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import { AUTH_RATE_LIMIT_WINDOW_MS } from '../db/auth-rate-limits';
import { RSVP_LOOKUP_RATE_WINDOW_MS } from '../db/rsvp-rate-limits';

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

// Each pass deletes at most this many rows per table, and the sweep repeats until a
// pass comes back short. A single 100-row pass per day could not keep up: fifteen
// minute windows mean one busy address alone can leave ~96 rate-limit buckets a day,
// and pending registrations hold a scrypt hash until they are swept.
const AUTH_SCRATCH_BATCH = 100;
const AUTH_SCRATCH_MAX_PASSES = 50;

export async function cleanupAuthScratch(
  env: AppEnv,
  now = new Date(),
): Promise<{ registrations: number; challenges: number; rateLimits: number }> {
  const total = { registrations: 0, challenges: 0, rateLimits: 0 };
  for (let pass = 0; pass < AUTH_SCRATCH_MAX_PASSES; pass += 1) {
    const swept = await sweepAuthScratch(env, now);
    total.registrations += swept.registrations;
    total.challenges += swept.challenges;
    total.rateLimits += swept.rateLimits;
    // A short pass means every table is drained; the cap is only a runaway guard.
    if (swept.registrations < AUTH_SCRATCH_BATCH
      && swept.challenges < AUTH_SCRATCH_BATCH
      && swept.rateLimits < AUTH_SCRATCH_BATCH) break;
  }
  return total;
}

async function sweepAuthScratch(
  env: AppEnv,
  now: Date,
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
        LIMIT ?
      )
    `).bind(timestamp, AUTH_SCRATCH_BATCH),
    env.DB.prepare(`
      DELETE FROM host_login_challenges
      WHERE id IN (
        SELECT id FROM host_login_challenges
        WHERE expires_at < ?
        ORDER BY expires_at
        LIMIT ?
      )
    `).bind(timestamp, AUTH_SCRATCH_BATCH),
    env.DB.prepare(`
      DELETE FROM host_auth_rate_limits
      WHERE rowid IN (
        SELECT rowid FROM host_auth_rate_limits
        WHERE window_started_at < ?
        ORDER BY window_started_at
        LIMIT ?
      )
    `).bind(rateLimitCutoff, AUTH_SCRATCH_BATCH),
  ]);
  return {
    registrations: results[0]?.meta.changes ?? 0,
    challenges: results[1]?.meta.changes ?? 0,
    rateLimits: results[2]?.meta.changes ?? 0,
  };
}

// RSVP scratch is bounded exactly like auth scratch, and for the same reason: an
// event with a live roster produces sessions and fifteen-minute rate windows all
// day, and one 100-row pass could not keep up with them.
const RSVP_SCRATCH_BATCH = 100;
const RSVP_SCRATCH_MAX_PASSES = 50;

export async function cleanupRsvpScratch(
  env: AppEnv,
  now = new Date(),
): Promise<{ sessions: number; rateLimits: number }> {
  const total = { sessions: 0, rateLimits: 0 };
  for (let pass = 0; pass < RSVP_SCRATCH_MAX_PASSES; pass += 1) {
    const swept = await sweepRsvpScratch(env, now);
    total.sessions += swept.sessions;
    total.rateLimits += swept.rateLimits;
    // A short pass means both tables are drained; the cap is only a runaway guard.
    if (swept.sessions < RSVP_SCRATCH_BATCH && swept.rateLimits < RSVP_SCRATCH_BATCH) break;
  }
  return total;
}

async function sweepRsvpScratch(
  env: AppEnv,
  now: Date,
): Promise<{ sessions: number; rateLimits: number }> {
  const timestamp = now.toISOString();
  const windowCutoff = new Date(now.getTime() - RSVP_LOOKUP_RATE_WINDOW_MS).toISOString();
  // Counts only. Neither statement can report a household, a name, or a scope.
  const results = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM rsvp_sessions
      WHERE id IN (
        SELECT id FROM rsvp_sessions
        WHERE revoked_at IS NOT NULL OR expires_at < ?
        ORDER BY expires_at
        LIMIT ?
      )
    `).bind(timestamp, RSVP_SCRATCH_BATCH),
    env.DB.prepare(`
      DELETE FROM rsvp_lookup_rate_limits
      WHERE rowid IN (
        SELECT rowid FROM rsvp_lookup_rate_limits
        WHERE window_started_at < ?
        ORDER BY window_started_at
        LIMIT ?
      )
    `).bind(windowCutoff, RSVP_SCRATCH_BATCH),
  ]);
  return {
    sessions: results[0]?.meta.changes ?? 0,
    rateLimits: results[1]?.meta.changes ?? 0,
  };
}

/**
 * Retires one event completely.
 *
 * The order is load-bearing. Every credential is revoked and the printed entry
 * disabled first, so nothing can reach the event while its objects are being
 * removed. Only once the prefix is actually gone does the relational purge run —
 * a hard delete before that would strand objects nothing can discover again. If
 * object deletion fails, the failure propagates and the event stays marked
 * deleted so a later scheduled pass retries exactly this row.
 */
export async function deleteEventData(env: AppEnv, eventId: string, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE events SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE rsvp_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare(`
      UPDATE event_entry_credentials SET disabled_at = COALESCE(disabled_at, ?) WHERE event_id = ?
    `).bind(timestamp, eventId),
  ]);
  await deletePrefix(env.MEDIA_BUCKET, `events/${eventId}/`);
  // `media` and `guest_messages` reference `event_sessions` with ON DELETE
  // RESTRICT, so a populated event cannot be removed by the event cascade alone.
  // Clearing those two first lets the remaining CASCADE relationships — entry,
  // households, invitees, receipts, RSVP sessions, rate windows, exports — run.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM media WHERE event_id = ?').bind(eventId),
    env.DB.prepare('DELETE FROM guest_messages WHERE event_id = ?').bind(eventId),
    env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId),
  ]);
}

export async function scheduledCleanup(env: AppEnv, now = new Date()): Promise<void> {
  await cleanupAuthScratch(env, now);
  await cleanupRsvpScratch(env, now);
  await cleanupExpiredReservations(env, now);
  await cleanupExpiredExports(env, now);
  // Notification delivery is no longer part of this run. It has its own hourly
  // trigger and its own durable state, so a mail failure and a retention purge no
  // longer share a failure boundary in either direction.
  //
  // Rows already marked deleted are selected too: a purge whose object deletion
  // failed is retried here until it succeeds, rather than being left behind with
  // objects no later pass would look for.
  const purged = await env.DB.prepare(`
    SELECT id FROM events WHERE deleted_at IS NOT NULL OR purge_after <= ? LIMIT 100
  `).bind(now.toISOString()).all<{ id: string }>();
  for (const event of purged.results) await deleteEventData(env, event.id, now);
}

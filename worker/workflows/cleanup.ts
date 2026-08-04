import type { AppEnv } from '../env';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import { AUTH_RATE_LIMIT_WINDOW_MS } from '../db/auth-rate-limits';
import { RSVP_LOOKUP_RATE_WINDOW_MS } from '../db/rsvp-rate-limits';

/**
 * Exported rather than duplicated: the cover storage service needs exactly this
 * paging delete, and a second copy is a second place for the truncation loop to
 * be got wrong.
 */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
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

const CANONICAL_NONE_COVER_CONFIG = '{"version":1,"source":{"kind":"none"}}';

/**
 * Child before parent, and every position is load-bearing.
 *
 * Receipts reference drafts and render sets; backfill jobs reference masters,
 * render sets, and runs; render objects reference sets; sets reference masters
 * and drafts; previews reference drafts; drafts reference masters. Moving any
 * line fails the batch rather than corrupting anything, which is the point of
 * the RESTRICT inversion.
 *
 * `event_cover_workflow_fences` is deliberately absent: it has no event foreign
 * key because it must outlive the row it protected, and it ages out on its own
 * 31-day schedule.
 */
const COVER_PURGE_ORDER = [
  'event_cover_rate_events',
  'event_cover_publish_receipts',
  'event_cover_backfill_jobs',
  'event_cover_render_objects',
  'event_cover_render_sets',
  'event_cover_draft_previews',
  'event_cover_drafts',
  'event_cover_retired_legacy_objects',
  'event_cover_masters',
  'event_cover_purge_progress',
] as const;

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
  // The existing prefix already covers all four cover key shapes — raw, masters,
  // previews, rendered — because every one of them is built beneath
  // `events/{eventId}/cover/`. `cleanup.test.ts` asserts that rather than
  // assuming it.
  await deletePrefix(env.MEDIA_BUCKET, `events/${eventId}/`);

  // Read before the jobs go, so their run counters can be recomputed from what
  // actually remains rather than decremented by hand.
  const runs = await env.DB.prepare(
    'SELECT DISTINCT run_id AS id FROM event_cover_backfill_jobs WHERE event_id = ?',
  ).bind(eventId).all<{ id: string }>();
  const affectedRuns = JSON.stringify(runs.results.map((row) => row.id));

  // One transaction, and the order inside it is enforced by the schema rather
  // than by convention: every cover `event_id` is ON DELETE RESTRICT, and the
  // inventory tables reference each other the same way, so a statement out of
  // place fails the whole batch with a foreign-key error.
  //
  // `media` and `guest_messages` reference `event_sessions` with ON DELETE
  // RESTRICT for the same reason, and clearing them lets the remaining CASCADE
  // relationships — entry, households, invitees, receipts, RSVP sessions, rate
  // windows, exports — run when the event row finally goes.
  await env.DB.batch([
    // The pointers first, on the row that is already soft-deleted. Nothing may
    // still name an object whose inventory is about to be removed.
    env.DB.prepare(`
      UPDATE events
      SET cover_config = ?, cover_object_key = NULL, cover_render_set_id = NULL
      WHERE id = ? AND deleted_at IS NOT NULL
    `).bind(CANONICAL_NONE_COVER_CONFIG, eventId),
    ...COVER_PURGE_ORDER.map((table) => env.DB
      .prepare(`DELETE FROM ${table} WHERE event_id = ?`).bind(eventId)),
    env.DB.prepare(`
      UPDATE event_cover_backfill_runs SET
        total_count = (SELECT count(*) FROM event_cover_backfill_jobs j WHERE j.run_id = event_cover_backfill_runs.id),
        queued_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id AND j.status = 'queued'),
        applied_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id AND j.status = 'applied'),
        skipped_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id AND j.status = 'skipped'),
        resolved_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id AND j.status = 'resolved'),
        failed_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id AND j.status = 'failed'),
        needs_replacement_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id AND j.status = 'needs_replacement'),
        updated_at = ?
      WHERE id IN (SELECT value FROM json_each(?))
    `).bind(timestamp, affectedRuns),
    // A run has no event foreign key, so it never blocks this purge. It is
    // removed here only when it is both empty and already past its own expiry;
    // ledger retention otherwise belongs to the scheduled cover sweep.
    env.DB.prepare(`
      DELETE FROM event_cover_backfill_runs
      WHERE id IN (SELECT value FROM json_each(?))
        AND expires_at IS NOT NULL AND expires_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_backfill_jobs j WHERE j.run_id = event_cover_backfill_runs.id
        )
    `).bind(affectedRuns, timestamp),
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

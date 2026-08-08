import { COVER_CLEANUP_ROWS_PER_CLASS } from '../../shared/constants';
import type { AppEnv } from '../env';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import { AUTH_RATE_LIMIT_WINDOW_MS } from '../db/auth-rate-limits';
import { releaseCoverRawBytes } from '../db/event-covers';
import { RSVP_LOOKUP_RATE_WINDOW_MS } from '../db/rsvp-rate-limits';
import {
  COVER_BACKFILL_BINDING,
  reconcileCoverBackfillJobs,
  recoverStaleInitialBackfillDispatches,
} from './cover-backfill';
import {
  defaultCoverBackfillWorkflowAccessor,
  defaultCoverWorkflowAccessor,
  type CoverBackfillWorkflowAccessor,
  type CoverWorkflowAccessor,
  type CoverWorkflowLookup,
} from './cover-platform';

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

/* ------------------------------------------------------------------ *
 * Cover storage
 * ------------------------------------------------------------------ */

export interface CoverCleanupSummary {
  draftsExpired: number;
  previewsDeleted: number;
  receiptsExpired: number;
  /** Drafts left frozen by a publication whose receipt has since been swept. */
  strandedDraftsReleased: number;
  backfillJobsReleased: number;
  rateEventsDeleted: number;
  fencesDeleted: number;
  setsAbandoned: number;
  renderObjectsDeleted: number;
  setsDeleted: number;
  legacyObjectsDeleted: number;
  mastersDeleted: number;
  /** True when any class filled its per-pass bound and has more waiting. */
  remainder: boolean;
}

/** The same window publication gives a set it abandons or retires. */
const COVER_RETIRED_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;

const LIVE_COVER_DRAFT_STATES = "('reserved', 'transferred', 'inspected', 'ready', 'publishing')";
const EXPIRABLE_COVER_DRAFT_STATES = "('reserved', 'transferred', 'inspected', 'ready', 'failed')";
const TERMINAL_COVER_DRAFT_STATES = "('failed', 'expired', 'published')";

/**
 * Deletes an object and proves it is gone before its inventory row may go.
 *
 * The ordering is the whole point. A row removed before its object leaves bytes
 * in the bucket that nothing can ever discover again — there is no listing that
 * would find them, because every cover key sits beneath an opaque identifier
 * that only the row held. A failed delete therefore leaves the row in place and
 * the next pass retries exactly this object.
 */
async function deleteObjectFirst(bucket: R2Bucket, key: string): Promise<boolean> {
  try {
    await bucket.delete(key);
    return await bucket.head(key) === null;
  } catch {
    return false;
  }
}

/**
 * The bounded cover sweep, in the one order the foreign keys permit.
 *
 * Every cover table's `event_id` is `ON DELETE RESTRICT` and the inventory
 * tables reference each other the same way, so this is not a matter of taste:
 * receipts and backfill jobs release their references before the sets and
 * masters they name, render objects go before their sets, and masters go last.
 * A phase out of place fails on a foreign key rather than corrupting anything.
 *
 * Each class processes at most `COVER_CLEANUP_ROWS_PER_CLASS` rows and reports
 * `remainder` when it filled that bound, so a large backlog drains across
 * passes instead of turning one scheduled run into an unbounded one.
 */
export async function cleanupEventCovers(
  env: AppEnv,
  now = new Date(),
): Promise<CoverCleanupSummary> {
  const timestamp = now.toISOString();
  const limit = COVER_CLEANUP_ROWS_PER_CLASS;
  const summary: CoverCleanupSummary = {
    draftsExpired: 0,
    previewsDeleted: 0,
    receiptsExpired: 0,
    strandedDraftsReleased: 0,
    backfillJobsReleased: 0,
    rateEventsDeleted: 0,
    fencesDeleted: 0,
    setsAbandoned: 0,
    renderObjectsDeleted: 0,
    setsDeleted: 0,
    legacyObjectsDeleted: 0,
    mastersDeleted: 0,
    remainder: false,
  };
  const note = (count: number) => {
    if (count >= limit) summary.remainder = true;
    return count;
  };

  // 1. Reservations and unpublished drafts at their own expiry. A `publishing`
  // draft is absent from the state list entirely: its receipt may still be
  // nonterminal or inside its retryable restart window, and publication
  // ownership is what returns it to `ready` — never a sweep.
  const expired = await env.DB.prepare(`
    UPDATE event_cover_drafts
    SET state = 'expired', draft_revision = draft_revision + 1, updated_at = ?1
    WHERE id IN (
      SELECT id FROM event_cover_drafts
      WHERE state IN ${EXPIRABLE_COVER_DRAFT_STATES}
        AND (expires_at <= ?1
          OR (state = 'reserved' AND reservation_expires_at IS NOT NULL
              AND reservation_expires_at <= ?1))
      ORDER BY expires_at LIMIT ?2
    )
  `).bind(timestamp, limit).run();
  summary.draftsExpired = note(expired.meta.changes);

  // Raw bytes stay charged against the event's aggregate until R2 absence is
  // verified, so a discard can stop future ingress but cannot subtract
  // cleanup-pending bytes on its own say-so.
  const raws = await env.DB.prepare(`
    SELECT id, raw_object_key AS objectKey FROM event_cover_drafts
    WHERE raw_object_key IS NOT NULL AND state IN ${TERMINAL_COVER_DRAFT_STATES}
    ORDER BY updated_at LIMIT ?
  `).bind(limit).all<{ id: string; objectKey: string }>();
  for (const draft of raws.results) {
    if (!await deleteObjectFirst(env.MEDIA_BUCKET, draft.objectKey)) continue;
    await releaseCoverRawBytes(env.DB, { draftId: draft.id, now });
  }

  // 2. Preview files, which only ever belong to a draft that is over.
  const previews = await env.DB.prepare(`
    SELECT p.id, p.object_key AS objectKey FROM event_cover_draft_previews p
    JOIN event_cover_drafts d ON d.id = p.draft_id
    WHERE p.object_key IS NOT NULL AND d.state IN ${TERMINAL_COVER_DRAFT_STATES}
    ORDER BY p.updated_at LIMIT ?
  `).bind(limit).all<{ id: string; objectKey: string }>();
  for (const preview of previews.results) {
    if (!await deleteObjectFirst(env.MEDIA_BUCKET, preview.objectKey)) continue;
    const removed = await env.DB.prepare('DELETE FROM event_cover_draft_previews WHERE id = ?')
      .bind(preview.id).run();
    summary.previewsDeleted += removed.meta.changes;
  }
  note(previews.results.length);

  // 3. Receipts, which reference both a draft and a render set. Their own
  // `expires_at` already encodes the deadline their status earns: seven days
  // for `applied`, twenty-four hours for a conflict or permanent failure, and
  // the restart window for a retryable one.
  const receipts = await env.DB.prepare(`
    DELETE FROM event_cover_publish_receipts
    WHERE rowid IN (
      SELECT rowid FROM event_cover_publish_receipts
      WHERE expires_at IS NOT NULL AND expires_at <= ?1
        AND status IN ('applied', 'conflict', 'failed')
      ORDER BY expires_at LIMIT ?2
    )
  `).bind(timestamp, limit).run();
  summary.receiptsExpired = note(receipts.meta.changes);

  // 3b. A draft frozen for a publication whose receipt has now gone. `publishing`
  // is deliberately absent from the expirable states because publication
  // ownership is what returns a draft to `ready` — but once the receipt is swept
  // that owner no longer exists, and nothing else ever releases it. The draft,
  // the master it holds, and its raw bytes would otherwise be uncollectable for
  // the life of the event, and the host's one draft slot with them.
  const stranded = await env.DB.prepare(`
    UPDATE event_cover_drafts
    SET state = 'failed', draft_revision = draft_revision + 1, updated_at = ?1
    WHERE id IN (
      SELECT d.id FROM event_cover_drafts d
      WHERE d.state = 'publishing' AND d.expires_at <= ?1
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_publish_receipts r WHERE r.draft_id = d.id
        )
      ORDER BY d.expires_at LIMIT ?2
    )
  `).bind(timestamp, limit).run();
  summary.strandedDraftsReleased = note(stranded.meta.changes);

  // 4. Backfill jobs release their master and set references only once an active
  // event pointer or abandoned-set inventory owns those objects, then the rows
  // themselves expire, then an emptied run summary does.
  const released = await env.DB.prepare(`
    UPDATE event_cover_backfill_jobs
    SET master_id = NULL, render_set_id = NULL, updated_at = ?1
    WHERE id IN (
      SELECT id FROM event_cover_backfill_jobs
      WHERE reference_release_at IS NOT NULL AND reference_release_at <= ?1
        AND (master_id IS NOT NULL OR render_set_id IS NOT NULL)
      ORDER BY reference_release_at LIMIT ?2
    )
  `).bind(timestamp, limit).run();
  summary.backfillJobsReleased = note(released.meta.changes);

  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM event_cover_backfill_jobs
      WHERE rowid IN (
        SELECT rowid FROM event_cover_backfill_jobs
        WHERE expires_at IS NOT NULL AND expires_at <= ?1
          AND master_id IS NULL AND render_set_id IS NULL
        ORDER BY expires_at LIMIT ?2
      )
    `).bind(timestamp, limit),
    env.DB.prepare(`
      DELETE FROM event_cover_backfill_runs
      WHERE expires_at IS NOT NULL AND expires_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_backfill_jobs j WHERE j.run_id = event_cover_backfill_runs.id
        )
    `).bind(timestamp),
  ]);

  // 5-6. Persisted budgets and dispatch fences, both of which age out on their
  // own recorded expiry. A fence deliberately outlives the event it protected.
  const scratch = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM event_cover_rate_events
      WHERE rowid IN (
        SELECT rowid FROM event_cover_rate_events WHERE expires_at <= ?1
        ORDER BY expires_at LIMIT ?2
      )
    `).bind(timestamp, limit),
    env.DB.prepare(`
      DELETE FROM event_cover_workflow_fences
      WHERE rowid IN (
        SELECT rowid FROM event_cover_workflow_fences WHERE expires_at <= ?1
        ORDER BY expires_at LIMIT ?2
      )
    `).bind(timestamp, limit),
  ]);
  summary.rateEventsDeleted = note(scratch[0]?.meta.changes ?? 0);
  summary.fencesDeleted = note(scratch[1]?.meta.changes ?? 0);

  // 7. A staging or ready set whose owning receipt and job are both gone can
  // never activate — nothing is left that could run its final transaction — so
  // it becomes collectable rather than sitting in the bucket indefinitely. It
  // gets the same seven-day recovery window a retired set gets, which is also
  // what keeps discovery and deletion in different passes: an orphan noticed
  // today is not swept today.
  const recoveryDeadline = new Date(now.getTime() + COVER_RETIRED_RECOVERY_MS).toISOString();
  const abandoned = await env.DB.prepare(`
    UPDATE event_cover_render_sets
    SET state = 'abandoned', abandoned_reason = 'orphaned', abandoned_at = ?1, cleanup_after = ?3
    WHERE id IN (
      SELECT s.id FROM event_cover_render_sets s
      WHERE s.state IN ('staging', 'ready')
        AND s.id IS NOT (SELECT cover_render_set_id FROM events WHERE id = s.event_id)
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_publish_receipts r WHERE r.render_set_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_backfill_jobs j WHERE j.render_set_id = s.id
        )
      ORDER BY s.created_at LIMIT ?2
    )
  `).bind(timestamp, limit, recoveryDeadline).run();
  summary.setsAbandoned = note(abandoned.meta.changes);

  // 8-9. Render objects before their sets, and only for a set that is past its
  // recovery window and is not the one the event still points at.
  const collectableSets = await env.DB.prepare(`
    SELECT id FROM event_cover_render_sets
    WHERE state IN ('retired', 'abandoned')
      AND cleanup_after IS NOT NULL AND cleanup_after <= ?1
      AND id IS NOT (SELECT cover_render_set_id FROM events WHERE id = event_cover_render_sets.event_id)
      AND NOT EXISTS (SELECT 1 FROM event_cover_publish_receipts r WHERE r.render_set_id = event_cover_render_sets.id)
      AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs j WHERE j.render_set_id = event_cover_render_sets.id)
    ORDER BY cleanup_after LIMIT ?2
  `).bind(timestamp, limit).all<{ id: string }>();
  note(collectableSets.results.length);

  for (const set of collectableSets.results) {
    const objects = await env.DB.prepare(
      'SELECT id, object_key AS objectKey FROM event_cover_render_objects WHERE render_set_id = ?',
    ).bind(set.id).all<{ id: string; objectKey: string }>();
    let cleared = true;
    for (const object of objects.results) {
      if (!await deleteObjectFirst(env.MEDIA_BUCKET, object.objectKey)) {
        cleared = false;
        continue;
      }
      const removed = await env.DB.prepare('DELETE FROM event_cover_render_objects WHERE id = ?')
        .bind(object.id).run();
      summary.renderObjectsDeleted += removed.meta.changes;
    }
    // Only once every object of this set is proven gone. A partially swept set
    // keeps its row so the next pass finds the rest.
    if (!cleared) continue;
    const removed = await env.DB.prepare('DELETE FROM event_cover_render_sets WHERE id = ?')
      .bind(set.id).run();
    summary.setsDeleted += removed.meta.changes;
  }

  // 10. Displaced legacy originals, past their own recovery deadline and proven
  // not to be the key the event still serves.
  const legacy = await env.DB.prepare(`
    SELECT id, object_key AS objectKey FROM event_cover_retired_legacy_objects
    WHERE deleted_at IS NULL AND cleanup_after <= ?1
      AND object_key IS NOT (SELECT cover_object_key FROM events WHERE id = event_id)
    ORDER BY cleanup_after LIMIT ?2
  `).bind(timestamp, limit).all<{ id: string; objectKey: string }>();
  note(legacy.results.length);
  for (const object of legacy.results) {
    if (!await deleteObjectFirst(env.MEDIA_BUCKET, object.objectKey)) continue;
    const removed = await env.DB.prepare('DELETE FROM event_cover_retired_legacy_objects WHERE id = ?')
      .bind(object.id).run();
    summary.legacyObjectsDeleted += removed.meta.changes;
  }

  // 11. Masters last, because a draft, a set, a receipt, and a backfill job can
  // all reference one. §9.1 makes a *live* draft blocking, but the foreign key
  // cannot tell live from finished — so a terminal draft's pointer is released
  // in the same transaction that removes the row it was holding.
  const masters = await env.DB.prepare(`
    SELECT m.id, m.object_key AS objectKey FROM event_cover_masters m
    WHERE m.cleanup_after IS NOT NULL AND m.cleanup_after <= ?1
      AND m.object_key IS NOT (SELECT cover_object_key FROM events WHERE id = m.event_id)
      AND NOT EXISTS (
        SELECT 1 FROM event_cover_drafts d
        WHERE d.master_id = m.id AND d.state IN ${LIVE_COVER_DRAFT_STATES}
      )
      AND NOT EXISTS (SELECT 1 FROM event_cover_render_sets s WHERE s.master_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs j WHERE j.master_id = m.id)
    ORDER BY m.cleanup_after LIMIT ?2
  `).bind(timestamp, limit).all<{ id: string; objectKey: string }>();
  note(masters.results.length);
  for (const master of masters.results) {
    if (!await deleteObjectFirst(env.MEDIA_BUCKET, master.objectKey)) continue;
    const results = await env.DB.batch([
      env.DB.prepare(`
        UPDATE event_cover_drafts SET master_id = NULL, updated_at = ?
        WHERE master_id = ? AND state NOT IN ${LIVE_COVER_DRAFT_STATES}
      `).bind(timestamp, master.id),
      env.DB.prepare('DELETE FROM event_cover_masters WHERE id = ?').bind(master.id),
    ]);
    summary.mastersDeleted += results[1]?.meta.changes ?? 0;
  }

  return summary;
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

/* ------------------------------------------------------------------ *
 * Event purge coordination
 * ------------------------------------------------------------------ */

/**
 * The expiry an unresolved blocked fence is held at.
 *
 * Two jobs in one value. The bounded sweep deletes fences by `expires_at`, so a
 * fence still protecting an unfinished purge must never be reachable by it; and
 * `0012` gives the fence no "settled" column, so the sentinel *is* the marker —
 * a blocked fence still holding it has not been verified terminal, and one that
 * no longer holds it has. Exact equality rather than a comparison, so the test
 * for "unresolved" can never drift into a range check that a re-stamped expiry
 * accidentally satisfies.
 */
export const FENCE_PURGE_HOLD_EXPIRES_AT = '9999-12-31T23:59:59.999Z';

/**
 * 31 days past terminal verification, exceeding the platform's own 30-day
 * retention for a completed instance so its ID can never be recreated behind us.
 */
const FENCE_TERMINAL_TTL_MS = 31 * 24 * 60 * 60 * 1000;

export interface CoverPurgeProgressSummary {
  eventId: string;
  /** `complete` is not a stored phase: `0012` allows only the first three, and
   * completion is the progress row no longer existing. */
  phase: 'fences' | 'r2' | 'relational' | 'complete';
  inspected: number;
  platformMutations: number;
  remainder: boolean;
}

export interface CoverPurgeWorkflowAccessors {
  render: CoverWorkflowAccessor;
  backfill: CoverBackfillWorkflowAccessor;
}

interface HeldFenceRow {
  workflow_binding: string;
  workflow_instance_id: string;
  created_at: string;
}

/**
 * How long a fence nobody can classify may hold a purge open.
 *
 * `unknown` never settles, and that is right: acting on absent information is
 * how a swept prefix ends up underneath a running instance. But the hold
 * sentinel also removes the fence from the only sweep that would ever have
 * deleted it, so "never settles" was literally never — a fence opened for a
 * `create()` that failed answers no status read and no terminate, and the event
 * behind it stayed soft-deleted with every object intact for good.
 *
 * The bound is the fence's own TTL, which is already chosen to exceed the
 * platform's retention of a completed instance. A cover Workflow renders at most
 * twenty-four objects from one master; none of them is a month-long job, so an
 * ID that has been silent for that long is not an instance that might still
 * write — it is a fence for work that never started. Past that point the purge
 * stops waiting, having tried to stop it one more time first.
 */
const FENCE_UNRESOLVABLE_AFTER_MS = 31 * 24 * 60 * 60 * 1000;

/** What a purge does about one lookup. Total, with an explicit wait default. */
function purgeActionFor(lookup: CoverWorkflowLookup): 'terminate' | 'settle' | 'materialize' | 'wait' {
  if (lookup.kind === 'unknown') return 'wait';
  if (lookup.kind === 'missing') return 'materialize';
  switch (lookup.status) {
    // Still able to do work, so it is stopped before the prefix is swept.
    case 'queued':
    case 'running':
    case 'waiting':
    case 'waitingForPause':
    case 'paused':
      return 'terminate';
    case 'errored':
    case 'terminated':
    case 'complete':
      return 'settle';
    // The platform's own `unknown`, and any status this release has never seen.
    // Neither is evidence the instance is finished, and neither may be acted on.
    case 'unknown':
    default:
      return 'wait';
  }
}

/** Never throws: an accessor that rejects leaves the fence unresolved. */
async function purgeLookup(
  accessor: { lookup(id: string): Promise<CoverWorkflowLookup> },
  instanceId: string,
): Promise<CoverWorkflowLookup> {
  return accessor.lookup(instanceId)
    .catch((): CoverWorkflowLookup => ({ kind: 'unknown', telemetry: 'cover_purge_lookup_failed' }));
}

/**
 * Recreates a certified-absent instance from its own immutable payload.
 *
 * Under the same fenced ID, never a fresh one: the point is to obtain something
 * that can be driven terminal and verified, not to start new work. Returns false
 * when the payload row is gone or the platform refuses, which leaves the fence
 * unresolved for a later pass rather than advancing the purge on a guess.
 */
async function materializeForPurge(
  env: AppEnv,
  fence: HeldFenceRow,
  eventId: string,
  accessors: CoverPurgeWorkflowAccessors,
): Promise<boolean> {
  try {
    if (fence.workflow_binding === COVER_BACKFILL_BINDING) {
      const job = await env.DB.prepare(`
        SELECT id, run_id FROM event_cover_backfill_jobs
        WHERE event_id = ? AND workflow_instance_id = ?
      `).bind(eventId, fence.workflow_instance_id).first<{ id: string; run_id: string }>();
      if (!job) return false;
      await accessors.backfill.createBatch([{
        id: fence.workflow_instance_id,
        params: { runId: job.run_id, jobId: job.id, eventId },
      }]);
      return true;
    }
    const receipt = await env.DB.prepare(`
      SELECT operation_id FROM event_cover_publish_receipts
      WHERE event_id = ? AND workflow_instance_id = ?
    `).bind(eventId, fence.workflow_instance_id).first<{ operation_id: string }>();
    if (!receipt) return false;
    await accessors.render.create(fence.workflow_instance_id, {
      eventId, operationId: receipt.operation_id,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Settles every fence this event still holds, bounded, and reports what remains.
 *
 * The cursor lets an event with more fences than one pass allows drain across
 * passes; when the walk reaches the end it resets, so fences left unresolved by
 * an earlier pass are revisited rather than skipped forever. The phase advances
 * only on a fresh count of zero, never on this pass having merely finished.
 */
async function settleEventCoverFences(
  env: AppEnv,
  eventId: string,
  now: Date,
  accessors: CoverPurgeWorkflowAccessors,
  summary: CoverPurgeProgressSummary,
): Promise<boolean> {
  const timestamp = now.toISOString();
  const cursor = await env.DB.prepare(`
    SELECT workflow_binding, workflow_instance_id FROM event_cover_purge_progress
    WHERE event_id = ?
  `).bind(eventId).first<{ workflow_binding: string | null; workflow_instance_id: string | null }>();

  const held = await env.DB.prepare(`
    SELECT workflow_binding, workflow_instance_id, created_at FROM event_cover_workflow_fences
    WHERE event_id = ?1 AND state = 'deletion-blocked' AND expires_at = ?2
      AND (workflow_binding > ?3
        OR (workflow_binding = ?3 AND workflow_instance_id > ?4))
    ORDER BY workflow_binding, workflow_instance_id
    LIMIT ?5
  `).bind(
    eventId, FENCE_PURGE_HOLD_EXPIRES_AT,
    cursor?.workflow_binding ?? '', cursor?.workflow_instance_id ?? '',
    COVER_CLEANUP_ROWS_PER_CLASS,
  ).all<HeldFenceRow>();

  // Rows *resolved*, which is what the column is called and what an operator
  // watching a stalled purge needs. `summary.inspected` counts rows read, and a
  // pass that reads the same unresolved fence every day would otherwise report a
  // resolution count larger than the number of fences the event ever had.
  let resolved = 0;

  for (const fence of held.results) {
    summary.inspected += 1;
    const accessor = fence.workflow_binding === COVER_BACKFILL_BINDING
      ? accessors.backfill
      : accessors.render;

    let lookup = await purgeLookup(accessor, fence.workflow_instance_id);
    let action = purgeActionFor(lookup);

    if (action === 'materialize') {
      if (!await materializeForPurge(env, fence, eventId, accessors)) continue;
      summary.platformMutations += 1;
      action = 'terminate';
    }

    if (action === 'terminate') {
      try {
        await accessor.terminate(fence.workflow_instance_id);
      } catch {
        // The next pass retries exactly this instance.
        continue;
      }
      summary.platformMutations += 1;
      // Re-read rather than assume: terminate returning is not proof the
      // instance reached a terminal state, and the fence may only be released
      // against an observed one.
      lookup = await purgeLookup(accessor, fence.workflow_instance_id);
      action = purgeActionFor(lookup);
    }

    if (action !== 'settle') {
      // Still unclassifiable, and young enough that it might yet be real.
      if (Date.parse(fence.created_at) + FENCE_UNRESOLVABLE_AFTER_MS > now.getTime()) continue;
      // Older than any cover instance can be. One last attempt to stop whatever
      // might be behind it, then the purge stops waiting on an answer that is
      // never going to come.
      try {
        await accessor.terminate(fence.workflow_instance_id);
        summary.platformMutations += 1;
      } catch { /* Nothing is there to stop; settling is the point. */ }
    }

    const released = await env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET expires_at = ?, updated_at = ?
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND state = 'deletion-blocked'
    `).bind(
      new Date(now.getTime() + FENCE_TERMINAL_TTL_MS).toISOString(), timestamp,
      fence.workflow_binding, fence.workflow_instance_id,
    ).run();
    resolved += released.meta.changes;
  }

  const last = held.results[held.results.length - 1];
  const exhausted = held.results.length < COVER_CLEANUP_ROWS_PER_CLASS;
  await env.DB.prepare(`
    UPDATE event_cover_purge_progress
    SET workflow_binding = ?, workflow_instance_id = ?, fences_resolved = fences_resolved + ?,
        platform_mutations = platform_mutations + ?, updated_at = ?
    WHERE event_id = ?
  `).bind(
    exhausted ? null : last?.workflow_binding ?? null,
    exhausted ? null : last?.workflow_instance_id ?? null,
    resolved, summary.platformMutations, timestamp, eventId,
  ).run();

  const unresolved = await env.DB.prepare(`
    SELECT count(*) AS count FROM event_cover_workflow_fences
    WHERE event_id = ? AND state = 'deletion-blocked' AND expires_at = ?
  `).bind(eventId, FENCE_PURGE_HOLD_EXPIRES_AT).first<{ count: number }>();
  return (unresolved?.count ?? 0) === 0;
}

/**
 * Retires one event completely, in persisted phases that survive interruption.
 *
 * The order is load-bearing. Every credential is revoked, every nonterminal
 * cover row is made terminal, and every open fence is blocked first, so nothing
 * can reach the event or start new cover work while its objects are being
 * removed. Then every blocked fence is driven to an *observed* terminal state:
 * until a fresh count proves none is outstanding, the prefix is not touched,
 * because a running instance and a swept prefix is exactly how a cover write
 * lands in a bucket nothing will ever look in again. Only once the prefix is
 * actually gone does the relational purge run, and if any step fails the event
 * stays marked deleted so a later scheduled pass retries exactly this row.
 */
export async function reconcileEventCoverPurge(
  env: AppEnv,
  eventId: string,
  now = new Date(),
  accessors?: CoverPurgeWorkflowAccessors,
): Promise<CoverPurgeProgressSummary> {
  const timestamp = now.toISOString();
  const summary: CoverPurgeProgressSummary = {
    eventId, phase: 'fences', inspected: 0, platformMutations: 0, remainder: true,
  };
  const platform = accessors ?? {
    render: defaultCoverWorkflowAccessor(env),
    backfill: defaultCoverBackfillWorkflowAccessor(env),
  };

  // Idempotent: every statement is guarded, so a resumed purge re-runs this
  // without undoing a phase it already finished.
  await env.DB.batch([
    env.DB.prepare('UPDATE events SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE event_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare('UPDATE rsvp_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE event_id = ?').bind(timestamp, eventId),
    env.DB.prepare(`
      UPDATE event_entry_credentials SET disabled_at = COALESCE(disabled_at, ?) WHERE event_id = ?
    `).bind(timestamp, eventId),
    // Accepted work that can no longer be delivered is made terminal here rather
    // than left `preparing` forever behind a deleted event.
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
          dispatch_state = 'blocked', updated_at = ?
      WHERE event_id = ? AND status IN ('queued', 'rendering', 'finalizing')
    `).bind(timestamp, eventId),
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
          dispatch_state = 'blocked', terminal_at = COALESCE(terminal_at, ?), updated_at = ?
      WHERE event_id = ? AND status IN ('queued', 'normalizing', 'rendering', 'finalizing')
    `).bind(timestamp, timestamp, eventId),
    env.DB.prepare(`
      UPDATE event_cover_backfill_runs SET
        queued_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id
            AND j.status IN ('queued', 'normalizing', 'rendering', 'finalizing')),
        failed_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id AND j.status = 'failed'),
        updated_at = ?
      WHERE id IN (SELECT run_id FROM event_cover_backfill_jobs WHERE event_id = ?)
    `).bind(timestamp, eventId),
    // The fence is what actually stops a late dispatcher, and holding its expiry
    // keeps the bounded sweep from removing it mid-purge.
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET state = 'deletion-blocked', expires_at = ?, updated_at = ?
      WHERE event_id = ? AND state = 'open'
    `).bind(FENCE_PURGE_HOLD_EXPIRES_AT, timestamp, eventId),
    env.DB.prepare(`
      INSERT INTO event_cover_purge_progress (event_id, phase, created_at, updated_at)
      SELECT ?, 'fences', ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)
      ON CONFLICT (event_id) DO NOTHING
    `).bind(eventId, timestamp, timestamp, eventId),
  ]);

  const progress = await env.DB.prepare(
    'SELECT phase FROM event_cover_purge_progress WHERE event_id = ?',
  ).bind(eventId).first<{ phase: string }>();
  // No progress row and no event row means an earlier pass already finished.
  if (!progress) {
    return { ...summary, phase: 'complete', remainder: false };
  }

  let phase = progress.phase;
  if (phase === 'fences') {
    const settled = await settleEventCoverFences(env, eventId, now, platform, summary);
    if (!settled) return { ...summary, phase: 'fences', remainder: true };
    await env.DB.prepare(`
      UPDATE event_cover_purge_progress SET phase = 'r2', updated_at = ? WHERE event_id = ?
    `).bind(timestamp, eventId).run();
    phase = 'r2';
  }

  if (phase === 'r2') {
    // The existing prefix already covers all four cover key shapes — raw,
    // masters, previews, rendered — because every one of them is built beneath
    // `events/{eventId}/cover/`. `cleanup.test.ts` asserts that rather than
    // assuming it.
    await deletePrefix(env.MEDIA_BUCKET, `events/${eventId}/`);
    const remaining = await env.MEDIA_BUCKET.list({ prefix: `events/${eventId}/` });
    if (remaining.objects.length > 0) {
      return { ...summary, phase: 'r2', remainder: true };
    }
    await env.DB.prepare(`
      UPDATE event_cover_purge_progress SET phase = 'relational', updated_at = ? WHERE event_id = ?
    `).bind(timestamp, eventId).run();
  }

  await purgeEventRelationalRows(env, eventId, timestamp);
  return { ...summary, phase: 'complete', remainder: false };
}

/**
 * The relational half, unchanged in order and still schema-enforced.
 *
 * Reached only once every fence is verified terminal and the prefix is proven
 * empty, so nothing here can strand an object.
 */
async function purgeEventRelationalRows(
  env: AppEnv,
  eventId: string,
  timestamp: string,
): Promise<void> {
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
        -- The same four statuses recomputeBackfillRunCounters uses. This batch
        -- runs last in a purge, so a narrower definition here would silently
        -- overwrite the canonical count with one that omits every job the run
        -- still has in flight for some other event.
        queued_count = (SELECT count(*) FROM event_cover_backfill_jobs j
          WHERE j.run_id = event_cover_backfill_runs.id
            AND j.status IN ('queued', 'normalizing', 'rendering', 'finalizing')),
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

/**
 * Retires one event, from the caller that does not care about phases.
 *
 * An event with no cover fence still finishes in this one call, which is the
 * common case. One that owns unresolved fences is soft-deleted, fenced, and left
 * for the scheduled pass to finish — the host's delete has still taken effect,
 * because every credential is revoked before this returns.
 */
export async function deleteEventData(env: AppEnv, eventId: string, now = new Date()): Promise<void> {
  await reconcileEventCoverPurge(env, eventId, now);
}

export async function scheduledCleanup(env: AppEnv, now = new Date()): Promise<void> {
  await cleanupAuthScratch(env, now);
  await cleanupRsvpScratch(env, now);
  await cleanupExpiredReservations(env, now);
  await cleanupExpiredExports(env, now);
  // Before the purge, not after: an event whose retention is due may own cover
  // rows this sweep is the only thing that removes, and a purge that ran first
  // would meet them as foreign-key failures instead of finding them already
  // collected. Its own bound means a large backlog drains across passes rather
  // than making one scheduled run unbounded.
  await cleanupEventCovers(env, now);
  // After the cover sweep and before the purge, because it is the phase that
  // turns an interrupted dispatch back into an observable one: a claim left
  // `creating` by a lost terminal is replayed through idempotent `createBatch`
  // and confirmed, and a claim whose fence a purge has taken is settled here
  // rather than being met as a surprise by the purge itself. Its own bound means
  // a backlog drains across passes.
  await recoverStaleInitialBackfillDispatches(env, now);
  // After recovery, because an initial claim replayed a moment ago is not a
  // divergence to reconcile, and before the purge, because a job whose event is
  // going away must be settled by the coordinator that owns the fence rather
  // than resumed or restarted into a prefix that is about to be swept.
  await reconcileCoverBackfillJobs(env, now);
  // Notification delivery is no longer part of this run. It has its own hourly
  // trigger and its own durable state, so a mail failure and a retention purge no
  // longer share a failure boundary in either direction.
  //
  // Rows already marked deleted are selected too: a purge whose object deletion
  // failed is retried here until it succeeds, rather than being left behind with
  // objects no later pass would look for.
  //
  // Least-recently-attempted first, and that ordering is load-bearing rather
  // than tidiness. A purge can now legitimately return unfinished — an
  // unresolved fence parks it in the `fences` phase — and an unordered
  // `LIMIT 100` would hand every future pass the same hundred stalled rows, so
  // an event deleted today would never be selected at all. An event that has
  // never been attempted has no progress row and sorts first; one the last pass
  // already worked on sorts behind it.
  const purged = await env.DB.prepare(`
    SELECT e.id FROM events e
    LEFT JOIN event_cover_purge_progress p ON p.event_id = e.id
    WHERE e.deleted_at IS NOT NULL OR e.purge_after <= ?
    ORDER BY COALESCE(p.updated_at, '') , e.id LIMIT 100
  `).bind(now.toISOString()).all<{ id: string }>();
  for (const event of purged.results) await deleteEventData(env, event.id, now);
}

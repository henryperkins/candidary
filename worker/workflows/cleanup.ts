import {
  COVER_CLEANUP_ROWS_PER_CLASS,
  COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX,
  COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
  MAX_COVER_PURGE_FENCES_PER_PASS,
  MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS,
  GUEST_NOTE_WINDOW_MS,
  coverWorkflowFenceTerminalExpiry,
} from '../../shared/constants';
import type { AppEnv } from '../env';
import { ExportsRepository } from '../db/exports';
import { MediaRepository } from '../db/media';
import { AUTH_RATE_LIMIT_WINDOW_MS } from '../db/auth-rate-limits';
import { releaseCoverRawBytes } from '../db/event-covers';
import { RSVP_LOOKUP_RATE_WINDOW_MS } from '../db/rsvp-rate-limits';
import { STALE_DISPATCH_CLAIM_MS } from '../services/event-cover-publication';
import {
  BACKFILL_RESTART_WINDOW_MS,
  COVER_BACKFILL_BINDING,
  closeCoverBackfillRuns,
  reconcileCoverBackfillJobs,
  recoverStaleInitialBackfillDispatches,
  resolveSupersededBackfillJobsBounded,
} from './cover-backfill';
import {
  defaultCoverBackfillWorkflowAccessor,
  defaultCoverWorkflowAccessor,
  dispositionForLookup,
  emitCoverPlatformTelemetry,
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
  const timestamp = now.toISOString();
  const expired = await repository.listExpiredReady(timestamp);
  let cleaned = 0;
  for (const job of expired) {
    const parts = await repository.listParts(job.id);
    const keys = [
      job.objectKey,
      job.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      job.guestbookHtmlObjectKey,
      job.guestbookCsvObjectKey,
    ]
      .filter((key): key is string => Boolean(key));
    if (keys.length) await env.MEDIA_BUCKET.delete(keys);
    if (await repository.markExpired(job.id, timestamp)) cleaned += 1;
  }
  return cleaned;
}

async function deleteEventExportInventory(env: AppEnv, eventId: string): Promise<void> {
  const repository = new ExportsRepository(env.DB);
  const jobs = await repository.listForEvent(eventId);
  for (const job of jobs) {
    const parts = await repository.listParts(job.id);
    const keys = [
      job.objectKey,
      job.manifestObjectKey,
      ...parts.map(({ objectKey }) => objectKey),
      job.guestbookHtmlObjectKey,
      job.guestbookCsvObjectKey,
    ].filter((key): key is string => Boolean(key));
    if (keys.length) await env.MEDIA_BUCKET.delete(keys);
  }
}

// Each pass deletes at most this many rows per table, and the sweep repeats until a
// pass comes back short. A single 100-row pass per day could not keep up: fifteen
// minute windows mean one busy address alone can leave ~96 rate-limit buckets a day,
// and pending registrations hold a scrypt hash until they are swept.
const AUTH_SCRATCH_BATCH = 100;
const AUTH_SCRATCH_MAX_PASSES = 50;

function settledBackfillJobRetentionSql(restartFloorSql: string): string {
  return `(status IN ('applied', 'skipped', 'resolved')
    OR (status = 'failed' AND (
      retryable = 0 OR (terminal_at IS NOT NULL AND terminal_at <= ${restartFloorSql})
    )))`;
}

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

// Guest-message quota rows are scratch; purge receipts are deliberately not.
// Each statement has a hard page bound and the pass cap prevents one scheduled
// invocation from turning a pathological backlog into an unbounded delete.
const GUEST_MESSAGE_SCRATCH_BATCH = 100;
const GUEST_MESSAGE_SCRATCH_MAX_PASSES = 50;

export async function cleanupGuestMessageRateEvents(
  env: AppEnv,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - GUEST_NOTE_WINDOW_MS).toISOString();
  let total = 0;
  for (let pass = 0; pass < GUEST_MESSAGE_SCRATCH_MAX_PASSES; pass += 1) {
    const deleted = await env.DB.prepare(`
      DELETE FROM guest_message_rate_events
      WHERE rowid IN (
        SELECT rowid FROM guest_message_rate_events
        WHERE window_started_at < ?
        ORDER BY window_started_at, created_at, id
        LIMIT ?
      )
    `).bind(cutoff, GUEST_MESSAGE_SCRATCH_BATCH).run();
    const changes = deleted.meta.changes ?? 0;
    total += changes;
    if (changes < GUEST_MESSAGE_SCRATCH_BATCH) break;
  }
  return total;
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
/** A newly permanent publication failure remains queryable for one day. */
const COVER_RECEIPT_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

const LIVE_COVER_DRAFT_STATES = "('reserved', 'transferred', 'inspected', 'ready', 'publishing')";
const EXPIRABLE_COVER_DRAFT_STATES = "('reserved', 'transferred', 'inspected', 'ready', 'failed')";
const TERMINAL_COVER_DRAFT_STATES = "('failed', 'expired', 'published')";

/**
 * Old purge code could write any plain ISO deadline after guessing from age.
 * It could not write this suffix, so the exact tagged deadline is durable proof
 * that the terminal-only coordinator, rather than an old escape hatch, released
 * a deletion-blocked fence.
 */
function coverPurgeFenceTerminalExpiry(now: Date): string {
  return `${coverWorkflowFenceTerminalExpiry(now)}${COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX}`;
}

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
  workflow?: CoverWorkflowAccessor,
): Promise<CoverCleanupSummary> {
  const timestamp = now.toISOString();
  const backfillRestartFloor = new Date(
    now.getTime() - BACKFILL_RESTART_WINDOW_MS,
  ).toISOString();
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

  // An expired retryable publication still blocks a competitor until the
  // recorded Workflow is observed terminal. The expiry pass first rejects
  // unknown evidence, then claims the exact receipt/fence generation and holds
  // it. A post-claim terminal reading (fresh again after any termination) is
  // required before releasing the draft/set and clearing `retryable`.
  const cleanupDay = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
  const expiringRetryableReceipts = await env.DB.prepare(`
    WITH candidates AS (
      SELECT r.event_id, r.operation_id, r.expected_revision, r.draft_id, r.render_set_id,
        r.workflow_instance_id, r.dispatch_state, r.dispatch_generation,
        r.failure_code, r.last_dispatch_at, r.updated_at, r.expires_at,
        COALESCE(r.last_dispatch_at, r.updated_at) AS claim_at,
        ROW_NUMBER() OVER (
          ORDER BY r.expires_at, r.event_id, r.operation_id
        ) - 1 AS ordinal,
        COUNT(*) OVER () AS candidate_count
      FROM event_cover_publish_receipts r
      WHERE r.action = 'publish' AND r.status = 'failed' AND r.retryable = 1
        AND r.expires_at <= ?1
        AND EXISTS (SELECT 1 FROM events e WHERE e.id = r.event_id AND e.deleted_at IS NULL)
    ), rotated AS (
      SELECT *, CAST((candidate_count + ?2 - 1) / ?2 AS INTEGER) AS window_count
      FROM candidates
    )
    SELECT event_id, operation_id, expected_revision, draft_id, render_set_id, workflow_instance_id,
      dispatch_state, dispatch_generation, failure_code, last_dispatch_at,
      updated_at, expires_at, claim_at
    FROM rotated
    ORDER BY (
      ordinal - (
        (CAST(?3 / window_count AS INTEGER) + (?3 % window_count) * ?2)
        % candidate_count
      ) + candidate_count
    ) % candidate_count
    LIMIT ?2
  `).bind(
    timestamp, MAX_COVER_PURGE_FENCES_PER_PASS, cleanupDay,
  ).all<ExpiringRetryableReceipt>();
  if (expiringRetryableReceipts.results.length >= MAX_COVER_PURGE_FENCES_PER_PASS) {
    summary.remainder = true;
  }
  const platform = workflow ?? defaultCoverWorkflowAccessor(env);
  let platformInspections = 0;
  let platformMutations = 0;
  for (const receipt of expiringRetryableReceipts.results) {
    if (platformInspections >= MAX_COVER_PURGE_FENCES_PER_PASS) {
      summary.remainder = true;
      break;
    }
    if (isYoungRetryableReceiptClaim(receipt, now) || !receipt.workflow_instance_id) {
      summary.remainder = true;
      continue;
    }

    platformInspections += 1;
    const initialLookup = await retryableReceiptExpiryLookup(
      platform, receipt.workflow_instance_id,
    );
    const initialAction = retryableReceiptExpiryActionFor(initialLookup);
    if (initialAction === 'wait') {
      summary.remainder = true;
      continue;
    }
    if (platformInspections >= MAX_COVER_PURGE_FENCES_PER_PASS) {
      summary.remainder = true;
      continue;
    }

    const claimState: RetryableReceiptExpiryClaimState = initialLookup.kind === 'status'
      && initialLookup.status === 'paused'
      ? 'resuming'
      : 'restarting';
    const generation = await claimRetryableReceiptExpiry(env, receipt, claimState, now);
    if (generation === null) {
      summary.remainder = true;
      continue;
    }

    platformInspections += 1;
    let action = retryableReceiptExpiryActionFor(await retryableReceiptExpiryLookup(
      platform, receipt.workflow_instance_id,
    ));
    if (action === 'terminate') {
      if (platformMutations >= MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS
        || platformInspections >= MAX_COVER_PURGE_FENCES_PER_PASS) {
        summary.remainder = true;
        continue;
      }
      platformMutations += 1;
      try {
        await platform.terminate(receipt.workflow_instance_id);
      } catch {
        // The call may have reached the platform. Only the fresh lookup below
        // decides whether this generation now has terminal proof.
      }
      platformInspections += 1;
      const observed = await retryableReceiptExpiryLookup(
        platform, receipt.workflow_instance_id,
      );
      action = retryableReceiptExpiryActionFor(observed);
    }
    if (action !== 'settle') {
      summary.remainder = true;
      continue;
    }
    if (!await settleRetryableReceiptExpiry(
      env, receipt, claimState, generation, now,
    )) {
      summary.remainder = true;
    }
  }

  // Legacy releases created open fences with a creation-relative expiry. An
  // exact generation-matching terminal owner first upgrades that old value to
  // its full terminal-relative deadline. Deletion happens only on a later pass,
  // so the derived deadline is durable before age can act on it.
  //
  // Owner expiry below remains guarded by the fence, so an upgrade cannot lose
  // its proof even when the fence/owner bounds and expiry orders differ.
  const upgradedFences = await env.DB.prepare(`
    WITH terminal_owners AS (
      SELECT f.rowid AS fence_rowid, f.expires_at AS fence_expires_at,
        r.updated_at AS terminal_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', r.updated_at, '+31 days') AS terminal_expires_at
      FROM event_cover_workflow_fences f
      JOIN event_cover_publish_receipts r
        ON f.workflow_binding = 'COVER_RENDER_WORKFLOW'
       AND r.event_id = f.event_id AND r.workflow_instance_id = f.workflow_instance_id
       AND r.dispatch_generation = f.dispatch_generation
      WHERE f.state = 'open' AND r.updated_at >= f.created_at AND (
        r.status IN ('applied', 'conflict')
        OR (r.status = 'failed' AND r.retryable = 0)
      )
      UNION ALL
      SELECT f.rowid AS fence_rowid, f.expires_at AS fence_expires_at,
        j.terminal_at AS terminal_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', j.terminal_at, '+31 days') AS terminal_expires_at
      FROM event_cover_workflow_fences f
      JOIN event_cover_backfill_jobs j
        ON f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
       AND j.event_id = f.event_id AND j.workflow_instance_id = f.workflow_instance_id
       AND j.dispatch_generation = f.dispatch_generation
      WHERE f.state = 'open' AND j.terminal_at IS NOT NULL
        AND j.terminal_at >= f.created_at AND (
        j.status IN ('applied', 'skipped', 'resolved', 'needs_replacement')
        OR (j.status = 'failed' AND (
          j.retryable = 0 OR j.terminal_at <= ?3
        ))
      )
    )
    UPDATE event_cover_workflow_fences
    SET expires_at = (
          SELECT terminal_expires_at FROM terminal_owners
          WHERE fence_rowid = event_cover_workflow_fences.rowid
        ),
        updated_at = (
          SELECT terminal_at FROM terminal_owners
          WHERE fence_rowid = event_cover_workflow_fences.rowid
        )
    WHERE rowid IN (
      SELECT fence_rowid FROM terminal_owners
      WHERE terminal_expires_at IS NOT NULL
        AND fence_expires_at <> terminal_expires_at
      ORDER BY fence_expires_at LIMIT ?2
    )
  `).bind(timestamp, limit, backfillRestartFloor).run();

  if (upgradedFences.meta.changes > 0) {
    // A later pass consumes the now-durable deadline. This also makes a partial
    // (<100) upgrade visible to callers rather than claiming the class drained.
    summary.remainder = true;
  } else {
    const fences = await env.DB.prepare(`
      DELETE FROM event_cover_workflow_fences
      WHERE rowid IN (
        SELECT f.rowid FROM event_cover_workflow_fences f
        WHERE f.expires_at <= (?1 || ?4) AND (
          (
            f.state = 'deletion-blocked'
            AND strftime(
              '%Y-%m-%dT%H:%M:%fZ', f.updated_at, '+31 days'
            ) IS NOT NULL
            AND f.expires_at = strftime(
              '%Y-%m-%dT%H:%M:%fZ', f.updated_at, '+31 days'
            ) || ?4
            AND strftime(
              '%Y-%m-%dT%H:%M:%fZ', f.updated_at, '+31 days'
            ) <= ?1
          )
          OR (
            f.expires_at <= ?1 AND f.state = 'open'
            AND f.workflow_binding = 'COVER_RENDER_WORKFLOW'
            AND EXISTS (
              SELECT 1 FROM event_cover_publish_receipts r
              WHERE r.event_id = f.event_id
                AND r.workflow_instance_id = f.workflow_instance_id
                AND r.dispatch_generation = f.dispatch_generation
                AND r.updated_at >= f.created_at
                AND (
                  r.status IN ('applied', 'conflict')
                  OR (r.status = 'failed' AND r.retryable = 0)
                )
                AND f.expires_at = strftime(
                  '%Y-%m-%dT%H:%M:%fZ', r.updated_at, '+31 days'
                )
            )
          )
          OR (
            f.expires_at <= ?1 AND f.state = 'open'
            AND f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
            AND EXISTS (
              SELECT 1 FROM event_cover_backfill_jobs j
              WHERE j.event_id = f.event_id
                AND j.workflow_instance_id = f.workflow_instance_id
                AND j.dispatch_generation = f.dispatch_generation
                AND j.terminal_at IS NOT NULL
                AND j.terminal_at >= f.created_at
                AND (
                  j.status IN ('applied', 'skipped', 'resolved', 'needs_replacement')
                  OR (j.status = 'failed' AND (
                    j.retryable = 0 OR j.terminal_at <= ?3
                  ))
                )
                AND f.expires_at = strftime(
                  '%Y-%m-%dT%H:%M:%fZ', j.terminal_at, '+31 days'
                )
            )
          )
        )
        ORDER BY f.expires_at LIMIT ?2
      )
    `).bind(
      timestamp, limit, backfillRestartFloor,
      COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX,
    ).run();
    summary.fencesDeleted = note(fences.meta.changes);
  }

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
        AND (status IN ('applied', 'conflict') OR (status = 'failed' AND retryable = 0))
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = 'COVER_RENDER_WORKFLOW'
            AND f.event_id = event_cover_publish_receipts.event_id
            AND f.workflow_instance_id = event_cover_publish_receipts.workflow_instance_id
        )
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
        AND ${settledBackfillJobRetentionSql('?3')}
        AND (master_id IS NOT NULL OR render_set_id IS NOT NULL)
      ORDER BY reference_release_at LIMIT ?2
    )
  `).bind(timestamp, limit, backfillRestartFloor).run();
  summary.backfillJobsReleased = note(released.meta.changes);

  const expiredBackfillLedger = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM event_cover_backfill_jobs
      WHERE rowid IN (
        SELECT rowid FROM event_cover_backfill_jobs
        WHERE expires_at IS NOT NULL AND expires_at <= ?1
          AND ${settledBackfillJobRetentionSql('?3')}
          AND master_id IS NULL AND render_set_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM event_cover_workflow_fences f
            WHERE f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
              AND f.event_id = event_cover_backfill_jobs.event_id
              AND f.workflow_instance_id = event_cover_backfill_jobs.workflow_instance_id
          )
        ORDER BY expires_at, id LIMIT ?2
      )
    `).bind(timestamp, limit, backfillRestartFloor),
    env.DB.prepare(`
      DELETE FROM event_cover_backfill_runs
      WHERE rowid IN (
        SELECT rowid FROM event_cover_backfill_runs
        WHERE status IN ('verified', 'failed')
          AND expires_at IS NOT NULL AND expires_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM event_cover_backfill_jobs j
            WHERE j.run_id = event_cover_backfill_runs.id
          )
        ORDER BY expires_at, id LIMIT ?2
      )
    `).bind(timestamp, limit),
  ]);
  // Jobs and runs are independent bounded classes even though the second sees
  // the first statement's committed deletions in the same atomic batch.
  note(expiredBackfillLedger[0]?.meta.changes ?? 0);
  note(expiredBackfillLedger[1]?.meta.changes ?? 0);

  // 5. Persisted budgets age out on their own recorded expiry. Dispatch fences
  // were handled before their owner rows so terminal proof could not be lost.
  const scratch = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM event_cover_rate_events
      WHERE rowid IN (
        SELECT rowid FROM event_cover_rate_events WHERE expires_at <= ?1
        ORDER BY expires_at LIMIT ?2
      )
    `).bind(timestamp, limit),
  ]);
  summary.rateEventsDeleted = note(scratch[0]?.meta.changes ?? 0);

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

/**
 * Durable upgrade marker stored in the existing purge cursor column.
 *
 * Releases before terminal-proof fencing wrote only NULL or one of the two
 * literal Workflow bindings here. Prefixing the cursor therefore creates a
 * migration-free protocol version old code could not have synthesized. The
 * upgrade batch re-holds every blocked fence before publishing this marker.
 */
const COVER_PURGE_FENCE_PROTOCOL_V2 = 'terminal-proof-v2:';

function encodedPurgeFenceCursor(binding: string | null): string {
  return `${COVER_PURGE_FENCE_PROTOCOL_V2}${binding ?? ''}`;
}

function decodedPurgeFenceCursor(value: string | null): string | null {
  if (!value?.startsWith(COVER_PURGE_FENCE_PROTOCOL_V2)) return null;
  const binding = value.slice(COVER_PURGE_FENCE_PROTOCOL_V2.length);
  return binding === 'COVER_RENDER_WORKFLOW' || binding === COVER_BACKFILL_BINDING
    ? binding
    : null;
}

const COVER_PURGE_FENCE_PROTOCOL_CURSOR_VALUES = [
  encodedPurgeFenceCursor(null),
  encodedPurgeFenceCursor('COVER_RENDER_WORKFLOW'),
  encodedPurgeFenceCursor(COVER_BACKFILL_BINDING),
] as const;

interface HeldFenceRow {
  workflow_binding: string;
  workflow_instance_id: string;
  dispatch_generation: number;
  dispatch_state: string | null;
  claim_at: string | null;
}

const CLAIM_STATES = new Set(['creating', 'resuming', 'restarting']);

function isYoungClaim(fence: HeldFenceRow, now: Date): boolean {
  if (!fence.dispatch_state || !CLAIM_STATES.has(fence.dispatch_state) || !fence.claim_at) {
    return false;
  }
  const claimedAt = Date.parse(fence.claim_at);
  return Number.isFinite(claimedAt)
    && now.getTime() - claimedAt < STALE_DISPATCH_CLAIM_MS;
}

/** What a purge does about one lookup. Total, with an explicit wait default. */
function purgeActionFor(lookup: CoverWorkflowLookup): 'terminate' | 'settle' | 'materialize' | 'wait' {
  emitCoverPlatformTelemetry('purge', dispositionForLookup(lookup).telemetry);
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
    .catch((): CoverWorkflowLookup => ({
      kind: 'unknown', telemetry: 'cover_platform_lookup_failed',
    }));
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
): Promise<{ attempted: boolean; created: boolean }> {
  try {
    if (fence.workflow_binding === COVER_BACKFILL_BINDING) {
      const job = await env.DB.prepare(`
        SELECT id, run_id FROM event_cover_backfill_jobs
        WHERE event_id = ? AND workflow_instance_id = ?
      `).bind(eventId, fence.workflow_instance_id).first<{ id: string; run_id: string }>();
      if (!job) return { attempted: false, created: false };
      try {
        await accessors.backfill.createBatch([{
          id: fence.workflow_instance_id,
          params: { runId: job.run_id, jobId: job.id, eventId },
        }]);
        return { attempted: true, created: true };
      } catch {
        return { attempted: true, created: false };
      }
    }
    const receipt = await env.DB.prepare(`
      SELECT operation_id FROM event_cover_publish_receipts
      WHERE event_id = ? AND workflow_instance_id = ?
    `).bind(eventId, fence.workflow_instance_id).first<{ operation_id: string }>();
    if (!receipt) return { attempted: false, created: false };
    try {
      await accessors.render.create(fence.workflow_instance_id, {
        eventId, operationId: receipt.operation_id,
      });
      return { attempted: true, created: true };
    } catch {
      return { attempted: true, created: false };
    }
  } catch {
    return { attempted: false, created: false };
  }
}

interface ExpiringRetryableReceipt {
  event_id: string;
  operation_id: string;
  expected_revision: number;
  draft_id: string | null;
  render_set_id: string | null;
  workflow_instance_id: string | null;
  dispatch_state: string;
  dispatch_generation: number;
  failure_code: string | null;
  last_dispatch_at: string | null;
  updated_at: string;
  expires_at: string;
  claim_at: string | null;
}

type RetryableReceiptExpiryAction = 'terminate' | 'settle' | 'wait';
type RetryableReceiptExpiryClaimState = 'resuming' | 'restarting';

function isYoungRetryableReceiptClaim(receipt: ExpiringRetryableReceipt, now: Date): boolean {
  if (!['creating', 'resuming', 'restarting'].includes(receipt.dispatch_state)
    || !receipt.claim_at) {
    return false;
  }
  const claimedAt = Date.parse(receipt.claim_at);
  return Number.isFinite(claimedAt)
    && now.getTime() - claimedAt < STALE_DISPATCH_CLAIM_MS;
}

/** Never throws: absent evidence is never permission to unblock a publication. */
async function retryableReceiptExpiryLookup(
  accessor: CoverWorkflowAccessor,
  instanceId: string,
): Promise<CoverWorkflowLookup> {
  return accessor.lookup(instanceId).catch((): CoverWorkflowLookup => ({
    kind: 'unknown', telemetry: 'cover_platform_lookup_failed',
  }));
}

/** Expiry stops live work; it does not inherit the ordinary restart map's mutations. */
function retryableReceiptExpiryActionFor(
  lookup: CoverWorkflowLookup,
): RetryableReceiptExpiryAction {
  emitCoverPlatformTelemetry('purge', dispositionForLookup(lookup).telemetry);
  if (lookup.kind === 'unknown') return 'wait';
  if (lookup.kind === 'missing') return 'settle';
  switch (lookup.status) {
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
    case 'unknown':
    default:
      return 'wait';
  }
}

async function claimRetryableReceiptExpiry(
  env: AppEnv,
  receipt: ExpiringRetryableReceipt,
  claimState: RetryableReceiptExpiryClaimState,
  now: Date,
): Promise<number | null> {
  if (!receipt.workflow_instance_id || !receipt.draft_id || !receipt.render_set_id) return null;
  const timestamp = now.toISOString();
  const staleClaimFloor = new Date(now.getTime() - STALE_DISPATCH_CLAIM_MS).toISOString();
  const nextGeneration = receipt.dispatch_generation + 1;
  const claimed = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET dispatch_state = ?1, dispatch_generation = ?2,
          last_dispatch_at = ?3, updated_at = ?3
      WHERE event_id = ?4 AND operation_id = ?5
        AND action = 'publish' AND status = 'failed' AND retryable = 1
        AND expires_at = ?6 AND expires_at <= ?3
        AND workflow_instance_id = ?7
        AND dispatch_state = ?8 AND dispatch_generation = ?9
        AND failure_code IS ?10 AND last_dispatch_at IS ?11 AND updated_at = ?12
        AND draft_id = ?13 AND render_set_id = ?14
        AND expected_revision = ?16
        AND (
          dispatch_state NOT IN ('creating', 'resuming', 'restarting')
          OR COALESCE(last_dispatch_at, updated_at) <= ?15
        )
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.id = event_cover_publish_receipts.event_id AND e.deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_drafts d
          WHERE d.id = ?13 AND d.event_id = ?4 AND d.state = 'publishing'
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          WHERE s.id = ?14 AND s.event_id = ?4 AND s.draft_id = ?13
            AND s.state IN ('staging', 'ready')
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = 'COVER_RENDER_WORKFLOW'
            AND f.workflow_instance_id = ?7 AND f.event_id = ?4
            AND f.state = 'open' AND f.dispatch_generation = ?9
        )
    `).bind(
      claimState, nextGeneration, timestamp,
      receipt.event_id, receipt.operation_id, receipt.expires_at,
      receipt.workflow_instance_id, receipt.dispatch_state, receipt.dispatch_generation,
      receipt.failure_code, receipt.last_dispatch_at, receipt.updated_at,
      receipt.draft_id, receipt.render_set_id, staleClaimFloor, receipt.expected_revision,
    ),
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET dispatch_generation = ?1, expires_at = ?2, updated_at = ?3
      WHERE workflow_binding = 'COVER_RENDER_WORKFLOW'
        AND workflow_instance_id = ?4 AND event_id = ?5
        AND state = 'open' AND dispatch_generation = ?6 AND changes() = 1
    `).bind(
      nextGeneration, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT, timestamp,
      receipt.workflow_instance_id, receipt.event_id, receipt.dispatch_generation,
    ),
  ]);
  return (claimed[0]?.meta.changes ?? 0) === 1 && (claimed[1]?.meta.changes ?? 0) === 1
    ? nextGeneration
    : null;
}

async function settleRetryableReceiptExpiry(
  env: AppEnv,
  receipt: ExpiringRetryableReceipt,
  claimState: RetryableReceiptExpiryClaimState,
  generation: number,
  now: Date,
): Promise<boolean> {
  if (!receipt.workflow_instance_id || !receipt.draft_id || !receipt.render_set_id) return false;
  const event = await env.DB.prepare(`
    SELECT cover_revision FROM events WHERE id = ? AND deleted_at IS NULL
  `).bind(receipt.event_id).first<{ cover_revision: number }>();
  if (!event) return false;
  const timestamp = now.toISOString();
  const terminalReceiptExpiry = new Date(
    now.getTime() + COVER_RECEIPT_TERMINAL_RETENTION_MS,
  ).toISOString();
  const abandonedSetCleanupAfter = new Date(
    now.getTime() + COVER_RETIRED_RECOVERY_MS,
  ).toISOString();
  const revisionConflict = event.cover_revision !== receipt.expected_revision;
  const receiptStatus = revisionConflict ? 'conflict' : 'failed';
  const receiptFailureCode = revisionConflict ? null : receipt.failure_code;
  const receiptRenderSetId = revisionConflict ? null : receipt.render_set_id;
  const receiptDispatchState = revisionConflict ? claimState : 'failed';
  const abandonedReason = revisionConflict
    ? 'revision-conflict'
    : (receipt.failure_code ?? 'restart-window-expired');
  const settled = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = ?1, retryable = 0, failure_code = ?2, render_set_id = ?3,
          dispatch_state = ?4, updated_at = ?5, expires_at = ?6
      WHERE event_id = ?7 AND operation_id = ?8
        AND action = 'publish' AND status = 'failed' AND retryable = 1
        AND expires_at = ?9 AND expires_at <= ?5
        AND workflow_instance_id = ?10
        AND dispatch_state = ?11 AND dispatch_generation = ?12
        AND failure_code IS ?13 AND last_dispatch_at = ?5 AND updated_at = ?5
        AND draft_id = ?14 AND render_set_id = ?15 AND expected_revision = ?16
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.id = event_cover_publish_receipts.event_id AND e.deleted_at IS NULL
            AND e.cover_revision = ?17
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_drafts d
          WHERE d.id = ?14 AND d.event_id = ?7 AND d.state = 'publishing'
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          WHERE s.id = ?15 AND s.event_id = ?7 AND s.draft_id = ?14
            AND s.state IN ('staging', 'ready')
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = 'COVER_RENDER_WORKFLOW'
            AND f.workflow_instance_id = ?10 AND f.event_id = ?7
            AND f.state = 'open' AND f.dispatch_generation = ?12
            AND f.expires_at = ?18
        )
    `).bind(
      receiptStatus, receiptFailureCode, receiptRenderSetId, receiptDispatchState,
      timestamp, terminalReceiptExpiry,
      receipt.event_id, receipt.operation_id, receipt.expires_at,
      receipt.workflow_instance_id, claimState, generation,
      receipt.failure_code, receipt.draft_id, receipt.render_set_id,
      receipt.expected_revision, event.cover_revision,
      COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
    ),
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET updated_at = ?1, expires_at = ?2
      WHERE workflow_binding = 'COVER_RENDER_WORKFLOW'
        AND workflow_instance_id = ?3 AND event_id = ?4
        AND state = 'open' AND dispatch_generation = ?5
        AND expires_at = ?6 AND changes() = 1
        AND EXISTS (
          SELECT 1 FROM event_cover_publish_receipts r
          WHERE r.event_id = ?4 AND r.operation_id = ?7
            AND r.workflow_instance_id = ?3 AND r.dispatch_generation = ?5
            AND r.draft_id = ?8 AND r.expected_revision = ?9
            AND r.status = ?10 AND r.retryable = 0 AND r.failure_code IS ?11
            AND r.dispatch_state = ?12 AND r.render_set_id IS ?13
            AND r.updated_at = ?1 AND r.expires_at = ?14
        )
    `).bind(
      timestamp, coverWorkflowFenceTerminalExpiry(now),
      receipt.workflow_instance_id, receipt.event_id, generation,
      COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT, receipt.operation_id,
      receipt.draft_id, receipt.expected_revision, receiptStatus, receiptFailureCode,
      receiptDispatchState, receiptRenderSetId, terminalReceiptExpiry,
    ),
    env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'abandoned', abandoned_reason = ?1,
          abandoned_at = ?2, cleanup_after = ?3
      WHERE id = ?4 AND event_id = ?5 AND draft_id = ?6
        AND state IN ('staging', 'ready')
        AND changes() = 1
        AND EXISTS (
          SELECT 1 FROM event_cover_publish_receipts r
          WHERE r.event_id = ?5 AND r.operation_id = ?7
            AND r.workflow_instance_id = ?8 AND r.dispatch_generation = ?9
            AND r.draft_id = ?6 AND r.expected_revision = ?10
            AND r.status = ?11 AND r.retryable = 0 AND r.failure_code IS ?12
            AND r.dispatch_state = ?13 AND r.render_set_id IS ?14
            AND r.updated_at = ?2 AND r.expires_at = ?15
        )
    `).bind(
      abandonedReason, timestamp, abandonedSetCleanupAfter,
      receipt.render_set_id, receipt.event_id, receipt.draft_id,
      receipt.operation_id, receipt.workflow_instance_id, generation,
      receipt.expected_revision, receiptStatus, receiptFailureCode,
      receiptDispatchState, receiptRenderSetId, terminalReceiptExpiry,
    ),
    env.DB.prepare(`
      UPDATE event_cover_drafts
      SET state = CASE WHEN expires_at <= ?1 THEN 'expired' ELSE 'ready' END,
          draft_revision = draft_revision + 1, updated_at = ?1
      WHERE id = ?2 AND event_id = ?3 AND state = 'publishing'
        AND changes() = 1
        AND EXISTS (
          SELECT 1 FROM event_cover_publish_receipts r
          WHERE r.event_id = ?3 AND r.operation_id = ?4
            AND r.workflow_instance_id = ?5 AND r.dispatch_generation = ?6
            AND r.draft_id = ?2 AND r.expected_revision = ?7
            AND r.status = ?8 AND r.retryable = 0 AND r.failure_code IS ?9
            AND r.dispatch_state = ?10 AND r.render_set_id IS ?11
            AND r.updated_at = ?1 AND r.expires_at = ?12
        )
    `).bind(
      timestamp, receipt.draft_id, receipt.event_id, receipt.operation_id,
      receipt.workflow_instance_id, generation, receipt.expected_revision,
      receiptStatus, receiptFailureCode, receiptDispatchState,
      receiptRenderSetId, terminalReceiptExpiry,
    ),
  ]);
  return settled.every((result) => (result.meta.changes ?? 0) === 1);
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
  const cursorBinding = decodedPurgeFenceCursor(cursor?.workflow_binding ?? null);
  const cursorInstance = cursorBinding ? cursor?.workflow_instance_id ?? '' : '';

  const held = await env.DB.prepare(`
    SELECT f.workflow_binding, f.workflow_instance_id, f.dispatch_generation,
      CASE WHEN f.workflow_binding = 'COVER_RENDER_WORKFLOW'
        THEN r.dispatch_state ELSE j.dispatch_state END AS dispatch_state,
      CASE WHEN f.workflow_binding = 'COVER_RENDER_WORKFLOW'
        THEN COALESCE(r.last_dispatch_at, r.updated_at) ELSE j.updated_at END AS claim_at
    FROM event_cover_workflow_fences f
    LEFT JOIN event_cover_publish_receipts r
      ON f.workflow_binding = 'COVER_RENDER_WORKFLOW'
     AND r.event_id = f.event_id AND r.workflow_instance_id = f.workflow_instance_id
     AND r.dispatch_generation = f.dispatch_generation
    LEFT JOIN event_cover_backfill_jobs j
      ON f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
     AND j.event_id = f.event_id AND j.workflow_instance_id = f.workflow_instance_id
     AND j.dispatch_generation = f.dispatch_generation
    WHERE f.event_id = ?1 AND f.state = 'deletion-blocked'
      AND (
        strftime('%Y-%m-%dT%H:%M:%fZ', f.updated_at, '+31 days') IS NULL
        OR f.expires_at <> strftime(
          '%Y-%m-%dT%H:%M:%fZ', f.updated_at, '+31 days'
        ) || ?2
      )
      AND (f.workflow_binding > ?3
        OR (f.workflow_binding = ?3 AND f.workflow_instance_id > ?4))
    ORDER BY f.workflow_binding, f.workflow_instance_id
    LIMIT ?5
  `).bind(
    eventId, COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX,
    cursorBinding ?? '', cursorInstance,
    MAX_COVER_PURGE_FENCES_PER_PASS,
  ).all<HeldFenceRow>();

  // Rows *resolved*, which is what the column is called and what an operator
  // watching a stalled purge needs. `summary.inspected` counts rows read, and a
  // pass that reads the same unresolved fence every day would otherwise report a
  // resolution count larger than the number of fences the event ever had.
  let resolved = 0;
  let halted = false;
  let lastSettled: HeldFenceRow | null = null;

  for (const fence of held.results) {
    if (isYoungClaim(fence, now)) {
      halted = true;
      break;
    }
    summary.inspected += 1;
    const accessor = fence.workflow_binding === COVER_BACKFILL_BINDING
      ? accessors.backfill
      : accessors.render;

    // Pending generation zero is the durable proof that no platform claim ever
    // won. The first real create/resume/restart claim changes both fields in the
    // same guarded D1 unit before contacting Workflows. Generation zero alone is
    // insufficient: legacy confirmed rows can already own a live instance.
    let action: 'terminate' | 'settle' | 'materialize' | 'wait';
    if (fence.workflow_binding === COVER_BACKFILL_BINDING
      && fence.dispatch_generation === 0 && fence.dispatch_state === 'pending') {
      action = 'settle';
    } else {
      const lookup = await purgeLookup(accessor, fence.workflow_instance_id);
      action = purgeActionFor(lookup);
    }
    if (action === 'wait') {
      halted = true;
      break;
    }

    const requiredMutations = action === 'materialize' ? 2 : action === 'terminate' ? 1 : 0;
    if (summary.platformMutations + requiredMutations
      > MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS) {
      halted = true;
      break;
    }

    if (action === 'materialize') {
      const materialized = await materializeForPurge(env, fence, eventId, accessors);
      if (materialized.attempted) summary.platformMutations += 1;
      if (!materialized.created) {
        halted = true;
        break;
      }
      action = 'terminate';
    }

    if (action === 'terminate') {
      summary.platformMutations += 1;
      try {
        await accessor.terminate(fence.workflow_instance_id);
      } catch {
        // The next pass retries exactly this instance.
        halted = true;
        break;
      }
      // Re-read rather than assume: terminate returning is not proof the
      // instance reached a terminal state, and the fence may only be released
      // against an observed one.
      const postTerminate = await purgeLookup(accessor, fence.workflow_instance_id);
      action = purgeActionFor(postTerminate);
    }

    if (action !== 'settle') {
      halted = true;
      break;
    }

    const released = await env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET expires_at = ?, updated_at = ?
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND state = 'deletion-blocked'
        AND (
          strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+31 days') IS NULL
          OR expires_at <> strftime(
            '%Y-%m-%dT%H:%M:%fZ', updated_at, '+31 days'
          ) || ?
        )
    `).bind(
      coverPurgeFenceTerminalExpiry(now), timestamp,
      fence.workflow_binding, fence.workflow_instance_id,
      COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX,
    ).run();
    if (released.meta.changes !== 1) {
      halted = true;
      break;
    }
    resolved += 1;
    lastSettled = fence;
  }

  const reachedEnd = !halted && held.results.length < MAX_COVER_PURGE_FENCES_PER_PASS;
  const nextBinding = reachedEnd ? null
    : lastSettled?.workflow_binding ?? cursorBinding;
  const nextInstance = reachedEnd ? null
    : (lastSettled?.workflow_instance_id ?? cursorInstance) || null;
  await env.DB.prepare(`
    UPDATE event_cover_purge_progress
    SET workflow_binding = ?, workflow_instance_id = ?, fences_resolved = fences_resolved + ?,
        platform_mutations = platform_mutations + ?, updated_at = ?
    WHERE event_id = ?
  `).bind(
    encodedPurgeFenceCursor(nextBinding),
    nextInstance,
    resolved, summary.platformMutations, timestamp, eventId,
  ).run();

  const unresolved = await env.DB.prepare(`
    SELECT count(*) AS count FROM event_cover_workflow_fences
    WHERE event_id = ? AND state = 'deletion-blocked' AND (
      strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+31 days') IS NULL
      OR expires_at <> strftime(
        '%Y-%m-%dT%H:%M:%fZ', updated_at, '+31 days'
      ) || ?
    )
  `).bind(eventId, COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX).first<{ count: number }>();
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
    // A queued export has not written anything and can be made terminal before
    // its Workflow claims it. A running export remains the owner of its attempt
    // cleanup; the purge waits below until that owner records a terminal state.
    env.DB.prepare(`
      UPDATE export_jobs SET state = 'failed', error_code = 'EXPORT_EVENT_DELETED'
      WHERE event_id = ? AND state = 'queued'
    `).bind(eventId),
    // Timestamp equality is not proof: a0ee's age escape hatch wrote the exact
    // same shape after unknown + failed termination. Before publishing the v2
    // marker, quarantine every *already blocked* row regardless of dated shape.
    // This statement deliberately precedes the open -> blocked transition, so a
    // self-recorded terminal owner can still provide durable proof below.
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET expires_at = ?, updated_at = ?
      WHERE event_id = ? AND state = 'deletion-blocked' AND NOT EXISTS (
        SELECT 1 FROM event_cover_purge_progress p
        WHERE p.event_id = ? AND p.workflow_binding IN (?, ?, ?)
      )
        AND EXISTS (SELECT 1 FROM events e WHERE e.id = event_cover_workflow_fences.event_id)
    `).bind(
      COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT, timestamp, eventId, eventId,
      ...COVER_PURGE_FENCE_PROTOCOL_CURSOR_VALUES,
    ),
    // Every open fence without exact generation-matching durable terminal proof
    // enters purge blocked and held. Receipt/job claim clocks remain untouched.
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET state = 'deletion-blocked', expires_at = ?, updated_at = ?
      WHERE event_id = ? AND state = 'open' AND NOT (
        (
          workflow_binding = 'COVER_RENDER_WORKFLOW' AND EXISTS (
            SELECT 1 FROM event_cover_publish_receipts r
            WHERE r.event_id = event_cover_workflow_fences.event_id
              AND r.workflow_instance_id = event_cover_workflow_fences.workflow_instance_id
              AND r.dispatch_generation = event_cover_workflow_fences.dispatch_generation
              AND r.updated_at >= event_cover_workflow_fences.created_at
              AND (
                r.status IN ('applied', 'conflict')
                OR (r.status = 'failed' AND r.retryable = 0)
              )
              AND event_cover_workflow_fences.expires_at = strftime(
                '%Y-%m-%dT%H:%M:%fZ', r.updated_at, '+31 days'
              )
          )
        )
        OR (
          workflow_binding = 'COVER_BACKFILL_WORKFLOW' AND EXISTS (
            SELECT 1 FROM event_cover_backfill_jobs j
            WHERE j.event_id = event_cover_workflow_fences.event_id
              AND j.workflow_instance_id = event_cover_workflow_fences.workflow_instance_id
              AND j.dispatch_generation = event_cover_workflow_fences.dispatch_generation
              AND j.terminal_at IS NOT NULL
              AND j.terminal_at >= event_cover_workflow_fences.created_at
              AND (
                j.status IN ('applied', 'skipped', 'resolved', 'needs_replacement')
                OR (j.status = 'failed' AND j.retryable = 0)
              )
              AND event_cover_workflow_fences.expires_at = strftime(
                '%Y-%m-%dT%H:%M:%fZ', j.terminal_at, '+31 days'
              )
          )
        )
      )
    `).bind(COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT, timestamp, eventId),
    // The only open rows left have exact generation-matching self-recorded
    // terminal proof from the predicate above. Preserve that terminal-relative
    // clock while publishing the old-code-impossible per-fence proof tag.
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET state = 'deletion-blocked', expires_at = expires_at || ?
      WHERE event_id = ? AND state = 'open'
    `).bind(COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX, eventId),
    // Accepted work that can no longer be delivered is made terminal here rather
    // than left `preparing` forever behind a deleted event.
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
          dispatch_state = CASE
            WHEN dispatch_state IN ('creating', 'resuming', 'restarting') THEN dispatch_state
            ELSE 'blocked'
          END,
          updated_at = CASE
            WHEN dispatch_state IN ('creating', 'resuming', 'restarting') THEN updated_at
            ELSE ?
          END
      WHERE event_id = ? AND (
        status IN ('queued', 'rendering', 'finalizing')
        OR (status = 'failed' AND retryable = 1)
      )
    `).bind(timestamp, eventId),
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
          dispatch_state = CASE
            WHEN dispatch_state = 'pending' AND dispatch_generation = 0 THEN dispatch_state
            WHEN dispatch_state IN ('creating', 'resuming', 'restarting') THEN dispatch_state
            ELSE 'blocked'
          END,
          terminal_at = COALESCE(terminal_at, ?),
          updated_at = CASE
            WHEN dispatch_state IN ('creating', 'resuming', 'restarting') THEN updated_at
            ELSE ?
          END
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
    env.DB.prepare(`
      INSERT INTO event_cover_purge_progress (
        event_id, phase, workflow_binding, created_at, updated_at
      )
      SELECT ?, 'fences', ?, ?, ? WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)
      ON CONFLICT (event_id) DO NOTHING
    `).bind(
      eventId, encodedPurgeFenceCursor(null), timestamp, timestamp, eventId,
    ),
    // Publish v2 only after the blanket hold above. Old code wrote NULL or a
    // literal binding, never this prefix. Any legacy purge with a blocked fence
    // restarts at fences and must obtain fresh platform proof.
    env.DB.prepare(`
      UPDATE event_cover_purge_progress
      SET phase = CASE WHEN EXISTS (
        SELECT 1 FROM event_cover_workflow_fences f
        WHERE f.event_id = ? AND f.state = 'deletion-blocked'
      ) THEN 'fences' ELSE phase END,
          workflow_binding = ?, workflow_instance_id = NULL, updated_at = ?
      WHERE event_id = ? AND (
        workflow_binding IS NULL OR workflow_binding NOT IN (?, ?, ?)
      )
    `).bind(
      eventId, encodedPurgeFenceCursor(null), timestamp, eventId,
      ...COVER_PURGE_FENCE_PROTOCOL_CURSOR_VALUES,
    ),
    // A marked purge can return from r2/relational only for a genuinely
    // unresolved row written after its earlier phase proof. Selection and the
    // fresh-zero query below use this same NULL-safe predicate.
    env.DB.prepare(`
      UPDATE event_cover_purge_progress
      SET phase = 'fences', workflow_binding = ?, workflow_instance_id = NULL,
          updated_at = ?
      WHERE event_id = ? AND phase IN ('r2', 'relational')
        AND workflow_binding IN (?, ?, ?) AND EXISTS (
        SELECT 1 FROM event_cover_workflow_fences f
        WHERE f.event_id = ? AND f.state = 'deletion-blocked' AND (
          strftime('%Y-%m-%dT%H:%M:%fZ', f.updated_at, '+31 days') IS NULL
          OR f.expires_at <> strftime(
            '%Y-%m-%dT%H:%M:%fZ', f.updated_at, '+31 days'
          ) || ?
        )
      )
    `).bind(
      encodedPurgeFenceCursor(null), timestamp, eventId,
      ...COVER_PURGE_FENCE_PROTOCOL_CURSOR_VALUES,
      eventId, COVER_PURGE_FENCE_TERMINAL_PROOF_SUFFIX,
    ),
  ]);

  const progress = await env.DB.prepare(
    'SELECT phase FROM event_cover_purge_progress WHERE event_id = ?',
  ).bind(eventId).first<{ phase: string }>();
  // No progress row and no event row means an earlier pass already finished.
  if (!progress) {
    return { ...summary, phase: 'complete', remainder: false };
  }

  const runningExports = await env.DB.prepare(`
    SELECT count(*) AS count FROM export_jobs
    WHERE event_id = ? AND state = 'running'
  `).bind(eventId).first<{ count: number }>();
  if ((runningExports?.count ?? 0) > 0) {
    // This also upgrades a purge that older code had already advanced to R2:
    // no event prefix is safe to sweep while an export attempt can still write.
    await env.DB.prepare(`
      UPDATE event_cover_purge_progress
      SET phase = 'fences', updated_at = ? WHERE event_id = ?
    `).bind(timestamp, eventId).run();
    return { ...summary, phase: 'fences', remainder: true };
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
    // Durable export inventory is authoritative. Delete those exact keys before
    // the broader event sweep removes media and cover objects.
    await deleteEventExportInventory(env, eventId);
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
    // Terminal-proven fences deliberately stay deletion-blocked after their
    // owners and event disappear. Their tagged deadline authorizes only the
    // later bounded sweep; it never reopens dispatch admission.
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
        AND status IN ('verified', 'failed')
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
export async function deleteEventData(
  env: AppEnv,
  eventId: string,
  now = new Date(),
): Promise<CoverPurgeProgressSummary> {
  return reconcileEventCoverPurge(env, eventId, now);
}

/** The final bounded cover phase, extracted so its ordering is directly testable. */
export async function resumeDeletedEventPurges(
  env: AppEnv,
  now = new Date(),
): Promise<number> {
  // Least-recently-attempted first. A stalled purge must rotate behind events
  // that have never had a chance to start, and the ID is the stable tie-break.
  const purged = await env.DB.prepare(`
    SELECT e.id FROM events e
    LEFT JOIN event_cover_purge_progress p ON p.event_id = e.id
    WHERE e.deleted_at IS NOT NULL OR e.purge_after <= ?
    ORDER BY COALESCE(p.updated_at, ''), e.id LIMIT 100
  `).bind(now.toISOString()).all<{ id: string }>();
  for (const event of purged.results) await deleteEventData(env, event.id, now);
  return purged.results.length;
}

export async function scheduledCleanup(env: AppEnv, now = new Date()): Promise<void> {
  await cleanupAuthScratch(env, now);
  await cleanupRsvpScratch(env, now);
  await cleanupGuestMessageRateEvents(env, now);
  await cleanupExpiredReservations(env, now);
  await cleanupExpiredExports(env, now);
  // Global before per-instance recovery: a job whose exact legacy source is no
  // longer current has nothing left to restart, and current blockers rotate so
  // newer superseded rows cannot starve behind the same oldest hundred. Its
  // conservative remainder is scheduling information only; every later safety
  // phase still runs within its own bound.
  await resolveSupersededBackfillJobsBounded(env, now);
  // Before reconciliation and the purge, because it is the phase that turns an
  // interrupted dispatch back into an observable one: a claim left
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
  // A run closes only after every recovery/reconciliation edge has had this
  // pass, and the proof is re-derived inside the status-changing statement.
  // Saturation is scheduling information; cover cleanup and purge still run.
  await closeCoverBackfillRuns(env, now);
  // Before the purge, not after: an event whose retention is due may own cover
  // rows this sweep is the only thing that removes, and a purge that ran first
  // would meet them as foreign-key failures instead of finding them already
  // collected. Its own bound means a large backlog drains across passes rather
  // than making one scheduled run unbounded.
  await cleanupEventCovers(env, now);
  // Notification delivery is no longer part of this run. It has its own hourly
  // trigger and its own durable state, so a mail failure and a retention purge no
  // longer share a failure boundary in either direction.
  //
  // Rows already marked deleted are selected too: a purge whose object deletion
  // failed is retried here until it succeeds, rather than being left behind with
  // objects no later pass would look for.
  //
  await resumeDeletedEventPurges(env, now);
}

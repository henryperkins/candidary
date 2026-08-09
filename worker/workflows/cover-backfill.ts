import {
  COVER_CLEANUP_ROWS_PER_CLASS,
  COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
  MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  coverWorkflowFenceTerminalExpiry,
} from '../../shared/constants';
import {
  CLAIM_APPLIED_AT_SQL,
  LIVE_COVER_DISPATCH_STATES,
  NONTERMINAL_COVER_BACKFILL_STATUSES,
  blockCoverBackfillDispatchSql,
  confirmCoverBackfillDispatchSql,
  coverBackfillCurrentSourceSql,
  coverBackfillFenceGuardSql,
  coverBackfillInstanceIdleSql,
  coverBackfillMinuteBudgetSql,
  coverBackfillNoPurgeGuardSql,
  coverDispatchReadSql,
  type CoverDispatchClaimState,
} from '../../shared/cover-dispatch';
import {
  ZERO_LEGACY_PROOF_NAMES,
  zeroLegacyProofAllZeroSql,
  zeroLegacyProofAnyRedSql,
  zeroLegacyProofRowsSql,
  type ZeroLegacyProofCounts,
  type ZeroLegacyProofName,
} from '../../shared/cover-backfill-proof';
import {
  COVER_PIPELINE_VERSIONS,
  EVENT_COVER_PROFILES,
  type EventCoverProfileId,
  canonicalCoverConfig,
} from '../../shared/event-cover';
import { ApiError } from '../../shared/errors';
import { adoptCoverRenderObject } from '../db/event-covers';
import { coverPointerStatements } from '../db/events';
import type { EventRow } from '../db/events';
import type { CoverBackfillJobRow, CoverMasterRow, CoverRenderSetRow } from '../db/types';
import type { AppEnv } from '../env';
import { STALE_DISPATCH_CLAIM_MS, coverRequestDigest } from '../services/event-cover-publication';
import {
  normalizeCoverMaster,
  renderCoverProfileObject,
  verifyCoverManifest,
} from '../storage/event-cover-images';
import { coverKeyFingerprint } from '../storage/event-cover-keys';
import { deriveCoverSlots, type CoverRenderSlot } from './cover-render';
import {
  defaultCoverBackfillWorkflowAccessor,
  dispositionForLookup,
  type CoverBackfillWorkflowAccessor,
  type CoverWorkflowLookup,
} from './cover-platform';

/**
 * Converts one pre-`0012` legacy original onto the responsive pipeline.
 *
 * Release-only, and deliberately the same engine as publication rather than a
 * parallel one: the same normalization service, the same source-qualified
 * manifest rules, the same replay-safe profile operations, and the same
 * fence discipline. What differs is ownership. A backfill job is not a host
 * intent, so it consumes no draft slot, no publication receipt, and none of the
 * event's mutation-rate capacity — an operator sweeping every legacy cover must
 * not be able to lock a host out of changing their own.
 *
 * Two properties matter more than throughput. **No release phase silently
 * discards an existing cover**: a source that cannot enter Images, cannot meet
 * the 1x minimum without upscaling, or cannot pass the master ladder becomes
 * `needs_replacement` and stays on the compatibility reader, never degraded and
 * never deleted. And **a newer cover always wins**: every predicate carries the
 * original key fingerprint, the expected revision, and the null render set, so a
 * host who replaced their cover between inventory and execution turns the job
 * into `skipped` rather than having their choice overwritten by a sweep.
 */

/**
 * The payload one legacy-cover backfill job's Workflow instance carries.
 *
 * Same shape of reasoning as `CoverRenderPayload`: the run and job identify the
 * durable ledger row, and every pinned dependency version, fingerprint, derived
 * manifest, and staging set is read from that row. A restart therefore reuses
 * the same immutable payload without the launcher reconstructing anything.
 */
export interface CoverBackfillPayload {
  runId: string;
  jobId: string;
  eventId: string;
}

/**
 * The wrangler binding name, and an immutable release constant from `0012`
 * onward for the same reason `COVER_RENDER_BINDING` is: it is written into every
 * fence row protecting a backfill instance, so renaming it orphans them.
 */
export const COVER_BACKFILL_BINDING = 'COVER_BACKFILL_WORKFLOW';

const JOB_REFERENCE_RELEASE_MS = 7 * 24 * 60 * 60 * 1000;
const JOB_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const RETIRED_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** A restart is reachable only inside this window, and only for a retryable job. */
export const BACKFILL_RESTART_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CoverBackfillStatus =
  | 'applied'
  | 'skipped'
  | 'resolved'
  | 'needs_replacement'
  | 'failed';

export interface CoverBackfillOutcome {
  status: CoverBackfillStatus;
  appliedRevision: number | null;
  failureCode: string | null;
  retryable: boolean;
}

export interface CoverBackfillStage {
  shouldContinue: boolean;
  outcome: CoverBackfillOutcome;
}

export interface CoverBackfillStepSummary {
  profile: EventCoverProfileId;
  /** Small inventory only. Image bytes stay in R2, never in Workflow state. */
  written: number;
  adopted: number;
}

/**
 * The source-independent dependency snapshot pinned at job creation.
 *
 * Source-independent is the operative word: every version here is decided before
 * the legacy object is read, so a restart inside the window renders under
 * exactly the resolvers the first attempt used even though the master those
 * resolvers produce is derived later.
 */
export function coverBackfillDependencyVersions(): Record<string, number> {
  return {
    normalizationLadder: COVER_PIPELINE_VERSIONS.normalizationLadder,
    imagesParameterRecipe: COVER_PIPELINE_VERSIONS.imagesParameterRecipe,
    matte: COVER_PIPELINE_VERSIONS.matte,
    metadataPolicy: COVER_PIPELINE_VERSIONS.metadataPolicy,
    compositionModel: COVER_PIPELINE_VERSIONS.compositionModel,
    cropProfileRegistry: COVER_PIPELINE_VERSIONS.cropProfileRegistry,
    tonalEffect: COVER_PIPELINE_VERSIONS.tonalEffect,
    sharpening: COVER_PIPELINE_VERSIONS.sharpening,
    outputQualityLadder: COVER_PIPELINE_VERSIONS.outputQualityLadder,
  };
}

/** Unique within `CoverBackfillWorkflow`; a later run derives a different ID. */
export async function coverBackfillInstanceId(
  runId: string,
  jobId: string,
  eventId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`cover-backfill-v1|${runId}|${jobId}|${eventId}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `cb1-${hex.slice(0, 48)}`;
}

/**
 * The canonical config every backfilled cover receives.
 *
 * `natural` and automatic focus, because there is no host intent to recover: a
 * pre-`0012` original was never composed or styled, and inventing either would
 * change how an existing event looks without its host asking.
 */
export const BACKFILL_COVER_CONFIG = {
  version: 1,
  source: { kind: 'upload' },
  focus: { mode: 'auto' },
  effect: 'natural',
} as const;

function stage(
  status: CoverBackfillStatus,
  failureCode: string | null = null,
  retryable = false,
  appliedRevision: number | null = null,
): CoverBackfillStage {
  return {
    shouldContinue: false,
    outcome: { status, appliedRevision, failureCode, retryable },
  };
}

const CONTINUE: CoverBackfillStage = {
  shouldContinue: true,
  outcome: { status: 'skipped', appliedRevision: null, failureCode: null, retryable: true },
};

interface BackfillState {
  job: CoverBackfillJobRow;
  event: EventRow;
}

async function loadState(env: AppEnv, payload: CoverBackfillPayload): Promise<BackfillState | null> {
  const job = await env.DB.prepare(
    'SELECT * FROM event_cover_backfill_jobs WHERE id = ? AND run_id = ? AND event_id = ?',
  ).bind(payload.jobId, payload.runId, payload.eventId).first<CoverBackfillJobRow>();
  if (!job) return null;
  const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?')
    .bind(payload.eventId).first<EventRow>();
  return event ? { job, event } : null;
}

/**
 * Whether the exact row this job was created against is still the current one.
 *
 * All four predicates travel together everywhere they appear. Checking three of
 * them is how a sweep overwrites the cover a host chose while the job sat in the
 * queue, and the fingerprint is the one that catches a replacement that happened
 * to land back on the same revision.
 */
export async function backfillPredicatesHold(
  job: CoverBackfillJobRow,
  event: EventRow,
): Promise<boolean> {
  if (event.deleted_at) return false;
  if (!event.cover_object_key || event.cover_render_set_id !== null) return false;
  if (event.cover_revision !== job.expected_revision) return false;
  return await coverKeyFingerprint(event.cover_object_key) === job.legacy_key_fingerprint;
}

function terminalTimestamps(now: Date, ageOut: boolean): {
  terminalAt: string;
  referenceReleaseAt: string | null;
  expiresAt: string | null;
} {
  const terminalAt = now.toISOString();
  if (!ageOut) return { terminalAt, referenceReleaseAt: null, expiresAt: null };
  return {
    terminalAt,
    referenceReleaseAt: new Date(now.getTime() + JOB_REFERENCE_RELEASE_MS).toISOString(),
    expiresAt: new Date(now.getTime() + JOB_EXPIRY_MS).toISOString(),
  };
}

function terminalFenceStatement(
  env: AppEnv,
  payload: CoverBackfillPayload,
  now: Date,
): D1PreparedStatement {
  return env.DB.prepare(`
    UPDATE event_cover_workflow_fences
    SET expires_at = ?, updated_at = ?
    WHERE workflow_binding = ? AND workflow_instance_id = (
      SELECT workflow_instance_id FROM event_cover_backfill_jobs
      WHERE id = ? AND run_id = ? AND event_id = ?
        AND status IN ('applied', 'skipped', 'resolved', 'failed', 'needs_replacement')
    ) AND event_id = ? AND dispatch_generation = (
      SELECT dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?
    ) AND state = 'open'
  `).bind(
    coverWorkflowFenceTerminalExpiry(now), now.toISOString(), COVER_BACKFILL_BINDING,
    payload.jobId, payload.runId, payload.eventId, payload.eventId, payload.jobId,
  );
}

/**
 * Run counters, recomputed from the jobs rather than decremented.
 *
 * A manual decrement is wrong the first time a job moves between two nonterminal
 * states twice, and the ledger's whole purpose is to be truthful after an
 * interruption. Always batched with the transition it summarizes.
 */
export function recomputeBackfillRunCounters(
  db: D1Database,
  runId: string,
  now: Date,
  onlyIfPriorStatementChanged: boolean | 'any' = false,
): D1PreparedStatement {
  const changeGuard = onlyIfPriorStatementChanged === 'any'
    ? ' AND changes() > 0'
    : onlyIfPriorStatementChanged
      ? ' AND changes() = 1'
      : '';
  return db.prepare(`
    UPDATE event_cover_backfill_runs SET
      total_count = (SELECT count(*) FROM event_cover_backfill_jobs WHERE run_id = ?1),
      queued_count = (SELECT count(*) FROM event_cover_backfill_jobs WHERE run_id = ?1
                        AND status IN ('queued', 'normalizing', 'rendering', 'finalizing')),
      applied_count = (SELECT count(*) FROM event_cover_backfill_jobs WHERE run_id = ?1 AND status = 'applied'),
      skipped_count = (SELECT count(*) FROM event_cover_backfill_jobs WHERE run_id = ?1 AND status = 'skipped'),
      resolved_count = (SELECT count(*) FROM event_cover_backfill_jobs WHERE run_id = ?1 AND status = 'resolved'),
      failed_count = (SELECT count(*) FROM event_cover_backfill_jobs WHERE run_id = ?1 AND status = 'failed'),
      needs_replacement_count = (SELECT count(*) FROM event_cover_backfill_jobs WHERE run_id = ?1
                                   AND status = 'needs_replacement'),
      updated_at = ?2
    WHERE id = ?1${changeGuard}
  `).bind(runId, now.toISOString());
}

async function recordTerminal(
  env: AppEnv,
  payload: CoverBackfillPayload,
  status: CoverBackfillStatus,
  now: Date,
  options: { failureCode?: string | null; retryable?: boolean; abandonSetId?: string | null } = {},
): Promise<void> {
  const retryable = options.retryable === true;
  // A `needs_replacement` job and a retryable failure inside its window never age
  // out: one still blocks the zero-legacy proof, and the other is still
  // restartable. Only a settled job gets a reference release and an expiry.
  const { terminalAt, referenceReleaseAt, expiresAt } = terminalTimestamps(
    now,
    !retryable && status !== 'needs_replacement',
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = ?, failure_code = ?, retryable = ?, terminal_at = ?,
          reference_release_at = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND status NOT IN ('applied', 'skipped', 'resolved')
    `).bind(
      status, options.failureCode ?? null, retryable ? 1 : 0, terminalAt,
      referenceReleaseAt, expiresAt, terminalAt, payload.jobId,
    ),
    terminalFenceStatement(env, payload, now),
  ];
  if (options.abandonSetId) {
    statements.push(env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'abandoned', abandoned_reason = ?, abandoned_at = ?, cleanup_after = ?
      WHERE id = ? AND state IN ('staging', 'ready')
    `).bind(
      options.failureCode ?? status, terminalAt,
      new Date(now.getTime() + RETIRED_RECOVERY_MS).toISOString(), options.abandonSetId,
    ));
  }
  statements.push(recomputeBackfillRunCounters(env.DB, payload.runId, now));
  await env.DB.batch(statements);
}

/* ------------------------------------------------------------------ *
 * Dispatch confirmation and initial-create recovery
 * ------------------------------------------------------------------ */

/** The three answers a post-trigger read can support, and no fourth. */
export type CoverBackfillDispatchConfirmation = 'confirmed' | 'blocked' | 'stale';

interface DispatchReadRow {
  run_id: string;
  job_id: string;
  event_id: string;
  workflow_instance_id: string;
  dispatch_state: string;
  dispatch_generation: number;
  status: string;
  fence_state: string | null;
  fence_generation: number | null;
}

/** The launcher renders these as literals; here they are bound. Same predicates. */
const BOUND = {
  binding: '?1', runId: '?2', jobId: '?3', eventId: '?4', generation: '?5', now: '?6',
} as const;

/**
 * Records that one claimed dispatch generation really did reach the platform.
 *
 * The operator's generated `confirm` step runs the same statement from the other
 * side, but a lost terminal or an interrupted shell cannot be trusted, so this
 * is the authoritative caller: the Workflow's own first step, and the recovery
 * pass below. Both render their SQL from `shared/cover-dispatch.ts`, which is
 * what stops the two paths from drifting into different guarantees.
 *
 * It never bumps the generation and never writes the fence. The fence's
 * `updated_at` is the durable dispatch-claim clock the rolling-minute budget is
 * measured from; a confirmation that touched it would hand the next batch a
 * minute of capacity nobody claimed.
 */
export async function confirmCoverBackfillDispatch(
  env: AppEnv,
  input: {
    runId: string;
    jobId: string;
    eventId: string;
    generation: number;
    now: Date;
    /** Which claim is being confirmed. Only the reconciler passes the other two. */
    from?: CoverDispatchClaimState;
  },
): Promise<CoverBackfillDispatchConfirmation> {
  const from = input.from ?? 'creating';
  const row = await env.DB.prepare(coverDispatchReadSql({
    binding: BOUND.binding, runId: BOUND.runId, jobId: BOUND.jobId, eventId: BOUND.eventId,
  })).bind(COVER_BACKFILL_BINDING, input.runId, input.jobId, input.eventId)
    .first<DispatchReadRow>();
  if (!row) return 'stale';
  if (row.dispatch_generation !== input.generation) return 'stale';

  const binds = [
    COVER_BACKFILL_BINDING, input.runId, input.jobId, input.eventId,
    input.generation, input.now.toISOString(),
  ];

  // A purge owns this instance. Settle the unit rather than confirming it; the
  // coordinator owns terminating the instance itself.
  if (row.fence_state === 'deletion-blocked') {
    await env.DB.batch([
      env.DB.prepare(blockCoverBackfillDispatchSql(BOUND)).bind(...binds),
      recomputeBackfillRunCounters(env.DB, input.runId, input.now),
    ]);
    return 'blocked';
  }
  // Absence is refusal, and a fence standing somewhere else is not this unit's.
  if (row.fence_state !== 'open' || row.fence_generation !== input.generation) return 'stale';
  if (row.dispatch_state === 'confirmed') return 'confirmed';
  if (row.dispatch_state !== from) return 'stale';

  const results = await env.DB.batch([
    env.DB.prepare(confirmCoverBackfillDispatchSql(BOUND, from)).bind(...binds),
  ]);
  if (results[0]!.meta.changes === 1) return 'confirmed';

  // The guard refused at commit time, so the read is already out of date. Answer
  // from what is actually there rather than from what was read.
  const after = await env.DB.prepare(
    'SELECT dispatch_state, dispatch_generation FROM event_cover_backfill_jobs WHERE id = ?',
  ).bind(input.jobId).first<{ dispatch_state: string; dispatch_generation: number }>();
  return after?.dispatch_state === 'confirmed' && after.dispatch_generation === input.generation
    ? 'confirmed'
    : 'stale';
}

/**
 * The Workflow's own first step.
 *
 * The payload carries no generation — it is immutable across restarts, while the
 * generation is not — so the instance confirms whichever generation its job is
 * standing at. That is the right one by construction: a restart reuses this
 * instance ID and moves the job and its fence together, so the run that is
 * executing is always the run the ledger points at.
 */
export async function coverBackfillConfirmStep(
  env: AppEnv,
  payload: CoverBackfillPayload,
  now = new Date(),
): Promise<CoverBackfillDispatchConfirmation> {
  const job = await env.DB.prepare(
    'SELECT dispatch_generation FROM event_cover_backfill_jobs WHERE id = ? AND run_id = ? AND event_id = ?',
  ).bind(payload.jobId, payload.runId, payload.eventId)
    .first<{ dispatch_generation: number }>();
  if (!job) return 'stale';
  return confirmCoverBackfillDispatch(env, { ...payload, generation: job.dispatch_generation, now });
}

export interface StaleInitialDispatchSummary {
  inspected: number;
  materialized: number;
  confirmed: number;
  blocked: number;
  remainder: boolean;
}

/**
 * Heals a claim that was made but whose create may never have landed.
 *
 * A `creating` job older than the stale threshold is the durable trace of an
 * accepted dispatch whose outcome nobody observed — the operator's terminal
 * died, the shell was interrupted, or the trigger itself was lost. The claim is
 * a commitment, not an inference, which is what makes replaying it safe:
 * `createBatch` is documented to skip an ID it still retains and create one it
 * does not, so the same call is correct whether or not the instance exists.
 *
 * Deliberately no lookup. Asking the platform what it thinks of this ID would
 * make recovery depend on distinguishing "absent" from "invalid", which the
 * adapter refuses to certify — and it does not need to be distinguished here.
 *
 * Any platform failure leaves the claim exactly as it was, so the next pass
 * retries it; a purge-owned fence settles through the same confirmation path
 * rather than being created for.
 */
export async function recoverStaleInitialBackfillDispatches(
  env: AppEnv,
  now = new Date(),
  workflow: CoverBackfillWorkflowAccessor = defaultCoverBackfillWorkflowAccessor(env),
): Promise<StaleInitialDispatchSummary> {
  const stale = await env.DB.prepare(`
    SELECT j.id AS job_id, j.run_id AS run_id, j.event_id AS event_id,
           j.workflow_instance_id AS workflow_instance_id,
           j.dispatch_generation AS dispatch_generation,
           f.state AS fence_state, f.dispatch_generation AS fence_generation
    FROM event_cover_backfill_jobs j
    LEFT JOIN event_cover_workflow_fences f
      ON f.workflow_binding = ?1 AND f.workflow_instance_id = j.workflow_instance_id
     AND f.event_id = j.event_id
    WHERE j.dispatch_state = 'creating' AND j.updated_at <= ?2
      AND j.status IN ('queued', 'normalizing', 'rendering', 'finalizing')
    ORDER BY j.updated_at, j.id LIMIT ?3
  `).bind(
    COVER_BACKFILL_BINDING,
    new Date(now.getTime() - STALE_DISPATCH_CLAIM_MS).toISOString(),
    COVER_CLEANUP_ROWS_PER_CLASS,
  ).all<Pick<DispatchReadRow,
    'job_id' | 'run_id' | 'event_id' | 'workflow_instance_id' | 'dispatch_generation'
    | 'fence_state' | 'fence_generation'>>();

  const summary: StaleInitialDispatchSummary = {
    inspected: 0,
    materialized: 0,
    confirmed: 0,
    blocked: 0,
    remainder: stale.results.length >= COVER_CLEANUP_ROWS_PER_CLASS,
  };

  for (const claim of stale.results) {
    summary.inspected += 1;
    const input = {
      runId: claim.run_id,
      jobId: claim.job_id,
      eventId: claim.event_id,
      generation: claim.dispatch_generation,
      now,
    };
    // No fence, a blocked fence, or one at another generation: there is nothing
    // to materialize, only something to settle.
    if (claim.fence_state !== 'open' || claim.fence_generation !== claim.dispatch_generation) {
      if (await confirmCoverBackfillDispatch(env, input) === 'blocked') summary.blocked += 1;
      continue;
    }
    try {
      await workflow.createBatch([{
        id: claim.workflow_instance_id,
        params: { runId: claim.run_id, jobId: claim.job_id, eventId: claim.event_id },
      }]);
    } catch {
      // The claim stays `creating` and is picked up again next pass. Recording a
      // failure here would turn a platform blip into a terminal job.
      continue;
    }
    summary.materialized += 1;
    const outcome = await confirmCoverBackfillDispatch(env, input);
    if (outcome === 'confirmed') summary.confirmed += 1;
    if (outcome === 'blocked') summary.blocked += 1;
  }
  return summary;
}

/* ------------------------------------------------------------------ *
 * Platform reconciliation and the one guarded restart edge
 * ------------------------------------------------------------------ */

export interface CoverBackfillReconcileSummary {
  inspected: number;
  resumed: number;
  restarted: number;
  recreated: number;
  failuresRecorded: number;
  blocked: number;
  unchanged: number;
  remainder: boolean;
}

interface ReconcileRow {
  id: string;
  run_id: string;
  event_id: string;
  workflow_instance_id: string;
  dispatch_state: string;
  dispatch_generation: number;
  status: string;
  retryable: number;
  terminal_at: string | null;
  expected_revision: number;
  legacy_key_fingerprint: string;
  dependency_versions_json: string;
  master_id: string | null;
  render_set_id: string | null;
  manifest_json: string | null;
  manifest_sha256: string | null;
  fence_state: string | null;
  fence_generation: number | null;
  event_deleted_at: string | null;
  cover_object_key: string | null;
  cover_render_set_id: string | null;
  cover_revision: number | null;
}

const NONTERMINAL_SQL = NONTERMINAL_COVER_BACKFILL_STATUSES.map((s) => `'${s}'`).join(', ');

/**
 * The dispatch states a recovery may be claimed *out of*.
 *
 * `pending` is absent because there is nothing to recover — no instance was ever
 * asked for — and `creating` is absent because an initial claim belongs to
 * `recoverStaleInitialBackfillDispatches`, which replays it without a lookup on
 * purpose. Consulting the platform about a `creating` claim would make recovery
 * depend on telling an absent instance from an invalid ID, which the adapter
 * deliberately refuses to certify.
 */
const RECOVERABLE_CLAIM_STATES = "('confirmed', 'resuming', 'restarting')";

const CLAIM_BOUND = {
  binding: '?1',
  runId: '?2',
  jobId: '?3',
  eventId: '?4',
  generation: '?5',
  now: '?6',
  workflowInstanceId: '?7',
  dependencies: '?8',
  sourceObjectKey: '?9',
  windowFloor: '?10',
} as const;

/**
 * One globally bounded pass over everything the platform might have moved
 * underneath the ledger.
 *
 * Three arms, and each names a different way D1 and the platform can disagree:
 * a job the ledger believes is running, a retryable failure still inside its
 * restart window, and a recovery claim whose outcome nobody observed. A
 * `pending` job is deliberately absent from all three — it has no instance
 * behind it — and so is `creating`, which belongs to initial-create recovery.
 */
const RECONCILE_SELECT_SQL = `
  SELECT j.id, j.run_id, j.event_id, j.workflow_instance_id, j.dispatch_state,
         j.dispatch_generation, j.status, j.retryable, j.terminal_at,
         j.expected_revision, j.legacy_key_fingerprint, j.dependency_versions_json,
         j.master_id, j.render_set_id, j.manifest_json, j.manifest_sha256,
         f.state AS fence_state, f.dispatch_generation AS fence_generation,
         e.deleted_at AS event_deleted_at, e.cover_object_key,
         e.cover_render_set_id, e.cover_revision
  FROM event_cover_backfill_jobs j
  LEFT JOIN event_cover_workflow_fences f
    ON f.workflow_binding = ?1 AND f.workflow_instance_id = j.workflow_instance_id
   AND f.event_id = j.event_id
  LEFT JOIN events e ON e.id = j.event_id
  WHERE (
        (j.dispatch_state = 'confirmed' AND j.status IN (${NONTERMINAL_SQL}))
     OR (j.status = 'failed' AND j.retryable = 1
         AND j.terminal_at IS NOT NULL AND j.terminal_at > ?2)
     OR (j.dispatch_state IN ('resuming', 'restarting') AND j.updated_at <= ?3
         AND j.status IN (${NONTERMINAL_SQL}))
  )
  ORDER BY j.updated_at, j.id LIMIT ?4
`;

/**
 * Everything a recovery claim and a restart claim require in common.
 *
 * Rendered from `shared/cover-dispatch.ts` rather than written out here, so the
 * bounds a Worker-side recovery spends are the same strings the operator's
 * initial dispatch is refused by. A resume, a restart, and a recreate each put
 * an instance on the platform, so each one spends the rolling minute.
 */
const CLAIM_GUARDS = ` AND ${coverBackfillCurrentSourceSql()}`
  + ` AND ${coverBackfillNoPurgeGuardSql()}`
  + ` AND ${coverBackfillFenceGuardSql(CLAIM_BOUND.binding, 'open', CLAIM_BOUND.generation)}`
  + ` AND ${coverBackfillMinuteBudgetSql(CLAIM_BOUND.binding, MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE)}`
  + ` AND ${coverBackfillInstanceIdleSql(CLAIM_BOUND.binding, CLAIM_BOUND.workflowInstanceId)}`
  + ' AND EXISTS (SELECT 1 FROM events e'
  + ' WHERE e.id = event_cover_backfill_jobs.event_id'
  + ` AND e.cover_object_key = ${CLAIM_BOUND.sourceObjectKey})`;

const CLAIM_IDENTITY = ` WHERE id = ${CLAIM_BOUND.jobId} AND run_id = ${CLAIM_BOUND.runId}`
  + ` AND event_id = ${CLAIM_BOUND.eventId}`
  + ` AND dispatch_generation = ${CLAIM_BOUND.generation}`
  + ` AND dispatch_state IN ${RECOVERABLE_CLAIM_STATES}`
  + ` AND dependency_versions_json = ${CLAIM_BOUND.dependencies}`;

/**
 * Restore one retained instance at the stage D1 can prove durably.
 *
 * `?11` is derived from the immutable quartet and exact adopted-object tuples;
 * `?12` through `?15` pin the read values into the write predicate. SQLite's
 * `IS` is intentional: it gives exact equality for text and NULL-safe equality
 * for the legitimate all-null, pre-normalization checkpoint.
 */
function restorationClaimSql(target: 'resuming' | 'creating' | 'restarting'): string {
  return 'UPDATE event_cover_backfill_jobs'
    + ` SET status = ?11, dispatch_state = '${target}',`
    + ' dispatch_generation = dispatch_generation + 1,'
    + ' failure_code = NULL, retryable = 0, terminal_at = NULL,'
    + ' reference_release_at = NULL, expires_at = NULL,'
    + ` updated_at = ${CLAIM_BOUND.now}`
    + CLAIM_IDENTITY
    + ` AND ((status IN (${NONTERMINAL_SQL})) OR (`
    + "status = 'failed' AND retryable = 1"
    + ` AND terminal_at IS NOT NULL AND terminal_at > ${CLAIM_BOUND.windowFloor}))`
    + ' AND master_id IS ?12 AND render_set_id IS ?13'
    + ' AND manifest_json IS ?14 AND manifest_sha256 IS ?15'
    // The object read used to derive the checkpoint is deliberately repeated
    // inside the claim. Otherwise an adopted tuple can disappear, or an
    // unexpected tuple can arrive, between that read and this generation bump.
    + ` AND (?11 = 'queued' OR NOT EXISTS (`
    + ' SELECT 1 FROM event_cover_render_objects o'
    + ' WHERE o.render_set_id = event_cover_backfill_jobs.render_set_id'
    + ' AND o.event_id = event_cover_backfill_jobs.event_id'
    + ' AND NOT EXISTS ('
    + " SELECT 1 FROM json_each(event_cover_backfill_jobs.manifest_json, '$.slots') slot"
    + " WHERE json_extract(slot.value, '$.profile') = o.profile_id"
    + " AND json_extract(slot.value, '$.density') = o.density"
    + " AND json_extract(slot.value, '$.format') = o.format"
    + ')))'
    + ` AND (?11 <> 'finalizing' OR NOT EXISTS (`
    + " SELECT 1 FROM json_each(event_cover_backfill_jobs.manifest_json, '$.slots') slot"
    + ' WHERE NOT EXISTS ('
    + ' SELECT 1 FROM event_cover_render_objects o'
    + ' WHERE o.render_set_id = event_cover_backfill_jobs.render_set_id'
    + ' AND o.event_id = event_cover_backfill_jobs.event_id'
    + " AND o.profile_id = json_extract(slot.value, '$.profile')"
    + " AND o.density = json_extract(slot.value, '$.density')"
    + " AND o.format = json_extract(slot.value, '$.format')"
    + ')))'
    + CLAIM_GUARDS;
}

/** The fence moves with the job, and only when the job moved. */
const FENCE_CLAIM_SQL = 'UPDATE event_cover_workflow_fences'
  + ' SET dispatch_generation = (SELECT j.dispatch_generation'
  + '   FROM event_cover_backfill_jobs j WHERE j.id = ?2),'
  + ` expires_at = '${COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT}',`
  + ` updated_at = ${CLAIM_APPLIED_AT_SQL}`
  + ' WHERE workflow_binding = ?1 AND workflow_instance_id = ?4'
  + " AND event_id = ?3 AND state = 'open'"
  + ' AND dispatch_generation = (SELECT j.dispatch_generation - 1'
  + '   FROM event_cover_backfill_jobs j WHERE j.id = ?2)'
  + ' AND changes() = 1';

/** Terminal, and never restartable: nothing is left that could authorize work. */
async function settleUnreachableBackfillJob(
  env: AppEnv,
  job: ReconcileRow,
  observed: 'event-deleted' | 'blocked-fence' | 'missing-fence',
  now: Date,
): Promise<boolean> {
  const timestamp = now.toISOString();
  const observedGuard = observed === 'event-deleted'
    ? `EXISTS (
        SELECT 1 FROM events e WHERE e.id = event_cover_backfill_jobs.event_id
          AND e.deleted_at IS NOT NULL
      )`
    : observed === 'blocked-fence'
      ? `EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ?1
            AND f.workflow_instance_id = event_cover_backfill_jobs.workflow_instance_id
            AND f.event_id = event_cover_backfill_jobs.event_id
            AND f.state = 'deletion-blocked'
        )`
      : `NOT EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ?1
            AND f.workflow_instance_id = event_cover_backfill_jobs.workflow_instance_id
            AND f.event_id = event_cover_backfill_jobs.event_id
        )`;
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'failed', retryable = 0, failure_code = 'EVENT_DELETED',
          dispatch_state = 'blocked', terminal_at = COALESCE(terminal_at, ?7), updated_at = ?7
      WHERE id = ?2 AND run_id = ?3 AND event_id = ?4 AND workflow_instance_id = ?5
        AND dispatch_generation = ?6
        AND status NOT IN ('applied', 'skipped', 'resolved', 'needs_replacement')
        AND ${observedGuard}
    `).bind(
      COVER_BACKFILL_BINDING, job.id, job.run_id, job.event_id,
      job.workflow_instance_id, job.dispatch_generation, timestamp,
    ),
    recomputeBackfillRunCounters(env.DB, job.run_id, now, true),
  ]);
  return results[0]!.meta.changes === 1;
}

/** Persist a platform terminal/divergence reading before claiming its restart. */
async function recordReconcilePlatformFailure(
  env: AppEnv,
  job: ReconcileRow,
  now: Date,
): Promise<boolean> {
  const timestamp = now.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'failed', failure_code = 'COVER_RENDER_UNAVAILABLE', retryable = 1,
          terminal_at = ?, reference_release_at = NULL, expires_at = NULL, updated_at = ?
      WHERE id = ? AND run_id = ? AND event_id = ? AND workflow_instance_id = ?
        AND dispatch_state = ? AND dispatch_generation = ?
        AND status IN (${NONTERMINAL_SQL})
        AND ${coverBackfillFenceGuardSql('?9', 'open', '?8')}
    `).bind(
      timestamp, timestamp, job.id, job.run_id, job.event_id, job.workflow_instance_id,
      job.dispatch_state, job.dispatch_generation, COVER_BACKFILL_BINDING,
    ),
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET expires_at = ?
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
        AND dispatch_generation = ? AND state = 'open' AND changes() = 1
    `).bind(
      coverWorkflowFenceTerminalExpiry(now), COVER_BACKFILL_BINDING,
      job.workflow_instance_id, job.event_id, job.dispatch_generation,
    ),
    recomputeBackfillRunCounters(env.DB, job.run_id, now, true),
  ]);
  return results[0]!.meta.changes === 1;
}

/**
 * The predicates a digest is needed for, checked immediately before the claim.
 *
 * Everything SQL can decide is decided inside the claim statement at commit
 * time; these two cannot be, so they are checked here and the statement is
 * applied straight afterwards. A drift in either means this job's frozen work no
 * longer describes what a restart would produce.
 */
async function backfillJobIsRestorable(job: ReconcileRow): Promise<boolean> {
  if (job.dependency_versions_json !== JSON.stringify(coverBackfillDependencyVersions())) {
    return false;
  }
  if (job.event_deleted_at !== null) return false;
  if (!job.cover_object_key || job.cover_render_set_id !== null) return false;
  if (job.cover_revision !== job.expected_revision) return false;
  return await coverKeyFingerprint(job.cover_object_key) === job.legacy_key_fingerprint;
}

type BackfillRecoveryStatus = 'queued' | 'normalizing' | 'rendering' | 'finalizing';

interface BackfillRecoveryCheckpoint {
  status: BackfillRecoveryStatus;
  masterId: string | null;
  renderSetId: string | null;
  manifestJson: string | null;
  manifestSha256: string | null;
}

interface AdoptedRenderTuple {
  profile_id: string;
  density: string;
  format: string;
}

function tupleKey(tuple: { profile: string; density: string; format: string }): string {
  return `${tuple.profile}|${tuple.density}|${tuple.format}`;
}

function parseFrozenBackfillManifest(raw: string): CoverRenderSlot[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).length !== 1 || !('slots' in parsed)) return null;
  const slots = (parsed as { slots?: unknown }).slots;
  if (!Array.isArray(slots) || slots.length < 12 || slots.length > 24) return null;

  const knownProfiles = EVENT_COVER_PROFILES.map((profile) => profile.id as string);
  const seen = new Set<string>();
  const validated: CoverRenderSlot[] = [];
  for (const candidate of slots) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return null;
    const keys = Object.keys(candidate).sort();
    if (keys.join('|') !== 'density|format|profile') return null;
    const { profile, density, format } = candidate as Record<string, unknown>;
    if (typeof profile !== 'string' || !knownProfiles.includes(profile)) return null;
    if (density !== '1x' && density !== '2x') return null;
    if (format !== 'webp' && format !== 'jpeg') return null;
    const slot = { profile, density, format } as CoverRenderSlot;
    const key = tupleKey(slot);
    if (seen.has(key)) return null;
    seen.add(key);
    validated.push(slot);
  }

  // Every profile always owns both mandatory 1x formats. A source-qualified 2x
  // density is optional, but it is a WebP/JPEG pair or it is not a valid
  // manifest. These two shape rules are what make 12-24 a meaningful bound.
  for (const profile of knownProfiles) {
    if (!seen.has(tupleKey({ profile, density: '1x', format: 'webp' }))) return null;
    if (!seen.has(tupleKey({ profile, density: '1x', format: 'jpeg' }))) return null;
    const webp2x = seen.has(tupleKey({ profile, density: '2x', format: 'webp' }));
    const jpeg2x = seen.has(tupleKey({ profile, density: '2x', format: 'jpeg' }));
    if (webp2x !== jpeg2x) return null;
  }
  return validated;
}

/**
 * Derive only the stage D1 can prove, without inventing a Workflow checkpoint.
 *
 * The query is intentionally tuple-only, exact to both immutable owners, and
 * bounded by the schema's maximum manifest size. Object bytes and private keys
 * are neither needed nor read during platform reconciliation.
 */
async function deriveBackfillRecoveryCheckpoint(
  env: AppEnv,
  job: ReconcileRow,
  allNullStatus: 'queued' | 'normalizing' = 'queued',
): Promise<BackfillRecoveryCheckpoint | null> {
  const quartet = [job.master_id, job.render_set_id, job.manifest_json, job.manifest_sha256];
  if (quartet.every((value) => value === null)) {
    return {
      status: allNullStatus, masterId: null, renderSetId: null,
      manifestJson: null, manifestSha256: null,
    };
  }
  if (quartet.some((value) => value === null)) return null;

  const masterId = job.master_id!;
  const renderSetId = job.render_set_id!;
  const manifestJson = job.manifest_json!;
  const manifestSha256 = job.manifest_sha256!;
  if (await coverRequestDigest(manifestJson) !== manifestSha256) return null;
  const slots = parseFrozenBackfillManifest(manifestJson);
  if (!slots) return null;

  const adopted = await env.DB.prepare(`
    SELECT profile_id, density, format
    FROM event_cover_render_objects
    WHERE render_set_id = ? AND event_id = ?
    ORDER BY profile_id, density, format
    LIMIT 24
  `).bind(renderSetId, job.event_id).all<AdoptedRenderTuple>();
  const expected = new Set(slots.map(tupleKey));
  const actual = new Set<string>();
  for (const object of adopted.results) {
    const key = tupleKey({
      profile: object.profile_id, density: object.density, format: object.format,
    });
    if (!expected.has(key) || actual.has(key)) return null;
    actual.add(key);
  }

  const everyProfileComplete = EVENT_COVER_PROFILES.every((profile) => {
    const profileSlots = slots.filter((slot) => slot.profile === profile.id);
    return profileSlots.length > 0 && profileSlots.every((slot) => actual.has(tupleKey(slot)));
  });
  return {
    status: everyProfileComplete ? 'finalizing' : 'rendering',
    masterId, renderSetId, manifestJson, manifestSha256,
  };
}

/**
 * A resume continues retained Workflow history, so its D1 stage is preserved
 * only when the frozen evidence is compatible with that exact continuation.
 */
async function derivePausedRecoveryCheckpoint(
  env: AppEnv,
  job: ReconcileRow,
): Promise<BackfillRecoveryCheckpoint | null> {
  if (job.status === 'failed') {
    return deriveBackfillRecoveryCheckpoint(env, job, 'normalizing');
  }
  if (job.status === 'queued' || job.status === 'normalizing') {
    const checkpoint = await deriveBackfillRecoveryCheckpoint(env, job, job.status);
    return checkpoint?.status === job.status && checkpoint.masterId === null
      ? checkpoint
      : null;
  }
  if (job.status === 'rendering') {
    const checkpoint = await deriveBackfillRecoveryCheckpoint(env, job);
    return checkpoint && checkpoint.masterId !== null
      ? { ...checkpoint, status: 'rendering' }
      : null;
  }
  if (job.status === 'finalizing') {
    const checkpoint = await deriveBackfillRecoveryCheckpoint(env, job);
    return checkpoint?.status === 'finalizing' ? checkpoint : null;
  }
  return null;
}

async function applyClaim(
  env: AppEnv,
  job: ReconcileRow,
  statement: string,
  binds: unknown[],
  recomputeRestoredRunAt?: Date,
): Promise<boolean> {
  const statements = [
    env.DB.prepare(statement).bind(...binds),
    env.DB.prepare(FENCE_CLAIM_SQL).bind(
      COVER_BACKFILL_BINDING, job.id, job.event_id, job.workflow_instance_id,
    ),
  ];
  // A restoration moves a failed job back into the run's queued capacity. The
  // fence statement is immediately before this recompute, so `changes() = 1`
  // requires both the guarded job claim and its generation-matched fence move.
  // Ordinary nonterminal recovery leaves its run summary untouched.
  if (recomputeRestoredRunAt) {
    statements.push(recomputeBackfillRunCounters(
      env.DB, job.run_id, recomputeRestoredRunAt, true,
    ));
  }
  const results = await env.DB.batch(statements);
  return results[0]!.meta.changes === 1;
}

function claimBinds(job: ReconcileRow, now: Date): unknown[] {
  return [
    COVER_BACKFILL_BINDING, job.run_id, job.id, job.event_id,
    job.dispatch_generation, now.toISOString(), job.workflow_instance_id,
    JSON.stringify(coverBackfillDependencyVersions()), job.cover_object_key,
  ];
}

function restorationClaimBinds(
  job: ReconcileRow,
  now: Date,
  restartFloor: string,
  checkpoint: BackfillRecoveryCheckpoint,
): unknown[] {
  return [
    ...claimBinds(job, now), restartFloor, checkpoint.status,
    checkpoint.masterId, checkpoint.renderSetId,
    checkpoint.manifestJson, checkpoint.manifestSha256,
  ];
}

/**
 * Reconciles the ledger with what the platform actually reports, and takes at
 * most one recovery edge per job per pass.
 *
 * Every transition here is Worker-side by design. An operator never issues a raw
 * `instances resume` or `instances restart`: those commands move the platform
 * without moving the generation or the fence, which is precisely the divergence
 * this function exists to close. Keeping one authoritative writer is what lets
 * the fence stay a truthful record of what was dispatched.
 *
 * Nothing is written on an `unknown` reading, ever. Absence of information is
 * not evidence of absence of work, and the cost of guessing wrong is a second
 * instance rendering into a set the first one is still writing.
 */
export async function reconcileCoverBackfillJobs(
  env: AppEnv,
  now = new Date(),
  workflow: CoverBackfillWorkflowAccessor = defaultCoverBackfillWorkflowAccessor(env),
): Promise<CoverBackfillReconcileSummary> {
  const restartFloor = new Date(now.getTime() - BACKFILL_RESTART_WINDOW_MS).toISOString();
  const staleBefore = new Date(now.getTime() - STALE_DISPATCH_CLAIM_MS).toISOString();

  const selected = await env.DB.prepare(RECONCILE_SELECT_SQL).bind(
    COVER_BACKFILL_BINDING, restartFloor, staleBefore, COVER_CLEANUP_ROWS_PER_CLASS,
  ).all<ReconcileRow>();

  const summary: CoverBackfillReconcileSummary = {
    inspected: 0,
    resumed: 0,
    restarted: 0,
    recreated: 0,
    failuresRecorded: 0,
    blocked: 0,
    unchanged: 0,
    remainder: selected.results.length >= COVER_CLEANUP_ROWS_PER_CLASS,
  };

  for (const job of selected.results) {
    summary.inspected += 1;
    const payload: CoverBackfillPayload = {
      runId: job.run_id, jobId: job.id, eventId: job.event_id,
    };
    const next = job.dispatch_generation + 1;

    // 1. Deletion and fence ownership, decided before the platform is contacted
    // at all. A job whose event is going away routes to the purge coordinator,
    // which owns terminating the instance; reconciliation only settles the row.
    // Deletion ownership is generation-independent and therefore precedes open
    // fence supersession. The job write still pins its selected generation.
    if (job.event_deleted_at !== null) {
      const settled = await settleUnreachableBackfillJob(
        env, job, 'event-deleted', now,
      );
      if (settled) summary.blocked += 1;
      else summary.unchanged += 1;
      continue;
    }
    if (job.fence_state === 'deletion-blocked') {
      const settled = await settleUnreachableBackfillJob(env, job, 'blocked-fence', now);
      if (settled) summary.blocked += 1;
      else summary.unchanged += 1;
      continue;
    }
    if (job.fence_state === null) {
      // A missing fence is terminal deletion evidence for this release: open
      // fences are retained beyond platform retention and ordinary cleanup can
      // remove only versioned terminal proof. Guard the write on exact absence
      // so a concurrent newer claim cannot be terminalized by this stale read.
      const settled = await settleUnreachableBackfillJob(env, job, 'missing-fence', now);
      if (settled) summary.blocked += 1;
      else summary.unchanged += 1;
      continue;
    }
    if (job.fence_generation !== job.dispatch_generation) {
      // Only an open fence reaches here. Its other generation belongs to a
      // different claim, so terminalizing this selected job would poison it.
      summary.unchanged += 1;
      continue;
    }

    const lookup = await workflow.lookup(job.workflow_instance_id).catch(
      (): CoverWorkflowLookup => ({
        kind: 'unknown', telemetry: 'cover_backfill_lookup_failed',
      }),
    );
    const disposition = dispositionForLookup(lookup);
    const nonterminal = (NONTERMINAL_COVER_BACKFILL_STATUSES as readonly string[])
      .includes(job.status);

    if (!disposition.mutates) {
      // A recovery claim whose instance turns out to be running did land: the
      // interruption was between the platform call and the confirmation. Record
      // that, so the ledger stops describing a claim nobody ever resolved.
      if (lookup.kind === 'status'
        && (lookup.status === 'queued' || lookup.status === 'running'
          || lookup.status === 'waiting' || lookup.status === 'waitingForPause')
        && (job.dispatch_state === 'resuming' || job.dispatch_state === 'restarting')) {
        await confirmCoverBackfillDispatch(env, {
          ...payload,
          generation: job.dispatch_generation,
          now,
          from: job.dispatch_state,
        });
      }
      summary.unchanged += 1;
      continue;
    }

    // Platform completion cannot improve an already-terminal ledger result.
    // In particular, a retryable failure is still a recorded terminal outcome;
    // restarting it merely because the retained instance later says `complete`
    // would erase the truthful result without any new D1 evidence.
    if (disposition.kind === 'complete' && !nonterminal) {
      summary.unchanged += 1;
      continue;
    }

    // 2. Certified absence, which the shipped adapter cannot produce: its
    // matcher registry is empty by construction, so this is reachable only once
    // Task 11 proves a stable discriminator against the deployed platform.
    if (disposition.kind === 'missing') {
      if (!await backfillJobIsRestorable(job)) {
        summary.unchanged += 1;
        continue;
      }
      const checkpoint = await deriveBackfillRecoveryCheckpoint(env, job);
      if (!checkpoint || !await applyClaim(
        env,
        job,
        restorationClaimSql('creating'),
        restorationClaimBinds(job, now, restartFloor, checkpoint),
        nonterminal ? undefined : now,
      )) {
        summary.unchanged += 1;
        continue;
      }
      try {
        await workflow.createBatch([{ id: job.workflow_instance_id, params: payload }]);
      } catch {
        // The claim stands, so the next pass finds it as a stale recovery claim.
        continue;
      }
      const outcome = await confirmCoverBackfillDispatch(env, {
        ...payload, generation: next, now, from: 'creating',
      });
      if (outcome === 'confirmed') summary.recreated += 1;
      if (outcome === 'blocked') summary.blocked += 1;
      continue;
    }

    // 3. Paused, on a job the ledger still believes is live. Resume keeps every
    // step the instance already paid for, so it carries none of the restart
    // predicates — no `failed`, no `retryable`, no `terminal_at`.
    if (disposition.recovery === 'resume') {
      if (!await backfillJobIsRestorable(job)) {
        summary.unchanged += 1;
        continue;
      }
      const checkpoint = await derivePausedRecoveryCheckpoint(env, job);
      if (!checkpoint) {
        summary.unchanged += 1;
        continue;
      }
      if (!await applyClaim(
        env,
        job,
        restorationClaimSql('resuming'),
        restorationClaimBinds(job, now, restartFloor, checkpoint),
        nonterminal ? undefined : now,
      )) {
        summary.unchanged += 1;
        continue;
      }
      try {
        await workflow.resume(job.workflow_instance_id);
      } catch {
        continue;
      }
      const outcome = await confirmCoverBackfillDispatch(env, {
        ...payload, generation: next, now, from: 'resuming',
      });
      if (outcome === 'confirmed') summary.resumed += 1;
      if (outcome === 'blocked') summary.blocked += 1;
      continue;
    }

    // 4. Errored, terminated, or complete-while-D1-is-nonterminal. The platform's
    // verdict is persisted *before* the restart is claimed: an interruption
    // between the two then leaves a truthful retryable failure that the next
    // pass can act on, rather than a job that lost a generation to nothing.
    if (nonterminal) {
      if (!await recordReconcilePlatformFailure(env, job, now)) {
        summary.unchanged += 1;
        continue;
      }
      summary.failuresRecorded += 1;
    }
    if (!await backfillJobIsRestorable(job)) {
      summary.unchanged += 1;
      continue;
    }
    const checkpoint = await deriveBackfillRecoveryCheckpoint(env, job);
    if (!checkpoint || !await applyClaim(
      env,
      job,
      restorationClaimSql('restarting'),
      restorationClaimBinds(job, now, restartFloor, checkpoint),
      now,
    )) {
      summary.unchanged += 1;
      continue;
    }
    try {
      await workflow.restart(job.workflow_instance_id);
    } catch {
      continue;
    }
    const outcome = await confirmCoverBackfillDispatch(env, {
      ...payload, generation: next, now, from: 'restarting',
    });
    if (outcome === 'confirmed') summary.restarted += 1;
    if (outcome === 'blocked') summary.blocked += 1;
  }

  return summary;
}

/**
 * Step 1: everything that must hold before the legacy object is even read.
 *
 * The fence is checked before Images and R2 for the same reason publication
 * checks it there: an instance that survived an event purge must exit without
 * writing objects into a prefix that has already been swept.
 */
export async function coverBackfillPreflight(
  env: AppEnv,
  payload: CoverBackfillPayload,
  now = new Date(),
): Promise<CoverBackfillStage> {
  const state = await loadState(env, payload);
  if (!state) return stage('skipped');
  const { job, event } = state;

  if (job.status === 'applied') return stage('applied', null, false, event.cover_revision);
  if (job.status === 'skipped' || job.status === 'resolved') return stage(job.status);
  if (job.status === 'needs_replacement') return stage('needs_replacement', job.failure_code);
  if (job.status === 'failed' && job.retryable === 0) return stage('failed', job.failure_code);

  // A fence on its own is not permission, because the fence and the claim are
  // opened by two different statements. The launcher's dispatch artifact inserts
  // the fence first — the claim's own guard requires it to already be there — and
  // only the claim that follows carries the in-flight, rolling-minute, and
  // single-active-run bounds. A refused claim therefore leaves an open fence
  // standing at the job's current generation with `dispatch_state` still
  // `pending`, while the artifact's trigger command runs whether the claim landed
  // or not. Without this, that instance would satisfy the generation check below
  // and convert the cover outside every bound the claim exists to enforce.
  //
  // Nothing is written: the job is still `pending` and still `queued`, so the
  // next batch can claim it properly. Recording a failure here would burn a row
  // whose only misfortune was to be triggered a moment too early.
  if (!(LIVE_COVER_DISPATCH_STATES as readonly string[]).includes(job.dispatch_state)) {
    return stage('skipped');
  }

  // A present, open, generation-matching fence for this event is permission;
  // anything else, including no row at all, is refusal. See the same guard in
  // `coverRenderPreflight` for why absence cannot mean consent.
  const fence = await env.DB.prepare(`
    SELECT state, dispatch_generation FROM event_cover_workflow_fences
    WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
  `).bind(COVER_BACKFILL_BINDING, job.workflow_instance_id, job.event_id)
    .first<{ state: string; dispatch_generation: number }>();
  if (!fence
    || fence.state !== 'open'
    || fence.dispatch_generation !== job.dispatch_generation) {
    await recordTerminal(env, payload, 'failed', now, {
      failureCode: 'COVER_RENDER_UNAVAILABLE',
      abandonSetId: job.render_set_id,
    });
    return stage('failed', 'COVER_RENDER_UNAVAILABLE');
  }

  // A row that changed after inventory is skipped, not failed. A host replacing
  // their own cover is not a defect; it is the guard working.
  if (!await backfillPredicatesHold(job, event)) {
    await recordTerminal(env, payload, 'skipped', now, { abandonSetId: job.render_set_id });
    return stage('skipped');
  }

  // A replay that is already past normalization continues where it stopped
  // rather than restarting the ladder it already paid for.
  if (job.status === 'rendering' || job.status === 'finalizing') return CONTINUE;

  const advanced = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'normalizing', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'normalizing')
    `).bind(now.toISOString(), payload.jobId),
    recomputeBackfillRunCounters(env.DB, payload.runId, now),
  ]);
  if ((advanced[0]?.meta.changes ?? 0) !== 1) return stage('skipped');
  return CONTINUE;
}

/**
 * Steps 2-4: inspect, normalize, then freeze the manifest and staging set.
 *
 * The manifest cannot be derived any earlier. Its 2x membership depends on the
 * winning master dimensions, and those are unknown until the five-rung ladder has
 * chosen a rung — which is exactly why `manifest_json` and `render_set_id` are
 * nullable in `queued` and `normalizing` and required from `rendering` onward.
 */
export async function coverBackfillNormalize(
  env: AppEnv,
  payload: CoverBackfillPayload,
  now = new Date(),
): Promise<CoverBackfillStage> {
  const state = await loadState(env, payload);
  if (!state) return stage('skipped');
  const { job, event } = state;

  if (job.status === 'rendering' || job.status === 'finalizing') return CONTINUE;
  if (job.status !== 'normalizing') return stage('skipped');
  if (!await backfillPredicatesHold(job, event)) {
    await recordTerminal(env, payload, 'skipped', now);
    return stage('skipped');
  }

  const masterId = crypto.randomUUID();
  let master: CoverMasterRow;
  try {
    const normalized = await normalizeCoverMaster(env, {
      eventId: payload.eventId,
      masterId,
      rawKey: event.cover_object_key!,
    });
    // Centre focus, written with the master rather than after it: no historic
    // focal point exists to recover, and a master a draft could later edit from
    // must never be left without the point Reset returns to.
    await env.DB.prepare(`
      INSERT INTO event_cover_masters (
        id, event_id, object_key, mime_type, byte_size, width, height, sha256,
        normalization_version, normalization_rung,
        auto_focus_x, auto_focus_y, composition_model_version, created_at
      ) VALUES (?, ?, ?, 'image/webp', ?, ?, ?, ?, ?, ?, 0.5, 0.5, ?, ?)
    `).bind(
      masterId, payload.eventId, normalized.objectKey, normalized.byteSize,
      normalized.width, normalized.height, normalized.sha256,
      normalized.normalizationVersion, normalized.rung,
      COVER_PIPELINE_VERSIONS.compositionModel, now.toISOString(),
    ).run();
    master = (await env.DB.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
      .bind(masterId).first<CoverMasterRow>())!;
  } catch (error) {
    // A source Candidary cannot normalize is not a failure of this job — it is a
    // photo that needs replacing. It stays on the compatibility reader, and the
    // proof stays red until its host replaces or removes it.
    const code = error instanceof ApiError ? error.code : 'COVER_RENDER_UNAVAILABLE';
    const needsReplacement = code === 'COVER_SOURCE_UNSUPPORTED'
      || code === 'COVER_SOURCE_TOO_SMALL'
      || code === 'COVER_MASTER_BUDGET_EXHAUSTED'
      || code === 'UPLOAD_OBJECT_MISSING';
    await recordTerminal(env, payload, needsReplacement ? 'needs_replacement' : 'failed', now, {
      failureCode: code,
      retryable: !needsReplacement,
    });
    return stage(needsReplacement ? 'needs_replacement' : 'failed', code, !needsReplacement);
  }

  const slots = deriveCoverSlots(master, BACKFILL_COVER_CONFIG.focus);
  const manifestJson = JSON.stringify({ slots });
  const recipeJson = canonicalCoverConfig(BACKFILL_COVER_CONFIG);
  const renderSetId = crypto.randomUUID();
  const timestamp = now.toISOString();

  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO event_cover_render_sets (
        id, event_id, master_id, draft_id, recipe_json, recipe_sha256,
        state, required_slots, created_at
      )
      SELECT ?, ?, ?, NULL, ?, ?, 'staging', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM events
        WHERE id = ? AND deleted_at IS NULL AND cover_revision = ?
          AND cover_object_key = ? AND cover_render_set_id IS NULL
      )
    `).bind(
      renderSetId, payload.eventId, masterId, recipeJson,
      await coverRequestDigest(recipeJson), slots.length, timestamp,
      payload.eventId, job.expected_revision, event.cover_object_key,
    ),
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'rendering', master_id = ?, render_set_id = ?,
          manifest_json = ?, manifest_sha256 = ?, updated_at = ?
      WHERE id = ? AND status = 'normalizing' AND changes() = 1
    `).bind(
      masterId, renderSetId, manifestJson, await coverRequestDigest(manifestJson),
      timestamp, payload.jobId,
    ),
    recomputeBackfillRunCounters(env.DB, payload.runId, now),
  ]);

  if ((results[1]?.meta.changes ?? 0) !== 1) {
    await recordTerminal(env, payload, 'skipped', now, { abandonSetId: renderSetId });
    return stage('skipped');
  }
  return CONTINUE;
}

/** Step 5, one profile at a time and individually replay-safe. */
export async function coverBackfillProfileStep(
  env: AppEnv,
  payload: CoverBackfillPayload,
  profile: EventCoverProfileId,
  now = new Date(),
): Promise<CoverBackfillStepSummary> {
  const state = await loadState(env, payload);
  if (!state || state.job.status !== 'rendering') return { profile, written: 0, adopted: 0 };
  const { job } = state;
  if (!job.master_id || !job.render_set_id || !job.manifest_json) {
    throw new ApiError('COVER_RENDER_UNAVAILABLE', 'This cover could not be prepared.', 503);
  }
  const master = await env.DB.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
    .bind(job.master_id).first<CoverMasterRow>();
  if (!master) {
    throw new ApiError('COVER_RENDER_UNAVAILABLE', 'This cover could not be prepared.', 503);
  }

  // The frozen manifest, not a re-derivation. Re-deriving here would let a
  // dependency change between steps produce a set nothing ever verified.
  const { slots } = JSON.parse(job.manifest_json) as { slots: CoverRenderSlot[] };
  let written = 0;
  let adopted = 0;
  for (const slot of slots) {
    if (slot.profile !== profile) continue;
    const result = await renderCoverProfileObject(env, {
      eventId: payload.eventId,
      renderSetId: job.render_set_id,
      masterKey: master.object_key,
      master: { width: master.width, height: master.height },
      focus: { x: 0.5, y: 0.5, zoom: 1 },
      effect: BACKFILL_COVER_CONFIG.effect,
      profile: slot.profile,
      density: slot.density,
      format: slot.format,
    });
    await adoptCoverRenderObject(env.DB, {
      renderSetId: job.render_set_id,
      eventId: payload.eventId,
      profileId: slot.profile,
      density: slot.density,
      format: slot.format,
      objectKey: result.objectKey,
      contentType: result.contentType,
      byteSize: result.byteSize,
      width: result.width,
      height: result.height,
      qualityRung: result.rung,
      sha256: result.sha256,
      now,
    });
    if (result.adopted) adopted += 1; else written += 1;
  }
  return { profile, written, adopted };
}

/**
 * Steps 6-7: verify the exact manifest, then swap the pointers under guard.
 *
 * The legacy original is inventoried by the same statements that displace it —
 * `coverPointerStatements` with a `backfilled` reason — so there is no window in
 * which the pointer has moved and the only record of the old object has not been
 * written. Nothing is deleted from R2 here or anywhere in this Workflow.
 */
export async function coverBackfillFinalize(
  env: AppEnv,
  payload: CoverBackfillPayload,
  now = new Date(),
): Promise<CoverBackfillOutcome> {
  const state = await loadState(env, payload);
  if (!state) return stage('skipped').outcome;
  const { job, event } = state;
  if (job.status === 'applied') {
    return {
      status: 'applied', appliedRevision: event.cover_revision, failureCode: null, retryable: false,
    };
  }
  if (job.status !== 'rendering' && job.status !== 'finalizing') return stage('skipped').outcome;
  if (!job.render_set_id || !job.master_id) return stage('skipped').outcome;

  if (!await backfillPredicatesHold(job, event)) {
    await recordTerminal(env, payload, 'skipped', now, { abandonSetId: job.render_set_id });
    return stage('skipped').outcome;
  }

  const set = await env.DB.prepare('SELECT * FROM event_cover_render_sets WHERE id = ?')
    .bind(job.render_set_id).first<CoverRenderSetRow>();
  const master = await env.DB.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
    .bind(job.master_id).first<CoverMasterRow>();
  if (!set || !master) return stage('skipped').outcome;

  const verdict = await verifyCoverManifest(env, set.id);
  if (!verdict.complete) {
    await recordTerminal(env, payload, 'failed', now, {
      failureCode: 'COVER_OUTPUT_BUDGET_EXHAUSTED',
      abandonSetId: set.id,
    });
    return {
      status: 'failed', appliedRevision: null,
      failureCode: 'COVER_OUTPUT_BUDGET_EXHAUSTED', retryable: false,
    };
  }

  const timestamp = now.toISOString();
  const nextRevision = job.expected_revision + 1;
  const { referenceReleaseAt, expiresAt } = terminalTimestamps(now, true);

  const results = await env.DB.batch([
    ...coverPointerStatements(env.DB, {
      eventId: payload.eventId,
      expectedRevision: job.expected_revision,
      expectedCurrentKey: event.cover_object_key,
      expectedCurrentRenderSetId: null,
      nextConfig: canonicalCoverConfig(BACKFILL_COVER_CONFIG),
      nextObjectKey: master.object_key,
      nextRenderSetId: set.id,
      retiredAt: timestamp,
      cleanupAfter: new Date(now.getTime() + RETIRED_RECOVERY_MS).toISOString(),
      retiredKeyFingerprint: job.legacy_key_fingerprint,
      reason: 'backfilled',
    }),
    // Predicated on the revision having actually moved: a zero-change UPDATE does
    // not error a D1 batch, so without this a lost guard would still activate the
    // set and mark the job applied.
    env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'active', manifest_sha256 = ?, published_revision = ?,
          ready_at = COALESCE(ready_at, ?), published_at = ?
      WHERE id = ? AND state IN ('staging', 'ready')
        AND EXISTS (SELECT 1 FROM events WHERE id = ? AND cover_revision = ?)
    `).bind(
      job.manifest_sha256, nextRevision, timestamp, timestamp,
      set.id, payload.eventId, nextRevision,
    ),
    env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET status = 'applied', failure_code = NULL, retryable = 0, terminal_at = ?,
          reference_release_at = ?, expires_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('rendering', 'finalizing')
        AND EXISTS (SELECT 1 FROM events WHERE id = ? AND cover_revision = ?)
    `).bind(
      timestamp, referenceReleaseAt, expiresAt, timestamp,
      payload.jobId, payload.eventId, nextRevision,
    ),
    terminalFenceStatement(env, payload, now),
    recomputeBackfillRunCounters(env.DB, payload.runId, now),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    await recordTerminal(env, payload, 'skipped', now, { abandonSetId: set.id });
    return stage('skipped').outcome;
  }
  return { status: 'applied', appliedRevision: nextRevision, failureCode: null, retryable: false };
}

/**
 * The one exit from `needs_replacement` and `failed` that is not terminal.
 *
 * A job whose source is no longer current cannot block the zero-legacy proof:
 * the host replaced or removed that cover themselves, or a later job applied it.
 * Nothing about the job's history changes — it simply stops counting against a
 * proof it can no longer say anything true about.
 */
export interface CoverBackfillLedgerSweepSummary {
  inspectedJobs: number;
  resolvedJobs: number;
  closedVerifiedRuns: number;
  closedFailedRuns: number;
  expiredRunsStamped: number;
  remainder: boolean;
}

interface CoverBackfillLedgerSweepRow extends CoverBackfillJobRow {
  event_exists: number;
  event_cover_object_key: string | null;
  event_deleted_at: string | null;
  event_cover_render_set_id: string | null;
  event_cover_revision: number | null;
}

interface CoverBackfillLedgerCandidate {
  id: string;
  runId: string;
  eventId: string;
  workflowInstanceId: string;
  dispatchState: string;
  dispatchGeneration: number;
  expectedRevision: number;
  status: string;
  updatedAt: string;
  legacyKeyFingerprint: string;
  terminalAt: string | null;
  eventExists: number;
  eventCoverObjectKey: string | null;
  eventDeletedAt: string | null;
  eventCoverRenderSetId: string | null;
  eventCoverRevision: number | null;
  rotatedAt: string;
}

function ledgerSweepCandidate(job: CoverBackfillLedgerSweepRow, now: Date): CoverBackfillLedgerCandidate {
  const selectedUpdatedAt = Date.parse(job.updated_at);
  return {
    id: job.id,
    runId: job.run_id,
    eventId: job.event_id,
    workflowInstanceId: job.workflow_instance_id,
    dispatchState: job.dispatch_state,
    dispatchGeneration: job.dispatch_generation,
    expectedRevision: job.expected_revision,
    status: job.status,
    updatedAt: job.updated_at,
    legacyKeyFingerprint: job.legacy_key_fingerprint,
    terminalAt: job.terminal_at,
    eventExists: job.event_exists,
    eventCoverObjectKey: job.event_cover_object_key,
    eventDeletedAt: job.event_deleted_at,
    eventCoverRenderSetId: job.event_cover_render_set_id,
    eventCoverRevision: job.event_cover_revision,
    rotatedAt: new Date(
      Math.max(now.getTime(), Number.isFinite(selectedUpdatedAt) ? selectedUpdatedAt : 0) + 1,
    ).toISOString(),
  };
}

function ledgerCandidateEventSnapshotSql(jobRef: string): string {
  return `(
    (json_extract(candidate.value, '$.eventExists') = 0 AND NOT EXISTS (
      SELECT 1 FROM events e WHERE e.id = ${jobRef}.event_id
    )) OR (
      json_extract(candidate.value, '$.eventExists') = 1 AND EXISTS (
        SELECT 1 FROM events e WHERE e.id = ${jobRef}.event_id
          AND e.cover_object_key IS json_extract(candidate.value, '$.eventCoverObjectKey')
          AND e.deleted_at IS json_extract(candidate.value, '$.eventDeletedAt')
          AND e.cover_render_set_id IS json_extract(candidate.value, '$.eventCoverRenderSetId')
          AND e.cover_revision IS json_extract(candidate.value, '$.eventCoverRevision')
      )
    )
  )`;
}

function ledgerCandidateJobSnapshotSql(jobRef: string): string {
  return `
    json_extract(candidate.value, '$.id') = ${jobRef}.id
    AND json_extract(candidate.value, '$.runId') = ${jobRef}.run_id
    AND json_extract(candidate.value, '$.eventId') = ${jobRef}.event_id
    AND json_extract(candidate.value, '$.workflowInstanceId') = ${jobRef}.workflow_instance_id
    AND json_extract(candidate.value, '$.dispatchState') = ${jobRef}.dispatch_state
    AND json_extract(candidate.value, '$.dispatchGeneration') = ${jobRef}.dispatch_generation
    AND json_extract(candidate.value, '$.expectedRevision') = ${jobRef}.expected_revision
    AND json_extract(candidate.value, '$.status') = ${jobRef}.status
    AND json_extract(candidate.value, '$.updatedAt') = ${jobRef}.updated_at
    AND json_extract(candidate.value, '$.legacyKeyFingerprint') = ${jobRef}.legacy_key_fingerprint
    AND ${ledgerCandidateEventSnapshotSql(jobRef)}
  `;
}

export async function resolveSupersededBackfillJobsBounded(
  env: AppEnv,
  now = new Date(),
): Promise<CoverBackfillLedgerSweepSummary> {
  const { results } = await env.DB.prepare(`
    SELECT j.*, e.id IS NOT NULL AS event_exists,
      e.cover_object_key AS event_cover_object_key,
      e.deleted_at AS event_deleted_at,
      e.cover_render_set_id AS event_cover_render_set_id,
      e.cover_revision AS event_cover_revision
    FROM event_cover_backfill_jobs j
    LEFT JOIN events e ON e.id = j.event_id
    WHERE j.status IN ('needs_replacement', 'failed')
    ORDER BY j.updated_at, j.id LIMIT ?
  `).bind(COVER_CLEANUP_ROWS_PER_CLASS).all<CoverBackfillLedgerSweepRow>();

  const classified = await Promise.all(results.map(async (job) => {
    const stillCurrent = job.event_exists === 1
      && job.event_deleted_at === null
      && job.event_cover_object_key !== null
      && job.event_cover_render_set_id === null
      && await coverKeyFingerprint(job.event_cover_object_key) === job.legacy_key_fingerprint;
    return { candidate: ledgerSweepCandidate(job, now), stillCurrent };
  }));

  const currentCandidates = classified
    .filter(({ stillCurrent }) => stillCurrent)
    .map(({ candidate }) => candidate);
  const supersededByRun = new Map<string, CoverBackfillLedgerCandidate[]>();
  for (const { candidate, stillCurrent } of classified) {
    if (stillCurrent) continue;
    const group = supersededByRun.get(candidate.runId) ?? [];
    group.push(candidate);
    supersededByRun.set(candidate.runId, group);
  }

  if (currentCandidates.length > 0) {
    const candidatesJson = JSON.stringify(currentCandidates);
    await env.DB.prepare(`
      UPDATE event_cover_backfill_jobs
      SET updated_at = (
        SELECT json_extract(candidate.value, '$.rotatedAt')
        FROM json_each(?1) candidate
        WHERE json_extract(candidate.value, '$.id') = event_cover_backfill_jobs.id
      )
      WHERE EXISTS (
        SELECT 1 FROM json_each(?1) candidate
        WHERE ${ledgerCandidateJobSnapshotSql('event_cover_backfill_jobs')}
      )
    `).bind(candidatesJson).run();
  }

  let resolved = 0;
  const { terminalAt, referenceReleaseAt, expiresAt } = terminalTimestamps(now, true);
  for (const [runId, candidates] of supersededByRun) {
    const candidatesJson = JSON.stringify(candidates);
    const batch = await env.DB.batch([
      env.DB.prepare(`
        UPDATE event_cover_backfill_jobs
        SET status = 'resolved', retryable = 0,
            terminal_at = COALESCE(terminal_at, ?1),
            reference_release_at = ?2, expires_at = ?3, updated_at = ?1
        WHERE EXISTS (
          SELECT 1 FROM json_each(?4) candidate
          WHERE ${ledgerCandidateJobSnapshotSql('event_cover_backfill_jobs')}
        )
      `).bind(terminalAt, referenceReleaseAt, expiresAt, candidatesJson),
      // Adjacency is load-bearing: a missing fence must not replace the job
      // UPDATE's changes() value and suppress this one-per-run recount.
      recomputeBackfillRunCounters(env.DB, runId, now, 'any'),
      env.DB.prepare(`
        UPDATE event_cover_workflow_fences
        SET expires_at = ?1, updated_at = ?2
        WHERE workflow_binding = ?3 AND state = 'open' AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM json_each(?4) candidate
            JOIN event_cover_backfill_jobs j
              ON json_extract(candidate.value, '$.id') = j.id
            WHERE j.run_id = ?5
              AND j.event_id = event_cover_workflow_fences.event_id
              AND j.workflow_instance_id = event_cover_workflow_fences.workflow_instance_id
              AND j.dispatch_generation = event_cover_workflow_fences.dispatch_generation
              AND j.status = 'resolved' AND j.retryable = 0
              AND j.updated_at = ?2 AND j.reference_release_at = ?6 AND j.expires_at = ?7
              AND j.terminal_at IS COALESCE(
                json_extract(candidate.value, '$.terminalAt'), ?2
              )
              AND j.legacy_key_fingerprint = json_extract(
                candidate.value, '$.legacyKeyFingerprint'
              )
              AND j.expected_revision = json_extract(candidate.value, '$.expectedRevision')
              AND j.dispatch_state = json_extract(candidate.value, '$.dispatchState')
              AND ${ledgerCandidateEventSnapshotSql('j')}
          )
      `).bind(
        coverWorkflowFenceTerminalExpiry(now), terminalAt, COVER_BACKFILL_BINDING,
        candidatesJson, runId, referenceReleaseAt, expiresAt,
      ),
    ]);
    resolved += batch[0]?.meta.changes ?? 0;
  }
  const unresolved = results.length - resolved;
  return {
    inspectedJobs: results.length,
    resolvedJobs: resolved,
    closedVerifiedRuns: 0,
    closedFailedRuns: 0,
    expiredRunsStamped: 0,
    remainder: results.length === COVER_CLEANUP_ROWS_PER_CLASS || unresolved > 0,
  };
}

export interface ZeroLegacyProof extends ZeroLegacyProofCounts {
  proven: boolean;
}

const TERMINAL_COVER_BACKFILL_STATUSES = "('applied', 'skipped', 'resolved', 'needs_replacement', 'failed')";

/**
 * One run-eligibility predicate used by candidate selection and both guarded
 * closure transitions. Counters are diagnostic; the jobs themselves decide.
 */
function closableCoverBackfillRunSql(
  runAlias: string,
  restartFloorSql: string,
): string {
  return `${runAlias}.status = 'executing'
    AND (
      ${runAlias}.mode = 'verify'
      OR (${runAlias}.mode = 'execute' AND ${runAlias}.inventory_sha256 IS NOT NULL)
    )
    AND NOT EXISTS (
      SELECT 1 FROM event_cover_backfill_jobs j
      WHERE j.run_id = ${runAlias}.id AND (
        j.status IN ('queued', 'normalizing', 'rendering', 'finalizing')
        OR (
          j.status = 'needs_replacement'
          AND EXISTS (
            SELECT 1 FROM events e
            WHERE e.id = j.event_id AND e.deleted_at IS NULL
              AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL
          )
        )
        OR (
          j.status = 'failed' AND j.retryable = 1
          AND (j.terminal_at IS NULL OR j.terminal_at > ${restartFloorSql})
        )
        OR (j.status IN ${TERMINAL_COVER_BACKFILL_STATUSES} AND j.terminal_at IS NULL)
      )
    )`;
}

/** Run rows have no terminal_at; the closure statement's clock is authoritative. */
function closedRunExpirySql(runAlias: string, closureClockSql: string): string {
  return `strftime(
    '%Y-%m-%dT%H:%M:%fZ',
    max(
      ${closureClockSql},
      coalesce(
        (SELECT max(j.terminal_at) FROM event_cover_backfill_jobs j
          WHERE j.run_id = ${runAlias}.id),
        ${closureClockSql}
      )
    ),
    '+30 days'
  )`;
}

function zeroProof(): ZeroLegacyProof {
  return {
    legacyRows: 0,
    blockingJobs: 0,
    incompleteActiveSets: 0,
    uploadsWithoutActiveSet: 0,
    proven: true,
  };
}

async function readZeroLegacyProof(env: AppEnv): Promise<ZeroLegacyProof> {
  const { results } = await env.DB.prepare(zeroLegacyProofRowsSql())
    .all<{ name: string; value: number }>();
  const byName = new Map<ZeroLegacyProofName, number>();
  for (const name of ZERO_LEGACY_PROOF_NAMES) {
    const matches = results.filter((candidate) => candidate.name === name);
    const value = matches.length === 1 ? matches[0]!.value : -1;
    byName.set(name, Number.isInteger(value) && value >= 0 ? value : -1);
  }
  const counts: ZeroLegacyProofCounts = {
    legacyRows: byName.get('legacyRows') ?? -1,
    blockingJobs: byName.get('blockingJobs') ?? -1,
    incompleteActiveSets: byName.get('incompleteActiveSets') ?? -1,
    uploadsWithoutActiveSet: byName.get('uploadsWithoutActiveSet') ?? -1,
  };
  return {
    ...counts,
    proven: ZERO_LEGACY_PROOF_NAMES.every((name) => counts[name] === 0),
  };
}

/**
 * The direct D1 proof phase 3 is gated on.
 *
 * Four independent counts rather than one clever query, because each names a
 * different way the cutover could be incomplete and an operator needs to know
 * which. `blockingJobs` deliberately counts across every retained run: a
 * historical job cannot keep the proof red after its exact source was safely
 * replaced, but it must not be ignorable while that source is still current.
 */
export async function proveZeroLegacyCovers(env: AppEnv): Promise<ZeroLegacyProof> {
  return readZeroLegacyProof(env);
}

export interface ZeroLegacyVerificationResult {
  proof: ZeroLegacyProof;
  transition: 'verified' | 'failed' | 'unchanged';
}

/**
 * The only authority that records the global proof.
 *
 * A displayed count payload never reaches this function. Both outcomes recheck
 * their proof and run eligibility inside the status-changing SQL statement, so
 * neither a stale green read nor a stale red diagnostic can close the run.
 */
export async function recordZeroLegacyVerification(
  env: AppEnv,
  runId: string,
  now = new Date(),
): Promise<ZeroLegacyVerificationResult> {
  const timestamp = now.toISOString();
  const restartFloor = new Date(now.getTime() - BACKFILL_RESTART_WINDOW_MS).toISOString();
  const run = 'event_cover_backfill_runs';
  const verified = await env.DB.prepare(`
    UPDATE event_cover_backfill_runs
    SET status = 'verified', verified_at = ?2, updated_at = ?2,
        expires_at = ${closedRunExpirySql(run, '?2')}
    WHERE id = ?1
      AND ${closableCoverBackfillRunSql(run, '?3')}
      AND (${zeroLegacyProofAllZeroSql()})
  `).bind(runId, timestamp, restartFloor).run();
  if (verified.meta.changes === 1) return { proof: zeroProof(), transition: 'verified' };

  const diagnostic = await readZeroLegacyProof(env);
  if (diagnostic.proven) return { proof: diagnostic, transition: 'unchanged' };

  const failed = await env.DB.prepare(`
    UPDATE event_cover_backfill_runs
    SET status = 'failed', verified_at = NULL, updated_at = ?2,
        expires_at = ${closedRunExpirySql(run, '?2')}
    WHERE id = ?1
      AND ${closableCoverBackfillRunSql(run, '?3')}
      AND (${zeroLegacyProofAnyRedSql()})
  `).bind(runId, timestamp, restartFloor).run();
  if (failed.meta.changes === 1) return { proof: diagnostic, transition: 'failed' };
  return { proof: await readZeroLegacyProof(env), transition: 'unchanged' };
}

/** Globally bounded run closure, after Task 5 has reconciled every reachable edge. */
export async function closeCoverBackfillRuns(
  env: AppEnv,
  now = new Date(),
): Promise<CoverBackfillLedgerSweepSummary> {
  const restartFloor = new Date(now.getTime() - BACKFILL_RESTART_WINDOW_MS).toISOString();
  const { results } = await env.DB.prepare(`
    SELECT r.id FROM event_cover_backfill_runs r
    WHERE ${closableCoverBackfillRunSql('r', '?1')}
    ORDER BY r.updated_at, r.id LIMIT ?2
  `).bind(restartFloor, COVER_CLEANUP_ROWS_PER_CLASS).all<{ id: string }>();
  let closedVerifiedRuns = 0;
  let closedFailedRuns = 0;
  let unchanged = 0;
  for (const run of results) {
    const recorded = await recordZeroLegacyVerification(env, run.id, now);
    if (recorded.transition === 'verified') closedVerifiedRuns += 1;
    else if (recorded.transition === 'failed') closedFailedRuns += 1;
    else unchanged += 1;
  }
  return {
    inspectedJobs: 0,
    resolvedJobs: 0,
    closedVerifiedRuns,
    closedFailedRuns,
    expiredRunsStamped: closedVerifiedRuns + closedFailedRuns,
    remainder: results.length === COVER_CLEANUP_ROWS_PER_CLASS || unchanged > 0,
  };
}

export { EVENT_COVER_PROFILES };

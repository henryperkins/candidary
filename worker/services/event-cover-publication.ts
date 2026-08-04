import {
  MAX_COVER_PUBLICATIONS_PER_HOUR,
  MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
  MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
} from '../../shared/constants';
import {
  CANONICAL_NONE_COVER_CONFIG,
  COVER_PIPELINE_VERSIONS,
  EVENT_COVER_PROFILES,
  type EventCoverPreparationView,
  type EventCoverPublishRequestV1,
  canonicalCoverConfig,
} from '../../shared/event-cover';
import { ApiError } from '../../shared/errors';
import { chargeCoverRateEvent } from '../db/event-covers';
import { coverPointerStatements } from '../db/events';
import type { CoverDraftRow, CoverPublishReceiptRow, EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { coverKeyFingerprint } from '../storage/event-cover-keys';

/**
 * Durable publication receipts, dispatch fences, and platform reconciliation.
 *
 * A committed receipt *is* acceptance. If the client never sees the response,
 * if the later dispatch returns 503, or if the tab closes, the work is still
 * accepted and its draft is not discardable — which is the whole reason this
 * lives in D1 rather than being inferred from a Workflow instance.
 */

const RECEIPT_APPLIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const RESTART_WINDOW_MS = 24 * 60 * 60 * 1000;
const FENCE_TTL_MS = 31 * 24 * 60 * 60 * 1000;
const RETIRED_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a `creating`/`resuming`/`restarting` claim may sit before purge reconciles it. */
export const STALE_DISPATCH_CLAIM_MS = 2 * 60 * 1000;

export const COVER_RENDER_BINDING = 'COVER_RENDER_WORKFLOW';

/* ------------------------------------------------------------------ *
 * Platform status
 * ------------------------------------------------------------------ */

export type CoverPlatformRecovery = 'none' | 'resume' | 'restart' | 'create';

export interface CoverPlatformDisposition {
  /** What the platform says, reduced to the four things Candidary does about it. */
  kind: 'active' | 'recoverable' | 'complete' | 'unknown' | 'missing';
  recovery: CoverPlatformRecovery;
  /** What a manager should be told while D1 is still nonterminal. */
  productStatus: 'preparing' | 'retryable-failed';
  /** Whether any mutation predicate may be satisfied on this reading. */
  mutates: boolean;
  retryable: boolean;
  /** Sanitized operations telemetry; never a raw platform status in a response. */
  telemetry: string | null;
}

/**
 * The total map from §9.4, and deliberately total.
 *
 * Its `default` preserves product state and emits telemetry rather than
 * guessing: an unrecognized status is the one case where treating the instance
 * as gone could destroy work that is actually running. No value other than the
 * ones named below is ever treated as non-running.
 */
export function mapPlatformStatus(status: string): CoverPlatformDisposition {
  switch (status) {
    case 'queued':
    case 'running':
    case 'waiting':
    case 'waitingForPause':
      return {
        kind: 'active', recovery: 'none', productStatus: 'preparing',
        mutates: false, retryable: true, telemetry: null,
      };
    // A paused instance is resumed on the same ID. Restarting it would discard
    // completed steps that are still valid.
    case 'paused':
      return {
        kind: 'recoverable', recovery: 'resume', productStatus: 'retryable-failed',
        mutates: true, retryable: true, telemetry: null,
      };
    case 'errored':
    case 'terminated':
      return {
        kind: 'recoverable', recovery: 'restart', productStatus: 'retryable-failed',
        mutates: true, retryable: true, telemetry: null,
      };
    // Reconcile D1 first: an existing applied, conflict, or failed result wins.
    // Only an unexpectedly nonterminal D1 becomes a retryable divergence.
    case 'complete':
      return {
        kind: 'complete', recovery: 'restart', productStatus: 'retryable-failed',
        mutates: true, retryable: true, telemetry: 'cover_platform_complete',
      };
    // Never satisfies a mutation predicate. Absence of information is not
    // evidence of absence of work.
    case 'unknown':
      return {
        kind: 'unknown', recovery: 'none', productStatus: 'preparing',
        mutates: false, retryable: true, telemetry: 'cover_platform_unknown',
      };
    // A *confirmed* not-found may be recreated under the same fenced ID. This is
    // recreation of the same operation, not a new publication.
    case 'not-found':
      return {
        kind: 'missing', recovery: 'create', productStatus: 'retryable-failed',
        mutates: true, retryable: true, telemetry: 'cover_platform_missing',
      };
    default:
      return {
        kind: 'active', recovery: 'none', productStatus: 'preparing',
        mutates: false, retryable: true, telemetry: `cover_platform_unmapped:${status.slice(0, 32)}`,
      };
  }
}

/* ------------------------------------------------------------------ *
 * Workflow accessor
 * ------------------------------------------------------------------ */

export interface CoverWorkflowAccessor {
  create(id: string, payload: { eventId: string; operationId: string }): Promise<void>;
  status(id: string): Promise<string>;
  resume(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
}

/**
 * Scoped to exactly what is unproven, and no wider.
 *
 * Binding *presence* under miniflare is already demonstrated by the export
 * route's 202. Instance *lifecycle* — get, status, resume, restart, terminate —
 * has no precedent anywhere in this repository, and every disposition above
 * depends on those calls. So the service takes its accessor as a dependency
 * that defaults to the real binding, and the tests drive the lifecycle through
 * a fake. The distance between that fake and the platform is a stated phase-1
 * limitation, not a silent one.
 */
export function defaultCoverWorkflowAccessor(env: AppEnv): CoverWorkflowAccessor {
  const workflow = env.COVER_RENDER_WORKFLOW;
  return {
    async create(id, payload) { await workflow.create({ id, params: payload }); },
    async status(id) {
      const instance = await workflow.get(id);
      const status = await instance.status();
      return String((status as { status?: string }).status ?? 'unknown');
    },
    async resume(id) { await (await workflow.get(id)).resume(); },
    async restart(id) { await (await workflow.get(id)).restart(); },
    async terminate(id) { await (await workflow.get(id)).terminate(); },
  };
}

/* ------------------------------------------------------------------ *
 * Receipts
 * ------------------------------------------------------------------ */

export interface CoverPublicationAcceptance {
  receipt: CoverPublishReceiptRow;
  /** True when this call inserted it, false when it loaded a prior attempt. */
  accepted: boolean;
  view: EventCoverPreparationView;
}

export interface CoverPublicationOutcome {
  applied: boolean;
  appliedRevision: number | null;
  receipt: CoverPublishReceiptRow;
  view: EventCoverPreparationView;
}

export interface CoverPublicationRestartResult {
  status: 'restarted' | 'terminal' | 'ineligible' | 'unavailable';
  view: EventCoverPreparationView | null;
  retryAfterSeconds: number | null;
}

/** A bounded lowercase-hex ID, unique within `CoverRenderWorkflow`. */
export async function coverWorkflowInstanceId(
  eventId: string,
  operationId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`cover-render-v1|${eventId}|${operationId}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `cr1-${hex.slice(0, 48)}`;
}

function preparationView(receipt: CoverPublishReceiptRow): EventCoverPreparationView {
  const status = receipt.status === 'applied'
    ? 'applied'
    : receipt.status === 'conflict'
      ? 'conflict'
      : receipt.status === 'failed'
        ? (receipt.retryable === 1 ? 'retryable-failed' : 'permanent-failed')
        : 'preparing';
  return {
    operationId: receipt.operation_id,
    status,
    completedSteps: receipt.completed_profiles,
    requiredSteps: receipt.required_profiles,
    retryable: receipt.retryable === 1,
    // An allowlisted product enum, never a platform status, object key, or
    // recipe. `failure_code` is only ever written from ApiErrorCode members.
    safeFailureCode: receipt.failure_code,
    updatedAt: receipt.updated_at,
  };
}

async function loadReceipt(
  env: AppEnv,
  eventId: string,
  operationId: string,
): Promise<CoverPublishReceiptRow | null> {
  return env.DB.prepare(
    'SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?',
  ).bind(eventId, operationId).first<CoverPublishReceiptRow>();
}

/**
 * The one receipt a Manager read should surface.
 *
 * The unresolved one if there is one, otherwise the most recently updated
 * terminal receipt from the last 24 hours, otherwise nothing. Server-selected
 * so clearing session storage cannot hide accepted work.
 */
export async function selectEventCoverPreparation(
  env: AppEnv,
  eventId: string,
  now: Date,
): Promise<EventCoverPreparationView | null> {
  const unresolved = await env.DB.prepare(`
    SELECT * FROM event_cover_publish_receipts
    WHERE event_id = ?
      AND (status IN ('queued', 'rendering', 'finalizing') OR (status = 'failed' AND retryable = 1))
    ORDER BY updated_at DESC LIMIT 1
  `).bind(eventId).first<CoverPublishReceiptRow>();
  if (unresolved) return preparationView(unresolved);

  const recent = await env.DB.prepare(`
    SELECT * FROM event_cover_publish_receipts
    WHERE event_id = ? AND status IN ('applied', 'conflict', 'failed') AND updated_at >= ?
    ORDER BY updated_at DESC LIMIT 1
  `).bind(eventId, new Date(now.getTime() - RECEIPT_TERMINAL_TTL_MS).toISOString())
    .first<CoverPublishReceiptRow>();
  return recent ? preparationView(recent) : null;
}

/** Side-effect-free. Read-only product-view synthesis, never a writer. */
export async function readCoverPublication(
  env: AppEnv,
  input: {
    eventId: string;
    operationId: string;
    now: Date;
    workflow?: CoverWorkflowAccessor;
  },
): Promise<EventCoverPreparationView | null> {
  const receipt = await loadReceipt(env, input.eventId, input.operationId);
  if (!receipt) return null;
  const view = preparationView(receipt);
  if (view.status !== 'preparing' || !receipt.workflow_instance_id) return view;

  // D1 is nonterminal, so the recorded instance is consulted and §9.4's map
  // applied in memory. This may synthesize an immediate retryable view; it may
  // not write one. The Workflow handler, the restart POST, and bounded cleanup
  // are the authoritative writers.
  const accessor = input.workflow ?? defaultCoverWorkflowAccessor(env);
  // A failed status read is `unknown`, not absence: it must not satisfy any
  // mutation predicate, and it must not be reported as a failure either.
  const platform = await accessor.status(receipt.workflow_instance_id).catch(() => 'unknown');
  const disposition = mapPlatformStatus(platform);
  if (disposition.productStatus === 'preparing') return view;
  return { ...view, status: 'retryable-failed', retryable: true };
}

interface AcceptContext {
  event: EventRecord;
  request: EventCoverPublishRequestV1;
  requestDigest: string;
  now: Date;
}

async function assertStorageCaps(env: AppEnv, eventId: string): Promise<void> {
  const counts = await env.DB.prepare(`
    SELECT
      (SELECT count(*) FROM event_cover_render_sets
        WHERE event_id = ? AND state <> 'active') AS sets,
      (SELECT count(*) FROM event_cover_publish_receipts WHERE event_id = ?) AS receipts
  `).bind(eventId, eventId).first<{ sets: number; receipts: number }>();
  if ((counts?.sets ?? 0) >= MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT
    || (counts?.receipts ?? 0) >= MAX_RETAINED_COVER_RECEIPTS_PER_EVENT) {
    throw new ApiError(
      'COVER_PUBLICATION_CONFLICT',
      'This event has as much cover history as it can hold. Try again after the next daily cleanup.',
      409,
    );
  }
}

/**
 * Insert-or-load, then the cheap revision check, then freeze and allocate.
 *
 * Duplicate lookup happens *before* the revision check on purpose: an
 * already-applied replay has to stay recoverable even though its expected
 * revision is now stale, and reversing the two would turn every lost response
 * into a spurious conflict.
 */
export async function acceptCoverPublication(
  env: AppEnv,
  input: AcceptContext,
): Promise<CoverPublicationAcceptance> {
  const { event, request, requestDigest, now } = input;
  const existing = await loadReceipt(env, event.id, request.operationId);
  if (existing) {
    if (existing.request_sha256 !== requestDigest) {
      throw new ApiError(
        'COVER_PUBLICATION_CONFLICT',
        'That publish was already used with different details. Reload and try again.',
        409,
      );
    }
    return { receipt: existing, accepted: false, view: preparationView(existing) };
  }

  // A first-seen operation is charged; a replay reached the branch above and
  // never gets here, so it consumes no capacity.
  await chargeCoverRateEvent(env.DB, {
    eventId: event.id,
    action: 'publication',
    replayKey: request.operationId,
    requestDigest,
    limit: MAX_COVER_PUBLICATIONS_PER_HOUR,
    now,
  });
  await assertStorageCaps(env, event.id);

  const timestamp = now.toISOString();
  const isUpload = 'focus' in request;
  const draft = isUpload ? await requireReadyDraft(env, event.id, request.source.draftId) : null;
  const workflowInstanceId = isUpload
    ? await coverWorkflowInstanceId(event.id, request.operationId)
    : null;
  const renderSetId = isUpload ? crypto.randomUUID() : null;

  // The cheap revision check, before any Images work and before a Workflow
  // exists. A first attempt that is already stale becomes `conflict` here.
  const stale = event.coverRevision !== request.expectedRevision;
  const status = stale ? 'conflict' : 'queued';

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, draft_id, render_set_id, request_sha256, action,
        expected_revision, status, workflow_instance_id, dependency_versions_json,
        completed_profiles, required_profiles, failure_code, retryable,
        dispatch_state, dispatch_generation, created_at, updated_at, expires_at
      )
      SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 0, 'pending', 0, ?, ?, ?
      WHERE (SELECT cover_revision FROM events WHERE id = ? AND deleted_at IS NULL) IS NOT NULL
    `).bind(
      event.id, request.operationId, draft?.id ?? null,
      requestDigest,
      request.source.kind === 'none' ? 'remove' : 'publish',
      request.expectedRevision, status,
      stale ? null : workflowInstanceId,
      JSON.stringify(COVER_PIPELINE_VERSIONS),
      isUpload ? EVENT_COVER_PROFILES.length : 0,
      timestamp, timestamp,
      new Date(now.getTime() + (stale ? RECEIPT_TERMINAL_TTL_MS : RECEIPT_APPLIED_TTL_MS)).toISOString(),
      event.id,
    ),
  ];

  // The render set is adopted by a later statement rather than named in the
  // insert above. Foreign keys are enforced immediately, not deferred to commit,
  // so a receipt that named a set created further down the same batch would fail
  // outright — and moving the set first would break the guard-first convention
  // and leave an orphan staging set behind whenever the guard was lost.
  if (!stale && isUpload && draft && renderSetId && workflowInstanceId) {
    statements.push(
      // Freeze the draft. `publishing` is what makes it non-discardable until
      // the receipt is terminal.
      env.DB.prepare(`
        UPDATE event_cover_drafts
        SET state = 'publishing', draft_revision = draft_revision + 1, updated_at = ?
        WHERE id = ? AND event_id = ? AND state = 'ready' AND changes() = 1
      `).bind(timestamp, draft.id, event.id),
      env.DB.prepare(`
        INSERT INTO event_cover_render_sets (
          id, event_id, master_id, draft_id, recipe_json, recipe_sha256, state,
          required_slots, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'staging', ?, ? WHERE changes() = 1
      `).bind(
        renderSetId, event.id, draft.master_id, draft.id,
        canonicalCoverConfig(publishedConfig(request)), requestDigest,
        // Both formats for all six 1x profiles is the floor; the Workflow's
        // preflight raises it once the master's 2x eligibility is known.
        EVENT_COVER_PROFILES.length * 2, timestamp,
      ),
      env.DB.prepare(`
        UPDATE event_cover_publish_receipts SET render_set_id = ?
        WHERE event_id = ? AND operation_id = ? AND changes() = 1
      `).bind(renderSetId, event.id, request.operationId),
      // The fence closes the gap between this commit and the platform call.
      env.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        )
        SELECT ?, ?, ?, 0, 'open', ?, ?, ? WHERE changes() = 1
      `).bind(
        COVER_RENDER_BINDING, workflowInstanceId, event.id, timestamp, timestamp,
        new Date(now.getTime() + FENCE_TTL_MS).toISOString(),
      ),
    );
  }

  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    // The one-preparing-per-event partial unique index, or a concurrent insert
    // of this same operation. Re-read before deciding which.
    const raced = await loadReceipt(env, event.id, request.operationId);
    if (raced && raced.request_sha256 === requestDigest) {
      return { receipt: raced, accepted: false, view: preparationView(raced) };
    }
    if (String(error).includes('UNIQUE')) {
      throw new ApiError(
        'COVER_PUBLICATION_CONFLICT',
        'Another cover change is already being prepared for this event. Wait for it to finish.',
        409,
      );
    }
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const raced = await loadReceipt(env, event.id, request.operationId);
    if (raced && raced.request_sha256 === requestDigest) {
      return { receipt: raced, accepted: false, view: preparationView(raced) };
    }
    throw new ApiError(
      'COVER_PUBLICATION_CONFLICT',
      'Another cover change is already being prepared for this event. Wait for it to finish.',
      409,
    );
  }

  const receipt = (await loadReceipt(env, event.id, request.operationId))!;
  return { receipt, accepted: true, view: preparationView(receipt) };
}

function publishedConfig(request: EventCoverPublishRequestV1) {
  if (!('effect' in request)) return CANONICAL_NONE_COVER_CONFIG;
  if ('focus' in request) {
    return {
      version: 1 as const,
      source: { kind: 'upload' as const },
      focus: request.focus,
      effect: request.effect,
    };
  }
  return {
    version: 1 as const,
    source: {
      kind: 'preset' as const,
      presetId: request.source.presetId,
      assetVersion: 1 as const,
    },
    effect: request.effect,
  };
}

async function requireReadyDraft(
  env: AppEnv,
  eventId: string,
  draftId: string,
): Promise<CoverDraftRow> {
  const draft = await env.DB.prepare(
    'SELECT * FROM event_cover_drafts WHERE id = ? AND event_id = ?',
  ).bind(draftId, eventId).first<CoverDraftRow>();
  if (!draft || draft.state !== 'ready' || !draft.master_id) {
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'That cover is not ready to publish yet. Reload and try again.',
      409,
    );
  }
  return draft;
}

/**
 * The synchronous `none` publication.
 *
 * Lives here rather than in a route so removal and the Workflow's finalize
 * share exactly one writer for the event pointers; both compose
 * `coverPointerStatements` into their own batch.
 */
export async function applyRemovalPublication(
  env: AppEnv,
  input: {
    event: EventRecord;
    operationId: string;
    requestDigest: string;
    expectedRevision: number;
    now: Date;
  },
): Promise<CoverPublicationOutcome> {
  const receipt = await loadReceipt(env, input.event.id, input.operationId);
  if (!receipt) throw new Error('Removal publication requires an accepted receipt.');
  if (receipt.status === 'applied' || receipt.status === 'conflict') {
    return {
      applied: receipt.status === 'applied',
      appliedRevision: receipt.applied_revision,
      receipt,
      view: preparationView(receipt),
    };
  }

  const timestamp = input.now.toISOString();
  const results = await env.DB.batch([
    ...coverPointerStatements(env.DB, {
      eventId: input.event.id,
      expectedRevision: input.expectedRevision,
      expectedCurrentKey: input.event.coverObjectKey,
      expectedCurrentRenderSetId: input.event.coverRenderSetId,
      nextConfig: canonicalCoverConfig(CANONICAL_NONE_COVER_CONFIG),
      nextObjectKey: null,
      nextRenderSetId: null,
      retiredAt: timestamp,
      cleanupAfter: new Date(input.now.getTime() + RETIRED_RECOVERY_MS).toISOString(),
      retiredKeyFingerprint: input.event.coverObjectKey
        ? await coverKeyFingerprint(input.event.coverObjectKey)
        : '0'.repeat(64),
    }),
    // Retire the previous active set in the same transaction, so nothing is
    // ever pointed at by an event that has moved on.
    env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'retired', retired_at = ?, cleanup_after = ?
      WHERE id = ? AND state = 'active'
        AND EXISTS (SELECT 1 FROM events WHERE id = ? AND cover_revision = ?)
    `).bind(
      timestamp, new Date(input.now.getTime() + RETIRED_RECOVERY_MS).toISOString(),
      input.event.coverRenderSetId, input.event.id, input.expectedRevision + 1,
    ),
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'applied', applied_revision = ?, result_cover_json = ?, updated_at = ?,
          dispatch_state = 'confirmed', expires_at = ?
      WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
        AND status NOT IN ('applied', 'conflict')
        AND EXISTS (SELECT 1 FROM events WHERE id = ? AND cover_revision = ?)
    `).bind(
      input.expectedRevision + 1,
      canonicalCoverConfig(CANONICAL_NONE_COVER_CONFIG),
      timestamp,
      new Date(input.now.getTime() + RECEIPT_APPLIED_TTL_MS).toISOString(),
      input.event.id, input.operationId, input.requestDigest,
      input.event.id, input.expectedRevision + 1,
    ),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    // The house shape for a lost optimistic guard. A new code would say the
    // cover pipeline failed; it did not — the manager's page is simply stale.
    await recordConflict(env, input.event.id, input.operationId, input.now);
    throw new ApiError(
      'VALIDATION_FAILED',
      'This cover has moved on since this page loaded. Reload and try again.',
      409,
    );
  }

  const updated = (await loadReceipt(env, input.event.id, input.operationId))!;
  return {
    applied: true,
    appliedRevision: input.expectedRevision + 1,
    receipt: updated,
    view: preparationView(updated),
  };
}

async function recordConflict(
  env: AppEnv,
  eventId: string,
  operationId: string,
  now: Date,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE event_cover_publish_receipts
    SET status = 'conflict', retryable = 0, updated_at = ?, expires_at = ?
    WHERE event_id = ? AND operation_id = ? AND status NOT IN ('applied', 'conflict')
  `).bind(
    now.toISOString(),
    new Date(now.getTime() + RECEIPT_TERMINAL_TTL_MS).toISOString(),
    eventId, operationId,
  ).run();
}

/**
 * The only `failed -> queued` edge.
 *
 * Reconstructs nothing from the client: the pinned request, digest, draft,
 * expected revision, render set, dependency versions, and Workflow ID all come
 * from the receipt, which is what lets `Try again` survive a reload with every
 * scrap of local state cleared.
 */
export async function restartCoverPublication(
  env: AppEnv,
  input: {
    eventId: string;
    operationId: string;
    now: Date;
    workflow?: CoverWorkflowAccessor;
  },
): Promise<CoverPublicationRestartResult> {
  const receipt = await loadReceipt(env, input.eventId, input.operationId);
  if (!receipt) return { status: 'ineligible', view: null, retryAfterSeconds: null };
  if (receipt.status === 'applied' || receipt.status === 'conflict') {
    return { status: 'terminal', view: preparationView(receipt), retryAfterSeconds: null };
  }
  if (!receipt.workflow_instance_id) {
    return { status: 'ineligible', view: preparationView(receipt), retryAfterSeconds: null };
  }

  const accessor = input.workflow ?? defaultCoverWorkflowAccessor(env);
  // A failed status read is `unknown`, not absence: it must not satisfy any
  // mutation predicate, and it must not be reported as a failure either.
  const platform = await accessor.status(receipt.workflow_instance_id).catch(() => 'unknown');
  const disposition = mapPlatformStatus(platform);

  // A permanently failed receipt is not restartable however the platform reads.
  if (receipt.status === 'failed' && receipt.retryable === 0) {
    return { status: 'ineligible', view: preparationView(receipt), retryAfterSeconds: null };
  }
  if (!disposition.mutates) {
    // `unknown` never satisfies a mutation predicate. The caller returns 503
    // with polling guidance rather than acting on absent information.
    return {
      status: disposition.kind === 'unknown' ? 'unavailable' : 'ineligible',
      view: preparationView(receipt),
      retryAfterSeconds: disposition.kind === 'unknown' ? 5 : null,
    };
  }

  // Outside its restart window a retryable failure is no longer recoverable;
  // the host needs a corrected draft and a new operation.
  const failedAt = Date.parse(receipt.updated_at);
  if (receipt.status === 'failed' && input.now.getTime() - failedAt > RESTART_WINDOW_MS) {
    return { status: 'ineligible', view: preparationView(receipt), retryAfterSeconds: null };
  }

  const timestamp = input.now.toISOString();
  const claimed = await env.DB.batch([
    // One guarded transaction: persist the mapped failure if D1 was still
    // nonterminal, and claim the recovery edge, so recovery never waits for the
    // daily sweep. Rechecks the revision and the one-preparation cap.
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'queued', retryable = 1, failure_code = NULL,
          dispatch_state = ?, dispatch_generation = dispatch_generation + 1,
          last_dispatch_at = ?, updated_at = ?
      WHERE event_id = ? AND operation_id = ? AND workflow_instance_id = ?
        AND status IN ('queued', 'rendering', 'finalizing', 'failed')
        AND (status <> 'failed' OR retryable = 1)
        AND EXISTS (
          SELECT 1 FROM events
          WHERE id = ? AND deleted_at IS NULL AND cover_revision = expected_revision
        )
    `).bind(
      disposition.recovery === 'resume' ? 'resuming'
        : disposition.recovery === 'create' ? 'creating' : 'restarting',
      timestamp, timestamp,
      input.eventId, input.operationId, receipt.workflow_instance_id, input.eventId,
    ),
    // The fence must still be open. If deletion won the race it is
    // `deletion-blocked`, and this claim changes nothing.
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET dispatch_generation = dispatch_generation + 1, updated_at = ?
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND state = 'open'
        AND changes() = 1
    `).bind(timestamp, COVER_RENDER_BINDING, receipt.workflow_instance_id),
  ]);

  if ((claimed[0]?.meta.changes ?? 0) !== 1) {
    const current = (await loadReceipt(env, input.eventId, input.operationId))!;
    return { status: 'ineligible', view: preparationView(current), retryAfterSeconds: null };
  }

  try {
    if (disposition.recovery === 'resume') await accessor.resume(receipt.workflow_instance_id);
    else if (disposition.recovery === 'create') {
      await accessor.create(receipt.workflow_instance_id, {
        eventId: input.eventId, operationId: input.operationId,
      });
    } else await accessor.restart(receipt.workflow_instance_id);
  } catch {
    await markDispatchFailed(env, input.eventId, input.operationId, input.now);
    return { status: 'unavailable', view: null, retryAfterSeconds: 5 };
  }

  // Mandatory post-call check. If deletion won the commit/dispatch gap, the
  // instance is terminated and no successful dispatch is recorded.
  const fence = await env.DB.prepare(`
    SELECT state FROM event_cover_workflow_fences
    WHERE workflow_binding = ? AND workflow_instance_id = ?
  `).bind(COVER_RENDER_BINDING, receipt.workflow_instance_id).first<{ state: string }>();
  if (fence?.state !== 'open') {
    try { await accessor.terminate(receipt.workflow_instance_id); } catch { /* purge retries */ }
    await markDispatchFailed(env, input.eventId, input.operationId, input.now);
    return { status: 'ineligible', view: null, retryAfterSeconds: null };
  }

  await env.DB.prepare(`
    UPDATE event_cover_publish_receipts SET dispatch_state = 'confirmed', updated_at = ?
    WHERE event_id = ? AND operation_id = ?
  `).bind(timestamp, input.eventId, input.operationId).run();

  const updated = (await loadReceipt(env, input.eventId, input.operationId))!;
  return { status: 'restarted', view: preparationView(updated), retryAfterSeconds: 2 };
}

export async function markDispatchFailed(
  env: AppEnv,
  eventId: string,
  operationId: string,
  now: Date,
): Promise<void> {
  await env.DB.prepare(`
    UPDATE event_cover_publish_receipts
    SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
        dispatch_state = 'failed', updated_at = ?, expires_at = ?
    WHERE event_id = ? AND operation_id = ? AND status NOT IN ('applied', 'conflict')
  `).bind(
    now.toISOString(),
    new Date(now.getTime() + RESTART_WINDOW_MS).toISOString(),
    eventId, operationId,
  ).run();
}

/** Records a successful first dispatch, after the mandatory fence recheck. */
export async function confirmCoverDispatch(
  env: AppEnv,
  input: {
    eventId: string;
    operationId: string;
    workflowInstanceId: string;
    now: Date;
    workflow: CoverWorkflowAccessor;
  },
): Promise<boolean> {
  const fence = await env.DB.prepare(`
    SELECT state FROM event_cover_workflow_fences
    WHERE workflow_binding = ? AND workflow_instance_id = ?
  `).bind(COVER_RENDER_BINDING, input.workflowInstanceId).first<{ state: string }>();
  if (fence?.state !== 'open') {
    try { await input.workflow.terminate(input.workflowInstanceId); } catch { /* purge retries */ }
    await markDispatchFailed(env, input.eventId, input.operationId, input.now);
    return false;
  }
  await env.DB.prepare(`
    UPDATE event_cover_publish_receipts
    SET dispatch_state = 'confirmed', last_dispatch_at = ?, updated_at = ?
    WHERE event_id = ? AND operation_id = ? AND status = 'queued'
  `).bind(input.now.toISOString(), input.now.toISOString(), input.eventId, input.operationId).run();
  return true;
}

import {
  COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
  MAX_COVER_PUBLICATIONS_PER_HOUR,
  MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
  MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
  coverWorkflowFenceTerminalExpiry,
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
import { coverPointerStatements, EventsRepository } from '../db/events';
import type {
  CoverDispatchState,
  CoverDraftRow,
  CoverPublishReceiptRow,
  EventRecord,
} from '../db/types';
import type { AppEnv } from '../env';
import { coverKeyFingerprint } from '../storage/event-cover-keys';
import {
  defaultCoverWorkflowAccessor,
  dispositionForLookup,
  emitCoverPlatformTelemetry,
  type CoverPlatformDisposition,
  type CoverWorkflowAccessor,
  type CoverWorkflowLookup,
} from '../workflows/cover-platform';

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
const RETIRED_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a `creating`/`resuming`/`restarting` claim may sit before purge reconciles it. */
export const STALE_DISPATCH_CLAIM_MS = 2 * 60 * 1000;
const DISPATCH_CLAIM_APPLIED_AT_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * The wrangler binding name, and an immutable release constant from 0012 onward.
 *
 * It is written into every `event_cover_workflow_fences` row, so renaming it
 * later orphans every fence still protecting an instance. (The reasoning lives
 * here rather than in `wrangler.jsonc`, which despite its extension must stay
 * comment-free — `tests/unit/static-headers.test.ts` JSON.parses it.)
 */
export const COVER_RENDER_BINDING = 'COVER_RENDER_WORKFLOW';

/**
 * Reads the recorded instance and reduces it to a disposition, never throwing.
 *
 * The real adapter already classifies its own failures, so this guard exists for
 * an injected accessor that rejects. It resolves to `unknown` for the same
 * reason the adapter does: a lookup that established nothing must satisfy no
 * mutation predicate by itself and must not be reported to a manager as a
 * failure. The restart writer may still replay a fully guarded deterministic
 * ID through idempotent batch creation without classifying it as absent.
 */
async function lookupDisposition(
  accessor: CoverWorkflowAccessor,
  instanceId: string,
): Promise<CoverPlatformDisposition> {
  const lookup = await accessor.lookup(instanceId).catch(
    (): CoverWorkflowLookup => ({ kind: 'unknown', telemetry: 'cover_platform_lookup_failed' }),
  );
  const disposition = dispositionForLookup(lookup);
  emitCoverPlatformTelemetry('publication', disposition.telemetry);
  return disposition;
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
  event: EventRecord;
}

export interface CoverPublicationRestartResult {
  status: 'active' | 'restarted' | 'terminal' | 'ineligible' | 'unavailable';
  view: EventCoverPreparationView | null;
  retryAfterSeconds: number | null;
}

export interface CoverPublicationTerminalResult {
  status: 'applied' | 'conflict' | 'failed';
  appliedRevision: number | null;
  view: EventCoverPreparationView;
}

type CoverDispatchClaimState = 'creating' | 'resuming' | 'restarting';

interface CoverDispatchScope {
  workflowInstanceId: string;
  dispatchState: CoverDispatchState;
  dispatchGeneration: number;
}

export type InitialCoverDispatchClaim =
  | { kind: 'claimed'; dispatchGeneration: number }
  | { kind: 'in-flight'; dispatchGeneration: number }
  | { kind: 'stale'; dispatchGeneration: number }
  | { kind: 'confirmed' }
  | { kind: 'unavailable' };

/**
 * The digest a receipt is pinned to, over the canonical request string.
 *
 * Taken over the canonical serialization rather than the raw body, so a client
 * that reorders keys or reformats whitespace on a retry still replays into its
 * own receipt instead of colliding with it.
 */
export async function coverRequestDigest(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

function activePreparationView(receipt: CoverPublishReceiptRow): EventCoverPreparationView {
  return {
    ...preparationView(receipt),
    status: 'preparing',
    retryable: false,
    safeFailureCode: null,
  };
}

function terminalReceiptStatus(
  receipt: CoverPublishReceiptRow,
): CoverPublicationTerminalResult['status'] | null {
  if (receipt.status === 'applied' || receipt.status === 'conflict') return receipt.status;
  return receipt.status === 'failed' && receipt.retryable === 0 ? 'failed' : null;
}

function terminalRestartResult(receipt: CoverPublishReceiptRow): CoverPublicationRestartResult {
  return { status: 'terminal', view: preparationView(receipt), retryAfterSeconds: null };
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

/** Reads the exact durable terminal result after a platform dispatch attempt. */
export async function readCoverPublicationTerminalResult(
  env: AppEnv,
  eventId: string,
  operationId: string,
): Promise<CoverPublicationTerminalResult | null> {
  const receipt = await loadReceipt(env, eventId, operationId);
  if (!receipt) return null;
  const status = terminalReceiptStatus(receipt);
  if (!status) return null;
  return {
    status,
    appliedRevision: receipt.applied_revision,
    view: preparationView(receipt),
  };
}

async function hasYoungExactDispatchClaim(
  env: AppEnv,
  input: { eventId: string; operationId: string; workflowInstanceId: string },
): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT 1 AS present
    FROM event_cover_publish_receipts r
    WHERE r.event_id = ? AND r.operation_id = ? AND r.workflow_instance_id = ?
      AND r.dispatch_state IN ('creating', 'resuming', 'restarting')
      AND (
        r.status IN ('queued', 'rendering', 'finalizing')
        OR (r.status = 'failed' AND r.retryable = 1)
      )
      AND r.last_dispatch_at IS NOT NULL
      AND r.last_dispatch_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes')
      AND EXISTS (
        SELECT 1 FROM event_cover_workflow_fences f
        WHERE f.workflow_binding = ? AND f.workflow_instance_id = r.workflow_instance_id
          AND f.event_id = r.event_id AND f.state = 'open'
          AND f.dispatch_generation = r.dispatch_generation
      )
  `).bind(
    input.eventId, input.operationId, input.workflowInstanceId, COVER_RENDER_BINDING,
  ).first<{ present: number }>();
  return row !== null;
}

function isRecoverableReceipt(receipt: CoverPublishReceiptRow): boolean {
  return receipt.status === 'queued'
    || receipt.status === 'rendering'
    || receipt.status === 'finalizing'
    || (receipt.status === 'failed' && receipt.retryable === 1);
}

async function loadReceiptWithExactOpenDispatchFence(
  env: AppEnv,
  input: { eventId: string; operationId: string; workflowInstanceId: string },
): Promise<(CoverPublishReceiptRow & { exact_open_fence: number }) | null> {
  return env.DB.prepare(`
    SELECT r.*, EXISTS (
      SELECT 1 FROM event_cover_workflow_fences f
      WHERE f.workflow_binding = ? AND f.workflow_instance_id = r.workflow_instance_id
        AND f.event_id = r.event_id AND f.state = 'open'
        AND f.dispatch_generation = r.dispatch_generation
    ) AS exact_open_fence
    FROM event_cover_publish_receipts r
    WHERE r.event_id = ? AND r.operation_id = ? AND r.workflow_instance_id = ?
  `).bind(
    COVER_RENDER_BINDING,
    input.eventId,
    input.operationId,
    input.workflowInstanceId,
  ).first<CoverPublishReceiptRow & { exact_open_fence: number }>();
}

function platformDispositionIsKnown(disposition: CoverPlatformDisposition): boolean {
  return disposition.kind !== 'unknown'
    && disposition.telemetry !== 'cover_platform_unmapped';
}

/**
 * Classifies the fresh durable owner after an awaited lookup or platform edge
 * loses its original receipt CAS. A newer exact claim/confirmation is progress,
 * never a transient platform outage; unknown evidence remains fail-closed.
 */
async function recoveryResultAfterLostOwnership(
  env: AppEnv,
  input: { eventId: string; operationId: string; workflowInstanceId: string },
  disposition: CoverPlatformDisposition,
): Promise<CoverPublicationRestartResult | null> {
  const current = await loadReceipt(env, input.eventId, input.operationId);
  if (!current) return { status: 'ineligible', view: null, retryAfterSeconds: null };
  if (terminalReceiptStatus(current)) return terminalRestartResult(current);
  if (disposition.kind === 'complete' && current.status === 'failed') {
    return terminalRestartResult(current);
  }
  if (current.workflow_instance_id !== input.workflowInstanceId) return null;

  const platformKnown = platformDispositionIsKnown(disposition);
  const youngClaim = await hasYoungExactDispatchClaim(env, input);
  const exactOwner = await loadReceiptWithExactOpenDispatchFence(env, input);
  const ownsOpenFence = exactOwner?.exact_open_fence === 1
    && isRecoverableReceipt(exactOwner);
  const platformActive = disposition.kind === 'active' && disposition.telemetry === null;
  if (ownsOpenFence && platformKnown && (youngClaim || platformActive)) {
    return {
      status: 'active',
      view: activePreparationView(current),
      retryAfterSeconds: 2,
    };
  }
  if (!platformKnown && youngClaim) {
    return {
      status: 'unavailable',
      view: preparationView(current),
      retryAfterSeconds: 5,
    };
  }
  return null;
}

async function recoveryGuardIsKnownIneligible(
  env: AppEnv,
  input: { eventId: string; operationId: string; workflowInstanceId: string },
): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT
      (
        r.status = 'failed'
        AND r.expires_at <= ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      ) AS restart_expired,
      (
        SELECT count(*) FROM event_cover_publish_receipts retained
        WHERE retained.event_id = r.event_id
      ) > ? AS receipts_over_cap,
      (
        SELECT count(*) FROM event_cover_render_sets retained_set
        WHERE retained_set.event_id = r.event_id
          AND retained_set.state <> 'active'
      ) > ? AS sets_over_cap
    FROM event_cover_publish_receipts r
    WHERE r.event_id = ? AND r.operation_id = ? AND r.workflow_instance_id = ?
  `).bind(
    MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
    MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
    input.eventId,
    input.operationId,
    input.workflowInstanceId,
  ).first<{ restart_expired: number; receipts_over_cap: number; sets_over_cap: number }>();
  return row !== null
    && (row.restart_expired === 1 || row.receipts_over_cap === 1 || row.sets_over_cap === 1);
}

function sameRecoverySnapshot(
  before: CoverPublishReceiptRow,
  after: CoverPublishReceiptRow,
): boolean {
  return before.workflow_instance_id === after.workflow_instance_id
    && before.status === after.status
    && before.retryable === after.retryable
    && before.dispatch_state === after.dispatch_state
    && before.dispatch_generation === after.dispatch_generation;
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
  if ((view.status !== 'preparing' && view.status !== 'retryable-failed')
    || !receipt.workflow_instance_id) return view;

  // D1 is nonterminal, so the recorded instance is consulted and §9.4's map
  // applied in memory. This may synthesize an immediate retryable view; it may
  // not write one. The Workflow handler, the restart POST, and bounded cleanup
  // are the authoritative writers.
  const accessor = input.workflow ?? defaultCoverWorkflowAccessor(env);
  // A failed lookup is `unknown`, not absence: it must not satisfy any
  // mutation predicate, and it must not be reported as a failure either.
  const disposition = await lookupDisposition(accessor, receipt.workflow_instance_id);
  const current = await loadReceipt(env, input.eventId, input.operationId);
  if (!current) return null;
  const currentView = preparationView(current);
  if (terminalReceiptStatus(current)) return currentView;
  // A lookup about an older recovery generation cannot classify the generation
  // that won while it was pending. Progress-only changes are safe to surface
  // from the fresh row because they do not change this ownership snapshot.
  if (!sameRecoverySnapshot(receipt, current)) return currentView;
  if (disposition.kind === 'active' && disposition.telemetry === null) {
    return activePreparationView(current);
  }
  if (disposition.productStatus === 'preparing') return currentView;
  return {
    ...currentView,
    status: 'retryable-failed', retryable: true,
    safeFailureCode: 'COVER_RENDER_UNAVAILABLE',
  };
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
  if (!('focus' in request)) {
    const prior = await loadReceipt(env, event.id, request.operationId);
    const outcome = await applySemanticCoverPublication(env, input);
    return {
      receipt: outcome.receipt,
      accepted: prior === null,
      view: outcome.view,
    };
  }
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
  const draft = await requireReadyDraft(env, event.id, request.source.draftId);
  const workflowInstanceId = await coverWorkflowInstanceId(event.id, request.operationId);
  const renderSetId = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, draft_id, render_set_id, request_sha256, action,
        expected_revision, status, workflow_instance_id, dependency_versions_json,
        completed_profiles, required_profiles, failure_code, retryable,
        dispatch_state, dispatch_generation, created_at, updated_at, expires_at
      )
      SELECT ?, ?, ?, NULL, ?, ?, ?,
        CASE WHEN e.cover_revision = ? THEN 'queued' ELSE 'conflict' END,
        CASE WHEN e.cover_revision = ? THEN ? ELSE NULL END,
        ?, 0, ?, NULL, 0, 'pending', 0, ?, ?,
        CASE WHEN e.cover_revision = ? THEN ? ELSE ? END
      FROM events e WHERE e.id = ? AND e.deleted_at IS NULL
        AND (
          e.cover_revision <> ? OR ? = 0 OR EXISTS (
            SELECT 1 FROM event_cover_drafts d
            WHERE d.id = ? AND d.event_id = e.id AND d.state = 'ready'
              AND d.master_id = ?
          )
        )
        AND (
          ? = 1 OR e.cover_revision <> ? OR (
            e.cover_object_key IS ? AND e.cover_render_set_id IS ?
          )
        )
        AND (
          SELECT count(*) FROM event_cover_publish_receipts retained
          WHERE retained.event_id = e.id
        ) < ?
        AND (
          SELECT count(*) FROM event_cover_render_sets retained_set
          WHERE retained_set.event_id = e.id AND retained_set.state <> 'active'
        ) < ?
    `).bind(
      event.id, request.operationId, draft?.id ?? null,
      requestDigest,
       'publish',
      request.expectedRevision,
      request.expectedRevision,
      request.expectedRevision, workflowInstanceId,
      JSON.stringify(COVER_PIPELINE_VERSIONS),
       EVENT_COVER_PROFILES.length,
      timestamp, timestamp,
      request.expectedRevision,
      new Date(now.getTime() + RECEIPT_APPLIED_TTL_MS).toISOString(),
      new Date(now.getTime() + RECEIPT_TERMINAL_TTL_MS).toISOString(),
      event.id,
      request.expectedRevision,
       1,
       draft.id,
       draft.master_id,
       1,
      request.expectedRevision,
      event.coverObjectKey,
      event.coverRenderSetId,
      MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
      MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
    ),
  ];

  // The render set is adopted by a later statement rather than named in the
  // insert above. Foreign keys are enforced immediately, not deferred to commit,
  // so a receipt that named a set created further down the same batch would fail
  // outright — and moving the set first would break the guard-first convention
  // and leave an orphan staging set behind whenever the guard was lost.
  statements.push(
      // Freeze the draft. `publishing` is what makes it non-discardable until
      // the receipt is terminal.
      env.DB.prepare(`
        UPDATE event_cover_drafts
        SET state = 'publishing', draft_revision = draft_revision + 1, updated_at = ?
        WHERE id = ? AND event_id = ? AND state = 'ready' AND changes() = 1
          AND EXISTS (
            SELECT 1 FROM event_cover_publish_receipts r
            WHERE r.event_id = ? AND r.operation_id = ? AND r.status = 'queued'
              AND r.workflow_instance_id = ? AND r.expected_revision = ?
              AND r.render_set_id IS NULL
          )
      `).bind(
        timestamp, draft.id, event.id,
        event.id, request.operationId, workflowInstanceId, request.expectedRevision,
      ),
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
        WHERE event_id = ? AND operation_id = ? AND status = 'queued'
          AND workflow_instance_id = ? AND render_set_id IS NULL AND changes() = 1
      `).bind(renderSetId, event.id, request.operationId, workflowInstanceId),
      // The fence closes the gap between this commit and the platform call.
      env.DB.prepare(`
        INSERT INTO event_cover_workflow_fences (
          workflow_binding, workflow_instance_id, event_id, dispatch_generation,
          state, created_at, updated_at, expires_at
        )
        SELECT ?, ?, ?, 0, 'open', ?, ?, ? WHERE changes() = 1
      `).bind(
        COVER_RENDER_BINDING, workflowInstanceId, event.id, timestamp, timestamp,
        COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      ),
    );

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
    // The optimistic read above gives the ordinary fast refusal, while the
    // INSERT predicate is the serialized authority. Re-read here so a cap that
    // filled between those points reports the same safe reason without ever
    // committing receipt 1,025 or render set 33.
    await assertStorageCaps(env, event.id);
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

interface PublicationRetentionOwner {
  eventId: string;
  operationId: string;
  requestSha256: string;
  expectedRevision: number;
  expectedCurrentKey: string | null;
  expectedCurrentRenderSetId: string | null;
  displacedMasterId: string | null;
  retiredAt: string;
  cleanupFloor: string;
  retiredKeyFingerprint: string;
}

interface SemanticPublicationOwner extends PublicationRetentionOwner {
  kind: 'semantic';
  action: 'publish' | 'remove';
  nextConfig: string;
}

export interface RenderPublicationOwner extends PublicationRetentionOwner {
  kind: 'render';
  action: 'publish';
  workflowInstanceId: string;
  dispatchGeneration: number;
  renderSetId: string;
  draftId: string;
  nextMasterId: string;
  nextObjectKey: string;
  nextConfig: string;
  manifestSha256: string;
  readyAt: string;
  publishedAt: string;
  receiptExpiresAt: string;
  conflictReceiptExpiresAt: string;
  fenceExpiresAt: string;
  completedProfiles: number;
}

export interface BackfillPublicationOwner {
  kind: 'backfill';
  eventId: string;
  runId: string;
  jobId: string;
  workflowInstanceId: string;
  dispatchGeneration: number;
  expectedRevision: number;
  expectedCurrentKey: string;
  nextConfig: string;
  nextMasterId: string;
  nextObjectKey: string;
  renderSetId: string;
  manifestSha256: string;
  readyAt: string;
  publishedAt: string;
  terminalAt: string;
  referenceReleaseAt: string;
  expiresAt: string;
  fenceExpiresAt: string;
  legacyKeyFingerprint: string;
  retiredAt: string;
  cleanupFloor: string;
}

type CoverReceiptPublicationOwner = SemanticPublicationOwner | RenderPublicationOwner;
type CoverPublicationOwner = CoverReceiptPublicationOwner | BackfillPublicationOwner;

function retainedMasterDeadlineSql(): string {
  return `max(?, COALESCE((
    SELECT max(r.expires_at)
    FROM event_cover_publish_receipts r
    LEFT JOIN event_cover_render_sets referenced_set ON referenced_set.id = r.render_set_id
    LEFT JOIN event_cover_drafts referenced_draft ON referenced_draft.id = r.draft_id
    WHERE r.event_id = ?
      AND (referenced_set.master_id = ? OR referenced_draft.master_id = ?)
  ), ?))`;
}

/**
 * Retires one displaced normalized set and pins both it and its immutable master
 * through the longer of the recovery window and every receipt reference.
 */
export function coverDisplacedUploadRetentionStatements(
  db: D1Database,
  owner: CoverReceiptPublicationOwner,
): D1PreparedStatement[] {
  if (!owner.expectedCurrentRenderSetId || !owner.displacedMasterId || !owner.expectedCurrentKey) {
    return [];
  }
  const deadlineSql = retainedMasterDeadlineSql();
  const deadlineBindings = [
    owner.cleanupFloor,
    owner.eventId,
    owner.displacedMasterId,
    owner.displacedMasterId,
    owner.cleanupFloor,
  ] as const;
  const receiptOwnerSql = owner.kind === 'semantic'
    ? 'r.workflow_instance_id IS NULL AND r.render_set_id IS NULL AND r.draft_id IS NULL'
    : `r.workflow_instance_id = ? AND r.dispatch_generation = ?
        AND r.render_set_id = ? AND r.draft_id = ?`;
  const receiptOwnerBindings = owner.kind === 'semantic'
    ? []
    : [owner.workflowInstanceId, owner.dispatchGeneration, owner.renderSetId, owner.draftId];
  return [
    db.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'retired', retired_at = ?, cleanup_after = ${deadlineSql}
      WHERE id = ? AND event_id = ? AND master_id = ? AND state = 'active'
        AND EXISTS (
          SELECT 1 FROM event_cover_publish_receipts r
          WHERE r.event_id = ? AND r.operation_id = ? AND r.request_sha256 = ?
            AND r.action = ? AND r.expected_revision = ?
            AND r.status = 'applied' AND r.applied_revision = ?
            AND ${receiptOwnerSql}
        )
    `).bind(
      owner.retiredAt,
      ...deadlineBindings,
      owner.expectedCurrentRenderSetId,
      owner.eventId,
      owner.displacedMasterId,
      owner.eventId,
      owner.operationId,
      owner.requestSha256,
      owner.action,
      owner.expectedRevision,
      owner.expectedRevision + 1,
      ...receiptOwnerBindings,
    ),
    db.prepare(`
      UPDATE event_cover_masters
      SET cleanup_after = ${deadlineSql}
      WHERE id = ? AND event_id = ? AND object_key IS ? AND changes() = 1
    `).bind(
      ...deadlineBindings,
      owner.displacedMasterId,
      owner.eventId,
      owner.expectedCurrentKey,
    ),
  ];
}

function backfillPublicationTerminalAssertionStatement(
  db: D1Database,
  owner: BackfillPublicationOwner,
): D1PreparedStatement {
  return db.prepare(`
    UPDATE event_cover_backfill_jobs
    SET status = 'backfill-terminal-assertion-failed'
    WHERE id = ? AND run_id = ? AND event_id = ?
      AND workflow_instance_id = ? AND dispatch_generation = ?
      AND NOT (
        status = 'applied' AND expected_revision = ?
          AND master_id = ? AND render_set_id = ? AND manifest_sha256 = ?
          AND failure_code IS NULL AND retryable = 0
          AND terminal_at = ? AND reference_release_at = ? AND expires_at = ?
          AND EXISTS (
            SELECT 1 FROM events e
            WHERE e.id = event_cover_backfill_jobs.event_id AND e.deleted_at IS NULL
              AND e.cover_revision = ? AND e.cover_config = ?
              AND e.cover_object_key IS ? AND e.cover_render_set_id IS ?
          )
          AND EXISTS (
            SELECT 1 FROM event_cover_render_sets s
            WHERE s.id = event_cover_backfill_jobs.render_set_id
              AND s.event_id = event_cover_backfill_jobs.event_id
              AND s.master_id = event_cover_backfill_jobs.master_id AND s.draft_id IS NULL
              AND s.state = 'active' AND s.manifest_sha256 = ?
              AND s.published_revision = ? AND s.ready_at = ? AND s.published_at = ?
          )
          AND EXISTS (
            SELECT 1 FROM event_cover_retired_legacy_objects legacy
            WHERE legacy.event_id = event_cover_backfill_jobs.event_id
              AND legacy.object_key = ? AND legacy.key_fingerprint = ?
              AND legacy.reason = 'backfilled' AND legacy.retired_at = ?
              AND legacy.cleanup_after = ? AND legacy.deleted_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM event_cover_workflow_fences f
            WHERE f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
              AND f.workflow_instance_id = ? AND f.event_id = ?
              AND f.dispatch_generation = ? AND f.state = 'open' AND f.expires_at = ?
          )
      )
  `).bind(
    owner.jobId,
    owner.runId,
    owner.eventId,
    owner.workflowInstanceId,
    owner.dispatchGeneration,
    owner.expectedRevision,
    owner.nextMasterId,
    owner.renderSetId,
    owner.manifestSha256,
    owner.terminalAt,
    owner.referenceReleaseAt,
    owner.expiresAt,
    owner.expectedRevision + 1,
    owner.nextConfig,
    owner.nextObjectKey,
    owner.renderSetId,
    owner.manifestSha256,
    owner.expectedRevision + 1,
    owner.readyAt,
    owner.publishedAt,
    owner.expectedCurrentKey,
    owner.legacyKeyFingerprint,
    owner.retiredAt,
    owner.cleanupFloor,
    owner.workflowInstanceId,
    owner.eventId,
    owner.dispatchGeneration,
    owner.fenceExpiresAt,
  );
}

function renderPublicationTerminalAssertionStatement(
  db: D1Database,
  owner: RenderPublicationOwner,
): D1PreparedStatement {
  const deadlineSql = retainedMasterDeadlineSql();
  const hasDisplacedUpload = owner.expectedCurrentRenderSetId !== null
    && owner.displacedMasterId !== null
    && owner.expectedCurrentKey !== null;
  return db.prepare(`
    UPDATE event_cover_publish_receipts
    SET status = 'render-publication-terminal-assertion-failed'
    WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
      AND workflow_instance_id = ? AND dispatch_generation = ?
      AND render_set_id = ? AND draft_id = ?
      AND NOT (
        (
          status = 'conflict' AND action = 'publish' AND expected_revision = ?
            AND applied_revision IS NULL AND result_cover_json IS NULL
            AND failure_code IS NULL AND retryable = 0 AND expires_at = ?
            AND EXISTS (
              SELECT 1 FROM event_cover_render_sets s
              WHERE s.id = ? AND s.event_id = event_cover_publish_receipts.event_id
                AND s.master_id = ? AND s.draft_id = event_cover_publish_receipts.draft_id
                AND s.state = 'abandoned' AND s.manifest_sha256 = ? AND s.ready_at = ?
                AND s.published_revision IS NULL AND s.published_at IS NULL
                AND s.abandoned_reason = 'revision-conflict'
                AND s.abandoned_at = ? AND s.cleanup_after = ?
            )
            AND EXISTS (
              SELECT 1 FROM event_cover_drafts d
              WHERE d.id = ? AND d.event_id = event_cover_publish_receipts.event_id
                AND d.state = 'ready'
            )
            AND EXISTS (
              SELECT 1 FROM event_cover_workflow_fences f
              WHERE f.workflow_binding = 'COVER_RENDER_WORKFLOW'
                AND f.workflow_instance_id = ? AND f.event_id = ?
                AND f.dispatch_generation = ? AND f.state = 'open' AND f.expires_at = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM events e
              WHERE e.id = ? AND e.cover_revision = ?
                AND e.cover_object_key IS ? AND e.cover_render_set_id IS ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM event_cover_retired_legacy_objects legacy
              WHERE legacy.event_id = ? AND legacy.object_key IS ? AND legacy.retired_at = ?
            )
        )
        OR (
          status = 'applied' AND action = 'publish' AND expected_revision = ?
            AND applied_revision = ? AND result_cover_json = ?
            AND completed_profiles = ? AND required_profiles = ?
            AND failure_code IS NULL AND retryable = 0
            AND expires_at = ?
            AND workflow_instance_id = ? AND dispatch_generation = ?
            AND render_set_id = ? AND draft_id = ?
            AND EXISTS (
              SELECT 1 FROM events e
              WHERE e.id = ? AND e.deleted_at IS NULL AND e.cover_revision = ?
                AND e.cover_config = ? AND e.cover_object_key IS ? AND e.cover_render_set_id IS ?
            )
            AND EXISTS (
              SELECT 1 FROM event_cover_render_sets s
              WHERE s.id = ? AND s.event_id = event_cover_publish_receipts.event_id
                AND s.master_id = ? AND s.draft_id = event_cover_publish_receipts.draft_id
                AND s.state = 'active' AND s.manifest_sha256 = ?
                AND s.published_revision = ? AND s.ready_at = ? AND s.published_at = ?
            )
            AND EXISTS (
              SELECT 1 FROM event_cover_drafts d
              WHERE d.id = ? AND d.event_id = event_cover_publish_receipts.event_id
                AND d.state = 'published'
            )
            AND EXISTS (
              SELECT 1 FROM event_cover_workflow_fences f
              WHERE f.workflow_binding = 'COVER_RENDER_WORKFLOW'
                AND f.workflow_instance_id = ? AND f.event_id = ?
                AND f.dispatch_generation = ? AND f.state = 'open' AND f.expires_at = ?
            )
            AND (
              ? = 0 OR (
                EXISTS (
                  SELECT 1 FROM event_cover_render_sets displaced
                  WHERE displaced.id = ? AND displaced.event_id = event_cover_publish_receipts.event_id
                    AND displaced.master_id = ? AND displaced.state = 'retired'
                    AND displaced.retired_at = ? AND displaced.cleanup_after = ${deadlineSql}
                )
                AND EXISTS (
                  SELECT 1 FROM event_cover_masters m
                  WHERE m.id = ? AND m.event_id = event_cover_publish_receipts.event_id
                    AND m.object_key IS ? AND m.cleanup_after = ${deadlineSql}
                )
                AND NOT EXISTS (
                  SELECT 1 FROM event_cover_retired_legacy_objects legacy
                  WHERE legacy.event_id = event_cover_publish_receipts.event_id
                    AND legacy.object_key IS ?
                )
              )
            )
            AND (
              ? IS NULL OR ? IS NOT NULL OR EXISTS (
                SELECT 1 FROM event_cover_retired_legacy_objects legacy
                WHERE legacy.event_id = ? AND legacy.object_key IS ?
                  AND legacy.key_fingerprint = ? AND legacy.reason = 'replaced'
                  AND legacy.retired_at = ? AND legacy.cleanup_after = ?
              )
            )
        )
      )
  `).bind(
    owner.eventId,
    owner.operationId,
    owner.requestSha256,
    owner.workflowInstanceId,
    owner.dispatchGeneration,
    owner.renderSetId,
    owner.draftId,
    owner.expectedRevision,
    owner.conflictReceiptExpiresAt,
    owner.renderSetId,
    owner.nextMasterId,
    owner.manifestSha256,
    owner.readyAt,
    owner.retiredAt,
    owner.cleanupFloor,
    owner.draftId,
    owner.workflowInstanceId,
    owner.eventId,
    owner.dispatchGeneration,
    owner.fenceExpiresAt,
    owner.eventId,
    owner.expectedRevision + 1,
    owner.nextObjectKey,
    owner.renderSetId,
    owner.eventId,
    owner.expectedCurrentKey,
    owner.retiredAt,
    owner.expectedRevision,
    owner.expectedRevision + 1,
    owner.nextConfig,
    owner.completedProfiles,
    owner.completedProfiles,
    owner.receiptExpiresAt,
    owner.workflowInstanceId,
    owner.dispatchGeneration,
    owner.renderSetId,
    owner.draftId,
    owner.eventId,
    owner.expectedRevision + 1,
    owner.nextConfig,
    owner.nextObjectKey,
    owner.renderSetId,
    owner.renderSetId,
    owner.nextMasterId,
    owner.manifestSha256,
    owner.expectedRevision + 1,
    owner.readyAt,
    owner.publishedAt,
    owner.draftId,
    owner.workflowInstanceId,
    owner.eventId,
    owner.dispatchGeneration,
    owner.fenceExpiresAt,
    hasDisplacedUpload ? 1 : 0,
    owner.expectedCurrentRenderSetId,
    owner.displacedMasterId,
    owner.retiredAt,
    owner.cleanupFloor,
    owner.eventId,
    owner.displacedMasterId,
    owner.displacedMasterId,
    owner.cleanupFloor,
    owner.displacedMasterId,
    owner.expectedCurrentKey,
    owner.cleanupFloor,
    owner.eventId,
    owner.displacedMasterId,
    owner.displacedMasterId,
    owner.cleanupFloor,
    owner.expectedCurrentKey,
    owner.expectedCurrentKey,
    owner.expectedCurrentRenderSetId,
    owner.eventId,
    owner.expectedCurrentKey,
    owner.retiredKeyFingerprint,
    owner.retiredAt,
    owner.cleanupFloor,
  );
}

/**
 * Makes an incomplete publication terminal graph violate the existing receipt
 * status CHECK, which is the D1 error that rolls every earlier batch statement
 * back. The invalid value can never commit.
 */
export function coverPublicationTerminalAssertionStatement(
  db: D1Database,
  owner: CoverPublicationOwner,
): D1PreparedStatement {
  if (owner.kind === 'backfill') return backfillPublicationTerminalAssertionStatement(db, owner);
  if (owner.kind === 'render') return renderPublicationTerminalAssertionStatement(db, owner);
  const deadlineSql = retainedMasterDeadlineSql();
  const hasDisplacedUpload = owner.expectedCurrentRenderSetId !== null
    && owner.displacedMasterId !== null
    && owner.expectedCurrentKey !== null;
  return db.prepare(`
    UPDATE event_cover_publish_receipts
    SET status = 'semantic-publication-terminal-assertion-failed'
    WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
      AND NOT (
        (
          status = 'conflict' AND action = ? AND expected_revision = ?
            AND applied_revision IS NULL AND result_cover_json IS NULL
            AND workflow_instance_id IS NULL AND render_set_id IS NULL AND draft_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM events e
              WHERE e.id = event_cover_publish_receipts.event_id
                AND e.deleted_at IS NULL AND e.cover_revision = ?
                AND e.cover_object_key IS ? AND e.cover_render_set_id IS ?
            )
        )
        OR (
          status = 'applied' AND action = ? AND expected_revision = ?
            AND applied_revision = ? AND result_cover_json = ?
            AND workflow_instance_id IS NULL AND render_set_id IS NULL AND draft_id IS NULL
            AND EXISTS (
              SELECT 1 FROM events e
              WHERE e.id = event_cover_publish_receipts.event_id
                AND e.deleted_at IS NULL AND e.cover_revision = ?
                AND e.cover_config = ? AND e.cover_object_key IS NULL
                AND e.cover_render_set_id IS NULL
            )
            AND (
              ? = 0 OR (
                EXISTS (
                  SELECT 1 FROM event_cover_render_sets s
                  WHERE s.id = ? AND s.event_id = event_cover_publish_receipts.event_id
                    AND s.master_id = ? AND s.state = 'retired'
                    AND s.retired_at = ? AND s.cleanup_after = ${deadlineSql}
                )
                AND EXISTS (
                  SELECT 1 FROM event_cover_masters m
                  WHERE m.id = ? AND m.event_id = event_cover_publish_receipts.event_id
                    AND m.object_key IS ? AND m.cleanup_after = ${deadlineSql}
                )
                AND NOT EXISTS (
                  SELECT 1 FROM event_cover_retired_legacy_objects legacy
                  WHERE legacy.event_id = event_cover_publish_receipts.event_id
                    AND legacy.object_key IS ?
                )
              )
            )
            AND (
              ? IS NULL OR ? IS NOT NULL OR EXISTS (
                SELECT 1 FROM event_cover_retired_legacy_objects legacy
                WHERE legacy.event_id = event_cover_publish_receipts.event_id
                  AND legacy.object_key IS ? AND legacy.key_fingerprint = ?
                  AND legacy.reason = ? AND legacy.retired_at = ?
                  AND legacy.cleanup_after = ?
              )
            )
        )
      )
  `).bind(
    owner.eventId,
    owner.operationId,
    owner.requestSha256,
    owner.action,
    owner.expectedRevision,
    owner.expectedRevision,
    owner.expectedCurrentKey,
    owner.expectedCurrentRenderSetId,
    owner.action,
    owner.expectedRevision,
    owner.expectedRevision + 1,
    owner.nextConfig,
    owner.expectedRevision + 1,
    owner.nextConfig,
    hasDisplacedUpload ? 1 : 0,
    owner.expectedCurrentRenderSetId,
    owner.displacedMasterId,
    owner.retiredAt,
    owner.cleanupFloor,
    owner.eventId,
    owner.displacedMasterId,
    owner.displacedMasterId,
    owner.cleanupFloor,
    owner.displacedMasterId,
    owner.expectedCurrentKey,
    owner.cleanupFloor,
    owner.eventId,
    owner.displacedMasterId,
    owner.displacedMasterId,
    owner.cleanupFloor,
    owner.expectedCurrentKey,
    owner.expectedCurrentKey,
    owner.expectedCurrentRenderSetId,
    owner.expectedCurrentKey,
    owner.retiredKeyFingerprint,
    owner.action === 'remove' ? 'removed' : 'replaced',
    owner.retiredAt,
    owner.cleanupFloor,
  );
}

async function loadCurrentEvent(env: AppEnv, eventId: string): Promise<EventRecord> {
  const event = await new EventsRepository(env.DB).getById(eventId);
  if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
  return event;
}

function semanticOutcome(receipt: CoverPublishReceiptRow, event: EventRecord): CoverPublicationOutcome {
  return {
    applied: receipt.status === 'applied',
    appliedRevision: receipt.applied_revision,
    receipt,
    view: preparationView(receipt),
    event,
  };
}

/** Applies a preset or removal, including its receipt, in one strict D1 batch. */
export async function applySemanticCoverPublication(
  env: AppEnv,
  input: AcceptContext,
): Promise<CoverPublicationOutcome> {
  const { event, request, requestDigest, now } = input;
  if ('focus' in request) {
    throw new Error('Uploaded covers require CoverRenderWorkflow publication.');
  }
  const action = request.source.kind === 'none' ? 'remove' : 'publish';
  const nextConfig = canonicalCoverConfig(publishedConfig(request));
  const existing = await loadReceipt(env, event.id, request.operationId);
  if (existing) {
    if (existing.request_sha256 !== requestDigest || existing.action !== action
      || existing.expected_revision !== request.expectedRevision) {
      throw new ApiError(
        'COVER_PUBLICATION_CONFLICT',
        'That publish was already used with different details. Reload and try again.',
        409,
      );
    }
    if (terminalReceiptStatus(existing)) {
      return semanticOutcome(existing, await loadCurrentEvent(env, event.id));
    }
  } else {
    await chargeCoverRateEvent(env.DB, {
      eventId: event.id,
      action: 'publication',
      replayKey: request.operationId,
      requestDigest,
      limit: MAX_COVER_PUBLICATIONS_PER_HOUR,
      now,
    });
    await assertStorageCaps(env, event.id);
  }

  const displaced = event.coverRenderSetId
    ? await env.DB.prepare(`
        SELECT s.master_id, m.object_key
        FROM event_cover_render_sets s
        JOIN event_cover_masters m ON m.id = s.master_id AND m.event_id = s.event_id
        WHERE s.id = ? AND s.event_id = ? AND m.object_key IS ?
      `).bind(event.coverRenderSetId, event.id, event.coverObjectKey)
        .first<{ master_id: string; object_key: string }>()
    : null;
  if (event.coverRenderSetId && !displaced) {
    throw new Error('The active uploaded cover graph is incomplete.');
  }
  const timestamp = now.toISOString();
  const cleanupFloor = new Date(now.getTime() + RETIRED_RECOVERY_MS).toISOString();
  const owner: SemanticPublicationOwner = {
    kind: 'semantic',
    eventId: event.id,
    operationId: request.operationId,
    requestSha256: requestDigest,
    action,
    expectedRevision: request.expectedRevision,
    expectedCurrentKey: event.coverObjectKey,
    expectedCurrentRenderSetId: event.coverRenderSetId,
    displacedMasterId: displaced?.master_id ?? null,
    nextConfig,
    retiredAt: timestamp,
    cleanupFloor,
    retiredKeyFingerprint: event.coverObjectKey
      ? await coverKeyFingerprint(event.coverObjectKey)
      : '0'.repeat(64),
  };
  const [movePointer, retireLegacy] = coverPointerStatements(env.DB, {
    eventId: event.id,
    expectedRevision: request.expectedRevision,
    expectedCurrentKey: event.coverObjectKey,
    expectedCurrentRenderSetId: event.coverRenderSetId,
    nextConfig,
    nextObjectKey: null,
    nextRenderSetId: null,
    retiredAt: timestamp,
    cleanupAfter: cleanupFloor,
    retiredKeyFingerprint: owner.retiredKeyFingerprint,
    semanticPublicationGuard: {
      action,
      operationId: request.operationId,
      requestSha256: requestDigest,
      expectedRevision: request.expectedRevision,
    },
    onlyIfPriorStatementChanged: true,
  });
  const statements: D1PreparedStatement[] = [];
  if (!existing) {
    statements.push(env.DB.prepare(`
      INSERT INTO event_cover_publish_receipts (
        event_id, operation_id, draft_id, render_set_id, request_sha256, action,
        expected_revision, status, workflow_instance_id, dependency_versions_json,
        completed_profiles, required_profiles, failure_code, retryable,
        dispatch_state, dispatch_generation, created_at, updated_at, expires_at
      )
      SELECT ?, ?, NULL, NULL, ?, ?, ?, 'queued', NULL, ?, 0, 0, NULL, 0,
        'pending', 0, ?, ?, ?
      FROM events e WHERE e.id = ? AND e.deleted_at IS NULL
        AND (SELECT count(*) FROM event_cover_publish_receipts r WHERE r.event_id = e.id) < ?
        AND (SELECT count(*) FROM event_cover_render_sets s
          WHERE s.event_id = e.id AND s.state <> 'active') < ?
    `).bind(
      event.id,
      request.operationId,
      requestDigest,
      action,
      request.expectedRevision,
      JSON.stringify(COVER_PIPELINE_VERSIONS),
      timestamp,
      timestamp,
      new Date(now.getTime() + RECEIPT_APPLIED_TTL_MS).toISOString(),
      event.id,
      MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
      MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
    ));
  }
  statements.push(
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'applied', applied_revision = ?, result_cover_json = ?, updated_at = ?,
          dispatch_state = 'confirmed', expires_at = ?
      WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
        AND action = ? AND expected_revision = ? AND status = 'queued' AND retryable = 0
        AND workflow_instance_id IS NULL AND render_set_id IS NULL AND draft_id IS NULL
        AND dispatch_state = 'pending' AND dispatch_generation = 0
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.id = event_cover_publish_receipts.event_id AND e.deleted_at IS NULL
            AND e.cover_revision = ? AND e.cover_object_key IS ? AND e.cover_render_set_id IS ?
        )
        ${existing ? '' : 'AND changes() = 1'}
    `).bind(
      request.expectedRevision + 1,
      nextConfig,
      timestamp,
      new Date(now.getTime() + RECEIPT_APPLIED_TTL_MS).toISOString(),
      event.id,
      request.operationId,
      requestDigest,
      action,
      request.expectedRevision,
      request.expectedRevision,
      event.coverObjectKey,
      event.coverRenderSetId,
    ),
    movePointer!,
    retireLegacy!,
    ...coverDisplacedUploadRetentionStatements(env.DB, owner),
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'conflict', retryable = 0, updated_at = ?, expires_at = ?
      WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
        AND action = ? AND expected_revision = ? AND status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.id = event_cover_publish_receipts.event_id
            AND e.deleted_at IS NULL AND e.cover_revision = ?
            AND e.cover_object_key IS ? AND e.cover_render_set_id IS ?
        )
    `).bind(
      timestamp,
      new Date(now.getTime() + RECEIPT_TERMINAL_TTL_MS).toISOString(),
      event.id,
      request.operationId,
      requestDigest,
      action,
      request.expectedRevision,
      request.expectedRevision,
      event.coverObjectKey,
      event.coverRenderSetId,
    ),
    coverPublicationTerminalAssertionStatement(env.DB, owner),
  );

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await loadReceipt(env, event.id, request.operationId);
    if (raced && raced.request_sha256 === requestDigest && terminalReceiptStatus(raced)) {
      return semanticOutcome(raced, await loadCurrentEvent(env, event.id));
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
  const receipt = await loadReceipt(env, event.id, request.operationId);
  if (!receipt) {
    await assertStorageCaps(env, event.id);
    throw new ApiError(
      'COVER_PUBLICATION_CONFLICT',
      'Another cover change is already being prepared for this event. Wait for it to finish.',
      409,
    );
  }
  return semanticOutcome(receipt, await loadCurrentEvent(env, event.id));
}

/** Compatibility wrapper for callers that already accepted a `none` request. */
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
  return applySemanticCoverPublication(env, {
    event: input.event,
    request: {
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      source: { kind: 'none' },
    },
    requestDigest: input.requestDigest,
    now: input.now,
  });
}

/**
 * Resolves a revision lost before an initial or recovery platform call.
 *
 * Callers invoke this only when the exact initial generation never earned
 * `create()`, or a fresh lookup proved the retained instance terminal/absent.
 * The receipt, staging set, draft, and terminal fence proof move as one guarded
 * unit; a later replay observes conflict instead of reviving stale work.
 */
async function settleCoverDispatchRevisionConflict(
  env: AppEnv,
  input: { eventId: string; operationId: string; workflowInstanceId: string },
  receipt: CoverPublishReceiptRow,
): Promise<boolean> {
  if (!receipt.draft_id || !receipt.render_set_id) return false;
  const settled = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'conflict', retryable = 0, failure_code = NULL,
          render_set_id = NULL,
          updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL},
          expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')
      WHERE event_id = ? AND operation_id = ? AND workflow_instance_id = ?
        AND draft_id = ? AND render_set_id = ?
        AND status = ? AND retryable = ?
        AND dispatch_state = ? AND dispatch_generation = ?
        AND status NOT IN ('applied', 'conflict')
        AND (status <> 'failed' OR retryable = 1)
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.id = event_cover_publish_receipts.event_id AND e.deleted_at IS NULL
            AND e.cover_revision <> event_cover_publish_receipts.expected_revision
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_drafts d
          WHERE d.id = event_cover_publish_receipts.draft_id
            AND d.event_id = event_cover_publish_receipts.event_id
            AND d.state = 'publishing'
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          WHERE s.id = event_cover_publish_receipts.render_set_id
            AND s.event_id = event_cover_publish_receipts.event_id
            AND s.draft_id = event_cover_publish_receipts.draft_id
            AND s.state IN ('staging', 'ready')
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ? AND f.workflow_instance_id = ?
            AND f.event_id = ? AND f.state = 'open' AND f.dispatch_generation = ?
        )
    `).bind(
      input.eventId, input.operationId, input.workflowInstanceId,
      receipt.draft_id, receipt.render_set_id,
      receipt.status, receipt.retryable, receipt.dispatch_state, receipt.dispatch_generation,
      COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId,
      receipt.dispatch_generation,
    ),
    env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'abandoned', abandoned_reason = 'revision-conflict',
          abandoned_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL},
          cleanup_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+7 days')
      WHERE id = ? AND event_id = ? AND draft_id = ? AND state IN ('staging', 'ready')
        AND changes() = 1
    `).bind(receipt.render_set_id, input.eventId, receipt.draft_id),
    env.DB.prepare(`
      UPDATE event_cover_drafts
      SET state = 'ready', draft_revision = draft_revision + 1,
          updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      WHERE id = ? AND event_id = ? AND state = 'publishing' AND changes() = 1
    `).bind(receipt.draft_id, input.eventId),
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET updated_at = (
            SELECT r.updated_at FROM event_cover_publish_receipts r
            WHERE r.event_id = ? AND r.operation_id = ?
          ),
          expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', (
            SELECT r.updated_at FROM event_cover_publish_receipts r
            WHERE r.event_id = ? AND r.operation_id = ?
          ), '+31 days')
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
        AND state = 'open' AND dispatch_generation = ? AND changes() = 1
    `).bind(
      input.eventId, input.operationId,
      input.eventId, input.operationId,
      COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId,
      receipt.dispatch_generation,
    ),
  ]);
  return settled.every((result) => (result.meta.changes ?? 0) === 1);
}

/**
 * Claims the one instance whose source revision has already lost and whose
 * platform lifecycle must be stopped before D1 can settle it.
 *
 * A paused Workflow cannot reach its own conflict finalizer, and a stale
 * creating/resuming/restarting host may still issue its already-authorized
 * lifecycle call. Settling D1 first would let that late call outlive terminal
 * proof. Move the exact receipt and fence generation together first; only that
 * caller may then terminate, freshly observe terminal state, and record the
 * conflict.
 */
async function claimRevisionConflictTermination(
  env: AppEnv,
  input: { eventId: string; operationId: string; workflowInstanceId: string },
  receipt: CoverPublishReceiptRow,
  claimState: 'resuming' | 'restarting',
): Promise<CoverPublishReceiptRow | null> {
  if (!receipt.draft_id || !receipt.render_set_id) return null;
  const dispatchGeneration = receipt.dispatch_generation + 1;
  const claimed = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET dispatch_state = ?, dispatch_generation = ?,
          last_dispatch_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL},
          updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      WHERE event_id = ? AND operation_id = ? AND workflow_instance_id = ?
        AND draft_id = ? AND render_set_id = ?
        AND status = ? AND retryable = ?
        AND dispatch_state = ? AND dispatch_generation = ?
        AND (
          status IN ('queued', 'rendering', 'finalizing')
          OR (status = 'failed' AND retryable = 1)
        )
        AND (
          dispatch_state NOT IN ('creating', 'resuming', 'restarting')
          OR (last_dispatch_at IS NOT NULL AND last_dispatch_at <=
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'))
        )
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.id = event_cover_publish_receipts.event_id AND e.deleted_at IS NULL
            AND e.cover_revision <> event_cover_publish_receipts.expected_revision
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_drafts d
          WHERE d.id = event_cover_publish_receipts.draft_id
            AND d.event_id = event_cover_publish_receipts.event_id
            AND d.state = 'publishing'
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          WHERE s.id = event_cover_publish_receipts.render_set_id
            AND s.event_id = event_cover_publish_receipts.event_id
            AND s.draft_id = event_cover_publish_receipts.draft_id
            AND s.state IN ('staging', 'ready')
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ? AND f.workflow_instance_id = ?
            AND f.event_id = ? AND f.state = 'open'
            AND f.dispatch_generation = event_cover_publish_receipts.dispatch_generation
        )
    `).bind(
      claimState, dispatchGeneration,
      input.eventId, input.operationId, input.workflowInstanceId,
      receipt.draft_id, receipt.render_set_id,
      receipt.status, receipt.retryable,
      receipt.dispatch_state, receipt.dispatch_generation,
      COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId,
    ),
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET dispatch_generation = ?, expires_at = ?,
          updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
        AND state = 'open' AND dispatch_generation = ? AND changes() = 1
    `).bind(
      dispatchGeneration, COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId,
      receipt.dispatch_generation,
    ),
  ]);
  if ((claimed[0]?.meta.changes ?? 0) !== 1 || (claimed[1]?.meta.changes ?? 0) !== 1) {
    return null;
  }
  const current = await loadReceipt(env, input.eventId, input.operationId);
  return current?.workflow_instance_id === input.workflowInstanceId
    && current.dispatch_state === claimState
    && current.dispatch_generation === dispatchGeneration
    ? current
    : null;
}

async function terminateRevisionConflict(
  env: AppEnv,
  input: { eventId: string; operationId: string; workflowInstanceId: string },
  receipt: CoverPublishReceiptRow,
  accessor: CoverWorkflowAccessor,
): Promise<CoverPublicationRestartResult> {
  try {
    await accessor.terminate(input.workflowInstanceId);
  } catch {
    // A rejected call may still have reached the platform. The fresh lookup
    // below, never the thrown result, decides whether terminal proof exists.
  }
  const observed = await lookupDisposition(accessor, input.workflowInstanceId);
  const terminal = observed.kind === 'complete'
    || observed.kind === 'missing'
    || observed.recovery === 'restart';
  if (terminal && await settleCoverDispatchRevisionConflict(env, input, receipt)) {
    const current = await loadReceipt(env, input.eventId, input.operationId);
    if (current) return terminalRestartResult(current);
  }
  const current = await loadReceipt(env, input.eventId, input.operationId);
  if (current && terminalReceiptStatus(current)) return terminalRestartResult(current);
  if (observed.kind === 'complete' && current?.status === 'failed') {
    return terminalRestartResult(current);
  }
  const platformKnown = observed.kind !== 'unknown'
    && observed.telemetry !== 'cover_platform_unmapped';
  const youngClaim = current?.workflow_instance_id === input.workflowInstanceId
    && await hasYoungExactDispatchClaim(env, input);
  if (youngClaim && platformKnown) {
    return {
      status: 'active',
      view: activePreparationView(current),
      retryAfterSeconds: 2,
    };
  }
  return {
    status: 'unavailable',
    view: current ? preparationView(current) : null,
    retryAfterSeconds: 5,
  };
}

/**
 * Claims the one permitted initial create before touching the Workflow binding.
 *
 * The receipt and fence move from generation zero together. A replay that sees
 * a live claim, a failure, or a confirmed dispatch cannot call `create()` again;
 * only the exact `pending` receipt and its exact open fence earn that mutation.
 */
export async function claimInitialCoverDispatch(
  env: AppEnv,
  input: {
    eventId: string;
    operationId: string;
    workflowInstanceId: string;
  },
): Promise<InitialCoverDispatchClaim> {
  const dispatchGeneration = 1;
  const claimed = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET dispatch_state = 'creating', dispatch_generation = ?,
          last_dispatch_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL},
          updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      WHERE event_id = ? AND operation_id = ? AND workflow_instance_id = ?
        AND status = 'queued' AND dispatch_state = 'pending' AND dispatch_generation = 0
        AND EXISTS (
          SELECT 1 FROM events
          WHERE id = ? AND deleted_at IS NULL AND cover_revision = expected_revision
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ? AND f.workflow_instance_id = ?
            AND f.event_id = ? AND f.state = 'open' AND f.dispatch_generation = 0
        )
    `).bind(
      dispatchGeneration,
      input.eventId, input.operationId, input.workflowInstanceId,
      input.eventId,
      COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId,
    ),
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET dispatch_generation = ?, updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
        AND state = 'open' AND dispatch_generation = 0 AND changes() = 1
    `).bind(
      dispatchGeneration,
      COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId,
    ),
  ]);

  if ((claimed[0]?.meta.changes ?? 0) === 1 && (claimed[1]?.meta.changes ?? 0) === 1) {
    return { kind: 'claimed', dispatchGeneration };
  }

  const [current, fence] = await Promise.all([
    loadReceipt(env, input.eventId, input.operationId),
    env.DB.prepare(`
      SELECT state, dispatch_generation FROM event_cover_workflow_fences
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
    `).bind(COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId)
      .first<{ state: string; dispatch_generation: number }>(),
  ]);
  if (current?.workflow_instance_id === input.workflowInstanceId
    && current.status === 'queued'
    && current.dispatch_state === 'pending'
    && current.dispatch_generation === 0
    && await settleCoverDispatchRevisionConflict(env, input, current)) {
    return { kind: 'unavailable' };
  }
  if (current?.workflow_instance_id === input.workflowInstanceId
    && current.dispatch_state === 'confirmed'
    && ['queued', 'rendering', 'finalizing', 'applied'].includes(current.status)
    && fence?.state === 'open'
    && fence.dispatch_generation === current.dispatch_generation) {
    return { kind: 'confirmed' };
  }
  if (current?.workflow_instance_id === input.workflowInstanceId
    && ['queued', 'rendering', 'finalizing'].includes(current.status)
    && ['creating', 'resuming', 'restarting'].includes(current.dispatch_state)
    && fence?.state === 'open'
    && fence.dispatch_generation === current.dispatch_generation) {
    const young = await hasYoungExactDispatchClaim(env, input);
    return {
      kind: young ? 'in-flight' : 'stale',
      dispatchGeneration: current.dispatch_generation,
    };
  }
  return { kind: 'unavailable' };
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
  if (terminalReceiptStatus(receipt)) return terminalRestartResult(receipt);
  if (!receipt.workflow_instance_id) {
    return { status: 'ineligible', view: preparationView(receipt), retryAfterSeconds: null };
  }

  // Outside its restart window a retryable failure is no longer recoverable;
  // the host needs a corrected draft and a new operation.
  const restartExpiresAt = Date.parse(receipt.expires_at);
  if (receipt.status === 'failed'
    && (!Number.isFinite(restartExpiresAt) || input.now.getTime() >= restartExpiresAt)) {
    return { status: 'ineligible', view: preparationView(receipt), retryAfterSeconds: null };
  }

  const accessor = input.workflow ?? defaultCoverWorkflowAccessor(env);
  // A failed lookup is `unknown`, not absence: it must not satisfy any
  // mutation predicate, and it must not be reported as a failure either.
  const disposition = await lookupDisposition(accessor, receipt.workflow_instance_id);
  const materializeAfterFailedLookup = disposition.kind === 'unknown'
    && disposition.telemetry === 'cover_platform_lookup_failed';
  // The lookup can overlap a Workflow or another recovery writer. Re-read once
  // before interpreting its platform evidence so every terminal D1 winner is
  // returned exactly and stale evidence never mutates a newer generation.
  const afterLookup = await loadReceipt(env, input.eventId, input.operationId);
  if (!afterLookup) return { status: 'ineligible', view: null, retryAfterSeconds: null };
  if (terminalReceiptStatus(afterLookup)) return terminalRestartResult(afterLookup);
  // A completed platform instance cannot supersede either kind of already
  // recorded D1 failure. The retained failed result wins without reopening it.
  if (disposition.kind === 'complete' && afterLookup.status === 'failed') {
    return terminalRestartResult(afterLookup);
  }
  const platformActive = disposition.kind === 'active' && disposition.telemetry === null;
  const platformKnown = platformDispositionIsKnown(disposition);
  const observedClaimState = ['creating', 'resuming', 'restarting']
    .includes(afterLookup.dispatch_state)
    ? afterLookup.dispatch_state as CoverDispatchClaimState
    : null;
  const youngExactClaim = observedClaimState !== null
    && await hasYoungExactDispatchClaim(env, {
      eventId: input.eventId,
      operationId: input.operationId,
      workflowInstanceId: afterLookup.workflow_instance_id!,
    });
  if (!sameRecoverySnapshot(receipt, afterLookup)) {
    const freshOwner = await recoveryResultAfterLostOwnership(env, {
      eventId: input.eventId,
      operationId: input.operationId,
      workflowInstanceId: receipt.workflow_instance_id,
    }, disposition);
    if (freshOwner) return freshOwner;
    return {
      status: 'unavailable',
      view: preparationView(afterLookup),
      retryAfterSeconds: 5,
    };
  }
  if (youngExactClaim) {
    if (platformKnown) {
      return {
        status: 'active',
        view: activePreparationView(afterLookup),
        retryAfterSeconds: 2,
      };
    }
    return {
      status: 'unavailable',
      view: preparationView(afterLookup),
      retryAfterSeconds: 5,
    };
  }
  if (!disposition.mutates && !materializeAfterFailedLookup) {
    // Active, unknown, and unrecognized states all preserve D1 and ask the
    // caller to poll. None is evidence that this operation has become
    // permanently ineligible.
    if (platformActive
      && observedClaimState
      && afterLookup.status !== 'failed') {
      const confirmed = await confirmCoverDispatch(env, {
        eventId: input.eventId,
        operationId: input.operationId,
        workflowInstanceId: receipt.workflow_instance_id,
        dispatchGeneration: afterLookup.dispatch_generation,
        from: observedClaimState,
        now: input.now,
        workflow: accessor,
      });
      const current = await loadReceipt(env, input.eventId, input.operationId);
      if (!current) {
        return { status: 'ineligible', view: null, retryAfterSeconds: null };
      }
      if (terminalReceiptStatus(current)) return terminalRestartResult(current);
      if (!confirmed) {
        return {
          status: 'unavailable',
          view: preparationView(current),
          retryAfterSeconds: 5,
        };
      }
      return {
        status: 'active',
        view: activePreparationView(current),
        retryAfterSeconds: 2,
      };
    }
    return {
      status: platformActive ? 'active' : 'unavailable',
      view: platformActive ? activePreparationView(afterLookup) : preparationView(afterLookup),
      retryAfterSeconds: platformActive ? 2 : 5,
    };
  }

  const claimState: CoverDispatchClaimState = disposition.recovery === 'resume'
    ? 'resuming'
    : disposition.recovery === 'create' || materializeAfterFailedLookup
      ? 'creating'
      : 'restarting';
  const previousGeneration = receipt.dispatch_generation;
  const dispatchGeneration = previousGeneration + 1;
  const claimed = await env.DB.batch([
    // One guarded transaction: persist the mapped failure if D1 was still
    // nonterminal, and claim the recovery edge, so recovery never waits for the
    // daily sweep. Rechecks the revision and the one-preparation cap.
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'queued', retryable = 1, failure_code = NULL,
          dispatch_state = ?, dispatch_generation = ?,
          last_dispatch_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL},
          updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      WHERE event_id = ? AND operation_id = ? AND workflow_instance_id = ?
        AND dispatch_state = ? AND dispatch_generation = ?
        AND status = ? AND retryable = ?
        AND (
          dispatch_state NOT IN ('creating', 'resuming', 'restarting')
          OR (last_dispatch_at IS NOT NULL AND last_dispatch_at <=
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'))
        )
        AND status IN ('queued', 'rendering', 'finalizing', 'failed')
        AND (status <> 'failed' OR retryable = 1)
        AND (status <> 'failed' OR expires_at > ${DISPATCH_CLAIM_APPLIED_AT_SQL})
        AND EXISTS (
          SELECT 1 FROM events
          WHERE id = ? AND deleted_at IS NULL AND cover_revision = expected_revision
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ? AND f.workflow_instance_id = ?
            AND f.event_id = ? AND f.state = 'open'
            AND f.dispatch_generation = event_cover_publish_receipts.dispatch_generation
        )
        AND (
          SELECT count(*) FROM event_cover_publish_receipts retained
          WHERE retained.event_id = event_cover_publish_receipts.event_id
        ) <= ?
        AND (
          SELECT count(*) FROM event_cover_render_sets retained_set
          WHERE retained_set.event_id = event_cover_publish_receipts.event_id
            AND retained_set.state <> 'active'
        ) <= ?
    `).bind(
      claimState, dispatchGeneration,
      input.eventId, input.operationId, receipt.workflow_instance_id,
      receipt.dispatch_state, previousGeneration,
      receipt.status, receipt.retryable,
      input.eventId,
      COVER_RENDER_BINDING, receipt.workflow_instance_id, input.eventId,
      MAX_RETAINED_COVER_RECEIPTS_PER_EVENT,
      MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT,
    ),
    // The fence must still be open. If deletion won the race it is
    // `deletion-blocked`, and this claim changes nothing.
    env.DB.prepare(`
      UPDATE event_cover_workflow_fences
      SET dispatch_generation = ?, expires_at = ?,
          updated_at = ${DISPATCH_CLAIM_APPLIED_AT_SQL}
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
        AND state = 'open' AND dispatch_generation = ? AND changes() = 1
    `).bind(
      dispatchGeneration,
      COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT,
      COVER_RENDER_BINDING,
      receipt.workflow_instance_id,
      input.eventId,
      previousGeneration,
    ),
  ]);

  if ((claimed[0]?.meta.changes ?? 0) !== 1 || (claimed[1]?.meta.changes ?? 0) !== 1) {
    const current = await loadReceipt(env, input.eventId, input.operationId);
    if (current && terminalReceiptStatus(current)) return terminalRestartResult(current);
    if (disposition.kind === 'complete' && current?.status === 'failed') {
      return terminalRestartResult(current);
    }
    // A retained exact claim is stronger evidence than a revision mismatch:
    // another caller may already be between its D1 claim and platform call.
    // Do not use this caller's older lookup to settle that newer generation.
    const youngClaim = current?.workflow_instance_id === receipt.workflow_instance_id
      && await hasYoungExactDispatchClaim(env, {
        eventId: input.eventId,
        operationId: input.operationId,
        workflowInstanceId: receipt.workflow_instance_id,
      });
    if (youngClaim) {
      if (platformKnown) {
        return {
          status: 'active',
          view: activePreparationView(current),
          retryAfterSeconds: 2,
        };
      }
      return {
        status: 'unavailable',
        view: preparationView(current),
        retryAfterSeconds: 5,
      };
    }
    const observedActiveClaim = ['creating', 'resuming', 'restarting']
      .includes(receipt.dispatch_state);
    if (disposition.recovery === 'resume' || observedActiveClaim) {
      const conflictClaim = await claimRevisionConflictTermination(env, {
        eventId: input.eventId,
        operationId: input.operationId,
        workflowInstanceId: receipt.workflow_instance_id,
      }, receipt, disposition.recovery === 'resume' ? 'resuming' : 'restarting');
      if (conflictClaim) {
        return terminateRevisionConflict(env, {
          eventId: input.eventId,
          operationId: input.operationId,
          workflowInstanceId: receipt.workflow_instance_id,
        }, conflictClaim, accessor);
      }
    }
    const terminalOrAbsent = disposition.kind === 'complete'
      || disposition.kind === 'missing'
      || disposition.recovery === 'restart';
    if (!observedActiveClaim
      && current?.workflow_instance_id === receipt.workflow_instance_id
      && terminalOrAbsent
      && await settleCoverDispatchRevisionConflict(env, {
        eventId: input.eventId,
        operationId: input.operationId,
        workflowInstanceId: receipt.workflow_instance_id,
      }, receipt)) {
      const conflicted = await loadReceipt(env, input.eventId, input.operationId);
      if (conflicted) return terminalRestartResult(conflicted);
    }
    const latest = await loadReceiptWithExactOpenDispatchFence(env, {
      eventId: input.eventId,
      operationId: input.operationId,
      workflowInstanceId: receipt.workflow_instance_id,
    });
    if (latest && terminalReceiptStatus(latest)) return terminalRestartResult(latest);
    if (latest && await recoveryGuardIsKnownIneligible(env, {
      eventId: input.eventId,
      operationId: input.operationId,
      workflowInstanceId: receipt.workflow_instance_id,
    })) {
      return {
        status: 'ineligible',
        view: preparationView(latest),
        retryAfterSeconds: null,
      };
    }
    const latestRecoverable = latest !== null
      && isRecoverableReceipt(latest)
      && latest.exact_open_fence === 1;
    return {
      status: latestRecoverable ? 'unavailable' : 'ineligible',
      view: latest ? preparationView(latest) : null,
      retryAfterSeconds: latestRecoverable ? 5 : null,
    };
  }

  const scope: CoverDispatchScope = {
    workflowInstanceId: receipt.workflow_instance_id,
    dispatchState: claimState,
    dispatchGeneration,
  };
  try {
    if (disposition.recovery === 'resume') await accessor.resume(receipt.workflow_instance_id);
    else if (disposition.recovery === 'create' || materializeAfterFailedLookup) {
      await accessor.create(receipt.workflow_instance_id, {
        eventId: input.eventId, operationId: input.operationId,
      });
    } else await accessor.restart(receipt.workflow_instance_id);
  } catch {
    const followUp = await lookupDisposition(accessor, receipt.workflow_instance_id);
    if (followUp.kind === 'unknown' || followUp.telemetry === 'cover_platform_unmapped') {
      await guardCoverDispatchAfterPlatformCall(env, {
        eventId: input.eventId,
        operationId: input.operationId,
        workflowInstanceId: receipt.workflow_instance_id,
        dispatchGeneration,
        workflow: accessor,
      });
      const current = await loadReceipt(env, input.eventId, input.operationId);
      if (!current) {
        return { status: 'ineligible', view: null, retryAfterSeconds: null };
      }
      if (terminalReceiptStatus(current)) return terminalRestartResult(current);
      return {
        status: 'unavailable', view: preparationView(current), retryAfterSeconds: 5,
      };
    }
    if (followUp.kind !== 'active') {
      const failed = await markDispatchFailed(
        env, input.eventId, input.operationId, input.now, scope,
      );
      // A lost failure CAS can mean purge/deletion won after the platform call.
      // Reuse the exact post-call guard so only this generation is terminated;
      // a newer claim is neither written nor terminated by this caller.
      if (!failed) {
        await confirmCoverDispatch(env, {
          eventId: input.eventId,
          operationId: input.operationId,
          workflowInstanceId: receipt.workflow_instance_id,
          dispatchGeneration,
          from: claimState,
          now: input.now,
          workflow: accessor,
        });
      }
      const freshOwner = await recoveryResultAfterLostOwnership(env, {
        eventId: input.eventId,
        operationId: input.operationId,
        workflowInstanceId: receipt.workflow_instance_id,
      }, followUp);
      if (freshOwner) return freshOwner;
      const current = await loadReceipt(env, input.eventId, input.operationId);
      if (!current) {
        return { status: 'ineligible', view: null, retryAfterSeconds: null };
      }
      if (terminalReceiptStatus(current)) return terminalRestartResult(current);
      return {
        status: 'unavailable', view: preparationView(current), retryAfterSeconds: 5,
      };
    }
  }

  const confirmed = await confirmCoverDispatch(env, {
    eventId: input.eventId,
    operationId: input.operationId,
    workflowInstanceId: receipt.workflow_instance_id,
    dispatchGeneration,
    from: claimState,
    now: input.now,
    workflow: accessor,
  });
  if (!confirmed) {
    const freshOwner = await recoveryResultAfterLostOwnership(env, {
      eventId: input.eventId,
      operationId: input.operationId,
      workflowInstanceId: receipt.workflow_instance_id,
    }, disposition);
    if (freshOwner) return freshOwner;
    const current = await loadReceipt(env, input.eventId, input.operationId);
    if (!current) return { status: 'ineligible', view: null, retryAfterSeconds: null };
    if (terminalReceiptStatus(current)) return terminalRestartResult(current);
    return {
      status: 'unavailable', view: preparationView(current), retryAfterSeconds: 5,
    };
  }

  const updated = await loadReceipt(env, input.eventId, input.operationId);
  if (!updated) return { status: 'ineligible', view: null, retryAfterSeconds: null };
  if (terminalReceiptStatus(updated)) return terminalRestartResult(updated);
  return { status: 'restarted', view: preparationView(updated), retryAfterSeconds: 2 };
}

export async function markDispatchFailed(
  env: AppEnv,
  eventId: string,
  operationId: string,
  now: Date,
  expected?: CoverDispatchScope,
): Promise<boolean> {
  const scope = expected ?? await loadReceipt(env, eventId, operationId).then((receipt) => (
    receipt?.workflow_instance_id
      ? {
          workflowInstanceId: receipt.workflow_instance_id,
          dispatchState: receipt.dispatch_state,
          dispatchGeneration: receipt.dispatch_generation,
        }
      : null
  ));
  if (!scope) return false;
  const failed = await env.DB.prepare(`
    UPDATE event_cover_publish_receipts
    SET status = 'failed', retryable = 1, failure_code = 'COVER_RENDER_UNAVAILABLE',
        dispatch_state = 'failed', updated_at = ?, expires_at = ?
    WHERE event_id = ? AND operation_id = ? AND workflow_instance_id = ?
      AND dispatch_state = ? AND dispatch_generation = ?
      AND status IN ('queued', 'rendering', 'finalizing')
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.id = event_cover_publish_receipts.event_id
          AND e.deleted_at IS NULL
          AND e.cover_revision = event_cover_publish_receipts.expected_revision
      )
      AND EXISTS (
        SELECT 1 FROM event_cover_workflow_fences f
        WHERE f.workflow_binding = ? AND f.workflow_instance_id = ?
          AND f.event_id = ? AND f.state = 'open'
          AND f.dispatch_generation = event_cover_publish_receipts.dispatch_generation
      )
  `).bind(
    now.toISOString(),
    new Date(now.getTime() + RESTART_WINDOW_MS).toISOString(),
    eventId, operationId, scope.workflowInstanceId,
    scope.dispatchState, scope.dispatchGeneration,
    COVER_RENDER_BINDING, scope.workflowInstanceId, eventId,
  ).run();
  return failed.meta.changes === 1;
}

interface CoverDispatchPostCallInput {
  eventId: string;
  operationId: string;
  workflowInstanceId: string;
  dispatchGeneration: number;
  workflow: CoverWorkflowAccessor;
}

interface CoverDispatchPostCallSnapshot {
  receipt: CoverPublishReceiptRow | null;
  fence: {
    state: string;
    dispatch_generation: number;
    updated_at: string;
    expires_at: string;
  } | null;
  eventIsCurrent: boolean;
  exactGeneration: boolean;
}

/**
 * Checks only whether this exact platform call lost admission after it began.
 *
 * This helper deliberately performs no D1 write. Unknown/unmapped follow-up
 * states use it before returning, so deletion can still terminate the exact
 * instance without turning uncertain platform evidence into confirmation.
 */
async function inspectAndGuardCoverDispatch(
  env: AppEnv,
  input: CoverDispatchPostCallInput,
): Promise<CoverDispatchPostCallSnapshot> {
  const [receipt, fence, event] = await Promise.all([
    loadReceipt(env, input.eventId, input.operationId),
    env.DB.prepare(`
      SELECT state, dispatch_generation, updated_at, expires_at
      FROM event_cover_workflow_fences
      WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
    `).bind(COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId)
      .first<{
        state: string;
        dispatch_generation: number;
        updated_at: string;
        expires_at: string;
      }>(),
    env.DB.prepare(`
      SELECT deleted_at, cover_revision FROM events WHERE id = ?
    `).bind(input.eventId).first<{ deleted_at: string | null; cover_revision: number }>(),
  ]);
  const exactGeneration = receipt?.workflow_instance_id === input.workflowInstanceId
    && receipt.dispatch_generation === input.dispatchGeneration;
  const terminalResult = receipt !== null && terminalReceiptStatus(receipt) !== null;
  const eventIsCurrent = event !== null && receipt !== null
    && event.deleted_at === null
    && (terminalResult || event.cover_revision === receipt.expected_revision);
  // Deletion owns this event/instance across generations. Once its exact
  // fence is blocked, no delayed caller may leave the retained instance live,
  // including while purge proof is still on HOLD or after relational cleanup.
  const deletionWon = fence?.state === 'deletion-blocked';
  const fenceDisappearedWithoutSupersession = exactGeneration && !fence;
  const eventMovedOn = exactGeneration && !terminalResult && !eventIsCurrent;
  const receiptUpdatedAt = receipt ? new Date(receipt.updated_at) : null;
  const supersedingTerminalExpiry = receiptUpdatedAt !== null
    && Number.isFinite(receiptUpdatedAt.getTime())
    ? coverWorkflowFenceTerminalExpiry(receiptUpdatedAt)
    : null;
  const supersedingTerminalProof = receipt !== null
    && receipt.workflow_instance_id === input.workflowInstanceId
    && terminalResult
    && receipt.dispatch_generation > input.dispatchGeneration
    && fence !== null
    && fence.dispatch_generation === receipt.dispatch_generation
    && supersedingTerminalExpiry !== null
    && fence.state === 'open'
    && fence.expires_at === supersedingTerminalExpiry;
  if (deletionWon
    || fenceDisappearedWithoutSupersession
    || eventMovedOn
    || supersedingTerminalProof) {
    try { await input.workflow.terminate(input.workflowInstanceId); } catch { /* purge retries */ }
  }
  return { receipt, fence, eventIsCurrent, exactGeneration };
}

export async function guardCoverDispatchAfterPlatformCall(
  env: AppEnv,
  input: CoverDispatchPostCallInput,
): Promise<void> {
  await inspectAndGuardCoverDispatch(env, input);
}

/** Records a successful first dispatch, after the mandatory fence recheck. */
export async function confirmCoverDispatch(
  env: AppEnv,
  input: {
    eventId: string;
    operationId: string;
    workflowInstanceId: string;
    dispatchGeneration: number;
    from?: CoverDispatchClaimState;
    now: Date;
    workflow: CoverWorkflowAccessor;
  },
): Promise<boolean> {
  const from = input.from ?? 'creating';
  const confirmed = await env.DB.prepare(`
    UPDATE event_cover_publish_receipts
    SET dispatch_state = 'confirmed',
        updated_at = CASE
          WHEN status IN ('applied', 'conflict') OR (status = 'failed' AND retryable = 0)
            THEN updated_at
          ELSE ${DISPATCH_CLAIM_APPLIED_AT_SQL}
        END
    WHERE event_id = ? AND operation_id = ? AND workflow_instance_id = ?
      AND dispatch_state = ? AND dispatch_generation = ?
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.id = event_cover_publish_receipts.event_id
          AND e.deleted_at IS NULL
          AND (
            event_cover_publish_receipts.status IN ('applied', 'conflict')
            OR (
              event_cover_publish_receipts.status = 'failed'
              AND event_cover_publish_receipts.retryable = 0
            )
            OR e.cover_revision = event_cover_publish_receipts.expected_revision
          )
      )
      AND EXISTS (
        SELECT 1 FROM event_cover_workflow_fences f
        WHERE f.workflow_binding = ? AND f.workflow_instance_id = ?
          AND f.event_id = ? AND f.state = 'open' AND f.dispatch_generation = ?
      )
  `).bind(
    input.eventId, input.operationId, input.workflowInstanceId,
    from, input.dispatchGeneration,
    COVER_RENDER_BINDING, input.workflowInstanceId, input.eventId, input.dispatchGeneration,
  ).run();
  if (confirmed.meta.changes === 1) return true;

  const { receipt, fence, eventIsCurrent, exactGeneration } = await inspectAndGuardCoverDispatch(
    env,
    input,
  );
  if (exactGeneration
    && receipt !== null
    && receipt.dispatch_state === 'confirmed'
    && fence?.state === 'open'
    && fence.dispatch_generation === input.dispatchGeneration
    && eventIsCurrent) {
    return true;
  }

  return false;
}

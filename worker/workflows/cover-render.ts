import { coverWorkflowFenceTerminalExpiry } from '../../shared/constants';
import {
  COVER_PIPELINE_VERSIONS,
  EVENT_COVER_PROFILES,
  type EventCoverDensity,
  type EventCoverEffectId,
  type EventCoverFormat,
  type EventCoverProfileId,
  canonicalCoverConfig,
  parseStoredCoverConfig,
  qualifiedCover2xProfiles,
  resolvedCoverFocusPoint,
} from '../../shared/event-cover';
import { ApiError } from '../../shared/errors';
import { adoptCoverRenderObject } from '../db/event-covers';
import { coverPointerStatements } from '../db/events';
import type { EventRow } from '../db/events';
import type {
  CoverDraftRow,
  CoverMasterRow,
  CoverPublishReceiptRow,
  CoverRenderSetRow,
} from '../db/types';
import type { AppEnv } from '../env';
import { COVER_RENDER_BINDING } from '../services/event-cover-publication';
import { renderCoverProfileObject, verifyCoverManifest } from '../storage/event-cover-images';
import { coverKeyFingerprint } from '../storage/event-cover-keys';

/**
 * The payload one cover publication's Workflow instance carries.
 *
 * Deliberately two opaque identifiers and nothing else. Every other input —
 * the frozen draft, the pinned master, the recipe, the derived manifest, the
 * staging set — is rehydrated from the durable receipt in preflight, so a
 * replayed step can never act on a stale copy of state that D1 has since moved,
 * and no recipe detail is ever carried in platform-retained instance data.
 */
export interface CoverRenderPayload {
  eventId: string;
  operationId: string;
}

export interface CoverRenderSlot {
  profile: EventCoverProfileId;
  density: EventCoverDensity;
  format: EventCoverFormat;
}

export interface CoverRenderOutcome {
  status: 'applied' | 'conflict' | 'failed' | 'skipped';
  appliedRevision: number | null;
  failureCode: string | null;
  retryable: boolean;
}

export interface CoverRenderPreflight {
  shouldRender: boolean;
  outcome: CoverRenderOutcome;
  /** The exact 12-24 slot manifest, frozen before the first transform. */
  slots: CoverRenderSlot[];
}

export interface CoverRenderStepSummary {
  profile: EventCoverProfileId;
  /** Small inventory only. Image bytes stay in R2, never in Workflow state. */
  written: number;
  adopted: number;
  completedProfiles: number;
}

const RETIRED_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_APPLIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;

function terminalFenceStatement(
  env: AppEnv,
  payload: CoverRenderPayload,
  generation: number,
  now: Date,
  onlyIfPriorStatementChanged = false,
): D1PreparedStatement {
  const changeGuard = onlyIfPriorStatementChanged ? ' AND changes() = 1' : '';
  return env.DB.prepare(`
    UPDATE event_cover_workflow_fences
    SET expires_at = ?, updated_at = ?
    WHERE workflow_binding = ? AND workflow_instance_id = (
      SELECT workflow_instance_id FROM event_cover_publish_receipts
      WHERE event_id = ? AND operation_id = ? AND dispatch_generation = ?
        AND status IN ('applied', 'conflict', 'failed')
    ) AND event_id = ? AND dispatch_generation = ? AND state = 'open'${changeGuard}
  `).bind(
    coverWorkflowFenceTerminalExpiry(now), now.toISOString(), COVER_RENDER_BINDING,
    payload.eventId, payload.operationId, generation, payload.eventId, generation,
  );
}

interface RehydratedState {
  receipt: CoverPublishReceiptRow;
  event: EventRow;
  draft: CoverDraftRow;
  master: CoverMasterRow;
  set: CoverRenderSetRow;
}

function terminal(
  status: CoverRenderOutcome['status'],
  failureCode: string | null = null,
  retryable = false,
): CoverRenderPreflight {
  return {
    shouldRender: false,
    outcome: { status, appliedRevision: null, failureCode, retryable },
    slots: [],
  };
}

function outcomeFromReceipt(receipt: CoverPublishReceiptRow): CoverRenderOutcome | null {
  if (receipt.status === 'applied') {
    return {
      status: 'applied', appliedRevision: receipt.applied_revision,
      failureCode: null, retryable: false,
    };
  }
  if (receipt.status === 'conflict') {
    return { status: 'conflict', appliedRevision: null, failureCode: null, retryable: false };
  }
  if (receipt.status === 'failed') {
    return {
      status: 'failed', appliedRevision: null,
      failureCode: receipt.failure_code, retryable: receipt.retryable === 1,
    };
  }
  return null;
}

function terminalFromReceipt(receipt: CoverPublishReceiptRow): CoverRenderPreflight {
  return {
    shouldRender: false,
    outcome: outcomeFromReceipt(receipt)
      ?? { status: 'skipped', appliedRevision: null, failureCode: null, retryable: false },
    slots: [],
  };
}

async function currentPreflightOutcome(
  env: AppEnv,
  payload: CoverRenderPayload,
): Promise<CoverRenderPreflight> {
  const receipt = await env.DB.prepare(`
    SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
  `).bind(payload.eventId, payload.operationId).first<CoverPublishReceiptRow>();
  return receipt ? terminalFromReceipt(receipt) : terminal('skipped');
}

async function currentRenderOutcome(
  env: AppEnv,
  payload: CoverRenderPayload,
): Promise<CoverRenderOutcome> {
  const receipt = await env.DB.prepare(`
    SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
  `).bind(payload.eventId, payload.operationId).first<CoverPublishReceiptRow>();
  return receipt ? terminalFromReceipt(receipt).outcome : terminal('skipped').outcome;
}

async function rehydrate(env: AppEnv, payload: CoverRenderPayload): Promise<RehydratedState | null> {
  const receipt = await env.DB.prepare(
    'SELECT * FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?',
  ).bind(payload.eventId, payload.operationId).first<CoverPublishReceiptRow>();
  if (!receipt?.draft_id || !receipt.render_set_id) return null;

  const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?')
    .bind(payload.eventId).first<EventRow>();
  const draft = await env.DB.prepare('SELECT * FROM event_cover_drafts WHERE id = ?')
    .bind(receipt.draft_id).first<CoverDraftRow>();
  const set = await env.DB.prepare('SELECT * FROM event_cover_render_sets WHERE id = ?')
    .bind(receipt.render_set_id).first<CoverRenderSetRow>();
  if (!event || !draft || !set || !draft.master_id) return null;
  const master = await env.DB.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
    .bind(draft.master_id).first<CoverMasterRow>();
  if (!master) return null;
  return { receipt, event, draft, master, set };
}

/**
 * Everything that must be true before a single byte is transformed.
 *
 * Rehydrates server state rather than trusting the payload, and exits without
 * touching Images on every disposition that cannot end in an activation. That
 * ordering is the difference between a stale publication costing nothing and a
 * stale publication costing twenty-four billable transformations.
 */
export async function coverRenderPreflight(
  env: AppEnv,
  payload: CoverRenderPayload,
  now = new Date(),
): Promise<CoverRenderPreflight> {
  const state = await rehydrate(env, payload);
  if (!state) return terminal('skipped');
  const { receipt, event, draft, master, set } = state;

  // A late replay of an already-terminal receipt does nothing at all.
  if (outcomeFromReceipt(receipt)) return terminalFromReceipt(receipt);

  // The deletion fence, before Images or R2 work. A present, open,
  // generation-matching fence for this event is *permission*; anything else,
  // including no row at all, is refusal.
  //
  // The earlier form asked only whether a fence objected, so a missing row read
  // as "nothing objects" — and a missing row is exactly what a purge that has
  // already settled and swept leaves behind. Failing closed also costs nothing
  // legitimate: every instance that may run has a fence written in the same
  // transaction that accepted it.
  const fence = await env.DB.prepare(`
    SELECT state, dispatch_generation FROM event_cover_workflow_fences
    WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
  `).bind(COVER_RENDER_BINDING, receipt.workflow_instance_id, receipt.event_id)
    .first<{ state: string; dispatch_generation: number }>();
  //
  // Absence and a purge's hold are refusals, and a refusal has to hand the draft
  // back with it: `publishing` is not expirable, cannot be discarded, and cannot
  // be failed, so a draft left in it is stranded for the life of the event.
  if (!fence || fence.state !== 'open') {
    await recordSafeFailure(
      env, payload, 'COVER_RENDER_UNAVAILABLE', false, now,
      receipt.dispatch_generation, set.id, draft.id,
    );
    return currentPreflightOutcome(env, payload);
  }
  // A generation this instance did not claim is supersession, not failure.
  // `restartCoverPublication` moves the receipt and the fence in one batch, so a
  // divergence means another generation owns this receipt now — and writing a
  // terminal status here would poison the run that does. The superseded run
  // leaves without touching anything.
  if (fence.dispatch_generation !== receipt.dispatch_generation) {
    return currentPreflightOutcome(env, payload);
  }

  if (event.deleted_at) {
    await recordSafeFailure(
      env, payload, 'COVER_RENDER_UNAVAILABLE', false, now,
      receipt.dispatch_generation, set.id, draft.id,
    );
    return currentPreflightOutcome(env, payload);
  }

  // The event moved on while this was queued. Record the conflict, abandon the
  // empty set, and hand the still-valid draft back so the host can republish.
  if (event.cover_revision !== receipt.expected_revision) {
    await recordConflict(env, payload, set.id, draft.id, now, receipt.dispatch_generation);
    return currentPreflightOutcome(env, payload);
  }
  if (draft.state !== 'publishing') {
    await recordConflict(env, payload, set.id, draft.id, now, receipt.dispatch_generation);
    return currentPreflightOutcome(env, payload);
  }

  const config = parseStoredCoverConfig(JSON.parse(set.recipe_json) as unknown);
  if (!config || !('effect' in config) || !('focus' in config)) {
    await recordSafeFailure(
      env, payload, 'COVER_RENDER_UNAVAILABLE', false, now,
      receipt.dispatch_generation, set.id, draft.id,
    );
    return currentPreflightOutcome(env, payload);
  }

  const slots = deriveCoverSlots(master, config.focus);
  const timestamp = now.toISOString();
  // Freeze the derived manifest and move to rendering in one guarded write, so
  // a replay of this step cannot re-derive a different slot count.
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'rendering', required_profiles = ?, updated_at = ?
      WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
        AND workflow_instance_id = ? AND dispatch_generation = ?
        AND render_set_id = ? AND draft_id = ?
        AND status = ? AND retryable = ? AND status IN ('queued', 'rendering')
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.id = event_cover_publish_receipts.event_id
            AND e.deleted_at IS NULL
            AND e.cover_revision = event_cover_publish_receipts.expected_revision
            AND e.cover_object_key IS ? AND e.cover_render_set_id IS ?
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          WHERE s.id = event_cover_publish_receipts.render_set_id
            AND s.event_id = event_cover_publish_receipts.event_id
            AND s.draft_id = event_cover_publish_receipts.draft_id
            AND s.state = 'staging'
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_drafts d
          WHERE d.id = event_cover_publish_receipts.draft_id
            AND d.event_id = event_cover_publish_receipts.event_id
            AND d.state = 'publishing'
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ?
            AND f.workflow_instance_id = event_cover_publish_receipts.workflow_instance_id
            AND f.event_id = event_cover_publish_receipts.event_id
            AND f.state = 'open'
            AND f.dispatch_generation = event_cover_publish_receipts.dispatch_generation
        )
    `).bind(
      EVENT_COVER_PROFILES.length, timestamp,
      payload.eventId, payload.operationId, receipt.request_sha256, receipt.workflow_instance_id,
      receipt.dispatch_generation, set.id, draft.id,
      receipt.status, receipt.retryable,
      event.cover_object_key, event.cover_render_set_id,
      COVER_RENDER_BINDING,
    ),
    env.DB.prepare(`
      UPDATE event_cover_render_sets SET required_slots = ?
      WHERE id = ? AND state = 'staging' AND changes() = 1
    `).bind(slots.length, set.id),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    return currentPreflightOutcome(env, payload);
  }

  return {
    shouldRender: true,
    outcome: { status: 'skipped', appliedRevision: null, failureCode: null, retryable: true },
    slots,
  };
}

/**
 * The exact required slots for this master and focus.
 *
 * Both formats for all six 1x profiles are mandatory; a 2x pair is added only
 * where the selected crop can produce it without upscaling. Twelve to
 * twenty-four objects, derived once and then immutable for the publication.
 */
export function deriveCoverSlots(
  master: { width: number; height: number; auto_focus_x: number | null; auto_focus_y: number | null },
  focus: { mode: 'auto' } | { mode: 'manual'; x: number; y: number; zoom: number },
): CoverRenderSlot[] {
  const point = resolvedCoverFocusPoint(
    focus,
    master.auto_focus_x !== null && master.auto_focus_y !== null
      ? { x: master.auto_focus_x, y: master.auto_focus_y }
      : null,
  );
  const qualified = new Set(qualifiedCover2xProfiles(master, point));
  const slots: CoverRenderSlot[] = [];
  for (const profile of EVENT_COVER_PROFILES) {
    for (const format of ['webp', 'jpeg'] as const) {
      slots.push({ profile: profile.id, density: '1x', format });
    }
    if (qualified.has(profile.id)) {
      for (const format of ['webp', 'jpeg'] as const) {
        slots.push({ profile: profile.id, density: '2x', format });
      }
    }
  }
  return slots;
}

async function coverRenderProfileAdmissionHolds(
  env: AppEnv,
  payload: CoverRenderPayload,
  receipt: CoverPublishReceiptRow,
  set: CoverRenderSetRow,
  draft: CoverDraftRow,
): Promise<boolean> {
  if (!receipt.workflow_instance_id) return false;
  const admitted = await env.DB.prepare(`
    SELECT 1 AS admitted
    FROM event_cover_publish_receipts r
    JOIN events e ON e.id = r.event_id
    JOIN event_cover_render_sets s ON s.id = r.render_set_id AND s.event_id = r.event_id
    JOIN event_cover_drafts d ON d.id = r.draft_id AND d.event_id = r.event_id
    JOIN event_cover_workflow_fences f
      ON f.workflow_binding = ? AND f.workflow_instance_id = r.workflow_instance_id
        AND f.event_id = r.event_id AND f.state = 'open'
        AND f.dispatch_generation = r.dispatch_generation
    WHERE r.event_id = ? AND r.operation_id = ? AND r.request_sha256 = ?
      AND r.workflow_instance_id = ? AND r.dispatch_generation = ?
      AND r.render_set_id = ? AND r.draft_id = ? AND r.status = 'rendering'
      AND e.deleted_at IS NULL AND e.cover_revision = r.expected_revision
      AND s.state = 'staging' AND d.state = 'publishing'
  `).bind(
    COVER_RENDER_BINDING,
    payload.eventId, payload.operationId, receipt.request_sha256,
    receipt.workflow_instance_id, receipt.dispatch_generation,
    set.id, draft.id,
  ).first<{ admitted: number }>();
  return admitted !== null;
}

/**
 * One profile's slots, individually replay-safe.
 *
 * Running this twice adopts rather than rewrites: the object keys are
 * deterministic and the writes are conditional creates, so the second pass
 * verifies bytes that may already belong to an active manifest instead of
 * replacing them.
 */
export async function coverRenderProfileStep(
  env: AppEnv,
  payload: CoverRenderPayload,
  profile: EventCoverProfileId,
  now = new Date(),
): Promise<CoverRenderStepSummary> {
  const state = await rehydrate(env, payload);
  if (!state) return { profile, written: 0, adopted: 0, completedProfiles: 0 };
  const { receipt, master, set, draft } = state;
  if (!await coverRenderProfileAdmissionHolds(env, payload, receipt, set, draft)) {
    return {
      profile, written: 0, adopted: 0,
      completedProfiles: receipt.completed_profiles,
    };
  }

  const config = parseStoredCoverConfig(JSON.parse(set.recipe_json) as unknown);
  if (!config || !('focus' in config)) {
    throw new ApiError('COVER_RENDER_UNAVAILABLE', 'This cover could not be prepared.', 503);
  }
  const point = resolvedCoverFocusPoint(
    config.focus,
    master.auto_focus_x !== null && master.auto_focus_y !== null
      ? { x: master.auto_focus_x, y: master.auto_focus_y }
      : null,
  );

  let written = 0;
  let adopted = 0;
  for (const slot of deriveCoverSlots(master, config.focus)) {
    if (slot.profile !== profile) continue;
    if (!await coverRenderProfileAdmissionHolds(env, payload, receipt, set, draft)) break;
    const result = await renderCoverProfileObject(env, {
      eventId: payload.eventId,
      renderSetId: set.id,
      masterKey: master.object_key,
      master: { width: master.width, height: master.height },
      focus: point,
      effect: config.effect as EventCoverEffectId,
      profile: slot.profile,
      density: slot.density,
      format: slot.format,
    });
    const admitted = await adoptCoverRenderObject(env.DB, {
      renderSetId: set.id,
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
      publicationAdmission: {
        operationId: payload.operationId,
        workflowInstanceId: receipt.workflow_instance_id!,
        dispatchGeneration: receipt.dispatch_generation,
        draftId: draft.id,
      },
    });
    if (!admitted) {
      if (!result.adopted) await env.MEDIA_BUCKET.delete(result.objectKey);
      break;
    }
    if (result.adopted) adopted += 1; else written += 1;
  }

  // Durable progress, derived from inventory rather than counted in memory, so
  // a replayed step cannot double-count and polling never guesses from elapsed
  // time. Never above the profile count.
  const progressed = await env.DB.prepare(`
    UPDATE event_cover_publish_receipts
    SET completed_profiles = MIN(?, (
          SELECT count(DISTINCT profile_id) FROM event_cover_render_objects
          WHERE render_set_id = ?
        )),
        updated_at = ?
    WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
      AND workflow_instance_id = ? AND dispatch_generation = ?
      AND render_set_id = ? AND draft_id = ? AND status = 'rendering'
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.id = event_cover_publish_receipts.event_id
          AND e.deleted_at IS NULL
          AND e.cover_revision = event_cover_publish_receipts.expected_revision
      )
      AND EXISTS (
        SELECT 1 FROM event_cover_render_sets s
        WHERE s.id = event_cover_publish_receipts.render_set_id AND s.state = 'staging'
      )
      AND EXISTS (
        SELECT 1 FROM event_cover_drafts d
        WHERE d.id = event_cover_publish_receipts.draft_id AND d.state = 'publishing'
      )
      AND EXISTS (
        SELECT 1 FROM event_cover_workflow_fences f
        WHERE f.workflow_binding = ?
          AND f.workflow_instance_id = event_cover_publish_receipts.workflow_instance_id
          AND f.event_id = event_cover_publish_receipts.event_id
          AND f.state = 'open'
          AND f.dispatch_generation = event_cover_publish_receipts.dispatch_generation
      )
    RETURNING completed_profiles
  `).bind(
    EVENT_COVER_PROFILES.length, set.id, now.toISOString(),
    payload.eventId, payload.operationId, receipt.request_sha256,
    receipt.workflow_instance_id, receipt.dispatch_generation,
    set.id, draft.id, COVER_RENDER_BINDING,
  ).first<{ completed_profiles: number }>();

  return {
    profile,
    written,
    adopted,
    completedProfiles: progressed?.completed_profiles ?? receipt.completed_profiles,
  };
}

/**
 * The one authoritative transaction.
 *
 * Verifies the exact manifest first, then moves the set to `ready`, then commits
 * the pointer flip, the retirement inventory, the previous set's retirement, the
 * new set's activation, the draft's `published` flip, and the receipt's
 * `applied` flip together. `coverPointerStatements` supplies the first two, so
 * the displaced legacy key is inventoried by the same statements that move the
 * pointer — never by a follow-up that a failure could skip.
 */
export async function coverRenderFinalize(
  env: AppEnv,
  payload: CoverRenderPayload,
  now = new Date(),
): Promise<CoverRenderOutcome> {
  const state = await rehydrate(env, payload);
  if (!state) return { status: 'skipped', appliedRevision: null, failureCode: null, retryable: false };
  const { receipt, event, draft, master, set } = state;
  if (receipt.status === 'applied') {
    return { status: 'applied', appliedRevision: receipt.applied_revision, failureCode: null, retryable: false };
  }
  if (receipt.status === 'conflict') {
    return { status: 'conflict', appliedRevision: null, failureCode: null, retryable: false };
  }
  if (receipt.status === 'failed') {
    return {
      status: 'failed', appliedRevision: null,
      failureCode: receipt.failure_code, retryable: receipt.retryable === 1,
    };
  }

  const config = parseStoredCoverConfig(JSON.parse(set.recipe_json) as unknown);
  if (!config || !('focus' in config)) {
    await recordSafeFailure(
      env, payload, 'COVER_OUTPUT_BUDGET_EXHAUSTED', false, now,
      receipt.dispatch_generation, set.id, draft.id,
    );
    return currentRenderOutcome(env, payload);
  }
  const verdict = await verifyCoverManifest(
    env,
    set.id,
    deriveCoverSlots(master, config.focus),
  );
  if (!verdict.complete) {
    // A controlled permanent failure: abandon the set and hand the draft back
    // so the host can correct it. The active cover is untouched throughout.
    await recordSafeFailure(
      env, payload, 'COVER_OUTPUT_BUDGET_EXHAUSTED', false, now,
      receipt.dispatch_generation, set.id, draft.id,
    );
    return currentRenderOutcome(env, payload);
  }

  const timestamp = now.toISOString();
  const cleanupAfter = new Date(now.getTime() + RETIRED_RECOVERY_MS).toISOString();
  const nextRevision = receipt.expected_revision + 1;

  const results = await env.DB.batch([
    ...coverPointerStatements(env.DB, {
      eventId: payload.eventId,
      expectedRevision: receipt.expected_revision,
      expectedCurrentKey: event.cover_object_key,
      expectedCurrentRenderSetId: event.cover_render_set_id,
      nextConfig: canonicalCoverConfig(config),
      nextObjectKey: master.object_key,
      nextRenderSetId: set.id,
      retiredAt: timestamp,
      cleanupAfter,
      retiredKeyFingerprint: event.cover_object_key
        ? await coverKeyFingerprint(event.cover_object_key)
        : '0'.repeat(64),
      renderPublicationGuard: {
        operationId: payload.operationId,
        requestSha256: receipt.request_sha256,
        workflowInstanceId: receipt.workflow_instance_id!,
        dispatchGeneration: receipt.dispatch_generation,
        renderSetId: set.id,
        draftId: draft.id,
      },
    }),
    // Everything below is predicated on the revision having actually moved. A
    // zero-change UPDATE does not error a D1 batch, so without this a lost guard
    // would still activate the set and mark the receipt applied.
    env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'retired', retired_at = ?, cleanup_after = ?
      WHERE event_id = ? AND state = 'active' AND id <> ?
        AND EXISTS (
          SELECT 1 FROM events WHERE id = ? AND deleted_at IS NULL
            AND cover_revision = ? AND cover_object_key IS ? AND cover_render_set_id IS ?
        )
    `).bind(
      timestamp, cleanupAfter, payload.eventId, set.id,
      payload.eventId, nextRevision, master.object_key, set.id,
    ),
    env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'active', manifest_sha256 = ?, published_revision = ?,
          ready_at = COALESCE(ready_at, ?), published_at = ?
      WHERE id = ? AND state IN ('staging', 'ready')
        AND EXISTS (
          SELECT 1 FROM events WHERE id = ? AND deleted_at IS NULL
            AND cover_revision = ? AND cover_object_key IS ? AND cover_render_set_id IS ?
        )
    `).bind(
      verdict.manifestSha256, nextRevision, timestamp, timestamp,
      set.id, payload.eventId, nextRevision, master.object_key, set.id,
    ),
    env.DB.prepare(`
      UPDATE event_cover_drafts
      SET state = 'published', draft_revision = draft_revision + 1, updated_at = ?
      WHERE id = ? AND state = 'publishing'
        AND EXISTS (
          SELECT 1 FROM events WHERE id = ? AND deleted_at IS NULL
            AND cover_revision = ? AND cover_object_key IS ? AND cover_render_set_id IS ?
        )
    `).bind(timestamp, draft.id, payload.eventId, nextRevision, master.object_key, set.id),
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'applied', applied_revision = ?, result_cover_json = ?, retryable = 0,
          failure_code = NULL, completed_profiles = ?, updated_at = ?, expires_at = ?
      WHERE event_id = ? AND operation_id = ? AND request_sha256 = ?
        AND workflow_instance_id = ? AND dispatch_generation = ?
        AND render_set_id = ? AND draft_id = ?
        AND status IN ('rendering', 'finalizing')
        AND EXISTS (
          SELECT 1 FROM events WHERE id = ? AND deleted_at IS NULL
            AND cover_revision = ? AND cover_object_key IS ? AND cover_render_set_id IS ?
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ? AND f.workflow_instance_id = ?
            AND f.event_id = ? AND f.state = 'open' AND f.dispatch_generation = ?
        )
    `).bind(
      nextRevision, canonicalCoverConfig(config), EVENT_COVER_PROFILES.length, timestamp,
      new Date(now.getTime() + RECEIPT_APPLIED_TTL_MS).toISOString(),
      payload.eventId, payload.operationId, receipt.request_sha256, receipt.workflow_instance_id,
      receipt.dispatch_generation, set.id, draft.id,
      payload.eventId, nextRevision, master.object_key, set.id,
      COVER_RENDER_BINDING, receipt.workflow_instance_id, payload.eventId,
      receipt.dispatch_generation,
    ),
    terminalFenceStatement(env, payload, receipt.dispatch_generation, now, true),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const [current, currentEvent, currentFence] = await Promise.all([
      env.DB.prepare(`
      SELECT *
      FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
      `).bind(payload.eventId, payload.operationId).first<CoverPublishReceiptRow>(),
      env.DB.prepare(`
        SELECT deleted_at, cover_revision, cover_object_key, cover_render_set_id
        FROM events WHERE id = ?
      `).bind(payload.eventId).first<Pick<
        EventRow, 'deleted_at' | 'cover_revision' | 'cover_object_key' | 'cover_render_set_id'
      >>(),
      env.DB.prepare(`
        SELECT state, dispatch_generation FROM event_cover_workflow_fences
        WHERE workflow_binding = ? AND workflow_instance_id = ? AND event_id = ?
      `).bind(COVER_RENDER_BINDING, receipt.workflow_instance_id, payload.eventId)
        .first<{ state: string; dispatch_generation: number }>(),
    ]);
    if (current?.status === 'applied') {
      return {
        status: 'applied', appliedRevision: current.applied_revision,
        failureCode: null, retryable: false,
      };
    }
    if (current?.status === 'failed') {
      return {
        status: 'failed', appliedRevision: null,
        failureCode: current.failure_code, retryable: current.retryable === 1,
      };
    }
    if (current?.status === 'conflict') {
      return { status: 'conflict', appliedRevision: null, failureCode: null, retryable: false };
    }

    const exactOwner = current?.workflow_instance_id === receipt.workflow_instance_id
      && current.dispatch_generation === receipt.dispatch_generation
      && (current.status === 'rendering' || current.status === 'finalizing');
    const exactFence = currentFence?.state === 'open'
      && currentFence.dispatch_generation === receipt.dispatch_generation;
    const revisionLost = currentEvent !== null
      && currentEvent.deleted_at === null
      && (
        currentEvent.cover_revision !== receipt.expected_revision
        || currentEvent.cover_object_key !== event.cover_object_key
        || currentEvent.cover_render_set_id !== event.cover_render_set_id
      );
    if (exactOwner && exactFence && revisionLost) {
      await recordConflict(env, payload, set.id, draft.id, now, receipt.dispatch_generation);
      const settled = await env.DB.prepare(`
        SELECT status, applied_revision, failure_code, retryable
        FROM event_cover_publish_receipts WHERE event_id = ? AND operation_id = ?
      `).bind(payload.eventId, payload.operationId).first<Pick<
        CoverPublishReceiptRow, 'status' | 'applied_revision' | 'failure_code' | 'retryable'
      >>();
      if (settled?.status === 'applied') {
        return {
          status: 'applied', appliedRevision: settled.applied_revision,
          failureCode: null, retryable: false,
        };
      }
      if (settled?.status === 'failed') {
        return {
          status: 'failed', appliedRevision: null,
          failureCode: settled.failure_code, retryable: settled.retryable === 1,
        };
      }
      if (settled?.status === 'conflict') {
        return { status: 'conflict', appliedRevision: null, failureCode: null, retryable: false };
      }
    }
    return { status: 'skipped', appliedRevision: null, failureCode: null, retryable: false };
  }
  return { status: 'applied', appliedRevision: nextRevision, failureCode: null, retryable: false };
}

/**
 * A lost final guard, recorded without touching a single active pointer.
 *
 * The set is abandoned and the draft returns to `ready`, which is what releases
 * publication ownership so the host can discard or republish it.
 */
async function recordConflict(
  env: AppEnv,
  payload: CoverRenderPayload,
  renderSetId: string,
  draftId: string,
  now: Date,
  generation: number,
): Promise<boolean> {
  const timestamp = now.toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'conflict', retryable = 0, updated_at = ?, expires_at = ?
      WHERE event_id = ? AND operation_id = ? AND dispatch_generation = ?
        AND (status IN ('queued', 'rendering', 'finalizing')
          OR (status = 'failed' AND retryable = 1))
        AND EXISTS (
          SELECT 1 FROM event_cover_workflow_fences f
          WHERE f.workflow_binding = ?
            AND f.workflow_instance_id = event_cover_publish_receipts.workflow_instance_id
            AND f.event_id = event_cover_publish_receipts.event_id
            AND f.state = 'open'
            AND f.dispatch_generation = event_cover_publish_receipts.dispatch_generation
        )
    `).bind(
      timestamp, new Date(now.getTime() + RECEIPT_TERMINAL_TTL_MS).toISOString(),
      payload.eventId, payload.operationId, generation, COVER_RENDER_BINDING,
    ),
    env.DB.prepare(`
      UPDATE event_cover_render_sets
      SET state = 'abandoned', abandoned_reason = 'revision-conflict', abandoned_at = ?,
          cleanup_after = ?
      WHERE id = ? AND state IN ('staging', 'ready') AND changes() = 1
    `).bind(timestamp, new Date(now.getTime() + RETIRED_RECOVERY_MS).toISOString(), renderSetId),
    env.DB.prepare(`
      UPDATE event_cover_drafts
      SET state = 'ready', draft_revision = draft_revision + 1, updated_at = ?
      WHERE id = ? AND state = 'publishing' AND changes() = 1
    `).bind(timestamp, draftId),
    terminalFenceStatement(env, payload, generation, now, true),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1;
}

/**
 * The receipt UPDATE carries the generation the caller read, so a run that has
 * been superseded between its own reads cannot stamp a terminal status over the
 * generation that replaced it. Every caller has already decided it owns this
 * receipt; this is the guard that makes that decision true at commit time
 * rather than at read time.
 */
async function recordSafeFailure(
  env: AppEnv,
  payload: CoverRenderPayload,
  failureCode: string,
  retryable: boolean,
  now: Date,
  generation: number,
  renderSetId?: string,
  draftId?: string,
): Promise<boolean> {
  const timestamp = now.toISOString();
  const statements = [
    env.DB.prepare(`
      UPDATE event_cover_publish_receipts
      SET status = 'failed', failure_code = ?, retryable = ?, updated_at = ?, expires_at = ?
      WHERE event_id = ? AND operation_id = ? AND dispatch_generation = ?
        AND (status IN ('queued', 'rendering', 'finalizing')
          OR (status = 'failed' AND retryable = 1))
        AND EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          WHERE s.id = ? AND s.event_id = event_cover_publish_receipts.event_id
            AND s.state IN ('staging', 'ready')
        )
        AND EXISTS (
          SELECT 1 FROM event_cover_drafts d
          WHERE d.id = ? AND d.event_id = event_cover_publish_receipts.event_id
            AND d.state = 'publishing'
        )
        AND (
          EXISTS (
            SELECT 1 FROM event_cover_workflow_fences f
            WHERE f.workflow_binding = ?
              AND f.workflow_instance_id = event_cover_publish_receipts.workflow_instance_id
              AND f.event_id = event_cover_publish_receipts.event_id
              AND f.state = 'open'
              AND f.dispatch_generation = event_cover_publish_receipts.dispatch_generation
          )
          OR (
            NOT EXISTS (
              SELECT 1 FROM event_cover_workflow_fences f
              WHERE f.workflow_binding = ?
                AND f.workflow_instance_id = event_cover_publish_receipts.workflow_instance_id
            )
            AND EXISTS (
              SELECT 1 FROM events e
              WHERE e.id = event_cover_publish_receipts.event_id
                AND e.deleted_at IS NULL
                AND e.cover_revision = event_cover_publish_receipts.expected_revision
            )
          )
        )
    `).bind(
      failureCode, retryable ? 1 : 0, timestamp,
      new Date(now.getTime() + RECEIPT_TERMINAL_TTL_MS).toISOString(),
      payload.eventId, payload.operationId, generation,
      renderSetId ?? null, draftId ?? null,
      COVER_RENDER_BINDING, COVER_RENDER_BINDING,
    ),
  ];
  // Only a permanent failure releases the draft. A retryable one keeps it
  // `publishing` and its staging set intact through the restart window.
  if (!retryable && renderSetId && draftId) {
    statements.push(
      env.DB.prepare(`
        UPDATE event_cover_render_sets
        SET state = 'abandoned', abandoned_reason = ?, abandoned_at = ?, cleanup_after = ?
        WHERE id = ? AND state IN ('staging', 'ready') AND changes() = 1
      `).bind(
        failureCode, timestamp,
        new Date(now.getTime() + RETIRED_RECOVERY_MS).toISOString(), renderSetId,
      ),
      env.DB.prepare(`
        UPDATE event_cover_drafts
        SET state = 'ready', draft_revision = draft_revision + 1, updated_at = ?
        WHERE id = ? AND state = 'publishing' AND changes() = 1
      `).bind(timestamp, draftId),
    );
  }
  statements.push(terminalFenceStatement(env, payload, generation, now, true));
  const results = await env.DB.batch(statements);
  return (results[0]?.meta.changes ?? 0) === 1;
}

export { COVER_PIPELINE_VERSIONS };

import {
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_INSPECTIONS_PER_HOUR,
  MAX_COVER_PREVIEWS_PER_HOUR,
  MAX_COVER_RESERVATIONS_PER_HOUR,
  MAX_COVER_UPLOAD_BYTES,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import {
  COVER_PIPELINE_VERSIONS,
  EVENT_COVER_EFFECTS,
  type EventCoverDraftCreateRequestV1,
  type EventCoverEffectId,
  type EventCoverProfileId,
  parseStoredCoverConfig,
  qualifiedCover2xProfiles,
  resolvedCoverFocusPoint,
  safeCoverZoomMaximum,
} from '../../shared/event-cover';
import {
  adoptCoverInspection,
  adoptCoverPreview,
  scheduleCoverMasterCleanup,
  chargeCoverRateEvent,
  claimCoverRawIngress,
  clearCoverRawPointer,
  createCoverDraft,
  failCoverDraft,
  insertCoverMaster,
  loadCoverDraft,
  recordVerifiedCoverRaw,
  replayCoverDraftReservation,
} from '../db/event-covers';
import type { CoverDraftPreviewRow, CoverDraftRow, CoverMasterRow, EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { coverMasterKey, coverRawKey } from '../storage/event-cover-keys';
import { normalizeCoverMaster, renderCoverPreview } from '../storage/event-cover-images';

/**
 * The draft half of the cover pipeline, between the routes and the services.
 *
 * Routes authorize and translate HTTP; they do not build object keys, Images
 * recipes, or state transitions. Everything below composes the storage,
 * rendering, and inventory pieces into the four things a draft can do —
 * reserve, receive bytes, be inspected, and show a preview — and returns the
 * one safe projection a manager is allowed to see.
 */

/** The safe draft projection. No object key, checksum, or recipe appears here. */
export interface EventCoverDraftView {
  id: string;
  source: 'new-upload' | 'existing-upload';
  state: CoverDraftRow['state'];
  revision: number;
  expiresAt: string;
  compositionModelVersion: number;
  master: {
    width: number;
    height: number;
    safeZoomMaximum: number;
    available2xProfiles: readonly EventCoverProfileId[];
  } | null;
  focus: { x: number; y: number; modelVersion: number } | null;
  preview: {
    effect: string;
    width: number;
    height: number;
    byteSize: number;
    recipeVersion: number;
  } | null;
}

export async function coverDraftView(
  env: AppEnv,
  draft: CoverDraftRow,
): Promise<EventCoverDraftView> {
  const master = draft.master_id
    ? await env.DB.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
      .bind(draft.master_id).first<CoverMasterRow>()
    : null;
  const preview = await env.DB.prepare(`
    SELECT * FROM event_cover_draft_previews
    WHERE draft_id = ? AND effect_id = 'natural' AND state = 'ready'
  `).bind(draft.id).first<CoverDraftPreviewRow>();

  // The automatic point is the master's until a composition write copies it onto
  // the draft, which is what makes `Reset to automatic` always have something
  // true to return to.
  const point = resolvedCoverFocusPoint(
    { mode: 'auto' },
    master ? { x: master.auto_focus_x ?? 0.5, y: master.auto_focus_y ?? 0.5 } : null,
  );

  return {
    id: draft.id,
    source: draft.source === 'new_upload' ? 'new-upload' : 'existing-upload',
    state: draft.state,
    revision: draft.draft_revision,
    expiresAt: draft.expires_at,
    compositionModelVersion: COVER_PIPELINE_VERSIONS.compositionModel,
    master: master
      ? {
        width: master.width,
        height: master.height,
        safeZoomMaximum: safeCoverZoomMaximum(master),
        available2xProfiles: qualifiedCover2xProfiles(master, point),
      }
      : null,
    focus: draft.focus_x !== null && draft.focus_y !== null
      ? {
        x: draft.focus_x,
        y: draft.focus_y,
        modelVersion: draft.composition_model_version ?? COVER_PIPELINE_VERSIONS.compositionModel,
      }
      : null,
    preview: preview && preview.width !== null && preview.height !== null && preview.byte_size !== null
      ? {
        effect: preview.effect_id,
        width: preview.width,
        height: preview.height,
        byteSize: preview.byte_size,
        recipeVersion: preview.recipe_version,
      }
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Reservation
 * ------------------------------------------------------------------ */

export interface CoverDraftReservationResult {
  draft: CoverDraftRow;
  replayed: boolean;
}

export async function reserveCoverDraft(
  env: AppEnv,
  input: {
    event: EventRecord;
    request: EventCoverDraftCreateRequestV1;
    requestDigest: string;
    now: Date;
  },
): Promise<CoverDraftReservationResult> {
  const { event, request, requestDigest, now } = input;

  // Charged before the draft exists, and keyed by the client's intent so a lost
  // reservation response replays without consuming a second slot.
  await chargeCoverRateEvent(env.DB, {
    eventId: event.id,
    action: 'reservation',
    replayKey: request.draftIntentId,
    requestDigest,
    limit: MAX_COVER_RESERVATIONS_PER_HOUR,
    now,
  });

  // Resolve an already-committed intent before consulting today's event
  // pointers. A caller replaying a lost response owns the original request,
  // even when another publication has advanced the active cover since then.
  const replay = await replayCoverDraftReservation(env.DB, {
    eventId: event.id,
    draftIntentId: request.draftIntentId,
    requestDigest,
  });
  if (replay) return replay;

  // `in` rather than `request.source.kind`: the union discriminates on a nested
  // key, which is exactly why `z.discriminatedUnion` could not express it either.
  if ('mimeType' in request) {
    // The schema already pinned the four-member MIME tuple and the decimal
    // ceiling; this is the server restating them over its own constants rather
    // than trusting a parsed shape to have been built from the same list.
    if (!(COVER_UPLOAD_MIME_TYPES as readonly string[]).includes(request.mimeType)) {
      throw new ApiError('COVER_SOURCE_UNSUPPORTED', unsupportedSourceMessage(), 422);
    }
    if (request.byteSize > MAX_COVER_UPLOAD_BYTES) {
      throw new ApiError('COVER_SOURCE_UNSUPPORTED', oversizeSourceMessage(), 422);
    }
    return createCoverDraft(env.DB, {
      eventId: event.id,
      draftIntentId: request.draftIntentId,
      requestDigest,
      source: 'new_upload',
      filename: request.filename,
      mimeType: request.mimeType,
      byteSize: request.byteSize,
      now,
    });
  }

  // The existing-upload branch resolves the master entirely on the server. It
  // accepts no object key, URL, or source identifier — only the revision it
  // expects still to name an active uploaded cover.
  const config = parseStoredCoverConfig(safeJson(event.coverConfig));
  if (
    event.coverRevision !== request.expectedCoverRevision
    || config?.source.kind !== 'upload'
    || !event.coverRenderSetId
  ) {
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'This cover has moved on since this page loaded. Reload and try again.',
      409,
    );
  }
  const master = await env.DB.prepare(`
    SELECT masters.* FROM event_cover_masters masters
    JOIN event_cover_render_sets sets ON sets.master_id = masters.id
    WHERE sets.id = ? AND sets.event_id = ?
  `).bind(event.coverRenderSetId, event.id).first<CoverMasterRow>();
  if (!master) {
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'This cover cannot be edited right now. Reload and try again.',
      409,
    );
  }

  return createCoverDraft(env.DB, {
    eventId: event.id,
    draftIntentId: request.draftIntentId,
    requestDigest,
    source: 'existing_upload',
    masterId: master.id,
    now,
  });
}

/* ------------------------------------------------------------------ *
 * Bounded raw ingress
 * ------------------------------------------------------------------ */

class CoverIngressOverflow extends Error {}

/**
 * The runtime's own length complaint, which is a client problem, not ours.
 *
 * `FixedLengthStream` rejects a body that stops short or runs long with a
 * `TypeError`. That is the interrupted upload, so it maps to the same corrective
 * answer rather than escaping as an `INTERNAL_ERROR`.
 */
function isStreamLengthError(reason: unknown): boolean {
  return reason instanceof TypeError && /bytes|length/iu.test(reason.message);
}

export async function receiveCoverRaw(
  env: AppEnv,
  input: {
    event: EventRecord;
    draft: CoverDraftRow;
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: number;
    now: Date;
  },
): Promise<CoverDraftRow> {
  const { event, draft, contentLength, now } = input;
  const declared = draft.declared_byte_size ?? 0;

  if (draft.state !== 'reserved') {
    // A verified transfer replays rather than allocating another raw slot.
    if (draft.state === 'transferred' && draft.verified_raw_byte_size === contentLength) return draft;
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'That cover upload has moved on since this page loaded. Reload and try again.',
      409,
    );
  }
  if (input.contentType !== draft.declared_mime_type) {
    throw new ApiError('COVER_SOURCE_UNSUPPORTED', 'That file type does not match the one this upload reserved.', 415);
  }
  if (contentLength !== declared) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'That photo is a different size than the one this upload reserved. Choose it again.',
      422,
    );
  }
  if (contentLength > MAX_COVER_UPLOAD_BYTES) {
    throw new ApiError('COVER_SOURCE_UNSUPPORTED', oversizeSourceMessage(), 413);
  }

  // Recorded before a single byte is written, so a crash mid-transfer leaves
  // charged, sweepable inventory rather than bytes nothing can find again.
  const claim = await claimCoverRawIngress(env.DB, {
    draftId: draft.id,
    eventId: event.id,
    expectedDraftRevision: draft.draft_revision,
    now,
  });
  const claimed = await loadCoverDraft(env.DB, draft.id, event.id);

  let observed = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      observed += chunk.byteLength;
      // Aborts as soon as the byte after the declaration arrives. The whole
      // photo is never buffered: chunks pass straight through to the R2 write.
      if (observed > declared || observed > MAX_COVER_UPLOAD_BYTES) {
        controller.error(new CoverIngressOverflow());
        return;
      }
      controller.enqueue(chunk);
    },
  });

  // R2 will not accept a stream of unknown length, and `FixedLengthStream` is
  // the runtime's own enforcement of the exact count: a body that stops early
  // fails on close just as surely as one that runs long fails in the counter
  // above. Between the two, `declared` is the only byte count that can ever
  // reach the bucket, and none of it is buffered here.
  const fixed = new FixedLengthStream(declared);
  const upload = env.MEDIA_BUCKET.put(claim.objectKey, fixed.readable, {
    httpMetadata: { contentType: input.contentType },
  });
  const pump = input.body.pipeThrough(counted).pipeTo(fixed.writable);
  const settled = await Promise.allSettled([pump, upload]);
  const failure = settled.find((result) => result.status === 'rejected');

  if (failure || observed !== declared) {
    await discardPartialRaw(env, event.id, draft.id, claim.objectKey, now);
    const reason = failure?.status === 'rejected' ? failure.reason : null;
    if (reason && !(reason instanceof CoverIngressOverflow) && !isStreamLengthError(reason)) {
      throw reason;
    }
    throw new ApiError(
      'VALIDATION_FAILED',
      'That upload did not finish. Choose the photo again.',
      413,
    );
  }

  const stored = await env.MEDIA_BUCKET.head(claim.objectKey);
  if (!stored || stored.size !== declared) {
    await discardPartialRaw(env, event.id, draft.id, claim.objectKey, now);
    throw new ApiError('VALIDATION_FAILED', 'That upload could not be verified. Try again.', 409);
  }

  return recordVerifiedCoverRaw(env.DB, {
    draftId: draft.id,
    eventId: event.id,
    expectedDraftRevision: claimed.draft_revision,
    verifiedByteSize: stored.size,
    etag: stored.etag ?? null,
    now,
  });
}

/**
 * Deletes a partial and only then stops charging for it.
 *
 * If the delete fails, the draft is marked failed with its pointer and size
 * intact: those bytes may still be in the bucket, and the aggregate must keep
 * counting them until a bounded cleanup pass proves otherwise.
 */
async function discardPartialRaw(
  env: AppEnv,
  eventId: string,
  draftId: string,
  objectKey: string,
  now: Date,
): Promise<void> {
  try {
    await env.MEDIA_BUCKET.delete(objectKey);
    if (await env.MEDIA_BUCKET.head(objectKey)) throw new Error('Partial cover raw survived deletion.');
  } catch {
    await failCoverDraft(env.DB, { draftId, eventId, failureCode: 'COVER_SOURCE_UNSUPPORTED', now });
    return;
  }
  // Confirmed absent: the same draft may be retried rather than forcing the
  // host back through a fresh reservation.
  await clearCoverRawPointer(env.DB, {
    draftId, eventId, state: 'reserved', objectKey, now,
  });
}

/* ------------------------------------------------------------------ *
 * Inspection
 * ------------------------------------------------------------------ */

export async function inspectCoverDraft(
  env: AppEnv,
  input: { event: EventRecord; draft: CoverDraftRow; now: Date },
): Promise<CoverDraftRow> {
  const { event, draft, now } = input;
  if (draft.state === 'inspected' || draft.state === 'ready') return draft;
  if (draft.state !== 'transferred' || !draft.raw_object_key) {
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'That photo has not finished uploading yet. Try again in a moment.',
      409,
    );
  }

  await chargeCoverRateEvent(env.DB, {
    eventId: event.id,
    action: 'inspection',
    replayKey: `${draft.id}:${COVER_PIPELINE_VERSIONS.inspectionRecipe}`,
    requestDigest: draft.request_sha256,
    limit: MAX_COVER_INSPECTIONS_PER_HOUR,
    now,
  });

  const masterId = crypto.randomUUID();
  let master;
  try {
    // The stored object is rechecked before its bytes reach Images: the size
    // against what the transfer verified, and the decoded type against what the
    // reservation declared.
    const stored = await env.MEDIA_BUCKET.head(draft.raw_object_key);
    if (!stored || (draft.verified_raw_byte_size !== null && stored.size !== draft.verified_raw_byte_size)) {
      throw new ApiError(
        'COVER_SOURCE_UNSUPPORTED',
        'That upload could not be verified. Choose the photo again.',
        409,
      );
    }
    master = await normalizeCoverMaster(env, {
      eventId: event.id,
      masterId,
      rawKey: draft.raw_object_key,
      declaredMimeType: draft.declared_mime_type,
    });
  } catch (error) {
    // A rejected source never waits until `Done`, and it never touches the
    // active cover. The raw goes; the master was never written.
    await env.MEDIA_BUCKET.delete(coverRawKey(event.id, draft.id)).catch(() => undefined);
    await failCoverDraft(env.DB, {
      draftId: draft.id,
      eventId: event.id,
      failureCode: error instanceof ApiError ? error.code : 'COVER_SOURCE_UNSUPPORTED',
      now,
    });
    throw error;
  }

  await insertCoverMaster(env.DB, {
    id: masterId,
    eventId: event.id,
    objectKey: master.objectKey,
    byteSize: master.byteSize,
    width: master.width,
    height: master.height,
    sha256: master.sha256,
    normalizationVersion: master.normalizationVersion,
    normalizationRung: master.rung,
    now,
  });
  const inspected = await adoptCoverInspection(env.DB, {
    draftId: draft.id,
    eventId: event.id,
    expectedDraftRevision: draft.draft_revision,
    masterId,
    inspection: {
      recipeVersion: COVER_PIPELINE_VERSIONS.inspectionRecipe,
      normalizationRung: master.rung,
      width: master.width,
      height: master.height,
    },
    now,
  });

  const rawKey = coverRawKey(event.id, draft.id);

  // The natural preview is what the browser composition worker decodes, so it
  // is produced here rather than on a later request the host would wait for.
  try {
    await renderAndAdoptPreview(env, event.id, inspected, masterId, 'natural', now);
  } catch (error) {
    // §10.1: a natural-preview exhaustion permanently fails inspection and makes
    // its new master and raw eligible for cleanup. Leaving the draft `inspected`
    // would keep both charged against the event's budget for a photo that can
    // never be published, and three of them would exhaust the draft cap.
    await releaseInspectionArtifacts(env, event.id, draft.id, masterId, rawKey, 'inspected', now);
    await failCoverDraft(env.DB, {
      draftId: draft.id,
      eventId: event.id,
      failureCode: error instanceof ApiError ? error.code : 'COVER_PREVIEW_BUDGET_EXHAUSTED',
      now,
    });
    throw error;
  }

  // Only now is the raw disposable: the master is durable and verified. The
  // pointer stops charging only after R2 absence is confirmed, so a failed
  // delete leaves the bytes counted rather than silently forgiven.
  await env.MEDIA_BUCKET.delete(rawKey).catch(() => undefined);
  if (!(await env.MEDIA_BUCKET.head(rawKey))) {
    await clearCoverRawPointer(env.DB, {
      draftId: draft.id,
      eventId: event.id,
      state: 'inspected',
      objectKey: rawKey,
      now,
    });
  }

  return loadCoverDraft(env.DB, draft.id, event.id);
}

/**
 * Deletes an inspection's own artifacts, then stops charging for them.
 *
 * Absence is proven before the pointer is cleared, in that order, so a failed
 * delete leaves the bytes counted for a later bounded pass rather than silently
 * forgiven.
 */
async function releaseInspectionArtifacts(
  env: AppEnv,
  eventId: string,
  draftId: string,
  masterId: string,
  rawKey: string,
  state: 'reserved' | 'inspected',
  now: Date,
): Promise<void> {
  await env.MEDIA_BUCKET.delete(rawKey).catch(() => undefined);
  if (!(await env.MEDIA_BUCKET.head(rawKey))) {
    await clearCoverRawPointer(env.DB, { draftId, eventId, state, objectKey: rawKey, now });
  }
  await scheduleCoverMasterCleanup(env.DB, { masterId, cleanupAfter: now });
}

/* ------------------------------------------------------------------ *
 * Bounded previews
 * ------------------------------------------------------------------ */

export interface CoverPreviewDelivery {
  body: ReadableStream;
  contentType: string;
  byteSize: number;
}

export async function readCoverDraftPreview(
  env: AppEnv,
  input: {
    event: EventRecord;
    draft: CoverDraftRow;
    effect: string;
    now: Date;
  },
): Promise<CoverPreviewDelivery> {
  const effect = requireCoverEffect(input.effect);
  if (!input.draft.master_id) {
    throw new ApiError(
      'COVER_DRAFT_STATE_CONFLICT',
      'That photo has not been prepared yet. Try again in a moment.',
      409,
    );
  }

  const existing = await env.DB.prepare(`
    SELECT * FROM event_cover_draft_previews
    WHERE draft_id = ? AND effect_id = ? AND recipe_version = ?
  `).bind(input.draft.id, effect, COVER_PIPELINE_VERSIONS.previewRecipe)
    .first<CoverDraftPreviewRow>();

  if (existing?.state === 'ready' && existing.object_key) {
    return deliverPreview(env, existing.object_key, existing.byte_size ?? 0);
  }
  if (existing?.state === 'failed' && existing.retryable === 0) {
    throw new ApiError(
      'COVER_PREVIEW_BUDGET_EXHAUSTED',
      'That style could not be prepared for this photo. Choose another style or another photo.',
      422,
    );
  }

  await chargeCoverRateEvent(env.DB, {
    eventId: input.event.id,
    action: 'preview',
    replayKey: `${input.draft.id}:${effect}:${COVER_PIPELINE_VERSIONS.previewRecipe}`,
    requestDigest: input.draft.request_sha256,
    limit: MAX_COVER_PREVIEWS_PER_HOUR,
    now: input.now,
  });

  const adopted = await renderAndAdoptPreview(
    env,
    input.event.id,
    input.draft,
    input.draft.master_id,
    effect,
    input.now,
  );
  return deliverPreview(env, adopted.object_key!, adopted.byte_size ?? 0);
}

async function renderAndAdoptPreview(
  env: AppEnv,
  eventId: string,
  draft: CoverDraftRow,
  masterId: string,
  effect: EventCoverEffectId,
  now: Date,
): Promise<CoverDraftPreviewRow> {
  try {
    const preview = await renderCoverPreview(env, {
      eventId,
      draftId: draft.id,
      masterKey: coverMasterKey(eventId, masterId),
      effect,
    });
    const adoption = await adoptCoverPreview(env.DB, {
      draftId: draft.id,
      eventId,
      effect,
      recipeVersion: preview.recipeVersion,
      objectKey: preview.objectKey,
      byteSize: preview.byteSize,
      width: preview.width,
      height: preview.height,
      ladderRung: preview.rung,
      sha256: preview.sha256,
      now,
    });
    return adoption.row;
  } catch (error) {
    // A terminal ladder exhaustion is stored for this exact draft/effect/recipe
    // tuple, so an identical request replays the answer instead of putting a
    // dense image through the same four rungs forever.
    if (error instanceof ApiError && error.code === 'COVER_PREVIEW_BUDGET_EXHAUSTED') {
      await adoptCoverPreview(env.DB, {
        draftId: draft.id,
        eventId,
        effect,
        recipeVersion: COVER_PIPELINE_VERSIONS.previewRecipe,
        failureCode: error.code,
        retryable: false,
        now,
      });
    }
    throw error;
  }
}

async function deliverPreview(
  env: AppEnv,
  objectKey: string,
  byteSize: number,
): Promise<CoverPreviewDelivery> {
  const object = await env.MEDIA_BUCKET.get(objectKey);
  if (!object) {
    throw new ApiError(
      'COVER_RENDER_UNAVAILABLE',
      'That preview is no longer available. Try again.',
      409,
    );
  }
  return { body: object.body!, contentType: 'image/webp', byteSize: byteSize || object.size };
}

/** The effect is a path enum against the server's allowlist, never free text. */
function requireCoverEffect(value: string): EventCoverEffectId {
  const effect = (EVENT_COVER_EFFECTS as readonly string[]).includes(value)
    ? value as EventCoverEffectId
    : null;
  if (!effect) {
    throw new ApiError('VALIDATION_FAILED', 'That cover style is not available.', 422);
  }
  return effect;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function unsupportedSourceMessage(): string {
  return 'Choose a JPEG, PNG, WebP, or HEIC photo.';
}

function oversizeSourceMessage(): string {
  return 'Cover photos need to be under 19 MB. Choose a smaller photo.';
}

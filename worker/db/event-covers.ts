import {
  MAX_COVER_PREVIEW_BYTES,
  MAX_COVER_PREVIEW_BYTES_PER_DRAFT,
  MAX_COVER_PREVIEW_FILES_PER_DRAFT,
  MAX_LIVE_COVER_DRAFTS_PER_EVENT,
  MAX_LIVE_COVER_RAW_BYTES_PER_EVENT,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { coverRawKey } from '../storage/event-cover-keys';
import type {
  CoverDraftPreviewRow,
  CoverDraftRow,
  CoverMasterRow,
  CoverRateAction,
} from './types';

/**
 * Durable inventory for the cover pipeline.
 *
 * `EventsRepository` uses `db.batch` zero times, so the guarded-batch convention
 * `CLAUDE.md` mandates lives here for the cover surface: the guard goes in the
 * first statement's `WHERE`, later statements append `AND changes() = 1`, the
 * caller checks `results[0].meta.changes === 1`, and the error is derived from
 * the state as it actually stands rather than from what the caller assumed.
 *
 * Idempotency is read-then-classify. `ExportsRepository.createActive` wraps its
 * INSERT in a bare try/catch and rethrows a 409, which cannot tell a
 * same-intent, same-digest replay from a genuine conflict; this follows
 * `MediaRepository.reserve`, which re-reads before deciding.
 */

const LIVE_DRAFT_STATES = "('reserved', 'transferred', 'inspected', 'ready', 'publishing')";

/**
 * The event's charged raw bytes, as one reusable scalar subquery.
 *
 * Reservation, ingress completion, discard, and cleanup all read exactly this,
 * so repeated upload/discard cycles cannot drift past the bound by disagreeing
 * about what counts. The aggregate is inventory-based and is deliberately not
 * released by a state label: a draft marked `expired` still owns whatever bytes
 * may be sitting in R2, and only verified absence releases them.
 */
export function liveCoverRawBytesSql(alias = 'raw'): string {
  return `SELECT COALESCE(SUM(CASE
      WHEN ${alias}.raw_object_key IS NOT NULL
        THEN MAX(COALESCE(${alias}.declared_byte_size, 0), COALESCE(${alias}.verified_raw_byte_size, 0))
      WHEN ${alias}.source = 'new_upload' AND ${alias}.state IN ('reserved', 'transferred')
        THEN COALESCE(${alias}.declared_byte_size, 0)
      ELSE 0
    END), 0)
    FROM event_cover_drafts ${alias} WHERE ${alias}.event_id = ?`;
}

export async function liveCoverRawBytes(db: D1Database, eventId: string): Promise<number> {
  const row = await db.prepare(`SELECT (${liveCoverRawBytesSql()}) AS bytes`).bind(eventId)
    .first<{ bytes: number }>();
  return row?.bytes ?? 0;
}

function draftConflict(message: string, status = 409): ApiError {
  return new ApiError('COVER_DRAFT_STATE_CONFLICT', message, status);
}

async function requireDraft(db: D1Database, draftId: string, eventId: string): Promise<CoverDraftRow> {
  const row = await db.prepare('SELECT * FROM event_cover_drafts WHERE id = ? AND event_id = ?')
    .bind(draftId, eventId).first<CoverDraftRow>();
  if (!row) throw draftConflict('That cover draft is no longer available. Start again.', 404);
  return row;
}

/* ------------------------------------------------------------------ *
 * Masters
 * ------------------------------------------------------------------ */

export interface InsertCoverMasterInput {
  id: string;
  eventId: string;
  objectKey: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
  normalizationVersion: number;
  normalizationRung: number;
  now: Date;
}

export async function insertCoverMaster(
  db: D1Database,
  input: InsertCoverMasterInput,
): Promise<CoverMasterRow> {
  await db.prepare(`
    INSERT INTO event_cover_masters (
      id, event_id, object_key, mime_type, byte_size, width, height, sha256,
      normalization_version, normalization_rung, created_at
    ) VALUES (?, ?, ?, 'image/webp', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.id, input.eventId, input.objectKey, input.byteSize, input.width, input.height,
    input.sha256, input.normalizationVersion, input.normalizationRung, input.now.toISOString(),
  ).run();
  return (await db.prepare('SELECT * FROM event_cover_masters WHERE id = ?')
    .bind(input.id).first<CoverMasterRow>())!;
}

/* ------------------------------------------------------------------ *
 * Drafts
 * ------------------------------------------------------------------ */

export interface CreateCoverDraftInput {
  eventId: string;
  draftIntentId: string;
  requestDigest: string;
  source: 'new_upload' | 'existing_upload';
  filename?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
  masterId?: string | null;
  now: Date;
}

export interface CoverDraftReservation {
  draft: CoverDraftRow;
  replayed: boolean;
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 60 * 60 * 1000;

export async function replayCoverDraftReservation(
  db: D1Database,
  input: Pick<CreateCoverDraftInput, 'eventId' | 'draftIntentId' | 'requestDigest'>,
): Promise<CoverDraftReservation | null> {
  const existing = await db.prepare(
    'SELECT * FROM event_cover_drafts WHERE event_id = ? AND draft_intent_id = ?',
  ).bind(input.eventId, input.draftIntentId).first<CoverDraftRow>();
  if (!existing) return null;
  if (existing.request_sha256 !== input.requestDigest) {
    throw draftConflict('That upload was already started with different details. Start a new one.');
  }
  return { draft: existing, replayed: true };
}

export async function createCoverDraft(
  db: D1Database,
  input: CreateCoverDraftInput,
): Promise<CoverDraftReservation> {
  // Read-then-classify. A lost reservation response must replay into the same
  // draft rather than consuming a second live slot or another rate event.
  const replay = await replayCoverDraftReservation(db, input);
  if (replay) return replay;

  const id = crypto.randomUUID();
  const timestamp = input.now.toISOString();
  const declared = input.byteSize ?? 0;
  // An existing-upload draft references the event's ready master, owns no raw,
  // and may begin ready; a new upload starts reserved and waits for bytes.
  const state = input.source === 'existing_upload' ? 'ready' : 'reserved';

  const statements = [
    db.prepare(`
      INSERT INTO event_cover_drafts (
        id, event_id, source, state, draft_intent_id, request_sha256, draft_revision,
        declared_filename, declared_mime_type, declared_byte_size, master_id,
        created_at, updated_at, reservation_expires_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (
        SELECT count(*) FROM event_cover_drafts live
        WHERE live.event_id = ? AND live.state IN ${LIVE_DRAFT_STATES}
      ) < ?
      AND (${liveCoverRawBytesSql()}) + ? <= ?
    `).bind(
      id, input.eventId, input.source, state, input.draftIntentId, input.requestDigest,
      input.filename ?? null, input.mimeType ?? null, input.byteSize ?? null, input.masterId ?? null,
      timestamp, timestamp,
      input.source === 'new_upload' ? new Date(input.now.getTime() + RESERVATION_TTL_MS).toISOString() : null,
      new Date(input.now.getTime() + DRAFT_TTL_MS).toISOString(),
      input.eventId, MAX_LIVE_COVER_DRAFTS_PER_EVENT,
      input.eventId, declared, MAX_LIVE_COVER_RAW_BYTES_PER_EVENT,
    ),
  ];
  if (input.masterId) {
    // The master owns the automatic point, so an edit draft starts from it and
    // `Reset to automatic` always has something true to return to.
    statements.push(db.prepare(`
      UPDATE event_cover_drafts SET
        focus_x = (SELECT auto_focus_x FROM event_cover_masters WHERE id = ?),
        focus_y = (SELECT auto_focus_y FROM event_cover_masters WHERE id = ?),
        composition_model_version = (SELECT composition_model_version FROM event_cover_masters WHERE id = ?)
      WHERE id = ? AND changes() = 1
    `).bind(input.masterId, input.masterId, input.masterId, id));
  }

  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    // A concurrent request with the same intent won the unique index.
    const raced = await db.prepare(
      'SELECT * FROM event_cover_drafts WHERE event_id = ? AND draft_intent_id = ?',
    ).bind(input.eventId, input.draftIntentId).first<CoverDraftRow>();
    if (raced && raced.request_sha256 === input.requestDigest) return { draft: raced, replayed: true };
    throw error;
  }

  if ((results[0]?.meta.changes ?? 0) !== 1) throw await draftCapacityError(db, input, declared);

  const draft = await db.prepare('SELECT * FROM event_cover_drafts WHERE id = ?')
    .bind(id).first<CoverDraftRow>();
  if (!draft) throw new Error('Reserved cover draft row was not created.');
  return { draft, replayed: false };
}

/** Which cap actually stopped it, read from the state as it now stands. */
async function draftCapacityError(
  db: D1Database,
  input: CreateCoverDraftInput,
  declared: number,
): Promise<ApiError> {
  const live = await db.prepare(`
    SELECT count(*) AS count FROM event_cover_drafts
    WHERE event_id = ? AND state IN ${LIVE_DRAFT_STATES}
  `).bind(input.eventId).first<{ count: number }>();
  if ((live?.count ?? 0) >= MAX_LIVE_COVER_DRAFTS_PER_EVENT) {
    return new ApiError(
      'COVER_DRAFT_LIMIT',
      'You already have three cover photos in progress. Finish or discard one, then try again.',
      409,
    );
  }
  const bytes = await liveCoverRawBytes(db, input.eventId);
  if (bytes + declared > MAX_LIVE_COVER_RAW_BYTES_PER_EVENT) {
    return new ApiError(
      'COVER_RAW_STORAGE_LIMIT',
      'There is not enough room for another cover photo yet. Discard one you are not using, then try again.',
      409,
    );
  }
  return draftConflict('That cover upload could not be started. Reload and try again.');
}

export interface CoverRawIngressClaim {
  objectKey: string;
  replayed: boolean;
}

/**
 * Records the raw key before a single byte is written.
 *
 * Deliberately not at reservation and deliberately not after the write: a key
 * recorded afterwards means a crash mid-transfer leaves bytes that no inventory
 * row accounts for, and those are exactly the bytes nothing would ever find
 * again. Recorded first, they are charged and sweepable even if the write dies.
 */
export async function claimCoverRawIngress(
  db: D1Database,
  input: { draftId: string; eventId: string; expectedDraftRevision: number; now: Date },
): Promise<CoverRawIngressClaim> {
  const expectedKey = coverRawKey(input.eventId, input.draftId);
  const current = await requireDraft(db, input.draftId, input.eventId);
  // A retry after a confirmed-absent partial re-enters the same slot rather
  // than allocating another — but only while it still holds the current
  // revision. Without that, two in-flight PUTs that both read revision N both
  // "replay" into the same key: the winner clears the pointer that charged for
  // it, and the loser's completed object is orphaned in R2 with no inventory
  // row behind it.
  if (current.raw_object_key === expectedKey
    && current.state === 'reserved'
    && current.draft_revision === input.expectedDraftRevision) {
    return { objectKey: expectedKey, replayed: true };
  }
  const result = await db.prepare(`
    UPDATE event_cover_drafts
    SET raw_object_key = ?, draft_revision = draft_revision + 1, updated_at = ?
    WHERE id = ? AND event_id = ? AND draft_revision = ?
      AND state = 'reserved' AND raw_object_key IS NULL
  `).bind(expectedKey, input.now.toISOString(), input.draftId, input.eventId, input.expectedDraftRevision)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw draftConflict('That cover upload has moved on since this page loaded. Reload and try again.');
  }
  return { objectKey: expectedKey, replayed: false };
}

export async function recordVerifiedCoverRaw(
  db: D1Database,
  input: {
    draftId: string;
    eventId: string;
    expectedDraftRevision: number;
    verifiedByteSize: number;
    etag: string | null;
    now: Date;
  },
): Promise<CoverDraftRow> {
  const result = await db.prepare(`
    UPDATE event_cover_drafts
    SET verified_raw_byte_size = ?, raw_etag = ?, state = 'transferred',
        draft_revision = draft_revision + 1, updated_at = ?
    WHERE id = ? AND event_id = ? AND draft_revision = ?
      AND state = 'reserved' AND raw_object_key IS NOT NULL
  `).bind(
    input.verifiedByteSize, input.etag, input.now.toISOString(),
    input.draftId, input.eventId, input.expectedDraftRevision,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw draftConflict('That cover upload has moved on since this page loaded. Reload and try again.');
  }
  return requireDraft(db, input.draftId, input.eventId);
}

/** The event-scoped read every cover route resolves ownership through. */
export async function loadCoverDraft(
  db: D1Database,
  draftId: string,
  eventId: string,
): Promise<CoverDraftRow> {
  return requireDraft(db, draftId, eventId);
}

/**
 * Adopts a verified master and moves `transferred -> inspected`.
 *
 * The master is written first and adopted here, so a crash between the two
 * leaves an unreferenced master for cleanup rather than a draft pointing at
 * bytes that were never verified. The automatic focal point is deliberately not
 * set here: it arrives from the browser composition worker through the guarded
 * composition write, which is the only thing that may move the draft to `ready`.
 */
export async function adoptCoverInspection(
  db: D1Database,
  input: {
    draftId: string;
    eventId: string;
    expectedDraftRevision: number;
    masterId: string;
    inspection: unknown;
    now: Date;
  },
): Promise<CoverDraftRow> {
  const current = await requireDraft(db, input.draftId, input.eventId);
  // An identical replay returns the inspected draft rather than normalizing a
  // second time; inspection is the most expensive step in the pipeline.
  if (current.state === 'inspected' && current.master_id === input.masterId) return current;

  const result = await db.prepare(`
    UPDATE event_cover_drafts
    SET state = 'inspected', master_id = ?, inspection_json = ?,
        draft_revision = draft_revision + 1, updated_at = ?
    WHERE id = ? AND event_id = ? AND draft_revision = ?
      AND state = 'transferred' AND master_id IS NULL
  `).bind(
    input.masterId, JSON.stringify(input.inspection), input.now.toISOString(),
    input.draftId, input.eventId, input.expectedDraftRevision,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw draftConflict('That cover upload has moved on since this page loaded. Reload and try again.');
  }
  return requireDraft(db, input.draftId, input.eventId);
}

/**
 * Records a terminal draft failure without touching the active cover.
 *
 * The raw pointer is left in place on purpose: it is still charging for bytes
 * that may be sitting in R2, and only verified absence may release them.
 */
export async function failCoverDraft(
  db: D1Database,
  input: { draftId: string; eventId: string; failureCode: string; now: Date },
): Promise<void> {
  await db.prepare(`
    UPDATE event_cover_drafts
    SET state = 'failed', failure_code = ?, draft_revision = draft_revision + 1, updated_at = ?
    WHERE id = ? AND event_id = ? AND state NOT IN ('publishing', 'published')
  `).bind(input.failureCode, input.now.toISOString(), input.draftId, input.eventId).run();
}

/**
 * Clears a raw pointer whose object the caller has proven absent from R2.
 *
 * Separate from `releaseCoverRawBytes` because these are the two *live* states
 * where releasing is correct, and each is narrow. `reserved` is an interrupted
 * transfer whose partial was deleted and verified gone, which is what makes a
 * same-draft retry possible rather than forcing a new reservation. `inspected`
 * is a successful normalization: the master is durable and the raw is gone, and
 * continuing to charge for it would let three ordinary uploads exhaust an
 * event's 57,000,000-byte budget with nothing in the bucket.
 *
 * The state travels as a bound parameter rather than as interpolated SQL, so the
 * guard stays a guard.
 */
export async function clearCoverRawPointer(
  db: D1Database,
  input: {
    draftId: string;
    eventId: string;
    state: 'reserved' | 'inspected';
    /** The exact key the caller proved absent, never whatever is there now. */
    objectKey: string;
    now: Date;
  },
): Promise<void> {
  await db.prepare(`
    UPDATE event_cover_drafts
    SET raw_object_key = NULL, verified_raw_byte_size = NULL, updated_at = ?
    WHERE id = ? AND event_id = ? AND state = ? AND raw_object_key = ?
  `).bind(
    input.now.toISOString(), input.draftId, input.eventId, input.state, input.objectKey,
  ).run();
}

/** Makes a master cleanup-eligible once nothing can reference it again. */
export async function scheduleCoverMasterCleanup(
  db: D1Database,
  input: { masterId: string; cleanupAfter: Date },
): Promise<void> {
  await db.prepare(`
    UPDATE event_cover_masters SET cleanup_after = ?
    WHERE id = ? AND cleanup_after IS NULL
  `).bind(input.cleanupAfter.toISOString(), input.masterId).run();
}

/**
 * Releases charged raw bytes, and only after R2 absence has been verified.
 *
 * The caller proves the object is gone; this clears the pointer that was
 * charging for it. Restricted to non-live drafts so a live upload can never
 * have its accounting cleared out from under it.
 */
export async function releaseCoverRawBytes(
  db: D1Database,
  input: { draftId: string; now: Date },
): Promise<void> {
  await db.prepare(`
    UPDATE event_cover_drafts
    SET raw_object_key = NULL, verified_raw_byte_size = NULL, updated_at = ?
    WHERE id = ? AND state IN ('failed', 'expired', 'published')
  `).bind(input.now.toISOString(), input.draftId).run();
}

export async function discardCoverDraft(
  db: D1Database,
  input: { draftId: string; eventId: string; expectedDraftRevision: number; now: Date },
): Promise<CoverDraftRow> {
  const current = await requireDraft(db, input.draftId, input.eventId);
  // Idempotent: a repeated discard of an already-expired draft is success, not
  // a conflict, whatever revision the caller last saw.
  if (current.state === 'expired') return current;
  if (current.state === 'publishing' || current.state === 'published') {
    throw draftConflict('That cover is being published. Wait for it to finish, then try again.');
  }

  const timestamp = input.now.toISOString();
  const statements = [
    db.prepare(`
      UPDATE event_cover_drafts
      SET state = 'expired', draft_revision = draft_revision + 1, updated_at = ?
      WHERE id = ? AND event_id = ? AND draft_revision = ?
        AND state IN ('reserved', 'transferred', 'inspected', 'ready', 'failed')
    `).bind(timestamp, input.draftId, input.eventId, input.expectedDraftRevision),
  ];
  if (current.master_id) {
    // Never the event's active master, and never one anything else still needs.
    // Expiring an edit draft must not make the cover it was editing collectable.
    statements.push(db.prepare(`
      UPDATE event_cover_masters SET cleanup_after = ?
      WHERE id = ? AND changes() = 1
        AND object_key IS NOT (SELECT cover_object_key FROM events WHERE id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          WHERE s.master_id = event_cover_masters.id AND s.state IN ('staging', 'ready', 'active')
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_cover_drafts d
          WHERE d.master_id = event_cover_masters.id AND d.id <> ?
            AND d.state IN ${LIVE_DRAFT_STATES}
        )
    `).bind(timestamp, current.master_id, input.eventId, input.draftId));
  }

  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw draftConflict('That cover draft has moved on since this page loaded. Reload and try again.');
  }
  return requireDraft(db, input.draftId, input.eventId);
}

export async function writeCoverComposition(
  db: D1Database,
  input: {
    draftId: string;
    eventId: string;
    expectedDraftRevision: number;
    modelVersion: number;
    x: number;
    y: number;
    now: Date;
  },
): Promise<CoverDraftRow> {
  const current = await requireDraft(db, input.draftId, input.eventId);
  // An identical replay returns the ready draft rather than moving the revision
  // a second time; `Done` waits on this response being durable.
  if (current.state === 'ready'
    && current.focus_x === input.x
    && current.focus_y === input.y
    && current.composition_model_version === input.modelVersion) {
    return current;
  }

  const timestamp = input.now.toISOString();
  const results = await db.batch([
    db.prepare(`
      UPDATE event_cover_drafts
      SET state = 'ready', focus_x = ?, focus_y = ?, composition_model_version = ?,
          draft_revision = draft_revision + 1, updated_at = ?
      WHERE id = ? AND event_id = ? AND draft_revision = ? AND state = 'inspected'
        AND master_id IS NOT NULL
    `).bind(
      input.x, input.y, input.modelVersion, timestamp,
      input.draftId, input.eventId, input.expectedDraftRevision,
    ),
    // One-time on the master: a later manual edit must still be able to reset to
    // the composition Candidary originally proposed for these exact bytes.
    db.prepare(`
      UPDATE event_cover_masters
      SET auto_focus_x = ?, auto_focus_y = ?, composition_model_version = ?
      WHERE id = ? AND changes() = 1 AND auto_focus_x IS NULL
    `).bind(input.x, input.y, input.modelVersion, current.master_id),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw draftConflict('That cover has moved on since this page loaded. Reload and try again.');
  }
  return requireDraft(db, input.draftId, input.eventId);
}

/* ------------------------------------------------------------------ *
 * Draft previews
 * ------------------------------------------------------------------ */

export interface AdoptCoverPreviewInput {
  draftId: string;
  eventId: string;
  effect: string;
  recipeVersion: number;
  objectKey?: string | null;
  byteSize?: number | null;
  width?: number | null;
  height?: number | null;
  ladderRung?: number | null;
  sha256?: string | null;
  failureCode?: string | null;
  retryable?: boolean;
  now: Date;
}

export interface CoverPreviewAdoption {
  row: CoverDraftPreviewRow;
  replayed: boolean;
}

export async function adoptCoverPreview(
  db: D1Database,
  input: AdoptCoverPreviewInput,
): Promise<CoverPreviewAdoption> {
  const existing = await db.prepare(`
    SELECT * FROM event_cover_draft_previews
    WHERE draft_id = ? AND effect_id = ? AND recipe_version = ?
  `).bind(input.draftId, input.effect, input.recipeVersion).first<CoverDraftPreviewRow>();

  // A stored ready or permanent-failed result replays. Only a retryable failure
  // may re-enter rendering under the same tuple, so a dense image is never put
  // through the same four-rung ladder forever.
  if (existing && (existing.state === 'ready' || (existing.state === 'failed' && existing.retryable === 0))) {
    return { row: existing, replayed: true };
  }

  const timestamp = input.now.toISOString();
  if (input.failureCode) {
    const id = existing?.id ?? crypto.randomUUID();
    await db.prepare(`
      INSERT INTO event_cover_draft_previews (
        id, draft_id, event_id, effect_id, recipe_version, state, failure_code, retryable,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)
      ON CONFLICT (draft_id, effect_id, recipe_version) DO UPDATE SET
        state = 'failed', failure_code = excluded.failure_code,
        retryable = excluded.retryable, updated_at = excluded.updated_at
    `).bind(
      id, input.draftId, input.eventId, input.effect, input.recipeVersion,
      input.failureCode, input.retryable ? 1 : 0, timestamp, timestamp,
    ).run();
    return { row: await requirePreview(db, input), replayed: false };
  }

  const byteSize = input.byteSize ?? 0;
  if (byteSize > MAX_COVER_PREVIEW_BYTES) {
    throw new ApiError(
      'COVER_PREVIEW_BUDGET_EXHAUSTED',
      'That style could not be prepared for this photo. Choose another style or another photo.',
      422,
    );
  }
  // Counted transactionally against ready files only, and before adoption:
  // a rendering or failed row holds no bytes.
  const ready = await db.prepare(`
    SELECT count(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
    FROM event_cover_draft_previews
    WHERE draft_id = ? AND state = 'ready' AND id IS NOT ?
  `).bind(input.draftId, existing?.id ?? null).first<{ count: number; bytes: number }>();
  if ((ready?.count ?? 0) + 1 > MAX_COVER_PREVIEW_FILES_PER_DRAFT
    || (ready?.bytes ?? 0) + byteSize > MAX_COVER_PREVIEW_BYTES_PER_DRAFT) {
    throw new ApiError(
      'COVER_PREVIEW_BUDGET_EXHAUSTED',
      'This photo has as many style previews as it can hold. Publish one, or start again with another photo.',
      409,
    );
  }

  await db.prepare(`
    INSERT INTO event_cover_draft_previews (
      id, draft_id, event_id, effect_id, recipe_version, state, object_key, mime_type,
      byte_size, width, height, ladder_rung, sha256, retryable, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'ready', ?, 'image/webp', ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT (draft_id, effect_id, recipe_version) DO UPDATE SET
      state = 'ready', object_key = excluded.object_key, mime_type = excluded.mime_type,
      byte_size = excluded.byte_size, width = excluded.width, height = excluded.height,
      ladder_rung = excluded.ladder_rung, sha256 = excluded.sha256,
      failure_code = NULL, retryable = 0, updated_at = excluded.updated_at
  `).bind(
    existing?.id ?? crypto.randomUUID(), input.draftId, input.eventId, input.effect,
    input.recipeVersion, input.objectKey ?? null, byteSize, input.width ?? null,
    input.height ?? null, input.ladderRung ?? null, input.sha256 ?? null, timestamp, timestamp,
  ).run();

  return { row: await requirePreview(db, input), replayed: false };
}

async function requirePreview(
  db: D1Database,
  input: { draftId: string; effect: string; recipeVersion: number },
): Promise<CoverDraftPreviewRow> {
  return (await db.prepare(`
    SELECT * FROM event_cover_draft_previews
    WHERE draft_id = ? AND effect_id = ? AND recipe_version = ?
  `).bind(input.draftId, input.effect, input.recipeVersion).first<CoverDraftPreviewRow>())!;
}

/* ------------------------------------------------------------------ *
 * Render objects
 * ------------------------------------------------------------------ */

export interface AdoptCoverRenderObjectInput {
  renderSetId: string;
  eventId: string;
  profileId: string;
  density: string;
  format: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  qualityRung: number;
  sha256: string;
  now: Date;
  publicationAdmission?: {
    operationId: string;
    workflowInstanceId: string;
    dispatchGeneration: number;
    draftId: string;
  };
}

/**
 * Adopts one slot into the manifest, or confirms the one already there.
 *
 * The compound key is what makes a duplicate slot unrepresentable, so a replayed
 * Workflow step lands on `DO UPDATE` rather than creating a second row that a
 * later count would have to reconcile. Only a valid object reaches here.
 */
export async function adoptCoverRenderObject(
  db: D1Database,
  input: AdoptCoverRenderObjectInput,
): Promise<boolean> {
  const timestamp = input.now.toISOString();
  const admissionSql = input.publicationAdmission ? `
    EXISTS (
      SELECT 1
      FROM event_cover_publish_receipts r
      JOIN events e ON e.id = r.event_id
      JOIN event_cover_render_sets s ON s.id = r.render_set_id AND s.event_id = r.event_id
      JOIN event_cover_drafts d ON d.id = r.draft_id AND d.event_id = r.event_id
      JOIN event_cover_workflow_fences f
        ON f.workflow_binding = 'COVER_RENDER_WORKFLOW'
          AND f.workflow_instance_id = r.workflow_instance_id
          AND f.event_id = r.event_id AND f.state = 'open'
          AND f.dispatch_generation = r.dispatch_generation
      WHERE r.event_id = ? AND r.operation_id = ? AND r.workflow_instance_id = ?
        AND r.dispatch_generation = ? AND r.render_set_id = ? AND r.draft_id = ?
        AND r.status = 'rendering' AND e.deleted_at IS NULL
        AND e.cover_revision = r.expected_revision
        AND s.state = 'staging' AND d.state = 'publishing'
    )
  ` : '1 = 1';
  const admissionBindings = input.publicationAdmission ? [
    input.eventId,
    input.publicationAdmission.operationId,
    input.publicationAdmission.workflowInstanceId,
    input.publicationAdmission.dispatchGeneration,
    input.renderSetId,
    input.publicationAdmission.draftId,
  ] : [];
  const result = await db.prepare(`
    INSERT INTO event_cover_render_objects (
      id, render_set_id, event_id, profile_id, density, format, object_key, content_type,
      byte_size, width, height, quality_rung, sha256, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${admissionSql}
    ON CONFLICT (render_set_id, profile_id, density, format) DO UPDATE SET
      object_key = excluded.object_key, content_type = excluded.content_type,
      byte_size = excluded.byte_size, width = excluded.width, height = excluded.height,
      quality_rung = excluded.quality_rung, sha256 = excluded.sha256
  `).bind(
    crypto.randomUUID(), input.renderSetId, input.eventId, input.profileId, input.density,
    input.format, input.objectKey, input.contentType, input.byteSize, input.width,
    input.height, input.qualityRung, input.sha256, timestamp,
    ...admissionBindings,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

/* ------------------------------------------------------------------ *
 * Persisted mutation budgets
 * ------------------------------------------------------------------ */

export interface ChargeCoverRateInput {
  eventId: string;
  action: CoverRateAction;
  replayKey: string;
  requestDigest: string;
  limit: number;
  now: Date;
}

/** 26 hours after the window opens, so a restart can still reconstruct it. */
const RATE_EVENT_TTL_MS = 26 * 60 * 60 * 1000;

export function coverRateWindowStart(now: Date): number {
  return Math.floor(now.getTime() / 1000 / 3600) * 3600;
}

/**
 * Charges one fixed hourly window, in D1 rather than in a rate-limit binding.
 *
 * A third `ratelimits` entry would change the generated bindings and the
 * topology digest for no functional gain, and — more to the point — an edge
 * limiter cannot answer "has this exact operation already been counted?", which
 * is the whole reason replays must be free. This follows the RSVP lookup budgets.
 */
export async function chargeCoverRateEvent(
  db: D1Database,
  input: ChargeCoverRateInput,
): Promise<{ replayed: boolean }> {
  const existing = await db.prepare(`
    SELECT request_sha256 FROM event_cover_rate_events
    WHERE event_id = ? AND action = ? AND replay_key = ?
  `).bind(input.eventId, input.action, input.replayKey).first<{ request_sha256: string }>();
  if (existing) {
    if (existing.request_sha256 !== input.requestDigest) {
      throw new ApiError(
        input.action === 'publication' ? 'COVER_PUBLICATION_CONFLICT' : 'COVER_DRAFT_STATE_CONFLICT',
        'That request was already used with different details. Start a new one.',
        409,
      );
    }
    return { replayed: true };
  }

  const windowStart = coverRateWindowStart(input.now);
  const result = await db.prepare(`
    INSERT INTO event_cover_rate_events (
      id, event_id, action, replay_key, request_sha256, window_start, created_at, expires_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE (
      SELECT count(*) FROM event_cover_rate_events
      WHERE event_id = ? AND action = ? AND window_start = ?
    ) < ?
    ON CONFLICT (event_id, action, replay_key) DO NOTHING
  `).bind(
    crypto.randomUUID(), input.eventId, input.action, input.replayKey, input.requestDigest,
    windowStart, input.now.toISOString(),
    new Date(windowStart * 1000 + RATE_EVENT_TTL_MS).toISOString(),
    input.eventId, input.action, windowStart, input.limit,
  ).run();

  if ((result.meta.changes ?? 0) !== 1) {
    const raced = await db.prepare(`
      SELECT request_sha256 FROM event_cover_rate_events
      WHERE event_id = ? AND action = ? AND replay_key = ?
    `).bind(input.eventId, input.action, input.replayKey).first<{ request_sha256: string }>();
    if (raced?.request_sha256 === input.requestDigest) return { replayed: true };
    if (raced) {
      throw new ApiError(
        input.action === 'publication' ? 'COVER_PUBLICATION_CONFLICT' : 'COVER_DRAFT_STATE_CONFLICT',
        'That request was already used with different details. Start a new one.',
        409,
      );
    }
    throw new ApiError(
      'RATE_LIMITED',
      'That is as many cover changes as this event can make in an hour. Try again shortly.',
      429,
    );
  }
  return { replayed: false };
}

/** Seconds until the current fixed window closes, for `Retry-After`. */
export function coverRateRetryAfterSeconds(now: Date): number {
  return Math.max(1, coverRateWindowStart(now) + 3600 - Math.floor(now.getTime() / 1000));
}

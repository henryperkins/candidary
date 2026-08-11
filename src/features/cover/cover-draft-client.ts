import {
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_UPLOAD_BYTES,
} from '../../../shared/constants';
import type { EventCoverPreparationView } from '../../../shared/event-cover';
import type { EventView } from '../../../shared/contracts';
import { api, apiBinary, apiBytes, apiEnvelope, ClientApiError } from '../../app/api';

/**
 * The sequence both upload controls share.
 *
 * Reserve, transfer, inspect, compose, publish — with the two identifiers that
 * make a lost response recoverable persisted *before* the request that uses
 * them. A draft intent that is only in a local variable turns a dropped
 * reservation response into a second live draft slot; an operation ID that is
 * only in a local variable turns a dropped `202` into a second publication.
 */

export interface CoverDraftView {
  id: string;
  source: 'new-upload' | 'existing-upload';
  state: string;
  revision: number;
  expiresAt: string;
  compositionModelVersion: number;
  master: {
    width: number;
    height: number;
    safeZoomMaximum: number;
    available2xProfiles: readonly string[];
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

export interface CoverPublicationResult {
  /** 200 applied, 202 preparing, 409 conflict, 503 retryable dispatch failure. */
  status: number;
  applied: boolean;
  appliedRevision?: number | null;
  operation: EventCoverPreparationView | null;
  event?: EventView;
}

/** Injected in tests for the same reason `GuestUploadFlow` takes a transport. */
export interface CoverCompositionRunner {
  (previewBytes: ArrayBuffer): Promise<{ x: number; y: number } | null>;
}

export interface PublishCoverUploadOptions {
  eventId: string;
  file: File;
  expectedRevision: number;
  runComposition?: CoverCompositionRunner;
  onProgress?(stage: 'reserving' | 'transferring' | 'inspecting' | 'composing' | 'publishing'): void;
}

const COVER_INTENT_PREFIX = 'candidary.cover.intent';
const COVER_OPERATION_PREFIX = 'candidary.cover.operation';

function coverBase(eventId: string): string {
  return `/api/manage/events/${encodeURIComponent(eventId)}/cover`;
}

/**
 * Session storage, guarded.
 *
 * Private modes and storage-partitioned embeds can throw on access rather than
 * return null, and a photo upload must not fail because a browser refused a key
 * — it only loses the replay guarantee that key was protecting.
 */
function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* The request still works; only lost-response replay is weakened. */
  }
}

function clearStored(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* As above. */
  }
}

/** Stable for one photo, so re-choosing the same file resumes its own draft. */
function intentKey(eventId: string, file: File): string {
  return `${COVER_INTENT_PREFIX}.${eventId}.${file.name}.${file.size}.${file.lastModified}`;
}

export function coverOperationKey(eventId: string): string {
  return `${COVER_OPERATION_PREFIX}.${eventId}`;
}

function persistedId(key: string): string {
  const existing = readStored(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  writeStored(key, created);
  return created;
}

export class CoverUploadRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverUploadRejected';
  }
}

/** The client half of the same limits the server enforces. Never a duplicate. */
export function validateCoverFile(file: File): void {
  if (!(COVER_UPLOAD_MIME_TYPES as readonly string[]).includes(file.type)) {
    throw new CoverUploadRejected('Choose a JPEG, PNG, WebP, or HEIC photo.');
  }
  if (file.size > MAX_COVER_UPLOAD_BYTES) {
    throw new CoverUploadRejected(
      `Cover photos need to be under ${Math.floor(MAX_COVER_UPLOAD_BYTES / 1_000_000)} MB.`,
    );
  }
}

export async function publishCoverUpload(
  options: PublishCoverUploadOptions,
): Promise<CoverPublicationResult> {
  const { eventId, file, expectedRevision } = options;
  validateCoverFile(file);
  const base = coverBase(eventId);

  options.onProgress?.('reserving');
  // Persisted before the first request, so a dropped reservation response
  // replays into the same draft instead of consuming a second live slot.
  const draftIntentId = persistedId(intentKey(eventId, file));
  const reservation = await api<{ draft: CoverDraftView; ingress: { path: string } | null }>(
    `${base}/drafts`,
    {
      method: 'POST',
      body: JSON.stringify({
        draftIntentId,
        source: { kind: 'new-upload' },
        filename: file.name,
        mimeType: file.type,
        byteSize: file.size,
      }),
    },
  );

  let draft = reservation.draft;
  if (draft.state === 'reserved' && reservation.ingress) {
    options.onProgress?.('transferring');
    const transferred = await apiBinary<{ draft: CoverDraftView }>(reservation.ingress.path, {
      method: 'PUT',
      headers: { 'content-type': file.type, 'if-match': `"${draft.revision}"` },
      body: file,
    });
    draft = transferred.draft;
  }

  if (draft.state === 'transferred') {
    options.onProgress?.('inspecting');
    draft = (await api<{ draft: CoverDraftView }>(`${base}/drafts/${draft.id}/inspect`, {
      method: 'POST',
    })).draft;
  }

  if (draft.state === 'inspected') {
    options.onProgress?.('composing');
    const focus = await resolveComposition(base, draft, options.runComposition);
    draft = (await api<{ draft: CoverDraftView }>(`${base}/drafts/${draft.id}/composition`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedDraftRevision: draft.revision,
        modelVersion: draft.compositionModelVersion,
        x: focus.x,
        y: focus.y,
      }),
    })).draft;
  }

  options.onProgress?.('publishing');
  // Persisted before dispatch. Once this is sent the outcome is ambiguous until
  // the receipt is read, and reusing the same ID is what keeps a lost response
  // from becoming a second publication.
  const operationKey = coverOperationKey(eventId);
  const operationId = persistedId(operationKey);
  const answered = await apiEnvelope<Omit<CoverPublicationResult, 'status'>>(
    `${base}/publications`,
    {
      method: 'POST',
      body: JSON.stringify({
        operationId,
        expectedRevision,
        source: { kind: 'upload', draftId: draft.id },
        // Phase 1 publishes the automatic composition and the faithful style. The
        // manual focus, the six designs, and the other four styles arrive with
        // Cover Studio; nothing shipped can select them.
        focus: { mode: 'auto' },
        effect: 'natural',
      }),
    },
  );
  return settle(eventId, { status: answered.status, ...answered.data });
}

/**
 * Releases the operation once its outcome is settled.
 *
 * A single per-event key is what makes a lost `202` replay into its own receipt
 * rather than a second publication — but only while that operation is still
 * unresolved. Held past a terminal outcome it becomes the opposite: the next
 * cover change reuses the ID with different bytes and takes a permanent 409.
 * A retryable failure is deliberately not settled, because the same operation
 * is what restarts.
 */
function settle(eventId: string, result: CoverPublicationResult): CoverPublicationResult {
  const status = result.operation?.status;
  const terminal = result.applied
    || status === 'applied'
    || status === 'conflict'
    || (status === 'permanent-failed')
    || (status === 'retryable-failed' && result.operation?.retryable === false)
    || result.status === 409;
  if (terminal) clearStored(coverOperationKey(eventId));
  return result;
}

export async function publishCoverRemoval(
  eventId: string,
  expectedRevision: number,
): Promise<CoverPublicationResult> {
  const operationId = persistedId(coverOperationKey(eventId));
  const answered = await apiEnvelope<Omit<CoverPublicationResult, 'status'>>(
    `${coverBase(eventId)}/publications`,
    {
      method: 'POST',
      body: JSON.stringify({ operationId, expectedRevision, source: { kind: 'none' } }),
    },
  );
  // Removal applies synchronously, so its operation is resolved the moment it
  // answers — including when it answers `409`, which the envelope now carries.
  return settle(eventId, { status: answered.status, ...answered.data });
}

export function forgetCoverOperation(eventId: string): void {
  clearStored(coverOperationKey(eventId));
}

export async function readCoverOperation(
  eventId: string,
  operationId: string,
): Promise<EventCoverPreparationView | null> {
  try {
    const result = await api<{ operation: EventCoverPreparationView }>(
      `${coverBase(eventId)}/publications/${encodeURIComponent(operationId)}`,
    );
    return result.operation;
  } catch (error) {
    if (error instanceof ClientApiError && error.code === 'EVENT_NOT_FOUND') return null;
    throw error;
  }
}

/** Sends only the operation ID: the recipe is pinned on the receipt. */
export async function restartCoverOperation(
  eventId: string,
  operationId: string,
): Promise<EventCoverPreparationView | null> {
  const result = await api<{ operation: EventCoverPreparationView | null }>(
    `${coverBase(eventId)}/publications/${encodeURIComponent(operationId)}/restart`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  return result.operation;
}

async function resolveComposition(
  base: string,
  draft: CoverDraftView,
  runComposition: CoverCompositionRunner | undefined,
): Promise<{ x: number; y: number }> {
  try {
    const previewBytes = await apiBytes(`${base}/drafts/${draft.id}/previews/natural`, {
      method: 'POST',
    });
    const runner = runComposition ?? defaultCompositionRunner;
    const focus = await runner(previewBytes);
    if (focus) return { x: focus.x, y: focus.y };
  } catch {
    /* Falls through to center. */
  }
  // A low-confidence or failed analysis uses center focus and keeps the same
  // manual correction path, rather than blocking a publication on a guess.
  return { x: 0.5, y: 0.5 };
}

/**
 * Loaded only when it is actually used.
 *
 * A module-level `?worker` import would pull a `Worker` constructor into every
 * jsdom suite that touches this file, and the composition step is the only
 * caller.
 */
const defaultCompositionRunner: CoverCompositionRunner = async (previewBytes) => {
  if (typeof Worker !== 'function') return null;
  const { default: CoverCompositionWorker } = await import('./cover-composition.worker?worker');
  const worker = new CoverCompositionWorker();
  try {
    return await new Promise<{ x: number; y: number } | null>((resolve) => {
      worker.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { ok: boolean; focus?: { x: number; y: number } };
        resolve(data.ok && data.focus ? data.focus : null);
      }, { once: true });
      worker.addEventListener('error', () => resolve(null), { once: true });
      worker.postMessage({ previewBytes }, [previewBytes]);
    });
  } finally {
    worker.terminate();
  }
};

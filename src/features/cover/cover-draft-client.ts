import {
  COVER_UPLOAD_MIME_TYPES,
  MAX_COVER_UPLOAD_BYTES,
  type CoverUploadMimeType,
} from '../../../shared/constants';
import type {
  EventCoverDraftCreateRequestV1,
  EventCoverEffectId,
  EventCoverFocusV1,
  EventCoverPreparationView,
  EventCoverPresetId,
} from '../../../shared/event-cover';
import type { EventView } from '../../../shared/contracts';
import type { ApiErrorBody } from '../../../shared/errors';
import { api, apiBytes, apiEnvelope, attachCredentials, ClientApiError } from '../../app/api';

/** The safe draft projection returned by every draft route. */
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

export interface CoverDraftReservation {
  draft: CoverDraftView;
  ingress: { method: 'PUT'; path: string } | null;
  replayed: boolean;
  draftIntentId: string;
}

export interface CoverOperationAnswer {
  status: number;
  operation: EventCoverPreparationView;
  appliedRevision?: number;
  event?: EventView;
  receiptPath: string;
  retryAfterMs: number | null;
}

/** Injected in tests because jsdom has no image-decoding Worker. */
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

export type CoverPublishIntent =
  | { source: { kind: 'none' } }
  | {
      source: { kind: 'preset'; presetId: EventCoverPresetId };
      effect: EventCoverEffectId;
    }
  | {
      source: { kind: 'upload'; draftId: string };
      focus: EventCoverFocusV1;
      effect: EventCoverEffectId;
    };

const COVER_INTENT_PREFIX = 'candidary.cover.intent';
const COVER_OPERATION_PREFIX = 'candidary.cover.operation';

function coverBase(eventId: string): string {
  return `/api/manage/events/${encodeURIComponent(eventId)}/cover`;
}

function draftPath(eventId: string, draftId: string): string {
  return `${coverBase(eventId)}/drafts/${encodeURIComponent(draftId)}`;
}

export function coverOperationReceiptPath(eventId: string, operationId: string): string {
  return `${coverBase(eventId)}/publications/${encodeURIComponent(operationId)}`;
}

/** Guarded because private/partitioned browser storage can throw. */
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

function persistedId(key: string): string {
  const existing = readStored(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  // Written before the request that uses it.
  writeStored(key, created);
  return created;
}

function draftIntentStorageKey(eventId: string, intentKey: string): string {
  return `${COVER_INTENT_PREFIX}.${eventId}.${intentKey}`;
}

function fileIntentKey(file: File): string {
  return `${file.name}.${file.size}.${file.lastModified}`;
}

export function coverOperationKey(eventId: string): string {
  return `${COVER_OPERATION_PREFIX}.${eventId}`;
}

export function readPersistedCoverOperation(eventId: string): string | null {
  return readStored(coverOperationKey(eventId));
}

export function persistCoverOperation(eventId: string, operationId: string): void {
  writeStored(coverOperationKey(eventId), operationId);
}

export function ensureCoverOperation(eventId: string): string {
  return persistedId(coverOperationKey(eventId));
}

export function forgetCoverOperation(eventId: string): void {
  clearStored(coverOperationKey(eventId));
}

export function forgetCoverDraftIntent(eventId: string, intentKey: string): void {
  clearStored(draftIntentStorageKey(eventId, intentKey));
}

export class CoverUploadRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverUploadRejected';
  }
}

export class CoverDraftPrimitiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverDraftPrimitiveError';
  }
}

/** The client half of the same limits the server enforces. */
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

export type CreateCoverDraftOptions = {
  eventId: string;
  /** Stable for this local edit attempt; the UUID itself is persisted internally. */
  intentKey: string;
} & (
  | { source: { kind: 'new-upload'; file: File } }
  | { source: { kind: 'existing-upload'; expectedCoverRevision: number } }
);

/** Reserves or replays one draft without accepting an object key from the client. */
export async function createCoverDraft(
  options: CreateCoverDraftOptions & { signal?: AbortSignal },
): Promise<CoverDraftReservation> {
  const draftIntentId = persistedId(draftIntentStorageKey(options.eventId, options.intentKey));
  let request: EventCoverDraftCreateRequestV1;
  if (options.source.kind === 'new-upload') {
    const { file } = options.source;
    validateCoverFile(file);
    request = {
      draftIntentId,
      source: { kind: 'new-upload' },
      filename: file.name,
      mimeType: file.type as CoverUploadMimeType,
      byteSize: file.size,
    } as EventCoverDraftCreateRequestV1;
  } else {
    request = {
      draftIntentId,
      source: { kind: 'existing-upload' },
      expectedCoverRevision: options.source.expectedCoverRevision,
    };
  }
  const result = await api<{
    draft: CoverDraftView;
    ingress: { method: 'PUT'; path: string } | null;
    replayed?: boolean;
  }>(`${coverBase(options.eventId)}/drafts`, {
    method: 'POST',
    body: JSON.stringify(request),
    signal: options.signal,
  });
  return {
    draft: result.draft,
    ingress: result.ingress,
    replayed: result.replayed === true,
    draftIntentId,
  };
}

export async function transferCoverDraft(options: {
  eventId: string;
  draft: CoverDraftView;
  file: File;
  signal: AbortSignal;
  onProgress(sentBytes: number, totalBytes: number): void;
}): Promise<CoverDraftView> {
  if (options.draft.state !== 'reserved') {
    throw new CoverDraftPrimitiveError('Only a reserved cover draft can receive source bytes.');
  }
  if (options.signal.aborted) {
    throw new DOMException('Cover upload was cancelled.', 'AbortError');
  }

  return new Promise<CoverDraftView>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      finish();
    };
    const abort = () => request.abort();
    options.signal.addEventListener('abort', abort, { once: true });

    const path = `${draftPath(options.eventId, options.draft.id)}/raw`;
    request.open('PUT', path);
    const target = new URL(path, window.location.href);
    if (target.origin === window.location.origin) {
      request.withCredentials = true;
      attachCredentials(new Headers(), 'PUT').forEach((value, name) => {
        request.setRequestHeader(name, value);
      });
    }
    request.setRequestHeader('content-type', options.file.type);
    request.setRequestHeader('if-match', `"${options.draft.revision}"`);
    request.upload.addEventListener('progress', (event) => {
      if (settled || options.signal.aborted) return;
      options.onProgress(
        Math.min(Math.max(0, event.loaded), options.file.size),
        options.file.size,
      );
    });
    request.addEventListener('load', () => settle(() => {
      if (options.signal.aborted) {
        reject(new DOMException('Cover upload was cancelled.', 'AbortError'));
        return;
      }
      const payload = (() => {
        try {
          return JSON.parse(request.responseText) as {
            data?: { draft?: CoverDraftView };
          } & Partial<ApiErrorBody>;
        } catch {
          return null;
        }
      })();
      if (request.status >= 200 && request.status < 300 && payload?.data?.draft) {
        options.onProgress(options.file.size, options.file.size);
        resolve(payload.data.draft);
        return;
      }
      if (payload?.code && payload.message) {
        reject(new ClientApiError(
          payload.code,
          payload.message,
          payload.fieldErrors,
          payload.details,
          request.status,
          payload.requestId,
        ));
        return;
      }
      reject(new Error('The transfer was interrupted. Try this photo again.'));
    }));
    request.addEventListener('error', () => settle(() => {
      reject(new Error('Reception dropped out. Try this photo again.'));
    }));
    request.addEventListener('abort', () => settle(() => {
      reject(new DOMException('Cover upload was cancelled.', 'AbortError'));
    }));
    request.send(options.file);
  });
}

export async function inspectCoverDraft(
  eventId: string,
  draft: CoverDraftView,
  signal?: AbortSignal,
): Promise<CoverDraftView> {
  if (draft.state !== 'transferred') {
    throw new CoverDraftPrimitiveError('Only a transferred cover draft can be inspected.');
  }
  return (await api<{ draft: CoverDraftView }>(`${draftPath(eventId, draft.id)}/inspect`, {
    method: 'POST',
    signal,
  })).draft;
}

export async function writeCoverComposition(options: {
  eventId: string;
  draft: CoverDraftView;
  focus: { x: number; y: number };
}): Promise<CoverDraftView> {
  if (options.draft.state !== 'inspected') {
    throw new CoverDraftPrimitiveError('Only an inspected cover draft can store a composition.');
  }
  return (await api<{ draft: CoverDraftView }>(
    `${draftPath(options.eventId, options.draft.id)}/composition`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        expectedDraftRevision: options.draft.revision,
        modelVersion: options.draft.compositionModelVersion,
        x: options.focus.x,
        y: options.focus.y,
      }),
    },
  )).draft;
}

export async function readCoverDraft(eventId: string, draftId: string): Promise<CoverDraftView> {
  return (await api<{ draft: CoverDraftView }>(draftPath(eventId, draftId))).draft;
}

export async function discardCoverDraft(eventId: string, draft: CoverDraftView): Promise<CoverDraftView> {
  return (await api<{ draft: CoverDraftView }>(draftPath(eventId, draft.id), {
    method: 'DELETE',
    headers: { 'if-match': `"${draft.revision}"` },
  })).draft;
}

export async function readCoverEffectPreview(
  eventId: string,
  draftId: string,
  effect: EventCoverEffectId,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return apiBytes(`${draftPath(eventId, draftId)}/previews/${effect}`, {
    method: 'POST',
    signal,
  });
}

interface CoverOperationPayload {
  operation: EventCoverPreparationView | null;
  appliedRevision?: number | null;
  event?: EventView;
}

function requestOrigin(): string {
  if (typeof location !== 'undefined' && location.origin && location.origin !== 'null') {
    return location.origin;
  }
  return 'http://localhost';
}

/** Accepts only the exact same-origin status resource for this event/operation. */
function authorizedReceiptPath(
  locationValue: string | null,
  eventId: string,
  operationId: string,
): string {
  const expected = coverOperationReceiptPath(eventId, operationId);
  if (!locationValue) return expected;
  try {
    const origin = requestOrigin();
    const parsed = new URL(locationValue, origin);
    if (parsed.origin !== origin
      || parsed.username
      || parsed.password
      || parsed.pathname !== expected
      || parsed.search
      || parsed.hash) {
      return expected;
    }
    return parsed.pathname;
  } catch {
    return expected;
  }
}

function coverOperationAnswer(
  eventId: string,
  operationId: string,
  response: {
    status: number;
    data: CoverOperationPayload;
    location: string | null;
    retryAfterMs: number | null;
  },
): CoverOperationAnswer {
  const operation = response.data.operation;
  if (!operation || operation.operationId !== operationId) {
    throw new Error('The cover operation response did not match the requested operation.');
  }
  return {
    status: response.status,
    operation,
    ...(typeof response.data.appliedRevision === 'number'
      ? { appliedRevision: response.data.appliedRevision }
      : {}),
    ...(response.data.event ? { event: response.data.event } : {}),
    receiptPath: authorizedReceiptPath(response.location, eventId, operationId),
    retryAfterMs: response.retryAfterMs,
  };
}

export async function publishCoverIntent(options: {
  eventId: string;
  expectedRevision: number;
  intent: CoverPublishIntent;
  /** Supplied by the reconciler after it persists and marks dispatch ambiguous. */
  operationId?: string;
}): Promise<CoverOperationAnswer> {
  const operationId = options.operationId ?? ensureCoverOperation(options.eventId);
  persistCoverOperation(options.eventId, operationId);
  const response = await apiEnvelope<CoverOperationPayload>(`${coverBase(options.eventId)}/publications`, {
    method: 'POST',
    body: JSON.stringify({
      operationId,
      expectedRevision: options.expectedRevision,
      ...options.intent,
    }),
  });
  return coverOperationAnswer(options.eventId, operationId, response);
}

export async function readCoverOperation(
  eventId: string,
  operationId: string,
): Promise<CoverOperationAnswer | null> {
  try {
    const response = await apiEnvelope<CoverOperationPayload>(
      coverOperationReceiptPath(eventId, operationId),
    );
    return coverOperationAnswer(eventId, operationId, response);
  } catch (error) {
    if (error instanceof ClientApiError && error.code === 'EVENT_NOT_FOUND') return null;
    throw error;
  }
}

/** Sends only the operation ID; the server-pinned recipe is never reconstructed. */
export async function restartCoverOperation(
  eventId: string,
  operationId: string,
): Promise<CoverOperationAnswer | null> {
  const response = await apiEnvelope<CoverOperationPayload>(
    `${coverOperationReceiptPath(eventId, operationId)}/restart`,
    { method: 'POST', body: JSON.stringify({}) },
  );
  if (!response.data.operation) return null;
  return coverOperationAnswer(eventId, operationId, response);
}

export async function publishCoverRemoval(
  eventId: string,
  expectedRevision: number,
): Promise<CoverOperationAnswer> {
  return publishCoverIntent({
    eventId,
    expectedRevision,
    intent: { source: { kind: 'none' } },
  });
}

/**
 * Retained CreatePage wrapper: same reserve/transfer/inspect/compose/publish
 * sequence and progress semantics, now composed from independently testable
 * primitives.
 */
export async function publishCoverUpload(
  options: PublishCoverUploadOptions,
): Promise<CoverOperationAnswer> {
  const { eventId, file, expectedRevision } = options;
  validateCoverFile(file);
  const controller = new AbortController();

  options.onProgress?.('reserving');
  const reservation = await createCoverDraft({
    eventId,
    intentKey: fileIntentKey(file),
    source: { kind: 'new-upload', file },
    signal: controller.signal,
  });
  let draft = reservation.draft;

  if (draft.state === 'reserved') {
    options.onProgress?.('transferring');
    draft = await transferCoverDraft({
      eventId,
      draft,
      file,
      signal: controller.signal,
      onProgress: () => undefined,
    });
  }
  if (draft.state === 'transferred') {
    options.onProgress?.('inspecting');
    draft = await inspectCoverDraft(eventId, draft, controller.signal);
  }
  if (draft.state === 'inspected') {
    options.onProgress?.('composing');
    const focus = await resolveComposition(eventId, draft, options.runComposition);
    draft = await writeCoverComposition({ eventId, draft, focus });
  }
  if (draft.state !== 'ready') {
    throw new CoverDraftPrimitiveError('The cover draft did not become ready to publish.');
  }

  options.onProgress?.('publishing');
  return publishCoverIntent({
    eventId,
    expectedRevision,
    intent: {
      source: { kind: 'upload', draftId: draft.id },
      focus: { mode: 'auto' },
      effect: 'natural',
    },
  });
}

export async function resolveComposition(
  eventId: string,
  draft: CoverDraftView,
  runComposition: CoverCompositionRunner | undefined,
  signal?: AbortSignal,
): Promise<{ x: number; y: number }> {
  try {
    const previewBytes = await readCoverEffectPreview(eventId, draft.id, 'natural', signal);
    return resolveCompositionFromPreview(previewBytes, runComposition);
  } catch {
    /* A failed or aborted analysis falls through to the neutral center. */
  }
  return { x: 0.5, y: 0.5 };
}

/** Runs composition over already-read natural bytes so Studio can reuse them. */
export async function resolveCompositionFromPreview(
  previewBytes: ArrayBuffer,
  runComposition?: CoverCompositionRunner,
): Promise<{ x: number; y: number }> {
  try {
    const runner = runComposition ?? defaultCompositionRunner;
    // The default Worker transfers its buffer. Keep the caller's bytes intact
    // so the same authorized natural preview can become the canvas URL.
    const focus = await runner(previewBytes.slice(0));
    if (focus) return { x: focus.x, y: focus.y };
  } catch {
    /* A failed analysis uses the neutral center, never a client guess. */
  }
  return { x: 0.5, y: 0.5 };
}

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

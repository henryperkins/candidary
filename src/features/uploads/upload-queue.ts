import { UPLOAD_BATCH_SIZE } from '../../../shared/constants';
import type { ApiErrorCode } from '../../../shared/errors';
import { ClientApiError } from '../../app/api';

export type UploadQueueState =
  | 'selected'
  | 'reserving'
  | 'queued'
  | 'uploading'
  | 'finalizing'
  | 'delivered'
  | 'failed';

export interface UploadReservation {
  mediaId: string;
  uploadUrl: string;
  mimeType: string;
}

export interface UploadQueueItem {
  id: string;
  file: File;
  state: UploadQueueState;
  progress: number;
  isNewCapture: boolean;
  error?: string;
  failure?: UploadFailure;
  validationError?: boolean;
  retryStage?: 'finalize';
  reservation?: UploadReservation;
  previewUrl?: string;
}

export type ReservationResult =
  | { id: string; status: 'accepted'; reservation: UploadReservation }
  | { id: string; status: 'delivered'; mediaId: string }
  | { id: string; status: 'canceled' }
  | { id: string; status: 'rejected'; error: string; failure?: UploadFailure };

export interface UploadFailure {
  code: ApiErrorCode;
  status: number;
  stage: 'reserve' | 'upload' | 'finalize';
}

export interface UploadTransport {
  reserve(items: readonly UploadQueueItem[], signal?: AbortSignal): Promise<readonly ReservationResult[]>;
  upload(
    item: UploadQueueItem,
    reservation: UploadReservation,
    progress: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  finalize(item: UploadQueueItem, reservation: UploadReservation, signal?: AbortSignal): Promise<void>;
  retryUploadAfterFinalizeError?(error: unknown): boolean;
}

export interface RunUploadQueueOptions {
  concurrency?: number;
  onChange?: (items: UploadQueueItem[]) => void;
  signal?: AbortSignal;
  onFinalized?: (result: { itemId: string; mediaId: string }) => void;
}

const CANCELLED_MESSAGE = 'Sending was cancelled. Retry when you are ready.';
const IN_FLIGHT_STATES = new Set<UploadQueueState>(['reserving', 'queued', 'uploading', 'finalizing']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This photo could not be sent.';
}

function failureFrom(error: unknown, stage: UploadFailure['stage']): UploadFailure | undefined {
  if (!(error instanceof ClientApiError) || typeof error.status !== 'number') return undefined;
  return { code: error.code, status: error.status, stage };
}

export async function runUploadQueue(
  items: readonly UploadQueueItem[],
  transport: UploadTransport,
  options: RunUploadQueueOptions = {},
): Promise<UploadQueueItem[]> {
  const { concurrency = 2, onChange, onFinalized, signal } = options;
  let current = items.map((item) => ({ ...item }));
  const finalizationRetries = current.filter(({ state, retryStage, reservation }) =>
    state === 'failed' && retryStage === 'finalize' && reservation);
  const candidates = current.filter(({ state, validationError, retryStage }) =>
    !validationError && (state === 'selected' || (state === 'failed' && retryStage !== 'finalize')));
  if (candidates.length === 0 && finalizationRetries.length === 0) return current;

  const activeIds = new Set([...candidates, ...finalizationRetries].map(({ id }) => id));
  const emit = () => onChange?.(current.map((item) => ({ ...item })));
  const update = (id: string, patch: Partial<UploadQueueItem>) => {
    current = current.map((item) => item.id === id ? { ...item, ...patch } : item);
    emit();
  };
  const markDelivered = (id: string, mediaId: string) => {
    if (signal?.aborted) return;
    const queued = current.find((item) => item.id === id);
    if (!queued || queued.state === 'delivered') return;
    update(id, {
      state: 'delivered',
      progress: 100,
      reservation: undefined,
      error: undefined,
      failure: undefined,
      retryStage: undefined,
    });
    if (signal?.aborted) return;
    onFinalized?.({ itemId: id, mediaId });
  };

  const ready: Array<{ id: string; stage: 'upload' | 'finalize' }> = finalizationRetries
    .map(({ id }) => ({ id, stage: 'finalize' }));

  for (let offset = 0; offset < candidates.length; offset += UPLOAD_BATCH_SIZE) {
    if (signal?.aborted) break;
    const chunk = candidates.slice(offset, offset + UPLOAD_BATCH_SIZE);
    const chunkIds = new Set(chunk.map(({ id }) => id));
    current = current.map((item) => chunkIds.has(item.id)
      ? {
          ...item,
          state: 'reserving',
          progress: 0,
          error: undefined,
          failure: undefined,
          retryStage: undefined,
        }
      : item);
    emit();
    if (signal?.aborted) break;

    const dispatched = chunk.map(({ id }) => current.find((item) => item.id === id)!)
      .filter(Boolean);
    let reservations: readonly ReservationResult[];
    try {
      reservations = await transport.reserve(dispatched, signal);
    } catch (error) {
      if (signal?.aborted) break;
      current = current.map((item) => chunkIds.has(item.id)
        ? {
            ...item,
            state: 'failed',
            error: errorMessage(error),
            failure: failureFrom(error, 'reserve'),
            retryStage: undefined,
          }
        : item);
      emit();
      break;
    }
    if (signal?.aborted) break;

    const resultsById = new Map(reservations.map((result) => [result.id, result]));
    for (const candidate of chunk) {
      if (signal?.aborted) break;
      const result = resultsById.get(candidate.id);
      if (result?.status === 'delivered') {
        markDelivered(candidate.id, result.mediaId);
      } else if (result?.status === 'accepted') {
        update(candidate.id, {
          state: 'queued',
          reservation: result.reservation,
          error: undefined,
          failure: undefined,
          retryStage: undefined,
        });
        if (!signal?.aborted) ready.push({ id: candidate.id, stage: 'upload' });
      } else if (result?.status === 'canceled') {
        current = current.filter((item) => item.id !== candidate.id);
        emit();
      } else {
        update(candidate.id, {
          state: 'failed',
          reservation: undefined,
          error: result?.error ?? 'This photo could not be reserved.',
          failure: result?.failure,
          retryStage: undefined,
        });
      }
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < ready.length) {
      if (signal?.aborted) return;
      const task = ready[cursor++];
      if (!task) return;
      const queued = current.find((item) => item.id === task.id);
      if (!queued?.reservation) continue;
      let stage = task.stage;
      try {
        if (stage === 'upload') {
          if (signal?.aborted) return;
          update(task.id, { state: 'uploading', progress: 0 });
          if (signal?.aborted) return;
          await transport.upload(queued, queued.reservation, (progress) => {
            if (signal?.aborted) return;
            update(task.id, { progress: Math.max(0, Math.min(100, Math.round(progress))) });
          }, signal);
          if (signal?.aborted) return;
          stage = 'finalize';
        }
        if (signal?.aborted) return;
        update(task.id, {
          state: 'finalizing',
          progress: 100,
          failure: undefined,
          retryStage: 'finalize',
        });
        if (signal?.aborted) return;
        await transport.finalize(queued, queued.reservation, signal);
        if (signal?.aborted) return;
        markDelivered(task.id, queued.reservation.mediaId);
      } catch (error) {
        if (signal?.aborted) return;
        const retryStage = stage === 'finalize' && !transport.retryUploadAfterFinalizeError?.(error)
          ? 'finalize'
          : undefined;
        update(task.id, {
          state: 'failed',
          error: errorMessage(error),
          failure: failureFrom(error, stage),
          retryStage,
        });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), ready.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (signal?.aborted) {
    current = current.map((item) => activeIds.has(item.id) && IN_FLIGHT_STATES.has(item.state)
      ? {
          ...item,
          state: 'failed',
          error: CANCELLED_MESSAGE,
          failure: undefined,
          retryStage: undefined,
        }
      : item);
    emit();
  }
  return current;
}

export function removeQueueItem(items: readonly UploadQueueItem[], id: string): UploadQueueItem[] {
  return items.filter((item) => item.id !== id || !['selected', 'failed'].includes(item.state));
}

export function getReceiptCount(items: readonly UploadQueueItem[]): number | null {
  const deliverable = items.filter(({ validationError }) => !validationError);
  if (deliverable.length === 0 || deliverable.some(({ state }) => state !== 'delivered')) return null;
  return deliverable.length;
}

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
  validationError?: boolean;
  retryStage?: 'finalize';
  reservation?: UploadReservation;
  previewUrl?: string;
}

export type ReservationResult =
  | { id: string; status: 'accepted'; reservation: UploadReservation }
  | { id: string; status: 'rejected'; error: string };

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
}

const CANCELLED_MESSAGE = 'Sending was cancelled. Retry when you are ready.';
const IN_FLIGHT_STATES = new Set<UploadQueueState>(['reserving', 'queued', 'uploading', 'finalizing']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This photo could not be sent.';
}

export async function runUploadQueue(
  items: readonly UploadQueueItem[],
  transport: UploadTransport,
  options: RunUploadQueueOptions = {},
): Promise<UploadQueueItem[]> {
  const { concurrency = 2, onChange, signal } = options;
  let current = items.map((item) => ({ ...item }));
  const finalizationRetries = current.filter(({ state, retryStage, reservation }) =>
    state === 'failed' && retryStage === 'finalize' && reservation);
  const candidates = current.filter(({ state, validationError, retryStage }) =>
    !validationError && (state === 'selected' || (state === 'failed' && retryStage !== 'finalize')));
  if (candidates.length === 0 && finalizationRetries.length === 0) return current;

  const candidateIds = new Set(candidates.map(({ id }) => id));
  const activeIds = new Set([...candidateIds, ...finalizationRetries.map(({ id }) => id)]);
  const emit = () => onChange?.(current.map((item) => ({ ...item })));
  const update = (id: string, patch: Partial<UploadQueueItem>) => {
    current = current.map((item) => item.id === id ? { ...item, ...patch } : item);
    emit();
  };

  current = current.map((item) => candidateIds.has(item.id)
    ? { ...item, state: 'reserving', progress: 0, error: undefined, retryStage: undefined }
    : item);
  emit();

  let reservations: readonly ReservationResult[] = [];
  let reservationRequestFailed = false;
  if (candidates.length > 0 && !signal?.aborted) {
    try {
      reservations = await transport.reserve(candidates, signal);
    } catch (error) {
      reservationRequestFailed = true;
      const message = signal?.aborted ? CANCELLED_MESSAGE : errorMessage(error);
      current = current.map((item) => candidateIds.has(item.id)
        ? { ...item, state: 'failed', error: message }
        : item);
      emit();
    }
  }

  const resultsById = new Map(reservations.map((result) => [result.id, result]));
  const ready: Array<{ id: string; stage: 'upload' | 'finalize' }> = finalizationRetries
    .map(({ id }) => ({ id, stage: 'finalize' }));
  for (const candidate of candidates) {
    if (reservationRequestFailed || signal?.aborted) continue;
    const result = resultsById.get(candidate.id);
    if (result?.status === 'accepted') {
      current = current.map((item) => item.id === candidate.id
        ? { ...item, state: 'queued', reservation: result.reservation, error: undefined }
        : item);
      ready.push({ id: candidate.id, stage: 'upload' });
    } else {
      current = current.map((item) => item.id === candidate.id
        ? { ...item, state: 'failed', error: result?.error ?? 'This photo could not be reserved.' }
        : item);
    }
  }
  emit();

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
          update(task.id, { state: 'uploading', progress: 0 });
          await transport.upload(queued, queued.reservation, (progress) => {
            update(task.id, { progress: Math.max(0, Math.min(100, Math.round(progress))) });
          }, signal);
          stage = 'finalize';
        }
        update(task.id, { state: 'finalizing', progress: 100, retryStage: 'finalize' });
        await transport.finalize(queued, queued.reservation, signal);
        update(task.id, { state: 'delivered', progress: 100, error: undefined, retryStage: undefined });
      } catch (error) {
        if (signal?.aborted) {
          update(task.id, { state: 'failed', error: CANCELLED_MESSAGE, retryStage: undefined });
          continue;
        }
        const retryStage = stage === 'finalize' && !transport.retryUploadAfterFinalizeError?.(error)
          ? 'finalize'
          : undefined;
        update(task.id, { state: 'failed', error: errorMessage(error), retryStage });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), ready.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (signal?.aborted) {
    current = current.map((item) => activeIds.has(item.id) && IN_FLIGHT_STATES.has(item.state)
      ? { ...item, state: 'failed', error: CANCELLED_MESSAGE, retryStage: undefined }
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

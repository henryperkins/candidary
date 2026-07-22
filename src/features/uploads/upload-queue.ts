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
  reservation?: UploadReservation;
  previewUrl?: string;
}

export type ReservationResult =
  | { id: string; status: 'accepted'; reservation: UploadReservation }
  | { id: string; status: 'rejected'; error: string };

export interface UploadTransport {
  reserve(items: readonly UploadQueueItem[]): Promise<readonly ReservationResult[]>;
  upload(item: UploadQueueItem, reservation: UploadReservation, progress: (percent: number) => void): Promise<void>;
  finalize(item: UploadQueueItem, reservation: UploadReservation): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'This photo could not be sent.';
}

export async function runUploadQueue(
  items: readonly UploadQueueItem[],
  transport: UploadTransport,
  concurrency = 2,
  onChange?: (items: UploadQueueItem[]) => void,
): Promise<UploadQueueItem[]> {
  let current = items.map((item) => ({ ...item }));
  const candidates = current.filter(({ state, validationError }) =>
    !validationError && (state === 'selected' || state === 'failed'));
  if (candidates.length === 0) return current;

  const candidateIds = new Set(candidates.map(({ id }) => id));
  const emit = () => onChange?.(current.map((item) => ({ ...item })));
  const update = (id: string, patch: Partial<UploadQueueItem>) => {
    current = current.map((item) => item.id === id ? { ...item, ...patch } : item);
    emit();
  };

  current = current.map((item) => candidateIds.has(item.id)
    ? { ...item, state: 'reserving', progress: 0, error: undefined }
    : item);
  emit();

  let reservations: readonly ReservationResult[];
  try {
    reservations = await transport.reserve(candidates);
  } catch (error) {
    const message = errorMessage(error);
    current = current.map((item) => candidateIds.has(item.id)
      ? { ...item, state: 'failed', error: message }
      : item);
    emit();
    return current;
  }

  const resultsById = new Map(reservations.map((result) => [result.id, result]));
  const readyIds: string[] = [];
  for (const candidate of candidates) {
    const result = resultsById.get(candidate.id);
    if (result?.status === 'accepted') {
      current = current.map((item) => item.id === candidate.id
        ? { ...item, state: 'queued', reservation: result.reservation, error: undefined }
        : item);
      readyIds.push(candidate.id);
    } else {
      current = current.map((item) => item.id === candidate.id
        ? { ...item, state: 'failed', error: result?.error ?? 'This photo could not be reserved.' }
        : item);
    }
  }
  emit();

  let cursor = 0;
  const worker = async () => {
    while (cursor < readyIds.length) {
      const id = readyIds[cursor++];
      if (!id) return;
      const queued = current.find((item) => item.id === id);
      if (!queued?.reservation) continue;
      try {
        update(id, { state: 'uploading', progress: 0 });
        await transport.upload(queued, queued.reservation, (progress) => {
          update(id, { progress: Math.max(0, Math.min(100, Math.round(progress))) });
        });
        update(id, { state: 'finalizing', progress: 100 });
        await transport.finalize(queued, queued.reservation);
        update(id, { state: 'delivered', progress: 100, error: undefined });
      } catch (error) {
        update(id, { state: 'failed', error: errorMessage(error) });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), readyIds.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return current;
}

export function removeQueueItem(items: readonly UploadQueueItem[], id: string): UploadQueueItem[] {
  return items.filter((item) => item.id !== id || !['selected', 'failed'].includes(item.state));
}

export function getReceiptCount(items: readonly UploadQueueItem[]): number | null {
  if (items.length === 0 || items.some(({ state }) => state !== 'delivered')) return null;
  const delivered = items.filter(({ state }) => state === 'delivered').length;
  return delivered > 0 ? delivered : null;
}

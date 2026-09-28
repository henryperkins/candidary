import type { AppEnv } from '../env';

/**
 * Private rehearsal counters for the preview deployment's optional Analytics
 * Engine dataset. Absent binding means no-op. Each point carries the event ID as
 * its index and only closed labels: never a guest, session, media, object key,
 * hash or filename. Writes are synchronous and never alter a response.
 */
export type OriginalReadPurpose = 'native-decode' | 'original-download' | 'export' | 'images-transform';
export type PreviewReadOutcome = 'persisted-hit' | 'legacy-hit' | 'legacy-images' | 'miss-regeneration' | 'unavailable' | 'denied';
type MetricsEnv = Pick<AppEnv, 'IMAGE_METRICS' | 'IMAGE_DECODER_ENVIRONMENT'>;

function write(env: MetricsEnv, eventId: string, kind: 'original-read' | 'preview-read', label: string, bytes: number): void {
  const dataset = env.IMAGE_METRICS;
  if (!dataset || !/^[A-Za-z0-9_-]{1,96}$/u.test(eventId)) return;
  try {
    dataset.writeDataPoint({ indexes: [eventId], blobs: [env.IMAGE_DECODER_ENVIRONMENT, kind, label],
      doubles: [Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0, 1] });
  } catch { /* Measurement never changes delivery. */ }
}

/** One opened original object: bytes are its full pinned size, the upper bound streamed. */
export function recordOriginalRead(env: MetricsEnv, eventId: string, purpose: OriginalReadPurpose, bytes: number): void {
  write(env, eventId, 'original-read', purpose, bytes);
}

export function recordPreviewRead(env: MetricsEnv, eventId: string, outcome: PreviewReadOutcome, bytes = 0): void {
  write(env, eventId, 'preview-read', outcome, bytes);
}

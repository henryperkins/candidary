import { DEVICE_EXPORT_MAX_BYTES, DEVICE_EXPORT_MAX_FILES, DEVICE_EXPORT_CONCURRENCY, type PhotoExportEntryView } from '../../../shared/photo-exports';
import { attachCredentials, ClientApiError } from '../../app/api';

export interface DeviceBatch { files: File[]; preparedIds: string[]; failedIds: string[] }
export interface DeviceLimits { maxFiles?: number; maxBytes?: number; concurrency?: number }
const supported = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif', 'image/gif']);
function assertActive(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Preparation was interrupted.', 'AbortError'); }

/** Reads only the private frozen-entry path and retains the server's original MIME and bytes. */
export async function readPhotoExportFile(eventId: string, jobId: string, entry: PhotoExportEntryView, signal: AbortSignal): Promise<File> {
  const response = await fetch(`/api/manage/events/${encodeURIComponent(eventId)}/photo-exports/${encodeURIComponent(jobId)}/entries/${encodeURIComponent(entry.mediaId)}/file`, {
    credentials: 'same-origin', headers: attachCredentials(new Headers(), 'GET'), signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ClientApiError(body.code ?? 'INTERNAL_ERROR', body.message ?? 'This original could not be read. Try again or use ZIP.', undefined, undefined, response.status);
  }
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== entry.mimeType.toLowerCase() || !supported.has(type)) { await response.body?.cancel(); throw new Error('The original format changed. Use ZIP or try again.'); }
  // Do not allocate an unbounded response if the server's inventory or stream changes.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The original response was empty.');
  const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
  try {
    while (true) {
      assertActive(signal);
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > entry.byteSize || size > DEVICE_EXPORT_MAX_BYTES) throw new Error('The original size changed. Use ZIP or try again.');
      chunks.push(new Uint8Array(next.value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  assertActive(signal);
  if (size !== entry.byteSize) throw new Error('The original download was interrupted. Try again.');
  return new File(chunks, entry.filename, { type });
}

/** A single explicit preparation gesture reads one bounded batch, never the whole selection. */
export async function prepareDeviceBatch(entries: readonly PhotoExportEntryView[], readFile: (entry: PhotoExportEntryView, signal: AbortSignal) => Promise<File>, signal: AbortSignal, limits: DeviceLimits = {}): Promise<DeviceBatch> {
  const maxFiles = Math.max(1, Math.min(DEVICE_EXPORT_MAX_FILES, limits.maxFiles ?? DEVICE_EXPORT_MAX_FILES));
  const maxBytes = Math.max(1, Math.min(DEVICE_EXPORT_MAX_BYTES, limits.maxBytes ?? DEVICE_EXPORT_MAX_BYTES));
  const concurrency = Math.max(1, Math.min(DEVICE_EXPORT_CONCURRENCY, limits.concurrency ?? DEVICE_EXPORT_CONCURRENCY));
  const chosen: PhotoExportEntryView[] = []; const failedIds: string[] = []; let bytes = 0;
  for (const entry of entries) {
    if (entry.state === 'acknowledged') continue;
    if (!supported.has(entry.mimeType.toLowerCase()) || entry.byteSize <= 0 || entry.byteSize > maxBytes) { failedIds.push(entry.mediaId); continue; }
    if (chosen.length >= maxFiles || bytes + entry.byteSize > maxBytes) break;
    chosen.push(entry); bytes += entry.byteSize;
  }
  const results: Array<File | null> = chosen.map(() => null); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, chosen.length) }, async () => {
    while (cursor < chosen.length) {
      assertActive(signal); const index = cursor++; const entry = chosen[index]!;
      try {
        const file = await readFile(entry, signal); assertActive(signal);
        if (!(file instanceof File) || file.size !== entry.byteSize || file.type.toLowerCase() !== entry.mimeType.toLowerCase() || file.size > maxBytes) throw new Error('Original changed');
        results[index] = file;
      } catch { assertActive(signal); failedIds.push(entry.mediaId); }
    }
  }));
  assertActive(signal);
  return { files: results.filter((file): file is File => file !== null), preparedIds: chosen.filter((_, index) => results[index] !== null).map(entry => entry.mediaId), failedIds };
}

export type PendingDeviceReceipt = { mediaIds: string[]; stage: 'sharing' | 'handed-off' };
const receiptKey = (eventId: string, jobId: string) => `candidary-photo-handoff:${eventId}:${jobId}`;
export function readDeviceReceipt(eventId: string, jobId: string): PendingDeviceReceipt | null {
  try { const value = JSON.parse(sessionStorage.getItem(receiptKey(eventId, jobId)) ?? 'null'); return value && Array.isArray(value.mediaIds) && ['sharing', 'handed-off'].includes(value.stage) ? value : null; } catch { return null; }
}
/** Throw before sharing if durable uncertainty cannot be recorded for this tab. */
export function saveDeviceReceipt(eventId: string, jobId: string, receipt: PendingDeviceReceipt | null): void {
  if (receipt) sessionStorage.setItem(receiptKey(eventId, jobId), JSON.stringify(receipt));
  else sessionStorage.removeItem(receiptKey(eventId, jobId));
}

import type { UploadBatchItemView } from '../../../shared/contracts';
import type { ApiErrorBody } from '../../../shared/errors';
import { api, attachCredentials, ClientApiError } from '../../app/api';
import type {
  ReservationResult,
  UploadQueueItem,
  UploadReservation,
  UploadTransport,
} from './upload-queue';

const FINALIZE_REUPLOAD_CODES = new Set([
  'UPLOAD_RESERVATION_EXPIRED',
  'UPLOAD_FINALIZE_CONFLICT',
  'FILE_TOO_LARGE',
  'FILE_TYPE_UNSUPPORTED',
]);

/* The reservation answer, exactly as the contract writes it. The queue only ever needed three things
   about a photo the server had already been told about — which media row it is, what to send it as,
   and whether the bytes are already there — and everything else the response used to carry (object
   key, byte size, dimensions, guest name, publication status, reservation expiry) was either the
   guest's own file talking back to it or storage detail it had no business reading. The file being
   sent is the client's; it is the one already in hand. */
const RESERVATION_FAILED = 'This photo could not be reserved.';

function managerReservationFailureStatus(code: ApiErrorBody['code']): number {
  if (code === 'RESOURCE_FORBIDDEN') return 403;
  if (code === 'FILE_TYPE_UNSUPPORTED') return 415;
  if (code === 'FILE_TOO_LARGE') return 413;
  if (code === 'VALIDATION_FAILED') return 422;
  if (code === 'INTERNAL_ERROR') return 500;
  return 409;
}

function cancellation() {
  return new DOMException('Sending was cancelled.', 'AbortError');
}

function flatApiError(responseText: string): ApiErrorBody | null {
  try {
    const value = JSON.parse(responseText) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const body = value as Partial<ApiErrorBody>;
    if (typeof body.code !== 'string'
      || typeof body.message !== 'string'
      || typeof body.requestId !== 'string') return null;
    return body as ApiErrorBody;
  } catch {
    return null;
  }
}

function backoff(attempt: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancellation());
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(cancellation());
    };
    const timer = setTimeout(finish, 350 * 2 ** attempt);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function xhrUpload(
  file: File,
  reservation: UploadReservation,
  progress: (percent: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancellation());
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const settle = (finish: () => void) => {
      signal?.removeEventListener('abort', abort);
      finish();
    };
    request.open('PUT', reservation.uploadUrl);
    const target = new URL(reservation.uploadUrl, window.location.href);
    if (target.origin === window.location.origin) {
      request.withCredentials = true;
      attachCredentials(new Headers(), 'PUT').forEach((value, name) => {
        request.setRequestHeader(name, value);
      });
    }
    request.setRequestHeader('Content-Type', reservation.mimeType);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress((event.loaded / event.total) * 100);
    });
    request.addEventListener('load', () => settle(() => {
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        const body = flatApiError(request.responseText);
        reject(body
          ? new ClientApiError(
              body.code,
              body.message,
              body.fieldErrors,
              body.details,
              request.status,
              body.requestId,
            )
          : new Error('The transfer was interrupted. Try this photo again.'));
      }
    }));
    request.addEventListener('error', () => settle(() => reject(new Error('Reception dropped out. Try this photo again.'))));
    request.addEventListener('abort', () => settle(() => reject(cancellation())));
    request.send(file);
  });
}

export type BrowserUploadTransportOptions =
  | { kind: 'guest'; slug: string; guestName: string }
  | { kind: 'manager'; eventId: string };

export interface BrowserUploadTransport extends UploadTransport {
  cancelReservation?(
    item: UploadQueueItem,
    reservation: UploadReservation,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function createBrowserTransport(
  options: BrowserUploadTransportOptions,
): BrowserUploadTransport {
  const root = options.kind === 'guest'
    ? `/api/event/${options.slug}/uploads`
    : `/api/manage/events/${encodeURIComponent(options.eventId)}/uploads`;
  const transport: BrowserUploadTransport = {
    async reserve(items, signal) {
      const files = items.map(({ id, file }) => ({
        filename: file.name,
        mimeType: file.type,
        byteSize: file.size,
        idempotencyKey: id,
        caption: null,
      }));
      const response = await api<{ items: UploadBatchItemView[] }>(`${root}/batch`, {
        method: 'POST',
        signal,
        body: JSON.stringify(options.kind === 'guest'
          ? { guestName: options.guestName, files }
          : { files }),
      });
      return response.items.map((item): ReservationResult => {
        if (item.status === 'rejected') {
          if (options.kind === 'manager'
            && item.error?.code === 'UPLOAD_RESERVATION_CANCELED') {
            return { id: item.idempotencyKey, status: 'canceled' };
          }
          return {
            id: item.idempotencyKey,
            status: 'rejected',
            error: item.error?.message ?? RESERVATION_FAILED,
            ...(options.kind === 'manager' && item.error
              ? {
                  failure: {
                    code: item.error.code,
                    status: managerReservationFailureStatus(item.error.code),
                    stage: 'reserve' as const,
                  },
                }
              : {}),
          };
        }
        if (item.alreadyDelivered && item.media?.uploadState === 'stored') {
          return { id: item.idempotencyKey, status: 'delivered', mediaId: item.media.id };
        }
        // An accepted reservation that still needs its bytes always carries both. Anything else is
        // an answer this queue cannot act on, and a photo it cannot send is a photo it must not
        // report as sent.
        if (item.media && item.uploadUrl) {
          return {
            id: item.idempotencyKey,
            status: 'accepted',
            reservation: {
              mediaId: item.media.id,
              uploadUrl: item.uploadUrl,
              mimeType: item.media.mimeType,
            },
          };
        }
        return { id: item.idempotencyKey, status: 'rejected', error: RESERVATION_FAILED };
      });
    },
    async upload(item, reservation, progress, signal) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await xhrUpload(item.file, reservation, progress, signal);
          return;
        } catch (error) {
          lastError = error;
          if (signal?.aborted) break;
          if (attempt < 2) await backoff(attempt, signal);
        }
      }
      throw lastError;
    },
    async finalize(_item, reservation, signal) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await api(`${root}/${encodeURIComponent(reservation.mediaId)}/finalize`, {
            method: 'POST',
            signal,
            body: '{}',
          });
          return;
        } catch (error) {
          lastError = error;
          if (error instanceof ClientApiError && FINALIZE_REUPLOAD_CODES.has(error.code)) throw error;
          if (signal?.aborted) break;
          if (attempt < 2) await backoff(attempt, signal);
        }
      }
      throw lastError;
    },
    retryUploadAfterFinalizeError(error) {
      return error instanceof ClientApiError && FINALIZE_REUPLOAD_CODES.has(error.code);
    },
  };
  if (options.kind === 'manager') {
    transport.cancelReservation = async (_item, reservation, signal) => {
      await api(`${root}/${encodeURIComponent(reservation.mediaId)}`, {
        method: 'DELETE',
        signal,
        body: '{}',
      });
    };
  }
  return transport;
}

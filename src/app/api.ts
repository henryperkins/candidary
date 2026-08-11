import type { ApiErrorBody, ApiErrorCode, ApiErrorDetails } from '../../shared/errors';
import type { EventCoverAssetSlot } from '../../shared/event-cover-assets';

interface Envelope<T> { data: T; requestId: string }

export interface ApiEnvelopeResponse<T> {
  status: number;
  data: T;
  /** The raw Location value; domain clients must still authorize its target. */
  location: string | null;
  /** Integer delta-seconds converted to milliseconds, or null when unsupported. */
  retryAfterMs: number | null;
}

export class ClientApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
    public readonly details?: ApiErrorDetails,
    public readonly status?: number,
  ) {
    super(message);
  }
}

function cookieValue(name: string): string | undefined {
  return document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))?.split('=')[1];
}

function attachCredentials(headers: Headers, method: string): Headers {
  if (['GET', 'HEAD'].includes(method)) return headers;
  // A browser can hold an event session and an account session at once, and the
  // route decides which one authorizes it. Both tokens are offered; the server
  // checks only the pair belonging to the credential it accepted.
  const csrf = cookieValue('candidary_csrf');
  if (csrf) headers.set('x-candidary-csrf', decodeURIComponent(csrf));
  const hostCsrf = cookieValue('candidary_host_csrf');
  if (hostCsrf) headers.set('x-candidary-host-csrf', decodeURIComponent(hostCsrf));
  const rsvpCsrf = cookieValue('candidary_rsvp_csrf');
  if (rsvpCsrf) headers.set('x-candidary-rsvp-csrf', decodeURIComponent(rsvpCsrf));
  return headers;
}

async function unwrap<T>(response: Response): Promise<T> {
  const payload = await response.json() as Envelope<T> & Partial<ApiErrorBody>;
  if (!response.ok) {
    throw new ClientApiError(
      payload.code ?? 'INTERNAL_ERROR',
      payload.message ?? 'Something went wrong.',
      payload.fieldErrors,
      payload.details,
      response.status,
    );
  }
  return payload.data;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? 'GET';
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  attachCredentials(headers, method);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  return unwrap<T>(response);
}

/**
 * The same credentials, for a request whose body is not JSON.
 *
 * `api()` forces `content-type: application/json` on any body and always parses
 * the response as JSON, so it cannot carry raw photo bytes and cannot read an
 * image back. This keeps the scope CSRF headers and `credentials: 'same-origin'`
 * identical and lets the caller own the content type — the cover raw ingress
 * declares the photo's exact type, and the preview route answers with bytes.
 */
export async function apiBinary<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? 'GET';
  attachCredentials(headers, method);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  return unwrap<T>(response);
}

/**
 * A response whose non-ok status still carries an envelope, not an error body.
 *
 * The publication route answers a stale revision with `409` and a dispatch
 * failure with `503`, both as ordinary `{ data, requestId }` envelopes carrying
 * the recovery view — the plan puts it there deliberately, rather than inside
 * `ApiErrorDetails`. `api()` cannot read those: it treats every non-ok body as
 * an error body and reports `INTERNAL_ERROR` / "Something went wrong", throwing
 * away the current revision the next publication needs.
 */
export async function apiEnvelope<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiEnvelopeResponse<T>> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? 'GET';
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  attachCredentials(headers, method);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const payload = await response.json() as Envelope<T> & Partial<ApiErrorBody>;
  // A genuine error body still throws. Only an envelope-shaped answer is handed
  // back with its status for the caller to branch on.
  if (!response.ok && payload.data === undefined) {
    throw new ClientApiError(
      payload.code ?? 'INTERNAL_ERROR',
      payload.message ?? 'Something went wrong.',
      payload.fieldErrors,
      payload.details,
    );
  }
  const retryAfter = response.headers.get('retry-after');
  let retryAfterMs: number | null = null;
  if (retryAfter && /^(?:0|[1-9][0-9]*)$/u.test(retryAfter)) {
    const seconds = Number(retryAfter);
    const milliseconds = seconds * 1_000;
    if (Number.isSafeInteger(milliseconds)) retryAfterMs = milliseconds;
  }
  return {
    status: response.status,
    data: payload.data,
    location: response.headers.get('location'),
    retryAfterMs,
  };
}

/** Reads an authorized image response as bytes, with the same credentials. */
export async function apiBytes(path: string, init: RequestInit): Promise<ArrayBuffer> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? 'GET';
  attachCredentials(headers, method);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as Partial<ApiErrorBody>;
    throw new ClientApiError(
      payload.code ?? 'INTERNAL_ERROR',
      payload.message ?? 'Something went wrong.',
      payload.fieldErrors,
      payload.details,
    );
  }
  return response.arrayBuffer();
}

export function mediaPreview(id: string): string {
  return `/api/media/${encodeURIComponent(id)}/preview`;
}

export function mediaOriginal(id: string): string {
  return `/api/media/${encodeURIComponent(id)}/original`;
}

export interface EventCoverSlotPathOptions extends EventCoverAssetSlot {
  revision: number;
}

function eventCoverSlotSuffix(options: EventCoverSlotPathOptions): string {
  if (!Number.isSafeInteger(options.revision) || options.revision < 0) {
    throw new RangeError('A cover slot revision must be a non-negative safe integer.');
  }
  return `${options.revision}/${options.profile}/${options.density}.${options.format}`;
}

export function guestEventCoverSlotPath(
  slug: string,
  options: EventCoverSlotPathOptions,
): string {
  return `/api/event/${encodeURIComponent(slug)}/cover/${eventCoverSlotSuffix(options)}`;
}

export function managerEventCoverSlotPath(
  eventId: string,
  options: EventCoverSlotPathOptions,
): string {
  return `/api/manage/events/${encodeURIComponent(eventId)}/cover/${eventCoverSlotSuffix(options)}`;
}

export const mediaContent = mediaPreview;

import type { ApiErrorBody, ApiErrorCode, ApiErrorDetails } from '../../shared/errors';

interface Envelope<T> { data: T; requestId: string }

export class ClientApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
    public readonly details?: ApiErrorDetails,
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

export function guestEventCoverPath(slug: string): string {
  return `/api/event/${encodeURIComponent(slug)}/cover`;
}

export function managerEventCoverPath(eventId: string): string {
  return `/api/manage/events/${encodeURIComponent(eventId)}/cover`;
}

export const mediaContent = mediaPreview;

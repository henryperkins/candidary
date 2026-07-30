import type { ApiErrorBody, ApiErrorCode } from '../../shared/errors';

interface Envelope<T> { data: T; requestId: string }

export class ClientApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

function cookieValue(name: string): string | undefined {
  return document.cookie.split('; ').find((part) => part.startsWith(`${name}=`))?.split('=')[1];
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? 'GET';
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) {
    // A browser can hold an event session and an account session at once, and the
    // route decides which one authorizes it. Both tokens are offered; the server
    // checks only the pair belonging to the credential it accepted.
    const csrf = cookieValue('candidary_csrf');
    if (csrf) headers.set('x-candidary-csrf', decodeURIComponent(csrf));
    const hostCsrf = cookieValue('candidary_host_csrf');
    if (hostCsrf) headers.set('x-candidary-host-csrf', decodeURIComponent(hostCsrf));
    const rsvpCsrf = cookieValue('candidary_rsvp_csrf');
    if (rsvpCsrf) headers.set('x-candidary-rsvp-csrf', decodeURIComponent(rsvpCsrf));
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const payload = await response.json() as Envelope<T> & Partial<ApiErrorBody>;
  if (!response.ok) throw new ClientApiError(payload.code ?? 'INTERNAL_ERROR', payload.message ?? 'Something went wrong.', payload.fieldErrors);
  return payload.data;
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

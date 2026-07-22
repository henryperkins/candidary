interface Envelope<T> { data: T; requestId: string }

export class ClientApiError extends Error {
  constructor(public code: string, message: string, public fieldErrors?: Record<string, string>) {
    super(message);
  }
}

function csrfToken(): string | undefined {
  return document.cookie.split('; ').find((part) => part.startsWith('candidary_csrf='))?.split('=')[1];
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = init.method?.toUpperCase() ?? 'GET';
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set('x-candidary-csrf', decodeURIComponent(csrf));
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const payload = await response.json() as Envelope<T> & { code?: string; message?: string; fieldErrors?: Record<string, string> };
  if (!response.ok) throw new ClientApiError(payload.code ?? 'INTERNAL_ERROR', payload.message ?? 'Something went wrong.', payload.fieldErrors);
  return payload.data;
}

export function mediaContent(id: string): string {
  return `/api/media/${encodeURIComponent(id)}/content`;
}

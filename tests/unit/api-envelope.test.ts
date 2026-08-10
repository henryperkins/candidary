import { afterEach, describe, expect, it, vi } from 'vitest';

import { apiEnvelope, ClientApiError } from '../../src/app/api';

function response(
  data: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ data, requestId: 'request-a' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('apiEnvelope', () => {
  it('preserves the selected operation headers on an accepted publication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(
      { operation: { operationId: 'operation-a', status: 'preparing' } },
      202,
      {
        Location: '/api/manage/events/event-a/cover/publications/operation-a',
        'Retry-After': '2',
        'X-Private-Internal': 'never expose this',
      },
    )));

    await expect(apiEnvelope('/publication', { method: 'POST', body: '{}' })).resolves.toEqual({
      status: 202,
      data: { operation: { operationId: 'operation-a', status: 'preparing' } },
      location: '/api/manage/events/event-a/cover/publications/operation-a',
      retryAfterMs: 2_000,
    });
  });

  it('keeps a 503 envelope typed and preserves a longer retry delay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(
      { operation: { operationId: 'operation-a', status: 'retryable-failed' } },
      503,
      { 'Retry-After': '17' },
    )));

    await expect(apiEnvelope('/restart', { method: 'POST', body: '{}' })).resolves.toEqual({
      status: 503,
      data: { operation: { operationId: 'operation-a', status: 'retryable-failed' } },
      location: null,
      retryAfterMs: 17_000,
    });
  });

  it.each(['', '-1', '1.5', 'Wed, 21 Oct 2015 07:28:00 GMT', 'Infinity', '9007199254740992'])(
    'ignores unsupported Retry-After %j',
    async (retryAfter) => {
      vi.stubGlobal('fetch', vi.fn(async () => response(
        { operation: { operationId: 'operation-a' } },
        202,
        { 'Retry-After': retryAfter },
      )));
      expect((await apiEnvelope('/publication')).retryAfterMs).toBeNull();
    },
  );

  it('still throws a genuine error body with no data envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'SESSION_REQUIRED', message: 'Sign in.', requestId: 'request-a',
    }), { status: 401, headers: { 'content-type': 'application/json' } })));

    await expect(apiEnvelope('/publication')).rejects.toBeInstanceOf(ClientApiError);
  });
});

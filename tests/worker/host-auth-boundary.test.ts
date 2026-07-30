import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import { EmailService } from '../../worker/services/email';
import { origin, testEnv } from './helpers';

const EVENT_ID = '11111111-2222-4333-8444-555555555555';
const COOKIE_TOKEN = 'opaque-id.opaque-secret';
const SOURCE_IP = '203.0.113.99';

function deniedAtBoundary(): { env: AppEnv; keys: string[] } {
  const keys: string[] = [];
  const deniedEnv = Object.create(testEnv) as AppEnv;
  Object.defineProperties(deniedEnv, {
    HOST_AUTH_RATE_LIMIT: {
      value: {
        async limit({ key }: { key: string }) {
          keys.push(key);
          return { success: false };
        },
      },
    },
    DB: {
      get() {
        throw new Error('A rate-limited request reached an auth service or D1.');
      },
    },
    EMAIL: {
      get() {
        throw new Error('A rate-limited request reached email.');
      },
    },
  });
  return { env: deniedEnv, keys };
}

const cases = [
  {
    name: 'registration start',
    path: '/api/host/register',
    body: {
      email: 'host@example.com',
      password: 'a-sufficiently-long-password',
      bindEventId: EVENT_ID,
    },
    cookie: `candidary_session=${COOKIE_TOKEN}`,
    secretScope: SOURCE_IP,
  },
  {
    name: 'registration resend',
    path: '/api/host/register/resend',
    body: {},
    cookie: `candidary_registration=${COOKIE_TOKEN}`,
    secretScope: SOURCE_IP,
  },
  {
    name: 'registration completion',
    path: '/api/host/register/complete',
    body: { code: '424242' },
    cookie: `candidary_registration=${COOKIE_TOKEN}; candidary_session=${COOKIE_TOKEN}`,
    secretScope: SOURCE_IP,
  },
  {
    name: 'sign-in',
    path: '/api/host/login',
    body: { email: 'host@example.com', password: 'a-sufficiently-long-password' },
    cookie: undefined,
    secretScope: SOURCE_IP,
  },
  {
    name: 'forgot-password',
    path: '/api/host/password/forgot',
    body: { email: 'host@example.com' },
    cookie: undefined,
    secretScope: SOURCE_IP,
  },
  {
    name: 'password reset',
    path: '/api/host/password/reset',
    body: {
      email: 'host@example.com',
      code: '424242',
      password: 'a-brand-new-long-password',
    },
    cookie: undefined,
    secretScope: SOURCE_IP,
  },
] as const;

describe('native host-auth request boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const entry of cases) {
    it(`rejects ${entry.name} before any auth service, database, scrypt, or email access`, async () => {
      const boundary = deniedAtBoundary();
      const send = vi.spyOn(EmailService.prototype, 'send');
      const response = await createApp().request(entry.path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'CF-Connecting-IP': SOURCE_IP,
          ...(entry.cookie ? { cookie: entry.cookie } : {}),
        },
        body: JSON.stringify(entry.body),
      }, boundary.env);

      expect(response.status).toBe(429);
      expect(await response.json<{ code: string }>()).toMatchObject({ code: 'RATE_LIMITED' });
      expect(boundary.keys).toHaveLength(1);
      expect(boundary.keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(boundary.keys[0]).not.toContain(entry.secretScope);
      expect(boundary.keys[0]).not.toContain(COOKIE_TOKEN);
      expect(send).not.toHaveBeenCalled();
    });
  }

  it('domain-separates actions that share the same source', async () => {
    const boundary = deniedAtBoundary();
    for (const entry of [cases[0], cases[3], cases[4], cases[5]]) {
      await createApp().request(entry.path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'CF-Connecting-IP': SOURCE_IP,
          ...(entry.cookie ? { cookie: entry.cookie } : {}),
        },
        body: JSON.stringify(entry.body),
      }, boundary.env);
    }

    expect(new Set(boundary.keys).size).toBe(4);
  });

  it('does not let a caller rotate registration cookies around the IP boundary', async () => {
    const boundary = deniedAtBoundary();
    for (const registrationToken of ['first-id.first-secret', 'second-id.second-secret']) {
      await createApp().request('/api/host/register/resend', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'CF-Connecting-IP': SOURCE_IP,
          cookie: `candidary_registration=${registrationToken}`,
        },
        body: '{}',
      }, boundary.env);
    }

    expect(boundary.keys).toHaveLength(2);
    expect(boundary.keys[0]).toBe(boundary.keys[1]);
  });
});

it('derives the boundary key from CF-Connecting-IP alone', async () => {
  // Host auth and RSVP lookup now share one hardened extractor, so a forwarding
  // header a client can set must not change which budget is charged.
  async function keyFor(headers: Record<string, string>) {
    const boundary = deniedAtBoundary();
    await createApp().request('/api/host/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify({ email: 'host@example.com', password: 'a'.repeat(15) }),
    }, boundary.env);
    return boundary.keys[0];
  }

  const honest = await keyFor({ 'CF-Connecting-IP': SOURCE_IP });
  const spoofed = await keyFor({
    'CF-Connecting-IP': SOURCE_IP,
    'X-Forwarded-For': '198.51.100.7',
    Forwarded: 'for=198.51.100.8',
  });
  const headerless = await keyFor({ 'X-Forwarded-For': '198.51.100.7' });

  expect(spoofed).toBe(honest);
  // No Cloudflare header at all falls back to one shared bucket rather than an
  // unlimited supply of fresh ones.
  expect(headerless).not.toBe(honest);
  expect(await keyFor({})).toBe(headerless);
});

import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../../worker/auth/service';
import { decryptGuestSecret } from '../../worker/security/crypto';
import { createApp } from '../../worker/app';
import type { AppEnv } from '../../worker/env';
import { classifyExchangeFailure } from '../../worker/routes/exchange';

const testEnv = env as AppEnv & { TEST_MIGRATION_QUERIES: string };
const origin = env.APP_ORIGIN;

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Expected a session cookie.');
  return setCookie.split(';', 1)[0]!;
}

async function createEvent(name = 'Maya & Theo') {
  const response = await createApp().request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      name,
      eventDate: '2026-09-19',
      welcomeMessage: 'Add the moments only you noticed.',
    }),
  }, testEnv);
  return { response, body: await response.json<any>() };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, [{
    name: '0001_core.sql',
    queries: JSON.parse(testEnv.TEST_MIGRATION_QUERIES) as string[],
  }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('event creation', () => {
  it('creates separate links, encrypted guest redisplay, and a management session', async () => {
    const { response, body } = await createEvent();

    expect(response.status).toBe(201);
    expect(body.data.event.name).toBe('Maya & Theo');
    expect(body.data.guestLink).toMatch(new RegExp(`^${origin}/join/[^.]+\\.[^.]+$`));
    expect(body.data.managementLink).toMatch(new RegExp(`^${origin}/manage/[^.]+\\.[^.]+$`));
    expect(body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");

    const guestToken = new URL(body.data.guestLink).pathname.split('/').at(-1)!;
    const [guestId, guestSecret] = guestToken.split('.');
    const managerToken = new URL(body.data.managementLink).pathname.split('/').at(-1)!;
    const [managerId, managerSecret] = managerToken.split('.');
    const guestRow = await env.DB.prepare('SELECT * FROM event_access_tokens WHERE id = ?').bind(guestId).first<any>();
    const managerRow = await env.DB.prepare('SELECT * FROM event_access_tokens WHERE id = ?').bind(managerId).first<any>();
    const sessionCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM event_sessions WHERE role = 'manager'").first<{ count: number }>();

    expect(guestRow.secret_digest).not.toBe(guestSecret);
    expect(await decryptGuestSecret(guestRow.secret_ciphertext, testEnv.GUEST_TOKEN_ENCRYPTION_KEY)).toBe(guestSecret);
    expect(managerRow.secret_digest).not.toBe(managerSecret);
    expect(managerRow.secret_ciphertext).toBeNull();
    expect(sessionCount?.count).toBe(1);
  });

  it('returns stable field errors and rejects foreign origins', async () => {
    const invalid = await createApp().request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ name: '', eventDate: 'not-a-date', welcomeMessage: '' }),
    }, testEnv);
    const invalidBody = await invalid.json<any>();
    expect(invalid.status).toBe(422);
    expect(invalidBody.code).toBe('VALIDATION_FAILED');
    expect(invalidBody.fieldErrors).toMatchObject({ name: expect.any(String), eventDate: expect.any(String) });

    const foreign = await createApp().request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ name: 'Event', eventDate: '2026-09-19', welcomeMessage: 'Hello' }),
    }, testEnv);
    expect(foreign.status).toBe(403);
    expect((await foreign.json<any>()).code).toBe('ORIGIN_FORBIDDEN');
  });
});

describe('token exchange and session authorization', () => {
  it('exchanges a guest token, redirects without the secret, and resolves the event shell', async () => {
    const created = await createEvent();
    const guestPath = new URL(created.body.data.guestLink).pathname;
    const exchange = await createApp().request(guestPath, { redirect: 'manual' }, testEnv);

    expect(exchange.status).toBe(302);
    expect(exchange.headers.get('location')).toMatch(/^\/event\/[a-z0-9-]+$/);
    expect(exchange.headers.get('location')).not.toContain(guestPath.split('/').at(-1)!);
    const cookie = cookieFrom(exchange);
    const eventPath = exchange.headers.get('location')!;
    const shell = await createApp().request(`/api${eventPath}`, { headers: { cookie } }, testEnv);

    expect(shell.status).toBe(200);
    expect((await shell.json<any>()).data.event.name).toBe('Maya & Theo');
  });

  it('invalidates existing sessions as soon as the backing token is revoked', async () => {
    const created = await createEvent();
    const guestPath = new URL(created.body.data.guestLink).pathname;
    const exchange = await createApp().request(guestPath, { redirect: 'manual' }, testEnv);
    const cookie = cookieFrom(exchange);
    const tokenId = guestPath.split('/').at(-1)!.split('.')[0]!;
    await env.DB.prepare('UPDATE event_access_tokens SET revoked_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), tokenId).run();

    const shell = await createApp().request(`/api${exchange.headers.get('location')!}`, { headers: { cookie } }, testEnv);
    expect(shell.status).toBe(401);
    expect((await shell.json<any>()).code).toBe('TOKEN_REVOKED');
  });

  it('prevents a manager session from crossing event boundaries', async () => {
    const first = await createEvent('First event');
    const firstCookie = cookieFrom(first.response);
    const second = await createEvent('Second event');
    const secondId = second.body.data.event.id;

    const response = await createApp().request(`/api/manage/events/${secondId}`, {
      headers: { cookie: firstCookie },
    }, testEnv);
    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('ROLE_FORBIDDEN');
  });

  it('redirects failed manager document navigations to a token-free recovery route while JSON clients retain the API error', async () => {
    const invalidPath = '/manage/invalid.token';

    const navigate = await createApp().request(invalidPath, {
      redirect: 'manual',
      headers: { 'sec-fetch-mode': 'navigate' },
    }, testEnv);
    expect(navigate.status).toBe(302);
    expect(navigate.headers.get('location')).toBe('/recover/manage?kind=latest-link');
    expect(navigate.headers.get('location')).not.toContain('invalid.token');
    expect(navigate.headers.get('referrer-policy')).toBe('no-referrer');

    const html = await createApp().request(invalidPath, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml' },
    }, testEnv);
    expect(html.status).toBe(302);
    expect(html.headers.get('location')).toBe('/recover/manage?kind=latest-link');

    const json = await createApp().request(invalidPath, {
      headers: { accept: 'application/json' },
    }, testEnv);
    expect(json.status).toBe(401);
    expect((await json.json<{ code: string }>()).code).toBe('SESSION_REQUIRED');
  });

  it.each([
    ['revoked manager link', 'revoked_at', 'latest-link'],
    ['expired manager link', 'expires_at', 'ended-event'],
  ] as const)('redirects a %s document navigation with %s recovery', async (_label, column, kind) => {
    const created = await createEvent();
    const managerPath = new URL(created.body.data.managementLink).pathname;
    const tokenId = managerPath.split('/').at(-1)!.split('.')[0]!;
    const value = column === 'revoked_at'
      ? new Date().toISOString()
      : new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(`UPDATE event_access_tokens SET ${column} = ? WHERE id = ?`).bind(value, tokenId).run();

    const response = await createApp().request(managerPath, {
      redirect: 'manual',
      headers: { 'sec-fetch-mode': 'navigate' },
    }, testEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/recover/manage?kind=${kind}`);
    expect(response.headers.get('location')).not.toContain(managerPath.split('/').at(-1)!);
  });

  it('redirects a deleted event manager navigation with ended-event recovery', async () => {
    const created = await createEvent();
    const managerPath = new URL(created.body.data.managementLink).pathname;
    await env.DB.prepare('UPDATE events SET deleted_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), created.body.data.event.id).run();

    const response = await createApp().request(managerPath, {
      redirect: 'manual',
      headers: { 'sec-fetch-mode': 'navigate' },
    }, testEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/recover/manage?kind=ended-event');
    expect(response.headers.get('location')).not.toContain(managerPath.split('/').at(-1)!);
  });

  it('preserves host cookies when a manager link establishes its event session', async () => {
    const created = await createEvent();
    const managerPath = new URL(created.body.data.managementLink).pathname;

    const response = await createApp().request(managerPath, {
      redirect: 'manual',
      headers: {
        cookie: 'candidary_host=dummy.host; candidary_host_csrf=dummy-csrf',
      },
    }, testEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/manage/event/${created.body.data.event.id}`);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringContaining('candidary_session='),
      expect.stringContaining('candidary_csrf='),
    ]));
    expect(cookies).not.toEqual(expect.arrayContaining([
      expect.stringContaining('candidary_host='),
      expect.stringContaining('candidary_host_csrf='),
    ]));
  });

  it('classifies an unexpected manager exchange failure as retryable', () => {
    expect(classifyExchangeFailure(new Error('unexpected'))).toBe('retry');
  });

  it('reports unexpected manager document failures before token-free retry recovery', async () => {
    vi.spyOn(AuthService.prototype, 'exchange')
      .mockRejectedValueOnce(new Error('database unavailable'));
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await createApp().request('/manage/not-a-real.token', {
      redirect: 'manual',
      headers: { 'sec-fetch-mode': 'navigate' },
    }, testEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/recover/manage?kind=retry');
    expect(report).toHaveBeenCalledTimes(1);
    const entry = String(report.mock.calls[0]?.[0]);
    expect(entry).toContain('"event":"manager_exchange_failed"');
    expect(entry).toContain('"errorName":"Error"');
    expect(entry).not.toContain('not-a-real.token');
    expect(entry).not.toContain('database unavailable');
  });
});


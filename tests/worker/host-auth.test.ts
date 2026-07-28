import { env } from 'cloudflare:workers';
import { scrypt } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rehashControl = vi.hoisted(() => ({
  pause: null as null | { arrived: () => void; release: Promise<void> },
}));

vi.mock('../../worker/security/passwords', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../worker/security/passwords')>();
  return {
    ...actual,
    hashPassword: async (password: string) => {
      const pause = rehashControl.pause;
      if (pause) {
        rehashControl.pause = null;
        pause.arrived();
        await pause.release;
      }
      return actual.hashPassword(password);
    },
  };
});

import { createApp } from '../../worker/app';
import { HostSessionsRepository, SessionsRepository } from '../../worker/db/sessions';
import { digestSecret } from '../../worker/security/crypto';
import { verifyPassword } from '../../worker/security/passwords';
import { HostAuthService } from '../../worker/services/host-auth';
import { cookiesFrom, eventAccess, origin, resetDatabase, testEnv } from './helpers';

const PASSWORD = 'a-sufficiently-long-password';

async function lowerCostHash(password: string): Promise<string> {
  const salt = Buffer.alloc(16, 7);
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, {
      N: 16384, r: 8, p: 3, maxmem: 64 * 1024 * 1024,
    }, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
  return `scrypt$16384$8$3$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function hostCookiesFrom(response: Response) {
  const value = response.headers.getSetCookie().join(', ');
  const session = /candidary_host=([^;,]+)/u.exec(value)?.[1];
  const csrf = /candidary_host_csrf=([^;,]+)/u.exec(value)?.[1];
  if (!session || !csrf) throw new Error(`Expected host cookies, received: ${value}`);
  return { cookie: `candidary_host=${session}; candidary_host_csrf=${csrf}`, csrf };
}

function hostHeaders(access: { cookie: string; csrf: string }, extraCookie = '') {
  return {
    'content-type': 'application/json',
    cookie: extraCookie ? `${access.cookie}; ${extraCookie}` : access.cookie,
    origin,
    'x-candidary-host-csrf': access.csrf,
  };
}

function eventSessionId(cookie: string): string {
  const token = /candidary_session=([^;]+)/u.exec(cookie)?.[1];
  if (!token) throw new Error(`Expected event session cookie, received: ${cookie}`);
  return token.split('.')[0]!;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return createApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  }, testEnv);
}

async function register(email: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return post('/api/host/register', { email, password: PASSWORD, ...extra }, headers);
}

// Only the digest of a code is ever stored, and recovering the original would mean
// digesting up to a million candidates — which is the point of storing it that way.
// The live challenge is restamped with a known code instead, so every check the
// real path performs still runs: the digest comparison, the attempt spend, and the
// single-use consumption. That the mailed code is the digested one is fixed by
// construction — `issueChallenge` digests and sends the same local.
async function forceCode(
  email: string,
  purpose: 'verify' | 'reset',
  code = '424242',
): Promise<string> {
  const row = await env.DB.prepare(`
    SELECT c.id AS id FROM host_login_challenges c
    JOIN host_accounts a ON a.id = c.account_id
    WHERE a.email = ? AND c.purpose = ? AND c.consumed_at IS NULL
    ORDER BY c.created_at DESC LIMIT 1
  `).bind(email, purpose).first<{ id: string }>();
  if (!row) throw new Error(`No live ${purpose} challenge for ${email}.`);
  await env.DB.prepare('UPDATE host_login_challenges SET secret_digest = ? WHERE id = ?')
    .bind(await digestSecret(code, testEnv.LOGIN_HMAC_KEY), row.id).run();
  return code;
}

beforeEach(resetDatabase);

describe('registration', () => {
  it('creates an account, signs the host in, and issues a verification code', async () => {
    const response = await register('host@example.com');

    expect(response.status).toBe(202);
    const host = hostCookiesFrom(response);
    const session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    const body = await session.json<any>();
    expect(body.data.account.email).toBe('host@example.com');
    expect(body.data.account.emailVerified).toBe(false);
    expect(body.data.events).toEqual([]);

    const challenge = await env.DB.prepare("SELECT COUNT(*) AS count FROM host_login_challenges WHERE purpose = 'verify'")
      .first<{ count: number }>();
    expect(challenge?.count).toBe(1);
  });

  it('normalizes the address and answers a taken one identically, without a second account', async () => {
    const first = await register('Host@Example.com');
    expect(first.status).toBe(202);

    const second = await register('host@example.com');

    expect(second.status).toBe(202);
    expect(await second.json<any>()).toMatchObject({ data: { registered: true } });
    // No session is minted for the address it does not own, which is the only way
    // the two responses differ — and it is not visible in the body.
    expect(second.headers.getSetCookie().join(',')).not.toContain('candidary_host=');
    const accounts = await env.DB.prepare('SELECT COUNT(*) AS count FROM host_accounts').first<{ count: number }>();
    expect(accounts?.count).toBe(1);
  });

  it('refuses a short password with a field error', async () => {
    const response = await post('/api/host/register', { email: 'host@example.com', password: 'short' });

    expect(response.status).toBe(422);
    expect((await response.json<any>()).fieldErrors.password).toBeTruthy();
  });

  it('binds the event named by a live management session and ignores one that is not', async () => {
    const access = await eventAccess();

    const bound = await register('host@example.com', { bindEventId: access.event.id }, { cookie: access.manager.cookie });
    expect((await bound.json<any>()).data.boundEvent).toBe(true);

    const other = await eventAccess('Someone Else');
    const unbound = await register('thief@example.com', { bindEventId: other.event.id });
    expect((await unbound.json<any>()).data.boundEvent).toBe(false);

    const hosts = await env.DB.prepare('SELECT event_id FROM event_hosts').all<{ event_id: string }>();
    expect(hosts.results.map((row) => row.event_id)).toEqual([access.event.id]);
  });

  it('marks the event creator management session as able to claim ownership', async () => {
    const access = await eventAccess();

    const session = await new SessionsRepository(env.DB).getById(eventSessionId(access.manager.cookie));

    expect(session?.canClaimOwner).toBe(true);
  });

  it('does not give exchanged management-link sessions ownership claim authority', async () => {
    const access = await eventAccess();
    const exchanged = await createApp().request(new URL(access.managementLink).pathname, {
      redirect: 'manual',
    }, testEnv);

    const session = await new SessionsRepository(env.DB).getById(eventSessionId(cookiesFrom(exchanged).cookie));

    expect(session?.canClaimOwner).toBe(false);
  });
});

describe('sign in', () => {
  it('accepts the right password and rejects a wrong one identically to an unknown address', async () => {
    await register('host@example.com');

    const good = await post('/api/host/login', { email: 'host@example.com', password: PASSWORD });
    expect(good.status).toBe(200);
    expect(hostCookiesFrom(good).cookie).toContain('candidary_host=');

    const wrongPassword = await post('/api/host/login', { email: 'host@example.com', password: 'wrong-password-here' });
    const unknownAddress = await post('/api/host/login', { email: 'nobody@example.com', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAddress.status).toBe(401);
    expect(await wrongPassword.json<any>()).toMatchObject({ code: 'LOGIN_CREDENTIALS_INVALID' });
    expect((await unknownAddress.json<any>()).code).toBe('LOGIN_CREDENTIALS_INVALID');
  });

  it('refuses a cross-origin sign-in', async () => {
    await register('host@example.com');

    const response = await createApp().request('/api/host/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'host@example.com', password: PASSWORD }),
    }, testEnv);

    expect((await response.json<any>()).code).toBe('ORIGIN_FORBIDDEN');
  });

  it('rejects a host session whose account authentication version changed', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));
    await env.DB.prepare('UPDATE host_accounts SET auth_version = auth_version + 1').run();

    const response = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);

    expect(response.status).toBe(401);
    expect((await response.json<any>()).code).toBe('SESSION_EXPIRED');
  });

  it('refuses a host-session insert with a stale account authentication version', async () => {
    await register('host@example.com');
    const account = await env.DB.prepare('SELECT id, auth_version FROM host_accounts').first<{
      id: string;
      auth_version: number;
    }>();

    const session = await new HostSessionsRepository(env.DB).createIfAuthVersion({
      id: 'stale-version-session',
      secretDigest: 'digest',
      csrfDigest: 'csrf',
      accountId: account!.id,
      authVersion: account!.auth_version + 1,
      expiresAt: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(session).toBeNull();
  });

  it('refuses a host-session insert for a disabled account', async () => {
    await register('host@example.com');
    const account = await env.DB.prepare('SELECT id, auth_version FROM host_accounts').first<{
      id: string;
      auth_version: number;
    }>();
    await env.DB.prepare('UPDATE host_accounts SET disabled_at = ? WHERE id = ?')
      .bind('2026-07-28T00:00:00.000Z', account!.id).run();

    const session = await new HostSessionsRepository(env.DB).createIfAuthVersion({
      id: 'disabled-account-session',
      secretDigest: 'digest',
      csrfDigest: 'csrf',
      accountId: account!.id,
      authVersion: account!.auth_version,
      expiresAt: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(session).toBeNull();
  });
});

describe('email verification', () => {
  it('verifies with the issued code and refuses to reuse it', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));
    const code = await forceCode('host@example.com', 'verify');

    const verified = await post('/api/host/verify', { code }, hostHeaders(host));
    expect(verified.status).toBe(200);

    const replay = await post('/api/host/verify', { code }, hostHeaders(host));
    expect((await replay.json<any>()).code).toBe('LOGIN_CODE_EXPIRED');
  });

  it('locks the code after five wrong guesses', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));
    const code = await forceCode('host@example.com', 'verify');
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await (await post('/api/host/verify', { code: wrong }, hostHeaders(host))).json<any>()).code)
        .toBe('LOGIN_CODE_INVALID');
    }

    // The sixth attempt is refused before the digest is even compared, so the
    // correct code no longer helps.
    const exhausted = await post('/api/host/verify', { code }, hostHeaders(host));
    expect((await exhausted.json<any>()).code).toBe('LOGIN_CODE_EXPIRED');
  });

  it('requires the host CSRF header, not the event one', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));
    const code = await forceCode('host@example.com', 'verify');

    const response = await post('/api/host/verify', { code }, {
      cookie: host.cookie,
      'x-candidary-csrf': host.csrf,
    });

    expect((await response.json<any>()).code).toBe('CSRF_INVALID');
  });
});

describe('password reset', () => {
  it('answers a forgotten-password request the same for a known and an unknown address', async () => {
    await register('host@example.com');

    const known = await post('/api/host/password/forgot', { email: 'host@example.com' });
    const unknown = await post('/api/host/password/forgot', { email: 'nobody@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await known.json<any>()).toMatchObject({ data: { sent: true } });
    expect(await unknown.json<any>()).toMatchObject({ data: { sent: true } });
  });

  it('changes the password, revokes open sessions, and verifies the address', async () => {
    const first = hostCookiesFrom(await register('host@example.com'));
    await post('/api/host/password/forgot', { email: 'host@example.com' });
    const code = await forceCode('host@example.com', 'reset');

    const reset = await post('/api/host/password/reset', {
      email: 'host@example.com', code, password: 'a-brand-new-long-password',
    });
    expect(reset.status).toBe(200);

    // The session held before the reset is gone.
    const stale = await createApp().request('/api/host/session', { headers: { cookie: first.cookie } }, testEnv);
    expect(stale.status).toBe(401);

    // The new session works, and resetting proved the address.
    const fresh = hostCookiesFrom(reset);
    const session = await createApp().request('/api/host/session', { headers: { cookie: fresh.cookie } }, testEnv);
    expect((await session.json<any>()).data.account.emailVerified).toBe(true);

    const oldPassword = await post('/api/host/login', { email: 'host@example.com', password: PASSWORD });
    expect(oldPassword.status).toBe(401);
    const newPassword = await post('/api/host/login', { email: 'host@example.com', password: 'a-brand-new-long-password' });
    expect(newPassword.status).toBe(200);
  });

  it('prevents a login verified before reset from creating a host session afterward', async () => {
    await register('host@example.com');
    const account = await env.DB.prepare('SELECT id, auth_version FROM host_accounts').first<{
      id: string;
      auth_version: number;
    }>();
    await post('/api/host/password/forgot', { email: 'host@example.com' });
    const code = await forceCode('host@example.com', 'reset');

    const reset = await post('/api/host/password/reset', {
      email: 'host@example.com', code, password: 'a-brand-new-long-password',
    });
    expect(reset.status).toBe(200);

    const staleSession = await new HostSessionsRepository(env.DB).createIfAuthVersion({
      id: 'login-that-finished-after-reset',
      secretDigest: 'digest',
      csrfDigest: 'csrf',
      accountId: account!.id,
      authVersion: account!.auth_version,
      expiresAt: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-07-28T00:00:00.000Z',
    });

    expect(staleSession).toBeNull();
  });

  it('does not let a stale lower-cost login rehash overwrite a concurrent reset', async () => {
    await register('host@example.com');
    await env.DB.prepare('UPDATE host_accounts SET password_hash = ? WHERE email = ?')
      .bind(await lowerCostHash(PASSWORD), 'host@example.com').run();
    const before = await env.DB.prepare('SELECT password_hash FROM host_accounts WHERE email = ?')
      .bind('host@example.com').first<{ password_hash: string }>();
    expect(await verifyPassword(PASSWORD, before!.password_hash)).toEqual({ valid: true, needsRehash: true });

    let releaseRehash!: () => void;
    const rehashStarted = new Promise<void>((resolve) => {
      rehashControl.pause = {
        arrived: resolve,
        release: new Promise<void>((release) => { releaseRehash = release; }),
      };
    });
    const staleLogin = new HostAuthService(testEnv).authenticate('host@example.com', PASSWORD);
    await rehashStarted;

    await post('/api/host/password/forgot', { email: 'host@example.com' });
    const code = await forceCode('host@example.com', 'reset');
    const reset = await post('/api/host/password/reset', {
      email: 'host@example.com', code, password: 'a-brand-new-long-password',
    });
    expect(reset.status).toBe(200);

    releaseRehash();
    await expect(staleLogin).resolves.toMatchObject({ email: 'host@example.com' });

    const after = await env.DB.prepare('SELECT password_hash FROM host_accounts WHERE email = ?')
      .bind('host@example.com').first<{ password_hash: string }>();
    expect(await verifyPassword('a-brand-new-long-password', after!.password_hash))
      .toEqual({ valid: true, needsRehash: false });
    expect(await verifyPassword(PASSWORD, after!.password_hash))
      .toEqual({ valid: false, needsRehash: false });
  });
});

describe('managing an event through an account', () => {
  it('reaches every host surface without the management link', async () => {
    const access = await eventAccess();
    const host = hostCookiesFrom(
      await register('host@example.com', { bindEventId: access.event.id }, { cookie: access.manager.cookie }),
    );

    const settings = await createApp().request(`/api/manage/events/${access.event.id}/settings`, {
      method: 'PATCH',
      headers: hostHeaders(host),
      body: JSON.stringify({
        uploadsEnabled: false, galleryVisible: true, moderationRequired: true,
      }),
    }, testEnv);
    expect(settings.status).toBe(200);
    expect((await settings.json<any>()).data.event.uploadsEnabled).toBe(false);

    const media = await createApp().request(`/api/manage/events/${access.event.id}/media`, {
      headers: { cookie: host.cookie },
    }, testEnv);
    expect(media.status).toBe(200);

    const links = await createApp().request(`/api/manage/events/${access.event.id}/links`, {
      headers: { cookie: host.cookie },
    }, testEnv);
    expect(links.status).toBe(200);
    expect((await links.json<any>()).data.guestLink).toContain('/join/');
  });

  it('refuses an account that does not host the event', async () => {
    const access = await eventAccess();
    const stranger = hostCookiesFrom(await register('stranger@example.com'));

    const response = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: stranger.cookie },
    }, testEnv);

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('ROLE_FORBIDDEN');
  });

  it('keeps both credentials usable at once', async () => {
    const access = await eventAccess();
    const host = hostCookiesFrom(
      await register('host@example.com', { bindEventId: access.event.id }, { cookie: access.manager.cookie }),
    );

    // Registering must not have disturbed the management link session sharing the
    // browser: a planner holding the link and a signed-in host are both valid.
    const viaLink = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: access.manager.cookie },
    }, testEnv);
    const viaBoth = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: `${host.cookie}; ${access.manager.cookie}` },
    }, testEnv);

    expect(viaLink.status).toBe(200);
    expect(viaBoth.status).toBe(200);
  });

  it('falls back to the management link when the account session has lapsed', async () => {
    const access = await eventAccess();
    const host = hostCookiesFrom(
      await register('host@example.com', { bindEventId: access.event.id }, { cookie: access.manager.cookie }),
    );
    await env.DB.prepare('UPDATE host_sessions SET revoked_at = ?')
      .bind(new Date().toISOString()).run();

    const both = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: `${host.cookie}; ${access.manager.cookie}` },
    }, testEnv);
    expect(both.status).toBe(200);

    // With nothing to fall back to, the same dead cookie reports a lapsed sign-in
    // rather than a refusal, because those call for different things next.
    const alone = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: host.cookie },
    }, testEnv);
    expect(alone.status).toBe(401);
    expect((await alone.json<any>()).code).toBe('SESSION_EXPIRED');
  });

  it('adopts an event held by link into a signed-in account', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));
    const access = await eventAccess('Later Wedding');

    const adopted = await post(`/api/host/events/${access.event.id}/adopt`, {},
      hostHeaders(host, access.manager.cookie));
    expect(adopted.status).toBe(200);

    const session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.events).toHaveLength(1);
  });

  it('refuses to adopt an event the account holds no link for', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));
    const access = await eventAccess('Not Yours');

    const response = await post(`/api/host/events/${access.event.id}/adopt`, {}, hostHeaders(host));

    expect(response.status).toBe(403);
  });
});

describe('sign out', () => {
  it('revokes the session and clears the cookie', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));

    const response = await post('/api/host/logout', {}, hostHeaders(host));
    expect(response.status).toBe(200);

    const after = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect(after.status).toBe(401);
  });
});

describe('unsubscribing', () => {
  it('turns notifications off from a signed link and ignores a forged one', async () => {
    const host = hostCookiesFrom(await register('host@example.com'));
    const account = await env.DB.prepare('SELECT id FROM host_accounts LIMIT 1').first<{ id: string }>();
    const digest = await digestSecret(`unsubscribe:${account!.id}`, testEnv.LOGIN_HMAC_KEY);

    const forged = await createApp().request(`/host/unsubscribe/${account!.id}.not-the-signature`, {}, testEnv);
    expect(forged.status).toBe(200);
    let session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.account.notificationsEnabled).toBe(true);

    const real = await createApp().request(`/host/unsubscribe/${account!.id}.${digest}`, {}, testEnv);
    expect(real.status).toBe(200);
    session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.account.notificationsEnabled).toBe(false);
  });
});

describe('guest sessions', () => {
  it('cannot be used to reach a host account surface', async () => {
    const access = await eventAccess();

    const response = await createApp().request('/api/host/session', {
      headers: { cookie: access.guest.cookie },
    }, testEnv);

    expect(response.status).toBe(401);
    expect((await response.json<any>()).code).toBe('HOST_SESSION_REQUIRED');
  });
});

// Guards the one thing a test suite cannot observe directly: that `cookiesFrom`
// still finds the event cookies now that a response may carry two pairs.
it('keeps the event and host cookie pairs distinct', async () => {
  const access = await eventAccess();
  const response = await register('host@example.com', { bindEventId: access.event.id }, { cookie: access.manager.cookie });

  const cookies = response.headers.getSetCookie().join(', ');
  expect(cookies).toContain('candidary_host=');
  expect(cookies).toContain('candidary_host_csrf=');
  expect(cookies).not.toContain('candidary_session=');
  expect(() => cookiesFrom(response)).toThrow();
});

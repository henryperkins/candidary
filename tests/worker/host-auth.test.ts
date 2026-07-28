import { env } from 'cloudflare:workers';
import { scrypt } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PasswordModule from '../../worker/security/passwords';

const rehashControl = vi.hoisted(() => ({
  pause: null as null | { arrived: () => void; release: Promise<void> },
}));

vi.mock('../../worker/security/passwords', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
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
import { AccountsRepository } from '../../worker/db/accounts';
import { HostSessionsRepository, SessionsRepository } from '../../worker/db/sessions';
import { digestSecret } from '../../worker/security/crypto';
import { verifyPassword } from '../../worker/security/passwords';
import { EmailService } from '../../worker/services/email';
import { HostAuthService } from '../../worker/services/host-auth';
import { cookiesFrom, eventAccess, origin, resetDatabase, testEnv } from './helpers';

const PASSWORD = 'a-sufficiently-long-password';
const trackedWaitUntil: Promise<unknown>[] = [];

const executionContext = {
  waitUntil(promise: Promise<unknown>) {
    trackedWaitUntil.push(promise);
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

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

function registrationCookiesFrom(response: Response) {
  const value = response.headers.getSetCookie().join(', ');
  const registration = /candidary_registration=([^;,]+)/u.exec(value)?.[1];
  if (!registration) throw new Error(`Expected registration cookie, received: ${value}`);
  return { cookie: `candidary_registration=${registration}`, token: registration };
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
  }, testEnv, executionContext);
}

async function register(email: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return post('/api/host/register', { email, password: PASSWORD, ...extra }, headers);
}

async function forceRegistrationCode(
  email: string,
  code = '424242',
): Promise<string> {
  const row = await env.DB.prepare(`
    SELECT id FROM host_registration_challenges
    WHERE email = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).bind(email).first<{ id: string }>();
  if (!row) throw new Error(`No live registration challenge for ${email}.`);
  await env.DB.prepare('UPDATE host_registration_challenges SET code_digest = ? WHERE id = ?')
    .bind(await digestSecret(code, testEnv.LOGIN_HMAC_KEY), row.id).run();
  return code;
}

async function completeRegistration(
  started: Response,
  email: string,
  headers: Record<string, string> = {},
) {
  const pending = registrationCookiesFrom(started);
  const code = await forceRegistrationCode(email);
  return post('/api/host/register/complete', { code }, {
    ...headers,
    cookie: [pending.cookie, headers.cookie].filter(Boolean).join('; '),
  });
}

async function registerAndComplete(
  email: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return completeRegistration(
    await register(email, extra, headers),
    email.trim().toLowerCase(),
    headers,
  );
}

async function registeredHost(
  email: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return hostCookiesFrom(await registerAndComplete(email, extra, headers));
}

async function unverifiedHost(email: string) {
  const host = await registeredHost(email);
  await env.DB.prepare('UPDATE host_accounts SET email_verified_at = NULL WHERE email = ?')
    .bind(email).run();
  const account = await new AccountsRepository(env.DB).getByEmail(email);
  await new HostAuthService(testEnv).issueChallenge(account!, 'verify', null);
  return host;
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
  await Promise.all(trackedWaitUntil.splice(0));
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

beforeEach(async () => {
  await Promise.all(trackedWaitUntil.splice(0));
  await resetDatabase();
});

describe('registration', () => {
  it('creates no account, owner, or host session before mailbox proof', async () => {
    const access = await eventAccess();
    const response = await register(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );

    expect(response.status).toBe(202);
    expect(await response.json<any>()).toMatchObject({ data: { registrationPending: true } });
    expect(response.headers.getSetCookie().join(', ')).toContain('candidary_registration=');
    for (const table of ['host_accounts', 'event_hosts', 'host_sessions']) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first('count')).toBe(0);
    }
  });

  it('completes a pending registration and reports the true owner claim', async () => {
    const access = await eventAccess();
    const started = await register(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );

    const completed = await completeRegistration(started, 'host@example.com', {
      cookie: access.manager.cookie,
    });

    expect(completed.status).toBe(200);
    expect(await completed.json<any>()).toMatchObject({
      data: { registered: true, boundEvent: true },
    });
    expect(hostCookiesFrom(completed).cookie).toContain('candidary_host=');
    expect(completed.headers.getSetCookie().join(', ')).toContain('candidary_registration=;');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_accounts').first('count')).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM event_hosts WHERE role = 'owner'").first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_sessions').first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(3);
  });

  it('answers new and existing addresses with indistinguishable start responses and cookies', async () => {
    const firstStart = await register('Host@Example.com', { displayName: 'Original Host' });
    const firstComplete = await completeRegistration(firstStart, 'host@example.com');
    expect(firstComplete.status).toBe(200);
    const before = await env.DB.prepare(`
      SELECT password_hash, auth_version, display_name FROM host_accounts WHERE email = ?
    `).bind('host@example.com').first<{
      password_hash: string;
      auth_version: number;
      display_name: string | null;
    }>();

    const newAddress = await register('new@example.com');
    const existingAddress = await register('HOST@example.com', { displayName: 'Replacement Name' });
    const newBody = await newAddress.json<any>();
    const existingBody = await existingAddress.json<any>();
    const cookieWithoutValue = (response: Response) => response.headers.getSetCookie()
      .map((value) => value.replace(/candidary_registration=[^;]+/u, 'candidary_registration=<opaque>'));

    expect(newAddress.status).toBe(202);
    expect(existingAddress.status).toBe(202);
    expect(existingBody.data).toEqual(newBody.data);
    expect(cookieWithoutValue(existingAddress)).toEqual(cookieWithoutValue(newAddress));
    expect(cookieWithoutValue(existingAddress)).toEqual([
      'candidary_registration=<opaque>; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);

    const existingComplete = await completeRegistration(existingAddress, 'host@example.com');
    expect(existingComplete.status).toBe(200);
    expect(hostCookiesFrom(existingComplete).cookie).toContain('candidary_host=');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_accounts').first('count')).toBe(1);
    expect(await env.DB.prepare(`
      SELECT password_hash, auth_version, display_name FROM host_accounts WHERE email = ?
    `).bind('host@example.com').first()).toEqual(before);
  });

  it('atomically replaces concurrent starts so only one browser challenge remains live', async () => {
    const [first, second] = await Promise.all([
      register('host@example.com', {}, { 'CF-Connecting-IP': '203.0.113.40' }),
      register('host@example.com', {}, { 'CF-Connecting-IP': '203.0.113.40' }),
    ]);
    const live = await env.DB.prepare(`
      SELECT id FROM host_registration_challenges
      WHERE email = ? AND consumed_at IS NULL
    `).bind('host@example.com').all<{ id: string }>();
    const cookieIds = [first, second].map((response) =>
      registrationCookiesFrom(response).token.split('.')[0],
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(live.results).toHaveLength(1);
    expect(cookieIds).toContain(live.results[0]!.id);
  });

  it('resends through the pending cookie and replaces the usable code', async () => {
    const started = await register('host@example.com');
    const pending = registrationCookiesFrom(started);
    const oldCode = await forceRegistrationCode('host@example.com', '111111');

    const resent = await post('/api/host/register/resend', {}, {
      cookie: pending.cookie,
      'CF-Connecting-IP': '203.0.113.10',
    });
    expect(resent.status).toBe(202);
    expect(await resent.json<any>()).toMatchObject({ data: { registrationPending: true } });
    expect(resent.headers.getSetCookie()).toContain(
      `candidary_registration=${pending.token}; Max-Age=900; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM host_registration_challenges
      WHERE email = ? AND consumed_at IS NULL
    `).bind('host@example.com').first('count')).toBe(1);

    const oldCompletion = await post('/api/host/register/complete', { code: oldCode }, {
      cookie: pending.cookie,
    });
    expect((await oldCompletion.json<any>()).code).toBe('LOGIN_CODE_INVALID');
  });

  it('does not renew the pending cookie when the resend email is undeliverable', async () => {
    const pending = registrationCookiesFrom(await register('host@example.com'));
    vi.spyOn(EmailService.prototype, 'send')
      .mockResolvedValueOnce({ delivered: false, code: 'provider_rejected' });

    const resent = await post('/api/host/register/resend', {}, {
      cookie: pending.cookie,
      'CF-Connecting-IP': '203.0.113.13',
    });

    expect(resent.status).toBe(502);
    expect(await resent.json<any>()).toMatchObject({ code: 'LOGIN_EMAIL_UNDELIVERABLE' });
    expect(resent.headers.getSetCookie()).not.toContain(
      expect.stringContaining('candidary_registration='),
    );
  });

  it('does not bind an existing account when resend supersedes its loaded code snapshot', async () => {
    await registeredHost('host@example.com');
    const access = await eventAccess();
    const started = await register(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    const pending = registrationCookiesFrom(started);
    const code = await forceRegistrationCode('host@example.com');
    const account = await new AccountsRepository(env.DB).getByEmail('host@example.com');
    expect(account).not.toBeNull();
    expect(await env.DB.prepare(`
      SELECT bind_event_id FROM host_registration_challenges WHERE id = ?
    `).bind(pending.token.split('.')[0]!).first('bind_event_id')).toBe(access.event.id);
    const sessionsBefore = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM host_sessions',
    ).first<number>('count');

    let activationReached!: () => void;
    const reachedActivation = new Promise<void>((resolve) => { activationReached = resolve; });
    let resumeActivation!: () => void;
    const activationRelease = new Promise<void>((resolve) => { resumeActivation = resolve; });
    const activateRegistration = AccountsRepository.prototype.activateRegistration;
    vi.spyOn(AccountsRepository.prototype, 'activateRegistration')
      .mockImplementationOnce(async (snapshot, activatedAt) => {
        activationReached();
        await activationRelease;
        return activateRegistration.call(new AccountsRepository(env.DB), snapshot, activatedAt);
      });

    const completing = post('/api/host/register/complete', { code }, {
      cookie: `${pending.cookie}; ${access.manager.cookie}`,
    });
    await reachedActivation;
    const resent = await post('/api/host/register/resend', {}, {
      cookie: pending.cookie,
      'CF-Connecting-IP': '203.0.113.14',
    });
    resumeActivation();
    const completed = await completing;

    expect(resent.status).toBe(202);
    expect(completed.status).toBe(400);
    expect(await completed.json<any>()).toMatchObject({ code: 'LOGIN_CODE_INVALID' });
    expect(completed.headers.getSetCookie()).not.toContain(
      expect.stringContaining('candidary_host='),
    );
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_sessions').first('count'))
      .toBe(sessionsBefore);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_hosts').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
  });

  it('lets exactly one identical registration completion consume its activation snapshot', async () => {
    const started = await register('host@example.com');
    const pending = registrationCookiesFrom(started);
    const code = await forceRegistrationCode('host@example.com');
    const now = new Date();
    const service = new HostAuthService(testEnv);

    const completions = await Promise.allSettled([
      service.completeRegistration(pending.token, code, null, now),
      service.completeRegistration(pending.token, code, null, now),
    ]);

    expect(completions.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(completions.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_accounts').first('count')).toBe(1);
  });

  it('spends registration attempts before comparison and locks after five guesses', async () => {
    const started = await register('host@example.com');
    const pending = registrationCookiesFrom(started);
    const code = await forceRegistrationCode('host@example.com');
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post('/api/host/register/complete', { code: wrong }, {
        cookie: pending.cookie,
      });
      expect((await response.json<any>()).code).toBe('LOGIN_CODE_INVALID');
    }

    const exhausted = await post('/api/host/register/complete', { code }, {
      cookie: pending.cookie,
    });
    expect((await exhausted.json<any>()).code).toBe('LOGIN_CODE_INVALID');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_accounts').first('count')).toBe(0);
  });

  it('requires the exact still-live creator session at completion', async () => {
    const access = await eventAccess();
    const started = await register(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    await env.DB.prepare('UPDATE event_sessions SET revoked_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), eventSessionId(access.manager.cookie)).run();

    const completed = await completeRegistration(started, 'host@example.com', {
      cookie: access.manager.cookie,
    });

    expect(completed.status).toBe(200);
    expect(await completed.json<any>()).toMatchObject({
      data: { registered: true, boundEvent: false },
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_accounts').first('count')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_hosts').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
  });

  it('does not substitute a different valid manager session at completion', async () => {
    const access = await eventAccess();
    const started = await register(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    const exchanged = await createApp().request(new URL(access.managementLink).pathname, {
      redirect: 'manual',
    }, testEnv);

    const completed = await completeRegistration(started, 'host@example.com', {
      cookie: cookiesFrom(exchanged).cookie,
    });

    expect(completed.status).toBe(200);
    expect(await completed.json<any>()).toMatchObject({
      data: { registered: true, boundEvent: false },
    });
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_hosts').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
  });

  it('does not report an existing cohost membership as an owner claim', async () => {
    await registerAndComplete('host@example.com');
    const account = await env.DB.prepare('SELECT id FROM host_accounts WHERE email = ?')
      .bind('host@example.com').first<{ id: string }>();
    const access = await eventAccess();
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, ?, 'cohost', ?)
    `).bind(access.event.id, account!.id, '2026-07-21T12:00:00.000Z').run();
    const started = await register(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );

    const completed = await completeRegistration(started, 'host@example.com', {
      cookie: access.manager.cookie,
    });

    expect(completed.status).toBe(200);
    expect(await completed.json<any>()).toMatchObject({
      data: { registered: true, boundEvent: false },
    });
    expect(await env.DB.prepare(`
      SELECT role FROM event_hosts WHERE event_id = ? AND account_id = ?
    `).bind(access.event.id, account!.id).first('role')).toBe('cohost');
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
  });

  it('rolls activation back when one scheduled outbox statement fails', async () => {
    const access = await eventAccess();
    const started = await register(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    await env.DB.prepare(`
      CREATE TRIGGER fail_registration_outbox
      BEFORE INSERT ON host_notification_outbox
      WHEN NEW.kind = 'event_reminder'
      BEGIN
        SELECT RAISE(ABORT, 'forced outbox failure');
      END
    `).run();

    const completed = await completeRegistration(started, 'host@example.com', {
      cookie: access.manager.cookie,
    });

    expect(completed.status).toBe(500);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_accounts').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_hosts').first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox').first('count')).toBe(0);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM host_registration_challenges WHERE consumed_at IS NULL
    `).first('count')).toBe(1);
  });

  it('enforces the exact registration email budget in one normalized scope', async () => {
    const responses = [];
    for (const email of ['Host@Example.com', 'host@example.com', ' HOST@example.com ', 'host@example.com']) {
      responses.push(await register(email, {}, { 'CF-Connecting-IP': '203.0.113.11' }));
    }

    expect(responses.map(({ status }) => status)).toEqual([202, 202, 202, 429]);
    expect(await responses[3]!.json<any>()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('uses one shared unknown-IP scope with an exact registration budget of ten', async () => {
    const responses = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(await register(`host-${attempt}@example.com`));
    }

    expect(responses.map(({ status }) => status)).toEqual([
      202, 202, 202, 202, 202, 202, 202, 202, 202, 202, 429,
    ]);
    expect(await responses[10]!.json<any>()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('enforces five registration resends for one pending browser', async () => {
    const pending = registrationCookiesFrom(await register('host@example.com'));
    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await post('/api/host/register/resend', {}, {
        cookie: pending.cookie,
        'CF-Connecting-IP': '203.0.113.12',
      }));
    }

    expect(responses.map(({ status }) => status)).toEqual([202, 202, 202, 202, 202, 429]);
    expect(await responses[5]!.json<any>()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(responses[5]!.headers.getSetCookie()).not.toContain(expect.stringContaining('candidary_registration='));
  });

  it('refuses a short password with a field error', async () => {
    const response = await post('/api/host/register', { email: 'host@example.com', password: 'short' });

    expect(response.status).toBe(422);
    expect((await response.json<any>()).fieldErrors.password).toBeTruthy();
  });

  it('binds the event named by a live management session and ignores one that is not', async () => {
    const access = await eventAccess();

    const bound = await registerAndComplete(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    expect((await bound.json<any>()).data.boundEvent).toBe(true);

    const other = await eventAccess('Someone Else');
    const unbound = await registerAndComplete('thief@example.com', { bindEventId: other.event.id });
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
    await registerAndComplete('host@example.com');

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
    await registerAndComplete('host@example.com');

    const response = await createApp().request('/api/host/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'host@example.com', password: PASSWORD }),
    }, testEnv);

    expect((await response.json<any>()).code).toBe('ORIGIN_FORBIDDEN');
  });

  it('rejects a host session whose account authentication version changed', async () => {
    const host = await registeredHost('host@example.com');
    await env.DB.prepare('UPDATE host_accounts SET auth_version = auth_version + 1').run();

    const response = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);

    expect(response.status).toBe(401);
    expect((await response.json<any>()).code).toBe('SESSION_EXPIRED');
  });

  it('refuses a host-session insert with a stale account authentication version', async () => {
    await registerAndComplete('host@example.com');
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
    await registerAndComplete('host@example.com');
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
    const host = await unverifiedHost('host@example.com');
    const code = await forceCode('host@example.com', 'verify');

    const verified = await post('/api/host/verify', { code }, hostHeaders(host));
    expect(verified.status).toBe(200);

    const replay = await post('/api/host/verify', { code }, hostHeaders(host));
    expect((await replay.json<any>()).code).toBe('LOGIN_CODE_EXPIRED');
  });

  it('locks the code after five wrong guesses', async () => {
    const host = await unverifiedHost('host@example.com');
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
    const host = await unverifiedHost('host@example.com');
    const code = await forceCode('host@example.com', 'verify');

    const response = await post('/api/host/verify', { code }, {
      cookie: host.cookie,
      'x-candidary-csrf': host.csrf,
    });

    expect((await response.json<any>()).code).toBe('CSRF_INVALID');
  });
});

describe('email verification and lifecycle mail', () => {
  it('requeues a guide that was retired for an unconfirmed address', async () => {
    const access = await eventAccess();
    const host = await registeredHost(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    const account = await new AccountsRepository(env.DB).getByEmail('host@example.com');
    // The dispatcher retires a row it cannot send yet. Confirming the address is
    // exactly the condition that was missing, so the message must come back rather
    // than stay terminal.
    await env.DB.prepare(`
      UPDATE host_notification_outbox
      SET status = 'failed', last_error_code = 'address_unverified'
      WHERE account_id = ? AND kind = 'getting_started'
    `).bind(account!.id).run();
    await env.DB.prepare('UPDATE host_accounts SET email_verified_at = NULL WHERE id = ?')
      .bind(account!.id).run();
    await new HostAuthService(testEnv).issueChallenge(account!, 'verify', null);
    const code = await forceCode('host@example.com', 'verify');

    const verified = await post('/api/host/verify', { code }, hostHeaders(host));

    expect(verified.status).toBe(200);
    expect(await env.DB.prepare(`
      SELECT status FROM host_notification_outbox WHERE account_id = ? AND kind = 'getting_started'
    `).bind(account!.id).first('status')).toBe('pending');
  });

  it('does not send lifecycle mail from the verification request itself', async () => {
    const access = await eventAccess();
    const host = await registeredHost(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    const account = await new AccountsRepository(env.DB).getByEmail('host@example.com');
    await env.DB.prepare('UPDATE host_accounts SET email_verified_at = NULL WHERE id = ?')
      .bind(account!.id).run();
    await new HostAuthService(testEnv).issueChallenge(account!, 'verify', null);
    const code = await forceCode('host@example.com', 'verify');

    await post('/api/host/verify', { code }, hostHeaders(host));

    // Delivery belongs to the outbox. A send from this request would block the
    // response on an external call and lose the message if it failed. The direct
    // path recorded itself in `host_notifications`, so an empty ledger is what
    // distinguishes "the outbox owns this" from "it was sent from here".
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notifications')
      .first('count')).toBe(0);
    expect(await env.DB.prepare(`
      SELECT status FROM host_notification_outbox WHERE account_id = ? AND kind = 'getting_started'
    `).bind(account!.id).first('status')).toBe('pending');
  });
});

describe('password reset', () => {
  it('answers a forgotten-password request the same for a known and an unknown address', async () => {
    await registerAndComplete('host@example.com');

    const known = await post('/api/host/password/forgot', { email: 'host@example.com' });
    const trackedForKnown = trackedWaitUntil.length;
    const unknown = await post('/api/host/password/forgot', { email: 'nobody@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect((await known.json<any>()).data).toEqual({ sent: true });
    expect((await unknown.json<any>()).data).toEqual({ sent: true });
    expect(known.headers.getSetCookie()).toEqual([]);
    expect(unknown.headers.getSetCookie()).toEqual([]);
    expect(trackedForKnown).toBe(1);
    expect(trackedWaitUntil).toHaveLength(1);
  });

  it('rate-limits known and unknown forgotten-password addresses identically', async () => {
    await registerAndComplete('host@example.com');
    const responses = [];
    for (const email of [
      'host@example.com', 'HOST@example.com', ' host@example.com ', 'host@example.com',
      'nobody@example.com', 'NOBODY@example.com', ' nobody@example.com ', 'nobody@example.com',
    ]) {
      responses.push(await post('/api/host/password/forgot', { email }, {
        'CF-Connecting-IP': '203.0.113.30',
      }));
    }
    const known = responses[3]!;
    const unknown = responses[7]!;
    const knownBody = await known.json<any>();
    const unknownBody = await unknown.json<any>();

    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect({ code: knownBody.code, message: knownBody.message })
      .toEqual({ code: unknownBody.code, message: unknownBody.message });
    expect(knownBody.code).toBe('RATE_LIMITED');
  });

  it('answers missing reset challenges identically for known and unknown addresses', async () => {
    await registerAndComplete('host@example.com');

    const known = await post('/api/host/password/reset', {
      email: 'host@example.com', code: '424242', password: 'a-brand-new-long-password',
    });
    const unknown = await post('/api/host/password/reset', {
      email: 'nobody@example.com', code: '424242', password: 'a-brand-new-long-password',
    });
    const knownBody = await known.json<any>();
    const unknownBody = await unknown.json<any>();

    expect(known.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(knownBody.code).toBe('LOGIN_CODE_INVALID');
    expect({ code: knownBody.code, message: knownBody.message })
      .toEqual({ code: unknownBody.code, message: unknownBody.message });
  });

  it('normalizes expired and consumed reset challenges to the same invalid-code response', async () => {
    await registerAndComplete('host@example.com');
    await post('/api/host/password/forgot', { email: 'host@example.com' });
    await Promise.all(trackedWaitUntil.splice(0));
    await env.DB.prepare(`
      UPDATE host_login_challenges SET expires_at = ?
      WHERE purpose = 'reset' AND consumed_at IS NULL
    `).bind('2000-01-01T00:00:00.000Z').run();
    const expired = await post('/api/host/password/reset', {
      email: 'host@example.com', code: '424242', password: 'a-brand-new-long-password',
    });

    await post('/api/host/password/forgot', { email: 'host@example.com' });
    await Promise.all(trackedWaitUntil.splice(0));
    await env.DB.prepare(`
      UPDATE host_login_challenges SET consumed_at = ?
      WHERE purpose = 'reset' AND consumed_at IS NULL
    `).bind(new Date().toISOString()).run();
    const consumed = await post('/api/host/password/reset', {
      email: 'host@example.com', code: '424242', password: 'a-brand-new-long-password',
    });
    const expiredBody = await expired.json<any>();
    const consumedBody = await consumed.json<any>();

    expect(expired.status).toBe(400);
    expect(consumed.status).toBe(400);
    expect({ code: expiredBody.code, message: expiredBody.message })
      .toEqual({ code: consumedBody.code, message: consumedBody.message });
    expect(expiredBody.code).toBe('LOGIN_CODE_INVALID');
  });

  it('changes the password, revokes open sessions, and verifies the address', async () => {
    const first = await registeredHost('host@example.com');
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
    await registerAndComplete('host@example.com');
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
    await registerAndComplete('host@example.com');
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
    const host = await registeredHost(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
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
    const stranger = await registeredHost('stranger@example.com');

    const response = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: stranger.cookie },
    }, testEnv);

    expect(response.status).toBe(403);
    expect((await response.json<any>()).code).toBe('ROLE_FORBIDDEN');
  });

  it('keeps both credentials usable at once', async () => {
    const access = await eventAccess();
    const host = await registeredHost(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
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
    const host = await registeredHost(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
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
    const host = await registeredHost('host@example.com');
    const access = await eventAccess('Later Wedding');

    const adopted = await post(`/api/host/events/${access.event.id}/adopt`, {},
      hostHeaders(host, access.manager.cookie));
    expect(adopted.status).toBe(200);

    const session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.events).toHaveLength(1);
  });

  it('idempotently adopts an event already owned by the signed-in host without its manager cookie', async () => {
    const access = await eventAccess('Already Owned');
    const host = await registeredHost(
      'owner@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );

    const adopted = await post(`/api/host/events/${access.event.id}/adopt`, {}, hostHeaders(host));

    expect(adopted.status).toBe(200);
    expect(await adopted.json<any>()).toMatchObject({ data: { adopted: true, existing: true } });
  });

  it('idempotently adopts an existing cohost without promoting that membership', async () => {
    const host = await registeredHost('cohost@example.com');
    const account = await new AccountsRepository(env.DB).getByEmail('cohost@example.com');
    const access = await eventAccess('Cohost Event');
    await env.DB.prepare(`
      INSERT INTO event_hosts (event_id, account_id, role, created_at)
      VALUES (?, ?, 'cohost', '2026-07-28T00:00:00.000Z')
    `).bind(access.event.id, account!.id).run();

    const adopted = await post(`/api/host/events/${access.event.id}/adopt`, {}, hostHeaders(host));

    expect(adopted.status).toBe(200);
    expect(await adopted.json<any>()).toMatchObject({ data: { adopted: true, existing: true } });
    expect(await env.DB.prepare(`
      SELECT role FROM event_hosts WHERE event_id = ? AND account_id = ?
    `).bind(access.event.id, account!.id).first('role')).toBe('cohost');
  });

  it('refuses to adopt an event the account holds no link for', async () => {
    const host = await registeredHost('host@example.com');
    const access = await eventAccess('Not Yours');

    const response = await post(`/api/host/events/${access.event.id}/adopt`, {}, hostHeaders(host));

    expect(response.status).toBe(403);
  });

  it('refuses a second durable owner without scheduling lifecycle mail', async () => {
    const access = await eventAccess('One Owner');
    await registerAndComplete(
      'first@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    const second = await registeredHost('second@example.com');

    const response = await post(
      `/api/host/events/${access.event.id}/adopt`,
      {},
      hostHeaders(second, access.manager.cookie),
    );

    expect(response.status).toBe(409);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM event_hosts WHERE event_id = ? AND role = 'owner'
    `).bind(access.event.id).first('count')).toBe(1);
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM host_notification_outbox WHERE event_id = ?
    `).bind(access.event.id).first('count')).toBe(3);
  });

  it('attaches a signed-in creation to the account in the creating request', async () => {
    const host = await registeredHost('host@example.com');

    const created = await createApp().request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: host.cookie },
      body: JSON.stringify({
        name: 'Saved On Create', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      }),
    }, testEnv);

    expect(created.status).toBe(201);
    const body = await created.json<any>();
    expect(body.data.savedToAccount).toBe(true);

    const account = await new AccountsRepository(env.DB).getByEmail('host@example.com');
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM event_hosts
      WHERE event_id = ? AND account_id = ? AND role = 'owner'
    `).bind(body.data.event.id, account!.id).first('count')).toBe(1);
    // Ownership and its lifecycle mail commit together, so a create that reports
    // itself saved can never be a create whose reminder was never scheduled.
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM host_notification_outbox WHERE event_id = ?
    `).bind(body.data.event.id).first('count')).toBe(3);
  });

  it('keeps a creation held by a stale host cookie explicitly link-only', async () => {
    const host = await registeredHost('host@example.com');
    // Revoking after the cookie was issued is the ordinary way a browser ends up
    // presenting a host credential the server will not honour.
    await env.DB.prepare('UPDATE host_sessions SET revoked_at = ?')
      .bind(new Date().toISOString()).run();

    const created = await createApp().request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: host.cookie },
      body: JSON.stringify({
        name: 'Link Only', eventDate: '2026-09-19', welcomeMessage: 'Welcome.',
      }),
    }, testEnv);

    expect(created.status).toBe(201);
    const body = await created.json<any>();
    expect(body.data.savedToAccount).toBe(false);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM event_hosts')
      .first('count')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM host_notification_outbox')
      .first('count')).toBe(0);
  });

  it('keeps an account-side lifecycle failure after an unusable link falls through', async () => {
    const access = await eventAccess('Expired Event');
    const host = await registeredHost(
      'host@example.com',
      { bindEventId: access.event.id },
      { cookie: access.manager.cookie },
    );
    // The account still owns the event; the event itself has aged out. A second,
    // unrelated management link is what the browser has left to fall back to.
    await env.DB.prepare('UPDATE events SET management_access_expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), access.event.id).run();
    const other = await eventAccess('Someone Else');

    const response = await createApp().request(`/api/manage/events/${access.event.id}`, {
      headers: { cookie: `${host.cookie}; ${other.manager.cookie}` },
    }, testEnv);

    // Flattening this to ROLE_FORBIDDEN would tell the host they lack permission
    // for an event they own, and hide the deadline that actually ended access.
    expect(response.status).toBe(410);
    expect((await response.json<any>()).code).toBe('EVENT_EXPIRED');
  });
});

describe('sign out', () => {
  it('revokes the session and clears the cookie', async () => {
    const host = await registeredHost('host@example.com');

    const response = await post('/api/host/logout', {}, hostHeaders(host));
    expect(response.status).toBe(200);

    const after = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect(after.status).toBe(401);
  });
});

describe('unsubscribing', () => {
  it('turns notifications off from a signed link and ignores a forged one', async () => {
    const host = await registeredHost('host@example.com');
    const account = await env.DB.prepare('SELECT id FROM host_accounts LIMIT 1').first<{ id: string }>();
    const digest = await digestSecret(`unsubscribe:${account!.id}`, testEnv.LOGIN_HMAC_KEY);

    // The forged token has to be spent against the endpoint that actually mutates.
    // Checking it on the read-only GET proves nothing: that handler writes either way.
    const forged = await createApp().request(
      `/host/unsubscribe/${account!.id}.not-the-signature`,
      { method: 'POST' },
      testEnv,
    );
    expect(forged.status).toBe(200);
    let session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.account.notificationsEnabled).toBe(true);

    // A GET is a link preview, a prefetch, or a scanner as often as it is a person.
    // It may confirm, and it may not decide anything.
    const visited = await createApp().request(`/host/unsubscribe/${account!.id}.${digest}`, {}, testEnv);
    expect(visited.status).toBe(200);
    expect(await visited.text()).toContain('<form');
    session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.account.notificationsEnabled).toBe(true);

    const confirmed = await createApp().request(`/host/unsubscribe/${account!.id}.${digest}`, {
      method: 'POST',
    }, testEnv);
    expect(confirmed.status).toBe(200);
    session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.account.notificationsEnabled).toBe(false);
  });

  it('lets a signed-in host turn lifecycle email back on', async () => {
    const host = await registeredHost('host@example.com');
    const account = await env.DB.prepare('SELECT id FROM host_accounts LIMIT 1').first<{ id: string }>();
    const digest = await digestSecret(`unsubscribe:${account!.id}`, testEnv.LOGIN_HMAC_KEY);
    await createApp().request(`/host/unsubscribe/${account!.id}.${digest}`, { method: 'POST' }, testEnv);

    const restored = await createApp().request('/api/host/preferences', {
      method: 'PATCH', headers: hostHeaders(host),
      body: JSON.stringify({ notificationsEnabled: true }),
    }, testEnv);

    expect(restored.status).toBe(200);
    const session = await createApp().request('/api/host/session', { headers: { cookie: host.cookie } }, testEnv);
    expect((await session.json<any>()).data.account.notificationsEnabled).toBe(true);
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
  const response = await registerAndComplete(
    'host@example.com',
    { bindEventId: access.event.id },
    { cookie: access.manager.cookie },
  );

  const cookies = response.headers.getSetCookie().join(', ');
  expect(cookies).toContain('candidary_host=');
  expect(cookies).toContain('candidary_host_csrf=');
  expect(cookies).not.toContain('candidary_session=');
  expect(() => cookiesFrom(response)).toThrow();
});

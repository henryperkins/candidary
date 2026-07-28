import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { ApiError } from '../../shared/errors';
import { AuthService } from '../auth/service';
import { AccountsRepository } from '../db/accounts';
import { EventsRepository } from '../db/events';
import { HostSessionsRepository } from '../db/sessions';
import type { AppBindings, AuthenticatedAccount } from '../env';
import {
  clearSessionCookies,
  getSessionCookie,
  setSessionCookies,
} from '../http/cookies';
import { assertCsrf, assertRequestOrigin } from '../http/csrf';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  describePasswordProblem,
  hashPassword,
} from '../security/passwords';
import { HostAuthService } from '../services/host-auth';
import { NotificationService } from '../services/notifications';

const emailSchema = z.string().trim().min(3).max(254).email('Enter a valid email address.');
const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);
const codeSchema = z.string().trim().regex(/^\d{6}$/u, 'Enter the six-digit code.');

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80).nullish(),
  bindEventId: z.uuid().nullish(),
});
const loginSchema = z.object({ email: emailSchema, password: passwordSchema });
const codeOnlySchema = z.object({ code: codeSchema });
const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({ email: emailSchema, code: codeSchema, password: passwordSchema });
const preferencesSchema = z.object({ notificationsEnabled: z.boolean() });

function accountView(principal: AuthenticatedAccount) {
  return {
    id: principal.account.id,
    email: principal.account.email,
    displayName: principal.account.displayName,
    emailVerified: principal.account.emailVerifiedAt !== null,
    notificationsEnabled: principal.account.notificationsEnabled,
  };
}

// Password rules are reported as a field error rather than a schema failure so the
// form can put the message under the password input instead of at the top.
function assertPasswordUsable(password: string): void {
  const problem = describePasswordProblem(password);
  if (problem) throw new ApiError('VALIDATION_FAILED', 'Choose a longer password.', 422, { password: problem });
}

async function parse<T extends z.ZodType>(context: Context<AppBindings>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'form');
      fields[field] ??= issue.message;
    }
    throw new ApiError('VALIDATION_FAILED', 'Check the highlighted details.', 422, fields);
  }
  return parsed.data;
}

async function requireHost(context: Context<AppBindings>, write = false): Promise<AuthenticatedAccount> {
  const principal = await new AuthService(context.env)
    .resolveHostSession(getSessionCookie(context, 'host'));
  if (write) await assertCsrf(context, 'host', principal.session.csrfDigest);
  return principal;
}

async function startSession(context: Context<AppBindings>, account: AuthenticatedAccount['account']) {
  const created = await new AuthService(context.env).createHostSession(account.id, account.authVersion);
  const maxAge = Math.max(1, Math.floor((Date.parse(created.expiresAt) - Date.now()) / 1000));
  setSessionCookies(context, 'host', created.sessionToken, created.csrfToken, maxAge);
  return created;
}

export const hostAuthRoutes = new Hono<AppBindings>();

// Registration answers the same way whether or not the address was free. The only
// place the difference shows up is the inbox that already owns the address.
hostAuthRoutes.post('/host/register', async (context) => {
  assertRequestOrigin(context);
  const body = await parse(context, registerSchema);
  assertPasswordUsable(body.password);

  // Binding is authorized by the management session in the other cookie, checked
  // before the account exists — possession of the link is the proof of ownership,
  // and it has to be spent here rather than trusted from a request field.
  let bindEventId: string | null = null;
  if (body.bindEventId) {
    const principal = await new AuthService(context.env).resolve(getSessionCookie(context, 'event'))
      .catch(() => null);
    if (principal?.kind === 'event'
      && principal.session.role === 'manager'
      && principal.event.id === body.bindEventId) {
      bindEventId = body.bindEventId;
    }
  }

  const account = await new HostAuthService(context.env).register({
    email: body.email,
    password: body.password,
    displayName: body.displayName ?? null,
    bindEventId,
  });

  if (account) await startSession(context, account);
  return context.json({
    data: { registered: true, boundEvent: Boolean(account && bindEventId) },
    requestId: context.get('requestId'),
  }, 202);
});

hostAuthRoutes.post('/host/login', async (context) => {
  assertRequestOrigin(context);
  const body = await parse(context, loginSchema);
  const account = await new HostAuthService(context.env).authenticate(body.email, body.password);
  await new AccountsRepository(context.env.DB).touch(account.id, new Date().toISOString());
  await startSession(context, account);
  return context.json({
    data: {
      account: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        emailVerified: account.emailVerifiedAt !== null,
        notificationsEnabled: account.notificationsEnabled,
      },
    },
    requestId: context.get('requestId'),
  });
});

hostAuthRoutes.post('/host/logout', async (context) => {
  const principal = await requireHost(context, true);
  await new HostSessionsRepository(context.env.DB).revoke(principal.session.id, new Date().toISOString());
  clearSessionCookies(context, 'host');
  return context.json({ data: { signedOut: true }, requestId: context.get('requestId') });
});

hostAuthRoutes.get('/host/session', async (context) => {
  const principal = await requireHost(context);
  const events = await new AccountsRepository(context.env.DB).listEventsForAccount(principal.account.id);
  return context.json({
    data: {
      account: accountView(principal),
      events: events.map((event) => ({
        id: event.id,
        name: event.name,
        slug: event.slug,
        eventDate: event.eventDate,
        storedMediaCount: event.storedMediaCount,
        managementAccessExpiresAt: event.managementAccessExpiresAt,
      })),
    },
    requestId: context.get('requestId'),
  });
});

hostAuthRoutes.post('/host/verify', async (context) => {
  const principal = await requireHost(context, true);
  const body = await parse(context, codeOnlySchema);
  const service = new HostAuthService(context.env);
  const challenge = await service.consumeCode(principal.account, 'verify', body.code);

  const accounts = new AccountsRepository(context.env.DB);
  const verifiedAt = new Date().toISOString();
  await accounts.markEmailVerified(principal.account.id, verifiedAt);

  // Getting-started waits for a confirmed address on purpose: it is the first
  // message a host would actually miss, and sending it to an unverified inbox is
  // how a domain earns a spam reputation.
  const eventId = challenge.bindEventId;
  if (eventId) {
    const event = await new EventsRepository(context.env.DB).getById(eventId);
    const account = await accounts.getById(principal.account.id);
    if (event && account) {
      await new NotificationService(context.env).sendGettingStarted(account, event);
    }
  }
  return context.json({ data: { emailVerified: true }, requestId: context.get('requestId') });
});

hostAuthRoutes.post('/host/verify/resend', async (context) => {
  const principal = await requireHost(context, true);
  if (principal.account.emailVerifiedAt) {
    return context.json({ data: { sent: false, emailVerified: true }, requestId: context.get('requestId') });
  }
  const events = await new AccountsRepository(context.env.DB).listEventsForAccount(principal.account.id);
  const issued = await new HostAuthService(context.env)
    .issueChallenge(principal.account, 'verify', events[0]?.id ?? null);
  if (!issued.delivered) {
    throw new ApiError('LOGIN_EMAIL_UNDELIVERABLE', 'That code could not be sent. Try again shortly.', 502);
  }
  return context.json({ data: { sent: true }, requestId: context.get('requestId') });
});

// Always 202, always the same shape. Whether the address has an account is exactly
// what this endpoint must not disclose.
hostAuthRoutes.post('/host/password/forgot', async (context) => {
  assertRequestOrigin(context);
  const body = await parse(context, forgotSchema);
  const account = await new AccountsRepository(context.env.DB).getByEmail(body.email);
  if (account && !account.disabledAt) {
    await new HostAuthService(context.env).issueChallenge(account, 'reset', null)
      .catch((error) => {
        // A throttled request must still answer like every other one.
        if (error instanceof ApiError && error.code === 'LOGIN_RATE_LIMITED') return;
        throw error;
      });
  }
  return context.json({ data: { sent: true }, requestId: context.get('requestId') }, 202);
});

hostAuthRoutes.post('/host/password/reset', async (context) => {
  assertRequestOrigin(context);
  const body = await parse(context, resetSchema);
  assertPasswordUsable(body.password);
  const accounts = new AccountsRepository(context.env.DB);
  const account = await accounts.getByEmail(body.email);
  if (!account || account.disabledAt) {
    // Indistinguishable from a wrong code, so a reset form cannot be used to test
    // which addresses are registered.
    throw new ApiError('LOGIN_CODE_INVALID', 'That code is not correct.', 400);
  }

  const service = new HostAuthService(context.env);
  await service.consumeCode(account, 'reset', body.code);
  await accounts.setPasswordHash(account.id, await hashPassword(body.password));
  // Everything that was signed in under the old password goes, including whatever
  // session an attacker may have been holding. The new session below is minted
  // after the revocation so it survives it.
  await new HostSessionsRepository(context.env.DB).revokeForAccount(account.id, new Date().toISOString());
  // A reset proves the same thing verification does: this person reads that inbox.
  await accounts.markEmailVerified(account.id, new Date().toISOString());
  await service.sendPasswordChanged(account);

  await startSession(context, account);
  return context.json({ data: { reset: true }, requestId: context.get('requestId') });
});

hostAuthRoutes.patch('/host/preferences', async (context) => {
  const principal = await requireHost(context, true);
  const body = await parse(context, preferencesSchema);
  await new AccountsRepository(context.env.DB)
    .setNotificationsEnabled(principal.account.id, body.notificationsEnabled);
  return context.json({
    data: { notificationsEnabled: body.notificationsEnabled },
    requestId: context.get('requestId'),
  });
});

// Adopts an event the host already controls by link into their account, for the
// case where the event was created anonymously before or apart from registering.
hostAuthRoutes.post('/host/events/:eventId/adopt', async (context) => {
  const principal = await requireHost(context, true);
  const eventId = context.req.param('eventId');
  const link = await new AuthService(context.env).resolve(getSessionCookie(context, 'event'))
    .catch(() => null);
  if (link?.kind !== 'event' || link.session.role !== 'manager' || link.event.id !== eventId) {
    throw new ApiError('ROLE_FORBIDDEN', 'Open this event’s management link first.', 403);
  }
  await new AccountsRepository(context.env.DB)
    .addEventHost(eventId, principal.account.id, 'owner', new Date().toISOString());
  return context.json({ data: { adopted: true }, requestId: context.get('requestId') });
});

import type { Context } from 'hono';

import { ApiError } from '../../shared/errors';
import { AccountsRepository } from '../db/accounts';
import { EventsRepository } from '../db/events';
import type { EventRecord } from '../db/types';
import type { AppBindings } from '../env';
import { getSessionCookie, type CookieScope } from '../http/cookies';
import { assertCsrf } from '../http/csrf';
import { AuthService } from './service';

// What a host route actually needs: the event, and enough to check CSRF against
// whichever credential answered. `via` is kept because the two are not equivalent
// — a delegate holding the management link is not the account owner — and because
// the CSRF pair to check follows from it.
export interface ManagerAuth {
  event: EventRecord;
  sessionId: string;
  csrfDigest: string;
  scope: CookieScope;
  via: 'link' | 'account';
  accountId: string | null;
}

function denied(): ApiError {
  return new ApiError('ROLE_FORBIDDEN', 'This management session belongs to a different event.', 403);
}

async function fromAccount(
  context: Context<AppBindings>,
  eventId: string,
): Promise<ManagerAuth | null> {
  const cookie = getSessionCookie(context, 'host');
  if (!cookie) return null;
  const principal = await new AuthService(context.env).resolveHostSession(cookie);

  const membership = await new AccountsRepository(context.env.DB)
    .getEventHost(eventId, principal.account.id);
  if (!membership) return null;

  const event = await new EventsRepository(context.env.DB).getById(eventId);
  if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
  if (event.deletedAt) throw new ApiError('EVENT_DELETED', 'This event has been deleted.', 410);
  // An account session outlives any one event, so the management window a link
  // session inherits from its token has to be enforced here instead.
  if (Date.parse(event.managementAccessExpiresAt) <= Date.now()) {
    throw new ApiError('EVENT_EXPIRED', 'This event access has expired.', 410);
  }

  return {
    event,
    sessionId: principal.session.id,
    csrfDigest: principal.session.csrfDigest,
    scope: 'host',
    via: 'account',
    accountId: principal.account.id,
  };
}

async function fromLink(
  context: Context<AppBindings>,
  eventId: string,
): Promise<ManagerAuth | null> {
  const cookie = getSessionCookie(context, 'event');
  if (!cookie) return null;
  const principal = await new AuthService(context.env).resolve(cookie);
  if (principal.kind !== 'event' || principal.session.role !== 'manager') return null;
  if (principal.event.id !== eventId) return null;

  return {
    event: principal.event,
    sessionId: principal.session.id,
    csrfDigest: principal.session.csrfDigest,
    scope: 'event',
    via: 'link',
    accountId: null,
  };
}

// Either credential is sufficient, and a browser may hold both. The account is
// tried first so that a host who is signed in keeps acting as themselves even when
// a stale management link is still sitting in the other cookie.
export async function resolveManager(
  context: Context<AppBindings>,
  eventId: string,
): Promise<ManagerAuth | null> {
  // An unusable account session must not block a management link that still works.
  // The two are independent credentials, so a host whose sign-in lapsed after 30
  // days still gets in with the link sitting in the other cookie. Failures from the
  // link path are left to propagate: a revoked link has a specific answer worth
  // giving, and nothing further to fall back to.
  const account = await fromAccount(context, eventId).catch(() => null);
  return account ?? (await fromLink(context, eventId));
}

// The single entry point for every host-only route. `eventId` defaults to the path
// parameter, which is what all but the media routes use.
export async function requireManager(
  context: Context<AppBindings>,
  options: { write?: boolean; eventId?: string; deniedMessage?: string } = {},
): Promise<ManagerAuth> {
  const eventId = options.eventId ?? context.req.param('eventId') ?? '';
  const auth = await resolveManager(context, eventId);
  if (!auth) {
    const hostCookie = getSessionCookie(context, 'host');
    // Nothing usable in either cookie is a missing session, not a refused one, so
    // the client is told to authenticate rather than that it lacks permission.
    if (!getSessionCookie(context, 'event') && !hostCookie) {
      throw new ApiError('SESSION_REQUIRED', 'Sign in or open your management link to continue.', 401);
    }
    // A host cookie that no longer resolves is a lapsed sign-in, not a refusal, and
    // the difference decides whether the client offers a sign-in or an error. Only
    // reached once every credential has already failed.
    if (hostCookie) await new AuthService(context.env).resolveHostSession(hostCookie);
    if (options.deniedMessage) throw new ApiError('ROLE_FORBIDDEN', options.deniedMessage, 403);
    throw denied();
  }
  if (options.write) await assertCsrf(context, auth.scope, auth.csrfDigest);
  return auth;
}

import type { Role } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { AccountsRepository } from '../db/accounts';
import { EventsRepository } from '../db/events';
import { SessionsRepository } from '../db/sessions';
import { TokensRepository } from '../db/tokens';
import type { AppEnv, AuthenticatedAccount, AuthenticatedSession, Principal } from '../env';
import { constantTimeEqual, createSecretToken, digestSecret } from '../security/crypto';

const GUEST_SESSION_SECONDS = 7 * 24 * 60 * 60;
const MANAGER_SESSION_SECONDS = 12 * 60 * 60;
// An account session is not pinned to an event's access window the way a link
// session is, so it can safely outlive one event. Per-request checks still deny a
// deleted or expired event, which is where that boundary actually belongs.
export const HOST_SESSION_SECONDS = 30 * 24 * 60 * 60;

function parseSecretToken(value: string): { id: string; secret: string } {
  const [id, secret, extra] = value.split('.');
  if (!id || !secret || extra) throw new ApiError('SESSION_REQUIRED', 'This access link is not valid.', 401);
  return { id, secret };
}

function sessionExpiry(role: Role, tokenExpiry: string, now: Date): string {
  const duration = role === 'guest' ? GUEST_SESSION_SECONDS : MANAGER_SESSION_SECONDS;
  return new Date(Math.min(Date.parse(tokenExpiry), now.getTime() + duration * 1000)).toISOString();
}

export class AuthService {
  private readonly accounts: AccountsRepository;
  private readonly events: EventsRepository;
  private readonly sessions: SessionsRepository;
  private readonly tokens: TokensRepository;

  constructor(private readonly env: AppEnv) {
    this.accounts = new AccountsRepository(env.DB);
    this.events = new EventsRepository(env.DB);
    this.sessions = new SessionsRepository(env.DB);
    this.tokens = new TokensRepository(env.DB);
  }

  async exchange(rawToken: string, role: Role, now = new Date()) {
    const parsed = parseSecretToken(rawToken);
    const token = await this.tokens.getById(parsed.id);
    if (!token || token.role !== role) throw new ApiError('SESSION_REQUIRED', 'This access link is not valid.', 401);
    if (token.revokedAt) throw new ApiError('TOKEN_REVOKED', 'This access link has been replaced or revoked.', 401);
    if (Date.parse(token.expiresAt) <= now.getTime()) throw new ApiError('EVENT_EXPIRED', 'This event access has expired.', 410);
    const suppliedDigest = await digestSecret(parsed.secret, this.env.TOKEN_HMAC_KEY);
    if (!constantTimeEqual(suppliedDigest, token.secretDigest)) {
      throw new ApiError('SESSION_REQUIRED', 'This access link is not valid.', 401);
    }
    const event = await this.events.getById(token.eventId);
    if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
    if (event.deletedAt) throw new ApiError('EVENT_DELETED', 'This event has been deleted.', 410);

    const sessionToken = createSecretToken();
    const csrfToken = createSecretToken().secret;
    const expiresAt = sessionExpiry(role, token.expiresAt, now);
    const session = await this.sessions.create({
      id: sessionToken.id,
      secretDigest: await digestSecret(sessionToken.secret, this.env.SESSION_HMAC_KEY),
      csrfDigest: await digestSecret(csrfToken, this.env.SESSION_HMAC_KEY),
      eventId: event.id,
      accessTokenId: token.id,
      role,
      expiresAt,
      createdAt: now.toISOString(),
    });

    return { event, session, sessionToken, csrfToken };
  }

  // Resolves one cookie to whoever is behind it, without deciding what they may
  // reach. A link session names one event; an account session names a host who may
  // have several. Turning either into "may manage THIS event" is the job of
  // `requireManager`, so that rule lives in exactly one place.
  async resolve(rawSession: string | undefined, now = new Date()): Promise<Principal> {
    if (!rawSession) throw new ApiError('SESSION_REQUIRED', 'Open a valid event link to continue.', 401);
    const parsed = parseSecretToken(rawSession);
    const session = await this.sessions.getById(parsed.id);
    if (!session) throw new ApiError('SESSION_REQUIRED', 'Open a valid event link to continue.', 401);
    const suppliedDigest = await digestSecret(parsed.secret, this.env.SESSION_HMAC_KEY);
    if (!constantTimeEqual(suppliedDigest, session.secretDigest)) {
      throw new ApiError('SESSION_REQUIRED', 'Open a valid event link to continue.', 401);
    }
    const expired = session.revokedAt !== null || Date.parse(session.expiresAt) <= now.getTime();

    if (session.role === 'host') {
      if (expired) {
        throw new ApiError('SESSION_EXPIRED', 'Your session expired. Sign in again to continue.', 401);
      }
      const account = session.accountId ? await this.accounts.getById(session.accountId) : null;
      if (!account) throw new ApiError('SESSION_REQUIRED', 'Sign in to continue.', 401);
      if (account.disabledAt) throw new ApiError('ACCOUNT_DISABLED', 'This account is no longer active.', 403);
      return { kind: 'account', account, session };
    }

    // Token first, and deliberately so: rotating a link revokes its tokens and its
    // sessions together, and the useful thing to tell the holder is that the link
    // was replaced — not that time passed, which is what checking the session
    // first would report for the identical situation.
    const token = session.accessTokenId ? await this.tokens.getById(session.accessTokenId) : null;
    if (!token || token.revokedAt) throw new ApiError('TOKEN_REVOKED', 'This access link has been replaced or revoked.', 401);
    if (expired) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired. Open your event link again.', 401);
    }
    if (Date.parse(token.expiresAt) <= now.getTime()) throw new ApiError('EVENT_EXPIRED', 'This event access has expired.', 410);
    const event = session.eventId ? await this.events.getById(session.eventId) : null;
    if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
    if (event.deletedAt) throw new ApiError('EVENT_DELETED', 'This event has been deleted.', 410);
    return { kind: 'event', event, session, token };
  }

  // The guest surface has no account concept: a host browsing it is doing so with
  // a link session like everyone else.
  async resolveEventSession(rawSession: string | undefined, now = new Date()): Promise<AuthenticatedSession> {
    const principal = await this.resolve(rawSession, now);
    if (principal.kind !== 'event') {
      throw new ApiError('SESSION_REQUIRED', 'Open a valid event link to continue.', 401);
    }
    return principal;
  }

  async resolveHostSession(rawSession: string | undefined, now = new Date()): Promise<AuthenticatedAccount> {
    if (!rawSession) throw new ApiError('HOST_SESSION_REQUIRED', 'Sign in to continue.', 401);
    const principal = await this.resolve(rawSession, now);
    if (principal.kind !== 'account') throw new ApiError('HOST_SESSION_REQUIRED', 'Sign in to continue.', 401);
    return principal;
  }

  async createHostSession(accountId: string, now = new Date()) {
    const sessionToken = createSecretToken();
    const csrfToken = createSecretToken().secret;
    const expiresAt = new Date(now.getTime() + HOST_SESSION_SECONDS * 1000).toISOString();
    const session = await this.sessions.createHost({
      id: sessionToken.id,
      secretDigest: await digestSecret(sessionToken.secret, this.env.SESSION_HMAC_KEY),
      csrfDigest: await digestSecret(csrfToken, this.env.SESSION_HMAC_KEY),
      accountId,
      expiresAt,
      createdAt: now.toISOString(),
    });
    return { session, sessionToken, csrfToken, expiresAt };
  }
}

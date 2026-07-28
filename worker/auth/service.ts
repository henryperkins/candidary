import type { Role } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { AccountsRepository } from '../db/accounts';
import { EventsRepository } from '../db/events';
import { HostSessionsRepository, SessionsRepository } from '../db/sessions';
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
  private readonly hostSessions: HostSessionsRepository;
  private readonly sessions: SessionsRepository;
  private readonly tokens: TokensRepository;

  constructor(private readonly env: AppEnv) {
    this.accounts = new AccountsRepository(env.DB);
    this.events = new EventsRepository(env.DB);
    this.hostSessions = new HostSessionsRepository(env.DB);
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
      canClaimOwner: false,
      expiresAt,
      createdAt: now.toISOString(),
    });

    return { event, session, sessionToken, csrfToken };
  }

  // Event cookies are link sessions only. Account cookies resolve separately from
  // `host_sessions`, so they can be invalidated by an account auth-version change.
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

    // Token first, and deliberately so: rotating a link revokes its tokens and its
    // sessions together, and the useful thing to tell the holder is that the link
    // was replaced — not that time passed, which is what checking the session
    // first would report for the identical situation.
    const token = await this.tokens.getById(session.accessTokenId);
    if (!token || token.revokedAt) throw new ApiError('TOKEN_REVOKED', 'This access link has been replaced or revoked.', 401);
    if (expired) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired. Open your event link again.', 401);
    }
    if (Date.parse(token.expiresAt) <= now.getTime()) throw new ApiError('EVENT_EXPIRED', 'This event access has expired.', 410);
    const event = await this.events.getById(session.eventId);
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
    const parsed = parseSecretToken(rawSession);
    const session = await this.hostSessions.getById(parsed.id);
    if (!session) throw new ApiError('HOST_SESSION_REQUIRED', 'Sign in to continue.', 401);
    const suppliedDigest = await digestSecret(parsed.secret, this.env.SESSION_HMAC_KEY);
    if (!constantTimeEqual(suppliedDigest, session.secretDigest)) {
      throw new ApiError('HOST_SESSION_REQUIRED', 'Sign in to continue.', 401);
    }
    if (session.revokedAt || Date.parse(session.expiresAt) <= now.getTime()) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired. Sign in again to continue.', 401);
    }
    const account = await this.accounts.getById(session.accountId);
    if (!account) throw new ApiError('HOST_SESSION_REQUIRED', 'Sign in to continue.', 401);
    if (account.disabledAt) throw new ApiError('ACCOUNT_DISABLED', 'This account is no longer active.', 403);
    if (account.authVersion !== session.authVersion) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired. Sign in again to continue.', 401);
    }
    return { account, session };
  }

  async createHostSession(accountId: string, authVersion: number, now = new Date()) {
    const sessionToken = createSecretToken();
    const csrfToken = createSecretToken().secret;
    const expiresAt = new Date(now.getTime() + HOST_SESSION_SECONDS * 1000).toISOString();
    const session = await this.hostSessions.createIfAuthVersion({
      id: sessionToken.id,
      secretDigest: await digestSecret(sessionToken.secret, this.env.SESSION_HMAC_KEY),
      csrfDigest: await digestSecret(csrfToken, this.env.SESSION_HMAC_KEY),
      accountId,
      authVersion,
      expiresAt,
      createdAt: now.toISOString(),
    });
    if (!session) throw new ApiError('LOGIN_CREDENTIALS_INVALID', 'Email or password is incorrect.', 401);
    return { session, sessionToken, csrfToken, expiresAt };
  }
}

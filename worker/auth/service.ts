import type { Role } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { EventsRepository } from '../db/events';
import { SessionsRepository } from '../db/sessions';
import { TokensRepository } from '../db/tokens';
import type { AppEnv, AuthenticatedSession } from '../env';
import { constantTimeEqual, createSecretToken, digestSecret } from '../security/crypto';

const GUEST_SESSION_SECONDS = 7 * 24 * 60 * 60;
const MANAGER_SESSION_SECONDS = 12 * 60 * 60;

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
  private readonly events: EventsRepository;
  private readonly sessions: SessionsRepository;
  private readonly tokens: TokensRepository;

  constructor(private readonly env: AppEnv) {
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

  async resolve(rawSession: string | undefined, now = new Date()): Promise<AuthenticatedSession> {
    if (!rawSession) throw new ApiError('SESSION_REQUIRED', 'Open a valid event link to continue.', 401);
    const parsed = parseSecretToken(rawSession);
    const session = await this.sessions.getById(parsed.id);
    if (!session) throw new ApiError('SESSION_REQUIRED', 'Open a valid event link to continue.', 401);
    if (session.revokedAt || Date.parse(session.expiresAt) <= now.getTime()) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired. Open your event link again.', 401);
    }
    const suppliedDigest = await digestSecret(parsed.secret, this.env.SESSION_HMAC_KEY);
    if (!constantTimeEqual(suppliedDigest, session.secretDigest)) {
      throw new ApiError('SESSION_REQUIRED', 'Open a valid event link to continue.', 401);
    }
    const token = await this.tokens.getById(session.accessTokenId);
    if (!token || token.revokedAt) throw new ApiError('TOKEN_REVOKED', 'This access link has been replaced or revoked.', 401);
    if (Date.parse(token.expiresAt) <= now.getTime()) throw new ApiError('EVENT_EXPIRED', 'This event access has expired.', 410);
    const event = await this.events.getById(session.eventId);
    if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
    if (event.deletedAt) throw new ApiError('EVENT_DELETED', 'This event has been deleted.', 410);
    return { event, session, token };
  }
}


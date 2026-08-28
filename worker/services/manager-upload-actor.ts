import type { ManagerAuth } from '../auth/manager';
import { AccountsRepository } from '../db/accounts';
import { EventsRepository } from '../db/events';
import { HostSessionsRepository, SessionsRepository } from '../db/sessions';
import { TokensRepository } from '../db/tokens';
import type { AppEnv } from '../env';
import { createSecretToken, digestSecret } from '../security/crypto';
import { ApiError } from '../../shared/errors';
import type { UploadAuthority } from './upload-authority';

const MAX_CREATE_ATTEMPTS = 2;

function linkAuthority(auth: ManagerAuth): UploadAuthority {
  return {
    kind: 'manager-link',
    actorSessionId: auth.sessionId,
    eventSessionId: auth.sessionId,
  };
}

function accountAuthority(
  auth: ManagerAuth & { accountId: string },
  actorSessionId: string,
): UploadAuthority {
  return {
    kind: 'manager-account',
    actorSessionId,
    hostSessionId: auth.sessionId,
    accountId: auth.accountId,
  };
}

function isActorUniquenessConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(
    'UNIQUE constraint failed: event_sessions.event_id, event_sessions.manager_upload_account_id',
  );
}

export class ManagerUploadActorService {
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

  /** Reservation-time resolution. May create the one live account actor. */
  async ensureForReservation(auth: ManagerAuth, now = new Date()): Promise<UploadAuthority> {
    if (auth.via === 'link') return linkAuthority(auth);
    if (!auth.accountId) {
      throw new ApiError('ROLE_FORBIDDEN', 'This management session belongs to a different event.', 403);
    }
    const accountAuth = auth as ManagerAuth & { accountId: string };
    const nowIso = now.toISOString();
    const existing = await this.sessions.getLiveManagerUploadActor(
      auth.event.id,
      auth.accountId,
      nowIso,
    );
    if (existing) return accountAuthority(accountAuth, existing.id);

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const actorSecret = createSecretToken();
      const csrfSecret = createSecretToken().secret;
      let created = null;
      try {
        created = await this.sessions.createManagerUploadActor({
          id: actorSecret.id,
          secretDigest: await digestSecret(actorSecret.secret, this.env.SESSION_HMAC_KEY),
          csrfDigest: await digestSecret(csrfSecret, this.env.SESSION_HMAC_KEY),
          hostSessionId: auth.sessionId,
          accountId: auth.accountId,
          eventId: auth.event.id,
          createdAt: nowIso,
          nowIso,
        });
      } catch (error) {
        if (!isActorUniquenessConflict(error)) throw error;
      }
      if (created) return accountAuthority(accountAuth, created.id);

      const winner = await this.sessions.getLiveManagerUploadActor(
        auth.event.id,
        auth.accountId,
        nowIso,
      );
      if (winner) return accountAuthority(accountAuth, winner.id);

      const hasCurrentToken = await this.assertAccountAuthorization(accountAuth, now);
      if (attempt === MAX_CREATE_ATTEMPTS - 1) {
        if (!hasCurrentToken) {
          throw new Error('A live event has no current Manager access token.');
        }
        throw new Error('The Manager upload actor could not be created.');
      }
    }

    throw new Error('The Manager upload actor could not be created.');
  }

  /** Content/finalize/cancel resolution. Never creates. */
  async lookupForExistingUpload(auth: ManagerAuth): Promise<UploadAuthority | null> {
    if (auth.via === 'link') return linkAuthority(auth);
    if (!auth.accountId) return null;
    const actor = await this.sessions.getLiveManagerUploadActor(
      auth.event.id,
      auth.accountId,
      new Date().toISOString(),
    );
    return actor
      ? accountAuthority(auth as ManagerAuth & { accountId: string }, actor.id)
      : null;
  }

  /**
   * Classifies only after the guarded insert refused. It never admits a write;
   * its result decides whether the bounded current-token race retry is allowed.
   */
  private async assertAccountAuthorization(
    auth: ManagerAuth & { accountId: string },
    now: Date,
  ): Promise<boolean> {
    const session = await this.hostSessions.getById(auth.sessionId);
    if (!session || session.accountId !== auth.accountId) {
      throw new ApiError('HOST_SESSION_REQUIRED', 'Sign in to continue.', 401);
    }
    if (session.revokedAt || Date.parse(session.expiresAt) <= now.getTime()) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired. Sign in again to continue.', 401);
    }
    const account = await this.accounts.getById(auth.accountId);
    if (!account) throw new ApiError('HOST_SESSION_REQUIRED', 'Sign in to continue.', 401);
    if (account.disabledAt) {
      throw new ApiError('ACCOUNT_DISABLED', 'This account is no longer active.', 403);
    }
    if (session.authVersion !== account.authVersion) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired. Sign in again to continue.', 401);
    }
    const membership = await this.accounts.getEventHost(auth.event.id, auth.accountId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'cohost')) {
      throw new ApiError('ROLE_FORBIDDEN', 'This management session belongs to a different event.', 403);
    }
    const event = await this.events.getById(auth.event.id);
    if (!event) throw new ApiError('EVENT_NOT_FOUND', 'This event could not be found.', 404);
    if (event.deletedAt) throw new ApiError('EVENT_DELETED', 'This event has been deleted.', 410);
    if (Date.parse(event.managementAccessExpiresAt) <= now.getTime()) {
      throw new ApiError('EVENT_EXPIRED', 'This event access has expired.', 410);
    }
    const token = await this.tokens.getActiveForRole(event.id, 'manager');
    return token !== null && Date.parse(token.expiresAt) > now.getTime();
  }
}

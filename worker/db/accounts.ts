import type { ChallengePurpose, EventHostRole, NotificationKind } from '../../shared/contracts';
import { mapEvent, type EventRow } from './events';
import type {
  EventHostRecord,
  EventRecord,
  HostAccountRecord,
  LoginChallengeRecord,
  PendingRegistrationRecord,
} from './types';
import { NotificationOutboxRepository } from './notification-outbox';

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  email_verified_at: string | null;
  notifications_enabled: number;
  auth_version: number;
  created_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
}

interface ChallengeRow {
  id: string;
  account_id: string;
  purpose: ChallengePurpose;
  secret_digest: string;
  bind_event_id: string | null;
  attempts: number;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

interface EventHostRow {
  event_id: string;
  account_id: string;
  role: EventHostRole;
  created_at: string;
}

interface PendingRegistrationRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  browser_secret_digest: string;
  code_digest: string;
  bind_event_id: string | null;
  creator_session_id: string | null;
  attempts: number;
  expires_at: string;
  consumed_at: string | null;
  activation_nonce: string | null;
  created_at: string;
  updated_at: string;
}

function mapAccount(row: AccountRow): HostAccountRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    emailVerifiedAt: row.email_verified_at,
    notificationsEnabled: row.notifications_enabled === 1,
    authVersion: row.auth_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    disabledAt: row.disabled_at,
  };
}

function mapChallenge(row: ChallengeRow): LoginChallengeRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    purpose: row.purpose,
    secretDigest: row.secret_digest,
    bindEventId: row.bind_event_id,
    attempts: row.attempts,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapEventHost(row: EventHostRow): EventHostRecord {
  return {
    eventId: row.event_id,
    accountId: row.account_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

function mapPendingRegistration(row: PendingRegistrationRow): PendingRegistrationRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    browserSecretDigest: row.browser_secret_digest,
    codeDigest: row.code_digest,
    bindEventId: row.bind_event_id,
    creatorSessionId: row.creator_session_id,
    attempts: row.attempts,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    activationNonce: row.activation_nonce,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// An address is one account no matter how it was typed. Normalizing here rather
// than at each caller is what makes the UNIQUE constraint mean what it says.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AccountsRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<HostAccountRecord | null> {
    const row = await this.db.prepare('SELECT * FROM host_accounts WHERE id = ?').bind(id).first<AccountRow>();
    return row ? mapAccount(row) : null;
  }

  async getByEmail(email: string): Promise<HostAccountRecord | null> {
    const row = await this.db.prepare('SELECT * FROM host_accounts WHERE email = ?')
      .bind(normalizeEmail(email)).first<AccountRow>();
    return row ? mapAccount(row) : null;
  }

  // Returns null when the address is already registered rather than throwing, so
  // the route can answer identically for a new and an existing address and give
  // away nothing about who already has an account here.
  async create(input: {
    email: string;
    passwordHash: string;
    displayName: string | null;
    createdAt: string;
  }): Promise<HostAccountRecord | null> {
    const normalized = normalizeEmail(input.email);
    const result = await this.db.prepare(`
      INSERT OR IGNORE INTO host_accounts (id, email, password_hash, display_name, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), normalized, input.passwordHash, input.displayName, input.createdAt).run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    return (await this.getByEmail(normalized))!;
  }

  // A successful sign-in may opportunistically raise a legacy hash's cost, but it
  // must never overwrite a password reset that won the race after verification.
  async setPasswordHashIfCurrent(
    id: string,
    expectedPasswordHash: string,
    authVersion: number,
    passwordHash: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE host_accounts SET password_hash = ?
      WHERE id = ? AND password_hash = ? AND auth_version = ? AND disabled_at IS NULL
    `).bind(passwordHash, id, expectedPasswordHash, authVersion).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async resetPasswordAndAdvanceVersion(
    id: string,
    passwordHash: string,
    authVersion: number,
    now: string,
  ): Promise<HostAccountRecord | null> {
    await this.db.batch([
      this.db.prepare(`
        UPDATE host_accounts
        SET password_hash = ?,
            auth_version = auth_version + 1,
            email_verified_at = COALESCE(email_verified_at, ?)
        WHERE id = ? AND auth_version = ? AND disabled_at IS NULL
      `).bind(passwordHash, now, id, authVersion),
      this.db.prepare(`
        UPDATE host_sessions
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE account_id = ?
          AND EXISTS (
            SELECT 1 FROM host_accounts
            WHERE id = ? AND auth_version = ? AND password_hash = ?
          )
      `).bind(now, id, id, authVersion + 1, passwordHash),
    ]);
    const account = await this.getById(id);
    return account?.authVersion === authVersion + 1
      && account.passwordHash === passwordHash
      ? account
      : null;
  }

  async markEmailVerified(id: string, verifiedAt: string): Promise<void> {
    await this.db.prepare('UPDATE host_accounts SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
      .bind(verifiedAt, id).run();
  }

  async setNotificationsEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.prepare('UPDATE host_accounts SET notifications_enabled = ? WHERE id = ?')
      .bind(enabled ? 1 : 0, id).run();
  }

  async touch(id: string, lastSeenAt: string): Promise<void> {
    await this.db.prepare('UPDATE host_accounts SET last_seen_at = ? WHERE id = ?').bind(lastSeenAt, id).run();
  }

  async getChallenge(id: string): Promise<LoginChallengeRecord | null> {
    const row = await this.db.prepare('SELECT * FROM host_login_challenges WHERE id = ?')
      .bind(id).first<ChallengeRow>();
    return row ? mapChallenge(row) : null;
  }

  async getLiveChallenge(
    accountId: string,
    purpose: ChallengePurpose,
    now: string,
  ): Promise<LoginChallengeRecord | null> {
    const row = await this.db.prepare(`
      SELECT * FROM host_login_challenges
      WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1
    `).bind(accountId, purpose, now).first<ChallengeRow>();
    return row ? mapChallenge(row) : null;
  }

  // Burns one attempt and reports whether the challenge was still live to burn.
  // A six-digit code is only 10^6 wide, so the attempt cap is the entire defense:
  // it has to be spent atomically, before the digest comparison, or two parallel
  // guessers each see the pre-increment count and the cap never binds.
  async spendAttempt(id: string, maxAttempts: number, now: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE host_login_challenges SET attempts = attempts + 1
      WHERE id = ? AND consumed_at IS NULL AND attempts < ? AND expires_at > ?
    `).bind(id, maxAttempts, now).run();
    return (result.meta.changes ?? 0) === 1;
  }

  // Single-use, enforced by the database rather than by a read-then-write in the
  // service. Losing this race must mean the code is spent, not reusable.
  async consumeChallenge(id: string, now: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE host_login_challenges SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).bind(now, id, now).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async replaceChallenge(input: {
    id: string;
    accountId: string;
    purpose: ChallengePurpose;
    secretDigest: string;
    bindEventId: string | null;
    expiresAt: string;
    createdAt: string;
  }): Promise<LoginChallengeRecord> {
    await this.db.batch([
      this.db.prepare(`
        UPDATE host_login_challenges SET consumed_at = ?
        WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL
      `).bind(input.createdAt, input.accountId, input.purpose),
      this.db.prepare(`
        INSERT INTO host_login_challenges (
          id, account_id, purpose, secret_digest, bind_event_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        input.id,
        input.accountId,
        input.purpose,
        input.secretDigest,
        input.bindEventId,
        input.expiresAt,
        input.createdAt,
      ),
    ]);
    return (await this.getChallenge(input.id))!;
  }

  async replacePendingRegistration(input: PendingRegistrationRecord): Promise<void> {
    await this.db.batch([
      this.db.prepare(`
        UPDATE host_registration_challenges
        SET consumed_at = ?, updated_at = ?
        WHERE email = ? AND consumed_at IS NULL
      `).bind(input.createdAt, input.createdAt, input.email),
      this.db.prepare(`
        INSERT INTO host_registration_challenges (
          id, email, password_hash, display_name, browser_secret_digest,
          code_digest, bind_event_id, creator_session_id, attempts,
          expires_at, consumed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)
      `).bind(
        input.id,
        input.email,
        input.passwordHash,
        input.displayName,
        input.browserSecretDigest,
        input.codeDigest,
        input.bindEventId,
        input.creatorSessionId,
        input.expiresAt,
        input.createdAt,
        input.updatedAt,
      ),
    ]);
  }

  async getPendingRegistration(id: string): Promise<PendingRegistrationRecord | null> {
    const row = await this.db.prepare(`
      SELECT * FROM host_registration_challenges WHERE id = ?
    `).bind(id).first<PendingRegistrationRow>();
    return row ? mapPendingRegistration(row) : null;
  }

  async spendRegistrationAttempt(id: string, maxAttempts: number, now: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE host_registration_challenges
      SET attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND consumed_at IS NULL AND attempts < ? AND expires_at > ?
    `).bind(now, id, maxAttempts, now).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async replaceRegistrationCode(input: {
    id: string;
    browserSecretDigest: string;
    expectedCodeDigest: string;
    expectedExpiresAt: string;
    codeDigest: string;
    expiresAt: string;
    now: string;
  }): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE host_registration_challenges
      SET code_digest = ?, attempts = 0, expires_at = ?, updated_at = ?
      WHERE id = ? AND browser_secret_digest = ?
        AND code_digest = ? AND expires_at = ?
        AND consumed_at IS NULL AND expires_at > ?
    `).bind(
      input.codeDigest,
      input.expiresAt,
      input.now,
      input.id,
      input.browserSecretDigest,
      input.expectedCodeDigest,
      input.expectedExpiresAt,
      input.now,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async activateRegistration(
    pending: PendingRegistrationRecord,
    now: string,
  ): Promise<{ account: HostAccountRecord; boundEvent: boolean } | null> {
    const proposedAccountId = crypto.randomUUID();
    const activationNonce = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.db.prepare(`
        UPDATE host_registration_challenges
        SET consumed_at = ?, activation_nonce = ?, updated_at = ?
        WHERE id = ?
          AND consumed_at IS NULL
          AND expires_at > ?
          AND browser_secret_digest = ?
          AND code_digest = ?
          AND NOT EXISTS (
            SELECT 1 FROM host_accounts
            WHERE email = host_registration_challenges.email AND disabled_at IS NOT NULL
          )
      `).bind(
        now,
        activationNonce,
        now,
        pending.id,
        now,
        pending.browserSecretDigest,
        pending.codeDigest,
      ),
      this.db.prepare(`
        INSERT OR IGNORE INTO host_accounts (
          id, email, password_hash, display_name, email_verified_at, created_at
        )
        SELECT ?, email, password_hash, display_name, ?, ?
        FROM host_registration_challenges
        WHERE id = ? AND activation_nonce = ?
      `).bind(proposedAccountId, now, now, pending.id, activationNonce),
      this.db.prepare(`
        UPDATE host_accounts
        SET email_verified_at = COALESCE(email_verified_at, ?)
        WHERE email = ?
          AND EXISTS (
            SELECT 1 FROM host_registration_challenges
            WHERE id = ? AND activation_nonce = ?
          )
      `).bind(now, pending.email, pending.id, activationNonce),
    ];

    if (pending.bindEventId && pending.creatorSessionId) {
      statements.push(
        this.db.prepare(`
          INSERT OR IGNORE INTO event_hosts (event_id, account_id, role, created_at)
          SELECT events.id, host_accounts.id, 'owner', ?
          FROM events
          JOIN host_accounts ON host_accounts.email = ?
          JOIN event_sessions
            ON event_sessions.id = ?
            AND event_sessions.event_id = events.id
          WHERE events.id = ?
            AND event_sessions.role = 'manager'
            AND event_sessions.revoked_at IS NULL
            AND event_sessions.expires_at > ?
            AND host_accounts.disabled_at IS NULL
            AND (event_sessions.can_claim_owner = 1 OR events.legacy_owner_claim_open = 1)
            AND NOT EXISTS (
              SELECT 1 FROM event_hosts WHERE event_hosts.event_id = events.id
            )
            AND EXISTS (
              SELECT 1 FROM host_registration_challenges
              WHERE id = ? AND activation_nonce = ?
            )
        `).bind(
          now,
          pending.email,
          pending.creatorSessionId,
          pending.bindEventId,
          now,
          pending.id,
          activationNonce,
        ),
        this.db.prepare(`
          UPDATE events
          SET legacy_owner_claim_open = 0
          WHERE id = ? AND legacy_owner_claim_open = 1
            AND EXISTS (
              SELECT 1 FROM event_hosts
              JOIN host_accounts ON host_accounts.id = event_hosts.account_id
              WHERE event_hosts.event_id = events.id
                AND event_hosts.role = 'owner'
                AND event_hosts.created_at = ?
                AND host_accounts.email = ?
            )
            AND EXISTS (
              SELECT 1 FROM host_registration_challenges
              WHERE id = ? AND activation_nonce = ?
            )
        `).bind(pending.bindEventId, now, pending.email, pending.id, activationNonce),
      );
      statements.push(...new NotificationOutboxRepository(this.db).scheduleStatements({
        accountId: null,
        accountEmail: pending.email,
        eventId: pending.bindEventId,
        createdAt: now,
        ownerCreatedAt: now,
      }, { challengeId: pending.id, activationNonce }));
    }

    const results = await this.db.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) return null;
    const account = await this.getByEmail(pending.email);
    if (!account) return null;
    const membership = pending.bindEventId
      ? await this.getEventHost(pending.bindEventId, account.id)
      : null;
    const boundEvent = membership?.role === 'owner';
    return { account, boundEvent };
  }

  async claimInitialOwnerAndSchedule(
    eventId: string,
    accountId: string,
    creatorSessionId: string,
    createdAt: string,
  ): Promise<'claimed' | 'existing' | 'owned_by_other' | 'not_authorized'> {
    const existing = await this.db.prepare(`
      SELECT account_id, role FROM event_hosts WHERE event_id = ?
    `).bind(eventId).all<{ account_id: string; role: EventHostRole }>();
    if (existing.results.some((row) => row.account_id === accountId && row.role === 'owner')) {
      return 'existing';
    }
    if (existing.results.length > 0) return 'owned_by_other';

    await this.db.batch([
      this.db.prepare(`
        INSERT OR IGNORE INTO event_hosts (event_id, account_id, role, created_at)
        SELECT events.id, ?, 'owner', ?
        FROM events
        JOIN event_sessions ON event_sessions.id = ?
          AND event_sessions.event_id = events.id
        WHERE events.id = ?
          AND event_sessions.role = 'manager'
          AND event_sessions.revoked_at IS NULL
          AND event_sessions.expires_at > ?
          AND (event_sessions.can_claim_owner = 1 OR events.legacy_owner_claim_open = 1)
          AND NOT EXISTS (SELECT 1 FROM event_hosts WHERE event_id = events.id)
      `).bind(accountId, createdAt, creatorSessionId, eventId, createdAt),
      this.db.prepare(`
        UPDATE events SET legacy_owner_claim_open = 0
        WHERE id = ? AND legacy_owner_claim_open = 1
          AND EXISTS (
            SELECT 1 FROM event_hosts
            WHERE event_id = ? AND account_id = ? AND role = 'owner' AND created_at = ?
          )
      `).bind(eventId, eventId, accountId, createdAt),
      ...new NotificationOutboxRepository(this.db).scheduleStatements({
        accountId,
        accountEmail: null,
        eventId,
        createdAt,
        ownerCreatedAt: createdAt,
      }),
    ]);
    const owner = await this.db.prepare(`
      SELECT account_id FROM event_hosts WHERE event_id = ? AND role = 'owner'
    `).bind(eventId).first<{ account_id: string }>();
    if (owner?.account_id === accountId) return 'claimed';
    if (owner) return 'owned_by_other';
    // No owner and no membership at all means the guarded insert matched nothing:
    // this session was not the creator and the legacy claim was already spent.
    // Reporting that as "someone else owns it" would name a host who does not exist
    // and hide the real reason. An existing non-owner membership is a different
    // refusal and keeps the conflict answer.
    const anyMembership = await this.db.prepare(
      'SELECT 1 FROM event_hosts WHERE event_id = ?',
    ).bind(eventId).first();
    return anyMembership ? 'owned_by_other' : 'not_authorized';
  }

  async addEventHost(
    eventId: string,
    accountId: string,
    role: EventHostRole,
    createdAt: string,
  ): Promise<void> {
    await this.db.prepare(`
      INSERT OR IGNORE INTO event_hosts (event_id, account_id, role, created_at) VALUES (?, ?, ?, ?)
    `).bind(eventId, accountId, role, createdAt).run();
  }

  async getEventHost(eventId: string, accountId: string): Promise<EventHostRecord | null> {
    const row = await this.db.prepare('SELECT * FROM event_hosts WHERE event_id = ? AND account_id = ?')
      .bind(eventId, accountId).first<EventHostRow>();
    return row ? mapEventHost(row) : null;
  }

  async getEventOwnershipState(
    eventId: string,
    now: string,
  ): Promise<{ hasOwner: boolean; claimStillPossible: boolean } | null> {
    const row = await this.db.prepare(`
      SELECT
        EXISTS (
          SELECT 1 FROM event_hosts
          WHERE event_hosts.event_id = events.id AND event_hosts.role = 'owner'
        ) AS has_owner,
        (
          events.legacy_owner_claim_open = 1
          OR EXISTS (
            SELECT 1 FROM event_sessions
            WHERE event_sessions.event_id = events.id
              AND event_sessions.role = 'manager'
              AND event_sessions.can_claim_owner = 1
              AND event_sessions.revoked_at IS NULL
              AND event_sessions.expires_at > ?
          )
        ) AS claim_still_possible
      FROM events
      WHERE events.id = ?
    `).bind(now, eventId).first<{ has_owner: number; claim_still_possible: number }>();
    return row
      ? { hasOwner: row.has_owner === 1, claimStillPossible: row.claim_still_possible === 1 }
      : null;
  }

  async listEventsForAccount(accountId: string): Promise<EventRecord[]> {
    const { results } = await this.db.prepare(`
      SELECT events.* FROM events
      JOIN event_hosts ON event_hosts.event_id = events.id
      WHERE event_hosts.account_id = ? AND events.deleted_at IS NULL
      ORDER BY events.event_date DESC, events.created_at DESC
    `).bind(accountId).all<EventRow>();
    return results.map(mapEvent);
  }

  // Claims the right to send one notification. The UNIQUE index on
  // (account_id, event_id, kind) is what makes this safe to call from a cron that
  // re-examines every event nightly: the second claim changes no rows and the
  // caller sends nothing.
  async claimNotification(input: {
    accountId: string;
    eventId: string | null;
    kind: NotificationKind;
    sentAt: string;
  }): Promise<boolean> {
    const result = await this.db.prepare(`
      INSERT OR IGNORE INTO host_notifications (id, account_id, event_id, kind, sent_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), input.accountId, input.eventId, input.kind, input.sentAt).run();
    return (result.meta.changes ?? 0) === 1;
  }

  // A claim that was never delivered has to be given back, or one transient send
  // failure silently costs the host that notification forever.
  async releaseNotification(accountId: string, eventId: string | null, kind: NotificationKind): Promise<void> {
    await this.db.prepare(`
      DELETE FROM host_notifications
      WHERE account_id = ? AND kind = ? AND event_id IS ?
    `).bind(accountId, kind, eventId).run();
  }
}

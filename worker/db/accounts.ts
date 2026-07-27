import type { ChallengePurpose, EventHostRole, NotificationKind } from '../../shared/contracts';
import { mapEvent, type EventRow } from './events';
import type {
  EventHostRecord,
  EventRecord,
  HostAccountRecord,
  LoginChallengeRecord,
} from './types';

interface AccountRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  email_verified_at: string | null;
  notifications_enabled: number;
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

function mapAccount(row: AccountRow): HostAccountRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    emailVerifiedAt: row.email_verified_at,
    notificationsEnabled: row.notifications_enabled === 1,
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

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.prepare('UPDATE host_accounts SET password_hash = ? WHERE id = ?')
      .bind(passwordHash, id).run();
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

  async createChallenge(input: {
    id: string;
    accountId: string;
    purpose: ChallengePurpose;
    secretDigest: string;
    bindEventId: string | null;
    expiresAt: string;
    createdAt: string;
  }): Promise<LoginChallengeRecord> {
    await this.db.prepare(`
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
    ).run();
    return (await this.getChallenge(input.id))!;
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

  async countRecentChallenges(accountId: string, purpose: ChallengePurpose, since: string): Promise<number> {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count FROM host_login_challenges
      WHERE account_id = ? AND purpose = ? AND created_at >= ?
    `).bind(accountId, purpose, since).first<{ count: number }>();
    return row?.count ?? 0;
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

  // Requesting a fresh code retires the ones before it, so an older message
  // sitting in an inbox cannot be replayed after the host asks again.
  async supersedeChallenges(accountId: string, purpose: ChallengePurpose, now: string): Promise<void> {
    await this.db.prepare(`
      UPDATE host_login_challenges SET consumed_at = ?
      WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL
    `).bind(now, accountId, purpose).run();
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

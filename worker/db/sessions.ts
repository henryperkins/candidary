import type { Role } from '../../shared/contracts';
import type { HostSessionRecord, SessionRecord } from './types';

interface SessionRow {
  id: string;
  secret_digest: string;
  csrf_digest: string;
  event_id: string;
  access_token_id: string;
  role: Role;
  can_claim_owner: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateSessionRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  eventId: string;
  accessTokenId: string;
  role: Role;
  canClaimOwner: boolean;
  expiresAt: string;
  createdAt: string;
}

interface HostSessionRow {
  id: string;
  secret_digest: string;
  csrf_digest: string;
  account_id: string;
  auth_version: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateHostSessionRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  accountId: string;
  authVersion: number;
  expiresAt: string;
  createdAt: string;
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    secretDigest: row.secret_digest,
    csrfDigest: row.csrf_digest,
    eventId: row.event_id,
    accessTokenId: row.access_token_id,
    role: row.role,
    canClaimOwner: row.can_claim_owner === 1,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function mapHostSession(row: HostSessionRow): HostSessionRecord {
  return {
    id: row.id,
    secretDigest: row.secret_digest,
    csrfDigest: row.csrf_digest,
    accountId: row.account_id,
    authVersion: row.auth_version,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export class SessionsRepository {
  constructor(private readonly db: D1Database) {}

  createStatement(input: CreateSessionRecord): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO event_sessions (
        id, secret_digest, csrf_digest, event_id, access_token_id, role, can_claim_owner, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.secretDigest,
      input.csrfDigest,
      input.eventId,
      input.accessTokenId,
      input.role,
      input.canClaimOwner ? 1 : 0,
      input.expiresAt,
      input.createdAt,
    );
  }

  async create(input: CreateSessionRecord): Promise<SessionRecord> {
    await this.createStatement(input).run();
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<SessionRecord | null> {
    const row = await this.db.prepare('SELECT * FROM event_sessions WHERE id = ?').bind(id).first<SessionRow>();
    return row ? mapSession(row) : null;
  }

  async getForEvent(id: string, eventId: string): Promise<SessionRecord | null> {
    const row = await this.db.prepare('SELECT * FROM event_sessions WHERE id = ? AND event_id = ?')
      .bind(id, eventId).first<SessionRow>();
    return row ? mapSession(row) : null;
  }

  async revoke(id: string, revokedAt: string): Promise<void> {
    await this.db.prepare('UPDATE event_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(revokedAt, id).run();
  }

  async revokeForToken(accessTokenId: string, revokedAt: string): Promise<void> {
    await this.db.prepare('UPDATE event_sessions SET revoked_at = ? WHERE access_token_id = ? AND revoked_at IS NULL')
      .bind(revokedAt, accessTokenId).run();
  }
}

export class HostSessionsRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateHostSessionRecord): Promise<HostSessionRecord> {
    await this.db.prepare(`
      INSERT INTO host_sessions (
        id, secret_digest, csrf_digest, account_id, auth_version, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.secretDigest,
      input.csrfDigest,
      input.accountId,
      input.authVersion,
      input.expiresAt,
      input.createdAt,
    ).run();
    return (await this.getById(input.id))!;
  }

  async createIfAuthVersion(input: CreateHostSessionRecord): Promise<HostSessionRecord | null> {
    const result = await this.db.prepare(`
      INSERT INTO host_sessions (
        id, secret_digest, csrf_digest, account_id, auth_version, expires_at, created_at
      )
      SELECT ?, ?, ?, id, auth_version, ?, ?
      FROM host_accounts
      WHERE id = ? AND auth_version = ? AND disabled_at IS NULL
    `).bind(
      input.id,
      input.secretDigest,
      input.csrfDigest,
      input.expiresAt,
      input.createdAt,
      input.accountId,
      input.authVersion,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<HostSessionRecord | null> {
    const row = await this.db.prepare('SELECT * FROM host_sessions WHERE id = ?').bind(id).first<HostSessionRow>();
    return row ? mapHostSession(row) : null;
  }

  async revoke(id: string, revokedAt: string): Promise<void> {
    await this.db.prepare('UPDATE host_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(revokedAt, id).run();
  }

  async revokeForAccount(accountId: string, revokedAt: string): Promise<void> {
    await this.db.prepare('UPDATE host_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL')
      .bind(revokedAt, accountId).run();
  }
}

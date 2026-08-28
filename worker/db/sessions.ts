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
  manager_upload_account_id: string | null;
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

export interface CreateManagerUploadActorRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  hostSessionId: string;
  accountId: string;
  eventId: string;
  createdAt: string;
  nowIso: string;
}

export interface ManagerUploadActorRecord {
  id: string;
  eventId: string;
  accessTokenId: string;
  accountId: string;
  expiresAt: string;
}

export interface ManagerLinkRotationSessionInput {
  eventId: string;
  predecessorId: string;
  replacementId: string;
  rotatedAt: string;
}

interface ManagerUploadActorRow {
  id: string;
  event_id: string;
  access_token_id: string;
  manager_upload_account_id: string;
  expires_at: string;
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
    managerUploadAccountId: row.manager_upload_account_id,
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

function mapManagerUploadActor(row: ManagerUploadActorRow): ManagerUploadActorRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    accessTokenId: row.access_token_id,
    accountId: row.manager_upload_account_id,
    expiresAt: row.expires_at,
  };
}

export class SessionsRepository {
  constructor(private readonly db: D1Database) {}

  createStatement(input: CreateSessionRecord): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO event_sessions (
        id, secret_digest, csrf_digest, event_id, access_token_id, role, can_claim_owner,
        manager_upload_account_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
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

  async createManagerUploadActor(
    input: CreateManagerUploadActorRecord,
  ): Promise<ManagerUploadActorRecord | null> {
    const result = await this.db.prepare(`
      INSERT INTO event_sessions (
        id, secret_digest, csrf_digest, event_id, access_token_id, role,
        can_claim_owner, manager_upload_account_id, expires_at, created_at
      )
      SELECT ?, ?, ?, e.id, t.id, 'manager', 0, a.id,
             e.management_access_expires_at, ?
        FROM host_sessions AS hs
        JOIN host_accounts AS a ON a.id = hs.account_id
        JOIN event_hosts AS eh ON eh.account_id = a.id
        JOIN events AS e ON e.id = eh.event_id
        JOIN event_access_tokens AS t ON t.event_id = e.id AND t.role = 'manager'
       WHERE hs.id = ? AND hs.account_id = ?
         AND hs.revoked_at IS NULL AND hs.expires_at > ?
         AND hs.auth_version = a.auth_version AND a.disabled_at IS NULL
         AND eh.event_id = ? AND eh.role IN ('owner', 'cohost')
         AND e.deleted_at IS NULL AND e.management_access_expires_at > ?
         AND t.revoked_at IS NULL AND t.expires_at > ?
    `).bind(
      input.id,
      input.secretDigest,
      input.csrfDigest,
      input.createdAt,
      input.hostSessionId,
      input.accountId,
      input.nowIso,
      input.eventId,
      input.nowIso,
      input.nowIso,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    return this.getLiveManagerUploadActor(input.eventId, input.accountId, input.nowIso);
  }

  async getLiveManagerUploadActor(
    eventId: string,
    accountId: string,
    nowIso: string,
  ): Promise<ManagerUploadActorRecord | null> {
    const row = await this.db.prepare(`
      SELECT
        s.id,
        s.event_id,
        s.access_token_id,
        s.manager_upload_account_id,
        s.expires_at
      FROM event_sessions AS s
      JOIN event_access_tokens AS t
        ON t.id = s.access_token_id
       AND t.event_id = s.event_id
       AND t.role = 'manager'
       AND t.revoked_at IS NULL
       AND t.expires_at > ?
      WHERE s.event_id = ?
        AND s.manager_upload_account_id = ?
        AND s.role = 'manager'
        AND s.can_claim_owner = 0
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
      LIMIT 1
    `).bind(nowIso, eventId, accountId, nowIso).first<ManagerUploadActorRow>();
    return row ? mapManagerUploadActor(row) : null;
  }

  async revokeManagerUploadActors(
    eventId: string,
    accountId: string | null,
    revokedAt: string,
  ): Promise<number> {
    const result = await this.db.prepare(`
      UPDATE event_sessions
      SET revoked_at = ?
      WHERE event_id = ?
        AND manager_upload_account_id IS NOT NULL
        AND revoked_at IS NULL
        AND (? IS NULL OR manager_upload_account_id = ?)
    `).bind(revokedAt, eventId, accountId, accountId).run();
    return result.meta.changes ?? 0;
  }

  /** Optional bearer revocation and account-actor rebind for one rotation winner. */
  managerLinkRotationStatements(input: ManagerLinkRotationSessionInput): D1PreparedStatement[] {
    const replacementGuard = `EXISTS (
      SELECT 1 FROM event_access_tokens AS replacement
      WHERE replacement.id = ? AND replacement.event_id = ?
        AND replacement.role = 'manager' AND replacement.revoked_at IS NULL
    )`;
    return [
      this.db.prepare(`
        UPDATE event_sessions
        SET revoked_at = ?
        WHERE event_id = ? AND access_token_id = ?
          AND role = 'manager' AND manager_upload_account_id IS NULL
          AND revoked_at IS NULL
          AND ${replacementGuard}
      `).bind(
        input.rotatedAt,
        input.eventId,
        input.predecessorId,
        input.replacementId,
        input.eventId,
      ),
      this.db.prepare(`
        UPDATE event_sessions
        SET access_token_id = ?
        WHERE event_id = ? AND access_token_id = ?
          AND role = 'manager' AND manager_upload_account_id IS NOT NULL
          AND revoked_at IS NULL AND expires_at > ?
          AND ${replacementGuard}
      `).bind(
        input.replacementId,
        input.eventId,
        input.predecessorId,
        input.rotatedAt,
        input.replacementId,
        input.eventId,
      ),
    ];
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

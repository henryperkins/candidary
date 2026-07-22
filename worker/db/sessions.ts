import type { Role } from '../../shared/contracts';
import type { SessionRecord } from './types';

interface SessionRow {
  id: string;
  secret_digest: string;
  csrf_digest: string;
  event_id: string;
  access_token_id: string;
  role: Role;
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
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export class SessionsRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateSessionRecord): Promise<SessionRecord> {
    await this.db.prepare(`
      INSERT INTO event_sessions (
        id, secret_digest, csrf_digest, event_id, access_token_id, role, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.secretDigest,
      input.csrfDigest,
      input.eventId,
      input.accessTokenId,
      input.role,
      input.expiresAt,
      input.createdAt,
    ).run();
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

  async revokeForToken(accessTokenId: string, revokedAt: string): Promise<void> {
    await this.db.prepare('UPDATE event_sessions SET revoked_at = ? WHERE access_token_id = ? AND revoked_at IS NULL')
      .bind(revokedAt, accessTokenId).run();
  }
}


import type { Role } from '../../shared/contracts';
import type { TokenRecord } from './types';

interface TokenRow {
  id: string;
  event_id: string;
  role: Role;
  secret_digest: string;
  secret_ciphertext: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateTokenRecord {
  id: string;
  eventId: string;
  role: Role;
  secretDigest: string;
  secretCiphertext: string | null;
  expiresAt: string;
  createdAt: string;
}

function mapToken(row: TokenRow): TokenRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    role: row.role,
    secretDigest: row.secret_digest,
    secretCiphertext: row.secret_ciphertext,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export class TokensRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateTokenRecord): Promise<TokenRecord> {
    await this.db.prepare(`
      INSERT INTO event_access_tokens (
        id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.eventId,
      input.role,
      input.secretDigest,
      input.secretCiphertext,
      input.expiresAt,
      input.createdAt,
    ).run();
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<TokenRecord | null> {
    const row = await this.db.prepare('SELECT * FROM event_access_tokens WHERE id = ?').bind(id).first<TokenRow>();
    return row ? mapToken(row) : null;
  }

  async getActiveForRole(eventId: string, role: Role): Promise<TokenRecord | null> {
    const row = await this.db.prepare(`
      SELECT * FROM event_access_tokens
      WHERE event_id = ? AND role = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).bind(eventId, role).first<TokenRow>();
    return row ? mapToken(row) : null;
  }

  async revoke(id: string, revokedAt: string): Promise<void> {
    await this.db.prepare('UPDATE event_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(revokedAt, id).run();
  }

  async revokeRole(eventId: string, role: Role, revokedAt: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`
        UPDATE event_access_tokens SET revoked_at = ?
        WHERE event_id = ? AND role = ? AND revoked_at IS NULL
      `).bind(revokedAt, eventId, role),
      this.db.prepare(`
        UPDATE event_sessions SET revoked_at = ?
        WHERE event_id = ? AND role = ? AND revoked_at IS NULL
      `).bind(revokedAt, eventId, role),
    ]);
  }
}

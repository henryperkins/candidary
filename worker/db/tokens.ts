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

export interface ManagerLinkRotationTokenInput extends CreateTokenRecord {
  expectedRevision: number;
  predecessorId: string;
  rotatedAt: string;
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

  createStatement(input: CreateTokenRecord): D1PreparedStatement {
    return this.db.prepare(`
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
    );
  }

  async create(input: CreateTokenRecord): Promise<TokenRecord> {
    await this.createStatement(input).run();
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

  async getManagerLinkRevision(eventId: string): Promise<number | null> {
    const row = await this.db.prepare(`
      SELECT manager_link_revision
      FROM events
      WHERE id = ? AND deleted_at IS NULL
    `).bind(eventId).first<{ manager_link_revision: number }>();
    return row?.manager_link_revision ?? null;
  }

  /**
   * The three required rotation winners plus a transaction assertion.
   *
   * A zero-change statement is not an error in D1, so the fourth statement
   * turns a missing replacement into a NOT NULL violation. That rolls the CAS
   * back when the exact predecessor was concurrently revoked, while callers
   * still inspect the first three result counts on every successful batch.
   */
  managerLinkRotationStatements(input: ManagerLinkRotationTokenInput): D1PreparedStatement[] {
    return [
      this.db.prepare(`
        UPDATE events
        SET manager_link_revision = manager_link_revision + 1
        WHERE id = ?
          AND manager_link_revision = ?
          AND deleted_at IS NULL
          AND management_access_expires_at > ?
      `).bind(input.eventId, input.expectedRevision, input.rotatedAt),
      this.db.prepare(`
        UPDATE event_access_tokens
        SET revoked_at = ?
        WHERE id = ? AND event_id = ?
          AND role = 'manager' AND revoked_at IS NULL
          AND changes() = 1
      `).bind(input.rotatedAt, input.predecessorId, input.eventId),
      this.db.prepare(`
        INSERT INTO event_access_tokens (
          id, event_id, role, secret_digest, secret_ciphertext, expires_at, created_at
        )
        SELECT ?, ?, 'manager', ?, NULL, ?, ?
        WHERE changes() = 1
      `).bind(
        input.id,
        input.eventId,
        input.secretDigest,
        input.expiresAt,
        input.createdAt,
      ),
      this.db.prepare(`
        UPDATE events
        SET manager_link_revision = CASE
          WHEN EXISTS (
            SELECT 1 FROM event_access_tokens
            WHERE id = ? AND event_id = ?
              AND role = 'manager' AND revoked_at IS NULL
          ) THEN manager_link_revision
          ELSE NULL
        END
        WHERE id = ?
      `).bind(input.id, input.eventId, input.eventId),
    ];
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

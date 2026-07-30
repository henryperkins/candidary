import type { RsvpSessionRecord } from './types';

export interface RsvpSessionRow {
  id: string;
  secret_digest: string;
  csrf_digest: string;
  event_id: string;
  household_id: string;
  write_authority_deadline: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface CreateRsvpSessionRecord {
  id: string;
  secretDigest: string;
  csrfDigest: string;
  eventId: string;
  householdId: string;
  writeAuthorityDeadline: string;
  expiresAt: string;
  createdAt: string;
}

export function mapRsvpSession(row: RsvpSessionRow): RsvpSessionRecord {
  return {
    id: row.id,
    secretDigest: row.secret_digest,
    csrfDigest: row.csrf_digest,
    eventId: row.event_id,
    householdId: row.household_id,
    writeAuthorityDeadline: row.write_authority_deadline,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export class RsvpSessionsRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateRsvpSessionRecord): Promise<RsvpSessionRecord> {
    await this.db.prepare(`
      INSERT INTO rsvp_sessions (
        id, secret_digest, csrf_digest, event_id, household_id,
        write_authority_deadline, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.secretDigest,
      input.csrfDigest,
      input.eventId,
      input.householdId,
      input.writeAuthorityDeadline,
      input.expiresAt,
      input.createdAt,
    ).run();
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<RsvpSessionRecord | null> {
    const row = await this.db.prepare('SELECT * FROM rsvp_sessions WHERE id = ?')
      .bind(id).first<RsvpSessionRow>();
    return row ? mapRsvpSession(row) : null;
  }

  async revoke(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE rsvp_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).bind(revokedAt, id).run();
    return (result.meta.changes ?? 0) === 1;
  }

  // Archiving a household ends its devices' authority immediately, so this runs
  // inside the same batch as the archive itself.
  revokeForHouseholdStatement(
    eventId: string,
    householdId: string,
    revokedAt: string,
  ): D1PreparedStatement {
    return this.db.prepare(`
      UPDATE rsvp_sessions
      SET revoked_at = ?
      WHERE event_id = ? AND household_id = ? AND revoked_at IS NULL
    `).bind(revokedAt, eventId, householdId);
  }

  // Used by the irreversible entry disable, which signs out every household at
  // once alongside the event's own guest sessions.
  revokeForEventStatement(eventId: string, revokedAt: string): D1PreparedStatement {
    return this.db.prepare(`
      UPDATE rsvp_sessions
      SET revoked_at = ?
      WHERE event_id = ? AND revoked_at IS NULL
    `).bind(revokedAt, eventId);
  }
}

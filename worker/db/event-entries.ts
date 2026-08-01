import type { EventEntryRecord } from './types';

export interface EventEntryRow {
  id: string;
  event_id: string;
  secret_digest: string;
  secret_ciphertext: string;
  created_at: string;
  disabled_at: string | null;
}

export interface CreateEventEntryRecord {
  id: string;
  eventId: string;
  secretDigest: string;
  secretCiphertext: string;
  createdAt: string;
}

export function mapEventEntry(row: EventEntryRow): EventEntryRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    secretDigest: row.secret_digest,
    secretCiphertext: row.secret_ciphertext,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

export class EventEntriesRepository {
  constructor(private readonly db: D1Database) {}

  // A statement rather than a write, so the entry credential is created in the
  // same batch as the event itself. An event that existed for even a moment
  // without its printed credential would be an event whose QR could not be
  // generated.
  createStatement(input: CreateEventEntryRecord): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO event_entry_credentials (
        id, event_id, secret_digest, secret_ciphertext, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.eventId,
      input.secretDigest,
      input.secretCiphertext,
      input.createdAt,
    );
  }

  /**
   * Adopts a pre-0008 guest token only if that exact token is still active when
   * the INSERT executes. Secret conversion happens before this statement is
   * built, so the predicate is what closes the read/crypto/disable race.
   */
  createLegacyAdoptionStatement(input: CreateEventEntryRecord): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO event_entry_credentials (
        id, event_id, secret_digest, secret_ciphertext, created_at
      )
      SELECT ?, event_id, ?, ?, ?
      FROM event_access_tokens
      WHERE id = ? AND event_id = ? AND role = 'guest' AND revoked_at IS NULL
    `).bind(
      input.id,
      input.secretDigest,
      input.secretCiphertext,
      input.createdAt,
      input.id,
      input.eventId,
    );
  }

  /**
   * Gives a legacy event the same durable disabled row as a migrated event.
   * The copied digest and ciphertext are deliberately never usable as an entry
   * credential: this row is born disabled inside the same batch that revokes
   * the source token. They only satisfy the historical table shape so recovery
   * and repeated disable calls can observe the irreversible tombstone.
   */
  createDisabledLegacyStatement(eventId: string, disabledAt: string): D1PreparedStatement {
    return this.db.prepare(`
      INSERT OR IGNORE INTO event_entry_credentials (
        id, event_id, secret_digest, secret_ciphertext, created_at, disabled_at
      )
      SELECT id, event_id, secret_digest, secret_ciphertext, created_at,
        COALESCE(revoked_at, ?)
      FROM event_access_tokens
      WHERE event_id = ? AND role = 'guest' AND secret_ciphertext IS NOT NULL
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC
      LIMIT 1
    `).bind(disabledAt, eventId);
  }

  async getById(id: string): Promise<EventEntryRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM event_entry_credentials WHERE id = ?')
      .bind(id).first<EventEntryRow>();
    return row ? mapEventEntry(row) : null;
  }

  async getForEvent(eventId: string): Promise<EventEntryRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM event_entry_credentials WHERE event_id = ?')
      .bind(eventId).first<EventEntryRow>();
    return row ? mapEventEntry(row) : null;
  }

  // Returns whether this call is the one that disabled it. A second call is not
  // an error: disabling is irreversible and idempotent, and the host who clicks
  // twice should see the same answer both times, with the original timestamp.
  async disableForEvent(eventId: string, disabledAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE event_entry_credentials
      SET disabled_at = ?
      WHERE event_id = ? AND disabled_at IS NULL
    `).bind(disabledAt, eventId).run();
    return (result.meta.changes ?? 0) === 1;
  }
}

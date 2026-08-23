export interface AlbumShareRecord {
  id: string;
  eventId: string;
  secretDigest: string;
  secretCiphertext: string;
  sharedAt: string;
  createdAt: string;
}

export interface AlbumShareSessionRecord {
  id: string;
  shareId: string;
  eventId: string;
  secretDigest: string;
  expiresAt: string;
  createdAt: string;
}

interface AlbumShareRow {
  id: string;
  event_id: string;
  secret_digest: string;
  secret_ciphertext: string;
  shared_at: string;
  created_at: string;
}

interface AlbumShareSessionRow {
  id: string;
  share_id: string;
  event_id: string;
  secret_digest: string;
  expires_at: string;
  created_at: string;
}

function mapShare(row: AlbumShareRow): AlbumShareRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    secretDigest: row.secret_digest,
    secretCiphertext: row.secret_ciphertext,
    sharedAt: row.shared_at,
    createdAt: row.created_at,
  };
}

function mapSession(row: AlbumShareSessionRow): AlbumShareSessionRecord {
  return {
    id: row.id,
    shareId: row.share_id,
    eventId: row.event_id,
    secretDigest: row.secret_digest,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export class AlbumSharesRepository {
  constructor(private readonly db: D1Database) {}

  async getForEvent(eventId: string): Promise<AlbumShareRecord | null> {
    const row = await this.db.prepare(`
      SELECT id, event_id, secret_digest, secret_ciphertext, shared_at, created_at
      FROM event_album_shares WHERE event_id = ?
    `).bind(eventId).first<AlbumShareRow>();
    return row ? mapShare(row) : null;
  }

  async getById(id: string): Promise<AlbumShareRecord | null> {
    const row = await this.db.prepare(`
      SELECT id, event_id, secret_digest, secret_ciphertext, shared_at, created_at
      FROM event_album_shares WHERE id = ?
    `).bind(id).first<AlbumShareRow>();
    return row ? mapShare(row) : null;
  }

  async create(record: AlbumShareRecord): Promise<void> {
    await this.db.prepare(`
      INSERT OR IGNORE INTO event_album_shares (
        id, event_id, secret_digest, secret_ciphertext, shared_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      record.id,
      record.eventId,
      record.secretDigest,
      record.secretCiphertext,
      record.sharedAt,
      record.createdAt,
    ).run();
  }

  async deleteForEvent(eventId: string): Promise<void> {
    await this.db.prepare('DELETE FROM event_album_shares WHERE event_id = ?')
      .bind(eventId).run();
  }

  async createSession(record: AlbumShareSessionRecord): Promise<void> {
    await this.db.prepare(`
      INSERT INTO event_album_share_sessions (
        id, share_id, event_id, secret_digest, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      record.id,
      record.shareId,
      record.eventId,
      record.secretDigest,
      record.expiresAt,
      record.createdAt,
    ).run();
  }

  async getSession(id: string): Promise<AlbumShareSessionRecord | null> {
    const row = await this.db.prepare(`
      SELECT id, share_id, event_id, secret_digest, expires_at, created_at
      FROM event_album_share_sessions WHERE id = ?
    `).bind(id).first<AlbumShareSessionRow>();
    return row ? mapSession(row) : null;
  }

  async deleteExpiredSessions(now: string, limit: number): Promise<number> {
    const result = await this.db.prepare(`
      DELETE FROM event_album_share_sessions
      WHERE id IN (
        SELECT id FROM event_album_share_sessions
        WHERE expires_at <= ?
        ORDER BY expires_at, id
        LIMIT ?
      )
    `).bind(now, limit).run();
    return result.meta.changes;
  }
}

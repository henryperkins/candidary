import type { GalleryAudienceSummaryView } from '../../shared/contracts';

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

/**
 * Result of the atomic per-share session admission batch. `created` is false
 * when revocation or the live-session ceiling wins; the in-transaction
 * diagnostic fields distinguish those outcomes without a racy follow-up read.
 */
export interface AlbumShareSessionAdmission {
  created: boolean;
  shareExists: boolean;
  retryAt: string | null;
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

  async audienceStatus(eventId: string): Promise<GalleryAudienceSummaryView['albumLink']> {
    const row = await this.db.prepare(`
      SELECT shared_at FROM event_album_shares WHERE event_id = ?
    `).bind(eventId).first<{ shared_at: string }>();
    return { active: row !== null, sharedAt: row?.shared_at ?? null };
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

  /**
   * Atomically admits one live session only while the share exists and its
   * per-share live-session count remains below `maxActive`.
   *
   * D1 executes a batch as one ordered transaction, so concurrent exchanges
   * cannot both observe the final slot. The diagnostic statement runs in the
   * same transaction and distinguishes revocation from capacity without a
   * racy follow-up read.
   */
  async admitSession(
    record: AlbumShareSessionRecord,
    activeAt: string,
    maxActive: number,
  ): Promise<AlbumShareSessionAdmission> {
    const results = await this.db.batch([
      this.db.prepare(`
      INSERT INTO event_album_share_sessions (
        id, share_id, event_id, secret_digest, expires_at, created_at
      )
      SELECT ?, share.id, share.event_id, ?, ?, ?
      FROM event_album_shares AS share
      WHERE share.id = ? AND share.event_id = ?
        AND (
          SELECT COUNT(*) FROM event_album_share_sessions AS session
          WHERE session.share_id = share.id AND session.expires_at > ?
        ) < ?
    `).bind(
        record.id,
        record.secretDigest,
        record.expiresAt,
        record.createdAt,
        record.shareId,
        record.eventId,
        activeAt,
        maxActive,
      ),
      this.db.prepare(`
        SELECT
          EXISTS (
            SELECT 1 FROM event_album_shares
            WHERE id = ? AND event_id = ?
          ) AS share_exists,
          (
            SELECT MIN(expires_at) FROM event_album_share_sessions
            WHERE share_id = ? AND expires_at > ?
          ) AS retry_at
      `).bind(record.shareId, record.eventId, record.shareId, activeAt),
    ]);
    const diagnostic = results[1]?.results[0] as {
      share_exists: number;
      retry_at: string | null;
    } | undefined;
    if (!diagnostic) throw new Error('Album share session admission returned no diagnostic.');
    return {
      created: (results[0]?.meta.changes ?? 0) === 1,
      shareExists: diagnostic.share_exists === 1,
      retryAt: diagnostic.retry_at,
    };
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

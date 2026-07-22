import type { ModerationStatus } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import type { FeedItem, MessageRecord } from './types';

interface MessageRow {
  id: string;
  event_id: string;
  guest_session_id: string;
  guest_name: string | null;
  body: string;
  moderation_status: ModerationStatus;
  created_at: string;
  approved_at: string | null;
  deleted_at: string | null;
}

interface FeedRow {
  id: string;
  kind: 'message' | 'caption';
  guest_name: string | null;
  body: string;
  moderation_status: ModerationStatus;
  created_at: string;
  media_id: string | null;
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    guestSessionId: row.guest_session_id,
    guestName: row.guest_name,
    body: row.body,
    moderationStatus: row.moderation_status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    deletedAt: row.deleted_at,
  };
}

export interface CreateMessageRecord {
  id: string;
  eventId: string;
  guestSessionId: string;
  guestName: string | null;
  body: string;
  moderationStatus: ModerationStatus;
  createdAt: string;
}

export class MessagesRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateMessageRecord): Promise<MessageRecord> {
    await this.db.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status, created_at, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      input.id,
      input.eventId,
      input.guestSessionId,
      input.guestName,
      input.body,
      input.moderationStatus,
      input.createdAt,
      input.moderationStatus === 'approved' ? input.createdAt : null,
    ).run();
    return (await this.getById(input.id))!;
  }

  async getById(id: string): Promise<MessageRecord | null> {
    const row = await this.db.prepare('SELECT * FROM guest_messages WHERE id = ?').bind(id).first<MessageRow>();
    return row ? mapMessage(row) : null;
  }

  async listForManager(eventId: string, status?: ModerationStatus): Promise<MessageRecord[]> {
    const result = status
      ? await this.db.prepare(`
          SELECT * FROM guest_messages
          WHERE event_id = ? AND moderation_status = ? AND deleted_at IS NULL
          ORDER BY created_at ASC
        `).bind(eventId, status).all<MessageRow>()
      : await this.db.prepare(`
          SELECT * FROM guest_messages WHERE event_id = ? AND deleted_at IS NULL ORDER BY created_at ASC
        `).bind(eventId).all<MessageRow>();
    return result.results.map(mapMessage);
  }

  async listFeed(eventId: string, guestSessionId: string): Promise<FeedItem[]> {
    const result = await this.db.prepare(`
      SELECT id, 'message' AS kind, guest_name, body, moderation_status, created_at, NULL AS media_id
      FROM guest_messages
      WHERE event_id = ? AND deleted_at IS NULL
        AND (moderation_status = 'approved' OR guest_session_id = ?)
      UNION ALL
      SELECT id, 'caption' AS kind, guest_name, caption AS body, moderation_status, created_at, id AS media_id
      FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND deleted_at IS NULL AND caption IS NOT NULL
        AND (moderation_status = 'approved' OR uploader_session_id = ?)
      ORDER BY created_at ASC
    `).bind(eventId, guestSessionId, eventId, guestSessionId).all<FeedRow>();
    return result.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      guestName: row.guest_name,
      body: row.body,
      moderationStatus: row.moderation_status,
      createdAt: row.created_at,
      mediaId: row.media_id,
    }));
  }

  async moderate(
    id: string,
    expected: ModerationStatus,
    target: ModerationStatus,
    changedAt: string,
  ): Promise<MessageRecord> {
    const result = await this.db.prepare(`
      UPDATE guest_messages SET moderation_status = ?, approved_at = ?
      WHERE id = ? AND moderation_status = ? AND deleted_at IS NULL
    `).bind(target, target === 'approved' ? changedAt : null, id, expected).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ApiError('MEDIA_STATE_CONFLICT', 'This note changed since you last viewed it. Refresh and try again.', 409);
    }
    return (await this.getById(id))!;
  }

  async delete(id: string, deletedAt: string): Promise<MessageRecord> {
    const result = await this.db.prepare(`
      UPDATE guest_messages SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL
    `).bind(deletedAt, id).run();
    if ((result.meta.changes ?? 0) !== 1) {
      const current = await this.getById(id);
      if (current?.deletedAt) return current;
      throw new ApiError('MEDIA_STATE_CONFLICT', 'This note no longer exists.', 404);
    }
    return (await this.getById(id))!;
  }
}

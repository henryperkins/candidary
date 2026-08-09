import type { ModerationStatus } from '../../shared/contracts';
import { GUEST_MESSAGE_PAGE_SIZE } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { MessageCursor } from '../http/message-cursor';
import type { FeedItem, MessageRecord } from './types';

interface MessageRow {
  id: string;
  event_id: string;
  guest_session_id: string;
  guest_name: string | null;
  body: string;
  moderation_status: ModerationStatus;
  idempotency_key: string | null;
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
    idempotencyKey: row.idempotency_key,
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
  idempotencyKey: string | null;
  createdAt: string;
}

export interface CreateMessageResult {
  message: MessageRecord;
  replayed: boolean;
}

export interface MessageFeedPage {
  items: FeedItem[];
  nextCursor: MessageCursor | null;
}

export class MessagesRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateMessageRecord): Promise<CreateMessageResult> {
    const inserted = await this.db.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (event_id, guest_session_id, idempotency_key) DO NOTHING
    `).bind(
      input.id,
      input.eventId,
      input.guestSessionId,
      input.guestName,
      input.body,
      input.moderationStatus,
      input.idempotencyKey,
      input.createdAt,
      input.moderationStatus === 'approved' ? input.createdAt : null,
    ).run();
    if ((inserted.meta.changes ?? 0) === 1) {
      return { message: (await this.getById(input.id))!, replayed: false };
    }

    if (!input.idempotencyKey) {
      throw new Error('Guest note insert did not create a row.');
    }
    const existing = await this.db.prepare(`
      SELECT * FROM guest_messages
      WHERE event_id = ? AND guest_session_id = ? AND idempotency_key = ?
    `).bind(input.eventId, input.guestSessionId, input.idempotencyKey).first<MessageRow>();
    if (!existing) throw new Error('Guest note idempotency conflict had no stored row.');
    if (existing.guest_name !== input.guestName || existing.body !== input.body) {
      throw new ApiError(
        'MESSAGE_SUBMISSION_CONFLICT',
        'This note changed after an earlier send attempt. Send it again.',
        409,
      );
    }
    return { message: mapMessage(existing), replayed: true };
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

  async listFeed(
    eventId: string,
    guestSessionId: string,
    cursor?: MessageCursor,
    limit = GUEST_MESSAGE_PAGE_SIZE,
  ): Promise<MessageFeedPage> {
    const cursorPredicate = cursor
      ? 'WHERE (created_at < ? OR (created_at = ? AND id < ?))'
      : '';
    const bindings: unknown[] = [eventId, guestSessionId, eventId, guestSessionId];
    if (cursor) bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    bindings.push(limit + 1);
    const result = await this.db.prepare(`
      SELECT * FROM (
        SELECT id, 'message' AS kind, guest_name, body, moderation_status, created_at, NULL AS media_id
        FROM guest_messages
        WHERE event_id = ? AND deleted_at IS NULL
          AND (moderation_status = 'approved' OR guest_session_id = ?)
        UNION ALL
        SELECT id, 'caption' AS kind, guest_name, caption AS body,
          CASE publication_status
            WHEN 'published' THEN 'approved'
            WHEN 'hidden' THEN 'rejected'
            ELSE 'pending'
          END AS moderation_status,
          created_at, id AS media_id
        FROM media
        WHERE event_id = ? AND upload_state = 'stored' AND deleted_at IS NULL AND caption IS NOT NULL
          AND (publication_status = 'published' OR uploader_session_id = ?)
      )
      ${cursorPredicate}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(...bindings).all<FeedRow>();
    const pageRows = result.results.slice(0, limit);
    const oldest = pageRows[pageRows.length - 1];
    const items = [...pageRows].reverse().map((row) => ({
      id: row.id,
      kind: row.kind,
      guestName: row.guest_name,
      body: row.body,
      moderationStatus: row.moderation_status,
      createdAt: row.created_at,
      mediaId: row.media_id,
    }));
    return {
      items,
      nextCursor: result.results.length > limit && oldest
        ? { createdAt: oldest.created_at, id: oldest.id }
        : null,
    };
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

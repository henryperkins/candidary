import type { ManagerGuestbookItem, ModerationStatus } from '../../shared/contracts';
import {
  GUEST_MESSAGE_PAGE_SIZE,
  MAX_EVENT_GUEST_NOTES,
  MAX_GUEST_NOTES_PER_IP_WINDOW,
  MAX_GUEST_NOTES_PER_SESSION_WINDOW,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import {
  EVENT_START_MIGRATION_SENTINEL,
  GUEST_READ_SURFACES_UNAVAILABLE_MESSAGE,
} from '../../shared/rsvp';
import type { MessageCursor } from '../http/message-cursor';
import { constantTimeEqual } from '../security/crypto';
import type { FeedItem, MessageRecord } from './types';

// Mirrors `resolveGuestEventPhase` at the write fence. The route supplies the
// user-facing refusal, while this predicate keeps a boundary/settings race from
// admitting a note after that projection became unavailable.
const GUEST_READ_SURFACES_AVAILABLE_SQL = `(
  (
    (e.event_start_at = ? OR julianday(e.event_start_at) IS NULL)
    AND NOT (
      e.uploads_enabled = 0
      AND e.rsvp_enabled = 1
      AND e.rsvp_deadline_at IS NOT NULL
      AND julianday(e.rsvp_deadline_at) IS NOT NULL
      AND e.rsvp_deadline_at >= ?
    )
  )
  OR (
    e.event_start_at <> ?
    AND julianday(e.event_start_at) IS NOT NULL
    AND COALESCE(e.photos_open_from, e.event_start_at) <= ?
  )
)`;

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

interface PurgeReceiptRow {
  request_hmac: string;
}

function mapManagerMessage(row: Pick<
  MessageRow,
  'id' | 'guest_name' | 'body' | 'moderation_status' | 'created_at' | 'deleted_at'
>): ManagerGuestbookItem {
  if (row.deleted_at) {
    return {
      id: row.id,
      source: 'guest_note',
      guestName: row.guest_name,
      body: row.body,
      createdAt: row.created_at,
      state: 'deleted',
      visibility: 'host_only',
    };
  }
  return {
    id: row.id,
    source: 'guest_note',
    guestName: row.guest_name,
    body: row.body,
    createdAt: row.created_at,
    state: row.moderation_status,
    visibility: row.moderation_status === 'approved' ? 'shared' : 'author_only',
  };
}

export interface CreateMessageRecord {
  id: string;
  eventId: string;
  guestSessionId: string;
  guestName: string | null;
  body: string;
  idempotencyKey: string;
  createdAt: string;
  sessionScopeDigest: string;
  ipScopeDigest: string;
  windowStartedAt: string;
  requestHmac: string;
}

export interface CreateMessageResult {
  message: MessageRecord;
  replayed: boolean;
}

export interface MessageFeedPage {
  items: FeedItem[];
  nextCursor: MessageCursor | null;
}

export type GuestMessageState = ModerationStatus | 'deleted';
export type GuestMessageStateAction = 'approve' | 'reject' | 'delete' | 'restore';

export class MessagesRepository {
  constructor(private readonly db: D1Database) {}

  async createBounded(input: CreateMessageRecord): Promise<CreateMessageResult> {
    const results = await this.db.batch([
      this.db.prepare(`
      INSERT INTO guest_messages (
        id, event_id, guest_session_id, guest_name, body, moderation_status,
        idempotency_key, created_at, approved_at
      )
      SELECT ?, e.id, ?, ?, ?,
        CASE WHEN e.moderation_required = 1 THEN 'pending' ELSE 'approved' END,
        ?, ?, CASE WHEN e.moderation_required = 1 THEN NULL ELSE ? END
      FROM events e
      WHERE e.id = ? AND e.deleted_at IS NULL
        AND ${GUEST_READ_SURFACES_AVAILABLE_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM guest_message_purge_receipts r
          WHERE r.event_id = e.id AND r.guest_session_id = ? AND r.idempotency_key = ?
        )
        AND (
        SELECT COUNT(*) FROM guest_message_rate_events
        WHERE event_id = ? AND session_scope_digest = ? AND window_started_at = ?
      ) < ? AND (
        SELECT COUNT(*) FROM guest_message_rate_events
        WHERE event_id = ? AND ip_scope_digest = ? AND window_started_at = ?
      ) < ? AND (
        SELECT COUNT(*) FROM guest_messages WHERE event_id = e.id
      ) < ?
      ON CONFLICT (event_id, guest_session_id, idempotency_key) DO NOTHING
    `).bind(
      input.id,
      input.guestSessionId,
      input.guestName,
      input.body,
      input.idempotencyKey,
      input.createdAt,
      input.createdAt,
      input.eventId,
      EVENT_START_MIGRATION_SENTINEL,
      input.createdAt,
      EVENT_START_MIGRATION_SENTINEL,
      input.createdAt,
      input.guestSessionId,
      input.idempotencyKey,
      input.eventId,
      input.sessionScopeDigest,
      input.windowStartedAt,
      MAX_GUEST_NOTES_PER_SESSION_WINDOW,
      input.eventId,
      input.ipScopeDigest,
      input.windowStartedAt,
      MAX_GUEST_NOTES_PER_IP_WINDOW,
      MAX_EVENT_GUEST_NOTES,
      ),
      this.db.prepare(`
        INSERT INTO guest_message_rate_events (
          id, event_id, session_scope_digest, ip_scope_digest, window_started_at, created_at
        )
        SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1
      `).bind(
        crypto.randomUUID(),
        input.eventId,
        input.sessionScopeDigest,
        input.ipScopeDigest,
        input.windowStartedAt,
        input.createdAt,
      ),
    ]);
    const inserted = results[0];
    if (!inserted) throw new Error('Guest note reservation batch returned no insert result.');
    if ((inserted.meta.changes ?? 0) === 1) {
      return { message: (await this.getById(input.id))!, replayed: false };
    }

    const guards = await this.db.prepare(`
      SELECT
        EXISTS (
          SELECT 1 FROM events e WHERE e.id = ? AND e.deleted_at IS NULL
            AND ${GUEST_READ_SURFACES_AVAILABLE_SQL}
        ) AS phase_open,
        (SELECT COUNT(*) FROM guest_message_rate_events
          WHERE event_id = ? AND session_scope_digest = ? AND window_started_at = ?) AS session_count,
        (SELECT COUNT(*) FROM guest_message_rate_events
          WHERE event_id = ? AND ip_scope_digest = ? AND window_started_at = ?) AS ip_count,
        (SELECT COUNT(*) FROM guest_messages WHERE event_id = ?) AS event_count
    `).bind(
      input.eventId,
      EVENT_START_MIGRATION_SENTINEL,
      input.createdAt,
      EVENT_START_MIGRATION_SENTINEL,
      input.createdAt,
      input.eventId, input.sessionScopeDigest, input.windowStartedAt,
      input.eventId, input.ipScopeDigest, input.windowStartedAt,
      input.eventId,
    ).first<{
      phase_open: number;
      session_count: number;
      ip_count: number;
      event_count: number;
    }>();
    // The current lifecycle owns every idempotency outcome. A route snapshot
    // cannot replay either a retained note or its purge tombstone after the
    // Manager has returned photo sharing to a future boundary.
    if (guards?.phase_open !== 1) {
      throw new ApiError('EVENT_PHASE_CONFLICT', GUEST_READ_SURFACES_UNAVAILABLE_MESSAGE, 409);
    }

    const existing = await this.db.prepare(`
      SELECT * FROM guest_messages
      WHERE event_id = ? AND guest_session_id = ? AND idempotency_key = ?
    `).bind(input.eventId, input.guestSessionId, input.idempotencyKey).first<MessageRow>();
    if (existing) {
      if (existing.guest_name !== input.guestName || existing.body !== input.body) {
        throw new ApiError(
          'MESSAGE_SUBMISSION_CONFLICT',
          'This note changed after an earlier send attempt. Send it again.',
          409,
        );
      }
      return { message: mapMessage(existing), replayed: true };
    }

    const receipt = await this.db.prepare(`
      SELECT request_hmac FROM guest_message_purge_receipts
      WHERE event_id = ? AND guest_session_id = ? AND idempotency_key = ?
    `).bind(
      input.eventId, input.guestSessionId, input.idempotencyKey,
    ).first<PurgeReceiptRow>();
    if (receipt) {
      if (!constantTimeEqual(receipt.request_hmac, input.requestHmac)) {
        throw new ApiError(
          'MESSAGE_SUBMISSION_CONFLICT',
          'This note changed after an earlier send attempt. Send it again.',
          409,
        );
      }
      throw new ApiError('MESSAGE_PURGED', 'This note was permanently deleted and cannot be restored.', 410);
    }

    if ((guards.session_count ?? 0) >= MAX_GUEST_NOTES_PER_SESSION_WINDOW
      || (guards.ip_count ?? 0) >= MAX_GUEST_NOTES_PER_IP_WINDOW) {
      throw new ApiError('RATE_LIMITED', 'Too many notes were sent in this window. Try again later.', 429);
    }
    if ((guards.event_count ?? 0) >= MAX_EVENT_GUEST_NOTES) {
      throw new ApiError('MESSAGE_EVENT_LIMIT', 'This guestbook is not accepting more notes.', 409);
    }
    throw new Error('Guarded guest note insert did not create a row.');
  }

  async getById(id: string): Promise<MessageRecord | null> {
    const row = await this.db.prepare('SELECT * FROM guest_messages WHERE id = ?').bind(id).first<MessageRow>();
    return row ? mapMessage(row) : null;
  }

  async listForManager(eventId: string, status?: ModerationStatus): Promise<ManagerGuestbookItem[]> {
    const result = status
      ? await this.db.prepare(`
          SELECT id, guest_name, body, moderation_status, created_at, deleted_at FROM guest_messages
          WHERE event_id = ? AND moderation_status = ? AND deleted_at IS NULL
          ORDER BY created_at ASC
        `).bind(eventId, status).all<MessageRow>()
      : await this.db.prepare(`
          SELECT id, guest_name, body, moderation_status, created_at, deleted_at
          FROM guest_messages WHERE event_id = ? AND deleted_at IS NULL ORDER BY created_at ASC
        `).bind(eventId).all<MessageRow>();
    return result.results.map(mapManagerMessage);
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
        SELECT media.id, 'caption' AS kind, media.guest_name, trim(media.caption) AS body,
          CASE
            WHEN media.publication_status = 'published' AND events.gallery_visible = 1 THEN 'approved'
            WHEN media.publication_status = 'unpublished' THEN 'pending'
            ELSE 'rejected'
          END AS moderation_status,
          media.created_at, media.id AS media_id
        FROM media
        JOIN events ON events.id = media.event_id
        WHERE media.event_id = ? AND media.upload_state = 'stored' AND media.deleted_at IS NULL
          AND media.caption IS NOT NULL AND length(trim(media.caption)) > 0
          AND (
            (media.publication_status = 'published' AND events.gallery_visible = 1)
            OR media.uploader_session_id = ?
          )
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
        ? { version: 1, createdAt: oldest.created_at, id: oldest.id }
        : null,
    };
  }

  async changeState(
    id: string,
    eventId: string,
    expected: GuestMessageState,
    action: GuestMessageStateAction,
    changedAt: string,
  ): Promise<MessageRecord> {
    const target = action === 'approve' ? 'approved' : 'rejected';
    const statement = action === 'restore'
      ? this.db.prepare(`
          UPDATE guest_messages
          SET moderation_status = 'rejected', approved_at = NULL, deleted_at = NULL
          WHERE id = ? AND event_id = ? AND deleted_at IS NOT NULL AND ? = 'deleted'
        `).bind(id, eventId, expected)
      : action === 'delete'
        ? this.db.prepare(`
            UPDATE guest_messages SET deleted_at = ?
            WHERE id = ? AND event_id = ? AND deleted_at IS NULL AND moderation_status = ?
          `).bind(changedAt, id, eventId, expected)
        : this.db.prepare(`
            UPDATE guest_messages SET moderation_status = ?, approved_at = ?
            WHERE id = ? AND event_id = ? AND deleted_at IS NULL AND moderation_status = ?
          `).bind(target, target === 'approved' ? changedAt : null, id, eventId, expected);
    const result = await statement.run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ApiError(
        'MESSAGE_STATE_CONFLICT',
        'This note changed since you last viewed it. Refresh and try again.',
        409,
      );
    }
    return (await this.getById(id))!;
  }

  async purgeDeleted(
    id: string,
    eventId: string,
    expected: GuestMessageState,
    requestHmac: string,
    purgedAt: string,
  ): Promise<{ source: 'guest_note'; id: string }> {
    const results = await this.db.batch([
      this.db.prepare(`
        INSERT INTO guest_message_purge_receipts (
          event_id, guest_session_id, idempotency_key, request_hmac, purged_at
        )
        SELECT event_id, guest_session_id, idempotency_key, ?, ?
        FROM guest_messages
        WHERE id = ? AND event_id = ? AND deleted_at IS NOT NULL
          AND ? = 'deleted' AND idempotency_key IS NOT NULL
        ON CONFLICT (event_id, guest_session_id, idempotency_key) DO NOTHING
      `).bind(requestHmac, purgedAt, id, eventId, expected),
      this.db.prepare(`
        DELETE FROM guest_messages
        WHERE id = ? AND event_id = ? AND deleted_at IS NOT NULL AND ? = 'deleted'
          AND (
            idempotency_key IS NULL OR EXISTS (
              SELECT 1 FROM guest_message_purge_receipts r
              WHERE r.event_id = guest_messages.event_id
                AND r.guest_session_id = guest_messages.guest_session_id
                AND r.idempotency_key = guest_messages.idempotency_key
                AND r.request_hmac = ?
            )
          )
      `).bind(id, eventId, expected, requestHmac),
    ]);
    const deleted = results[1];
    if (!deleted) throw new Error('Guest note purge batch returned no delete result.');
    if ((deleted.meta.changes ?? 0) !== 1) {
      throw new ApiError(
        'MESSAGE_STATE_CONFLICT',
        'This note changed since you last viewed it. Refresh and try again.',
        409,
      );
    }
    return { source: 'guest_note', id };
  }
}

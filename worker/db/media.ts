import type { ModerationStatus } from '../../shared/contracts';
import { MAX_EVENT_BYTES, MAX_EVENT_MEDIA, type SupportedImageType } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { MediaRecord } from './types';

interface MediaRow {
  id: string;
  event_id: string;
  uploader_session_id: string;
  object_key: string;
  original_filename: string;
  mime_type: SupportedImageType;
  declared_byte_size: number;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  guest_name: string | null;
  caption: string | null;
  upload_state: MediaRecord['uploadState'];
  moderation_status: ModerationStatus;
  idempotency_key: string;
  reservation_expires_at: string;
  created_at: string;
  approved_at: string | null;
  deleted_at: string | null;
}

export interface ReserveMediaRecord {
  id: string;
  eventId: string;
  uploaderSessionId: string;
  objectKey: string;
  originalFilename: string;
  mimeType: SupportedImageType;
  declaredByteSize: number;
  guestName: string | null;
  caption: string | null;
  idempotencyKey: string;
  reservationExpiresAt: string;
  createdAt: string;
}

function mapMedia(row: MediaRow): MediaRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    uploaderSessionId: row.uploader_session_id,
    objectKey: row.object_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    declaredByteSize: row.declared_byte_size,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    guestName: row.guest_name,
    caption: row.caption,
    uploadState: row.upload_state,
    moderationStatus: row.moderation_status,
    idempotencyKey: row.idempotency_key,
    reservationExpiresAt: row.reservation_expires_at,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    deletedAt: row.deleted_at,
  };
}

export class MediaRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<MediaRecord | null> {
    const row = await this.db.prepare('SELECT * FROM media WHERE id = ?').bind(id).first<MediaRow>();
    return row ? mapMedia(row) : null;
  }

  async listForManager(eventId: string, status?: ModerationStatus): Promise<MediaRecord[]> {
    const result = status
      ? await this.db.prepare(`
          SELECT * FROM media
          WHERE event_id = ? AND upload_state = 'stored' AND deleted_at IS NULL AND moderation_status = ?
          ORDER BY created_at ASC
        `).bind(eventId, status).all<MediaRow>()
      : await this.db.prepare(`
          SELECT * FROM media
          WHERE event_id = ? AND upload_state = 'stored' AND deleted_at IS NULL
          ORDER BY created_at ASC
        `).bind(eventId).all<MediaRow>();
    return result.results.map(mapMedia);
  }

  async listGallery(eventId: string): Promise<MediaRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND moderation_status = 'approved' AND deleted_at IS NULL
      ORDER BY approved_at ASC, created_at ASC
    `).bind(eventId).all<MediaRow>();
    return result.results.map(mapMedia);
  }

  async exportSnapshot(eventId: string, snapshotAt: string): Promise<MediaRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND moderation_status = 'approved'
        AND deleted_at IS NULL AND approved_at <= ? AND created_at <= ?
      ORDER BY approved_at ASC, created_at ASC, id ASC
    `).bind(eventId, snapshotAt, snapshotAt).all<MediaRow>();
    return result.results.map(mapMedia);
  }

  async listExpiredReservations(now: string, limit = 100): Promise<MediaRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM media WHERE upload_state = 'reserved' AND reservation_expires_at <= ?
      ORDER BY reservation_expires_at ASC LIMIT ?
    `).bind(now, limit).all<MediaRow>();
    return result.results.map(mapMedia);
  }

  async listContributions(eventId: string, sessionId: string): Promise<MediaRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM media
      WHERE event_id = ? AND uploader_session_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC
    `).bind(eventId, sessionId).all<MediaRow>();
    return result.results.map(mapMedia);
  }

  private async getIdempotent(input: ReserveMediaRecord): Promise<MediaRecord | null> {
    const row = await this.db.prepare(`
      SELECT * FROM media WHERE event_id = ? AND uploader_session_id = ? AND idempotency_key = ?
    `).bind(input.eventId, input.uploaderSessionId, input.idempotencyKey).first<MediaRow>();
    if (!row) return null;
    if (row.mime_type !== input.mimeType || row.declared_byte_size !== input.declaredByteSize) {
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload key was already used for different file metadata.', 409);
    }
    return mapMedia(row);
  }

  async reserve(input: ReserveMediaRecord): Promise<MediaRecord> {
    const existing = await this.getIdempotent(input);
    if (existing) return existing;

    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db.prepare(`
          UPDATE events
          SET reserved_media_count = reserved_media_count + 1,
              reserved_bytes = reserved_bytes + ?
          WHERE id = ?
            AND deleted_at IS NULL
            AND uploads_enabled = 1
            AND reserved_media_count + stored_media_count < ?
            AND reserved_bytes + stored_bytes + ? <= ?
        `).bind(input.declaredByteSize, input.eventId, MAX_EVENT_MEDIA, input.declaredByteSize, MAX_EVENT_BYTES),
        this.db.prepare(`
          INSERT INTO media (
            id, event_id, uploader_session_id, object_key, original_filename, mime_type,
            declared_byte_size, guest_name, caption, upload_state, moderation_status,
            idempotency_key, reservation_expires_at, created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'pending', ?, ?, ?
          WHERE changes() = 1
        `).bind(
          input.id,
          input.eventId,
          input.uploaderSessionId,
          input.objectKey,
          input.originalFilename,
          input.mimeType,
          input.declaredByteSize,
          input.guestName,
          input.caption,
          input.idempotencyKey,
          input.reservationExpiresAt,
          input.createdAt,
        ),
      ]);
    } catch (error) {
      const raced = await this.getIdempotent(input);
      if (raced) return raced;
      throw error;
    }

    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const event = await this.db.prepare(`
        SELECT reserved_media_count, stored_media_count, reserved_bytes, stored_bytes
        FROM events WHERE id = ?
      `).bind(input.eventId).first<{
        reserved_media_count: number;
        stored_media_count: number;
        reserved_bytes: number;
        stored_bytes: number;
      }>();
      if (event && event.reserved_media_count + event.stored_media_count >= MAX_EVENT_MEDIA) {
        throw new ApiError('EVENT_MEDIA_LIMIT', `This event has reached its ${MAX_EVENT_MEDIA}-image limit.`, 409);
      }
      throw new ApiError('EVENT_STORAGE_LIMIT', 'This event has reached its 300 MB storage limit.', 409);
    }

    const created = await this.getById(input.id);
    if (!created) throw new Error('Reserved media row was not created.');
    return created;
  }

  async finalize(
    id: string,
    metadata: { byteSize: number; width: number; height: number },
    moderationRequired: boolean,
  ): Promise<MediaRecord> {
    const current = await this.getById(id);
    if (!current) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The upload reservation no longer exists.', 404);
    if (current.uploadState === 'stored') {
      if (
        current.byteSize === metadata.byteSize
        && current.width === metadata.width
        && current.height === metadata.height
      ) return current;
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload was already finalized with different metadata.', 409);
    }
    if (current.uploadState !== 'reserved') {
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload can no longer be finalized.', 409);
    }

    const finalizedAt = new Date().toISOString();
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media
        SET byte_size = ?, width = ?, height = ?, upload_state = 'stored',
            moderation_status = ?, approved_at = ?
        WHERE id = ? AND upload_state = 'reserved'
      `).bind(
        metadata.byteSize,
        metadata.width,
        metadata.height,
        moderationRequired ? 'pending' : 'approved',
        moderationRequired ? null : finalizedAt,
        id,
      ),
      this.db.prepare(`
        UPDATE events
        SET reserved_media_count = reserved_media_count - 1,
            reserved_bytes = reserved_bytes - ?,
            stored_media_count = stored_media_count + 1,
            stored_bytes = stored_bytes + ?
        WHERE id = ? AND changes() = 1
      `).bind(current.declaredByteSize, metadata.byteSize, current.eventId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return this.finalize(id, metadata, moderationRequired);
    return (await this.getById(id))!;
  }

  async moderate(
    id: string,
    expected: ModerationStatus,
    target: ModerationStatus,
    changedAt: string,
  ): Promise<MediaRecord> {
    const result = await this.db.prepare(`
      UPDATE media SET moderation_status = ?, approved_at = ?
      WHERE id = ? AND upload_state = 'stored' AND moderation_status = ? AND deleted_at IS NULL
    `).bind(target, target === 'approved' ? changedAt : null, id, expected).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo changed since you last viewed it. Refresh and try again.', 409);
    }
    return (await this.getById(id))!;
  }

  async failReservation(id: string): Promise<MediaRecord> {
    const current = await this.getById(id);
    if (!current) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The upload reservation no longer exists.', 404);
    if (current.uploadState !== 'reserved') return current;
    const results = await this.db.batch([
      this.db.prepare("UPDATE media SET upload_state = 'failed' WHERE id = ? AND upload_state = 'reserved'").bind(id),
      this.db.prepare(`
        UPDATE events
        SET reserved_media_count = reserved_media_count - 1,
            reserved_bytes = reserved_bytes - ?
        WHERE id = ? AND changes() = 1
      `).bind(current.declaredByteSize, current.eventId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return (await this.getById(id))!;
    return (await this.getById(id))!;
  }

  async delete(id: string, deletedAt: string): Promise<MediaRecord> {
    const current = await this.getById(id);
    if (!current) throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo no longer exists.', 404);
    if (current.uploadState === 'deleted') return current;

    const counterType = current.uploadState;
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media SET upload_state = 'deleted', deleted_at = ?
        WHERE id = ? AND upload_state = ? AND deleted_at IS NULL
      `).bind(deletedAt, id, counterType),
      this.db.prepare(`
        UPDATE events SET
          reserved_media_count = reserved_media_count - ?,
          reserved_bytes = reserved_bytes - ?,
          stored_media_count = stored_media_count - ?,
          stored_bytes = stored_bytes - ?
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM media WHERE id = ? AND deleted_at = ?)
      `).bind(
        counterType === 'reserved' ? 1 : 0,
        counterType === 'reserved' ? current.declaredByteSize : 0,
        counterType === 'stored' ? 1 : 0,
        counterType === 'stored' ? current.byteSize ?? 0 : 0,
        current.eventId,
        id,
        deletedAt,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) return (await this.getById(id))!;
    return (await this.getById(id))!;
  }
}

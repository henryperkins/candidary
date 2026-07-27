import type { PublicationStatus } from '../../shared/contracts';
import {
  MANAGER_MEDIA_PAGE_SIZE,
  MAX_EVENT_BYTES,
  MAX_EVENT_MEDIA,
  type SupportedImageType,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { ManagerMediaCursor } from '../http/media-cursor';
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
  guest_name: string;
  caption: string | null;
  upload_state: MediaRecord['uploadState'];
  publication_status: PublicationStatus;
  idempotency_key: string;
  reservation_expires_at: string;
  created_at: string;
  stored_at: string | null;
  published_at: string | null;
  preview_object_key: string | null;
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
  guestName: string;
  caption: string | null;
  idempotencyKey: string;
  reservationExpiresAt: string;
  createdAt: string;
}

export type ReserveMediaBatchResult =
  | { status: 'accepted'; media: MediaRecord }
  | { status: 'rejected'; error: ApiError };

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
    publicationStatus: row.publication_status,
    idempotencyKey: row.idempotency_key,
    reservationExpiresAt: row.reservation_expires_at,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    previewObjectKey: row.preview_object_key,
    deletedAt: row.deleted_at,
  };
}

export interface ManagerMediaOptions {
  status?: PublicationStatus;
  guestName?: string;
  cursor?: ManagerMediaCursor;
  limit?: number;
}

export interface ManagerMediaPage {
  media: MediaRecord[];
  nextCursor: ManagerMediaCursor | null;
}

/**
 * Keyset page over the manager intake. Every predicate is a bound parameter and
 * `event_id` is always the first one, so a caller-supplied cursor can only move
 * the position inside the event the session is already authorized for.
 * Fetches `limit + 1` rows so the caller can tell whether another page exists.
 */
export function buildManagerMediaQuery(
  eventId: string,
  options: ManagerMediaOptions = {},
): { sql: string; bindings: unknown[] } {
  const limit = options.limit ?? MANAGER_MEDIA_PAGE_SIZE;
  const predicates = [
    'event_id = ?',
    "upload_state = 'stored'",
    'stored_at IS NOT NULL',
    'deleted_at IS NULL',
  ];
  const bindings: unknown[] = [eventId];

  if (options.status) {
    predicates.push('publication_status = ?');
    bindings.push(options.status);
  }
  const guestName = options.guestName?.trim();
  if (guestName) {
    predicates.push("guest_name LIKE '%' || ? || '%' COLLATE NOCASE");
    bindings.push(guestName);
  }
  if (options.cursor) {
    predicates.push('(stored_at < ? OR (stored_at = ? AND id < ?))');
    bindings.push(options.cursor.storedAt, options.cursor.storedAt, options.cursor.id);
  }
  bindings.push(limit + 1);

  return {
    sql: `
      SELECT * FROM media
      WHERE ${predicates.join(' AND ')}
      ORDER BY stored_at DESC, id DESC
      LIMIT ?
    `,
    bindings,
  };
}

export class MediaRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<MediaRecord | null> {
    const row = await this.db.prepare('SELECT * FROM media WHERE id = ?').bind(id).first<MediaRow>();
    return row ? mapMedia(row) : null;
  }

  async listForManager(eventId: string, options: ManagerMediaOptions = {}): Promise<ManagerMediaPage> {
    const limit = options.limit ?? MANAGER_MEDIA_PAGE_SIZE;
    const query = buildManagerMediaQuery(eventId, { ...options, limit });
    // One extra row tells us whether another page exists without a second query.
    const result = await this.db.prepare(query.sql).bind(...query.bindings).all<MediaRow>();
    const pageRows = result.results.slice(0, limit);
    const media = pageRows.map(mapMedia);
    const last = pageRows[pageRows.length - 1];
    const hasMore = result.results.length > limit;
    return {
      media,
      nextCursor: hasMore && last?.stored_at
        ? { storedAt: last.stored_at, id: last.id }
        : null,
    };
  }

  async listGallery(eventId: string): Promise<MediaRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM media
      WHERE event_id = ? AND upload_state = 'stored' AND publication_status = 'published' AND deleted_at IS NULL
      ORDER BY published_at ASC, created_at ASC
    `).bind(eventId).all<MediaRow>();
    return result.results.map(mapMedia);
  }

  async exportSnapshot(eventId: string, snapshotAt: string): Promise<MediaRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM media
      WHERE event_id = ? AND upload_state = 'stored'
        AND deleted_at IS NULL AND created_at <= ?
      ORDER BY created_at ASC, id ASC
    `).bind(eventId, snapshotAt).all<MediaRow>();
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

  private async capacityError(eventId: string): Promise<ApiError> {
    const event = await this.db.prepare(`
      SELECT reserved_media_count, stored_media_count, reserved_bytes, stored_bytes
      FROM events WHERE id = ?
    `).bind(eventId).first<{
      reserved_media_count: number;
      stored_media_count: number;
      reserved_bytes: number;
      stored_bytes: number;
    }>();
    if (event && event.reserved_media_count + event.stored_media_count >= MAX_EVENT_MEDIA) {
      return new ApiError('EVENT_MEDIA_LIMIT', `This event has reached its ${MAX_EVENT_MEDIA}-image limit.`, 409);
    }
    return new ApiError('EVENT_STORAGE_LIMIT', 'This event has reached its storage limit.', 409);
  }

  private async refreshIdempotent(input: ReserveMediaRecord, existing: MediaRecord): Promise<MediaRecord> {
    if (existing.uploadState === 'stored') return existing;
    if (existing.uploadState === 'deleted') {
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This photo was removed. Choose it again.', 409);
    }

    if (existing.uploadState === 'reserved') {
      await this.db.prepare(`
        UPDATE media
        SET reservation_expires_at = ?, guest_name = ?, caption = ?
        WHERE id = ? AND upload_state = 'reserved' AND reservation_expires_at < ?
      `).bind(
        input.reservationExpiresAt,
        input.guestName,
        input.caption,
        existing.id,
        input.reservationExpiresAt,
      ).run();
      return (await this.getById(existing.id))!;
    }

    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media
        SET upload_state = 'reserved', reservation_expires_at = ?,
            guest_name = ?, caption = ?, original_filename = ?
        WHERE id = ? AND upload_state = 'failed'
          AND EXISTS (
            SELECT 1 FROM events
            WHERE id = ? AND deleted_at IS NULL AND uploads_enabled = 1
              AND reserved_media_count + stored_media_count < ?
              AND reserved_bytes + stored_bytes + ? <= ?
          )
      `).bind(
        input.reservationExpiresAt,
        input.guestName,
        input.caption,
        input.originalFilename,
        existing.id,
        input.eventId,
        MAX_EVENT_MEDIA,
        input.declaredByteSize,
        MAX_EVENT_BYTES,
      ),
      this.db.prepare(`
        UPDATE events
        SET reserved_media_count = reserved_media_count + 1,
            reserved_bytes = reserved_bytes + ?
        WHERE id = ? AND changes() = 1
      `).bind(input.declaredByteSize, input.eventId),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 1) return (await this.getById(existing.id))!;

    const raced = await this.getById(existing.id);
    if (raced && raced.uploadState !== 'failed') return this.refreshIdempotent(input, raced);
    throw await this.capacityError(input.eventId);
  }

  async reserve(input: ReserveMediaRecord): Promise<MediaRecord> {
    if (!input.guestName || input.guestName.trim().length < 1 || input.guestName.trim().length > 80) {
      throw new ApiError('VALIDATION_FAILED', 'Enter your name before adding photos.', 422, {
        guestName: 'Your name is required.',
      });
    }
    input = { ...input, guestName: input.guestName.trim() };
    const existing = await this.getIdempotent(input);
    if (existing) return this.refreshIdempotent(input, existing);

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
            declared_byte_size, guest_name, caption, upload_state, publication_status,
            idempotency_key, reservation_expires_at, created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'unpublished', ?, ?, ?
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
      throw await this.capacityError(input.eventId);
    }

    const created = await this.getById(input.id);
    if (!created) throw new Error('Reserved media row was not created.');
    return created;
  }

  async reserveBatch(inputs: readonly ReserveMediaRecord[]): Promise<ReserveMediaBatchResult[]> {
    if (inputs.length === 0) return [];
    const eventId = inputs[0]!.eventId;
    if (inputs.some((input) => input.eventId !== eventId)) {
      throw new ApiError('VALIDATION_FAILED', 'Every photo in a batch must belong to the same event.', 422);
    }

    const results: Array<ReserveMediaBatchResult | undefined> = new Array(inputs.length);
    const pending: Array<{ index: number; input: ReserveMediaRecord }> = [];
    for (const [index, rawInput] of inputs.entries()) {
      if (!rawInput.guestName || rawInput.guestName.trim().length < 1 || rawInput.guestName.trim().length > 80) {
        results[index] = {
          status: 'rejected',
          error: new ApiError('VALIDATION_FAILED', 'Enter your name before adding photos.', 422, {
            guestName: 'Your name is required.',
          }),
        };
        continue;
      }
      const input = { ...rawInput, guestName: rawInput.guestName.trim() };
      try {
        const existing = await this.getIdempotent(input);
        if (existing) {
          results[index] = { status: 'accepted', media: await this.refreshIdempotent(input, existing) };
        } else {
          pending.push({ index, input });
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        results[index] = { status: 'rejected', error };
      }
    }

    if (pending.length > 0) {
      const event = await this.db.prepare(`
        SELECT reserved_media_count, stored_media_count, reserved_bytes, stored_bytes
        FROM events WHERE id = ? AND deleted_at IS NULL AND uploads_enabled = 1
      `).bind(eventId).first<{
        reserved_media_count: number;
        stored_media_count: number;
        reserved_bytes: number;
        stored_bytes: number;
      }>();
      let usedCount = (event?.reserved_media_count ?? MAX_EVENT_MEDIA) + (event?.stored_media_count ?? 0);
      let usedBytes = (event?.reserved_bytes ?? MAX_EVENT_BYTES) + (event?.stored_bytes ?? 0);
      let capacityError: ApiError | null = null;
      const accepted: Array<{ index: number; input: ReserveMediaRecord }> = [];
      for (const candidate of pending) {
        if (!capacityError && usedCount + 1 > MAX_EVENT_MEDIA) {
          capacityError = new ApiError('EVENT_MEDIA_LIMIT', `This event has reached its ${MAX_EVENT_MEDIA}-image limit.`, 409);
        }
        if (!capacityError && usedBytes + candidate.input.declaredByteSize > MAX_EVENT_BYTES) {
          capacityError = new ApiError('EVENT_STORAGE_LIMIT', 'This event has reached its storage limit.', 409);
        }
        if (capacityError) {
          results[candidate.index] = { status: 'rejected', error: capacityError };
          continue;
        }
        accepted.push(candidate);
        usedCount += 1;
        usedBytes += candidate.input.declaredByteSize;
      }

      if (accepted.length > 0) {
        const totalBytes = accepted.reduce((sum, { input }) => sum + input.declaredByteSize, 0);
        let writes: D1Result[] | null = null;
        try {
          writes = await this.db.batch([
            this.db.prepare(`
              UPDATE events
              SET reserved_media_count = reserved_media_count + ?,
                  reserved_bytes = reserved_bytes + ?
              WHERE id = ? AND deleted_at IS NULL AND uploads_enabled = 1
                AND reserved_media_count + stored_media_count + ? <= ?
                AND reserved_bytes + stored_bytes + ? <= ?
            `).bind(accepted.length, totalBytes, eventId, accepted.length, MAX_EVENT_MEDIA, totalBytes, MAX_EVENT_BYTES),
            ...accepted.map(({ input }) => this.db.prepare(`
              INSERT INTO media (
                id, event_id, uploader_session_id, object_key, original_filename, mime_type,
                declared_byte_size, guest_name, caption, upload_state, publication_status,
                idempotency_key, reservation_expires_at, created_at
              )
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 'unpublished', ?, ?, ?
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
            )),
          ]);
        } catch {
          // A concurrent idempotent request can win the unique key race. The
          // per-item fallback below resolves that row without duplicating it.
        }

        if ((writes?.[0]?.meta.changes ?? 0) === 1) {
          for (const candidate of accepted) {
            const media = await this.getById(candidate.input.id);
            if (!media) throw new Error('Reserved media batch row was not created.');
            results[candidate.index] = { status: 'accepted', media };
          }
        } else {
          for (const candidate of accepted) {
            try {
              results[candidate.index] = { status: 'accepted', media: await this.reserve(candidate.input) };
            } catch (error) {
              if (!(error instanceof ApiError)) throw error;
              results[candidate.index] = { status: 'rejected', error };
            }
          }
        }
      }
    }

    return results.map((result) => result ?? {
      status: 'rejected',
      error: new ApiError('INTERNAL_ERROR', 'This photo could not be reserved.', 500),
    });
  }

  async finalize(
    id: string,
    metadata: { byteSize: number; width: number; height: number },
    storedAt = new Date().toISOString(),
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

    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media
        SET byte_size = ?, width = ?, height = ?, upload_state = 'stored', stored_at = ?
        WHERE id = ? AND upload_state = 'reserved'
      `).bind(
        metadata.byteSize,
        metadata.width,
        metadata.height,
        storedAt,
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
    if ((results[0]?.meta.changes ?? 0) !== 1) return this.finalize(id, metadata);
    return (await this.getById(id))!;
  }

  async setPublication(
    id: string,
    expected: PublicationStatus,
    target: PublicationStatus,
    changedAt: string,
  ): Promise<MediaRecord> {
    const result = await this.db.prepare(`
      UPDATE media SET publication_status = ?, published_at = ?
      WHERE id = ? AND upload_state = 'stored' AND publication_status = ? AND deleted_at IS NULL
    `).bind(target, target === 'published' ? changedAt : null, id, expected).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo changed since you last viewed it. Refresh and try again.', 409);
    }
    return (await this.getById(id))!;
  }

  async setPreviewObjectKey(id: string, previewObjectKey: string): Promise<MediaRecord> {
    const result = await this.db.prepare(`
      UPDATE media SET preview_object_key = ?
      WHERE id = ? AND upload_state = 'stored' AND deleted_at IS NULL
    `).bind(previewObjectKey, id).run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo is no longer available.', 409);
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

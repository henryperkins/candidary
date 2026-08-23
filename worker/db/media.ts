import type {
  ManagerGalleryMediaView,
  ManagerMediaView,
  PublicationStatus,
} from '../../shared/contracts';
import {
  ALBUM_MAX_ENTRIES,
  MANAGER_MEDIA_PAGE_SIZE,
  MAX_EVENT_BYTES,
  MAX_EVENT_MEDIA,
  MEDIA_TIMELINE_SENTINEL,
  DEFAULT_GALLERY_TIMELINE_ORDER,
  type GalleryTimelineOrder,
  PRIVATE_GALLERY_PAGE_SIZE,
  type SupportedImageType,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { GalleryCursor } from '../http/gallery-cursor';
import type { ManagerMediaCursor } from '../http/media-cursor';
import type { MediaRecord } from './types';
import { MediaObjectWriteTombstoneRepository } from './media-write-tombstones';
import {
  assertLegacyPointerCutoverEnabled,
  assertWorkerIngressEnabled,
} from '../media-upload-release';

export interface MediaRow {
  id: string;
  event_id: string;
  uploader_session_id: string;
  object_key: string;
  object_bucket_generation: 'legacy' | 'canonical';
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
  captured_at: string | null;
  timeline_at: string;
  favorited_at: string | null;
  published_at: string | null;
  preview_object_key: string | null;
  deleted_at: string | null;
}

/**
 * Photo delivery is open for this event *right now*.
 *
 * Since 0010 `uploads_enabled` is capability rather than an open door — a new
 * event carries it from creation — so the scheduled opening has to be part of
 * the same guarded write. The route checks it too, but only this is a boundary:
 * a pause landing between the read and the reservation must not be able to slip
 * a photo through. Binds one value, the request's own instant.
 */
const PHOTO_INTAKE_OPEN_SQL
  = 'uploads_enabled = 1 AND COALESCE(photos_open_from, event_start_at) <= ?';

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

export type MediaObjectPromotionState =
  | 'pending'
  | 'copying'
  | 'target_verified'
  | 'cleanup_pending';

interface MediaObjectPromotionRow {
  media_id: string;
  event_id: string;
  source_bucket_generation: 'legacy';
  source_object_key: string;
  final_bucket_generation: 'canonical';
  final_object_key: string;
  source_etag: string | null;
  source_mime_type: SupportedImageType | null;
  source_byte_size: number | null;
  source_sha256: string | null;
  source_width: number | null;
  source_height: number | null;
  final_etag: string | null;
  target_verified_at: string | null;
  source_writable_until: string;
  state: MediaObjectPromotionState;
  final_pointer_committed: 0 | 1;
  claim_token: string | null;
  lease_expires_at: string | null;
  source_absent_since: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaObjectPromotion {
  mediaId: string;
  eventId: string;
  sourceBucketGeneration: 'legacy';
  sourceObjectKey: string;
  finalBucketGeneration: 'canonical';
  finalObjectKey: string;
  sourceEtag: string | null;
  sourceMimeType: SupportedImageType | null;
  sourceByteSize: number | null;
  sourceSha256: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  finalEtag: string | null;
  targetVerifiedAt: string | null;
  sourceWritableUntil: string;
  state: MediaObjectPromotionState;
  finalPointerCommitted: boolean;
  claimToken: string | null;
  leaseExpiresAt: string | null;
  sourceAbsentSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedMediaPromotion {
  promotion: MediaObjectPromotion;
  media: MediaRecord;
}

export interface ClaimedMediaIngress extends ClaimedMediaPromotion {
  claimToken: string;
}

function mapMedia(row: MediaRow): MediaRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    uploaderSessionId: row.uploader_session_id,
    objectKey: row.object_key,
    objectBucketGeneration: row.object_bucket_generation,
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
    storedAt: row.stored_at,
    capturedAt: row.captured_at,
    timelineAt: row.timeline_at,
    favoritedAt: row.favorited_at,
    publishedAt: row.published_at,
    previewObjectKey: row.preview_object_key,
    deletedAt: row.deleted_at,
  };
}

function mapPromotion(row: MediaObjectPromotionRow): MediaObjectPromotion {
  return {
    mediaId: row.media_id,
    eventId: row.event_id,
    sourceBucketGeneration: row.source_bucket_generation,
    sourceObjectKey: row.source_object_key,
    finalBucketGeneration: row.final_bucket_generation,
    finalObjectKey: row.final_object_key,
    sourceEtag: row.source_etag,
    sourceMimeType: row.source_mime_type,
    sourceByteSize: row.source_byte_size,
    sourceSha256: row.source_sha256,
    sourceWidth: row.source_width,
    sourceHeight: row.source_height,
    finalEtag: row.final_etag,
    targetVerifiedAt: row.target_verified_at,
    sourceWritableUntil: row.source_writable_until,
    state: row.state,
    finalPointerCommitted: row.final_pointer_committed === 1,
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    sourceAbsentSince: row.source_absent_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Whether the preview route can produce an image for this row, which is the only
 * question a client asks before rendering one.
 *
 * This deliberately does not consult `preview_object_key`. That column records a
 * *legacy* cached derivative and nothing in the current pipeline writes it —
 * `getOrCreatePreview` transforms the original on demand and keeps the result
 * ephemeral on purpose, so a stored row previews perfectly well with the column
 * NULL. Deriving the flag from the column reported `false` for every photo
 * delivered by the current code and left the private Gallery rendering
 * placeholders instead of the host's photographs.
 */
function previewAvailable(uploadState: MediaRecord['uploadState']): boolean {
  return uploadState === 'stored';
}

export function managerMediaView(media: Pick<
  MediaRecord,
  | 'id'
  | 'originalFilename'
  | 'guestName'
  | 'caption'
  | 'publicationStatus'
  | 'uploadState'
  | 'width'
  | 'height'
  | 'createdAt'
>): ManagerMediaView {
  return {
    id: media.id,
    originalFilename: media.originalFilename,
    guestName: media.guestName,
    caption: media.caption,
    publicationStatus: media.publicationStatus,
    uploadState: media.uploadState,
    previewAvailable: previewAvailable(media.uploadState),
    width: media.width,
    height: media.height,
    createdAt: media.createdAt,
  };
}

function mapManagerMedia(row: MediaRow): ManagerMediaView {
  return {
    id: row.id,
    originalFilename: row.original_filename,
    guestName: row.guest_name,
    caption: row.caption,
    publicationStatus: row.publication_status,
    uploadState: row.upload_state,
    previewAvailable: previewAvailable(row.upload_state),
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

export function managerGalleryMediaView(media: Pick<
  MediaRecord,
  | 'id'
  | 'originalFilename'
  | 'guestName'
  | 'caption'
  | 'publicationStatus'
  | 'uploadState'
  | 'width'
  | 'height'
  | 'createdAt'
  | 'storedAt'
  | 'capturedAt'
  | 'timelineAt'
  | 'favoritedAt'
>): ManagerGalleryMediaView {
  return {
    id: media.id,
    originalFilename: media.originalFilename,
    guestName: media.guestName,
    caption: media.caption,
    publicationStatus: media.publicationStatus,
    previewAvailable: previewAvailable(media.uploadState),
    width: media.width,
    height: media.height,
    receivedAt: media.storedAt ?? media.createdAt,
    timelineAt: media.timelineAt,
    timelineSource: media.capturedAt !== null ? 'capture' : 'received',
    isFavorite: media.favoritedAt !== null,
  };
}

function mapGalleryMediaRow(row: MediaRow): ManagerGalleryMediaView {
  return managerGalleryMediaView({
    id: row.id,
    originalFilename: row.original_filename,
    guestName: row.guest_name,
    caption: row.caption,
    publicationStatus: row.publication_status,
    uploadState: row.upload_state,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    storedAt: row.stored_at,
    capturedAt: row.captured_at,
    timelineAt: row.timeline_at,
    favoritedAt: row.favorited_at,
  });
}

export interface ManagerMediaOptions {
  status?: PublicationStatus;
  guestName?: string;
  cursor?: ManagerMediaCursor;
  limit?: number;
}

export interface ManagerMediaPage {
  media: ManagerMediaView[];
  nextCursor: ManagerMediaCursor | null;
}

export interface GalleryTimelineOptions {
  query?: string;
  favorites?: boolean;
  cursor?: GalleryCursor;
  limit?: number;
  order?: GalleryTimelineOrder;
}

export interface GalleryTimelinePage {
  media: ManagerGalleryMediaView[];
  nextCursor: GalleryCursor | null;
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
      SELECT
        id, original_filename, guest_name, caption, publication_status,
        upload_state, preview_object_key, width, height, created_at, stored_at
      FROM media
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
    const media = pageRows.map(mapManagerMedia);
    const last = pageRows[pageRows.length - 1];
    const hasMore = result.results.length > limit;
    return {
      media,
      nextCursor: hasMore && last?.stored_at
        ? { storedAt: last.stored_at, id: last.id }
        : null,
    };
  }

  /**
   * The host private Gallery stream: event-scoped, stored-only, non-deleted, ordered
   * by `timeline_at` and ID in the direction the host asked for. `event_id` is always
   * the first bound value, so a caller-supplied cursor can only move the position
   * inside the event the session is already authorized for. Search is a bound
   * `instr(lower(...), lower(?))` substring match — ASCII-only folding with
   * literal `%` and `_` — over contributor, caption, and filename.
   *
   * The keyset comparison and the ORDER BY must flip together, or the cursor walks
   * away from the page it just returned. `ascending` is derived from a validated
   * enum and only ever selects between two SQL literals here; no caller value
   * reaches the statement text.
   */
  async listGalleryTimeline(
    eventId: string,
    options: GalleryTimelineOptions = {},
  ): Promise<GalleryTimelinePage> {
    const limit = options.limit ?? PRIVATE_GALLERY_PAGE_SIZE;
    const ascending = (options.order ?? DEFAULT_GALLERY_TIMELINE_ORDER) === 'earliest';
    const predicates = [
      'event_id = ?',
      "upload_state = 'stored'",
      'deleted_at IS NULL',
    ];
    const bindings: unknown[] = [eventId];

    if (options.query) {
      predicates.push(`(
        instr(lower(guest_name), lower(?)) > 0
        OR instr(lower(COALESCE(caption, '')), lower(?)) > 0
        OR instr(lower(original_filename), lower(?)) > 0
      )`);
      bindings.push(options.query, options.query, options.query);
    }
    if (options.favorites) {
      predicates.push('favorited_at IS NOT NULL');
    }
    if (options.cursor) {
      predicates.push(ascending
        ? '(timeline_at > ? OR (timeline_at = ? AND id > ?))'
        : '(timeline_at < ? OR (timeline_at = ? AND id < ?))');
      bindings.push(options.cursor.timelineAt, options.cursor.timelineAt, options.cursor.id);
    }
    bindings.push(limit + 1);

    const direction = ascending ? 'ASC' : 'DESC';
    const result = await this.db.prepare(`
      SELECT
        id, original_filename, guest_name, caption, publication_status,
        upload_state, preview_object_key, width, height, created_at, stored_at,
        captured_at, timeline_at, favorited_at
      FROM media
      WHERE ${predicates.join(' AND ')}
      ORDER BY timeline_at ${direction}, id ${direction}
      LIMIT ?
    `).bind(...bindings).all<MediaRow>();
    const pageRows = result.results.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const hasMore = result.results.length > limit;
    return {
      media: pageRows.map(mapGalleryMediaRow),
      nextCursor: hasMore && last
        ? { timelineAt: last.timeline_at, id: last.id }
        : null,
    };
  }

  async setFavorite(eventId: string, mediaId: string, favoritedAt: string | null): Promise<MediaRecord> {
    if (favoritedAt !== null) {
      await this.addFavoritesWithinAlbumCapacity(eventId, [mediaId], favoritedAt);
      const current = await this.getById(mediaId);
      if (!current || current.eventId !== eventId) {
        throw new ApiError('RESOURCE_FORBIDDEN', 'This photo belongs to a different event.', 403);
      }
      if (current.uploadState !== 'stored' || current.deletedAt !== null) {
        throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo is no longer available.', 409);
      }
      return current;
    }
    const result = await this.db.prepare(`
      UPDATE media
      SET favorited_at = CASE
            WHEN ? IS NULL THEN NULL
            ELSE COALESCE(favorited_at, ?)
          END
      WHERE id = ? AND event_id = ?
        AND upload_state = 'stored' AND deleted_at IS NULL
      RETURNING *
    `).bind(favoritedAt, favoritedAt, mediaId, eventId).all<MediaRow>();
    const row = result.results[0];
    if (row) return mapMedia(row);

    const current = await this.getById(mediaId);
    if (!current || current.eventId !== eventId) {
      throw new ApiError('RESOURCE_FORBIDDEN', 'This photo belongs to a different event.', 403);
    }
    throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo is no longer available.', 409);
  }

  /**
   * Adds all eligible requested ids or none of them. The capacity predicate and the
   * membership mutation are one SQLite statement, so two hosts cannot both spend the
   * same final slot after independent reads. The diagnostic runs in the same D1 batch:
   * zero eligible ids remain after a successful write or a true no-op; remaining ids
   * over capacity are the one case reported as ALBUM_FULL.
   */
  private async addFavoritesWithinAlbumCapacity(
    eventId: string,
    mediaIds: readonly string[],
    favoritedAt: string,
  ): Promise<ManagerGalleryMediaView[]> {
    if (mediaIds.length === 0) return [];
    const unique = [...new Set(mediaIds)];
    if (unique.length > ALBUM_MAX_ENTRIES) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `Choose up to ${ALBUM_MAX_ENTRIES} photos at a time.`,
        422,
      );
    }
    const requested = JSON.stringify(unique);
    const sectionCountSql = `
      SELECT COUNT(*)
      FROM event_albums AS album,
        json_each(CASE WHEN json_valid(album.entries) THEN album.entries ELSE '[]' END) AS entry
      WHERE album.event_id = ?
        AND json_extract(entry.value, '$.kind') = 'section'
    `;
    const batch = await this.db.batch([
      this.db.prepare(`
        WITH
          requested(id) AS MATERIALIZED (
            SELECT DISTINCT CAST(value AS TEXT) FROM json_each(?)
          ),
          eligible(id) AS MATERIALIZED (
            SELECT media.id
            FROM media INNER JOIN requested ON requested.id = media.id
            WHERE media.event_id = ?
              AND media.upload_state = 'stored'
              AND media.deleted_at IS NULL
              AND media.favorited_at IS NULL
          ),
          capacity(allowed) AS MATERIALIZED (
            SELECT (
              (SELECT COUNT(*) FROM media
                WHERE event_id = ?
                  AND upload_state = 'stored'
                  AND deleted_at IS NULL
                  AND favorited_at IS NOT NULL)
              + (${sectionCountSql})
              + (SELECT COUNT(*) FROM eligible)
            ) <= ?
          )
        UPDATE media
        SET favorited_at = ?
        WHERE id IN (SELECT id FROM eligible)
          AND (SELECT allowed FROM capacity)
        RETURNING
          id, original_filename, guest_name, caption, publication_status,
          upload_state, preview_object_key, width, height, created_at, stored_at,
          captured_at, timeline_at, favorited_at
      `).bind(
        requested,
        eventId,
        eventId,
        eventId,
        ALBUM_MAX_ENTRIES,
        favoritedAt,
      ),
      this.db.prepare(`
        WITH requested(id) AS (
          SELECT DISTINCT CAST(value AS TEXT) FROM json_each(?)
        )
        SELECT
          (SELECT COUNT(*) FROM media
            WHERE event_id = ?
              AND upload_state = 'stored'
              AND deleted_at IS NULL
              AND favorited_at IS NOT NULL)
            + (${sectionCountSql}) AS used,
          (SELECT COUNT(*)
            FROM media INNER JOIN requested ON requested.id = media.id
            WHERE media.event_id = ?
              AND media.upload_state = 'stored'
              AND media.deleted_at IS NULL
              AND media.favorited_at IS NULL) AS remaining
      `).bind(requested, eventId, eventId, eventId),
    ]);
    const diagnostic = batch[1]?.results[0] as { used: number; remaining: number } | undefined;
    if (diagnostic
      && diagnostic.remaining > 0
      && diagnostic.used + diagnostic.remaining > ALBUM_MAX_ENTRIES) {
      throw new ApiError(
        'ALBUM_FULL',
        `An album holds up to ${ALBUM_MAX_ENTRIES} photos and sections. Remove an entry before adding more.`,
        409,
      );
    }
    return (batch[0]?.results as unknown as MediaRow[] | undefined)
      ?.map(mapGalleryMediaRow) ?? [];
  }

  /**
   * Album picks in bulk — the tray's `Add n to album` / `Remove n from album`, the undo
   * that reverses either, and the restore behind `Start empty`.
   *
   * The predicate selects only rows that actually change, so `RETURNING` is exactly the
   * set an undo has to reverse. Re-picking an already-picked photo is not an error and
   * not a change; it simply does not come back. That is what lets `Select all` over a
   * mixed page do the obvious thing, and it is why undoing `Add 12 to album` over a page
   * where four were already picked leaves those four picked.
   *
   * Chunked rather than refused past D1's 100-value statement bound, because the callers
   * have two different natural sizes — the tray is bounded by the selection cap, while
   * restoring a cleared album is bounded by the album itself. One batch keeps both from
   * committing halfway.
   */
  async setFavoriteBulk(
    eventId: string,
    mediaIds: readonly string[],
    favoritedAt: string | null,
  ): Promise<ManagerGalleryMediaView[]> {
    if (mediaIds.length === 0) return [];
    if (mediaIds.length > ALBUM_MAX_ENTRIES) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `Choose up to ${ALBUM_MAX_ENTRIES} photos at a time.`,
        422,
      );
    }
    const unique = [...new Set(mediaIds)];
    if (favoritedAt !== null) {
      return this.addFavoritesWithinAlbumCapacity(eventId, unique, favoritedAt);
    }
    const changing = favoritedAt === null ? 'favorited_at IS NOT NULL' : 'favorited_at IS NULL';
    // Two bound values are spent on the event and the stamp before any id, so the chunk
    // sits under the 100-value bound with room rather than exactly at it.
    const chunkSize = 90;
    const statements = [];
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      statements.push(this.db.prepare(`
        UPDATE media
        SET favorited_at = ?
        WHERE event_id = ?
          AND upload_state = 'stored'
          AND deleted_at IS NULL
          AND ${changing}
          AND id IN (${chunk.map(() => '?').join(', ')})
        RETURNING
          id, original_filename, guest_name, caption, publication_status,
          upload_state, preview_object_key, width, height, created_at, stored_at,
          captured_at, timeline_at, favorited_at
      `).bind(favoritedAt, eventId, ...chunk));
    }
    const batch = await this.db.batch<MediaRow>(statements);
    return batch.flatMap((result) => result.results.map(mapGalleryMediaRow));
  }

  /**
   * Empties the album's membership in one statement — the `Start empty` half of the
   * reconciliation prompt. Returns what it cleared so the choice is undoable through
   * `setFavoriteBulk`, which is bounded by the album cap and therefore always able to
   * take the whole list back.
   */
  async clearAllFavorites(eventId: string): Promise<string[]> {
    const result = await this.db.prepare(`
      UPDATE media
      SET favorited_at = NULL
      WHERE event_id = ?
        AND upload_state = 'stored'
        AND deleted_at IS NULL
        AND favorited_at IS NOT NULL
      RETURNING id
    `).bind(eventId).all<{ id: string }>();
    return result.results.map((row) => row.id);
  }

  async countStoredTimelineSentinels(eventId?: string): Promise<number> {
    const predicates = [
      "upload_state = 'stored'",
      'deleted_at IS NULL',
      'timeline_at = ?',
    ];
    const bindings: unknown[] = [MEDIA_TIMELINE_SENTINEL];
    if (eventId) {
      predicates.unshift('event_id = ?');
      bindings.unshift(eventId);
    }
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count FROM media WHERE ${predicates.join(' AND ')}
    `).bind(...bindings).first<{ count: number }>();
    return row?.count ?? 0;
  }

  async repairStoredTimelineSentinels(limit: number, eventId?: string): Promise<number> {
    const predicate = eventId ? 'AND event_id = ?' : '';
    const bindings = eventId ? [eventId, limit] : [limit];
    const result = await this.db.prepare(`
      UPDATE media
      SET timeline_at = COALESCE(stored_at, created_at)
      WHERE id IN (
        SELECT id FROM media
        WHERE upload_state = 'stored'
          AND deleted_at IS NULL
          AND timeline_at = ?
          ${predicate}
        LIMIT ?
      )
    `).bind(MEDIA_TIMELINE_SENTINEL, ...bindings).run();
    return result.meta.changes;
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

  async getPromotion(mediaId: string): Promise<MediaObjectPromotion | null> {
    const row = await this.db.prepare(`
      SELECT * FROM media_object_promotions WHERE media_id = ?
    `).bind(mediaId).first<MediaObjectPromotionRow>();
    return row ? mapPromotion(row) : null;
  }

  async ensureFinalObjectWriteTombstone(
    mediaId: string,
    finalObjectKey: string,
    recordedAt: string,
  ): Promise<void> {
    const media = await this.getById(mediaId);
    if (!media) throw new Error('Media row disappeared before final-object inventory.');
    await new MediaObjectWriteTombstoneRepository(this.db).ensure({
      bucketGeneration: 'canonical',
      objectKey: finalObjectKey,
      eventId: media.eventId,
      mediaId,
      objectKind: 'final',
      recordedAt,
    });
  }

  async listPromotionWork(
    now: string,
    limit = 25,
    includeActiveVerified = false,
  ): Promise<MediaObjectPromotion[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.db.prepare(`
      SELECT p.* FROM media_object_promotions AS p
      WHERE (
        p.state = 'cleanup_pending' AND p.source_writable_until <= ?
      ) OR (
        p.state = 'copying' AND p.lease_expires_at <= ? AND (
          p.source_writable_until <= ? OR (
            EXISTS (
              SELECT 1 FROM media AS m
              WHERE m.id = p.media_id
                AND m.event_id = p.event_id
                AND m.upload_state = 'stored'
                AND m.deleted_at IS NULL
                AND m.object_bucket_generation = p.source_bucket_generation
                AND m.object_key = p.source_object_key
            )
            AND EXISTS (
              SELECT 1 FROM events AS e
              WHERE e.id = p.event_id AND e.deleted_at IS NULL
            )
          )
        )
      ) OR (
        p.state = 'pending' AND p.source_writable_until <= ?
      ) OR (
        p.state = 'target_verified' AND (
          ? = 1
          OR NOT (
            EXISTS (
              SELECT 1 FROM media AS m
              WHERE m.id = p.media_id AND m.event_id = p.event_id
                AND m.upload_state = 'stored' AND m.deleted_at IS NULL
                AND m.object_bucket_generation = p.source_bucket_generation
                AND m.object_key = p.source_object_key
                AND m.mime_type = p.source_mime_type
                AND m.byte_size = p.source_byte_size
                AND m.width = p.source_width AND m.height = p.source_height
            )
            AND EXISTS (
              SELECT 1 FROM events AS e
              WHERE e.id = p.event_id AND e.deleted_at IS NULL
            )
          )
        )
      )
      ORDER BY p.updated_at ASC, p.media_id ASC
      LIMIT ?
    `).bind(
      now,
      now,
      now,
      now,
      includeActiveVerified ? 1 : 0,
      boundedLimit,
    ).all<MediaObjectPromotionRow>();
    return result.results.map(mapPromotion);
  }

  async countPromotions(): Promise<number> {
    return (await this.db.prepare(`
      SELECT count(*) AS count FROM media_object_promotions
    `).first<number>('count')) ?? 0;
  }

  async legacyStoredCutoverReadiness(): Promise<{
    liveLegacyCount: number;
    unverifiedLiveLegacyCount: number;
  }> {
    const row = await this.db.prepare(`
      SELECT
        count(*) AS live_legacy_count,
        COALESCE(sum(CASE WHEN NOT EXISTS (
          SELECT 1 FROM media_object_promotions AS p
          WHERE p.media_id = m.id AND p.event_id = m.event_id
            AND p.source_bucket_generation = m.object_bucket_generation
            AND p.source_object_key = m.object_key
            AND p.source_mime_type = m.mime_type
            AND p.source_byte_size = m.byte_size
            AND p.source_width = m.width AND p.source_height = m.height
            AND p.state = 'target_verified'
            AND p.source_etag IS NOT NULL AND p.source_sha256 IS NOT NULL
            AND p.final_etag IS NOT NULL AND p.target_verified_at IS NOT NULL
            AND p.final_object_key =
              ('events/' || m.event_id || '/media/final/' || m.id)
            AND EXISTS (
              SELECT 1 FROM media_object_write_tombstones AS t
              WHERE t.bucket_generation = p.final_bucket_generation
                AND t.object_key = p.final_object_key
                AND t.event_id = p.event_id AND t.media_id = p.media_id
                AND t.object_kind = 'final' AND t.suppression_started_at IS NULL
            )
        ) THEN 1 ELSE 0 END), 0) AS unverified_live_legacy_count
      FROM media AS m
      JOIN events AS e ON e.id = m.event_id AND e.deleted_at IS NULL
      WHERE m.upload_state = 'stored' AND m.deleted_at IS NULL
        AND m.object_bucket_generation = 'legacy'
    `).first<{ live_legacy_count: number; unverified_live_legacy_count: number }>();
    return {
      liveLegacyCount: row?.live_legacy_count ?? 0,
      unverifiedLiveLegacyCount: row?.unverified_live_legacy_count ?? 0,
    };
  }

  async claimPromotion(
    mediaId: string,
    claimToken: string,
    claimedAt: string,
    leaseExpiresAt: string,
  ): Promise<ClaimedMediaPromotion | null> {
    const result = await this.db.prepare(`
        UPDATE media_object_promotions
        SET state = 'copying', claim_token = ?, lease_expires_at = ?,
            final_pointer_committed = 0, updated_at = ?
      WHERE media_id = ?
        AND source_writable_until <= ?
        AND (
          state = 'pending'
          OR (state = 'copying' AND lease_expires_at <= ?
            AND (source_etag IS NULL OR source_etag NOT LIKE 'buffer:%'))
        )
        AND EXISTS (
          SELECT 1 FROM media AS m
          WHERE m.id = media_object_promotions.media_id
            AND m.event_id = media_object_promotions.event_id
            AND m.upload_state = 'stored'
            AND m.deleted_at IS NULL
            AND m.object_bucket_generation = media_object_promotions.source_bucket_generation
            AND m.object_key = media_object_promotions.source_object_key
        )
        AND EXISTS (
          SELECT 1 FROM events AS e
          WHERE e.id = media_object_promotions.event_id AND e.deleted_at IS NULL
        )
    `).bind(claimToken, leaseExpiresAt, claimedAt, mediaId, claimedAt, claimedAt).run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    const promotion = await this.getPromotion(mediaId);
    const media = await this.getById(mediaId);
    if (!promotion || !media) throw new Error('Claimed media promotion inventory disappeared.');
    return { promotion, media };
  }

  async claimInactivePromotion(
    mediaId: string,
    claimToken: string,
    claimedAt: string,
    leaseExpiresAt: string,
  ): Promise<ClaimedMediaPromotion | null> {
    const result = await this.db.prepare(`
        UPDATE media_object_promotions
        SET state = 'copying', claim_token = ?, lease_expires_at = ?,
            final_pointer_committed = 0,
          source_etag = NULL, source_mime_type = NULL,
          source_byte_size = NULL, source_sha256 = NULL,
          source_width = NULL, source_height = NULL,
          final_etag = NULL, target_verified_at = NULL, updated_at = ?
      WHERE media_id = ? AND source_writable_until <= ?
        AND (
          state = 'pending'
          OR (state = 'copying' AND lease_expires_at <= ?
            AND (source_etag IS NULL OR source_etag NOT LIKE 'buffer:%'))
        )
        AND NOT (
          EXISTS (
            SELECT 1 FROM media AS m
            WHERE m.id = media_object_promotions.media_id
              AND m.event_id = media_object_promotions.event_id
              AND m.upload_state = 'stored'
              AND m.deleted_at IS NULL
              AND m.object_bucket_generation = media_object_promotions.source_bucket_generation
              AND m.object_key = media_object_promotions.source_object_key
          )
          AND EXISTS (
            SELECT 1 FROM events AS e
            WHERE e.id = media_object_promotions.event_id AND e.deleted_at IS NULL
          )
        )
    `).bind(
      claimToken,
      leaseExpiresAt,
      claimedAt,
      mediaId,
      claimedAt,
      claimedAt,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) return null;
    const promotion = await this.getPromotion(mediaId);
    const media = await this.getById(mediaId);
    if (!promotion || !media) throw new Error('Claimed inactive media promotion inventory disappeared.');
    return { promotion, media };
  }

  async claimReservationIngress(input: {
    mediaId: string;
    eventId: string;
    uploaderSessionId: string;
    sourceObjectKey: string;
    mimeType: SupportedImageType;
    byteSize: number;
    sha256: string;
    width: number;
    height: number;
    claimToken: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }): Promise<ClaimedMediaIngress | null> {
    assertWorkerIngressEnabled();
    const row = await this.db.prepare(`
      UPDATE media_object_promotions
      SET state = 'copying', final_pointer_committed = 0,
          claim_token = ?, lease_expires_at = ?,
          source_etag = ?, source_mime_type = ?, source_byte_size = ?,
          source_sha256 = ?, source_width = ?, source_height = ?,
          final_etag = NULL, target_verified_at = NULL,
          source_absent_since = NULL, updated_at = ?
      WHERE media_id = ? AND event_id = ?
        AND (
          state = 'pending'
          OR (
            state = 'copying' AND source_etag = ?
              AND source_mime_type = ? AND source_byte_size = ?
              AND source_sha256 = ? AND source_width = ? AND source_height = ?
          )
        )
        AND source_object_key = ?
        AND EXISTS (
          SELECT 1 FROM media AS m
          WHERE m.id = ? AND m.event_id = ? AND m.uploader_session_id = ?
            AND m.object_key = ? AND m.mime_type = ?
            AND m.declared_byte_size = ? AND m.upload_state = 'reserved'
            AND m.deleted_at IS NULL AND m.reservation_expires_at > ?
            AND media_object_promotions.source_writable_until >= m.reservation_expires_at
        )
        AND EXISTS (
          SELECT 1 FROM events AS e
          WHERE e.id = ? AND e.deleted_at IS NULL AND ${PHOTO_INTAKE_OPEN_SQL}
        )
      RETURNING *
    `).bind(
      input.claimToken,
      input.leaseExpiresAt,
      `buffer:${input.sha256}`,
      input.mimeType,
      input.byteSize,
      input.sha256,
      input.width,
      input.height,
      input.claimedAt,
      input.mediaId,
      input.eventId,
      `buffer:${input.sha256}`,
      input.mimeType,
      input.byteSize,
      input.sha256,
      input.width,
      input.height,
      input.sourceObjectKey,
      input.mediaId,
      input.eventId,
      input.uploaderSessionId,
      input.sourceObjectKey,
      input.mimeType,
      input.byteSize,
      input.claimedAt,
      input.eventId,
      input.claimedAt,
    ).first<MediaObjectPromotionRow>();
    if (!row) return null;
    const media = await this.getById(input.mediaId);
    if (!media) throw new Error('Claimed media ingress row disappeared.');
    return { promotion: mapPromotion(row), media, claimToken: input.claimToken };
  }

  async commitReservationIngress(input: {
    mediaId: string;
    claimToken: string;
    finalObjectKey: string;
    byteSize: number;
    width: number;
    height: number;
    finalEtag: string;
    committedAt: string;
    capturedAt: string | null;
    timelineAt: string;
  }): Promise<boolean> {
    if (input.timelineAt === MEDIA_TIMELINE_SENTINEL) {
      throw new Error('A stored photo requires a non-sentinel timeline instant.');
    }
    assertWorkerIngressEnabled();
    const current = await this.getById(input.mediaId);
    if (!current || current.uploadState !== 'reserved') return false;
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media
        SET object_key = ?, object_bucket_generation = 'canonical',
            byte_size = ?, width = ?, height = ?,
            upload_state = 'stored', stored_at = ?, captured_at = ?, timeline_at = ?,
            preview_object_key = NULL
        WHERE id = ? AND upload_state = 'reserved' AND deleted_at IS NULL
          AND object_key = (
            SELECT source_object_key FROM media_object_promotions WHERE media_id = ?
          )
          AND object_bucket_generation = (
            SELECT source_bucket_generation FROM media_object_promotions WHERE media_id = ?
          )
          AND reservation_expires_at > ?
          AND mime_type = (
            SELECT source_mime_type FROM media_object_promotions WHERE media_id = ?
          )
          AND declared_byte_size = (
            SELECT source_byte_size FROM media_object_promotions WHERE media_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM media_object_promotions AS p
            WHERE p.media_id = ? AND p.state = 'copying'
              AND p.final_pointer_committed = 0 AND p.claim_token = ?
              AND p.lease_expires_at > ? AND p.final_object_key = ?
              AND p.source_sha256 IS NOT NULL
          )
          AND EXISTS (
            SELECT 1 FROM events AS e
            WHERE e.id = media.event_id AND e.deleted_at IS NULL
              AND ${PHOTO_INTAKE_OPEN_SQL}
          )
        RETURNING id
      `).bind(
        input.finalObjectKey,
        input.byteSize,
        input.width,
        input.height,
        input.committedAt,
        input.capturedAt,
        input.timelineAt,
        input.mediaId,
        input.mediaId,
        input.mediaId,
        input.committedAt,
        input.mediaId,
        input.mediaId,
        input.mediaId,
        input.claimToken,
        input.committedAt,
        input.finalObjectKey,
        input.committedAt,
      ),
      this.db.prepare(`
        UPDATE events
        SET reserved_media_count = reserved_media_count - 1,
            reserved_bytes = reserved_bytes - ?,
            stored_media_count = stored_media_count + 1,
            stored_bytes = stored_bytes + ?
        WHERE id = ? AND changes() = 1
      `).bind(current.declaredByteSize, input.byteSize, current.eventId),
      this.db.prepare(`
        UPDATE media_object_promotions
        SET state = 'cleanup_pending', final_pointer_committed = 1,
            lease_expires_at = NULL, source_absent_since = NULL,
            final_etag = ?, target_verified_at = ?, updated_at = ?
        WHERE media_id = ? AND state = 'copying' AND claim_token = ?
          AND changes() = 1
      `).bind(
        input.finalEtag,
        input.committedAt,
        input.committedAt,
        input.mediaId,
        input.claimToken,
      ),
    ]);
    return (results[0]?.results?.length ?? 0) === 1
      && (results[1]?.meta.changes ?? 0) === 1
      && (results[2]?.meta.changes ?? 0) === 1;
  }

  async recordPromotionSource(
    mediaId: string,
    claimToken: string,
    source: {
      etag: string;
      mimeType: SupportedImageType;
      byteSize: number;
      sha256: string;
      width: number;
      height: number;
      recordedAt: string;
    },
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions
      SET source_etag = ?, source_mime_type = ?, source_byte_size = ?,
          source_sha256 = ?, source_width = ?, source_height = ?, updated_at = ?
      WHERE media_id = ? AND state = 'copying' AND claim_token = ?
        AND lease_expires_at > ?
        AND EXISTS (
          SELECT 1 FROM media AS m
          WHERE m.id = media_object_promotions.media_id
            AND m.event_id = media_object_promotions.event_id
            AND m.upload_state = 'stored' AND m.deleted_at IS NULL
            AND m.object_key = media_object_promotions.source_object_key
            AND m.object_bucket_generation = media_object_promotions.source_bucket_generation
            AND m.mime_type = ? AND m.byte_size = ?
            AND m.width = ? AND m.height = ?
        )
        AND EXISTS (
          SELECT 1 FROM events AS e
          WHERE e.id = media_object_promotions.event_id AND e.deleted_at IS NULL
        )
    `).bind(
      source.etag,
      source.mimeType,
      source.byteSize,
      source.sha256,
      source.width,
      source.height,
      source.recordedAt,
      mediaId,
      claimToken,
      source.recordedAt,
      source.mimeType,
      source.byteSize,
      source.width,
      source.height,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async hasPromotionWritePermit(mediaId: string, claimToken: string, now: string): Promise<boolean> {
    const permitted = await this.db.prepare(`
      SELECT 1 AS permitted FROM media_object_promotions
      WHERE media_id = ? AND state = 'copying' AND claim_token = ?
        AND lease_expires_at > ?
        AND source_etag IS NOT NULL AND source_mime_type IS NOT NULL
        AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
        AND source_width IS NOT NULL AND source_height IS NOT NULL
    `).bind(mediaId, claimToken, now).first<number>('permitted');
    return permitted === 1;
  }

  async markPromotionTargetVerified(
    mediaId: string,
    claimToken: string,
    finalEtag: string,
    verifiedAt: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions AS p
      SET state = 'target_verified', lease_expires_at = NULL,
          final_etag = ?, target_verified_at = ?, updated_at = ?
      WHERE p.media_id = ? AND p.state = 'copying' AND p.claim_token = ?
        AND p.lease_expires_at > ?
        AND p.source_etag IS NOT NULL AND p.source_mime_type IS NOT NULL
        AND p.source_byte_size IS NOT NULL AND p.source_sha256 IS NOT NULL
        AND p.source_width IS NOT NULL AND p.source_height IS NOT NULL
        AND p.final_object_key = ('events/' || p.event_id || '/media/final/' || p.media_id)
        AND EXISTS (
          SELECT 1 FROM media AS m
          JOIN events AS e ON e.id = m.event_id AND e.deleted_at IS NULL
          WHERE m.id = p.media_id AND m.event_id = p.event_id
            AND m.upload_state = 'stored' AND m.deleted_at IS NULL
            AND m.object_bucket_generation = p.source_bucket_generation
            AND m.object_key = p.source_object_key
            AND m.mime_type = p.source_mime_type
            AND m.byte_size = p.source_byte_size
            AND m.width = p.source_width AND m.height = p.source_height
        )
        AND EXISTS (
          SELECT 1 FROM media_object_write_tombstones AS t
          WHERE t.bucket_generation = p.final_bucket_generation
            AND t.object_key = p.final_object_key
            AND t.event_id = p.event_id AND t.media_id = p.media_id
            AND t.object_kind = 'final' AND t.suppression_started_at IS NULL
        )
    `).bind(finalEtag, verifiedAt, verifiedAt, mediaId, claimToken, verifiedAt).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async commitPromotionPointer(mediaId: string, claimToken: string, committedAt: string): Promise<boolean> {
    assertLegacyPointerCutoverEnabled();
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media
        SET object_key = (
          SELECT final_object_key FROM media_object_promotions WHERE media_id = ?
        ), object_bucket_generation = 'canonical', preview_object_key = NULL
        WHERE id = ? AND upload_state = 'stored' AND deleted_at IS NULL
          AND object_key = (
            SELECT source_object_key FROM media_object_promotions WHERE media_id = ?
          )
          AND object_bucket_generation = (
            SELECT source_bucket_generation FROM media_object_promotions WHERE media_id = ?
          )
          AND mime_type = (
            SELECT source_mime_type FROM media_object_promotions WHERE media_id = ?
          )
          AND byte_size = (
            SELECT source_byte_size FROM media_object_promotions WHERE media_id = ?
          )
          AND width = (
            SELECT source_width FROM media_object_promotions WHERE media_id = ?
          )
          AND height = (
            SELECT source_height FROM media_object_promotions WHERE media_id = ?
          )
          AND EXISTS (
            SELECT 1 FROM media_object_promotions AS p
            WHERE p.media_id = ? AND p.event_id = media.event_id
              AND p.state = 'target_verified' AND p.claim_token = ?
              AND p.lease_expires_at IS NULL
              AND p.source_etag IS NOT NULL AND p.source_sha256 IS NOT NULL
              AND p.final_etag IS NOT NULL AND p.target_verified_at IS NOT NULL
              AND p.final_object_key =
                ('events/' || media.event_id || '/media/final/' || media.id)
              AND EXISTS (
                SELECT 1 FROM media_object_write_tombstones AS t
                WHERE t.bucket_generation = p.final_bucket_generation
                  AND t.object_key = p.final_object_key
                  AND t.event_id = p.event_id AND t.media_id = p.media_id
                  AND t.object_kind = 'final' AND t.suppression_started_at IS NULL
              )
          )
          AND EXISTS (
            SELECT 1 FROM events AS e
            WHERE e.id = media.event_id AND e.deleted_at IS NULL
          )
        RETURNING id
      `).bind(
        mediaId,
        mediaId,
        mediaId,
        mediaId,
        mediaId,
        mediaId,
        mediaId,
        mediaId,
        mediaId,
        claimToken,
      ),
      this.db.prepare(`
        UPDATE media_object_promotions
        SET state = 'cleanup_pending', lease_expires_at = NULL,
            final_pointer_committed = 1,
            source_absent_since = NULL, updated_at = ?
        WHERE media_id = ? AND state = 'target_verified' AND claim_token = ?
          AND changes() = 1
      `).bind(committedAt, mediaId, claimToken),
    ]);
    return (results[0]?.results?.length ?? 0) === 1
      && (results[1]?.meta.changes ?? 0) === 1;
  }

  async releasePromotionClaim(mediaId: string, claimToken: string, releasedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions
      SET state = 'pending', claim_token = NULL, lease_expires_at = NULL,
          final_pointer_committed = 0,
          source_etag = NULL, source_mime_type = NULL,
          source_byte_size = NULL, source_sha256 = NULL,
          source_width = NULL, source_height = NULL,
          final_etag = NULL, target_verified_at = NULL, updated_at = ?
      WHERE media_id = ? AND state = 'copying' AND claim_token = ?
    `).bind(releasedAt, mediaId, claimToken).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async handoffPromotionToPermanentSuppression(
    mediaId: string,
    claimToken: string,
    handedOffAt: string,
  ): Promise<boolean> {
    const activePointerSql = `
      EXISTS (
        SELECT 1 FROM media AS m
        JOIN events AS e ON e.id = m.event_id AND e.deleted_at IS NULL
        WHERE m.id = p.media_id AND m.event_id = p.event_id
          AND m.upload_state = 'stored' AND m.deleted_at IS NULL
          AND m.object_key = CASE p.final_pointer_committed
            WHEN 1 THEN p.final_object_key ELSE p.source_object_key END
          AND m.object_bucket_generation = CASE p.final_pointer_committed
            WHEN 1 THEN p.final_bucket_generation ELSE p.source_bucket_generation END
      )
    `;
    try {
      const results = await this.db.batch([
        this.db.prepare(`
          UPDATE media
          SET preview_object_key = NULL
          WHERE id = ? AND preview_object_key IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM media_object_promotions AS p
              WHERE p.media_id = media.id AND p.media_id = ?
                AND p.state = 'cleanup_pending' AND p.claim_token = ?
            )
        `).bind(mediaId, mediaId, claimToken),
        this.db.prepare(`
          UPDATE media_object_write_tombstones AS target
          SET suppression_started_at = COALESCE(suppression_started_at, ?),
              next_check_at = min(next_check_at, ?), updated_at = ?
          WHERE target.media_id = ? AND suppression_started_at IS NULL
            AND target.object_kind NOT IN ('export', 'cover')
            AND EXISTS (
              SELECT 1 FROM media_object_promotions AS p
              WHERE p.media_id = target.media_id AND p.event_id = target.event_id
                AND p.media_id = ? AND p.state = 'cleanup_pending'
                AND p.claim_token = ?
                AND (
                  (
                    p.final_pointer_committed = 1
                    AND ${activePointerSql}
                    AND NOT (
                      target.object_kind = 'final'
                      AND target.bucket_generation = p.final_bucket_generation
                      AND target.object_key = p.final_object_key
                    )
                  )
                  OR NOT ${activePointerSql}
                )
            )
        `).bind(handedOffAt, handedOffAt, handedOffAt, mediaId, mediaId, claimToken),
        this.db.prepare(`
          DELETE FROM media_object_promotions AS p
          WHERE p.media_id = ? AND p.state = 'cleanup_pending' AND p.claim_token = ?
            AND (
              (
                p.final_pointer_committed = 1
                AND ${activePointerSql}
                AND EXISTS (
                  SELECT 1 FROM media_object_write_tombstones AS final_target
                  WHERE final_target.bucket_generation = p.final_bucket_generation
                    AND final_target.object_key = p.final_object_key
                    AND final_target.event_id = p.event_id
                    AND final_target.media_id = p.media_id
                    AND final_target.object_kind = 'final'
                    AND final_target.suppression_started_at IS NULL
                )
                AND EXISTS (
                  SELECT 1 FROM media_object_write_tombstones AS preview_target
                  WHERE preview_target.bucket_generation = 'legacy'
                    AND preview_target.object_key =
                    ('events/' || p.event_id || '/previews/' || p.media_id || '.webp')
                    AND preview_target.event_id = p.event_id
                    AND preview_target.media_id = p.media_id
                    AND preview_target.object_kind = 'preview'
                    AND preview_target.suppression_started_at IS NOT NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM media_object_write_tombstones AS pending_target
                  WHERE pending_target.event_id = p.event_id
                    AND pending_target.media_id = p.media_id
                    AND pending_target.object_kind NOT IN ('export', 'cover')
                    AND NOT (
                      pending_target.object_kind = 'final'
                      AND pending_target.bucket_generation = p.final_bucket_generation
                      AND pending_target.object_key = p.final_object_key
                    )
                    AND pending_target.suppression_started_at IS NULL
                )
              )
              OR (
                NOT ${activePointerSql}
                AND EXISTS (
                  SELECT 1 FROM media_object_write_tombstones AS source_target
                  WHERE source_target.bucket_generation = p.source_bucket_generation
                    AND source_target.object_key = p.source_object_key
                    AND source_target.event_id = p.event_id
                    AND source_target.media_id = p.media_id
                    AND source_target.suppression_started_at IS NOT NULL
                )
                AND EXISTS (
                  SELECT 1 FROM media_object_write_tombstones AS final_target
                  WHERE final_target.bucket_generation = p.final_bucket_generation
                    AND final_target.object_key = p.final_object_key
                    AND final_target.event_id = p.event_id
                    AND final_target.media_id = p.media_id
                    AND final_target.object_kind = 'final'
                    AND final_target.suppression_started_at IS NOT NULL
                )
                AND EXISTS (
                  SELECT 1 FROM media_object_write_tombstones AS preview_target
                  WHERE preview_target.bucket_generation = 'legacy'
                    AND preview_target.object_key =
                    ('events/' || p.event_id || '/previews/' || p.media_id || '.webp')
                    AND preview_target.event_id = p.event_id
                    AND preview_target.media_id = p.media_id
                    AND preview_target.object_kind = 'preview'
                    AND preview_target.suppression_started_at IS NOT NULL
                )
                AND NOT EXISTS (
                  SELECT 1 FROM media_object_write_tombstones AS pending_target
                  WHERE pending_target.event_id = p.event_id
                    AND pending_target.media_id = p.media_id
                    AND pending_target.object_kind NOT IN ('export', 'cover')
                    AND pending_target.suppression_started_at IS NULL
                )
              )
            )
        `).bind(mediaId, claimToken),
      ]);
      if ((results[2]?.meta.changes ?? 0) === 1) return true;
    } catch (error) {
      // A D1 response can be lost after both statements committed. The missing
      // finite fence is success only because the permanent tombstones survive.
      if (!await this.getPromotion(mediaId)) return true;
      throw error;
    }
    return await this.getPromotion(mediaId) === null;
  }

  async parkInactivePromotionCleanup(
    mediaId: string,
    claimToken: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions
      SET state = 'cleanup_pending', lease_expires_at = NULL,
          final_pointer_committed = 0,
          source_etag = NULL, source_mime_type = NULL,
          source_byte_size = NULL, source_sha256 = NULL,
          source_width = NULL, source_height = NULL,
          final_etag = NULL, target_verified_at = NULL,
          source_absent_since = NULL, updated_at = ?
      WHERE media_id = ? AND state = 'copying'
        AND final_pointer_committed = 0 AND claim_token = ?
        AND source_writable_until <= ?
        AND NOT EXISTS (
          SELECT 1 FROM media AS m
          JOIN events AS e ON e.id = m.event_id AND e.deleted_at IS NULL
          WHERE m.id = media_object_promotions.media_id
            AND m.event_id = media_object_promotions.event_id
            AND m.deleted_at IS NULL
            AND (
              (
                media_object_promotions.final_pointer_committed = 1
                AND m.upload_state = 'stored'
                AND m.object_key = media_object_promotions.final_object_key
                AND m.object_bucket_generation = media_object_promotions.final_bucket_generation
              )
              OR (
                media_object_promotions.final_pointer_committed = 0
                AND media_object_promotions.source_etag LIKE 'buffer:%'
                AND m.upload_state = 'reserved'
                AND m.object_key = media_object_promotions.source_object_key
                AND m.object_bucket_generation = media_object_promotions.source_bucket_generation
              )
              OR (
                media_object_promotions.final_pointer_committed = 0
                AND media_object_promotions.source_etag NOT LIKE 'buffer:%'
                AND m.upload_state = 'stored'
                AND m.object_key = CASE media_object_promotions.final_pointer_committed
                  WHEN 1 THEN media_object_promotions.final_object_key
                  ELSE media_object_promotions.source_object_key END
                AND m.object_bucket_generation = CASE media_object_promotions.final_pointer_committed
                  WHEN 1 THEN media_object_promotions.final_bucket_generation
                  ELSE media_object_promotions.source_bucket_generation END
              )
            )
        )
    `).bind(now, mediaId, claimToken, now).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async parkInactiveVerifiedPromotionCleanup(
    mediaId: string,
    claimToken: string,
    now: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions AS p
      SET state = 'cleanup_pending', final_pointer_committed = 0,
          lease_expires_at = NULL, source_absent_since = NULL, updated_at = ?
      WHERE p.media_id = ? AND p.state = 'target_verified'
        AND p.final_pointer_committed = 0 AND p.claim_token = ?
        AND NOT (
          EXISTS (
            SELECT 1 FROM media AS m
            WHERE m.id = p.media_id AND m.event_id = p.event_id
              AND m.upload_state = 'stored' AND m.deleted_at IS NULL
              AND m.object_bucket_generation = p.source_bucket_generation
              AND m.object_key = p.source_object_key
              AND m.mime_type = p.source_mime_type
              AND m.byte_size = p.source_byte_size
              AND m.width = p.source_width AND m.height = p.source_height
          )
          AND EXISTS (
            SELECT 1 FROM events AS e
            WHERE e.id = p.event_id AND e.deleted_at IS NULL
          )
        )
    `).bind(now, mediaId, claimToken).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async markPromotionSourceAbsent(
    mediaId: string,
    claimToken: string,
    observedAt: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions
      SET source_absent_since = ?, updated_at = ?
      WHERE media_id = ? AND state = 'cleanup_pending' AND claim_token = ?
        AND source_writable_until <= ?
    `).bind(observedAt, observedAt, mediaId, claimToken, observedAt).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async clearPromotionSourceAbsence(
    mediaId: string,
    claimToken: string,
    observedAt: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions
      SET source_absent_since = NULL, updated_at = ?
      WHERE media_id = ? AND state = 'cleanup_pending' AND claim_token = ?
    `).bind(observedAt, mediaId, claimToken).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async touchPromotion(mediaId: string, touchedAt: string): Promise<void> {
    await this.db.prepare(`
      UPDATE media_object_promotions SET updated_at = ? WHERE media_id = ?
    `).bind(touchedAt, mediaId).run();
  }

  async rotateAmbiguousIngressPromotion(
    mediaId: string,
    sourceSha256: string,
    touchedAt: string,
  ): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE media_object_promotions
      SET updated_at = ?
      WHERE media_id = ? AND state = 'copying'
        AND source_etag = ('buffer:' || ?)
        AND source_sha256 = ?
    `).bind(touchedAt, mediaId, sourceSha256, sourceSha256).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async ingressPromotionIsInactive(mediaId: string): Promise<boolean> {
    const active = await this.db.prepare(`
      SELECT 1 AS active FROM media_object_promotions AS p
      JOIN media AS m ON m.id = p.media_id AND m.event_id = p.event_id
      JOIN events AS e ON e.id = p.event_id AND e.deleted_at IS NULL
      WHERE p.media_id = ? AND p.state = 'copying'
        AND p.source_etag LIKE 'buffer:%'
        AND m.upload_state = 'reserved' AND m.deleted_at IS NULL
        AND m.object_bucket_generation = p.source_bucket_generation
        AND m.object_key = p.source_object_key
      LIMIT 1
    `).bind(mediaId).first<number>('active');
    return active !== 1;
  }

  async adoptPresentIngressFinal(
    mediaId: string,
    expectedSha256: string,
    byteSize: number,
    width: number,
    height: number,
    finalEtag: string,
    committedAt: string,
  ): Promise<boolean> {
    assertWorkerIngressEnabled();
    const current = await this.getById(mediaId);
    if (!current || current.uploadState !== 'reserved') return false;
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media
        SET object_key = (
              SELECT final_object_key FROM media_object_promotions WHERE media_id = ?
            ), object_bucket_generation = 'canonical',
            byte_size = ?, width = ?, height = ?,
            upload_state = 'stored', stored_at = ?,
            captured_at = NULL, timeline_at = ?, preview_object_key = NULL
        WHERE id = ? AND upload_state = 'reserved' AND deleted_at IS NULL
          AND object_bucket_generation = 'legacy'
          AND object_key = (
            SELECT source_object_key FROM media_object_promotions WHERE media_id = ?
          )
          AND mime_type = (
            SELECT source_mime_type FROM media_object_promotions WHERE media_id = ?
          )
          AND declared_byte_size = ?
          AND EXISTS (
            SELECT 1 FROM media_object_promotions AS p
            WHERE p.media_id = ? AND p.event_id = media.event_id
              AND p.state = 'copying'
              AND p.source_etag = ('buffer:' || ?)
              AND p.source_sha256 = ? AND p.source_byte_size = ?
          )
          AND EXISTS (
            SELECT 1 FROM events AS e
            WHERE e.id = media.event_id AND e.deleted_at IS NULL
          )
        RETURNING id
      `).bind(
        mediaId,
        byteSize,
        width,
        height,
        committedAt,
        committedAt,
        mediaId,
        mediaId,
        mediaId,
        byteSize,
        mediaId,
        expectedSha256,
        expectedSha256,
        byteSize,
      ),
      this.db.prepare(`
        UPDATE events
        SET reserved_media_count = reserved_media_count - 1,
            reserved_bytes = reserved_bytes - ?,
            stored_media_count = stored_media_count + 1,
            stored_bytes = stored_bytes + ?
        WHERE id = ? AND changes() = 1
      `).bind(current.declaredByteSize, byteSize, current.eventId),
      this.db.prepare(`
        UPDATE media_object_promotions
        SET state = 'cleanup_pending', final_pointer_committed = 1,
            lease_expires_at = NULL, source_absent_since = NULL,
            final_etag = ?, target_verified_at = ?, updated_at = ?
        WHERE media_id = ? AND state = 'copying'
          AND source_etag = ('buffer:' || ?) AND source_sha256 = ?
          AND changes() = 1
      `).bind(
        finalEtag,
        committedAt,
        committedAt,
        mediaId,
        expectedSha256,
        expectedSha256,
      ),
    ]);
    return (results[0]?.results?.length ?? 0) === 1
      && (results[1]?.meta.changes ?? 0) === 1
      && (results[2]?.meta.changes ?? 0) === 1;
  }

  async eventHasPromotionFence(eventId: string): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT 1 AS present FROM media_object_promotions WHERE event_id = ? LIMIT 1
    `).bind(eventId).first<number>('present');
    return row === 1;
  }

  async eventHasWritableMediaAlias(eventId: string, now: string): Promise<boolean> {
    const row = await this.db.prepare(`
      SELECT 1 AS present FROM media
      WHERE event_id = ? AND reservation_expires_at > ? LIMIT 1
    `).bind(eventId, now).first<number>('present');
    return row === 1;
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

  private async idempotentRefreshConflict(input: ReserveMediaRecord): Promise<ApiError> {
    const promotion = await this.getPromotion((await this.getIdempotent(input))?.id ?? input.id);
    if (!promotion || promotion.state !== 'pending') {
      return new ApiError(
        'UPLOAD_FINALIZE_CONFLICT',
        'This upload is finishing secure storage cleanup. Choose the photo again shortly.',
        409,
      );
    }
    const intakeOpen = await this.db.prepare(`
      SELECT 1 AS permitted FROM events
      WHERE id = ? AND deleted_at IS NULL AND ${PHOTO_INTAKE_OPEN_SQL}
    `).bind(input.eventId, input.createdAt).first<number>('permitted');
    if (intakeOpen !== 1) {
      return new ApiError('UPLOADS_DISABLED', 'Photo uploads are paused for this event.', 409);
    }
    return new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload changed while it was being refreshed.', 409);
  }

  private async refreshIdempotent(input: ReserveMediaRecord, existing: MediaRecord): Promise<MediaRecord> {
    if (existing.uploadState === 'stored') return existing;
    if (existing.uploadState === 'deleted') {
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This photo was removed. Choose it again.', 409);
    }

    if (existing.uploadState === 'reserved') {
      const refreshed = await this.db.prepare(`
        UPDATE media
        SET reservation_expires_at = max(reservation_expires_at, ?),
            guest_name = ?, caption = ?
        WHERE id = ? AND upload_state = 'reserved' AND object_key = ?
          AND EXISTS (
            SELECT 1 FROM media_object_promotions AS p
            WHERE p.media_id = ? AND p.state = 'pending'
              AND p.source_object_key = ?
          )
          AND EXISTS (
            SELECT 1 FROM events
            WHERE id = ? AND deleted_at IS NULL AND ${PHOTO_INTAKE_OPEN_SQL}
          )
        RETURNING *
      `).bind(
        input.reservationExpiresAt,
        input.guestName,
        input.caption,
        existing.id,
        existing.objectKey,
        existing.id,
        existing.objectKey,
        input.eventId,
        input.createdAt,
      ).first<MediaRow>();
      if (!refreshed) throw await this.idempotentRefreshConflict(input);
      return mapMedia(refreshed);
    }

    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE media
        SET upload_state = 'reserved', reservation_expires_at = ?,
            guest_name = ?, caption = ?, original_filename = ?
        WHERE id = ? AND upload_state = 'failed' AND object_key = ?
          AND EXISTS (
            SELECT 1 FROM media_object_promotions AS p
            WHERE p.media_id = ? AND p.state = 'pending'
              AND p.source_object_key = ?
          )
          AND EXISTS (
            SELECT 1 FROM events
            WHERE id = ? AND deleted_at IS NULL AND ${PHOTO_INTAKE_OPEN_SQL}
              AND reserved_media_count + stored_media_count < ?
              AND reserved_bytes + stored_bytes + ? <= ?
          )
        RETURNING id
      `).bind(
        input.reservationExpiresAt,
        input.guestName,
        input.caption,
        input.originalFilename,
        existing.id,
        existing.objectKey,
        existing.id,
        existing.objectKey,
        input.eventId,
        input.createdAt,
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
    if ((results[0]?.results?.length ?? 0) === 1) return (await this.getById(existing.id))!;

    const raced = await this.getById(existing.id);
    if (raced && raced.uploadState !== 'failed') return this.refreshIdempotent(input, raced);
    const promotion = await this.getPromotion(existing.id);
    if (!promotion || promotion.state !== 'pending') throw await this.idempotentRefreshConflict(input);
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
            AND ${PHOTO_INTAKE_OPEN_SQL}
            AND reserved_media_count + stored_media_count < ?
            AND reserved_bytes + stored_bytes + ? <= ?
        `).bind(input.declaredByteSize, input.eventId, input.createdAt, MAX_EVENT_MEDIA, input.declaredByteSize, MAX_EVENT_BYTES),
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
    // One instant for the whole batch, taken from the request that built it, so
    // every capacity and schedule guard below answers the same question.
    const reservedAt = inputs[0]!.createdAt;
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
        FROM events WHERE id = ? AND deleted_at IS NULL AND ${PHOTO_INTAKE_OPEN_SQL}
      `).bind(eventId, reservedAt).first<{
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
              WHERE id = ? AND deleted_at IS NULL AND ${PHOTO_INTAKE_OPEN_SQL}
                AND reserved_media_count + stored_media_count + ? <= ?
                AND reserved_bytes + stored_bytes + ? <= ?
            `).bind(accepted.length, totalBytes, eventId, reservedAt, accepted.length, MAX_EVENT_MEDIA, totalBytes, MAX_EVENT_BYTES),
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
    metadata: {
      byteSize: number;
      width: number;
      height: number;
      objectKey?: string;
      source?: {
        etag: string;
        mimeType: SupportedImageType;
        sha256: string;
        finalEtag: string;
      };
    },
    storedAt: string,
    timeline: { capturedAt: string | null; timelineAt: string },
  ): Promise<MediaRecord> {
    if (timeline.timelineAt === MEDIA_TIMELINE_SENTINEL) {
      throw new Error('A stored photo requires a non-sentinel timeline instant.');
    }
    const current = await this.getById(id);
    if (!current) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The upload reservation no longer exists.', 404);
    const objectKey = metadata.objectKey ?? current.objectKey;
    if (current.uploadState === 'stored') {
      if (
        current.byteSize === metadata.byteSize
        && current.width === metadata.width
        && current.height === metadata.height
        && current.objectKey === objectKey
      ) return current;
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload was already finalized with different metadata.', 409);
    }
    if (current.uploadState !== 'reserved') {
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload can no longer be finalized.', 409);
    }

    const statements = [
      this.db.prepare(`
        UPDATE media
        SET object_key = ?, object_bucket_generation = CASE
              WHEN ? <> object_key THEN 'canonical' ELSE object_bucket_generation END,
            byte_size = ?, width = ?, height = ?, upload_state = 'stored',
            stored_at = ?, captured_at = ?, timeline_at = ?
            , preview_object_key = CASE WHEN ? <> object_key THEN NULL ELSE preview_object_key END
        WHERE id = ? AND upload_state = 'reserved' AND object_key = ?
          AND (
            ? = object_key OR EXISTS (
              SELECT 1 FROM media_object_promotions AS p
              WHERE p.media_id = media.id AND p.state = 'pending'
                AND p.source_object_key = media.object_key
            )
          )
        RETURNING id
      `).bind(
        objectKey,
        objectKey,
        metadata.byteSize,
        metadata.width,
        metadata.height,
        storedAt,
        timeline.capturedAt,
        timeline.timelineAt,
        objectKey,
        id,
        current.objectKey,
        objectKey,
      ),
      this.db.prepare(`
        UPDATE events
        SET reserved_media_count = reserved_media_count - 1,
            reserved_bytes = reserved_bytes - ?,
            stored_media_count = stored_media_count + 1,
            stored_bytes = stored_bytes + ?
        WHERE id = ? AND changes() = 1
      `).bind(current.declaredByteSize, metadata.byteSize, current.eventId),
    ];
    if (objectKey !== current.objectKey) {
      if (!metadata.source) throw new Error('Final object transition requires its validated source digest.');
      statements.push(this.db.prepare(`
        UPDATE media_object_promotions
        SET final_object_key = ?, source_etag = ?, source_mime_type = ?,
            source_byte_size = ?, source_sha256 = ?, source_width = ?, source_height = ?,
            final_etag = ?, target_verified_at = ?, state = 'cleanup_pending',
            final_pointer_committed = 1,
            claim_token = COALESCE(claim_token, ?), lease_expires_at = NULL,
            source_absent_since = NULL, updated_at = ?
        WHERE media_id = ? AND state = 'pending'
          AND source_object_key = ? AND changes() = 1
      `).bind(
        objectKey,
        metadata.source.etag,
        metadata.source.mimeType,
        metadata.byteSize,
        metadata.source.sha256,
        metadata.width,
        metadata.height,
        metadata.source.finalEtag,
        storedAt,
        crypto.randomUUID(),
        storedAt,
        id,
        current.objectKey,
      ));
    }
    const results = await this.db.batch(statements);
    if ((results[0]?.results?.length ?? 0) !== 1) return this.finalize(id, metadata, storedAt, timeline);
    if (objectKey !== current.objectKey && (results[2]?.meta.changes ?? 0) !== 1) {
      throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload changed while it was being finalized.', 409);
    }
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

  async setPublicationBulk(
    eventId: string,
    ids: readonly string[],
    expected: PublicationStatus,
    target: PublicationStatus,
    changedAt: string,
  ): Promise<MediaRecord[]> {
    const firstIdSlot = 4;
    const idPlaceholders = ids
      .map((_, index) => `?${firstIdSlot + index}`)
      .join(', ');
    const expectedSlot = firstIdSlot + ids.length;
    const countSlot = expectedSlot + 1;
    const result = await this.db.prepare(`
      UPDATE media
      SET publication_status = ?1, published_at = ?2
      WHERE event_id = ?3
        AND id IN (${idPlaceholders})
        AND upload_state = 'stored'
        AND publication_status = ?${expectedSlot}
        AND deleted_at IS NULL
        AND (
          SELECT COUNT(*)
          FROM media AS eligible
          WHERE eligible.event_id = ?3
            AND eligible.id IN (${idPlaceholders})
            AND eligible.upload_state = 'stored'
            AND eligible.publication_status = ?${expectedSlot}
            AND eligible.deleted_at IS NULL
        ) = ?${countSlot}
    `).bind(
      target,
      target === 'published' ? changedAt : null,
      eventId,
      ...ids,
      expected,
      ids.length,
    ).run();
    if ((result.meta.changes ?? 0) !== ids.length) {
      throw new ApiError(
        'MEDIA_STATE_CONFLICT',
        'One or more photos changed since you last viewed them. Refresh and try again.',
        409,
      );
    }
    const selected = await this.db.prepare(`
      SELECT * FROM media
      WHERE event_id = ? AND id IN (${ids.map(() => '?').join(', ')})
    `).bind(eventId, ...ids).all<MediaRow>();
    const byId = new Map(selected.results.map((row) => [row.id, mapMedia(row)]));
    return ids.map((id) => {
      const media = byId.get(id);
      if (!media) throw new Error('Bulk-updated media row was not found.');
      return media;
    });
  }

  async setPreviewObjectKey(id: string, previewObjectKey: string): Promise<MediaRecord> {
    const result = await this.db.prepare(`
      UPDATE media SET preview_object_key = ?
      WHERE id = ? AND upload_state = 'stored' AND deleted_at IS NULL
        AND object_bucket_generation = 'legacy'
      RETURNING *
    `).bind(previewObjectKey, id).all<MediaRow>();
    const row = result.results[0];
    if (!row || result.results.length !== 1) {
      throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo is no longer available.', 409);
    }
    return mapMedia(row);
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
    // The observed state can change between the read and CAS (for example,
    // reserved -> stored finalization). Retry against the winner so a 200
    // response never reports success while leaving an active photo behind.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getById(id);
      if (!current) throw new ApiError('MEDIA_STATE_CONFLICT', 'This photo no longer exists.', 404);
      if (current.uploadState === 'deleted') return current;

      const counterType = current.uploadState;
      const results = await this.db.batch([
        this.db.prepare(`
          UPDATE media SET upload_state = 'deleted', deleted_at = ?
          WHERE id = ? AND upload_state = ? AND deleted_at IS NULL
          RETURNING id
        `).bind(deletedAt, id, counterType),
        this.db.prepare(`
          UPDATE events SET
            reserved_media_count = reserved_media_count - ?,
            reserved_bytes = reserved_bytes - ?,
            stored_media_count = stored_media_count - ?,
            stored_bytes = stored_bytes - ?
          WHERE id = ? AND changes() = 1
        `).bind(
          counterType === 'reserved' ? 1 : 0,
          counterType === 'reserved' ? current.declaredByteSize : 0,
          counterType === 'stored' ? 1 : 0,
          counterType === 'stored' ? current.byteSize ?? 0 : 0,
          current.eventId,
        ),
        this.db.prepare(`
          UPDATE media_object_write_tombstones AS target
          SET suppression_started_at = COALESCE(suppression_started_at, ?),
              next_check_at = min(next_check_at, ?), updated_at = ?
          WHERE target.event_id = ? AND target.media_id = ?
            AND target.object_kind NOT IN ('export', 'cover')
            AND EXISTS (
              SELECT 1 FROM media AS m
              WHERE m.id = ? AND m.event_id = ?
                AND m.upload_state = 'deleted' AND m.deleted_at = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM media_object_promotions AS p
              WHERE p.media_id = ? AND p.event_id = ?
            )
            AND changes() = 1
        `).bind(
          deletedAt,
          deletedAt,
          deletedAt,
          current.eventId,
          id,
          id,
          current.eventId,
          deletedAt,
          id,
          current.eventId,
        ),
      ]);
      if ((results[0]?.results?.length ?? 0) === 1) return (await this.getById(id))!;
      const winner = await this.getById(id);
      if (winner?.uploadState === 'deleted') return winner;
    }
    throw new ApiError(
      'MEDIA_STATE_CONFLICT',
      'This photo changed while it was being removed. Try again.',
      409,
    );
  }
}

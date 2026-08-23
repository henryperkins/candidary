import { MAX_EVENT_BYTES } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { GuestbookRepository } from './guestbook';
import type { ExportMediaEntryRecord, ExportPartRecord, ExportRecord } from './types';

interface ExportRow {
  id: string;
  event_id: string;
  kind: ExportRecord['kind'];
  album_entries_json: string | null;
  state: ExportRecord['state'];
  snapshot_at: string;
  object_key: string | null;
  manifest_object_key: string | null;
  part_count: number;
  media_count: number;
  total_bytes: number;
  attempt: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  guestbook_html_object_key: string | null;
  guestbook_html_bytes: number | null;
  guestbook_html_sha256: string | null;
  guestbook_csv_object_key: string | null;
  guestbook_csv_bytes: number | null;
  guestbook_csv_sha256: string | null;
  guestbook_entry_count: number | null;
  guestbook_shared_count: number | null;
  guestbook_event_name: string | null;
  guestbook_event_date: string | null;
  guestbook_event_timezone: string | null;
  guestbook_prompt: string | null;
  guestbook_gallery_visible: number | null;
}

interface ExportPartRow {
  id: string;
  export_job_id: string;
  part_number: number;
  object_key: string;
  media_count: number;
  source_bytes: number;
  created_at: string;
}

interface ExportMediaEntryRow {
  export_job_id: string;
  media_id: string;
  object_key: string;
  object_bucket_generation: ExportMediaEntryRecord['objectBucketGeneration'];
  original_filename: string;
  mime_type: ExportMediaEntryRecord['mimeType'];
  declared_byte_size: number;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  guest_name: string;
  caption: string | null;
  publication_status: ExportMediaEntryRecord['publicationStatus'];
  created_at: string;
  published_at: string | null;
  album_tail_position: number | null;
}

export interface ReadyExportPart {
  partNumber: number;
  objectKey: string;
  mediaCount: number;
  sourceBytes: number;
}

export interface CreateExportRecord {
  id: string;
  eventId: string;
  snapshotAt: string;
  createdAt: string;
  /** Compatibility-only fixture path for pre-0015 photo exports. */
  mediaCount?: number;
  totalBytes?: number;
}

export interface GuestbookArtifactInventory {
  htmlObjectKey: string;
  htmlBytes: number;
  htmlSha256: string;
  csvObjectKey: string;
  csvBytes: number;
  csvSha256: string;
}

export interface ReadyExportInventory {
  manifestObjectKey: string | null;
  parts: ReadyExportPart[];
  guestbook: GuestbookArtifactInventory | null;
}

export type ExportRunClaim =
  | { owned: true; resumed: boolean; job: ExportRecord }
  | { owned: false; job: ExportRecord | null };

function mapExport(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    kind: row.kind,
    albumEntriesJson: row.album_entries_json,
    state: row.state,
    snapshotAt: row.snapshot_at,
    objectKey: row.object_key,
    manifestObjectKey: row.manifest_object_key,
    partCount: row.part_count,
    mediaCount: row.media_count,
    totalBytes: row.total_bytes,
    attempt: row.attempt,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    guestbookHtmlObjectKey: row.guestbook_html_object_key,
    guestbookHtmlBytes: row.guestbook_html_bytes,
    guestbookHtmlSha256: row.guestbook_html_sha256,
    guestbookCsvObjectKey: row.guestbook_csv_object_key,
    guestbookCsvBytes: row.guestbook_csv_bytes,
    guestbookCsvSha256: row.guestbook_csv_sha256,
    guestbookEntryCount: row.guestbook_entry_count,
    guestbookSharedCount: row.guestbook_shared_count,
    guestbookEventName: row.guestbook_event_name,
    guestbookEventDate: row.guestbook_event_date,
    guestbookEventTimezone: row.guestbook_event_timezone,
    guestbookPrompt: row.guestbook_prompt,
    guestbookGalleryVisible: row.guestbook_gallery_visible === null
      ? null
      : row.guestbook_gallery_visible === 1,
  };
}

function mapPart(row: ExportPartRow): ExportPartRecord {
  return {
    id: row.id,
    exportJobId: row.export_job_id,
    partNumber: row.part_number,
    objectKey: row.object_key,
    mediaCount: row.media_count,
    sourceBytes: row.source_bytes,
    createdAt: row.created_at,
  };
}

function mapMediaEntry(row: ExportMediaEntryRow): ExportMediaEntryRecord {
  return {
    exportJobId: row.export_job_id,
    id: row.media_id,
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
    publicationStatus: row.publication_status,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    albumTailPosition: row.album_tail_position,
  };
}

function artifactFieldsComplete(inventory: GuestbookArtifactInventory): boolean {
  return Boolean(
    inventory.htmlObjectKey && Number.isSafeInteger(inventory.htmlBytes) && inventory.htmlBytes >= 0
    && /^[a-f0-9]{64}$/u.test(inventory.htmlSha256)
    && inventory.csvObjectKey && Number.isSafeInteger(inventory.csvBytes) && inventory.csvBytes >= 0
    && /^[a-f0-9]{64}$/u.test(inventory.csvSha256),
  );
}

function photoPartsComplete(parts: ReadyExportPart[]): boolean {
  return parts.every((part, index) => (
    part.partNumber === index + 1
    && Boolean(part.objectKey)
    && Number.isSafeInteger(part.mediaCount)
    && part.mediaCount > 0
    && Number.isSafeInteger(part.sourceBytes)
    && part.sourceBytes >= 0
  ));
}

export class ExportsRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<ExportRecord | null> {
    const row = await this.db.prepare('SELECT * FROM export_jobs WHERE id = ?').bind(id).first<ExportRow>();
    return row ? mapExport(row) : null;
  }

  async createActive(input: CreateExportRecord): Promise<ExportRecord> {
    if (input.mediaCount !== undefined || input.totalBytes !== undefined) {
      try {
        await this.db.prepare(`
          INSERT INTO export_jobs (
            id, event_id, state, snapshot_at, media_count, total_bytes, attempt, created_at
          ) VALUES (?, ?, 'queued', ?, ?, ?, 1, ?)
        `).bind(
          input.id, input.eventId, input.snapshotAt,
          input.mediaCount ?? 0, input.totalBytes ?? 0, input.createdAt,
        ).run();
      } catch {
        throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
      }
      return (await this.getById(input.id))!;
    }
    const first = this.db.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, attempt, created_at,
        guestbook_entry_count, guestbook_shared_count, guestbook_event_name,
        guestbook_event_date, guestbook_event_timezone, guestbook_prompt,
        guestbook_gallery_visible
      )
      SELECT ?1, events.id, 'queued', ?3,
        (SELECT count(*) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND created_at <= ?3),
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND created_at <= ?3), 0),
        1, ?4,
        (SELECT count(*) FROM (
          SELECT id FROM guest_messages
            WHERE event_id = events.id AND deleted_at IS NULL AND created_at <= ?3
          UNION ALL
          SELECT id FROM media
            WHERE event_id = events.id AND upload_state = 'stored' AND deleted_at IS NULL
              AND created_at <= ?3 AND caption IS NOT NULL AND length(trim(caption)) > 0
        )),
        (SELECT count(*) FROM (
          SELECT id FROM guest_messages
            WHERE event_id = events.id AND deleted_at IS NULL AND created_at <= ?3
              AND moderation_status = 'approved'
          UNION ALL
          SELECT id FROM media
            WHERE event_id = events.id AND upload_state = 'stored' AND deleted_at IS NULL
              AND created_at <= ?3 AND caption IS NOT NULL AND length(trim(caption)) > 0
              AND publication_status = 'published' AND events.gallery_visible = 1
        )),
        events.name, events.event_date, events.event_timezone, events.guestbook_prompt,
        events.gallery_visible
      FROM events
      WHERE events.id = ?2 AND events.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM export_jobs WHERE event_id = events.id AND state IN ('queued', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND created_at <= ?3
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || events.id || '/media/final/' || media.id
            )
        )
        AND COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND created_at <= ?3), 0) <= ?5
        AND (
          EXISTS (SELECT 1 FROM media
            WHERE event_id = events.id AND upload_state = 'stored'
              AND deleted_at IS NULL AND created_at <= ?3)
          OR EXISTS (SELECT 1 FROM guest_messages
            WHERE event_id = events.id AND deleted_at IS NULL AND created_at <= ?3)
        )
    `).bind(input.id, input.eventId, input.snapshotAt, input.createdAt, MAX_EVENT_BYTES);
    try {
      const results = await this.db.batch([
        first,
        this.db.prepare(`
          INSERT INTO export_media_entries (
            export_job_id, media_id, object_key, object_bucket_generation,
            original_filename, mime_type,
            declared_byte_size, byte_size, width, height, guest_name, caption,
            publication_status, created_at, published_at
          )
          SELECT ?1, id, object_key, object_bucket_generation, original_filename, mime_type,
            declared_byte_size, byte_size, width, height, guest_name, caption,
            publication_status, created_at, published_at
          FROM media
          WHERE event_id = ?2 AND upload_state = 'stored' AND deleted_at IS NULL
            AND created_at <= ?3 AND EXISTS (
              SELECT 1 FROM export_jobs
              WHERE id = ?1 AND event_id = ?2 AND snapshot_at = ?3 AND state = 'queued'
            )
            AND object_bucket_generation = 'canonical'
            AND object_key = 'events/' || ?2 || '/media/final/' || media.id
          ORDER BY created_at ASC, id ASC
        `).bind(input.id, input.eventId, input.snapshotAt),
        ...new GuestbookRepository(this.db).snapshotStatements({
          exportJobId: input.id,
          eventId: input.eventId,
          snapshotAt: input.snapshotAt,
        }),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 1) return (await this.getById(input.id))!;
    } catch (error) {
      const active = await this.hasActive(input.eventId);
      if (active) throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
      throw error;
    }

    if (await this.hasActive(input.eventId)) {
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
    }
    const discriminators = await this.db.prepare(`
      SELECT
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL
            AND created_at <= ?2), 0) AS total_bytes,
        CASE WHEN EXISTS (SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL
            AND created_at <= ?2
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || ?1 || '/media/final/' || media.id
            ))
          THEN 1 ELSE 0 END AS needs_media_upgrade,
        CASE WHEN EXISTS (SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL
            AND created_at <= ?2) OR EXISTS (SELECT 1 FROM guest_messages
          WHERE event_id = ?1 AND deleted_at IS NULL AND created_at <= ?2)
          THEN 0 ELSE 1 END AS is_empty
    `).bind(input.eventId, input.snapshotAt).first<{
      total_bytes: number;
      needs_media_upgrade: number;
      is_empty: number;
    }>();
    if (discriminators?.needs_media_upgrade === 1) {
      throw new ApiError(
        'EXPORT_MEDIA_UPGRADE_REQUIRED',
        'Some photos need a storage upgrade before they can be exported. Try again after the upgrade is complete.',
        409,
      );
    }
    if ((discriminators?.total_bytes ?? 0) > MAX_EVENT_BYTES) {
      throw new ApiError('EXPORT_LIMIT_EXCEEDED', 'This event is too large to export.', 409);
    }
    throw new ApiError('EXPORT_EMPTY', 'Deliver a photo or guestbook entry before preparing an export.', 409);
  }

  async createAlbumActive(input: CreateExportRecord): Promise<ExportRecord> {
    const first = this.db.prepare(`
      INSERT INTO export_jobs (
        id, event_id, kind, album_entries_json, state, snapshot_at,
        media_count, total_bytes, attempt, created_at
      )
      SELECT ?1, events.id, 'album', json(event_albums.entries), 'queued', ?3,
        (SELECT count(*) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND favorited_at IS NOT NULL AND created_at <= ?3),
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND favorited_at IS NOT NULL AND created_at <= ?3), 0),
        1, ?4
      FROM events
      JOIN event_albums ON event_albums.event_id = events.id
      WHERE events.id = ?2 AND events.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM export_jobs
          WHERE event_id = events.id AND state IN ('queued', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND favorited_at IS NOT NULL AND created_at <= ?3
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || events.id || '/media/final/' || media.id
            )
        )
        AND COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND favorited_at IS NOT NULL AND created_at <= ?3), 0) <= ?5
        AND EXISTS (
          SELECT 1 FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND favorited_at IS NOT NULL AND created_at <= ?3
        )
    `).bind(input.id, input.eventId, input.snapshotAt, input.createdAt, MAX_EVENT_BYTES);
    try {
      const results = await this.db.batch([
        first,
        this.db.prepare(`
          INSERT INTO export_media_entries (
            export_job_id, media_id, object_key, object_bucket_generation,
            original_filename, mime_type, declared_byte_size, byte_size,
            width, height, guest_name, caption, publication_status, created_at,
            published_at, album_tail_position
          )
          SELECT ?1, id, object_key, object_bucket_generation, original_filename, mime_type,
            declared_byte_size, byte_size, width, height, guest_name, caption,
            publication_status, created_at, published_at,
            row_number() OVER (ORDER BY timeline_at ASC, id ASC)
          FROM media
          WHERE event_id = ?2 AND upload_state = 'stored' AND deleted_at IS NULL
            AND favorited_at IS NOT NULL AND created_at <= ?3
            AND object_bucket_generation = 'canonical'
            AND object_key = 'events/' || ?2 || '/media/final/' || media.id
            AND EXISTS (
              SELECT 1 FROM export_jobs
              WHERE id = ?1 AND event_id = ?2 AND kind = 'album'
                AND snapshot_at = ?3 AND state = 'queued'
            )
          ORDER BY timeline_at ASC, id ASC
        `).bind(input.id, input.eventId, input.snapshotAt),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 1) return (await this.getById(input.id))!;
    } catch (error) {
      if (await this.hasActive(input.eventId)) {
        throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
      }
      throw error;
    }

    if (await this.hasActive(input.eventId)) {
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
    }
    const discriminators = await this.db.prepare(`
      SELECT
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL
            AND favorited_at IS NOT NULL AND created_at <= ?2), 0) AS total_bytes,
        CASE WHEN EXISTS (
          SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL
            AND favorited_at IS NOT NULL AND created_at <= ?2
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || ?1 || '/media/final/' || media.id
            )
        ) THEN 1 ELSE 0 END AS needs_media_upgrade,
        CASE WHEN EXISTS (
          SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL
            AND favorited_at IS NOT NULL AND created_at <= ?2
        ) THEN 0 ELSE 1 END AS is_empty
    `).bind(input.eventId, input.snapshotAt).first<{
      total_bytes: number;
      needs_media_upgrade: number;
      is_empty: number;
    }>();
    if (discriminators?.needs_media_upgrade === 1) {
      throw new ApiError(
        'EXPORT_MEDIA_UPGRADE_REQUIRED',
        'Some album photos need a storage upgrade before they can be exported. Try again after the upgrade is complete.',
        409,
      );
    }
    if ((discriminators?.total_bytes ?? 0) > MAX_EVENT_BYTES) {
      throw new ApiError('EXPORT_LIMIT_EXCEEDED', 'This album is too large to export.', 409);
    }
    throw new ApiError('EXPORT_EMPTY', 'Pick a photo before preparing an album export.', 409);
  }

  private async hasActive(eventId: string): Promise<boolean> {
    return Boolean(await this.db.prepare(`
      SELECT 1 FROM export_jobs WHERE event_id = ? AND state IN ('queued', 'running') LIMIT 1
    `).bind(eventId).first());
  }

  async listForEvent(eventId: string): Promise<ExportRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM export_jobs WHERE event_id = ? ORDER BY created_at DESC
    `).bind(eventId).all<ExportRow>();
    return result.results.map(mapExport);
  }

  async listParts(exportJobId: string): Promise<ExportPartRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM export_parts WHERE export_job_id = ? ORDER BY part_number ASC
    `).bind(exportJobId).all<ExportPartRow>();
    return result.results.map(mapPart);
  }

  async listMediaEntries(
    exportJobId: string,
    cursor?: { createdAt: string; mediaId: string },
    limit = 100,
  ): Promise<{
      entries: ExportMediaEntryRecord[];
      nextCursor: { createdAt: string; mediaId: string } | null;
    }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Export media page size must be between 1 and 100.');
    }
    const result = await this.db.prepare(`
      SELECT * FROM export_media_entries
      WHERE export_job_id = ?1
        ${cursor ? `AND (created_at > ?2 OR (created_at = ?2 AND media_id > ?3))` : ''}
      ORDER BY created_at ASC, media_id ASC
      LIMIT ?${cursor ? 4 : 2}
    `).bind(
      exportJobId,
      ...(cursor ? [cursor.createdAt, cursor.mediaId] : []),
      limit + 1,
    ).all<ExportMediaEntryRow>();
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return {
      entries: rows.map(mapMediaEntry),
      nextCursor: result.results.length > limit && last
        ? { createdAt: last.created_at, mediaId: last.media_id }
        : null,
    };
  }

  async listAlbumMediaEntries(
    exportJobId: string,
    afterPosition = 0,
    limit = 100,
  ): Promise<{
      entries: ExportMediaEntryRecord[];
      nextPosition: number | null;
    }> {
    if (!Number.isSafeInteger(afterPosition) || afterPosition < 0) {
      throw new Error('Album export cursor must be a non-negative integer.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Export media page size must be between 1 and 100.');
    }
    const result = await this.db.prepare(`
      SELECT * FROM export_media_entries
      WHERE export_job_id = ?1 AND album_tail_position > ?2
      ORDER BY album_tail_position ASC, media_id ASC
      LIMIT ?3
    `).bind(exportJobId, afterPosition, limit + 1).all<ExportMediaEntryRow>();
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return {
      entries: rows.map(mapMediaEntry),
      nextPosition: result.results.length > limit && last
        ? last.album_tail_position
        : null,
    };
  }

  async claimRunning(id: string, startedAt: string): Promise<ExportRunClaim> {
    const result = await this.db.prepare(`
      UPDATE export_jobs SET state = 'running', started_at = ?, error_code = NULL
      WHERE id = ? AND state = 'queued' AND EXISTS (
        SELECT 1 FROM events
        WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
      )
    `).bind(startedAt, id).run();
    const job = await this.getById(id);
    // A Workflow step may retry after its callback throws. Its event timestamp
    // is stable across those serialized retries, so the original owner may
    // resume while a distinct delivery (with a different token) remains a
    // non-owner.
    return job?.state === 'running' && job.startedAt === startedAt
      ? { owned: true, resumed: (result.meta.changes ?? 0) !== 1, job }
      : { owned: false, job };
  }

  async assertOwnedRunActive(id: string, startedAt: string): Promise<void> {
    const row = await this.db.prepare(`
      SELECT e.id AS event_id, e.deleted_at, j.state, j.started_at
      FROM export_jobs j
      LEFT JOIN events e ON e.id = j.event_id
      WHERE j.id = ?
    `).bind(id).first<{
      event_id: string | null;
      deleted_at: string | null;
      state: ExportRecord['state'];
      started_at: string | null;
    }>();
    if (!row || row.event_id === null || row.deleted_at !== null) throw new Error('EXPORT_EVENT_DELETED');
    if (row.state !== 'running' || row.started_at !== startedAt) {
      throw new Error('EXPORT_RUN_NOT_OWNED');
    }
  }

  async markReady(
    id: string,
    inventory: ReadyExportInventory,
    completedAt: string,
    expiresAt: string,
  ): Promise<ExportRecord> {
    const job = await this.getById(id);
    if (!job || job.state !== 'running') throw new Error('Export job was not running.');
    if (!photoPartsComplete(inventory.parts)) {
      throw new Error('Photo inventory parts are incomplete or out of order.');
    }
    const albumFormat = job.kind === 'album';
    const newCompleteFormat = !albumFormat && job.guestbookEntryCount !== null;
    if (albumFormat) {
      if (job.albumEntriesJson === null) {
        throw new Error('An album export requires frozen album order.');
      }
      if (inventory.guestbook !== null) {
        throw new Error('An album export cannot contain Guestbook inventory.');
      }
      if (!inventory.manifestObjectKey || !inventory.parts.length) {
        throw new Error('An album export requires a manifest and parts.');
      }
    } else if (newCompleteFormat) {
      if (job.guestbookSharedCount === null || job.guestbookEventName === null
        || job.guestbookEventDate === null || job.guestbookEventTimezone === null
        || job.guestbookPrompt === null || job.guestbookGalleryVisible === null) {
        throw new Error('A new-format export requires complete snapshot metadata.');
      }
      if (!inventory.guestbook || !artifactFieldsComplete(inventory.guestbook)) {
        throw new Error('A new-format export requires complete Guestbook inventory.');
      }
      if (job.mediaCount === 0 && (inventory.manifestObjectKey !== null || inventory.parts.length !== 0)) {
        throw new Error('A notes-only export cannot contain photo inventory.');
      }
      if (job.mediaCount > 0 && (!inventory.manifestObjectKey || !inventory.parts.length)) {
        throw new Error('A photo export requires a manifest and parts.');
      }
    } else if (!inventory.manifestObjectKey || !inventory.parts.length) {
      throw new Error('A legacy export requires a manifest and parts.');
    }
    if (inventory.parts.reduce((count, part) => count + part.mediaCount, 0) !== job.mediaCount) {
      throw new Error('Photo inventory does not match the export snapshot.');
    }
    const guestbook = inventory.guestbook;
    const readyClaim = `ready:${crypto.randomUUID()}`;
    const statements = [
      // State ownership is the first statement in the transaction. The
      // temporary claim is never externally visible: D1 batch is atomic, and a
      // later failure rolls this transition back with every part mutation.
      this.db.prepare(`
        UPDATE export_jobs SET state = 'ready', error_code = ?
        WHERE id = ? AND state = 'running' AND EXISTS (
          SELECT 1 FROM events
          WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
        )
      `).bind(readyClaim, id),
      this.db.prepare(`
        DELETE FROM export_parts WHERE export_job_id = ? AND EXISTS (
          SELECT 1 FROM export_jobs
          WHERE id = ? AND state = 'ready' AND error_code = ?
        )
      `).bind(id, id, readyClaim),
      ...inventory.parts.map((part) => this.db.prepare(`
        INSERT INTO export_parts (
          id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM export_jobs
          WHERE id = ? AND state = 'ready' AND error_code = ?
        )
      `).bind(
        crypto.randomUUID(), id, part.partNumber, part.objectKey,
        part.mediaCount, part.sourceBytes, completedAt,
        id, readyClaim,
      )),
      this.db.prepare(`
        UPDATE export_jobs SET object_key = NULL, manifest_object_key = ?,
          part_count = ?, guestbook_html_object_key = ?, guestbook_html_bytes = ?,
          guestbook_html_sha256 = ?, guestbook_csv_object_key = ?, guestbook_csv_bytes = ?,
          guestbook_csv_sha256 = ?, completed_at = ?, expires_at = ?, error_code = NULL
        WHERE id = ? AND state = 'ready' AND error_code = ?
      `).bind(
        inventory.manifestObjectKey,
        inventory.parts.length,
        guestbook?.htmlObjectKey ?? null,
        guestbook?.htmlBytes ?? null,
        guestbook?.htmlSha256 ?? null,
        guestbook?.csvObjectKey ?? null,
        guestbook?.csvBytes ?? null,
        guestbook?.csvSha256 ?? null,
        completedAt,
        expiresAt,
        id,
        readyClaim,
      ),
    ];
    const results = await this.db.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results.at(-1)?.meta.changes ?? 0) !== 1) {
      const event = await this.db.prepare(`
        SELECT e.id AS event_id, e.deleted_at FROM export_jobs j
        LEFT JOIN events e ON e.id = j.event_id
        WHERE j.id = ?
      `).bind(id).first<{ event_id: string | null; deleted_at: string | null }>();
      if (!event || event.event_id === null || event.deleted_at !== null) {
        throw new Error('EXPORT_EVENT_DELETED');
      }
      throw new Error('Export job was not running.');
    }
    return (await this.getById(id))!;
  }

  async markFailed(id: string, errorCode: string): Promise<ExportRecord> {
    await this.db.prepare(`
      UPDATE export_jobs SET state = 'failed', error_code = ? WHERE id = ? AND state IN ('queued', 'running')
    `).bind(errorCode, id).run();
    return (await this.getById(id))!;
  }

  async retry(id: string): Promise<ExportRecord> {
    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db.prepare(`
          UPDATE export_jobs SET state = 'queued', attempt = attempt + 1, object_key = NULL,
            manifest_object_key = NULL, part_count = 0, error_code = NULL,
            guestbook_html_object_key = NULL, guestbook_html_bytes = NULL,
            guestbook_html_sha256 = NULL, guestbook_csv_object_key = NULL,
            guestbook_csv_bytes = NULL, guestbook_csv_sha256 = NULL,
            started_at = NULL, completed_at = NULL, expires_at = NULL
          WHERE id = ?1 AND state IN ('failed', 'expired')
            AND NOT EXISTS (
              SELECT 1 FROM export_jobs AS active
              WHERE active.event_id = export_jobs.event_id AND active.id <> export_jobs.id
                AND active.state IN ('queued', 'running')
            )
        `).bind(id),
        this.db.prepare('DELETE FROM export_parts WHERE export_job_id = ? AND changes() = 1').bind(id),
      ]);
    } catch (error) {
      if (await this.hasDifferentActive(id)) {
        throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
      }
      throw error;
    }
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      if (await this.hasDifferentActive(id)) {
        throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
      }
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'Only failed or expired exports can be retried.', 409);
    }
    return (await this.getById(id))!;
  }

  private async hasDifferentActive(id: string): Promise<boolean> {
    return Boolean(await this.db.prepare(`
      SELECT 1 FROM export_jobs AS active
      JOIN export_jobs AS candidate ON candidate.id = ?1
      WHERE active.event_id = candidate.event_id AND active.id <> candidate.id
        AND active.state IN ('queued', 'running')
      LIMIT 1
    `).bind(id).first());
  }

  async listExpiredReady(now: string): Promise<ExportRecord[]> {
    const expired = await this.db.prepare(`
      SELECT * FROM export_jobs WHERE state = 'ready' AND expires_at <= ? ORDER BY expires_at LIMIT 100
    `).bind(now).all<ExportRow>();
    return expired.results.map(mapExport);
  }

  async markExpired(id: string, now: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE export_jobs SET state = 'expired' WHERE id = ? AND state = 'ready' AND expires_at <= ?
    `).bind(id, now).run();
    return (result.meta.changes ?? 0) === 1;
  }
}

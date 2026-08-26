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
  execution_protocol: ExportRecord['executionProtocol'];
  execution_transition: number;
  execution_started_at: string | null;
  processed_media_count: number | null;
  processed_bytes: number | null;
  progress_updated_at: string | null;
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

export interface ExportRunOwner {
  id: string;
  executionProtocol: 'attempt-v2';
  attempt: number;
  executionStartedAt: string;
}

export type ExportRunClaim =
  | { status: 'claimed'; owner: ExportRunOwner; job: ExportRecord }
  | { status: 'resumed'; owner: ExportRunOwner; job: ExportRecord }
  | { status: 'lost'; job: ExportRecord | null };

export type ExportRunActivity =
  | { status: 'active'; job: ExportRecord }
  | { status: 'event-deleted'; job: ExportRecord }
  | { status: 'lost'; job: ExportRecord | null };

export interface ExportOwnedTransition {
  changed: boolean;
  job: ExportRecord | null;
}

export interface ExportArtifactInventory {
  objectKey: string | null;
  manifestObjectKey: string | null;
  guestbookHtmlObjectKey: string | null;
  guestbookCsvObjectKey: string | null;
  parts: readonly ReadyExportPart[];
}

export interface ExportExpiryCandidate {
  id: string;
  executionProtocol: 'legacy' | 'attempt-v2';
  attempt: number;
  executionTransition: number;
  expiresAt: string;
}

export interface ExpiredArtifactInventoryCandidate extends ExportExpiryCandidate {
  inventory: ExportArtifactInventory;
}

export type ExportExpiryResult =
  | { changed: false; job: ExportRecord | null }
  | { changed: true; job: ExportRecord; cleanup: ExpiredArtifactInventoryCandidate };

/**
 * Result of a guarded dispatch-failure write. `changed` is true only when the
 * exact pristine attempt lost its Workflow dispatch; `job` is the post-fence
 * row used to reconcile a concurrent claim, retry, artifact write, or delete.
 */
export interface ExportDispatchFailureFence {
  changed: boolean;
  job: ExportRecord | null;
}

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
    executionProtocol: row.execution_protocol,
    executionTransition: row.execution_transition,
    executionStartedAt: row.execution_started_at,
    processedMediaCount: row.processed_media_count,
    processedBytes: row.processed_bytes,
    progressUpdatedAt: row.progress_updated_at,
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

function batchRow<T>(result: D1Result | undefined): T | null {
  return (result?.results[0] as T | undefined) ?? null;
}

function albumGuestbookFieldsEmpty(job: ExportRecord): boolean {
  return job.guestbookEntryCount === null
    && job.guestbookSharedCount === null
    && job.guestbookEventName === null
    && job.guestbookEventDate === null
    && job.guestbookEventTimezone === null
    && job.guestbookPrompt === null
    && job.guestbookGalleryVisible === null
    && job.guestbookHtmlObjectKey === null
    && job.guestbookHtmlBytes === null
    && job.guestbookHtmlSha256 === null
    && job.guestbookCsvObjectKey === null
    && job.guestbookCsvBytes === null
    && job.guestbookCsvSha256 === null;
}

/**
 * Whether this photo's exact source object may still be frozen into a snapshot.
 *
 * A suppressed tombstone means the bytes are on their way out — from a guest's
 * permanent deletion, a completed promotion, or expiry cleanup — and an export
 * that froze them anyway would fail at the read with nothing to say. Filtering
 * here is the difference between a smaller export and a broken one.
 */
const UNSUPPRESSED_SOURCE_SQL = `
  NOT EXISTS (
    SELECT 1 FROM media_object_write_tombstones AS t
    WHERE t.bucket_generation = media.object_bucket_generation
      AND t.object_key = media.object_key
      AND t.suppression_started_at IS NOT NULL
  )
`;

const EXPORT_PROTOCOL_ADMITTED_SQL = `
  EXISTS (
    SELECT 1 FROM export_protocol_admission
    WHERE singleton = 1 AND state = 'open'
      AND worker_version_id IS NOT NULL AND admitted_at IS NOT NULL
  )
`;

function exportProtocolPaused(): ApiError {
  return new ApiError(
    'EXPORT_FAILED',
    'Export preparation is temporarily paused for a release. Try again shortly.',
    503,
  );
}

/**
 * The eligible source set for one export kind, as a WHERE clause over `media`.
 *
 * The same text serves the entry snapshot and both halves of the set-equality
 * check below, so the three can never drift into disagreeing about which photos
 * this export was supposed to contain. `?2` is the event, `?3` the snapshot
 * instant; a complete export takes everything delivered by then, an album export
 * only what was picked by then.
 */
function eligibleSourceSql(kind: 'complete' | 'album'): string {
  return `
    media.event_id = ?2
    AND media.upload_state = 'stored'
    AND media.deleted_at IS NULL
    AND media.trashed_at IS NULL
    AND media.created_at <= ?3
    ${kind === 'album' ? 'AND media.stored_at <= ?3 AND media.favorited_at <= ?3' : ''}
    AND media.object_bucket_generation = 'canonical'
    AND media.object_key = 'events/' || ?2 || '/media/final/' || media.id
    AND ${UNSUPPRESSED_SOURCE_SQL}
  `;
}

/**
 * The set-equality sentinel that closes export creation.
 *
 * `media_count` was computed by the first statement and the entries were frozen
 * by the second; between them a concurrent trash, guest deletion, or promotion
 * could make the two disagree. Both set differences are checked, not only the
 * cardinality, because two different photos produce the same count. Failing
 * assigns NULL to a NOT NULL column, which aborts the whole D1 batch — neither a
 * pre-read nor a post-commit count could make that claim.
 *
 * A frozen zero-photo snapshot satisfies it exactly when both sets are empty,
 * which is what keeps a legacy or notes-only export honest rather than special.
 */
function creationSentinel(
  db: D1Database,
  kind: 'complete' | 'album',
  jobId: string,
  eventId: string,
  snapshotAt: string,
) {
  const eligible = eligibleSourceSql(kind);
  return db.prepare(`
    UPDATE export_jobs
    SET media_count = CASE WHEN (
          (SELECT count(*) FROM export_media_entries WHERE export_job_id = ?1) = media_count
          AND NOT EXISTS (
            SELECT 1 FROM export_media_entries AS entry
            WHERE entry.export_job_id = ?1
              AND NOT EXISTS (
                SELECT 1 FROM media WHERE media.id = entry.media_id AND ${eligible}
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM media
            WHERE ${eligible}
              AND NOT EXISTS (
                SELECT 1 FROM export_media_entries AS entry
                WHERE entry.export_job_id = ?1 AND entry.media_id = media.id
              )
          )
        ) THEN media_count ELSE NULL END
    WHERE id = ?1
  `).bind(jobId, eventId, snapshotAt);
}

export class ExportsRepository {
  constructor(private readonly db: D1Database) {}

  async getById(id: string): Promise<ExportRecord | null> {
    const row = await this.db.prepare('SELECT * FROM export_jobs WHERE id = ?').bind(id).first<ExportRow>();
    return row ? mapExport(row) : null;
  }

  /**
   * Freeze one complete export.
   *
   * The pre-0015 fixture path that used to stand here — insert a job with a
   * caller-supplied count and no frozen entries — is gone, because migration
   * 0019 makes that job shape impossible: a queued export with no
   * `export_media_entries` behind it is exactly the one whose Workflow reads
   * live media instead of a snapshot, and nothing may create one again. Tests
   * that need a job without going through intake seed one directly.
   */
  async createActive(input: CreateExportRecord): Promise<ExportRecord> {
    const first = this.db.prepare(`
      INSERT INTO export_jobs (
        id, event_id, state, snapshot_at, media_count, total_bytes, attempt, created_at,
        guestbook_entry_count, guestbook_shared_count, guestbook_event_name,
        guestbook_event_date, guestbook_event_timezone, guestbook_prompt,
        guestbook_gallery_visible, execution_protocol
      )
      SELECT ?1, events.id, 'queued', ?3,
        (SELECT count(*) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3),
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3), 0),
        1, ?4,
        (SELECT count(*) FROM (
          SELECT id FROM guest_messages
            WHERE event_id = events.id AND deleted_at IS NULL AND created_at <= ?3
          UNION ALL
          SELECT id FROM media
            WHERE event_id = events.id AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
              AND created_at <= ?3 AND caption IS NOT NULL AND length(trim(caption)) > 0
        )),
        (SELECT count(*) FROM (
          SELECT id FROM guest_messages
            WHERE event_id = events.id AND deleted_at IS NULL AND created_at <= ?3
              AND moderation_status = 'approved'
          UNION ALL
          SELECT id FROM media
            WHERE event_id = events.id AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
              AND created_at <= ?3 AND caption IS NOT NULL AND length(trim(caption)) > 0
              AND publication_status = 'published' AND events.gallery_visible = 1
        )),
        events.name, events.event_date, events.event_timezone, events.guestbook_prompt,
        events.gallery_visible, 'attempt-v2'
      FROM events
      WHERE events.id = ?2 AND events.deleted_at IS NULL
        AND ${EXPORT_PROTOCOL_ADMITTED_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM export_jobs WHERE event_id = events.id AND state IN ('queued', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || events.id || '/media/final/' || media.id
            )
        )
        AND COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3), 0) <= ?5
        AND EXISTS (SELECT 1 FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3)
    `).bind(input.id, input.eventId, input.snapshotAt, input.createdAt, MAX_EVENT_BYTES);
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
          WHERE event_id = ?2 AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
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
        creationSentinel(this.db, 'complete', input.id, input.eventId, input.snapshotAt),
        this.db.prepare(`
          SELECT
            CASE WHEN ${EXPORT_PROTOCOL_ADMITTED_SQL} THEN 1 ELSE 0 END AS protocol_admitted,
            CASE WHEN EXISTS (
              SELECT 1 FROM export_jobs
              WHERE event_id = ?1 AND id <> ?2 AND state IN ('queued', 'running')
            ) THEN 1 ELSE 0 END AS active_conflict
        `).bind(input.eventId, input.id),
      ]);
    if ((results[0]?.meta.changes ?? 0) === 1) return (await this.getById(input.id))!;
    const diagnostic = batchRow<{ protocol_admitted: number; active_conflict: number }>(
      results.at(-1),
    );
    if (diagnostic?.protocol_admitted !== 1) throw exportProtocolPaused();
    if (diagnostic.active_conflict === 1) {
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
    }
    const discriminators = await this.db.prepare(`
      SELECT
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
            AND created_at <= ?2), 0) AS total_bytes,
        CASE WHEN EXISTS (SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
            AND created_at <= ?2
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || ?1 || '/media/final/' || media.id
            ))
          THEN 1 ELSE 0 END AS needs_media_upgrade,
        CASE WHEN EXISTS (SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
            AND created_at <= ?2)
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
    throw new ApiError('EXPORT_EMPTY', 'Deliver a photo before preparing an export.', 409);
  }

  async createAlbumActive(input: CreateExportRecord): Promise<ExportRecord> {
    const first = this.db.prepare(`
      INSERT INTO export_jobs (
        id, event_id, kind, album_entries_json, state, snapshot_at,
        media_count, total_bytes, attempt, created_at, execution_protocol
      )
      SELECT ?1, events.id, 'album',
        CASE
          WHEN json_valid(event_albums.entries) THEN CASE
            WHEN json_type(event_albums.entries) = 'array' THEN json(event_albums.entries)
            ELSE '[]'
          END
          ELSE '[]'
        END,
        'queued', ?3,
        (SELECT count(*) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3
            AND stored_at <= ?3 AND favorited_at <= ?3),
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3
            AND stored_at <= ?3 AND favorited_at <= ?3), 0),
        1, ?4, 'attempt-v2'
      FROM events
      JOIN event_albums ON event_albums.event_id = events.id
      WHERE events.id = ?2 AND events.deleted_at IS NULL
        AND ${EXPORT_PROTOCOL_ADMITTED_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM export_jobs
          WHERE event_id = events.id AND state IN ('queued', 'running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3
            AND stored_at <= ?3 AND favorited_at <= ?3
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || events.id || '/media/final/' || media.id
            )
        )
        AND COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3
            AND stored_at <= ?3 AND favorited_at <= ?3), 0) <= ?5
        AND EXISTS (
          SELECT 1 FROM media
          WHERE event_id = events.id AND upload_state = 'stored'
            AND deleted_at IS NULL AND trashed_at IS NULL AND created_at <= ?3
            AND stored_at <= ?3 AND favorited_at <= ?3
        )
    `).bind(input.id, input.eventId, input.snapshotAt, input.createdAt, MAX_EVENT_BYTES);
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
          WHERE ${eligibleSourceSql('album')}
            AND EXISTS (
              SELECT 1 FROM export_jobs
              WHERE id = ?1 AND event_id = ?2 AND kind = 'album'
                AND snapshot_at = ?3 AND state = 'queued'
            )
          ORDER BY timeline_at ASC, id ASC
        `).bind(input.id, input.eventId, input.snapshotAt),
        creationSentinel(this.db, 'album', input.id, input.eventId, input.snapshotAt),
        this.db.prepare(`
          SELECT
            CASE WHEN ${EXPORT_PROTOCOL_ADMITTED_SQL} THEN 1 ELSE 0 END AS protocol_admitted,
            CASE WHEN EXISTS (
              SELECT 1 FROM export_jobs
              WHERE event_id = ?1 AND id <> ?2 AND state IN ('queued', 'running')
            ) THEN 1 ELSE 0 END AS active_conflict
        `).bind(input.eventId, input.id),
      ]);
    if ((results[0]?.meta.changes ?? 0) === 1) return (await this.getById(input.id))!;
    const diagnostic = batchRow<{ protocol_admitted: number; active_conflict: number }>(
      results.at(-1),
    );
    if (diagnostic?.protocol_admitted !== 1) throw exportProtocolPaused();
    if (diagnostic.active_conflict === 1) {
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
    }
    const discriminators = await this.db.prepare(`
      SELECT
        COALESCE((SELECT sum(COALESCE(byte_size, declared_byte_size)) FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
            AND created_at <= ?2 AND stored_at <= ?2 AND favorited_at <= ?2), 0) AS total_bytes,
        CASE WHEN EXISTS (
          SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
            AND created_at <= ?2 AND stored_at <= ?2 AND favorited_at <= ?2
            AND (
              object_bucket_generation <> 'canonical'
              OR object_key <> 'events/' || ?1 || '/media/final/' || media.id
            )
        ) THEN 1 ELSE 0 END AS needs_media_upgrade,
        CASE WHEN EXISTS (
          SELECT 1 FROM media
          WHERE event_id = ?1 AND upload_state = 'stored' AND deleted_at IS NULL AND trashed_at IS NULL
            AND created_at <= ?2 AND stored_at <= ?2 AND favorited_at <= ?2
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

  async listForEvent(eventId: string): Promise<ExportRecord[]> {
    const result = await this.db.prepare(`
      SELECT * FROM export_jobs WHERE event_id = ? ORDER BY created_at DESC, id DESC
    `).bind(eventId).all<ExportRow>();
    return result.results.map(mapExport);
  }

  async listLatestForManager(eventId: string): Promise<ExportRecord[]> {
    const result = await this.db.prepare(`
      WITH ranked AS (
        SELECT id, row_number() OVER (
          PARTITION BY kind ORDER BY created_at DESC, id DESC
        ) AS manager_rank
        FROM export_jobs
        WHERE event_id = ?
      )
      SELECT export_jobs.*
      FROM export_jobs
      JOIN ranked ON ranked.id = export_jobs.id
      WHERE ranked.manager_rank = 1
      ORDER BY export_jobs.created_at DESC, export_jobs.id DESC
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

  async claimRunning(id: string, attempt: number, executionStartedAt: string): Promise<ExportRunClaim> {
    const owner: ExportRunOwner = {
      id,
      executionProtocol: 'attempt-v2',
      attempt,
      executionStartedAt,
    };
    const result = await this.db.prepare(`
      UPDATE export_jobs
      SET state = 'running', execution_transition = execution_transition + 1,
        execution_started_at = ?3, processed_media_count = 0,
        processed_bytes = 0, progress_updated_at = ?3, error_code = NULL
      WHERE id = ?1 AND state = 'queued' AND execution_protocol = 'attempt-v2'
        AND attempt = ?2 AND execution_started_at IS NULL
        AND processed_media_count IS NULL AND processed_bytes IS NULL
        AND progress_updated_at IS NULL AND started_at IS NULL
        AND object_key IS NULL AND manifest_object_key IS NULL AND part_count = 0
        AND guestbook_html_object_key IS NULL AND guestbook_html_bytes IS NULL
        AND guestbook_html_sha256 IS NULL AND guestbook_csv_object_key IS NULL
        AND guestbook_csv_bytes IS NULL AND guestbook_csv_sha256 IS NULL
        AND completed_at IS NULL AND expires_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM export_parts WHERE export_job_id = ?1)
        AND EXISTS (
        SELECT 1 FROM events
        WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
      )
    `).bind(id, attempt, executionStartedAt).run();
    const job = await this.getById(id);
    const exactOwner = job?.state === 'running'
      && job.executionProtocol === owner.executionProtocol
      && job.attempt === owner.attempt
      && job.executionStartedAt === owner.executionStartedAt;
    if (!job || !exactOwner) return { status: 'lost', job };
    return (result.meta.changes ?? 0) === 1
      ? { status: 'claimed', owner, job }
      : { status: 'resumed', owner, job };
  }

  async assertOwnedRunActive(owner: ExportRunOwner): Promise<ExportRunActivity> {
    const row = await this.db.prepare(`
      SELECT j.*, e.id AS owner_event_id, e.deleted_at AS owner_event_deleted_at
      FROM export_jobs j
      LEFT JOIN events e ON e.id = j.event_id
      WHERE j.id = ?
    `).bind(owner.id).first<ExportRow & {
      owner_event_id: string | null;
      owner_event_deleted_at: string | null;
    }>();
    if (!row) return { status: 'lost', job: null };
    const job = mapExport(row);
    if (job.state !== 'running'
      || job.executionProtocol !== owner.executionProtocol
      || job.attempt !== owner.attempt
      || job.executionStartedAt !== owner.executionStartedAt) {
      return { status: 'lost', job };
    }
    if (row.owner_event_id === null || row.owner_event_deleted_at !== null) {
      return { status: 'event-deleted', job };
    }
    return { status: 'active', job };
  }

  async recordProgress(
    owner: ExportRunOwner,
    progress: {
      processedMediaCount: number;
      processedBytes: number;
      progressUpdatedAt: string;
    },
  ): Promise<boolean> {
    if (!Number.isSafeInteger(progress.processedMediaCount) || progress.processedMediaCount < 0
      || !Number.isSafeInteger(progress.processedBytes) || progress.processedBytes < 0
      || !progress.progressUpdatedAt) {
      return false;
    }
    const result = await this.db.prepare(`
      UPDATE export_jobs
      SET processed_media_count = ?5, processed_bytes = ?6, progress_updated_at = ?7
      WHERE id = ?1 AND state = 'running' AND execution_protocol = ?2
        AND attempt = ?3 AND execution_started_at = ?4
        AND processed_media_count IS NOT NULL AND processed_bytes IS NOT NULL
        AND ?5 >= processed_media_count AND ?6 >= processed_bytes
        AND (?5 > processed_media_count OR ?6 > processed_bytes)
        AND ?5 <= media_count AND ?6 <= total_bytes
    `).bind(
      owner.id,
      owner.executionProtocol,
      owner.attempt,
      owner.executionStartedAt,
      progress.processedMediaCount,
      progress.processedBytes,
      progress.progressUpdatedAt,
    ).run();
    if ((result.meta.changes ?? 0) === 1) return true;
    const job = await this.getById(owner.id);
    return Boolean(job
      && job.state === 'running'
      && job.executionProtocol === owner.executionProtocol
      && job.attempt === owner.attempt
      && job.executionStartedAt === owner.executionStartedAt
      && job.processedMediaCount === progress.processedMediaCount
      && job.processedBytes === progress.processedBytes);
  }

  async resetOwnedRunProgress(owner: ExportRunOwner, progressUpdatedAt: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE export_jobs
      SET processed_media_count = 0, processed_bytes = 0, progress_updated_at = ?5
      WHERE id = ?1 AND state = 'running' AND execution_protocol = ?2
        AND attempt = ?3 AND execution_started_at = ?4
    `).bind(
      owner.id,
      owner.executionProtocol,
      owner.attempt,
      owner.executionStartedAt,
      progressUpdatedAt,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async markReady(
    owner: ExportRunOwner,
    inventory: ReadyExportInventory,
    completedAt: string,
    expiresAt: string,
  ): Promise<ExportOwnedTransition> {
    const job = await this.getById(owner.id);
    const exactOwner = job?.state === 'running'
      && job.executionProtocol === owner.executionProtocol
      && job.attempt === owner.attempt
      && job.executionStartedAt === owner.executionStartedAt;
    if (!job || !exactOwner) return { changed: false, job };
    if (!photoPartsComplete(inventory.parts)) {
      throw new Error('Photo inventory parts are incomplete or out of order.');
    }
    const albumFormat = job.kind === 'album';
    const newCompleteFormat = !albumFormat
      && job.guestbookEntryCount !== null
      && job.guestbookSharedCount !== null
      && job.guestbookEventName !== null
      && job.guestbookEventDate !== null
      && job.guestbookEventTimezone !== null
      && job.guestbookPrompt !== null
      && job.guestbookGalleryVisible !== null;
    if (albumFormat) {
      if (job.albumEntriesJson === null) {
        throw new Error('An album export requires frozen album order.');
      }
      if (!albumGuestbookFieldsEmpty(job) || inventory.guestbook !== null) {
        throw new Error('An album export cannot contain Guestbook data.');
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
    if (inventory.parts.reduce((bytes, part) => bytes + part.sourceBytes, 0) !== job.totalBytes) {
      throw new Error('Photo inventory bytes do not match the export snapshot.');
    }
    const guestbook = inventory.guestbook;
    const readyClaim = `ready:${crypto.randomUUID()}`;
    const statements = [
      // State ownership is the first statement in the transaction. The
      // temporary claim is never externally visible: D1 batch is atomic, and a
      // later failure rolls this transition back with every part mutation.
      this.db.prepare(`
        UPDATE export_jobs
        SET state = 'ready', execution_transition = execution_transition + 1,
          error_code = ?5, completed_at = ?6, expires_at = ?7
        WHERE id = ?1 AND state = 'running' AND execution_protocol = ?2
          AND attempt = ?3 AND execution_started_at = ?4
          AND processed_media_count = media_count AND processed_bytes = total_bytes
          AND EXISTS (
          SELECT 1 FROM events
          WHERE events.id = export_jobs.event_id AND events.deleted_at IS NULL
        )
      `).bind(
        owner.id,
        owner.executionProtocol,
        owner.attempt,
        owner.executionStartedAt,
        readyClaim,
        completedAt,
        expiresAt,
      ),
      this.db.prepare(`
        DELETE FROM export_parts WHERE export_job_id = ? AND EXISTS (
          SELECT 1 FROM export_jobs
          WHERE id = ? AND state = 'ready' AND error_code = ?
        )
      `).bind(owner.id, owner.id, readyClaim),
      ...inventory.parts.map((part) => this.db.prepare(`
        INSERT INTO export_parts (
          id, export_job_id, part_number, object_key, media_count, source_bytes, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM export_jobs
          WHERE id = ? AND state = 'ready' AND error_code = ?
        )
      `).bind(
        crypto.randomUUID(), owner.id, part.partNumber, part.objectKey,
        part.mediaCount, part.sourceBytes, completedAt,
        owner.id, readyClaim,
      )),
      this.db.prepare(`
        UPDATE export_jobs SET object_key = NULL, manifest_object_key = ?,
          part_count = ?, guestbook_html_object_key = ?, guestbook_html_bytes = ?,
          guestbook_html_sha256 = ?, guestbook_csv_object_key = ?, guestbook_csv_bytes = ?,
          guestbook_csv_sha256 = ?, error_code = NULL
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
        owner.id,
        readyClaim,
      ),
    ];
    const results = await this.db.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results.at(-1)?.meta.changes ?? 0) !== 1) {
      return { changed: false, job: await this.getById(owner.id) };
    }
    return { changed: true, job: await this.getById(owner.id) };
  }

  async markOwnedFailed(
    owner: ExportRunOwner,
    errorCode: string,
    completedAt: string,
  ): Promise<ExportOwnedTransition> {
    const result = await this.db.prepare(`
      UPDATE export_jobs
      SET state = 'failed', execution_transition = execution_transition + 1,
        error_code = ?5, completed_at = ?6
      WHERE id = ?1 AND state = 'running' AND execution_protocol = ?2
        AND attempt = ?3 AND execution_started_at = ?4
    `).bind(
      owner.id,
      owner.executionProtocol,
      owner.attempt,
      owner.executionStartedAt,
      errorCode,
      completedAt,
    ).run();
    return {
      changed: (result.meta.changes ?? 0) === 1,
      job: await this.getById(owner.id),
    };
  }

  async markInitialDispatchFailed(
    id: string,
    errorCode: string,
  ): Promise<ExportDispatchFailureFence> {
    const candidate = await this.getById(id);
    if (!candidate || candidate.state !== 'queued'
      || candidate.executionProtocol !== 'attempt-v2' || candidate.attempt !== 1) {
      return { changed: false, job: candidate };
    }
    const result = await this.db.prepare(`
      UPDATE export_jobs
      SET state = 'failed', execution_transition = execution_transition + 1,
        error_code = ?3
      WHERE id = ?1 AND state = 'queued' AND attempt = 1
        AND execution_protocol = 'attempt-v2' AND execution_transition = ?2
        AND error_code IS NULL
        AND object_key IS NULL AND manifest_object_key IS NULL AND part_count = 0
        AND guestbook_html_object_key IS NULL AND guestbook_html_bytes IS NULL
        AND guestbook_html_sha256 IS NULL AND guestbook_csv_object_key IS NULL
        AND guestbook_csv_bytes IS NULL AND guestbook_csv_sha256 IS NULL
        AND started_at IS NULL AND completed_at IS NULL AND expires_at IS NULL
        AND execution_started_at IS NULL AND processed_media_count IS NULL
        AND processed_bytes IS NULL AND progress_updated_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM export_parts WHERE export_job_id = ?1)
    `).bind(id, candidate.executionTransition, errorCode).run();
    return {
      changed: (result.meta.changes ?? 0) === 1,
      job: await this.getById(id),
    };
  }

  /**
   * Fails only the exact pristine retry attempt that could not retain a
   * Workflow. A concurrent Workflow claim or artifact write wins this fence.
   */
  async markRetryDispatchFailed(
    id: string,
    attempt: number,
    errorCode: string,
  ): Promise<ExportDispatchFailureFence> {
    const candidate = await this.getById(id);
    if (!candidate || candidate.state !== 'queued'
      || candidate.executionProtocol !== 'attempt-v2' || candidate.attempt !== attempt
      || attempt <= 1) {
      return { changed: false, job: candidate };
    }
    const result = await this.db.prepare(`
      UPDATE export_jobs
      SET state = 'failed', execution_transition = execution_transition + 1,
        error_code = ?4
      WHERE id = ?1 AND state = 'queued' AND attempt = ?2 AND attempt > 1
        AND execution_protocol = 'attempt-v2' AND execution_transition = ?3
        AND error_code IS NULL AND object_key IS NULL AND manifest_object_key IS NULL
        AND part_count = 0
        AND guestbook_html_object_key IS NULL AND guestbook_html_bytes IS NULL
        AND guestbook_html_sha256 IS NULL AND guestbook_csv_object_key IS NULL
        AND guestbook_csv_bytes IS NULL AND guestbook_csv_sha256 IS NULL
        AND started_at IS NULL AND completed_at IS NULL AND expires_at IS NULL
        AND execution_started_at IS NULL AND processed_media_count IS NULL
        AND processed_bytes IS NULL AND progress_updated_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM export_parts WHERE export_job_id = ?1)
    `).bind(id, attempt, candidate.executionTransition, errorCode).run();
    return {
      changed: (result.meta.changes ?? 0) === 1,
      job: await this.getById(id),
    };
  }

  /**
   * Reacquire this job's source hold and queue it again.
   *
   * Retry is stricter than the original run, because the hold was released the
   * moment the job went terminal. Every frozen entry must still resolve to a row
   * of this event that is stored, points at that exact key, and is either active
   * or recoverable — a photo the host trashed still has its bytes and stays
   * retryable, while one that was permanently deleted, repointed by promotion,
   * or suppressed does not. There is no R2 `HEAD` loop here: the tombstone and
   * the pointer are the evidence, and both are in this transaction.
   *
   * The queued state change is what re-establishes the hold, so it and the proof
   * are the same statement.
   */
  async retry(id: string): Promise<ExportRecord> {
    const candidate = await this.getById(id);
    if (!candidate) {
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'Only failed or expired exports can be retried.', 409);
    }
    const sourcesIntact = `
      NOT EXISTS (
        SELECT 1 FROM export_media_entries AS entry
        WHERE entry.export_job_id = export_jobs.id
          AND NOT EXISTS (
            SELECT 1 FROM media
            WHERE media.id = entry.media_id
              AND media.event_id = export_jobs.event_id
              AND media.upload_state = 'stored'
              AND media.object_bucket_generation = entry.object_bucket_generation
              AND media.object_key = entry.object_key
              AND (
                (media.trashed_at IS NULL AND media.deleted_at IS NULL)
                OR (media.trashed_at IS NOT NULL AND media.deleted_at = media.trashed_at)
              )
              AND EXISTS (
                SELECT 1 FROM media_object_write_tombstones AS t
                WHERE t.bucket_generation = entry.object_bucket_generation
                  AND t.object_key = entry.object_key
                  AND t.suppression_started_at IS NULL
              )
          )
      )
      AND (
        SELECT count(*) FROM export_media_entries AS entry
        WHERE entry.export_job_id = export_jobs.id
      ) = export_jobs.media_count
      AND COALESCE((
        SELECT sum(COALESCE(entry.byte_size, entry.declared_byte_size))
        FROM export_media_entries AS entry
        WHERE entry.export_job_id = export_jobs.id
      ), 0) = export_jobs.total_bytes
    `;
    const snapshotIntact = `
      (${sourcesIntact})
      AND (
        (
          export_jobs.kind = 'album'
          AND export_jobs.album_entries_json IS NOT NULL
          AND export_jobs.media_count > 0
          AND export_jobs.guestbook_entry_count IS NULL
          AND export_jobs.guestbook_shared_count IS NULL
        )
        OR (
          export_jobs.kind = 'complete'
          AND (
            (
              export_jobs.execution_protocol = 'legacy'
              AND export_jobs.media_count > 0
            )
            OR (
              export_jobs.guestbook_entry_count IS NOT NULL
              AND export_jobs.guestbook_shared_count IS NOT NULL
              AND export_jobs.guestbook_event_name IS NOT NULL
              AND export_jobs.guestbook_event_date IS NOT NULL
              AND export_jobs.guestbook_event_timezone IS NOT NULL
              AND export_jobs.guestbook_prompt IS NOT NULL
              AND export_jobs.guestbook_gallery_visible IS NOT NULL
              AND (SELECT count(*) FROM export_guestbook_entries AS guestbook
                WHERE guestbook.export_job_id = export_jobs.id
              ) = export_jobs.guestbook_entry_count
              AND (SELECT count(*) FROM export_guestbook_entries AS guestbook
                WHERE guestbook.export_job_id = export_jobs.id
                  AND guestbook.included_in_keepsake = 1
              ) = export_jobs.guestbook_shared_count
            )
          )
        )
      )
    `;
    const results = await this.db.batch([
        this.db.prepare(`
          UPDATE export_jobs SET state = 'queued', attempt = attempt + 1, object_key = NULL,
            manifest_object_key = NULL, part_count = 0, error_code = NULL,
            guestbook_html_object_key = NULL, guestbook_html_bytes = NULL,
            guestbook_html_sha256 = NULL, guestbook_csv_object_key = NULL,
            guestbook_csv_bytes = NULL, guestbook_csv_sha256 = NULL,
            started_at = NULL, completed_at = NULL, expires_at = NULL,
            execution_protocol = 'attempt-v2',
            execution_transition = execution_transition + 1,
            execution_started_at = NULL, processed_media_count = NULL,
            processed_bytes = NULL, progress_updated_at = NULL
          WHERE id = ?1 AND state = ?2 AND execution_protocol = ?3
            AND attempt = ?4 AND execution_transition = ?5
            AND state IN ('failed', 'expired')
            AND ${EXPORT_PROTOCOL_ADMITTED_SQL}
            AND NOT EXISTS (
              SELECT 1 FROM export_jobs AS newer
              WHERE newer.event_id = export_jobs.event_id
                AND newer.kind = export_jobs.kind
                AND (
                  newer.created_at > export_jobs.created_at
                  OR (newer.created_at = export_jobs.created_at AND newer.id > export_jobs.id)
                )
            )
            AND NOT EXISTS (
              SELECT 1 FROM export_jobs AS active
              WHERE active.event_id = export_jobs.event_id AND active.id <> export_jobs.id
                AND active.state IN ('queued', 'running')
            )
            AND (${snapshotIntact})
        `).bind(
          id,
          candidate.state,
          candidate.executionProtocol,
          candidate.attempt,
          candidate.executionTransition,
        ),
        this.db.prepare('DELETE FROM export_parts WHERE export_job_id = ? AND changes() = 1').bind(id),
        this.db.prepare(`
          SELECT
            CASE WHEN ${EXPORT_PROTOCOL_ADMITTED_SQL}
              THEN 1 ELSE 0 END AS protocol_admitted,
            CASE WHEN EXISTS (
              SELECT 1 FROM export_jobs AS active
              JOIN export_jobs AS candidate ON candidate.id = ?1
              WHERE active.event_id = candidate.event_id AND active.id <> candidate.id
                AND active.state IN ('queued', 'running')
            ) THEN 1 ELSE 0 END AS active_conflict,
            CASE WHEN EXISTS (
              SELECT 1 FROM export_jobs AS newer
              JOIN export_jobs AS candidate ON candidate.id = ?1
              WHERE newer.event_id = candidate.event_id
                AND newer.kind = candidate.kind
                AND (
                  newer.created_at > candidate.created_at
                  OR (newer.created_at = candidate.created_at AND newer.id > candidate.id)
                )
            ) THEN 1 ELSE 0 END AS stale_candidate,
            (SELECT CASE WHEN (${snapshotIntact})
              THEN 0 ELSE 1 END
              FROM export_jobs WHERE id = ?1) AS source_removed
        `).bind(id),
      ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const diagnostic = batchRow<{
        protocol_admitted: number;
        active_conflict: number;
        stale_candidate: number;
        source_removed: number | null;
      }>(results.at(-1));
      if (diagnostic?.protocol_admitted !== 1) throw exportProtocolPaused();
      if (diagnostic?.stale_candidate === 1) {
        throw new ApiError(
          'EXPORT_ALREADY_ACTIVE',
          'A newer prepared export is available. Refresh before retrying.',
          409,
        );
      }
      if (diagnostic?.active_conflict === 1) {
        throw new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already being prepared for this event.', 409);
      }
      if (diagnostic?.source_removed === 1) {
        throw new ApiError(
          'EXPORT_SOURCE_REMOVED',
          'Some photos in this export are no longer available. Prepare the current collection instead.',
          409,
        );
      }
      throw new ApiError('EXPORT_ALREADY_ACTIVE', 'Only failed or expired exports can be retried.', 409);
    }
    return (await this.getById(id))!;
  }


  async listExpiredReady(now: string): Promise<ExportExpiryCandidate[]> {
    const expired = await this.db.prepare(`
      SELECT id, execution_protocol, attempt, execution_transition, expires_at
      FROM export_jobs
      WHERE state = 'ready' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at, id
      LIMIT 100
    `).bind(now).all<{
      id: string;
      execution_protocol: ExportExpiryCandidate['executionProtocol'];
      attempt: number;
      execution_transition: number;
      expires_at: string;
    }>();
    return expired.results.map((row) => ({
      id: row.id,
      executionProtocol: row.execution_protocol,
      attempt: row.attempt,
      executionTransition: row.execution_transition,
      expiresAt: row.expires_at,
    }));
  }

  async markExpired(candidate: ExportExpiryCandidate, now: string): Promise<ExportExpiryResult> {
    const expiryClaim = `expiry:${crypto.randomUUID()}`;
    const nextTransition = candidate.executionProtocol === 'attempt-v2'
      ? candidate.executionTransition + 1
      : candidate.executionTransition;
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE export_jobs
        SET state = 'expired',
          execution_transition = CASE WHEN execution_protocol = 'attempt-v2'
            THEN execution_transition + 1 ELSE execution_transition END,
          error_code = ?6
        WHERE id = ?1 AND state = 'ready' AND execution_protocol = ?2
          AND attempt = ?3 AND execution_transition = ?4 AND expires_at = ?5
          AND expires_at <= ?7
      `).bind(
        candidate.id,
        candidate.executionProtocol,
        candidate.attempt,
        candidate.executionTransition,
        candidate.expiresAt,
        expiryClaim,
        now,
      ),
      this.db.prepare(`
        SELECT j.object_key, j.manifest_object_key,
          j.guestbook_html_object_key, j.guestbook_csv_object_key,
          p.part_number, p.object_key AS part_object_key,
          p.media_count AS part_media_count, p.source_bytes AS part_source_bytes
        FROM export_jobs AS j
        LEFT JOIN export_parts AS p ON p.export_job_id = j.id
        WHERE j.id = ?1 AND j.state = 'expired' AND j.execution_protocol = ?2
          AND j.attempt = ?3 AND j.execution_transition = ?4
          AND j.expires_at = ?5 AND j.error_code = ?6
        ORDER BY p.part_number
      `).bind(
        candidate.id,
        candidate.executionProtocol,
        candidate.attempt,
        nextTransition,
        candidate.expiresAt,
        expiryClaim,
      ),
      this.db.prepare(`
        UPDATE export_jobs SET error_code = NULL
        WHERE id = ?1 AND state = 'expired' AND execution_protocol = ?2
          AND attempt = ?3 AND execution_transition = ?4
          AND expires_at = ?5 AND error_code = ?6
      `).bind(
        candidate.id,
        candidate.executionProtocol,
        candidate.attempt,
        nextTransition,
        candidate.expiresAt,
        expiryClaim,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) {
      return { changed: false, job: await this.getById(candidate.id) };
    }
    const rows = results[1]?.results as Array<{
      object_key: string | null;
      manifest_object_key: string | null;
      guestbook_html_object_key: string | null;
      guestbook_csv_object_key: string | null;
      part_number: number | null;
      part_object_key: string | null;
      part_media_count: number | null;
      part_source_bytes: number | null;
    }> | undefined;
    const first = rows?.[0];
    const inventory: ExportArtifactInventory = {
      objectKey: first?.object_key ?? null,
      manifestObjectKey: first?.manifest_object_key ?? null,
      guestbookHtmlObjectKey: first?.guestbook_html_object_key ?? null,
      guestbookCsvObjectKey: first?.guestbook_csv_object_key ?? null,
      parts: (rows ?? []).flatMap((row) => (
        row.part_number === null || row.part_object_key === null
          || row.part_media_count === null || row.part_source_bytes === null
          ? []
          : [{
              partNumber: row.part_number,
              objectKey: row.part_object_key,
              mediaCount: row.part_media_count,
              sourceBytes: row.part_source_bytes,
            }]
      )),
    };
    const job = (await this.getById(candidate.id))!;
    return {
      changed: true,
      job,
      cleanup: { ...candidate, executionTransition: nextTransition, inventory },
    };
  }

  async listExpiredWithInventory(limit: number): Promise<ExpiredArtifactInventoryCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Expired export recovery limit must be between 1 and 100.');
    }
    const result = await this.db.prepare(`
      WITH candidates AS (
        SELECT id
        FROM export_jobs
        WHERE state = 'expired'
          AND (
            object_key IS NOT NULL OR manifest_object_key IS NOT NULL
            OR guestbook_html_object_key IS NOT NULL OR guestbook_csv_object_key IS NOT NULL
            OR EXISTS (SELECT 1 FROM export_parts WHERE export_job_id = export_jobs.id)
          )
        ORDER BY expires_at, id
        LIMIT ?1
      )
      SELECT j.id, j.execution_protocol, j.attempt, j.execution_transition, j.expires_at,
        j.object_key, j.manifest_object_key,
        j.guestbook_html_object_key, j.guestbook_csv_object_key,
        p.part_number, p.object_key AS part_object_key,
        p.media_count AS part_media_count, p.source_bytes AS part_source_bytes
      FROM candidates AS candidate
      JOIN export_jobs AS j ON j.id = candidate.id
      LEFT JOIN export_parts AS p ON p.export_job_id = j.id
      ORDER BY j.expires_at, j.id, p.part_number
    `).bind(limit).all<{
      id: string;
      execution_protocol: ExportExpiryCandidate['executionProtocol'];
      attempt: number;
      execution_transition: number;
      expires_at: string;
      object_key: string | null;
      manifest_object_key: string | null;
      guestbook_html_object_key: string | null;
      guestbook_csv_object_key: string | null;
      part_number: number | null;
      part_object_key: string | null;
      part_media_count: number | null;
      part_source_bytes: number | null;
    }>();
    const grouped = new Map<string, ExpiredArtifactInventoryCandidate>();
    for (const row of result.results) {
      let item = grouped.get(row.id);
      if (!item) {
        item = {
          id: row.id,
          executionProtocol: row.execution_protocol,
          attempt: row.attempt,
          executionTransition: row.execution_transition,
          expiresAt: row.expires_at,
          inventory: {
            objectKey: row.object_key,
            manifestObjectKey: row.manifest_object_key,
            guestbookHtmlObjectKey: row.guestbook_html_object_key,
            guestbookCsvObjectKey: row.guestbook_csv_object_key,
            parts: [],
          },
        };
        grouped.set(row.id, item);
      }
      if (row.part_number !== null && row.part_object_key !== null
        && row.part_media_count !== null && row.part_source_bytes !== null) {
        (item.inventory.parts as ReadyExportPart[]).push({
          partNumber: row.part_number,
          objectKey: row.part_object_key,
          mediaCount: row.part_media_count,
          sourceBytes: row.part_source_bytes,
        });
      }
    }
    return [...grouped.values()];
  }

  async clearExpiredInventory(candidate: ExpiredArtifactInventoryCandidate): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE export_jobs
        SET object_key = NULL, manifest_object_key = NULL, part_count = 0,
          guestbook_html_object_key = NULL, guestbook_html_bytes = NULL,
          guestbook_html_sha256 = NULL, guestbook_csv_object_key = NULL,
          guestbook_csv_bytes = NULL, guestbook_csv_sha256 = NULL
        WHERE id = ?1 AND state = 'expired' AND execution_protocol = ?2
          AND attempt = ?3 AND execution_transition = ?4 AND expires_at = ?5
      `).bind(
        candidate.id,
        candidate.executionProtocol,
        candidate.attempt,
        candidate.executionTransition,
        candidate.expiresAt,
      ),
      this.db.prepare(`
        DELETE FROM export_parts WHERE export_job_id = ?1 AND changes() = 1
      `).bind(candidate.id),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }
}

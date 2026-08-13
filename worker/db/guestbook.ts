import type {
  GuestGuestbookItem,
  GuestbookCaptionItem,
  GuestbookItem,
  GuestbookNoteItem,
  ManagerGuestbookItem,
} from '../../shared/contracts';
import {
  GUESTBOOK_SOURCE_RANK,
  GUEST_MESSAGE_PAGE_SIZE,
  MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE,
} from '../../shared/constants';
import type {
  GuestbookCursorKey,
  GuestbookManagerSource,
  GuestbookManagerView,
} from '../http/guestbook-cursor';
import type { ExportGuestbookEntryRecord } from './types';

interface GuestbookRow {
  id: string;
  source: 'guest_note' | 'photo_caption';
  source_rank: 0 | 1;
  guest_name: string | null;
  body: string;
  created_at: string;
  source_state: 'pending' | 'approved' | 'rejected' | 'deleted'
    | 'unpublished' | 'published' | 'hidden';
  guest_visibility: 'shared' | 'author_only' | 'host_only';
  is_own: number;
  media_id: string | null;
  preview_available: number;
  total_count?: number;
}

interface ExportGuestbookEntryRow {
  export_job_id: string;
  source: ExportGuestbookEntryRecord['source'];
  source_id: string;
  source_rank: 0 | 1;
  guest_name: string | null;
  body: string;
  created_at: string;
  source_state: ExportGuestbookEntryRecord['sourceState'];
  guest_visibility: ExportGuestbookEntryRecord['guestVisibility'];
  included_in_keepsake: number;
  media_id: string | null;
  original_filename: string | null;
}

export interface ExportGuestbookCursor {
  createdAt: string;
  sourceRank: 0 | 1;
  sourceId: string;
}

export interface ExportGuestbookPage {
  entries: ExportGuestbookEntryRecord[];
  nextCursor: ExportGuestbookCursor | null;
}

function exportEntry(row: ExportGuestbookEntryRow): ExportGuestbookEntryRecord {
  return {
    exportJobId: row.export_job_id,
    source: row.source,
    sourceId: row.source_id,
    sourceRank: row.source_rank,
    guestName: row.guest_name,
    body: row.body,
    createdAt: row.created_at,
    sourceState: row.source_state,
    guestVisibility: row.guest_visibility,
    includedInKeepsake: row.included_in_keepsake === 1,
    mediaId: row.media_id,
    originalFilename: row.original_filename,
  };
}

export interface GuestbookPageResult {
  items: GuestGuestbookItem[];
  nextCursor: GuestbookCursorKey | null;
}

export interface GuestbookOwnPageResult extends GuestbookPageResult {
  count: number;
}

export interface GuestbookSummary {
  needsReviewCount: number;
  sharedCount: number;
  hiddenCount: number;
  deletedCount: number;
  galleryVisible: boolean;
}

export interface ManagerGuestbookOptions {
  view: GuestbookManagerView;
  source: GuestbookManagerSource;
  cursor?: GuestbookCursorKey;
  limit?: number;
}

export interface ManagerGuestbookPage {
  items: ManagerGuestbookItem[];
  nextCursor: GuestbookCursorKey | null;
}

const GUEST_PROJECTION = `
  SELECT
    id,
    'guest_note' AS source,
    ${GUESTBOOK_SOURCE_RANK.guest_note} AS source_rank,
    guest_name,
    body,
    created_at,
    moderation_status AS source_state,
    CASE WHEN moderation_status = 'approved' THEN 'shared' ELSE 'author_only' END AS guest_visibility,
    CASE WHEN guest_session_id = ?2 THEN 1 ELSE 0 END AS is_own,
    NULL AS media_id,
    0 AS preview_available
  FROM guest_messages
  WHERE event_id = ?1 AND deleted_at IS NULL
  UNION ALL
  SELECT
    media.id,
    'photo_caption' AS source,
    ${GUESTBOOK_SOURCE_RANK.photo_caption} AS source_rank,
    media.guest_name,
    trim(media.caption) AS body,
    media.created_at,
    media.publication_status AS source_state,
    CASE
      WHEN media.publication_status = 'published' AND events.gallery_visible = 1 THEN 'shared'
      ELSE 'author_only'
    END AS guest_visibility,
    CASE WHEN media.uploader_session_id = ?2 THEN 1 ELSE 0 END AS is_own,
    media.id AS media_id,
    CASE WHEN media.preview_object_key IS NOT NULL THEN 1 ELSE 0 END AS preview_available
  FROM media
  JOIN events ON events.id = media.event_id
  WHERE media.event_id = ?1
    AND media.upload_state = 'stored'
    AND media.deleted_at IS NULL
    AND media.caption IS NOT NULL
    AND length(trim(media.caption)) > 0
`;

const MANAGER_PROJECTION = `
  SELECT
    id,
    'guest_note' AS source,
    ${GUESTBOOK_SOURCE_RANK.guest_note} AS source_rank,
    guest_name,
    body,
    created_at,
    CASE WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE moderation_status END AS source_state,
    CASE
      WHEN deleted_at IS NOT NULL THEN 'host_only'
      WHEN moderation_status = 'approved' THEN 'shared'
      ELSE 'author_only'
    END AS guest_visibility,
    0 AS is_own,
    NULL AS media_id,
    0 AS preview_available,
    CASE
      WHEN deleted_at IS NOT NULL THEN 'deleted'
      WHEN moderation_status = 'pending' THEN 'needs-review'
      WHEN moderation_status = 'approved' THEN 'shared'
      ELSE 'hidden'
    END AS view_name
  FROM guest_messages
  WHERE event_id = ?1
  UNION ALL
  SELECT
    media.id,
    'photo_caption' AS source,
    ${GUESTBOOK_SOURCE_RANK.photo_caption} AS source_rank,
    media.guest_name,
    trim(media.caption) AS body,
    media.created_at,
    media.publication_status AS source_state,
    CASE
      WHEN media.publication_status = 'published' AND events.gallery_visible = 1 THEN 'shared'
      ELSE 'author_only'
    END AS guest_visibility,
    0 AS is_own,
    media.id AS media_id,
    CASE WHEN media.preview_object_key IS NOT NULL THEN 1 ELSE 0 END AS preview_available,
    CASE
      WHEN media.publication_status = 'unpublished' THEN 'needs-review'
      WHEN media.publication_status = 'published' AND events.gallery_visible = 1 THEN 'shared'
      ELSE 'hidden'
    END AS view_name
  FROM media
  JOIN events ON events.id = media.event_id
  WHERE media.event_id = ?1
    AND media.upload_state = 'stored'
    AND media.deleted_at IS NULL
    AND media.caption IS NOT NULL
    AND length(trim(media.caption)) > 0
`;

function cursorPredicate(cursor: GuestbookCursorKey | undefined): string {
  return cursor
    ? `AND (
        created_at < ?
        OR (created_at = ? AND source_rank > ?)
        OR (created_at = ? AND source_rank = ? AND id < ?)
      )`
    : '';
}

function cursorBindings(cursor: GuestbookCursorKey | undefined): unknown[] {
  return cursor
    ? [cursor.createdAt, cursor.createdAt, cursor.sourceRank, cursor.createdAt, cursor.sourceRank, cursor.id]
    : [];
}

function cursorFor(row: GuestbookRow): GuestbookCursorKey {
  return { createdAt: row.created_at, sourceRank: row.source_rank, id: row.id };
}

function noteItem(row: GuestbookRow): GuestbookNoteItem | Extract<GuestbookItem, { state: 'deleted' }> {
  if (row.source_state === 'deleted') {
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
  if (!['pending', 'approved', 'rejected'].includes(row.source_state)) {
    throw new Error('Guestbook note projection returned an invalid state.');
  }
  return {
    id: row.id,
    source: 'guest_note',
    guestName: row.guest_name,
    body: row.body,
    createdAt: row.created_at,
    state: row.source_state as GuestbookNoteItem['state'],
    visibility: row.guest_visibility === 'shared' ? 'shared' : 'author_only',
  };
}

function captionItem(row: GuestbookRow): GuestbookCaptionItem {
  if (!['unpublished', 'published', 'hidden'].includes(row.source_state) || !row.media_id) {
    throw new Error('Guestbook caption projection returned an invalid state.');
  }
  return {
    id: row.id,
    source: 'photo_caption',
    mediaId: row.media_id,
    guestName: row.guest_name,
    body: row.body,
    createdAt: row.created_at,
    state: row.source_state as GuestbookCaptionItem['state'],
    visibility: row.guest_visibility === 'shared' ? 'shared' : 'author_only',
    previewAvailable: row.preview_available === 1,
  };
}

function managerItem(row: GuestbookRow): ManagerGuestbookItem {
  return row.source === 'guest_note' ? noteItem(row) : captionItem(row);
}

function guestItem(row: GuestbookRow): GuestGuestbookItem {
  if (row.source === 'guest_note') {
    const item = noteItem(row);
    if (item.state === 'deleted') throw new Error('Deleted note leaked into a guest projection.');
    return {
      ...item,
      isOwn: row.is_own === 1,
      kind: 'message',
      moderationStatus: item.state,
      mediaId: null,
    } as GuestGuestbookItem;
  }
  const item = captionItem(row);
  const moderationStatus = item.state === 'unpublished'
    ? 'pending'
    : item.state === 'published' && item.visibility === 'shared'
      ? 'approved'
      : 'rejected';
  return {
    ...item,
    isOwn: row.is_own === 1,
    kind: 'caption',
    moderationStatus,
  } as GuestGuestbookItem;
}

function pageFromRows(rows: GuestbookRow[], limit: number): GuestbookPageResult {
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(guestItem),
    nextCursor: rows.length > limit && last ? cursorFor(last) : null,
  };
}

export interface SnapshotStatementInput {
  exportJobId: string;
  eventId: string;
  snapshotAt: string;
}

export class GuestbookRepository {
  constructor(private readonly db: D1Database) {}

  async listGuestShared(
    eventId: string,
    guestSessionId: string,
    cursor?: GuestbookCursorKey,
    limit = GUEST_MESSAGE_PAGE_SIZE,
  ): Promise<GuestbookPageResult> {
    const result = await this.db.prepare(`
      WITH guestbook AS (${GUEST_PROJECTION})
      SELECT * FROM guestbook
      WHERE guest_visibility = 'shared'
      ${cursorPredicate(cursor)}
      ORDER BY created_at DESC, source_rank ASC, id DESC
      LIMIT ?
    `).bind(
      eventId,
      guestSessionId,
      ...cursorBindings(cursor),
      limit + 1,
    ).all<GuestbookRow>();
    return pageFromRows(result.results, limit);
  }

  async listGuestOwnUnshared(
    eventId: string,
    guestSessionId: string,
    cursor?: GuestbookCursorKey,
    limit = GUEST_MESSAGE_PAGE_SIZE,
  ): Promise<GuestbookOwnPageResult> {
    const result = await this.db.prepare(`
      WITH guestbook AS (${GUEST_PROJECTION})
      SELECT *, COUNT(*) OVER () AS total_count FROM guestbook
      WHERE guest_visibility = 'author_only' AND is_own = 1
      ${cursorPredicate(cursor)}
      ORDER BY created_at DESC, source_rank ASC, id DESC
      LIMIT ?
    `).bind(
      eventId,
      guestSessionId,
      ...cursorBindings(cursor),
      limit + 1,
    ).all<GuestbookRow>();
    const page = pageFromRows(result.results, limit);
    let count = result.results[0]?.total_count ?? 0;
    if (cursor) {
      count = await this.db.prepare(`
        WITH guestbook AS (${GUEST_PROJECTION})
        SELECT COUNT(*) AS count FROM guestbook
        WHERE guest_visibility = 'author_only' AND is_own = 1
      `).bind(eventId, guestSessionId).first<number>('count') ?? 0;
    }
    return { ...page, count };
  }

  async countGuestOwnUnshared(eventId: string, guestSessionId: string): Promise<number> {
    return await this.db.prepare(`
      WITH guestbook AS (${GUEST_PROJECTION})
      SELECT COUNT(*) AS count FROM guestbook
      WHERE guest_visibility = 'author_only' AND is_own = 1
    `).bind(eventId, guestSessionId).first<number>('count') ?? 0;
  }

  async summaryForManager(eventId: string): Promise<GuestbookSummary> {
    const row = await this.db.prepare(`
      WITH guestbook AS (${MANAGER_PROJECTION})
      SELECT
        SUM(CASE WHEN view_name = 'needs-review' THEN 1 ELSE 0 END) AS needs_review_count,
        SUM(CASE WHEN view_name = 'shared' THEN 1 ELSE 0 END) AS shared_count,
        SUM(CASE WHEN view_name = 'hidden' THEN 1 ELSE 0 END) AS hidden_count,
        SUM(CASE WHEN view_name = 'deleted' THEN 1 ELSE 0 END) AS deleted_count,
        (SELECT gallery_visible FROM events WHERE id = ?1) AS gallery_visible
      FROM guestbook
    `).bind(eventId).first<{
      needs_review_count: number;
      shared_count: number;
      hidden_count: number;
      deleted_count: number;
      gallery_visible: number;
    }>();
    return {
      needsReviewCount: row?.needs_review_count ?? 0,
      sharedCount: row?.shared_count ?? 0,
      hiddenCount: row?.hidden_count ?? 0,
      deletedCount: row?.deleted_count ?? 0,
      galleryVisible: row?.gallery_visible === 1,
    };
  }

  async listForManager(
    eventId: string,
    options: ManagerGuestbookOptions,
  ): Promise<ManagerGuestbookPage> {
    const limit = options.limit ?? MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE;
    const sourcePredicate = options.source === 'all' ? '' : 'AND source = ?';
    const result = await this.db.prepare(`
      WITH guestbook AS (${MANAGER_PROJECTION})
      SELECT * FROM guestbook
      WHERE view_name = ?
      ${sourcePredicate}
      ${cursorPredicate(options.cursor)}
      ORDER BY created_at DESC, source_rank ASC, id DESC
      LIMIT ?
    `).bind(
      eventId,
      options.view,
      ...(options.source === 'all' ? [] : [options.source]),
      ...cursorBindings(options.cursor),
      limit + 1,
    ).all<GuestbookRow>();
    const pageRows = result.results.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(managerItem),
      nextCursor: result.results.length > limit && last ? cursorFor(last) : null,
    };
  }

  snapshotStatements(input: SnapshotStatementInput): D1PreparedStatement[] {
    return [this.db.prepare(`
      INSERT INTO export_guestbook_entries (
        export_job_id, source, source_id, source_rank, guest_name, body,
        created_at, source_state, guest_visibility, included_in_keepsake,
        media_id, original_filename
      )
      SELECT
        ?1, source, source_id, source_rank, guest_name, body, created_at,
        source_state, guest_visibility,
        CASE WHEN guest_visibility = 'shared' THEN 1 ELSE 0 END,
        media_id, original_filename
      FROM (
        SELECT
          'guest_note' AS source,
          id AS source_id,
          ${GUESTBOOK_SOURCE_RANK.guest_note} AS source_rank,
          guest_name,
          body,
          created_at,
          moderation_status AS source_state,
          CASE WHEN moderation_status = 'approved' THEN 'shared' ELSE 'author_only' END AS guest_visibility,
          NULL AS media_id,
          NULL AS original_filename
        FROM guest_messages
        WHERE event_id = ?2 AND deleted_at IS NULL AND created_at <= ?3
        UNION ALL
        SELECT
          'photo_caption' AS source,
          media.id AS source_id,
          ${GUESTBOOK_SOURCE_RANK.photo_caption} AS source_rank,
          media.guest_name,
          trim(media.caption) AS body,
          media.created_at,
          media.publication_status AS source_state,
          CASE
            WHEN media.publication_status = 'published' AND events.gallery_visible = 1 THEN 'shared'
            ELSE 'author_only'
          END AS guest_visibility,
          media.id AS media_id,
          media.original_filename
        FROM media
        JOIN events ON events.id = media.event_id
        WHERE media.event_id = ?2
          AND media.upload_state = 'stored'
          AND media.deleted_at IS NULL
          AND media.created_at <= ?3
          AND media.caption IS NOT NULL
          AND length(trim(media.caption)) > 0
      )
      WHERE changes() = 1
      ORDER BY created_at ASC, source_rank DESC, source_id ASC
    `).bind(input.exportJobId, input.eventId, input.snapshotAt)];
  }

  async listExportEntries(
    exportJobId: string,
    cursor?: ExportGuestbookCursor,
    limit = 100,
  ): Promise<ExportGuestbookPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Guestbook export page size must be between 1 and 100.');
    }
    const result = await this.db.prepare(`
      SELECT * FROM export_guestbook_entries
      WHERE export_job_id = ?1
        ${cursor ? `AND (
          created_at > ?2
          OR (created_at = ?2 AND source_rank < ?3)
          OR (created_at = ?2 AND source_rank = ?3 AND source_id > ?4)
        )` : ''}
      ORDER BY created_at ASC, source_rank DESC, source_id ASC
      LIMIT ?${cursor ? 5 : 2}
    `).bind(
      exportJobId,
      ...(cursor ? [cursor.createdAt, cursor.sourceRank, cursor.sourceId] : []),
      limit + 1,
    ).all<ExportGuestbookEntryRow>();
    const rows = result.results.slice(0, limit);
    const last = rows.at(-1);
    return {
      entries: rows.map(exportEntry),
      nextCursor: result.results.length > limit && last
        ? { createdAt: last.created_at, sourceRank: last.source_rank, sourceId: last.source_id }
        : null,
    };
  }

  async noteItemById(id: string): Promise<ManagerGuestbookItem | null> {
    const row = await this.db.prepare(`
      SELECT
        id, 'guest_note' AS source, ${GUESTBOOK_SOURCE_RANK.guest_note} AS source_rank,
        guest_name, body, created_at,
        CASE WHEN deleted_at IS NOT NULL THEN 'deleted' ELSE moderation_status END AS source_state,
        CASE
          WHEN deleted_at IS NOT NULL THEN 'host_only'
          WHEN moderation_status = 'approved' THEN 'shared'
          ELSE 'author_only'
        END AS guest_visibility,
        0 AS is_own, NULL AS media_id, 0 AS preview_available
      FROM guest_messages WHERE id = ?
    `).bind(id).first<GuestbookRow>();
    return row ? managerItem(row) : null;
  }

  async captionItemById(id: string): Promise<ManagerGuestbookItem | null> {
    const row = await this.db.prepare(`
      SELECT
        media.id, 'photo_caption' AS source, ${GUESTBOOK_SOURCE_RANK.photo_caption} AS source_rank,
        media.guest_name, trim(media.caption) AS body, media.created_at,
        media.publication_status AS source_state,
        CASE
          WHEN media.publication_status = 'published' AND events.gallery_visible = 1 THEN 'shared'
          ELSE 'author_only'
        END AS guest_visibility,
        0 AS is_own, media.id AS media_id,
        CASE WHEN media.preview_object_key IS NOT NULL THEN 1 ELSE 0 END AS preview_available
      FROM media
      JOIN events ON events.id = media.event_id
      WHERE media.id = ?
        AND media.upload_state = 'stored'
        AND media.deleted_at IS NULL
        AND media.caption IS NOT NULL
        AND length(trim(media.caption)) > 0
    `).bind(id).first<GuestbookRow>();
    return row ? managerItem(row) : null;
  }
}

import type {
  AlbumEntryInput,
  AlbumEntryView,
  AlbumMetadataInput,
  AlbumView,
  ManagerGalleryMediaView,
} from '../../shared/contracts';
import { ALBUM_MAX_ENTRIES, ALBUM_MAX_SECTIONS } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { managerGalleryMediaView } from './media';
import type { MediaRow } from './media';

interface AlbumRow {
  event_id: string;
  entries: string;
  saved_at: string | null;
  revision: number;
  title: string;
  description: string;
  cover_media_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The stored order. Parsed defensively rather than trusted: the column is a JSON
 * document, so a partially written or hand-edited row must degrade to "no stored
 * order" — which still renders every pick in timeline order — instead of throwing
 * a 500 at a host looking at their wedding.
 */
function parseEntries(raw: string): AlbumEntryInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: AlbumEntryInput[] = [];
  const seenMedia = new Set<string>();
  const seenSections = new Set<string>();
  for (const candidate of parsed) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const entry = candidate as Record<string, unknown>;
    if (entry.kind === 'photo' && typeof entry.mediaId === 'string') {
      if (seenMedia.has(entry.mediaId)) continue;
      seenMedia.add(entry.mediaId);
      entries.push({ kind: 'photo', mediaId: entry.mediaId });
    } else if (
      entry.kind === 'section'
      && typeof entry.id === 'string'
      && typeof entry.heading === 'string'
    ) {
      if (seenSections.has(entry.id)) continue;
      seenSections.add(entry.id);
      entries.push({ kind: 'section', id: entry.id, heading: entry.heading });
    }
  }
  return entries;
}

const EMPTY_ALBUM = {
  entries: [] as AlbumEntryInput[],
  savedAt: null,
  revision: 0,
  title: 'Album',
  description: '',
  coverMediaId: null,
};

export interface StoredAlbum extends AlbumMetadataInput {
  entries: AlbumEntryInput[];
  savedAt: string | null;
  revision: number;
}

function parseMetadata(row: AlbumRow): AlbumMetadataInput {
  const title = typeof row.title === 'string' && row.title.trim().length > 0
    ? row.title.trim()
    : EMPTY_ALBUM.title;
  const description = typeof row.description === 'string'
    ? row.description
    : EMPTY_ALBUM.description;
  const coverMediaId = typeof row.cover_media_id === 'string' && row.cover_media_id.length > 0
    ? row.cover_media_id
    : null;
  return { title, description, coverMediaId };
}

/**
 * Resolves the stored order against the live picked set.
 *
 * Two rules do all the work. A stored photo entry survives only if that photo is
 * still picked, stored and undeleted — so unpicking anywhere, or deleting the photo,
 * removes it from the album with no write here. And a pick the stored order has never
 * heard of is appended in the timeline order the picks arrived in — so picking in
 * Library lands the photo at the end of the album without a second request, which is
 * the whole reason a host can pick liberally and prune later.
 */
export function resolveAlbum(
  stored: StoredAlbum,
  picked: readonly ManagerGalleryMediaView[],
  totalBytes = 0,
): AlbumView {
  const byId = new Map(picked.map((photo) => [photo.id, photo]));
  const placed = new Set<string>();
  const entries: AlbumEntryView[] = [];
  for (const entry of stored.entries) {
    if (entry.kind === 'section') {
      entries.push({ kind: 'section', id: entry.id, heading: entry.heading });
      continue;
    }
    const photo = byId.get(entry.mediaId);
    if (!photo || placed.has(entry.mediaId)) continue;
    placed.add(entry.mediaId);
    entries.push({ kind: 'photo', photo });
  }
  for (const photo of picked) {
    if (placed.has(photo.id)) continue;
    entries.push({ kind: 'photo', photo });
  }
  const coverMediaId = stored.coverMediaId !== null && byId.has(stored.coverMediaId)
    ? stored.coverMediaId
    : null;
  const firstPhoto = entries.find((entry) => entry.kind === 'photo');
  return {
    revision: stored.revision,
    saved: stored.savedAt !== null,
    title: stored.title,
    description: stored.description,
    coverMediaId,
    effectiveCoverMediaId: coverMediaId ?? (firstPhoto?.kind === 'photo' ? firstPhoto.photo.id : null),
    entries,
    photoCount: entries.filter((entry) => entry.kind === 'photo').length,
    sectionCount: entries.filter((entry) => entry.kind === 'section').length,
    totalBytes,
  };
}

/**
 * The picked set, in album-tail order. Deliberately not the gallery's `order` toggle:
 * that is a reading preference for the Library, and letting it reach the album would
 * silently reverse a host's arrangement every time they flipped it.
 */
export function albumPickQuery(): string {
  return `
    SELECT
      id, original_filename, guest_name, caption, publication_status,
      upload_state, preview_object_key, width, height, created_at, stored_at,
      captured_at, timeline_at, favorited_at, declared_byte_size, byte_size
    FROM media
    WHERE event_id = ?
      AND upload_state = 'stored'
      AND deleted_at IS NULL
      AND favorited_at IS NOT NULL
    ORDER BY timeline_at ASC, id ASC
    LIMIT ?
  `;
}

export class AlbumRepository {
  constructor(private readonly db: D1Database) {}

  private async storedAlbum(eventId: string): Promise<StoredAlbum> {
    const row = await this.db
      .prepare('SELECT * FROM event_albums WHERE event_id = ?')
      .bind(eventId)
      .first<AlbumRow>();
    if (!row) return { ...EMPTY_ALBUM };
    return {
      entries: parseEntries(row.entries),
      savedAt: row.saved_at,
      revision: row.revision,
      ...parseMetadata(row),
    };
  }

  private async picks(eventId: string): Promise<{
    photos: ManagerGalleryMediaView[];
    totalBytes: number;
  }> {
    // One over the cap: reading it is how an album that filled up before the cap
    // existed still renders, rather than silently truncating to exactly the limit.
    const result = await this.db
      .prepare(albumPickQuery())
      .bind(eventId, ALBUM_MAX_ENTRIES + 1)
      .all<MediaRow>();
    const photos = result.results.map((row) => managerGalleryMediaView({
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
    }));
    const totalBytes = result.results.reduce(
      (sum, row) => sum + (row.byte_size ?? row.declared_byte_size),
      0,
    );
    return { photos, totalBytes };
  }

  async get(eventId: string): Promise<AlbumView> {
    const [stored, picked] = await Promise.all([
      this.storedAlbum(eventId),
      this.picks(eventId),
    ]);
    return resolveAlbum(stored, picked.photos, picked.totalBytes);
  }

  /** How many photos are picked right now. The cap is charged against this, not the stored order. */
  async pickCount(eventId: string): Promise<number> {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count FROM media
      WHERE event_id = ?
        AND upload_state = 'stored'
        AND deleted_at IS NULL
        AND favorited_at IS NOT NULL
    `).bind(eventId).first<{ count: number }>();
    return row?.count ?? 0;
  }

  /**
   * Replaces the whole order under a revision guard.
   *
   * The guard is the first statement's `WHERE`, per the house D1 pattern: a lost
   * compare-and-set affects zero rows and is reported from the album's current state
   * rather than overwriting a co-host's arrangement. Composing against revision 0 is
   * how a first save works, and the upsert makes that the same statement.
   */
  async replace(
    eventId: string,
    expectedRevision: number,
    entries: AlbumEntryInput[],
    metadata: AlbumMetadataInput | undefined,
    now: string,
  ): Promise<AlbumView> {
    if (entries.length > ALBUM_MAX_ENTRIES) {
      throw new ApiError(
        'ALBUM_FULL',
        `An album holds up to ${ALBUM_MAX_ENTRIES} photos and sections.`,
        409,
      );
    }
    const sections = entries.filter((entry) => entry.kind === 'section').length;
    if (sections > ALBUM_MAX_SECTIONS) {
      throw new ApiError('ALBUM_FULL', `An album holds up to ${ALBUM_MAX_SECTIONS} sections.`, 409);
    }

    // Two statements, because one upsert cannot express this guard: the INSERT arm of
    // `ON CONFLICT` fires whatever revision the caller composed against, so a stale write
    // against a purged event would land as revision 1 rather than being refused. Seeding
    // the row first and guarding the UPDATE puts the compare-and-set in SQL, where the
    // house pattern wants it, and a lost race affects zero rows instead of overwriting a
    // co-host's arrangement.
    const update = metadata
      ? this.db.prepare(`
          UPDATE event_albums
          SET entries = ?,
              title = ?,
              description = ?,
              cover_media_id = ?,
              saved_at = COALESCE(saved_at, ?),
              revision = revision + 1,
              updated_at = ?
          WHERE event_id = ? AND revision = ?
        `).bind(
          JSON.stringify(entries),
          metadata.title,
          metadata.description,
          metadata.coverMediaId,
          now,
          now,
          eventId,
          expectedRevision,
        )
      : this.db.prepare(`
          UPDATE event_albums
          SET entries = ?,
              saved_at = COALESCE(saved_at, ?),
              revision = revision + 1,
              updated_at = ?
          WHERE event_id = ? AND revision = ?
        `).bind(JSON.stringify(entries), now, now, eventId, expectedRevision);
    const batch = await this.db.batch([
      this.db.prepare(`
        INSERT OR IGNORE INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
        VALUES (?, '[]', NULL, 0, ?, ?)
      `).bind(eventId, now, now),
      update,
    ]);

    if (batch[1]?.meta.changes !== 1) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'This album changed while you were arranging it. Reopen Album to see the current order.',
        409,
      );
    }
    return this.get(eventId);
  }

  /**
   * Marks the album committed without touching the order. `Start from picks` and
   * `Start empty` both end here: the reconciliation prompt is driven entirely by
   * `saved_at`, so a host who answered it once must not be asked again.
   *
   * Deliberately unguarded by revision, because it is idempotent by construction —
   * `COALESCE` keeps the first commit's instant, so a co-host racing the same choice
   * changes nothing and neither caller has to lose.
   */
  async markSaved(eventId: string, now: string): Promise<AlbumView> {
    await this.db.batch([
      this.db.prepare(`
        INSERT OR IGNORE INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
        VALUES (?, '[]', NULL, 0, ?, ?)
      `).bind(eventId, now, now),
      this.db.prepare(`
        UPDATE event_albums
        SET saved_at = COALESCE(saved_at, ?), updated_at = ?
        WHERE event_id = ? AND saved_at IS NULL
      `).bind(now, now, eventId),
    ]);
    return this.get(eventId);
  }
}

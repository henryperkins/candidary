import type {
  AlbumEntryInput,
  AlbumEntryView,
  AlbumMetadataInput,
  AlbumRetainedSlotView,
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
 * One album slot's occupant: a photograph the host can still see, or the opaque
 * stand-in for one they moved to Recently deleted.
 *
 * Both are ordered together by the same timeline instant, because a retained
 * slot is not a gap — it is the photo, still holding its place until Restore
 * puts it back or cleanup takes it away.
 */
export type AlbumPick =
  | { kind: 'photo'; photo: ManagerGalleryMediaView }
  | { kind: 'retained'; slot: AlbumRetainedSlotView };

function pickId(pick: AlbumPick): string {
  return pick.kind === 'photo' ? pick.photo.id : pick.slot.mediaId;
}

function pickEntry(pick: AlbumPick): AlbumEntryView {
  return pick.kind === 'photo'
    ? { kind: 'photo', photo: pick.photo }
    : { kind: 'photo-retained', slot: pick.slot };
}

/**
 * Resolves the stored order against the live picked set.
 *
 * Three rules now. A stored photo entry survives only if that photo is still
 * picked and still owns its slot — so unpicking anywhere, or a guest deleting
 * the photo, removes it from the album with no write here. A pick the stored
 * order has never heard of is appended in the timeline order the picks arrived
 * in, which is what lets picking in Library land the photo at the end of the
 * album without a second request. And a pick the host trashed resolves to an
 * opaque marker in its own slot rather than vanishing, because vanishing would
 * silently rearrange an album around a photo that is still recoverable.
 */
export function resolveAlbum(
  stored: StoredAlbum,
  picked: readonly AlbumPick[],
  totalBytes = 0,
): AlbumView {
  const byId = new Map(picked.map((pick) => [pickId(pick), pick]));
  const placed = new Set<string>();
  const entries: AlbumEntryView[] = [];
  for (const entry of stored.entries) {
    if (entry.kind === 'section') {
      entries.push({ kind: 'section', id: entry.id, heading: entry.heading });
      continue;
    }
    const pick = byId.get(entry.mediaId);
    if (!pick || placed.has(entry.mediaId)) continue;
    placed.add(entry.mediaId);
    entries.push(pickEntry(pick));
  }
  for (const pick of picked) {
    if (placed.has(pickId(pick))) continue;
    entries.push(pickEntry(pick));
  }
  const cover = stored.coverMediaId !== null ? byId.get(stored.coverMediaId) : undefined;
  const coverMediaId = cover ? stored.coverMediaId : null;
  const firstPhoto = entries.find((entry) => entry.kind === 'photo');
  const visibleCoverId = cover?.kind === 'photo' ? cover.photo.id : null;
  return {
    revision: stored.revision,
    saved: stored.savedAt !== null,
    title: stored.title,
    description: stored.description,
    coverMediaId,
    // A retained cover keeps its reference but cannot be rendered, so the
    // effective cover falls through to the first visible photo until Restore.
    effectiveCoverMediaId: visibleCoverId
      ?? (firstPhoto?.kind === 'photo' ? firstPhoto.photo.id : null),
    coverRetained: cover?.kind === 'retained' ? cover.slot : null,
    entries,
    photoCount: entries.filter((entry) => entry.kind === 'photo').length,
    retainedCount: entries.filter((entry) => entry.kind === 'photo-retained').length,
    sectionCount: entries.filter((entry) => entry.kind === 'section').length,
    totalBytes,
  };
}

/**
 * A row that holds an album slot: delivered, or retained in Recently deleted.
 * Kept as one predicate because every album count, guard, and read has to agree
 * about which photos are still spending the album's five hundred places.
 */
export const ALBUM_SLOT_OWNER_SQL = `(
  (media.deleted_at IS NULL AND media.trashed_at IS NULL)
  OR (media.trashed_at IS NOT NULL AND media.deleted_at = media.trashed_at)
)`;

/**
 * The picked set, in album-tail order. Deliberately not the gallery's `order` toggle:
 * that is a reading preference for the Library, and letting it reach the album would
 * silently reverse a host's arrangement every time they flipped it.
 *
 * Retained picks come back in the same stream, ordered by the same instant, so a
 * trashed photo in the middle of an unmaterialized tail keeps its neighbors.
 */
export function albumPickQuery(): string {
  return `
    SELECT
      id, original_filename, guest_name, caption, publication_status,
      upload_state, preview_object_key, width, height, created_at, stored_at,
      captured_at, timeline_at, favorited_at, declared_byte_size, byte_size,
      trashed_at, restore_until
    FROM media
    WHERE event_id = ?
      AND upload_state = 'stored'
      AND favorited_at IS NOT NULL
      AND ${ALBUM_SLOT_OWNER_SQL}
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

  private async picks(eventId: string, now: string): Promise<{
    picks: AlbumPick[];
    totalBytes: number;
  }> {
    // One over the cap: reading it is how an album that filled up before the cap
    // existed still renders, rather than silently truncating to exactly the limit.
    const result = await this.db
      .prepare(albumPickQuery())
      .bind(eventId, ALBUM_MAX_ENTRIES + 1)
      .all<MediaRow>();
    const picks = result.results.map<AlbumPick>((row) => {
      if (row.trashed_at !== null && row.restore_until !== null) {
        return {
          kind: 'retained',
          slot: {
            mediaId: row.id,
            restoreUntil: row.restore_until,
            // Past the deadline the slot survives, but only because an accepted
            // export still holds the bytes. It is not an offer of recovery.
            state: row.restore_until > now ? 'recoverable' : 'expired-cleanup-pending',
          },
        };
      }
      return {
        kind: 'photo',
        photo: managerGalleryMediaView({
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
        }),
      };
    });
    // Retained photos are not exportable, so they are not part of what an album
    // export would weigh. They still hold their slot; they no longer count bytes.
    const totalBytes = result.results.reduce(
      (sum, row) => (row.trashed_at !== null ? sum : sum + (row.byte_size ?? row.declared_byte_size)),
      0,
    );
    return { picks, totalBytes };
  }

  async get(eventId: string, now = new Date().toISOString()): Promise<AlbumView> {
    const [stored, picked] = await Promise.all([
      this.storedAlbum(eventId),
      this.picks(eventId, now),
    ]);
    return resolveAlbum(stored, picked.picks, picked.totalBytes);
  }

  /** How many photos are visibly picked right now. Retained slots are excluded: this is what a host sees. */
  async pickCount(eventId: string): Promise<number> {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count FROM media
      WHERE event_id = ?
        AND upload_state = 'stored'
        AND deleted_at IS NULL
        AND trashed_at IS NULL
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

    // Capacity and revision are predicates on the same UPDATE. D1 batches execute as
    // one transaction, so this serializes against the guarded favorite UPDATE: a pick
    // and a section save cannot both spend the final album slot.
    // Every submitted photo entry must still name a row of this event that owns
    // a slot. A photo that was merely unpicked passes and is dropped at resolve
    // time as it always was; a missing, foreign, or permanently deleted id is
    // refused, so an editor cannot save a terminal photograph back into an album.
    const submittedIds = JSON.stringify(
      entries.filter((entry) => entry.kind === 'photo').map((entry) => entry.mediaId),
    );
    const referenceGuard = `
      NOT EXISTS (
        SELECT 1 FROM json_each(?) AS requested
        WHERE NOT EXISTS (
          SELECT 1 FROM media
          WHERE media.id = CAST(requested.value AS TEXT)
            AND media.event_id = ?
            AND media.upload_state = 'stored'
            AND ${ALBUM_SLOT_OWNER_SQL}
        )
      )
    `;

    // And every retained slot must come back.
    //
    // An omitted *active* pick is an ordinary edit — the resolver re-appends it in
    // timeline order and nothing is lost. An omitted retained slot is not: the
    // photo is invisible, so the host cannot have meant to move it, and letting
    // the save through would silently relocate it to the tail and send a timely
    // Restore back to the wrong position. The likeliest source is a client
    // deployed before `photo-retained` existed, which cannot serialize the marker
    // at all — exactly the case that must be refused rather than accommodated.
    // Start empty remains the one operation that clears retained picks.
    const retainedGuard = `
      NOT EXISTS (
        SELECT 1 FROM media
        WHERE media.event_id = ?
          AND media.upload_state = 'stored'
          AND media.favorited_at IS NOT NULL
          AND media.trashed_at IS NOT NULL
          AND media.deleted_at = media.trashed_at
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) AS requested
            WHERE CAST(requested.value AS TEXT) = media.id
          )
      )
    `;

    // Retained slots are inside the count. Trash cannot appear to free a place
    // that a still-timely Restore is entitled to take back.
    const capacityGuard = `
      (SELECT COUNT(*) FROM media
        WHERE media.event_id = ?
          AND media.upload_state = 'stored'
          AND media.favorited_at IS NOT NULL
          AND ${ALBUM_SLOT_OWNER_SQL})
        + ? <= ?
    `;

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
            AND (${capacityGuard})
            AND (${referenceGuard})
            AND (${retainedGuard})
        `).bind(
          JSON.stringify(entries),
          metadata.title,
          metadata.description,
          metadata.coverMediaId,
          now,
          now,
          eventId,
          expectedRevision,
          eventId,
          sections,
          ALBUM_MAX_ENTRIES,
          submittedIds,
          eventId,
          eventId,
          submittedIds,
        )
      : this.db.prepare(`
          UPDATE event_albums
          SET entries = ?,
              saved_at = COALESCE(saved_at, ?),
              revision = revision + 1,
              updated_at = ?
          WHERE event_id = ? AND revision = ?
            AND (${capacityGuard})
            AND (${referenceGuard})
            AND (${retainedGuard})
        `).bind(
          JSON.stringify(entries),
          now,
          now,
          eventId,
          expectedRevision,
          eventId,
          sections,
          ALBUM_MAX_ENTRIES,
          submittedIds,
          eventId,
          eventId,
          submittedIds,
        );
    const batch = await this.db.batch([
      this.db.prepare(`
        INSERT OR IGNORE INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
        VALUES (?, '[]', NULL, 0, ?, ?)
      `).bind(eventId, now, now),
      update,
      this.db.prepare(`
        SELECT
          revision,
          ((SELECT COUNT(*) FROM media
            WHERE media.event_id = ?
              AND media.upload_state = 'stored'
              AND media.favorited_at IS NOT NULL
              AND ${ALBUM_SLOT_OWNER_SQL})
            + ? > ?) AS album_full,
          (NOT (${referenceGuard})) AS unknown_photo,
          (NOT (${retainedGuard})) AS dropped_retained
        FROM event_albums
        WHERE event_id = ?
      `).bind(
        eventId,
        sections,
        ALBUM_MAX_ENTRIES,
        submittedIds,
        eventId,
        eventId,
        submittedIds,
        eventId,
      ),
    ]);

    if (batch[1]?.meta.changes !== 1) {
      const diagnostic = batch[2]?.results[0] as {
        revision: number;
        album_full: number;
        unknown_photo: number;
        dropped_retained: number;
      } | undefined;
      if (diagnostic?.revision === expectedRevision && diagnostic.dropped_retained === 1) {
        throw new ApiError(
          'MEDIA_STATE_CONFLICT',
          'A photo in Recently deleted is still holding its place in this album. Reopen Album to see the current order.',
          409,
        );
      }
      if (diagnostic?.revision === expectedRevision && diagnostic.unknown_photo === 1) {
        throw new ApiError(
          'MEDIA_STATE_CONFLICT',
          'One of these photos is no longer part of this event. Reopen Album to see the current order.',
          409,
        );
      }
      if (diagnostic?.revision === expectedRevision && diagnostic.album_full === 1) {
        throw new ApiError(
          'ALBUM_FULL',
          `An album holds up to ${ALBUM_MAX_ENTRIES} photos and sections. Remove an entry before adding more.`,
          409,
        );
      }
      throw new ApiError(
        'REVISION_CONFLICT',
        'This album changed while you were arranging it. Reopen Album to see the current order.',
        409,
      );
    }
    return this.get(eventId, now);
  }

  /**
   * Answers the pre-album reconciliation prompt once.
   *
   * Every effect is in one D1 batch and conditioned on `saved_at IS NULL`, so two
   * hosts may race opposite answers but only the first transaction changes either
   * membership or order. A stale `Start empty` retry therefore cannot clear picks
   * added after reconciliation. Starting from picks freezes their current timeline
   * order so future picks append even when their capture time is earlier.
   */
  async start(
    eventId: string,
    choice: 'from-picks' | 'empty',
    now: string,
  ): Promise<{ album: AlbumView; started: boolean; cleared: string[] }> {
    const statements = [
      this.db.prepare(`
        INSERT OR IGNORE INTO event_albums (event_id, entries, saved_at, revision, created_at, updated_at)
        VALUES (?, '[]', NULL, 0, ?, ?)
      `).bind(eventId, now, now),
    ];
    let clearedResultIndex: number | null = null;
    let startedResultIndex: number;

    if (choice === 'from-picks') {
      startedResultIndex = statements.length;
      statements.push(this.db.prepare(`
        UPDATE event_albums
        SET entries = (
              SELECT COALESCE(
                json_group_array(json_object('kind', 'photo', 'mediaId', picked.id)),
                '[]'
              )
              FROM (
                SELECT media.id FROM media
                WHERE media.event_id = ?1
                  AND media.upload_state = 'stored'
                  AND media.favorited_at IS NOT NULL
                  AND ${ALBUM_SLOT_OWNER_SQL}
                ORDER BY media.timeline_at ASC, media.id ASC
              ) AS picked
            ),
            saved_at = ?2,
            updated_at = ?2
        WHERE event_id = ?1 AND saved_at IS NULL
          AND (SELECT COUNT(*) FROM media
            WHERE media.event_id = ?1
              AND media.upload_state = 'stored'
              AND media.favorited_at IS NOT NULL
              AND ${ALBUM_SLOT_OWNER_SQL}) <= ?3
      `).bind(eventId, now, ALBUM_MAX_ENTRIES));
    } else {
      clearedResultIndex = statements.length;
      statements.push(this.db.prepare(`
        UPDATE media
        SET favorited_at = NULL
        WHERE event_id = ?1
          AND upload_state = 'stored'
          AND favorited_at IS NOT NULL
          AND ${ALBUM_SLOT_OWNER_SQL}
          AND EXISTS (
            SELECT 1 FROM event_albums
            WHERE event_id = ?1 AND saved_at IS NULL
          )
        RETURNING id
      `).bind(eventId));
      startedResultIndex = statements.length;
      statements.push(this.db.prepare(`
        UPDATE event_albums
        SET entries = '[]', saved_at = ?2, updated_at = ?2
        WHERE event_id = ?1 AND saved_at IS NULL
      `).bind(eventId, now));
    }

    const diagnosticResultIndex = statements.length;
    statements.push(this.db.prepare(`
      SELECT saved_at,
        (SELECT COUNT(*) FROM media
          WHERE media.event_id = event_albums.event_id
            AND media.upload_state = 'stored'
            AND media.favorited_at IS NOT NULL
            AND ${ALBUM_SLOT_OWNER_SQL}) AS pick_count
      FROM event_albums
      WHERE event_id = ?
    `).bind(eventId));
    const results = await this.db.batch(statements);
    const started = results[startedResultIndex]?.meta.changes === 1;
    const diagnostic = results[diagnosticResultIndex]?.results[0] as {
      saved_at: string | null;
      pick_count: number;
    } | undefined;
    if (choice === 'from-picks' && !started && diagnostic?.saved_at === null
      && diagnostic.pick_count > ALBUM_MAX_ENTRIES) {
      throw new ApiError(
        'ALBUM_FULL',
        `An album holds up to ${ALBUM_MAX_ENTRIES} photos. Remove picks in Library before starting this album.`,
        409,
      );
    }
    const cleared = started && clearedResultIndex !== null
      ? ((results[clearedResultIndex]?.results as Array<{ id: string }> | undefined) ?? [])
        .map((row) => row.id)
      : [];
    return { album: await this.get(eventId), started, cleared };
  }
}

-- Album workspace: one curated artifact per event.
--
-- Membership is deliberately not stored here. A photo is in the album exactly
-- when `media.favorited_at IS NOT NULL` (0016), so every host on the event keeps
-- sharing one set and no per-photo state ships with this feature. What a row here
-- holds is the *order* that set is read in and the host-authored section headings
-- that divide it — the two things a set cannot express.
--
-- `entries` is one JSON array rather than a child table because the album is
-- bounded (`ALBUM_MAX_ENTRIES`) and every write replaces the whole list under a
-- revision guard. A child table would need a unique `(event_id, position)` index
-- that a reorder cannot satisfy without the deferred constraint SQLite lacks, and
-- the album has no query that selects one entry without reading its neighbours.
--
-- A photo id in `entries` is a position, never a membership claim. Reads intersect
-- the list with the currently favorited, stored, undeleted set, so a pick removed
-- elsewhere — or a photo deleted outright — leaves an id that is simply skipped.
-- That is why there is no foreign key to `media` and no cleanup obligation.
--
-- `saved_at` is NULL until the host first commits an album, and that is the entire
-- reconciliation signal: an event carrying favorites from before this feature opens
-- Album to a choice rather than to an artifact nobody curated.

CREATE TABLE event_albums (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  entries TEXT NOT NULL DEFAULT '[]',
  saved_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

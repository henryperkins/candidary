-- Host private Gallery: one effective timeline instant per stored photo, a
-- confirmed event-shared favorite stamp, and the chronological partial indexes
-- behind the unfiltered and Favorites-only reads.
--
-- The constant default keeps `timeline_at` NOT NULL without rebuilding `media`
-- and lets an older Worker that does not name the new columns keep inserting.
-- The sentinel is therefore not a valid stored-photo timeline value after
-- rollout; the application transitions write a canonical instant and a bounded
-- post-deploy repair clears rows an older Worker finalized in the mixed window.

ALTER TABLE media ADD COLUMN captured_at TEXT;
ALTER TABLE media ADD COLUMN timeline_at TEXT NOT NULL
  DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE media ADD COLUMN favorited_at TEXT;

UPDATE media
SET timeline_at = COALESCE(stored_at, created_at)
WHERE timeline_at = '1970-01-01T00:00:00.000Z';

CREATE INDEX media_private_gallery_timeline
ON media(event_id, timeline_at, id)
WHERE upload_state = 'stored' AND deleted_at IS NULL;

CREATE INDEX media_private_gallery_favorites
ON media(event_id, timeline_at, id)
WHERE upload_state = 'stored'
  AND deleted_at IS NULL
  AND favorited_at IS NOT NULL;

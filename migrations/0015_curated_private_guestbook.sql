ALTER TABLE events
ADD COLUMN guestbook_prompt TEXT NOT NULL
  DEFAULT 'Share a wish, memory, or moment from the day.'
  CHECK (length(trim(guestbook_prompt)) BETWEEN 1 AND 160);

-- Every pre-0015 pointer names the original bucket. New code changes this
-- discriminator only in the same D1 transaction that adopts canonical bytes.
ALTER TABLE media ADD COLUMN object_bucket_generation TEXT NOT NULL DEFAULT 'legacy'
  CHECK (object_bucket_generation IN ('legacy', 'canonical'));

CREATE TABLE guest_message_rate_events (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_scope_digest TEXT NOT NULL,
  ip_scope_digest TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX guestbook_rate_event_session_window
ON guest_message_rate_events(event_id, session_scope_digest, window_started_at);

CREATE INDEX guestbook_rate_event_ip_window
ON guest_message_rate_events(event_id, ip_scope_digest, window_started_at);

CREATE TABLE guest_message_purge_receipts (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hmac TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  PRIMARY KEY (event_id, guest_session_id, idempotency_key)
);

ALTER TABLE export_jobs ADD COLUMN guestbook_html_object_key TEXT;
ALTER TABLE export_jobs ADD COLUMN guestbook_html_bytes INTEGER
  CHECK (guestbook_html_bytes IS NULL OR guestbook_html_bytes >= 0);
ALTER TABLE export_jobs ADD COLUMN guestbook_html_sha256 TEXT;
ALTER TABLE export_jobs ADD COLUMN guestbook_csv_object_key TEXT;
ALTER TABLE export_jobs ADD COLUMN guestbook_csv_bytes INTEGER
  CHECK (guestbook_csv_bytes IS NULL OR guestbook_csv_bytes >= 0);
ALTER TABLE export_jobs ADD COLUMN guestbook_csv_sha256 TEXT;
ALTER TABLE export_jobs ADD COLUMN guestbook_entry_count INTEGER
  CHECK (guestbook_entry_count IS NULL OR guestbook_entry_count >= 0);
ALTER TABLE export_jobs ADD COLUMN guestbook_shared_count INTEGER
  CHECK (
    guestbook_shared_count IS NULL
    OR (guestbook_shared_count >= 0 AND guestbook_shared_count <= guestbook_entry_count)
  );
ALTER TABLE export_jobs ADD COLUMN guestbook_event_name TEXT;
ALTER TABLE export_jobs ADD COLUMN guestbook_event_date TEXT;
ALTER TABLE export_jobs ADD COLUMN guestbook_event_timezone TEXT;
ALTER TABLE export_jobs ADD COLUMN guestbook_prompt TEXT
  CHECK (guestbook_prompt IS NULL OR length(trim(guestbook_prompt)) BETWEEN 1 AND 160);
ALTER TABLE export_jobs ADD COLUMN guestbook_gallery_visible INTEGER
  CHECK (guestbook_gallery_visible IS NULL OR guestbook_gallery_visible IN (0, 1));

CREATE TABLE export_guestbook_entries (
  export_job_id TEXT NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('guest_note', 'photo_caption')),
  source_id TEXT NOT NULL,
  source_rank INTEGER NOT NULL CHECK (source_rank IN (0, 1)),
  guest_name TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_state TEXT NOT NULL CHECK (
    (source = 'guest_note' AND source_state IN ('pending', 'approved', 'rejected'))
    OR (source = 'photo_caption' AND source_state IN ('unpublished', 'published', 'hidden'))
  ),
  guest_visibility TEXT NOT NULL CHECK (guest_visibility IN ('shared', 'author_only')),
  included_in_keepsake INTEGER NOT NULL CHECK (included_in_keepsake IN (0, 1)),
  media_id TEXT,
  original_filename TEXT,
  PRIMARY KEY (export_job_id, source, source_id),
  CHECK (
    (source = 'guest_note' AND source_rank = 0 AND media_id IS NULL AND original_filename IS NULL)
    OR (source = 'photo_caption' AND source_rank = 1 AND media_id = source_id)
  )
);

CREATE INDEX guestbook_export_render_order
ON export_guestbook_entries(export_job_id, created_at ASC, source_rank DESC, source_id ASC);

-- Freeze the exact photo membership and export metadata alongside the job.
-- This intentionally does not reference media: deleting a live media row after
-- snapshotAt must not rewrite or cascade the historical export snapshot.
CREATE TABLE export_media_entries (
  export_job_id TEXT NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  object_bucket_generation TEXT NOT NULL
    CHECK (object_bucket_generation IN ('legacy', 'canonical')),
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  declared_byte_size INTEGER NOT NULL CHECK (declared_byte_size >= 0),
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  guest_name TEXT NOT NULL,
  caption TEXT,
  publication_status TEXT NOT NULL CHECK (
    publication_status IN ('unpublished', 'published', 'hidden')
  ),
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (export_job_id, media_id)
);

CREATE INDEX export_media_entries_order
ON export_media_entries(export_job_id, created_at ASC, media_id ASC);

CREATE INDEX guestbook_notes_event_owner
ON guest_messages(event_id, guest_session_id, created_at);

CREATE INDEX guestbook_notes_event_feed
ON guest_messages(event_id, moderation_status, deleted_at, created_at DESC, id DESC);

-- This inventory intentionally has no foreign keys. An old presigned PUT or an
-- already-admitted R2 write can land after its media and event rows are gone, so
-- discovery must survive relational purge permanently. Absence observations are
-- telemetry only: ordinary runtime never retires one of these rows.
CREATE TABLE media_object_write_tombstones (
  bucket_generation TEXT NOT NULL DEFAULT 'legacy'
    CHECK (bucket_generation IN ('legacy', 'canonical')),
  object_key TEXT NOT NULL CHECK (length(object_key) > 0),
  event_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (
    object_kind IN ('source', 'final', 'preview', 'export', 'cover')
  ),
  suppression_started_at TEXT,
  last_observed_at TEXT,
  last_observed_present INTEGER CHECK (
    last_observed_present IS NULL OR last_observed_present IN (0, 1)
  ),
  next_check_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_generation, object_key),
  CHECK (
    (last_observed_at IS NULL AND last_observed_present IS NULL)
    OR (
      last_observed_at IS NOT NULL
      AND last_observed_present IS NOT NULL
      AND suppression_started_at IS NOT NULL
    )
  )
);

CREATE INDEX media_object_write_tombstones_schedule
ON media_object_write_tombstones(next_check_at, bucket_generation, object_key);

CREATE INDEX media_object_write_tombstones_event
ON media_object_write_tombstones(event_id, media_id, object_kind);

CREATE TRIGGER media_object_write_tombstone_permanent
BEFORE DELETE ON media_object_write_tombstones
BEGIN
  SELECT RAISE(ABORT, 'media object write tombstones are permanent');
END;

CREATE TRIGGER media_object_write_tombstone_immutable
BEFORE UPDATE ON media_object_write_tombstones
WHEN NEW.object_key <> OLD.object_key
  OR NEW.bucket_generation <> OLD.bucket_generation
  OR NEW.event_id <> OLD.event_id
  OR NEW.media_id <> OLD.media_id
  OR NEW.object_kind <> OLD.object_kind
  OR NEW.created_at <> OLD.created_at
  OR (
    OLD.suppression_started_at IS NOT NULL
    AND NEW.suppression_started_at IS NOT OLD.suppression_started_at
  )
BEGIN
  SELECT RAISE(ABORT, 'media object write tombstone identity is immutable');
END;

-- A suppressed target can never become live again. This closes both an exact
-- key replay and reuse of a media ID after any one of its permanent targets has
-- entered suppression.
CREATE TRIGGER media_object_write_tombstone_guard_insert
BEFORE INSERT ON media
WHEN (NEW.object_bucket_generation = 'canonical' AND NEW.preview_object_key IS NOT NULL)
  OR (
    NEW.deleted_at IS NULL
    AND NEW.upload_state IN ('reserved', 'stored')
    AND EXISTS (
      SELECT 1 FROM media_object_write_tombstones AS t
      WHERE t.suppression_started_at IS NOT NULL
        AND t.object_kind NOT IN ('export', 'cover')
        AND (
          (t.event_id = NEW.event_id AND t.media_id = NEW.id)
          OR (t.bucket_generation = NEW.object_bucket_generation AND t.object_key = NEW.object_key)
          OR (NEW.preview_object_key IS NOT NULL
            AND t.bucket_generation = 'legacy' AND t.object_key = NEW.preview_object_key)
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'media object write target is permanently suppressed');
END;

CREATE TRIGGER media_object_write_tombstone_guard_update
BEFORE UPDATE OF event_id, object_key, object_bucket_generation,
  preview_object_key, upload_state, deleted_at ON media
WHEN (NEW.object_bucket_generation = 'canonical' AND NEW.preview_object_key IS NOT NULL)
  OR (
    NEW.deleted_at IS NULL
    AND NEW.upload_state IN ('reserved', 'stored')
    AND EXISTS (
      SELECT 1 FROM media_object_write_tombstones AS t
      WHERE t.suppression_started_at IS NOT NULL
        AND t.object_kind NOT IN ('export', 'cover')
        AND (
          (t.event_id = NEW.event_id AND t.media_id = NEW.id)
          OR (t.bucket_generation = NEW.object_bucket_generation AND t.object_key = NEW.object_key)
          OR (NEW.preview_object_key IS NOT NULL
            AND t.bucket_generation = 'legacy' AND t.object_key = NEW.preview_object_key)
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'media object write target is permanently suppressed');
END;

-- Seed every target an old Worker may already have authorized or written. UNION
-- de-duplicates the deterministic and recorded preview when they are identical;
-- a real cross-media/kind collision still aborts the migration at the PK.
INSERT INTO media_object_write_tombstones (
  bucket_generation, object_key, event_id, media_id, object_kind,
  next_check_at, created_at, updated_at
)
SELECT bucket_generation, object_key, event_id, media_id, object_kind,
       observed_at, observed_at, observed_at
FROM (
  SELECT 'legacy' AS bucket_generation, m.object_key, m.event_id,
         m.id AS media_id, 'source' AS object_kind,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS observed_at
  FROM media AS m
  UNION
  SELECT 'canonical', 'events/' || m.event_id || '/media/final/' || m.id,
         m.event_id, m.id, 'final', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM media AS m
  UNION
  SELECT 'legacy', 'events/' || m.event_id || '/previews/' || m.id || '.webp',
         m.event_id, m.id, 'preview', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM media AS m
  UNION
  SELECT 'legacy', m.preview_object_key, m.event_id, m.id, 'preview',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM media AS m WHERE m.preview_object_key IS NOT NULL
);

-- New and old Workers both create media through these rows. Inventory every
-- possible target in the same D1 transaction, before a later request can write.
CREATE TRIGGER media_object_write_tombstone_inventory_insert
AFTER INSERT ON media
BEGIN
  INSERT INTO media_object_write_tombstones (
    bucket_generation, object_key, event_id, media_id, object_kind,
    next_check_at, created_at, updated_at
  )
  SELECT NEW.object_bucket_generation, NEW.object_key, NEW.event_id, NEW.id,
         CASE NEW.object_bucket_generation WHEN 'canonical' THEN 'final' ELSE 'source' END,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ON CONFLICT (bucket_generation, object_key) DO UPDATE SET updated_at = media_object_write_tombstones.updated_at
  WHERE media_object_write_tombstones.event_id = excluded.event_id
    AND media_object_write_tombstones.media_id = excluded.media_id
    AND media_object_write_tombstones.object_kind = excluded.object_kind;
  SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM media_object_write_tombstones
      WHERE bucket_generation = NEW.object_bucket_generation
        AND object_key = NEW.object_key AND event_id = NEW.event_id
        AND media_id = NEW.id
        AND object_kind = CASE NEW.object_bucket_generation
          WHEN 'canonical' THEN 'final' ELSE 'source' END
    ) THEN RAISE(ABORT, 'media object write tombstone ownership collision') END;

  INSERT INTO media_object_write_tombstones (
    bucket_generation, object_key, event_id, media_id, object_kind,
    next_check_at, created_at, updated_at
  ) VALUES (
    'canonical', 'events/' || NEW.event_id || '/media/final/' || NEW.id,
    NEW.event_id, NEW.id, 'final',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (bucket_generation, object_key) DO UPDATE SET updated_at = media_object_write_tombstones.updated_at
  WHERE media_object_write_tombstones.event_id = excluded.event_id
    AND media_object_write_tombstones.media_id = excluded.media_id
    AND media_object_write_tombstones.object_kind = excluded.object_kind;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media_object_write_tombstones
    WHERE bucket_generation = 'canonical'
      AND object_key = ('events/' || NEW.event_id || '/media/final/' || NEW.id)
      AND event_id = NEW.event_id AND media_id = NEW.id AND object_kind = 'final'
  ) THEN RAISE(ABORT, 'media object write tombstone ownership collision') END;

  INSERT INTO media_object_write_tombstones (
    bucket_generation, object_key, event_id, media_id, object_kind,
    next_check_at, created_at, updated_at
  ) VALUES (
    'legacy', 'events/' || NEW.event_id || '/previews/' || NEW.id || '.webp',
    NEW.event_id, NEW.id, 'preview',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (bucket_generation, object_key) DO UPDATE SET updated_at = media_object_write_tombstones.updated_at
  WHERE media_object_write_tombstones.event_id = excluded.event_id
    AND media_object_write_tombstones.media_id = excluded.media_id
    AND media_object_write_tombstones.object_kind = excluded.object_kind;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM media_object_write_tombstones
    WHERE bucket_generation = 'legacy'
      AND object_key = ('events/' || NEW.event_id || '/previews/' || NEW.id || '.webp')
      AND event_id = NEW.event_id AND media_id = NEW.id AND object_kind = 'preview'
  ) THEN RAISE(ABORT, 'media object write tombstone ownership collision') END;

  INSERT INTO media_object_write_tombstones (
    bucket_generation, object_key, event_id, media_id, object_kind,
    next_check_at, created_at, updated_at
  )
  SELECT 'legacy', NEW.preview_object_key, NEW.event_id, NEW.id, 'preview',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.preview_object_key IS NOT NULL
  ON CONFLICT (bucket_generation, object_key) DO UPDATE SET updated_at = media_object_write_tombstones.updated_at
  WHERE media_object_write_tombstones.event_id = excluded.event_id
    AND media_object_write_tombstones.media_id = excluded.media_id
    AND media_object_write_tombstones.object_kind = excluded.object_kind;
  SELECT CASE WHEN NEW.preview_object_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_object_write_tombstones
    WHERE bucket_generation = 'legacy' AND object_key = NEW.preview_object_key
      AND event_id = NEW.event_id
      AND media_id = NEW.id AND object_kind = 'preview'
  ) THEN RAISE(ABORT, 'media object write tombstone ownership collision') END;
END;

CREATE TRIGGER media_object_write_tombstone_inventory_update
AFTER UPDATE OF event_id, object_key, object_bucket_generation, preview_object_key ON media
BEGIN
  INSERT INTO media_object_write_tombstones (
    bucket_generation, object_key, event_id, media_id, object_kind,
    next_check_at, created_at, updated_at
  )
  SELECT NEW.object_bucket_generation, NEW.object_key, NEW.event_id, NEW.id,
         CASE NEW.object_bucket_generation WHEN 'canonical' THEN 'final' ELSE 'source' END,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ON CONFLICT (bucket_generation, object_key) DO UPDATE SET updated_at = media_object_write_tombstones.updated_at
  WHERE media_object_write_tombstones.event_id = excluded.event_id
    AND media_object_write_tombstones.media_id = excluded.media_id
    AND media_object_write_tombstones.object_kind = excluded.object_kind;
  SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM media_object_write_tombstones
      WHERE bucket_generation = NEW.object_bucket_generation
        AND object_key = NEW.object_key AND event_id = NEW.event_id
        AND media_id = NEW.id
        AND object_kind = CASE NEW.object_bucket_generation
          WHEN 'canonical' THEN 'final' ELSE 'source' END
    ) THEN RAISE(ABORT, 'media object write tombstone ownership collision') END;

  INSERT INTO media_object_write_tombstones (
    bucket_generation, object_key, event_id, media_id, object_kind,
    next_check_at, created_at, updated_at
  )
  SELECT 'legacy', NEW.preview_object_key, NEW.event_id, NEW.id, 'preview',
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE NEW.preview_object_key IS NOT NULL
  ON CONFLICT (bucket_generation, object_key) DO UPDATE SET updated_at = media_object_write_tombstones.updated_at
  WHERE media_object_write_tombstones.event_id = excluded.event_id
    AND media_object_write_tombstones.media_id = excluded.media_id
    AND media_object_write_tombstones.object_kind = excluded.object_kind;
  SELECT CASE WHEN NEW.preview_object_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM media_object_write_tombstones
    WHERE bucket_generation = 'legacy' AND object_key = NEW.preview_object_key
      AND event_id = NEW.event_id
      AND media_id = NEW.id AND object_kind = 'preview'
  ) THEN RAISE(ABORT, 'media object write tombstone ownership collision') END;
END;

-- Existing stored photos used the same R2 key that a ten-minute presigned PUT
-- authorized.  Keep a durable, RESTRICT-backed inventory while those writable
-- aliases are promoted to the canonical immutable key.  A promotion survives
-- Worker interruption in one of four explicit states:
--
-- * pending: no invocation owns an R2 write;
-- * copying: one scheduled invocation owns the write until lease_expires_at;
-- * target_verified: the immutable canonical target and its complete frozen
--   source proof are durable, but D1 still points at the legacy snapshot;
-- * cleanup_pending: D1 points at the final key and the old alias still needs
--   verified deletion after its signed-write horizon has elapsed.
CREATE TABLE media_object_promotions (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  source_bucket_generation TEXT NOT NULL DEFAULT 'legacy'
    CHECK (source_bucket_generation = 'legacy'),
  source_object_key TEXT NOT NULL,
  final_bucket_generation TEXT NOT NULL DEFAULT 'canonical'
    CHECK (final_bucket_generation = 'canonical'),
  final_object_key TEXT NOT NULL UNIQUE,
  source_etag TEXT,
  source_mime_type TEXT,
  source_byte_size INTEGER CHECK (source_byte_size IS NULL OR source_byte_size > 0),
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR length(source_sha256) = 64),
  source_width INTEGER CHECK (source_width IS NULL OR source_width > 0),
  source_height INTEGER CHECK (source_height IS NULL OR source_height > 0),
  final_etag TEXT,
  target_verified_at TEXT,
  source_writable_until TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'copying', 'target_verified', 'cleanup_pending')),
  final_pointer_committed INTEGER NOT NULL DEFAULT 0
    CHECK (final_pointer_committed IN (0, 1)),
  claim_token TEXT,
  lease_expires_at TEXT,
  source_absent_since TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_absent_since IS NULL OR state = 'cleanup_pending'),
  CHECK (
    (state = 'pending'
      AND final_pointer_committed = 0
      AND claim_token IS NULL AND lease_expires_at IS NULL
      AND source_absent_since IS NULL
      AND source_etag IS NULL AND source_mime_type IS NULL
      AND source_byte_size IS NULL AND source_sha256 IS NULL
      AND source_width IS NULL AND source_height IS NULL
      AND final_etag IS NULL AND target_verified_at IS NULL)
    OR (state = 'copying'
      AND final_pointer_committed = 0
      AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND source_absent_since IS NULL
      AND final_etag IS NULL AND target_verified_at IS NULL
      AND (
        (source_etag IS NULL AND source_mime_type IS NULL
          AND source_byte_size IS NULL AND source_sha256 IS NULL
          AND source_width IS NULL AND source_height IS NULL)
        OR (source_etag IS NOT NULL AND source_mime_type IS NOT NULL
          AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
          AND source_width IS NOT NULL AND source_height IS NOT NULL)
      ))
    OR (state = 'target_verified'
      AND final_pointer_committed = 0
      AND claim_token IS NOT NULL AND lease_expires_at IS NULL
      AND source_absent_since IS NULL
      AND source_etag IS NOT NULL AND source_mime_type IS NOT NULL
      AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
      AND source_width IS NOT NULL AND source_height IS NOT NULL
      AND final_etag IS NOT NULL AND target_verified_at IS NOT NULL)
    OR (state = 'cleanup_pending'
      AND claim_token IS NOT NULL AND lease_expires_at IS NULL
      AND (
        (final_pointer_committed = 1
          AND source_etag IS NOT NULL AND source_mime_type IS NOT NULL
          AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
          AND source_width IS NOT NULL AND source_height IS NOT NULL
          AND final_etag IS NOT NULL AND target_verified_at IS NOT NULL)
        OR (final_pointer_committed = 0
          AND (
            (source_etag IS NULL AND source_mime_type IS NULL
              AND source_byte_size IS NULL AND source_sha256 IS NULL
              AND source_width IS NULL AND source_height IS NULL
              AND final_etag IS NULL AND target_verified_at IS NULL)
            OR (source_etag IS NOT NULL AND source_mime_type IS NOT NULL
              AND source_byte_size IS NOT NULL AND source_sha256 IS NOT NULL
              AND source_width IS NOT NULL AND source_height IS NOT NULL
              AND final_etag IS NOT NULL AND target_verified_at IS NOT NULL)
          ))
      ))
  )
);

-- A verified canonical snapshot is a monotone release proof, not a lease. Its
-- identity and hashes may survive only unchanged until the exact pointer CAS or
-- an inactive handoff moves the row to cleanup_pending. Direct deletion would
-- erase the canonical target's finite ownership before permanent suppression.
CREATE TRIGGER media_object_promotion_verified_proof_immutable
BEFORE UPDATE ON media_object_promotions
WHEN OLD.state = 'target_verified'
  AND (
    NEW.state NOT IN ('target_verified', 'cleanup_pending')
    OR NEW.media_id IS NOT OLD.media_id
    OR NEW.event_id IS NOT OLD.event_id
    OR NEW.source_bucket_generation IS NOT OLD.source_bucket_generation
    OR NEW.source_object_key IS NOT OLD.source_object_key
    OR NEW.final_bucket_generation IS NOT OLD.final_bucket_generation
    OR NEW.final_object_key IS NOT OLD.final_object_key
    OR NEW.source_etag IS NOT OLD.source_etag
    OR NEW.source_mime_type IS NOT OLD.source_mime_type
    OR NEW.source_byte_size IS NOT OLD.source_byte_size
    OR NEW.source_sha256 IS NOT OLD.source_sha256
    OR NEW.source_width IS NOT OLD.source_width
    OR NEW.source_height IS NOT OLD.source_height
    OR NEW.final_etag IS NOT OLD.final_etag
    OR NEW.target_verified_at IS NOT OLD.target_verified_at
    OR NEW.source_writable_until IS NOT OLD.source_writable_until
    OR NEW.claim_token IS NOT OLD.claim_token
    OR NEW.created_at IS NOT OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'verified media target proof is immutable');
END;

CREATE TRIGGER media_object_promotion_verified_delete_guard
BEFORE DELETE ON media_object_promotions
WHEN OLD.state = 'target_verified'
BEGIN
  SELECT RAISE(ABORT, 'verified media target requires suppression handoff');
END;

-- Permanent progress for the old-bucket namespace scanner. A completed epoch
-- wraps to NULL and begins again; it is never evidence that late writes stopped.
CREATE TABLE legacy_media_scan_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  cursor TEXT,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  epoch_started_at TEXT NOT NULL,
  epoch_discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (epoch_discovered_count >= 0),
  epoch_error_count INTEGER NOT NULL DEFAULT 0 CHECK (epoch_error_count >= 0),
  epoch_max_hourly_growth INTEGER NOT NULL DEFAULT 0 CHECK (epoch_max_hourly_growth >= 0),
  last_observed_at TEXT,
  last_observed_inventory_count INTEGER NOT NULL DEFAULT 0
    CHECK (last_observed_inventory_count >= 0),
  last_error_at TEXT,
  last_completed_at TEXT,
  last_completed_started_at TEXT,
  last_completed_discovered_count INTEGER
    CHECK (last_completed_discovered_count IS NULL OR last_completed_discovered_count >= 0),
  last_completed_error_count INTEGER
    CHECK (last_completed_error_count IS NULL OR last_completed_error_count >= 0),
  last_completed_max_hourly_growth INTEGER
    CHECK (last_completed_max_hourly_growth IS NULL OR last_completed_max_hourly_growth >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO legacy_media_scan_state (
  singleton, cursor, epoch, epoch_started_at, updated_at
) VALUES (
  1, NULL, 0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE legacy_media_scan_quarantine (
  object_key TEXT PRIMARY KEY CHECK (length(object_key) > 0),
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  observation_count INTEGER NOT NULL CHECK (observation_count > 0)
);

CREATE TRIGGER legacy_media_scan_state_permanent
BEFORE DELETE ON legacy_media_scan_state BEGIN
  SELECT RAISE(ABORT, 'legacy media scan state is permanent');
END;

CREATE TRIGGER legacy_media_scan_quarantine_permanent
BEFORE DELETE ON legacy_media_scan_quarantine BEGIN
  SELECT RAISE(ABORT, 'legacy media scan quarantine is permanent');
END;

CREATE INDEX media_object_promotions_schedule
ON media_object_promotions(state, updated_at, media_id);

CREATE INDEX media_object_promotions_event_state
ON media_object_promotions(event_id, state, updated_at);

-- Migration 0015 is the categorical boundary after the bridge has disabled old
-- upload signing. Existing live Stored legacy rows are grandfathered for the
-- copy-only pass, but no statement after this trigger exists may create one.
CREATE TRIGGER media_stored_legacy_guard_insert
BEFORE INSERT ON media
WHEN NEW.deleted_at IS NULL
  AND NEW.upload_state = 'stored'
  AND NEW.object_bucket_generation = 'legacy'
BEGIN
  SELECT RAISE(ABORT, 'legacy stored media creation is fenced');
END;

CREATE TRIGGER media_stored_legacy_guard_update
BEFORE UPDATE OF event_id, upload_state, deleted_at, object_key,
  object_bucket_generation, mime_type, byte_size, width, height ON media
WHEN NEW.deleted_at IS NULL
  AND NEW.upload_state = 'stored'
  AND NEW.object_bucket_generation = 'legacy'
  AND NOT (
    OLD.deleted_at IS NULL
    AND OLD.upload_state = 'stored'
    AND OLD.object_bucket_generation = 'legacy'
    AND OLD.event_id = NEW.event_id
    AND OLD.object_key = NEW.object_key
    AND OLD.mime_type = NEW.mime_type
    AND OLD.byte_size = NEW.byte_size
    AND OLD.width = NEW.width
    AND OLD.height = NEW.height
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy stored media creation is fenced');
END;

-- Seed every noncanonical media pointer before the migration commits, including
-- failed/deleted rows that may still have a live or in-flight signed write. This
-- makes event/media deletion fail closed in the migration-to-deploy window.
INSERT INTO media_object_promotions (
  media_id, event_id, source_object_key, final_object_key,
  source_writable_until, state, created_at, updated_at
)
SELECT
  m.id, m.event_id, m.object_key,
  'events/' || m.event_id || '/media/final/' || m.id,
  m.reservation_expires_at, 'pending',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM media AS m
WHERE m.object_bucket_generation = 'legacy';

-- The bridge has already disabled legacy finalization before 0015 commits.
-- These inventory triggers remain load-bearing for exact pending reservations:
-- moderation/preview updates must not reset or steal an active claim, while an
-- idempotent reservation refresh must monotonically extend its writable horizon.
CREATE TRIGGER media_object_promotion_inventory_insert
AFTER INSERT ON media
WHEN NEW.deleted_at IS NULL
  AND NEW.object_bucket_generation = 'legacy'
  AND (
    NEW.upload_state = 'reserved'
    OR NEW.upload_state = 'stored'
  )
BEGIN
  INSERT INTO media_object_promotions (
    media_id, event_id, source_object_key, final_object_key,
    source_writable_until, state, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.event_id, NEW.object_key,
    'events/' || NEW.event_id || '/media/final/' || NEW.id,
    NEW.reservation_expires_at, 'pending',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (media_id) DO UPDATE SET
    source_writable_until = max(
      media_object_promotions.source_writable_until,
      excluded.source_writable_until
    ),
    updated_at = excluded.updated_at
  WHERE NEW.upload_state = 'reserved'
    AND media_object_promotions.state = 'pending'
    AND media_object_promotions.source_bucket_generation = 'legacy'
    AND media_object_promotions.source_object_key = excluded.source_object_key;
END;

-- Fail closed if old Worker code tries to reactivate a failed reservation or
-- extend a reserved row and mint a presigned PUT. Only an unowned, exact-key
-- pending inventory row may acquire/extend that capability; the AFTER trigger
-- below then moves the durable writable horizon forward monotonically.
CREATE TRIGGER media_object_promotion_reservation_capability_guard
BEFORE UPDATE OF upload_state, object_key, object_bucket_generation,
  reservation_expires_at ON media
WHEN NEW.deleted_at IS NULL
  AND (
    (
      NEW.upload_state = 'reserved'
      AND NEW.object_bucket_generation = 'legacy'
      AND (
        OLD.upload_state <> 'reserved'
        OR NEW.reservation_expires_at > OLD.reservation_expires_at
      )
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM media_object_promotions AS p
    WHERE p.media_id = NEW.id
      AND p.event_id = NEW.event_id
      AND p.source_bucket_generation = NEW.object_bucket_generation
      AND p.source_object_key = NEW.object_key
      AND p.state = 'pending'
  )
BEGIN
  SELECT RAISE(ABORT, 'media reservation capability is fenced');
END;

CREATE TRIGGER media_object_promotion_inventory_update
AFTER UPDATE OF upload_state, object_key, object_bucket_generation,
  deleted_at, reservation_expires_at ON media
WHEN NEW.deleted_at IS NULL
  AND NEW.object_bucket_generation = 'legacy'
  AND (
    NEW.upload_state = 'reserved'
    OR NEW.upload_state = 'stored'
  )
BEGIN
  INSERT INTO media_object_promotions (
    media_id, event_id, source_object_key, final_object_key,
    source_writable_until, state, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.event_id, NEW.object_key,
    'events/' || NEW.event_id || '/media/final/' || NEW.id,
    NEW.reservation_expires_at, 'pending',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (media_id) DO UPDATE SET
    source_writable_until = max(
      media_object_promotions.source_writable_until,
      excluded.source_writable_until
    ),
    updated_at = excluded.updated_at
  WHERE NEW.upload_state = 'reserved'
    AND media_object_promotions.state = 'pending'
    AND media_object_promotions.source_bucket_generation = 'legacy'
    AND media_object_promotions.source_object_key = excluded.source_object_key;
END;

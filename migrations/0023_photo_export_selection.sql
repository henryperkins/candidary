-- Selection snapshots; admission stays closed until migration/Worker/device acceptance.
-- Foreign keys stay ON. Parent DROP cascades even with deferred foreign keys:
-- preserve every child row separately before replacement, restore before commit.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE export_media_entries_0023_backup AS SELECT * FROM export_media_entries;
CREATE TABLE export_parts_0023_backup AS SELECT * FROM export_parts;
CREATE TABLE export_guestbook_entries_0023_backup AS SELECT * FROM export_guestbook_entries;
DROP TRIGGER export_source_hold_tombstone_insert;
DROP TRIGGER export_source_hold_tombstone_suppress;
DROP TRIGGER export_media_entry_suppressed_source_insert;
DROP TRIGGER export_jobs_entryless_queued_insert;
DROP TRIGGER export_jobs_running_source_fence;
DROP TRIGGER export_jobs_retry_source_fence;
DROP TRIGGER export_jobs_progress_insert;
DROP TRIGGER export_jobs_progress_update;
DROP TRIGGER export_jobs_execution_insert;
DROP TRIGGER export_jobs_execution_update;
DROP TRIGGER export_protocol_admission_no_insert;
DROP TRIGGER export_protocol_admission_transition;
DROP TRIGGER export_protocol_admission_no_delete;
DROP TRIGGER export_jobs_protocol_admission_insert;
DROP TRIGGER export_jobs_protocol_admission_update;
CREATE TABLE export_jobs_selection_migration (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'expired', 'delivered', 'handed-off', 'cancelled')),
  snapshot_at TEXT NOT NULL,
  object_key TEXT,
  media_count INTEGER NOT NULL CHECK (media_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT
, manifest_object_key TEXT, part_count INTEGER NOT NULL DEFAULT 0 CHECK (part_count >= 0), guestbook_html_object_key TEXT, guestbook_html_bytes INTEGER
  CHECK (guestbook_html_bytes IS NULL OR guestbook_html_bytes >= 0), guestbook_html_sha256 TEXT, guestbook_csv_object_key TEXT, guestbook_csv_bytes INTEGER
  CHECK (guestbook_csv_bytes IS NULL OR guestbook_csv_bytes >= 0), guestbook_csv_sha256 TEXT, guestbook_entry_count INTEGER
  CHECK (guestbook_entry_count IS NULL OR guestbook_entry_count >= 0), guestbook_shared_count INTEGER
  CHECK (
    guestbook_shared_count IS NULL
    OR (guestbook_shared_count >= 0 AND guestbook_shared_count <= guestbook_entry_count)
  ), guestbook_event_name TEXT, guestbook_event_date TEXT, guestbook_event_timezone TEXT, guestbook_prompt TEXT
  CHECK (guestbook_prompt IS NULL OR length(trim(guestbook_prompt)) BETWEEN 1 AND 160), guestbook_gallery_visible INTEGER
  CHECK (guestbook_gallery_visible IS NULL OR guestbook_gallery_visible IN (0, 1)), kind TEXT NOT NULL DEFAULT 'complete'
  CHECK (kind IN ('complete', 'album', 'selection')), album_entries_json TEXT
  CHECK (
    (kind = 'complete' AND album_entries_json IS NULL)
    OR (kind = 'selection' AND album_entries_json IS NULL)
    OR (kind = 'album' AND album_entries_json IS NOT NULL
        AND json_valid(album_entries_json) AND json_type(album_entries_json) = 'array')
  ), processed_media_count INTEGER
  CHECK (processed_media_count IS NULL OR processed_media_count >= 0), processed_bytes INTEGER
  CHECK (processed_bytes IS NULL OR processed_bytes >= 0), progress_updated_at TEXT, execution_protocol TEXT NOT NULL DEFAULT 'legacy'
  CHECK (execution_protocol IN ('legacy', 'attempt-v2', 'selection-v1')), execution_transition INTEGER NOT NULL DEFAULT 0
  CHECK (execution_transition >= 0), execution_started_at TEXT,
  destination TEXT NOT NULL DEFAULT 'archive' CHECK (destination IN ('archive', 'device', 'google-photos', 'onedrive')),
  source_json TEXT,
  request_digest TEXT,
  idempotency_key TEXT,
  initiating_principal TEXT,
  confirmed_at TEXT,
  hold_expires_at TEXT,
  absolute_expires_at TEXT,
  cancel_requested_at TEXT,
  CHECK (
    (kind IN ('complete', 'album') AND execution_protocol IN ('legacy', 'attempt-v2')
      AND destination = 'archive' AND source_json IS NULL AND request_digest IS NULL
      AND idempotency_key IS NULL AND initiating_principal IS NULL AND confirmed_at IS NULL
      AND hold_expires_at IS NULL AND absolute_expires_at IS NULL AND cancel_requested_at IS NULL
      AND state IN ('queued', 'running', 'ready', 'failed', 'expired'))
    OR (kind = 'selection' AND execution_protocol = 'selection-v1' AND media_count > 0
      AND typeof(source_json) = 'text' AND json_valid(source_json)
      AND json_extract(source_json, '$.version') IS 1 AND json_type(source_json, '$.source') IS 'object'
      AND typeof(request_digest) = 'text' AND length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
      AND typeof(idempotency_key) = 'text' AND length(idempotency_key) BETWEEN 1 AND 128
      AND typeof(initiating_principal) = 'text' AND length(initiating_principal) > 0
      AND typeof(hold_expires_at) = 'text' AND typeof(absolute_expires_at) = 'text'
      AND hold_expires_at <= absolute_expires_at AND absolute_expires_at > created_at
      AND guestbook_html_object_key IS NULL AND guestbook_html_bytes IS NULL AND guestbook_html_sha256 IS NULL AND guestbook_csv_object_key IS NULL AND guestbook_csv_bytes IS NULL AND guestbook_csv_sha256 IS NULL AND guestbook_entry_count IS NULL AND guestbook_shared_count IS NULL AND guestbook_event_name IS NULL AND guestbook_event_date IS NULL AND guestbook_event_timezone IS NULL AND guestbook_prompt IS NULL AND guestbook_gallery_visible IS NULL
      AND (state <> 'ready' OR destination = 'archive')
      AND (state <> 'handed-off' OR destination = 'device')
      AND (state <> 'delivered' OR destination IN ('google-photos', 'onedrive')))
  )
);
INSERT INTO export_jobs_selection_migration SELECT export_jobs.*, 'archive', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM export_jobs;
DROP TABLE export_jobs;
ALTER TABLE export_jobs_selection_migration RENAME TO export_jobs;
CREATE UNIQUE INDEX export_jobs_one_active_per_event
  ON export_jobs(event_id)
  WHERE state IN ('queued', 'running');
CREATE INDEX export_jobs_expiry ON export_jobs(state, expires_at);
CREATE UNIQUE INDEX photo_export_idempotency ON export_jobs(event_id, initiating_principal, idempotency_key) WHERE kind = 'selection';
INSERT INTO export_media_entries SELECT * FROM export_media_entries_0023_backup;
DROP TABLE export_media_entries_0023_backup;
INSERT INTO export_parts SELECT * FROM export_parts_0023_backup;
DROP TABLE export_parts_0023_backup;
INSERT INTO export_guestbook_entries SELECT * FROM export_guestbook_entries_0023_backup;
DROP TABLE export_guestbook_entries_0023_backup;

CREATE TRIGGER export_source_hold_tombstone_insert
BEFORE INSERT ON media_object_write_tombstones
WHEN NEW.suppression_started_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM export_media_entries AS e
    JOIN export_jobs AS j ON j.id = e.export_job_id
    WHERE e.object_bucket_generation = NEW.bucket_generation
      AND e.object_key = NEW.object_key
      AND j.state IN ('queued', 'running')
  )
BEGIN
  SELECT RAISE(ABORT, 'an active export holds this source object');
END;

CREATE TRIGGER export_source_hold_tombstone_suppress
BEFORE UPDATE OF suppression_started_at ON media_object_write_tombstones
WHEN OLD.suppression_started_at IS NULL
  AND NEW.suppression_started_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM export_media_entries AS e
    JOIN export_jobs AS j ON j.id = e.export_job_id
    WHERE e.object_bucket_generation = NEW.bucket_generation
      AND e.object_key = NEW.object_key
      AND j.state IN ('queued', 'running')
  )
BEGIN
  SELECT RAISE(ABORT, 'an active export holds this source object');
END;

CREATE TRIGGER export_media_entry_suppressed_source_insert
BEFORE INSERT ON export_media_entries
WHEN EXISTS (
  SELECT 1 FROM media_object_write_tombstones AS t
  WHERE t.bucket_generation = NEW.object_bucket_generation
    AND t.object_key = NEW.object_key
    AND t.suppression_started_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'export source object is permanently suppressed');
END;

CREATE TRIGGER export_jobs_entryless_queued_insert
BEFORE INSERT ON export_jobs
WHEN NEW.state = 'queued'
  AND NEW.kind = 'complete'
  AND NEW.guestbook_entry_count IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a queued export must freeze its sources');
END;

CREATE TRIGGER export_jobs_running_source_fence
BEFORE UPDATE OF state ON export_jobs
WHEN NEW.state = 'running'
  AND OLD.state = 'queued'
  AND NOT (
    (NEW.kind <> 'selection' OR NEW.media_count > 0)
    AND (SELECT count(*) FROM export_media_entries AS e
      WHERE e.export_job_id = NEW.id) = NEW.media_count
    AND COALESCE((SELECT sum(COALESCE(e.byte_size, e.declared_byte_size))
      FROM export_media_entries AS e
      WHERE e.export_job_id = NEW.id), 0) = NEW.total_bytes
    AND NOT EXISTS (
      SELECT 1 FROM export_media_entries AS e
      WHERE e.export_job_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM media_object_write_tombstones AS t
          WHERE t.bucket_generation = e.object_bucket_generation
            AND t.object_key = e.object_key
            AND t.suppression_started_at IS NULL
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'export source hold is not intact');
END;

CREATE TRIGGER export_jobs_retry_source_fence
BEFORE UPDATE OF state ON export_jobs
WHEN NEW.state = 'queued'
  AND OLD.state IN ('failed', 'expired')
  AND (
    (NEW.kind = 'selection' AND NEW.media_count <= 0)
    OR (NEW.kind = 'complete' AND NEW.guestbook_entry_count IS NULL)
    OR NOT (
      (SELECT count(*) FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id) = NEW.media_count
      AND COALESCE((SELECT sum(COALESCE(e.byte_size, e.declared_byte_size))
        FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id), 0) = NEW.total_bytes
      AND NOT EXISTS (
        SELECT 1 FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id
          AND NOT EXISTS (
            SELECT 1 FROM media_object_write_tombstones AS t
            WHERE t.bucket_generation = e.object_bucket_generation
              AND t.object_key = e.object_key
              AND t.suppression_started_at IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id
          AND NOT EXISTS (
            SELECT 1 FROM media AS m
            WHERE m.id = e.media_id
              AND m.event_id = NEW.event_id
              AND m.upload_state = 'stored'
              AND m.object_bucket_generation = e.object_bucket_generation
              AND m.object_key = e.object_key
              AND (
                (m.trashed_at IS NULL AND m.deleted_at IS NULL)
                OR (m.trashed_at IS NOT NULL AND m.deleted_at = m.trashed_at)
              )
          )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'export source hold cannot be reacquired');
END;

CREATE TRIGGER export_jobs_progress_insert
BEFORE INSERT ON export_jobs
WHEN NOT (
  (
    NEW.processed_media_count IS NULL
    AND NEW.processed_bytes IS NULL
    AND NEW.progress_updated_at IS NULL
  )
  OR (
    NEW.processed_media_count IS NOT NULL
    AND NEW.processed_bytes IS NOT NULL
    AND NEW.progress_updated_at IS NOT NULL
    AND NEW.processed_media_count >= 0
    AND NEW.processed_media_count <= NEW.media_count
    AND NEW.processed_bytes >= 0
    AND NEW.processed_bytes <= NEW.total_bytes
  )
)
BEGIN
  SELECT RAISE(ABORT, 'export progress is invalid');
END;

CREATE TRIGGER export_jobs_progress_update
BEFORE UPDATE OF processed_media_count, processed_bytes, progress_updated_at,
  media_count, total_bytes ON export_jobs
WHEN NOT (
  (
    NEW.processed_media_count IS NULL
    AND NEW.processed_bytes IS NULL
    AND NEW.progress_updated_at IS NULL
  )
  OR (
    NEW.processed_media_count IS NOT NULL
    AND NEW.processed_bytes IS NOT NULL
    AND NEW.progress_updated_at IS NOT NULL
    AND NEW.processed_media_count >= 0
    AND NEW.processed_media_count <= NEW.media_count
    AND NEW.processed_bytes >= 0
    AND NEW.processed_bytes <= NEW.total_bytes
  )
)
BEGIN
  SELECT RAISE(ABORT, 'export progress is invalid');
END;

CREATE TRIGGER export_jobs_execution_insert
BEFORE INSERT ON export_jobs
WHEN NEW.execution_protocol = 'attempt-v2'
  AND NOT (
    NEW.state = 'queued'
    AND NEW.attempt = 1
    AND NEW.execution_transition = 0
    AND NEW.started_at IS NULL
    AND NEW.execution_started_at IS NULL
    AND NEW.processed_media_count IS NULL
    AND NEW.processed_bytes IS NULL
    AND NEW.progress_updated_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution transition is invalid');
END;

CREATE TRIGGER export_jobs_execution_update
BEFORE UPDATE ON export_jobs
WHEN (OLD.execution_protocol = 'attempt-v2' OR NEW.execution_protocol = 'attempt-v2')
  AND NOT (
    NEW.media_count = OLD.media_count
    AND NEW.total_bytes = OLD.total_bytes
    AND (
    -- Same-state writes do not advance the execution ledger. Only a running
    -- owner may change/reset progress within an attempt; terminal and queued
    -- rows preserve their milestone tuple.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND NEW.started_at IS NULL
      AND NEW.state = OLD.state
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND (
        OLD.state = 'running'
        OR (
          NEW.processed_media_count IS OLD.processed_media_count
          AND NEW.processed_bytes IS OLD.processed_bytes
          AND NEW.progress_updated_at IS OLD.progress_updated_at
        )
      )
    )
      OR
    -- First claim: establish the stable owner token and the zero milestone.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'queued'
      AND NEW.state = 'running'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND OLD.execution_started_at IS NULL
      AND NEW.execution_started_at IS NOT NULL
      AND NEW.started_at IS NULL
      AND OLD.processed_media_count IS NULL
      AND OLD.processed_bytes IS NULL
      AND OLD.progress_updated_at IS NULL
      AND NEW.processed_media_count = 0
      AND NEW.processed_bytes = 0
      AND NEW.progress_updated_at IS NOT NULL
    )
      OR
    -- Dispatch may fail before a queued attempt owns an execution.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'queued'
      AND NEW.state = 'failed'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND OLD.execution_started_at IS NULL
      AND NEW.execution_started_at IS NULL
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count IS NULL
      AND NEW.processed_bytes IS NULL
      AND NEW.progress_updated_at IS NULL
    )
      OR
    -- Ready is admitted only after the durable milestone reaches both totals.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'running'
      AND NEW.state = 'ready'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND NEW.execution_started_at IS NOT NULL
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count = NEW.media_count
      AND NEW.processed_bytes = NEW.total_bytes
      AND NEW.progress_updated_at IS NOT NULL
    )
      OR
    -- Failure records the last completed whole-part milestone unchanged.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'running'
      AND NEW.state = 'failed'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND NEW.execution_started_at IS NOT NULL
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count IS OLD.processed_media_count
      AND NEW.processed_bytes IS OLD.processed_bytes
      AND NEW.progress_updated_at IS OLD.progress_updated_at
    )
      OR
    -- Expiry preserves the completed attempt identity and inventory milestone.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'ready'
      AND NEW.state = 'expired'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count IS OLD.processed_media_count
      AND NEW.processed_bytes IS OLD.processed_bytes
      AND NEW.progress_updated_at IS OLD.progress_updated_at
    )
      OR
    -- Retry starts a new v2 attempt. This is also the sole legacy-to-v2 gate;
    -- 0019's existing Retry source trigger independently proves the snapshot.
      (
      OLD.execution_protocol IN ('legacy', 'attempt-v2')
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state IN ('failed', 'expired')
      AND NEW.state = 'queued'
      AND NEW.attempt = OLD.attempt + 1
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.started_at IS NULL
      AND NEW.execution_started_at IS NULL
      AND NEW.processed_media_count IS NULL
      AND NEW.processed_bytes IS NULL
      AND NEW.progress_updated_at IS NULL
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution transition is invalid');
END;

CREATE TRIGGER export_protocol_admission_no_insert
BEFORE INSERT ON export_protocol_admission
WHEN EXISTS (SELECT 1 FROM export_protocol_admission)
BEGIN
  SELECT RAISE(ABORT, 'export protocol admission row is immutable');
END;

CREATE TRIGGER export_protocol_admission_transition
BEFORE UPDATE ON export_protocol_admission
WHEN NOT (
  NEW.singleton = OLD.singleton
  AND NOT EXISTS (
    SELECT 1 FROM export_jobs
    WHERE execution_protocol = 'legacy'
      AND state IN ('queued', 'running')
  )
  AND (
    (
      OLD.state = 'legacy-open'
      AND OLD.closed_at IS NULL
      AND OLD.worker_version_id IS NULL
      AND OLD.admitted_at IS NULL
      AND NEW.state = 'closed'
      AND NEW.closed_at IS NOT NULL
      AND NEW.worker_version_id IS NULL
      AND NEW.admitted_at IS NULL
    )
    OR (
      OLD.state = 'closed'
      AND OLD.closed_at IS NOT NULL
      AND OLD.worker_version_id IS NULL
      AND OLD.admitted_at IS NULL
      AND NEW.state = 'open'
      AND NEW.closed_at IS OLD.closed_at
      AND NEW.worker_version_id IS NOT NULL
      AND NEW.admitted_at IS NOT NULL
    )
  )
)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM export_jobs
      WHERE execution_protocol = 'legacy'
        AND state IN ('queued', 'running')
    )
    THEN RAISE(ABORT, 'active legacy export blocks protocol admission transition')
    ELSE RAISE(ABORT, 'export protocol admission transition is invalid')
  END;
END;

CREATE TRIGGER export_protocol_admission_no_delete
BEFORE DELETE ON export_protocol_admission
BEGIN
  SELECT RAISE(ABORT, 'export protocol admission row is immutable');
END;

CREATE TRIGGER export_jobs_protocol_admission_insert
BEFORE INSERT ON export_jobs
WHEN NEW.state IN ('queued', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM export_protocol_admission
    WHERE singleton = 1
      AND (
        (state = 'legacy-open' AND NEW.execution_protocol = 'legacy')
        OR (state = 'open' AND (NEW.execution_protocol = 'attempt-v2'
          OR (NEW.execution_protocol = 'selection-v1' AND NEW.destination IN ('archive', 'device')
            AND EXISTS (SELECT 1 FROM photo_export_admission WHERE singleton = 1 AND enabled = 1))))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution protocol is not admitted');
END;

CREATE TRIGGER export_jobs_protocol_admission_update
BEFORE UPDATE ON export_jobs
WHEN NEW.state IN ('queued', 'running')
  AND (
    OLD.state NOT IN ('queued', 'running')
    OR NEW.execution_protocol IS NOT OLD.execution_protocol
  )
  AND NOT EXISTS (
    SELECT 1 FROM export_protocol_admission
    WHERE singleton = 1
      AND (
        (state = 'legacy-open' AND NEW.execution_protocol = 'legacy')
        OR (state = 'open' AND (NEW.execution_protocol = 'attempt-v2'
          OR (NEW.execution_protocol = 'selection-v1' AND NEW.destination IN ('archive', 'device')
            AND EXISTS (SELECT 1 FROM photo_export_admission WHERE singleton = 1 AND enabled = 1))))
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution protocol is not admitted');
END;

-- Enabling is an operator action after installed-Worker identity is recorded.
CREATE TABLE photo_export_admission (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  worker_version_id TEXT,
  admitted_at TEXT,
  CHECK ((enabled = 0 AND worker_version_id IS NULL AND admitted_at IS NULL)
    OR (enabled = 1 AND typeof(worker_version_id) = 'text'
      AND length(worker_version_id) = 36 AND worker_version_id = lower(worker_version_id)
      AND substr(worker_version_id, 9, 1) = '-' AND substr(worker_version_id, 14, 1) = '-'
      AND substr(worker_version_id, 19, 1) = '-' AND substr(worker_version_id, 24, 1) = '-'
      AND length(replace(worker_version_id, '-', '')) = 32
      AND replace(worker_version_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      AND typeof(admitted_at) = 'text' AND length(admitted_at) = 24
      AND strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) = admitted_at))
);
INSERT INTO photo_export_admission (singleton) VALUES (1);
CREATE TRIGGER photo_export_admission_no_insert BEFORE INSERT ON photo_export_admission
WHEN EXISTS (SELECT 1 FROM photo_export_admission)
BEGIN SELECT RAISE(ABORT, 'photo export admission row is immutable'); END;
CREATE TRIGGER photo_export_admission_no_delete BEFORE DELETE ON photo_export_admission
BEGIN SELECT RAISE(ABORT, 'photo export admission row is immutable'); END;
CREATE TRIGGER photo_export_admission_update BEFORE UPDATE ON photo_export_admission
WHEN NEW.singleton <> OLD.singleton OR (NEW.enabled = 1 AND NOT EXISTS (
  SELECT 1 FROM export_protocol_admission WHERE singleton = 1 AND state = 'open'))
BEGIN SELECT RAISE(ABORT, 'photo export worker is not admitted'); END;

CREATE TABLE photo_export_deliveries (
  export_job_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploading', 'prepared', 'acknowledged', 'failed', 'unresolved')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  prepared_at TEXT,
  acknowledged_at TEXT,
  failed_at TEXT,
  read_lease_token TEXT,
  read_lease_expires_at TEXT,
  PRIMARY KEY (export_job_id, media_id),
  FOREIGN KEY (export_job_id, media_id) REFERENCES export_media_entries(export_job_id, media_id) ON DELETE CASCADE,
  CHECK ((read_lease_token IS NULL AND read_lease_expires_at IS NULL)
    OR (typeof(read_lease_token) = 'text' AND length(read_lease_token) > 0 AND typeof(read_lease_expires_at) = 'text'
      AND length(read_lease_expires_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', read_lease_expires_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', read_lease_expires_at) = read_lease_expires_at)),
  CHECK (state NOT IN ('prepared', 'acknowledged') OR prepared_at IS NOT NULL),
  CHECK (state <> 'acknowledged' OR acknowledged_at IS NOT NULL),
  CHECK (state <> 'failed' OR failed_at IS NOT NULL)
);
CREATE INDEX photo_export_delivery_leases ON photo_export_deliveries(export_job_id, read_lease_expires_at)
  WHERE read_lease_token IS NOT NULL;
CREATE TRIGGER photo_export_delivery_insert BEFORE INSERT ON photo_export_deliveries
WHEN NOT EXISTS (SELECT 1 FROM export_jobs WHERE id = NEW.export_job_id AND kind = 'selection'
  AND destination = 'device' AND state IN ('queued', 'running') AND attempt = NEW.attempt
  AND cancel_requested_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'photo export delivery has no active owner'); END;
CREATE TRIGGER photo_export_delivery_update BEFORE UPDATE ON photo_export_deliveries
WHEN NEW.export_job_id IS NOT OLD.export_job_id OR NEW.media_id IS NOT OLD.media_id
  OR NEW.attempt < OLD.attempt
  OR (OLD.read_lease_token IS NOT NULL AND NEW.read_lease_token IS NOT NULL
    AND NEW.read_lease_token IS NOT OLD.read_lease_token
    AND julianday(OLD.read_lease_expires_at) > julianday('now'))
  OR NOT EXISTS (SELECT 1 FROM export_jobs WHERE id = NEW.export_job_id AND attempt = NEW.attempt
    AND state IN ('queued', 'running')
    AND (cancel_requested_at IS NULL OR (
      NEW.state = OLD.state AND NEW.attempt = OLD.attempt AND NEW.prepared_at IS OLD.prepared_at
      AND NEW.acknowledged_at IS OLD.acknowledged_at AND NEW.failed_at IS OLD.failed_at
      AND NEW.read_lease_token IS NULL AND NEW.read_lease_expires_at IS NULL)))
  OR (NEW.attempt = OLD.attempt AND OLD.state = 'acknowledged' AND
    (NEW.state <> 'acknowledged' OR NEW.acknowledged_at IS NOT OLD.acknowledged_at))
BEGIN SELECT RAISE(ABORT, 'photo export delivery ownership is invalid'); END;

CREATE TRIGGER photo_export_delivery_delete BEFORE DELETE ON photo_export_deliveries
WHEN OLD.read_lease_token IS NOT NULL AND julianday(OLD.read_lease_expires_at) > julianday('now')
  AND EXISTS (SELECT 1 FROM export_jobs WHERE id = OLD.export_job_id AND state IN ('queued', 'running'))
BEGIN SELECT RAISE(ABORT, 'photo export read lease is still active'); END;

-- A selection has no notes inventory and no mutable accepted source identity.
CREATE TRIGGER photo_export_guestbook_insert BEFORE INSERT ON export_guestbook_entries
WHEN EXISTS (SELECT 1 FROM export_jobs WHERE id = NEW.export_job_id AND kind = 'selection')
BEGIN SELECT RAISE(ABORT, 'selection exports contain photos only'); END;
CREATE TRIGGER photo_export_guestbook_update BEFORE UPDATE ON export_guestbook_entries
WHEN EXISTS (SELECT 1 FROM export_jobs WHERE id = NEW.export_job_id AND kind = 'selection')
BEGIN SELECT RAISE(ABORT, 'selection exports contain photos only'); END;
CREATE TRIGGER photo_export_entry_insert BEFORE INSERT ON export_media_entries
WHEN EXISTS (SELECT 1 FROM export_jobs WHERE id = NEW.export_job_id AND kind = 'selection'
  AND (state <> 'queued' OR confirmed_at IS NOT NULL OR cancel_requested_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'selection source inventory is frozen'); END;
CREATE TRIGGER photo_export_entry_update BEFORE UPDATE ON export_media_entries
WHEN EXISTS (SELECT 1 FROM export_jobs WHERE id IN (NEW.export_job_id, OLD.export_job_id) AND kind = 'selection')
BEGIN SELECT RAISE(ABORT, 'selection source inventory is frozen'); END;
CREATE TRIGGER photo_export_entry_delete BEFORE DELETE ON export_media_entries
WHEN EXISTS (SELECT 1 FROM export_jobs WHERE id = OLD.export_job_id AND kind = 'selection' AND state IN ('queued', 'running'))
BEGIN SELECT RAISE(ABORT, 'active selection source inventory is frozen'); END;

CREATE TRIGGER photo_export_execution_insert BEFORE INSERT ON export_jobs
WHEN NEW.execution_protocol = 'selection-v1' AND (
  NEW.state = 'queued' AND NEW.attempt = 1 AND NEW.execution_transition = 0
  AND NEW.started_at IS NULL AND NEW.execution_started_at IS NULL
  AND NEW.confirmed_at IS NULL AND NEW.completed_at IS NULL AND NEW.cancel_requested_at IS NULL
  AND NEW.processed_media_count IS NULL AND NEW.processed_bytes IS NULL AND NEW.progress_updated_at IS NULL) IS NOT TRUE
BEGIN SELECT RAISE(ABORT, 'selection execution must start pristine'); END;

CREATE TRIGGER photo_export_execution_update BEFORE UPDATE ON export_jobs
WHEN (OLD.execution_protocol = 'selection-v1' OR NEW.execution_protocol = 'selection-v1') AND (
  NEW.execution_protocol = OLD.execution_protocol
  AND NEW.id IS OLD.id AND NEW.event_id IS OLD.event_id AND NEW.kind IS OLD.kind
  AND NEW.destination IS OLD.destination AND NEW.source_json IS OLD.source_json
  AND NEW.request_digest IS OLD.request_digest AND NEW.idempotency_key IS OLD.idempotency_key
  AND NEW.initiating_principal IS OLD.initiating_principal AND NEW.snapshot_at IS OLD.snapshot_at
  AND NEW.created_at IS OLD.created_at AND NEW.absolute_expires_at IS OLD.absolute_expires_at
  AND NEW.media_count = OLD.media_count AND NEW.total_bytes = OLD.total_bytes
  AND NEW.started_at IS NULL
  AND (
    (NEW.hold_expires_at >= OLD.hold_expires_at
      AND (NEW.confirmed_at IS OLD.confirmed_at OR
        (OLD.confirmed_at IS NULL AND OLD.state = 'queued' AND NEW.confirmed_at IS NOT NULL))
      AND (NEW.cancel_requested_at IS OLD.cancel_requested_at OR
        (OLD.cancel_requested_at IS NULL AND OLD.state IN ('queued', 'running') AND NEW.cancel_requested_at IS NOT NULL)))
    -- Archive retry owns a new confirmation window under the same absolute ceiling.
    -- Only this attempt transition may clear confirmation/retirement or shorten the hold.
    OR (OLD.destination = 'archive' AND OLD.state IN ('failed', 'expired') AND NEW.state = 'queued'
      AND NEW.attempt = OLD.attempt + 1 AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.confirmed_at IS NULL AND NEW.cancel_requested_at IS NULL)
  )
  AND (
    -- Existing state/owner: progress only advances while running and not retired.
    (NEW.state = OLD.state AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND ((OLD.state = 'running' AND OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NULL
          AND NEW.processed_media_count >= OLD.processed_media_count AND NEW.processed_bytes >= OLD.processed_bytes
          AND NEW.progress_updated_at >= OLD.progress_updated_at)
        OR (NEW.processed_media_count IS OLD.processed_media_count AND NEW.processed_bytes IS OLD.processed_bytes
          AND NEW.progress_updated_at IS OLD.progress_updated_at)))
    OR (OLD.state = 'queued' AND NEW.state = 'running' AND OLD.cancel_requested_at IS NULL
      AND NEW.cancel_requested_at IS NULL AND NEW.confirmed_at IS NOT NULL
      AND NEW.attempt = OLD.attempt AND NEW.execution_transition = OLD.execution_transition + 1
      AND OLD.execution_started_at IS NULL AND NEW.execution_started_at IS NOT NULL
      AND NEW.processed_media_count = 0 AND NEW.processed_bytes = 0 AND NEW.progress_updated_at IS NOT NULL)
    OR (OLD.state IN ('queued', 'running') AND NEW.state IN ('ready', 'handed-off', 'delivered', 'failed', 'cancelled', 'expired')
      AND NEW.attempt = OLD.attempt AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND NOT EXISTS (SELECT 1 FROM photo_export_deliveries AS d WHERE d.export_job_id = NEW.id
        AND d.read_lease_token IS NOT NULL AND julianday(d.read_lease_expires_at) > julianday('now'))
      AND ((NEW.state IN ('failed', 'cancelled', 'expired')
          AND NEW.processed_media_count IS OLD.processed_media_count AND NEW.processed_bytes IS OLD.processed_bytes
          AND NEW.progress_updated_at IS OLD.progress_updated_at
          AND (NEW.state <> 'cancelled' OR NEW.cancel_requested_at IS NOT NULL))
        OR (OLD.state = 'running' AND NEW.cancel_requested_at IS NULL
          AND NEW.processed_media_count = NEW.media_count AND NEW.processed_bytes = NEW.total_bytes
          AND NEW.progress_updated_at IS NOT NULL
          AND ((NEW.state = 'ready' AND NEW.destination = 'archive')
            OR (NEW.state = 'handed-off' AND NEW.destination = 'device'
              AND (SELECT count(*) FROM photo_export_deliveries WHERE export_job_id = NEW.id
                AND attempt = NEW.attempt AND state = 'acknowledged') = NEW.media_count)))))
    OR (OLD.state = 'ready' AND NEW.state = 'expired' AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1 AND NEW.execution_started_at IS OLD.execution_started_at
      AND NEW.processed_media_count IS OLD.processed_media_count AND NEW.processed_bytes IS OLD.processed_bytes
      AND NEW.progress_updated_at IS OLD.progress_updated_at)
    OR (OLD.state IN ('failed', 'expired') AND NEW.state = 'queued'
      AND (OLD.cancel_requested_at IS NULL OR OLD.destination = 'archive')
      AND (NEW.destination <> 'archive' OR NEW.confirmed_at IS NULL)
      AND NEW.cancel_requested_at IS NULL AND NEW.attempt = OLD.attempt + 1
      AND NEW.execution_transition = OLD.execution_transition + 1 AND NEW.execution_started_at IS NULL
      AND NEW.processed_media_count IS NULL AND NEW.processed_bytes IS NULL AND NEW.progress_updated_at IS NULL)
  )
) IS NOT TRUE
BEGIN SELECT RAISE(ABORT, 'selection execution transition is invalid'); END;
PRAGMA defer_foreign_keys = OFF;

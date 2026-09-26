-- Source for the new ownership schema; the migration contains an explicit copy.
CREATE TABLE mobile_image_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 26),
  protocol INTEGER NOT NULL CHECK (protocol = 1)
);
INSERT INTO mobile_image_schema VALUES (1, 26, 1);
CREATE TRIGGER mobile_image_schema_no_insert BEFORE INSERT ON mobile_image_schema BEGIN SELECT RAISE(ABORT, 'mobile image schema is immutable'); END;
CREATE TRIGGER mobile_image_schema_no_update BEFORE UPDATE ON mobile_image_schema BEGIN SELECT RAISE(ABORT, 'mobile image schema is immutable'); END;
CREATE TRIGGER mobile_image_schema_no_delete BEFORE DELETE ON mobile_image_schema BEGIN SELECT RAISE(ABORT, 'mobile image schema is immutable'); END;

-- A switch can narrow committed release evidence, never manufacture capability.
CREATE TABLE mobile_image_admission (
  case_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  max_original_bytes INTEGER NOT NULL DEFAULT 536870912 CHECK (max_original_bytes BETWEEN 1 AND 536870912),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
);
-- @ADMISSION_CASES@
CREATE TRIGGER mobile_image_admission_no_insert BEFORE INSERT ON mobile_image_admission BEGIN SELECT RAISE(ABORT, 'unknown mobile image case'); END;
CREATE TRIGGER mobile_image_admission_no_delete BEFORE DELETE ON mobile_image_admission BEGIN SELECT RAISE(ABORT, 'mobile image case is permanent'); END;
CREATE TRIGGER mobile_image_admission_update BEFORE UPDATE ON mobile_image_admission
WHEN NEW.case_id IS NOT OLD.case_id OR NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'mobile image admission revision conflict'); END;

CREATE TABLE media_upload_transfers (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL UNIQUE REFERENCES media(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('guest', 'manager-link', 'manager-account')),
  actor_session_id TEXT NOT NULL REFERENCES event_sessions(id) ON DELETE RESTRICT,
  event_session_id TEXT REFERENCES event_sessions(id) ON DELETE RESTRICT,
  host_session_id TEXT REFERENCES host_sessions(id) ON DELETE RESTRICT,
  account_id TEXT REFERENCES host_accounts(id) ON DELETE RESTRICT,
  family TEXT NOT NULL CHECK (family IN ('jpeg','png','webp','heic','heif','dng','avif','gif','tiff','bmp','jp2','jxl')),
  mime_type TEXT NOT NULL,
  requires_sequence INTEGER NOT NULL CHECK (requires_sequence IN (0, 1)),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 536870912),
  part_bytes INTEGER NOT NULL CHECK (part_bytes = 8388608),
  part_count INTEGER NOT NULL CHECK (part_count = (byte_size + part_bytes - 1) / part_bytes),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  state TEXT NOT NULL DEFAULT 'receiving' CHECK (state IN ('receiving','processing','retryable','delivered','rejected','aborted','expired')),
  initial_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hard_expires_at TEXT NOT NULL,
  build_fingerprint TEXT NOT NULL CHECK (length(build_fingerprint) = 64 AND build_fingerprint NOT GLOB '*[^0-9a-f]*'),
  admission_case TEXT NOT NULL REFERENCES mobile_image_admission(case_id) ON DELETE RESTRICT,
  completion_token TEXT,
  completion_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (initial_expires_at <= expires_at AND expires_at <= hard_expires_at AND hard_expires_at > created_at),
  CHECK ((authority_kind = 'manager-account' AND event_session_id IS NULL AND host_session_id IS NOT NULL AND account_id IS NOT NULL)
    OR (authority_kind <> 'manager-account' AND event_session_id = actor_session_id AND host_session_id IS NULL AND account_id IS NULL)),
  CHECK ((completion_token IS NULL) = (completion_lease_expires_at IS NULL))
);
CREATE INDEX media_upload_transfers_cleanup ON media_upload_transfers(state, expires_at, id);
CREATE INDEX media_upload_transfers_event ON media_upload_transfers(event_id, id);
CREATE TRIGGER media_upload_transfer_identity BEFORE UPDATE ON media_upload_transfers
WHEN NEW.id IS NOT OLD.id OR NEW.media_id IS NOT OLD.media_id OR NEW.event_id IS NOT OLD.event_id
 OR NEW.authority_kind IS NOT OLD.authority_kind OR NEW.actor_session_id IS NOT OLD.actor_session_id
 OR NEW.event_session_id IS NOT OLD.event_session_id OR NEW.host_session_id IS NOT OLD.host_session_id OR NEW.account_id IS NOT OLD.account_id
 OR NEW.family IS NOT OLD.family OR NEW.mime_type IS NOT OLD.mime_type OR NEW.requires_sequence IS NOT OLD.requires_sequence
 OR NEW.byte_size IS NOT OLD.byte_size OR NEW.part_bytes IS NOT OLD.part_bytes OR NEW.part_count IS NOT OLD.part_count
 OR NEW.build_fingerprint IS NOT OLD.build_fingerprint OR NEW.admission_case IS NOT OLD.admission_case
 OR NEW.created_at IS NOT OLD.created_at OR NEW.initial_expires_at IS NOT OLD.initial_expires_at OR NEW.hard_expires_at IS NOT OLD.hard_expires_at
 OR NEW.generation < OLD.generation OR NEW.attempt < OLD.attempt OR NEW.expires_at < OLD.expires_at
 OR (OLD.state IN ('delivered','rejected','aborted','expired') AND NEW.state <> OLD.state)
BEGIN SELECT RAISE(ABORT, 'immutable upload transfer'); END;
CREATE TRIGGER media_upload_transfer_owner BEFORE INSERT ON media_upload_transfers
WHEN NOT EXISTS (SELECT 1 FROM media m JOIN events e ON e.id = m.event_id
  WHERE m.id = NEW.media_id AND m.event_id = NEW.event_id AND m.uploader_session_id = NEW.actor_session_id
    AND m.mime_type = NEW.mime_type AND m.declared_byte_size = NEW.byte_size
    AND m.upload_state = 'reserved' AND m.deleted_at IS NULL AND e.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'upload transfer owner mismatch'); END;

CREATE TABLE media_upload_parts (
  transfer_id TEXT NOT NULL REFERENCES media_upload_transfers(id) ON DELETE RESTRICT,
  part_index INTEGER NOT NULL CHECK (part_index >= 0),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  part_number INTEGER NOT NULL CHECK (part_number = part_index + 1),
  etag TEXT,
  claim_token TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  state TEXT NOT NULL CHECK (state IN ('writing','accepted','suppressed')),
  writer_lease_expires_at TEXT NOT NULL,
  writer_settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (transfer_id, part_index),
  CHECK (state <> 'accepted' OR (etag IS NOT NULL AND length(etag) > 0 AND writer_settled_at IS NOT NULL))
);
CREATE TRIGGER media_upload_part_identity BEFORE UPDATE ON media_upload_parts
WHEN NEW.transfer_id IS NOT OLD.transfer_id OR NEW.part_index IS NOT OLD.part_index OR NEW.part_number IS NOT OLD.part_number
 OR NEW.byte_size IS NOT OLD.byte_size OR NEW.sha256 IS NOT OLD.sha256 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.state = 'accepted' AND (NEW.etag IS NOT OLD.etag OR NEW.state = 'writing'))
 OR (OLD.state = 'suppressed' AND NEW.state <> 'suppressed')
BEGIN SELECT RAISE(ABORT, 'immutable upload part'); END;

CREATE TABLE media_upload_assemblies (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES media_upload_transfers(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  object_key TEXT NOT NULL UNIQUE,
  create_intent_at TEXT NOT NULL,
  multipart_upload_id TEXT,
  create_settled_at TEXT,
  completion_token TEXT,
  completion_lease_expires_at TEXT,
  writer_settled_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating','receiving','completing','completed','suppressed','absent')),
  expected_sha256 TEXT CHECK (expected_sha256 IS NULL OR (length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*')),
  expected_byte_size INTEGER NOT NULL CHECK (expected_byte_size BETWEEN 1 AND 536870912),
  completed_etag TEXT,
  suppression_started_at TEXT,
  absence_verified_at TEXT,
  multipart_closed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (transfer_id, attempt),
  CHECK (state <> 'completed' OR (completed_etag IS NOT NULL AND expected_sha256 IS NOT NULL AND writer_settled_at IS NOT NULL AND multipart_closed_at IS NOT NULL)),
  CHECK (state <> 'absent' OR (suppression_started_at IS NOT NULL AND absence_verified_at IS NOT NULL AND multipart_closed_at IS NOT NULL AND create_settled_at IS NOT NULL AND writer_settled_at IS NOT NULL))
);
CREATE TRIGGER media_upload_assembly_identity BEFORE UPDATE ON media_upload_assemblies
WHEN NEW.id IS NOT OLD.id OR NEW.transfer_id IS NOT OLD.transfer_id OR NEW.attempt IS NOT OLD.attempt
 OR NEW.generation IS NOT OLD.generation OR NEW.object_key IS NOT OLD.object_key OR NEW.create_intent_at IS NOT OLD.create_intent_at
 OR NEW.expected_byte_size IS NOT OLD.expected_byte_size
 OR (OLD.multipart_upload_id IS NOT NULL AND NEW.multipart_upload_id IS NOT OLD.multipart_upload_id)
 OR (OLD.expected_sha256 IS NOT NULL AND NEW.expected_sha256 IS NOT OLD.expected_sha256)
 OR (OLD.completed_etag IS NOT NULL AND NEW.completed_etag IS NOT OLD.completed_etag)
 OR (OLD.suppression_started_at IS NOT NULL AND NEW.suppression_started_at IS NOT OLD.suppression_started_at)
 OR (OLD.state IN ('suppressed','absent') AND NEW.state NOT IN ('suppressed','absent'))
 OR (OLD.state = 'absent' AND NEW.state <> 'absent')
BEGIN SELECT RAISE(ABORT, 'immutable upload assembly'); END;
CREATE TRIGGER media_upload_assembly_delete BEFORE DELETE ON media_upload_assemblies
WHEN OLD.state <> 'absent' BEGIN SELECT RAISE(ABORT, 'upload assembly cleanup unproved'); END;
CREATE TRIGGER media_upload_part_delete BEFORE DELETE ON media_upload_parts
WHEN OLD.writer_settled_at IS NULL OR EXISTS (SELECT 1 FROM media_upload_assemblies a WHERE a.transfer_id = OLD.transfer_id AND a.state <> 'absent')
BEGIN SELECT RAISE(ABORT, 'upload part writer unsettled'); END;
CREATE TRIGGER media_upload_transfer_delete BEFORE DELETE ON media_upload_transfers
WHEN OLD.state NOT IN ('delivered','rejected','aborted','expired')
BEGIN SELECT RAISE(ABORT, 'upload transfer active'); END;
CREATE TRIGGER media_upload_transfer_fence AFTER UPDATE OF generation ON media_upload_transfers
WHEN NEW.generation > OLD.generation BEGIN
  UPDATE media_upload_parts SET state = 'suppressed' WHERE transfer_id = NEW.id;
  UPDATE media_upload_assemblies SET state = CASE WHEN state = 'absent' THEN state ELSE 'suppressed' END,
    suppression_started_at = COALESCE(suppression_started_at,NEW.updated_at) WHERE transfer_id = NEW.id;
  UPDATE media_processing SET state = 'suppressed', generation = generation + 1 WHERE transfer_id = NEW.id;
  UPDATE media_image_previews SET state = 'suppressed', suppression_started_at = COALESCE(suppression_started_at,NEW.updated_at) WHERE media_id = NEW.media_id;
END;

CREATE TABLE media_processing (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE RESTRICT,
  transfer_id TEXT REFERENCES media_upload_transfers(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','unavailable','unsupported','suppressed')),
  actual_family TEXT,
  width INTEGER CHECK (width > 0), height INTEGER CHECK (height > 0),
  frame_count INTEGER CHECK (frame_count BETWEEN 1 AND 1024),
  is_sequence INTEGER CHECK (is_sequence IN (0,1)),
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*')),
  byte_size INTEGER CHECK (byte_size BETWEEN 1 AND 536870912),
  build_fingerprint TEXT CHECK (build_fingerprint IS NULL OR (length(build_fingerprint) = 64 AND build_fingerprint NOT GLOB '*[^0-9a-f]*')),
  preview_profile TEXT,
  failure_code TEXT CHECK (failure_code IN ('unsupported','malformed','resource_limit','busy','unavailable')),
  updated_at TEXT NOT NULL,
  CHECK (state <> 'ready' OR (actual_family IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND frame_count IS NOT NULL AND is_sequence IS NOT NULL
    AND source_sha256 IS NOT NULL AND byte_size IS NOT NULL AND build_fingerprint IS NOT NULL AND preview_profile IS NOT NULL AND failure_code IS NULL))
);

CREATE TABLE media_image_previews (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  profile TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/webp')),
  state TEXT NOT NULL CHECK (state IN ('pending','ready','suppressed')),
  byte_size INTEGER CHECK (byte_size BETWEEN 1 AND 20971520),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  etag TEXT,
  width INTEGER CHECK (width BETWEEN 1 AND 1600), height INTEGER CHECK (height BETWEEN 1 AND 1600),
  frame_count INTEGER CHECK (frame_count BETWEEN 1 AND 1024),
  claim_token TEXT NOT NULL,
  producer_kind TEXT NOT NULL DEFAULT 'upload' CHECK (producer_kind IN ('upload','workflow')),
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count BETWEEN 0 AND 3),
  failure_code TEXT CHECK (failure_code IN ('busy','unavailable','unsupported','malformed','resource_limit')),
  writer_lease_expires_at TEXT NOT NULL,
  writer_settled_at TEXT,
  suppression_started_at TEXT,
  absence_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (media_id, source_sha256, profile, generation),
  CHECK (object_key = 'events/' || event_id || '/media/previews/' || media_id || '/' || source_sha256 || '/' || profile || '/' || generation || CASE mime_type WHEN 'image/webp' THEN '.webp' ELSE '.jpg' END),
  CHECK (state <> 'ready' OR (byte_size IS NOT NULL AND sha256 IS NOT NULL AND etag IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND frame_count IS NOT NULL AND writer_settled_at IS NOT NULL)),
  CHECK (state <> 'suppressed' OR suppression_started_at IS NOT NULL)
);
CREATE UNIQUE INDEX media_image_preview_active ON media_image_previews(media_id, source_sha256, profile) WHERE state <> 'suppressed';
CREATE INDEX media_image_preview_event ON media_image_previews(event_id, state, id);
CREATE TRIGGER media_image_preview_identity BEFORE UPDATE ON media_image_previews
WHEN NEW.id IS NOT OLD.id OR NEW.media_id IS NOT OLD.media_id OR NEW.event_id IS NOT OLD.event_id
 OR NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.profile IS NOT OLD.profile OR NEW.generation IS NOT OLD.generation
 OR NEW.object_key IS NOT OLD.object_key OR NEW.mime_type IS NOT OLD.mime_type OR NEW.producer_kind IS NOT OLD.producer_kind
 OR (NEW.claim_token IS NOT OLD.claim_token AND NOT (OLD.state = 'pending' AND NEW.state = 'pending'
   AND OLD.producer_kind = 'workflow' AND OLD.writer_settled_at IS NOT NULL AND NEW.writer_settled_at IS NULL
   AND NEW.run_count = OLD.run_count + 1))
 OR (OLD.sha256 IS NOT NULL AND (NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_size IS NOT OLD.byte_size
   OR NEW.width IS NOT OLD.width OR NEW.height IS NOT OLD.height OR NEW.frame_count IS NOT OLD.frame_count))
 OR NEW.created_at IS NOT OLD.created_at OR (OLD.state = 'suppressed' AND NEW.state <> 'suppressed')
 OR (OLD.state = 'ready' AND (NEW.byte_size IS NOT OLD.byte_size OR NEW.sha256 IS NOT OLD.sha256 OR NEW.etag IS NOT OLD.etag
   OR NEW.width IS NOT OLD.width OR NEW.height IS NOT OLD.height OR NEW.frame_count IS NOT OLD.frame_count))
BEGIN SELECT RAISE(ABORT, 'immutable image preview'); END;
CREATE TRIGGER media_image_preview_owner BEFORE INSERT ON media_image_previews
WHEN NOT EXISTS (SELECT 1 FROM media m JOIN events e ON e.id = m.event_id WHERE m.id = NEW.media_id AND m.event_id = NEW.event_id
  AND m.upload_state IN ('reserved','stored') AND m.deleted_at IS NULL AND e.deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'image preview owner unavailable'); END;
CREATE TRIGGER media_image_preview_inventory AFTER INSERT ON media_image_previews BEGIN
  INSERT OR IGNORE INTO media_object_write_tombstones (bucket_generation,object_key,event_id,media_id,object_kind,next_check_at,created_at,updated_at)
    VALUES ('canonical',NEW.object_key,NEW.event_id,NEW.media_id,'preview',NEW.created_at,NEW.created_at,NEW.created_at);
  SELECT RAISE(ABORT, 'image preview key suppressed or collision') WHERE NOT EXISTS (SELECT 1 FROM media_object_write_tombstones t
    WHERE t.bucket_generation = 'canonical' AND t.object_key = NEW.object_key AND t.event_id = NEW.event_id AND t.media_id = NEW.media_id
      AND t.object_kind = 'preview' AND t.suppression_started_at IS NULL);
END;
CREATE TRIGGER media_image_preview_delete BEFORE DELETE ON media_image_previews
WHEN OLD.state <> 'suppressed' OR OLD.writer_settled_at IS NULL OR OLD.absence_verified_at IS NULL
BEGIN SELECT RAISE(ABORT, 'image preview cleanup unproved'); END;
CREATE TRIGGER media_image_preview_generation_retained BEFORE DELETE ON media_image_previews
WHEN EXISTS (SELECT 1 FROM media m JOIN events e ON e.id = m.event_id WHERE m.id = OLD.media_id AND e.deleted_at IS NULL
  AND (m.deleted_at IS NULL OR (m.trashed_at IS NOT NULL AND m.deleted_at = m.trashed_at)))
BEGIN SELECT RAISE(ABORT, 'image preview generation retained'); END;
CREATE TRIGGER mobile_preview_tombstone_suppress BEFORE UPDATE OF suppression_started_at ON media_object_write_tombstones
WHEN NEW.suppression_started_at IS NOT NULL AND NEW.bucket_generation = 'canonical' AND NEW.object_kind = 'preview'
 AND EXISTS (SELECT 1 FROM media_image_previews p JOIN media m ON m.id = p.media_id JOIN events e ON e.id = m.event_id
   WHERE p.object_key = NEW.object_key AND p.state <> 'suppressed' AND e.deleted_at IS NULL
     AND (m.deleted_at IS NULL OR (m.trashed_at IS NOT NULL AND m.deleted_at = m.trashed_at)))
BEGIN SELECT RAISE(ABORT, 'image preview owner retained'); END;

-- These triggers also protect old deployed code operating on the upgraded DB.
-- Trash retains a derivative; permanent deletion and event deletion fence it.
CREATE TRIGGER mobile_image_media_fence AFTER UPDATE OF deleted_at, upload_state ON media
WHEN (NEW.deleted_at IS NOT NULL AND NOT (NEW.trashed_at IS NOT NULL AND NEW.deleted_at = NEW.trashed_at)) OR NEW.upload_state IN ('failed','deleted')
BEGIN
  UPDATE media_upload_transfers SET generation = generation + 1,
    state = CASE WHEN state IN ('receiving','processing','retryable') THEN 'aborted' ELSE state END,
    completion_token = NULL, completion_lease_expires_at = NULL, updated_at = COALESCE(NEW.deleted_at, updated_at) WHERE media_id = NEW.id;
  UPDATE media_upload_parts SET state = 'suppressed' WHERE transfer_id IN (SELECT id FROM media_upload_transfers WHERE media_id = NEW.id);
  UPDATE media_upload_assemblies SET state = CASE WHEN state = 'absent' THEN state ELSE 'suppressed' END,
    suppression_started_at = COALESCE(suppression_started_at, NEW.deleted_at, updated_at)
    WHERE transfer_id IN (SELECT id FROM media_upload_transfers WHERE media_id = NEW.id);
  UPDATE media_processing SET state = 'suppressed', generation = generation + 1 WHERE media_id = NEW.id;
  UPDATE media_image_previews SET state = 'suppressed', suppression_started_at = COALESCE(suppression_started_at,NEW.deleted_at,updated_at) WHERE media_id = NEW.id;
END;
CREATE TRIGGER mobile_image_event_fence AFTER UPDATE OF deleted_at ON events WHEN NEW.deleted_at IS NOT NULL BEGIN
  UPDATE media_upload_transfers SET generation = generation + 1,
    state = CASE WHEN state IN ('receiving','processing','retryable') THEN 'aborted' ELSE state END,
    completion_token = NULL, completion_lease_expires_at = NULL, updated_at = NEW.deleted_at WHERE event_id = NEW.id;
  UPDATE media_upload_parts SET state = 'suppressed' WHERE transfer_id IN (SELECT id FROM media_upload_transfers WHERE event_id = NEW.id);
  UPDATE media_upload_assemblies SET state = CASE WHEN state = 'absent' THEN state ELSE 'suppressed' END,
    suppression_started_at = COALESCE(suppression_started_at, NEW.deleted_at)
    WHERE transfer_id IN (SELECT id FROM media_upload_transfers WHERE event_id = NEW.id);
  UPDATE media_processing SET state = 'suppressed', generation = generation + 1 WHERE media_id IN (SELECT id FROM media WHERE event_id = NEW.id);
  UPDATE media_image_previews SET state = 'suppressed', suppression_started_at = COALESCE(suppression_started_at,NEW.deleted_at) WHERE event_id = NEW.id;
END;
CREATE TRIGGER mobile_image_event_purge_guard BEFORE DELETE ON events
WHEN EXISTS (SELECT 1 FROM media_upload_transfers WHERE event_id = OLD.id)
 OR EXISTS (SELECT 1 FROM media_image_previews WHERE event_id = OLD.id)
 OR EXISTS (SELECT 1 FROM media_processing p JOIN media m ON m.id = p.media_id WHERE m.event_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'mobile image inventory must settle before event purge'); END;

PRAGMA foreign_keys = ON;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  event_date TEXT NOT NULL,
  welcome_message TEXT NOT NULL CHECK (length(welcome_message) BETWEEN 1 AND 500),
  cover_object_key TEXT,
  uploads_enabled INTEGER NOT NULL DEFAULT 1 CHECK (uploads_enabled IN (0, 1)),
  gallery_visible INTEGER NOT NULL DEFAULT 1 CHECK (gallery_visible IN (0, 1)),
  moderation_required INTEGER NOT NULL DEFAULT 1 CHECK (moderation_required IN (0, 1)),
  reserved_media_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_media_count >= 0),
  stored_media_count INTEGER NOT NULL DEFAULT 0 CHECK (stored_media_count >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stored_bytes >= 0),
  guest_access_expires_at TEXT NOT NULL,
  management_access_expires_at TEXT NOT NULL,
  purge_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE event_access_tokens (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('guest', 'manager')),
  secret_digest TEXT NOT NULL,
  secret_ciphertext TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((role = 'guest' AND secret_ciphertext IS NOT NULL) OR role = 'manager')
);

CREATE INDEX event_access_tokens_event_role ON event_access_tokens(event_id, role, revoked_at);

CREATE TABLE event_sessions (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  access_token_id TEXT NOT NULL REFERENCES event_access_tokens(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('guest', 'manager')),
  csrf_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX event_sessions_event_role ON event_sessions(event_id, role, revoked_at);
CREATE INDEX event_sessions_token ON event_sessions(access_token_id, revoked_at);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  uploader_session_id TEXT NOT NULL REFERENCES event_sessions(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  declared_byte_size INTEGER NOT NULL CHECK (declared_byte_size > 0),
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  guest_name TEXT,
  caption TEXT CHECK (caption IS NULL OR length(caption) <= 300),
  upload_state TEXT NOT NULL CHECK (upload_state IN ('reserved', 'stored', 'failed', 'deleted')),
  moderation_status TEXT NOT NULL CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  idempotency_key TEXT NOT NULL,
  reservation_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  deleted_at TEXT,
  UNIQUE (event_id, uploader_session_id, idempotency_key)
);

CREATE INDEX media_event_state ON media(event_id, upload_state, moderation_status, created_at);
CREATE INDEX media_uploader ON media(uploader_session_id, created_at);
CREATE INDEX media_reservations ON media(upload_state, reservation_expires_at);

CREATE TABLE guest_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  guest_session_id TEXT NOT NULL REFERENCES event_sessions(id) ON DELETE RESTRICT,
  guest_name TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  moderation_status TEXT NOT NULL CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  approved_at TEXT,
  deleted_at TEXT
);

CREATE INDEX guest_messages_event_status ON guest_messages(event_id, moderation_status, created_at);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'expired')),
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
);

CREATE UNIQUE INDEX export_jobs_one_active_per_event
  ON export_jobs(event_id)
  WHERE state IN ('queued', 'running');
CREATE INDEX export_jobs_expiry ON export_jobs(state, expires_at);


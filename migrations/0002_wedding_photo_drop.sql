PRAGMA defer_foreign_keys = ON;

UPDATE events SET gallery_visible = 0;

CREATE TABLE media_wedding_photo_drop (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  uploader_session_id TEXT NOT NULL REFERENCES event_sessions(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN (
    'image/jpeg', 'image/png', 'image/webp',
    'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'
  )),
  declared_byte_size INTEGER NOT NULL CHECK (declared_byte_size > 0),
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  guest_name TEXT NOT NULL CHECK (length(trim(guest_name)) BETWEEN 1 AND 80),
  caption TEXT CHECK (caption IS NULL OR length(caption) <= 300),
  upload_state TEXT NOT NULL CHECK (upload_state IN ('reserved', 'stored', 'failed', 'deleted')),
  publication_status TEXT NOT NULL CHECK (publication_status IN ('unpublished', 'published', 'hidden')),
  idempotency_key TEXT NOT NULL,
  reservation_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  preview_object_key TEXT,
  deleted_at TEXT,
  UNIQUE (event_id, uploader_session_id, idempotency_key)
);

INSERT INTO media_wedding_photo_drop (
  id, event_id, uploader_session_id, object_key, original_filename, mime_type,
  declared_byte_size, byte_size, width, height, guest_name, caption, upload_state,
  publication_status, idempotency_key, reservation_expires_at, created_at,
  published_at, preview_object_key, deleted_at
)
SELECT
  id, event_id, uploader_session_id, object_key, original_filename, mime_type,
  declared_byte_size, byte_size, width, height,
  CASE WHEN guest_name IS NULL OR length(trim(guest_name)) = 0
    THEN 'Guest (legacy upload)' ELSE trim(guest_name) END,
  caption, upload_state,
  CASE moderation_status
    WHEN 'approved' THEN 'published'
    WHEN 'rejected' THEN 'hidden'
    ELSE 'unpublished'
  END,
  idempotency_key, reservation_expires_at, created_at, approved_at, NULL, deleted_at
FROM media;

DROP TABLE media;
ALTER TABLE media_wedding_photo_drop RENAME TO media;

CREATE INDEX media_event_state ON media(event_id, upload_state, publication_status, created_at);
CREATE INDEX media_uploader ON media(uploader_session_id, created_at);
CREATE INDEX media_reservations ON media(upload_state, reservation_expires_at);

ALTER TABLE events
ADD COLUMN guestbook_prompt TEXT NOT NULL
  DEFAULT 'Share a wish, memory, or moment from the day.'
  CHECK (length(trim(guestbook_prompt)) BETWEEN 1 AND 160);

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

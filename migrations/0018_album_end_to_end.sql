ALTER TABLE event_albums ADD COLUMN title TEXT NOT NULL DEFAULT 'Album'
  CHECK (length(trim(title)) BETWEEN 1 AND 120);
ALTER TABLE event_albums ADD COLUMN description TEXT NOT NULL DEFAULT ''
  CHECK (length(description) <= 1000);
ALTER TABLE event_albums ADD COLUMN cover_media_id TEXT;

CREATE TABLE event_album_shares (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  secret_digest TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE event_album_share_sessions (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES event_album_shares(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  secret_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX event_album_share_sessions_expiry
  ON event_album_share_sessions(expires_at, id);
CREATE INDEX event_album_share_sessions_share_expiry
  ON event_album_share_sessions(share_id, expires_at, id);

ALTER TABLE export_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'complete'
  CHECK (kind IN ('complete', 'album'));
ALTER TABLE export_jobs ADD COLUMN album_entries_json TEXT
  CHECK (
    (kind = 'complete' AND album_entries_json IS NULL)
    OR (kind = 'album' AND album_entries_json IS NOT NULL
        AND json_valid(album_entries_json) AND json_type(album_entries_json) = 'array')
  );
ALTER TABLE export_media_entries ADD COLUMN album_tail_position INTEGER
  CHECK (album_tail_position IS NULL OR album_tail_position >= 1);
CREATE UNIQUE INDEX export_album_media_position
  ON export_media_entries(export_job_id, album_tail_position)
  WHERE album_tail_position IS NOT NULL;

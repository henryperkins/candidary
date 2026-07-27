-- A reservation has no manager-list position until its object is stored.
-- Existing stored rows predate this column, so their reservation timestamp is
-- the only safe position to preserve during the append-only migration.

ALTER TABLE media ADD COLUMN stored_at TEXT;

UPDATE media
SET stored_at = created_at
WHERE upload_state = 'stored' AND stored_at IS NULL;

CREATE INDEX media_manager_stored_page_all
ON media(event_id, upload_state, stored_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE INDEX media_manager_stored_page_status
ON media(event_id, upload_state, publication_status, stored_at DESC, id DESC)
WHERE deleted_at IS NULL;

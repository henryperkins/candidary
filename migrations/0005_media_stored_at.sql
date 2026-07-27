-- A reservation has no manager-list position until its object is stored.
-- Existing stored rows predate this column, so their reservation timestamp is
-- the only safe position to preserve during the append-only migration.

ALTER TABLE media ADD COLUMN stored_at TEXT;

UPDATE media
SET stored_at = created_at
WHERE upload_state = 'stored' AND stored_at IS NULL;

CREATE TRIGGER media_stamp_stored_at_compat
AFTER UPDATE OF upload_state ON media
FOR EACH ROW
WHEN OLD.upload_state = 'reserved'
  AND NEW.upload_state = 'stored'
  AND NEW.stored_at IS NULL
BEGIN
  UPDATE media
  SET stored_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id
    AND stored_at IS NULL;
END;

CREATE INDEX media_manager_stored_page_all
ON media(event_id, upload_state, stored_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE INDEX media_manager_stored_page_status
ON media(event_id, upload_state, publication_status, stored_at DESC, id DESC)
WHERE deleted_at IS NULL;

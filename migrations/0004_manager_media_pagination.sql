-- Keyset pagination for the manager intake list. Both indexes are partial on
-- `deleted_at IS NULL` so they only carry rows the manager can actually see,
-- and both trail `created_at DESC, id DESC` so a page boundary needs no sort.

CREATE INDEX media_manager_page_all
ON media(event_id, upload_state, created_at DESC, id DESC)
WHERE deleted_at IS NULL;

CREATE INDEX media_manager_page_status
ON media(event_id, upload_state, publication_status, created_at DESC, id DESC)
WHERE deleted_at IS NULL;

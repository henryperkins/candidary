-- Match the guest gallery's publication order, including legacy NULL dates.
-- ID makes equal timestamps deterministic without changing the existing order.
CREATE INDEX media_guest_gallery_page
ON media(event_id, published_at, created_at, id)
WHERE upload_state = 'stored' AND publication_status = 'published'
  AND deleted_at IS NULL AND trashed_at IS NULL;

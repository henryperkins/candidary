-- Assign each delivered photo a stable, event-scoped sequence for Library snapshots.
ALTER TABLE events ADD COLUMN last_delivery_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (last_delivery_sequence >= 0);

ALTER TABLE media ADD COLUMN delivery_sequence INTEGER
  CHECK (delivery_sequence IS NULL OR delivery_sequence > 0);

WITH delivered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY event_id ORDER BY COALESCE(stored_at, created_at), id
  ) AS sequence
  FROM media WHERE stored_at IS NOT NULL OR upload_state = 'stored'
)
UPDATE media SET delivery_sequence = (
  SELECT sequence FROM delivered WHERE delivered.id = media.id
) WHERE id IN (SELECT id FROM delivered);

UPDATE events SET last_delivery_sequence = COALESCE((
  SELECT MAX(delivery_sequence) FROM media WHERE media.event_id = events.id
), 0);

CREATE UNIQUE INDEX media_event_delivery_sequence
ON media(event_id, delivery_sequence) WHERE delivery_sequence IS NOT NULL;

CREATE TRIGGER media_delivery_sequence_insert
AFTER INSERT ON media
WHEN NEW.upload_state = 'stored' AND NEW.delivery_sequence IS NULL
BEGIN
  UPDATE events SET last_delivery_sequence = last_delivery_sequence + 1
  WHERE id = NEW.event_id;
  UPDATE media SET delivery_sequence = (
    SELECT last_delivery_sequence FROM events WHERE id = NEW.event_id
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER media_delivery_sequence_stored
AFTER UPDATE OF upload_state ON media
WHEN NEW.upload_state = 'stored' AND NEW.delivery_sequence IS NULL
BEGIN
  UPDATE events SET last_delivery_sequence = last_delivery_sequence + 1
  WHERE id = NEW.event_id;
  UPDATE media SET delivery_sequence = (
    SELECT last_delivery_sequence FROM events WHERE id = NEW.event_id
  ) WHERE id = NEW.id;
END;

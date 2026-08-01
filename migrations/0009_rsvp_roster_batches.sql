-- Durable manager receipts for the additive Add guests batch workflow.
--
-- The receipt deliberately contains only affected identifiers, committed
-- versions, and aggregate counts. Raw source rows, names, and labels never
-- become part of the idempotency record.
CREATE TABLE rsvp_roster_batch_receipts (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL
    CHECK (
      length(request_digest) = 64
      AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, idempotency_key)
);

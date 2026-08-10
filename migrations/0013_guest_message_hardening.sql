ALTER TABLE guest_messages
ADD COLUMN idempotency_key TEXT
  CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX guest_messages_session_idempotency
ON guest_messages(event_id, guest_session_id, idempotency_key);

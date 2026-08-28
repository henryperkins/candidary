-- Manager upload actors and Album-era provenance share one migration because
-- both must remain compatible with writes from the predecessor Worker during a
-- migration-first rollout. Database triggers own Album generation: they see the
-- predecessor Worker's one-column writes and the new Worker's paired writes,
-- and advance the event exactly once without a later finalization migration.

ALTER TABLE event_sessions ADD COLUMN manager_upload_account_id TEXT
  REFERENCES host_accounts(id);
ALTER TABLE media ADD COLUMN album_pick_version INTEGER
  CHECK (album_pick_version IS NULL OR album_pick_version = 1);
ALTER TABLE events ADD COLUMN album_pick_generation INTEGER NOT NULL DEFAULT 0
  CHECK (album_pick_generation >= 0);
ALTER TABLE events ADD COLUMN manager_link_revision INTEGER NOT NULL DEFAULT 0
  CHECK (manager_link_revision >= 0);

-- Revoke sessions before their duplicate token. Repeating the same rank in the
-- second statement is intentional: after the token update the losing set is no
-- longer discoverable as live.
WITH ranked_live_manager_tokens AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY event_id ORDER BY created_at DESC, id DESC
    ) AS live_rank
  FROM event_access_tokens
  WHERE role = 'manager' AND revoked_at IS NULL
)
UPDATE event_sessions
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE revoked_at IS NULL
  AND access_token_id IN (
    SELECT id FROM ranked_live_manager_tokens WHERE live_rank > 1
  );

WITH ranked_live_manager_tokens AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY event_id ORDER BY created_at DESC, id DESC
    ) AS live_rank
  FROM event_access_tokens
  WHERE role = 'manager' AND revoked_at IS NULL
)
UPDATE event_access_tokens
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT id FROM ranked_live_manager_tokens WHERE live_rank > 1
);

CREATE UNIQUE INDEX event_access_tokens_one_live_manager
ON event_access_tokens(event_id)
WHERE role = 'manager' AND revoked_at IS NULL;

CREATE UNIQUE INDEX event_sessions_manager_upload_actor
ON event_sessions(event_id, manager_upload_account_id)
WHERE manager_upload_account_id IS NOT NULL AND revoked_at IS NULL;

CREATE TRIGGER event_sessions_manager_upload_actor_insert
BEFORE INSERT ON event_sessions
WHEN NEW.manager_upload_account_id IS NOT NULL
  AND (NEW.role <> 'manager' OR NEW.can_claim_owner <> 0)
BEGIN
  SELECT RAISE(ABORT, 'manager upload actor must be a non-claiming manager');
END;

CREATE TRIGGER event_sessions_manager_upload_actor_update
BEFORE UPDATE ON event_sessions
WHEN NEW.manager_upload_account_id IS NOT NULL
  AND (NEW.role <> 'manager' OR NEW.can_claim_owner <> 0)
BEGIN
  SELECT RAISE(ABORT, 'manager upload actor must be a non-claiming manager');
END;

CREATE TRIGGER event_hosts_revoke_manager_upload_actor
AFTER DELETE ON event_hosts
BEGIN
  UPDATE event_sessions
  SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE event_id = OLD.event_id
    AND manager_upload_account_id = OLD.account_id
    AND revoked_at IS NULL;
END;

-- A saved Album is the only durable proof that an existing favorite belongs to
-- the current Album era. Unsaved and absent Albums remain conservatively
-- historical.
UPDATE media
SET album_pick_version = 1
WHERE favorited_at IS NOT NULL
  AND event_id IN (
    SELECT event_id FROM event_albums WHERE saved_at IS NOT NULL
  );

-- Compatibility for the predecessor Worker, which writes only favorited_at.
-- Each trigger is fenced on the exact transition it repairs, so a compound new-
-- Worker write is already consistent and does not enter either normalizer.
CREATE TRIGGER media_album_pick_version_on_legacy_pick
AFTER UPDATE OF favorited_at ON media
WHEN OLD.favorited_at IS NULL
  AND NEW.favorited_at IS NOT NULL
  AND OLD.album_pick_version IS NULL
  AND NEW.album_pick_version IS NULL
BEGIN
  UPDATE media
  SET album_pick_version = 1
  WHERE id = NEW.id
    AND favorited_at IS NEW.favorited_at
    AND album_pick_version IS NULL;
END;

CREATE TRIGGER media_album_pick_version_on_legacy_unpick
AFTER UPDATE OF favorited_at ON media
WHEN OLD.favorited_at IS NOT NULL
  AND NEW.favorited_at IS NULL
  AND NEW.album_pick_version IS NOT NULL
  AND NEW.album_pick_version IS OLD.album_pick_version
BEGIN
  UPDATE media
  SET album_pick_version = NULL
  WHERE id = NEW.id
    AND favorited_at IS NULL
    AND album_pick_version IS NEW.album_pick_version;
END;

-- BEFORE triggers run before the compatibility normalizers. Admit only the two
-- predecessor-shaped transitions those AFTER triggers repair; every other
-- disagreeing result is rejected in its originating statement.
CREATE TRIGGER media_album_pick_pair_guard
BEFORE UPDATE OF favorited_at, album_pick_version ON media
WHEN ((NEW.favorited_at IS NOT NULL AND NEW.album_pick_version IS NULL)
   OR (NEW.favorited_at IS NULL AND NEW.album_pick_version IS NOT NULL))
  -- Predecessor pick: stamps arrive one statement later, from the AFTER trigger.
  AND NOT (OLD.favorited_at IS NULL AND NEW.favorited_at IS NOT NULL
           AND NEW.album_pick_version IS NULL AND OLD.album_pick_version IS NULL)
  -- Predecessor unpick: the stale version is cleared one statement later.
  AND NOT (OLD.favorited_at IS NOT NULL AND NEW.favorited_at IS NULL
           AND NEW.album_pick_version IS NOT NULL
           AND NEW.album_pick_version IS OLD.album_pick_version)
BEGIN
  SELECT RAISE(ABORT, 'media.album_pick_version disagrees with media.favorited_at');
END;

-- Album eligibility is one predicate shared by update and delete: a picked row
-- is visible only while it is actively stored. Provenance-only normalization
-- cannot change the predicate, so it cannot advance the generation twice.
CREATE TRIGGER media_album_pick_generation_update
AFTER UPDATE ON media
WHEN (
    OLD.favorited_at IS NOT NULL
    AND OLD.upload_state = 'stored'
    AND OLD.deleted_at IS NULL
  ) <> (
    NEW.favorited_at IS NOT NULL
    AND NEW.upload_state = 'stored'
    AND NEW.deleted_at IS NULL
  )
BEGIN
  UPDATE events
  SET album_pick_generation = album_pick_generation + 1
  WHERE id = NEW.event_id;
END;

CREATE TRIGGER media_album_pick_generation_delete
AFTER DELETE ON media
WHEN OLD.favorited_at IS NOT NULL
  AND OLD.upload_state = 'stored'
  AND OLD.deleted_at IS NULL
BEGIN
  UPDATE events
  SET album_pick_generation = album_pick_generation + 1
  WHERE id = OLD.event_id;
END;

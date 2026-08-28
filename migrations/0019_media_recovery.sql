-- Recoverable host deletion, and the export source holds that make it honest.
--
-- Three things ship together here because none of them is safe alone:
--
--   1. a trash pair on `media` (`trashed_at` + `restore_until`) with the
--      compatibility exclusion marker `deleted_at = trashed_at`, so an 0018
--      Worker still serving during a migration-first deployment filters the row
--      out of every ordinary read and refuses its own delete path before
--      touching R2;
--   2. `events.recoverable_media_count` / `recoverable_bytes`, so a retained
--      photo keeps spending the capacity it will need back at Restore. Trash
--      that appeared to free space would make a later Restore fail for lack of
--      room, and a UI that promised recovery would have been lying;
--   3. an export source hold. `export_media_entries` plus an owning job in
--      `queued` or `running` is a claim on exact bytes: while it stands, no
--      tombstone for that exact bucket/key may enter suppression, so no
--      deletion path — old or new — can pull the ground out from under an
--      accepted export.
--
-- The migration is all-or-nothing and refuses to run while an export Workflow
-- is executing: it cannot reason about a job that is reading R2 right now.
-- Deployment waits for the run to become terminal and applies it again.

-- ---------------------------------------------------------------------------
-- 1. The execution gate.
--
-- The house pattern for "abort the whole migration" is a guard table whose
-- CHECK the sentinel row must satisfy (see `_event_cover_0014_proof_guard`).
-- Nothing above this point has changed the database, so a refusal is free.
-- ---------------------------------------------------------------------------

CREATE TABLE _media_recovery_0019_gate (
  proof INTEGER NOT NULL CHECK (proof = 1)
);

INSERT INTO _media_recovery_0019_gate (proof)
SELECT CASE WHEN
  NOT EXISTS (SELECT 1 FROM export_jobs WHERE state = 'running')
THEN 1 ELSE 0 END;

DROP TABLE _media_recovery_0019_gate;

-- ---------------------------------------------------------------------------
-- 2. Columns.
--
-- Both trash values are nullable and always written together; the pair rules
-- are triggers below, because `ALTER TABLE ADD COLUMN` cannot carry a
-- cross-column CHECK. The counters are ordinary non-negative integers.
-- ---------------------------------------------------------------------------

ALTER TABLE media ADD COLUMN trashed_at TEXT;
ALTER TABLE media ADD COLUMN restore_until TEXT;

ALTER TABLE events ADD COLUMN recoverable_media_count INTEGER NOT NULL DEFAULT 0
  CHECK (recoverable_media_count >= 0);
ALTER TABLE events ADD COLUMN recoverable_bytes INTEGER NOT NULL DEFAULT 0
  CHECK (recoverable_bytes >= 0);

-- The scheduled expiry sweep and the Recently deleted page. Both are partial,
-- so they cost nothing for the overwhelming majority of rows, which are active.
CREATE INDEX media_recovery_expiry
ON media(restore_until, id)
WHERE trashed_at IS NOT NULL;

CREATE INDEX media_recently_deleted_page
ON media(event_id, trashed_at DESC, id DESC)
WHERE trashed_at IS NOT NULL;

-- The source hold, over the columns the snapshot already froze. Retry resolves
-- each frozen entry to its current row by media id, which is why that leads.
CREATE INDEX export_media_entries_source_hold
ON export_media_entries(media_id, object_bucket_generation, object_key, export_job_id);

-- ---------------------------------------------------------------------------
-- 3. Validate every queued export job, before any guard exists to trip over.
--
-- A pre-0015 complete job (`guestbook_entry_count IS NULL`) is the one shape
-- whose pinned Workflow reads a live media query instead of its frozen
-- entries. Backfilling rows cannot make its *future* source set safe, so it is
-- failed rather than repaired. Album jobs are entry-backed by construction even
-- though they carry no Guestbook columns, so the discriminator names `kind`.
--
-- An entry-backed queued job survives only if its frozen cardinality and byte
-- sum still match the job, and no frozen source has already entered
-- suppression. It deliberately does not have to still be pointed at by a live
-- media row: an accepted snapshot is immutable, and a later trash, guest
-- deletion, or promotion must not strand bytes this job is entitled to read.
-- ---------------------------------------------------------------------------

UPDATE export_jobs
SET state = 'failed', error_code = 'EXPORT_SOURCE_REMOVED'
WHERE state = 'queued'
  AND kind = 'complete'
  AND guestbook_entry_count IS NULL;

UPDATE export_jobs
SET state = 'failed', error_code = 'EXPORT_SOURCE_REMOVED'
WHERE state = 'queued'
  AND NOT (
    (SELECT count(*) FROM export_media_entries AS e
      WHERE e.export_job_id = export_jobs.id) = export_jobs.media_count
    AND COALESCE((SELECT sum(COALESCE(e.byte_size, e.declared_byte_size))
      FROM export_media_entries AS e
      WHERE e.export_job_id = export_jobs.id), 0) = export_jobs.total_bytes
    AND NOT EXISTS (
      SELECT 1 FROM export_media_entries AS e
      WHERE e.export_job_id = export_jobs.id
        AND NOT EXISTS (
          SELECT 1 FROM media_object_write_tombstones AS t
          WHERE t.bucket_generation = e.object_bucket_generation
            AND t.object_key = e.object_key
            AND t.suppression_started_at IS NULL
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 4. The trash pair invariants.
--
-- `deleted_at = trashed_at` is not a coincidence and not permanent deletion: it
-- is the marker an 0018 Worker already understands. Every rule below is stated
-- for both INSERT and UPDATE so a fixture cannot create a shape the runtime is
-- forbidden to reach.
-- ---------------------------------------------------------------------------

CREATE TRIGGER media_trash_pair_insert
BEFORE INSERT ON media
WHEN (NEW.trashed_at IS NULL) <> (NEW.restore_until IS NULL)
  OR (
    NEW.trashed_at IS NOT NULL
    AND (
      NEW.upload_state <> 'stored'
      OR NEW.deleted_at IS NOT NEW.trashed_at
      OR NEW.restore_until <= NEW.trashed_at
      OR EXISTS (
        SELECT 1 FROM events AS e
        WHERE e.id = NEW.event_id
          AND (
            NEW.restore_until > e.management_access_expires_at
            OR NEW.restore_until > e.purge_after
          )
      )
    )
  )
  OR (
    NEW.trashed_at IS NULL
    AND NEW.upload_state = 'stored'
    AND NEW.deleted_at IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'media recovery markers are invalid');
END;

CREATE TRIGGER media_trash_pair_update
BEFORE UPDATE OF trashed_at, restore_until, deleted_at, upload_state, event_id ON media
WHEN (NEW.trashed_at IS NULL) <> (NEW.restore_until IS NULL)
  OR (
    NEW.trashed_at IS NOT NULL
    AND (
      NEW.upload_state <> 'stored'
      OR NEW.deleted_at IS NOT NEW.trashed_at
      OR NEW.restore_until <= NEW.trashed_at
      OR EXISTS (
        SELECT 1 FROM events AS e
        WHERE e.id = NEW.event_id
          AND (
            NEW.restore_until > e.management_access_expires_at
            OR NEW.restore_until > e.purge_after
          )
      )
    )
  )
  -- An active stored row carries none of the three markers. Grandfathered on
  -- OLD, so a pre-0019 row that somehow already held one is still writable.
  OR (
    NEW.trashed_at IS NULL
    AND NEW.upload_state = 'stored'
    AND NEW.deleted_at IS NOT NULL
    AND NOT (OLD.upload_state = 'stored' AND OLD.trashed_at IS NULL AND OLD.deleted_at IS NOT NULL)
  )
BEGIN
  SELECT RAISE(ABORT, 'media recovery markers are invalid');
END;

-- ---------------------------------------------------------------------------
-- 5. Capacity. Reserved + active stored + recoverable, on every counter write.
--
-- The 0018 Worker writes these columns too, and it has never heard of
-- `recoverable_*`. Enforcing the sum here rather than in the reservation
-- statement is what keeps its arithmetic inside the same ceiling.
-- ---------------------------------------------------------------------------

CREATE TRIGGER events_media_capacity_guard_insert
BEFORE INSERT ON events
WHEN NEW.reserved_media_count + NEW.stored_media_count + NEW.recoverable_media_count > 10000
  OR NEW.reserved_bytes + NEW.stored_bytes + NEW.recoverable_bytes > 107374182400
BEGIN
  SELECT RAISE(ABORT, 'event media capacity exceeded');
END;

CREATE TRIGGER events_media_capacity_guard_update
BEFORE UPDATE OF reserved_media_count, stored_media_count, recoverable_media_count,
  reserved_bytes, stored_bytes, recoverable_bytes ON events
WHEN NEW.reserved_media_count + NEW.stored_media_count + NEW.recoverable_media_count > 10000
  OR NEW.reserved_bytes + NEW.stored_bytes + NEW.recoverable_bytes > 107374182400
BEGIN
  SELECT RAISE(ABORT, 'event media capacity exceeded');
END;

-- ---------------------------------------------------------------------------
-- 6. A recoverable photo owns the objects it still points at.
--
-- While the trash pair stands, the row's current source pointer and its
-- recorded preview alias may not enter suppression — from new code, from the
-- promotion cleanup, or from the tombstone janitor. Those are the bytes Restore
-- gives back, and suppressing them would schedule the deletion of a photograph
-- the host has been told they can recover.
--
-- Deliberately scoped to the *current* pointers rather than to everything that
-- ever bore this media id. A promotion that has already moved the pointer must
-- still be able to retire the noncurrent legacy key it left behind — otherwise
-- its inventory row can never settle, the promotion fence never clears, and the
-- event purge that waits on that fence stalls for as long as the photo is
-- retained. This is the exact mirror of the recovery exception in the replaced
-- tombstone guard below: what may not be suppressed is what may not be missing
-- at Restore.
-- ---------------------------------------------------------------------------

CREATE TRIGGER media_recoverable_owner_tombstone_insert
BEFORE INSERT ON media_object_write_tombstones
WHEN NEW.suppression_started_at IS NOT NULL
  AND NEW.object_kind NOT IN ('export', 'cover')
  AND EXISTS (
    SELECT 1 FROM media AS m
    WHERE m.id = NEW.media_id
      AND m.event_id = NEW.event_id
      AND m.upload_state = 'stored'
      AND m.trashed_at IS NOT NULL
      AND m.deleted_at = m.trashed_at
      AND (
        (NEW.bucket_generation = m.object_bucket_generation AND NEW.object_key = m.object_key)
        OR (m.preview_object_key IS NOT NULL
          AND NEW.bucket_generation = 'legacy' AND NEW.object_key = m.preview_object_key)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'a recoverable photo owns this object');
END;

CREATE TRIGGER media_recoverable_owner_tombstone_suppress
BEFORE UPDATE OF suppression_started_at ON media_object_write_tombstones
WHEN OLD.suppression_started_at IS NULL
  AND NEW.suppression_started_at IS NOT NULL
  AND NEW.object_kind NOT IN ('export', 'cover')
  AND EXISTS (
    SELECT 1 FROM media AS m
    WHERE m.id = NEW.media_id
      AND m.event_id = NEW.event_id
      AND m.upload_state = 'stored'
      AND m.trashed_at IS NOT NULL
      AND m.deleted_at = m.trashed_at
      AND (
        (NEW.bucket_generation = m.object_bucket_generation AND NEW.object_key = m.object_key)
        OR (m.preview_object_key IS NOT NULL
          AND NEW.bucket_generation = 'legacy' AND NEW.object_key = m.preview_object_key)
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'a recoverable photo owns this object');
END;

-- ---------------------------------------------------------------------------
-- 7. The export source hold.
--
-- Exact bucket and key, exact owning job. An active hold blocks suppression
-- from every physical path at once, which is the only way the promise "no
-- accepted export loses a source object" survives paths this migration has
-- never read.
-- ---------------------------------------------------------------------------

CREATE TRIGGER export_source_hold_tombstone_insert
BEFORE INSERT ON media_object_write_tombstones
WHEN NEW.suppression_started_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM export_media_entries AS e
    JOIN export_jobs AS j ON j.id = e.export_job_id
    WHERE e.object_bucket_generation = NEW.bucket_generation
      AND e.object_key = NEW.object_key
      AND j.state IN ('queued', 'running')
  )
BEGIN
  SELECT RAISE(ABORT, 'an active export holds this source object');
END;

CREATE TRIGGER export_source_hold_tombstone_suppress
BEFORE UPDATE OF suppression_started_at ON media_object_write_tombstones
WHEN OLD.suppression_started_at IS NULL
  AND NEW.suppression_started_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM export_media_entries AS e
    JOIN export_jobs AS j ON j.id = e.export_job_id
    WHERE e.object_bucket_generation = NEW.bucket_generation
      AND e.object_key = NEW.object_key
      AND j.state IN ('queued', 'running')
  )
BEGIN
  SELECT RAISE(ABORT, 'an active export holds this source object');
END;

-- A snapshot may never freeze an object that is already on its way out.
CREATE TRIGGER export_media_entry_suppressed_source_insert
BEFORE INSERT ON export_media_entries
WHEN EXISTS (
  SELECT 1 FROM media_object_write_tombstones AS t
  WHERE t.bucket_generation = NEW.object_bucket_generation
    AND t.object_key = NEW.object_key
    AND t.suppression_started_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'export source object is permanently suppressed');
END;

-- ---------------------------------------------------------------------------
-- 8. Export execution fences.
--
-- A queued entryless complete job is the shape whose Workflow would read live
-- media. After this migration it cannot be created, and it cannot be retried
-- back into existence: the host prepares the current collection instead.
-- ---------------------------------------------------------------------------

CREATE TRIGGER export_jobs_entryless_queued_insert
BEFORE INSERT ON export_jobs
WHEN NEW.state = 'queued'
  AND NEW.kind = 'complete'
  AND NEW.guestbook_entry_count IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a queued export must freeze its sources');
END;

-- Queued -> running is the last boundary before any R2 read. It proves the
-- frozen snapshot is intact and unsuppressed; it deliberately does not consult
-- the mutable live pointer, because an accepted snapshot outlives it.
CREATE TRIGGER export_jobs_running_source_fence
BEFORE UPDATE OF state ON export_jobs
WHEN NEW.state = 'running'
  AND OLD.state = 'queued'
  AND NOT (
    (SELECT count(*) FROM export_media_entries AS e
      WHERE e.export_job_id = NEW.id) = NEW.media_count
    AND COALESCE((SELECT sum(COALESCE(e.byte_size, e.declared_byte_size))
      FROM export_media_entries AS e
      WHERE e.export_job_id = NEW.id), 0) = NEW.total_bytes
    AND NOT EXISTS (
      SELECT 1 FROM export_media_entries AS e
      WHERE e.export_job_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM media_object_write_tombstones AS t
          WHERE t.bucket_generation = e.object_bucket_generation
            AND t.object_key = e.object_key
            AND t.suppression_started_at IS NULL
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'export source hold is not intact');
END;

-- Retry is stricter than the run fence, because it reacquires holds that were
-- released when the job went terminal: every frozen entry must still resolve to
-- an active or recoverable stored row pointing at that exact key. A trashed row
-- qualifies — its bytes are retained — while a permanently deleted or
-- repointed one does not, and the route reports EXPORT_SOURCE_REMOVED.
CREATE TRIGGER export_jobs_retry_source_fence
BEFORE UPDATE OF state ON export_jobs
WHEN NEW.state = 'queued'
  AND OLD.state IN ('failed', 'expired')
  AND (
    (NEW.kind = 'complete' AND NEW.guestbook_entry_count IS NULL)
    OR NOT (
      (SELECT count(*) FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id) = NEW.media_count
      AND COALESCE((SELECT sum(COALESCE(e.byte_size, e.declared_byte_size))
        FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id), 0) = NEW.total_bytes
      AND NOT EXISTS (
        SELECT 1 FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id
          AND NOT EXISTS (
            SELECT 1 FROM media_object_write_tombstones AS t
            WHERE t.bucket_generation = e.object_bucket_generation
              AND t.object_key = e.object_key
              AND t.suppression_started_at IS NULL
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM export_media_entries AS e
        WHERE e.export_job_id = NEW.id
          AND NOT EXISTS (
            SELECT 1 FROM media AS m
            WHERE m.id = e.media_id
              AND m.event_id = NEW.event_id
              AND m.upload_state = 'stored'
              AND m.object_bucket_generation = e.object_bucket_generation
              AND m.object_key = e.object_key
              AND (
                (m.trashed_at IS NULL AND m.deleted_at IS NULL)
                OR (m.trashed_at IS NOT NULL AND m.deleted_at = m.trashed_at)
              )
          )
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'export source hold cannot be reacquired');
END;

-- ---------------------------------------------------------------------------
-- 9. The two 0015 UPDATE guards, replaced.
--
-- Both are reinstalled verbatim except for one exact recovery exception. Every
-- ordinary deleted-row revival still aborts; what is now permitted is a row
-- whose valid trash pair matches `deleted_at` clearing all three markers while
-- remaining stored, with its identity and pointers unchanged.
-- ---------------------------------------------------------------------------

DROP TRIGGER media_object_write_tombstone_guard_update;

CREATE TRIGGER media_object_write_tombstone_guard_update
BEFORE UPDATE OF event_id, object_key, object_bucket_generation,
  preview_object_key, upload_state, deleted_at, trashed_at, restore_until ON media
WHEN (NEW.object_bucket_generation = 'canonical' AND NEW.preview_object_key IS NOT NULL)
  OR (
    NEW.deleted_at IS NULL
    AND NEW.upload_state IN ('reserved', 'stored')
    AND CASE WHEN (
      -- The recovery exception.
      OLD.trashed_at IS NOT NULL
      AND OLD.deleted_at = OLD.trashed_at
      AND OLD.upload_state = 'stored'
      AND NEW.upload_state = 'stored'
      AND NEW.trashed_at IS NULL
      AND NEW.restore_until IS NULL
      AND NEW.event_id = OLD.event_id
      AND NEW.object_key = OLD.object_key
      AND NEW.object_bucket_generation = OLD.object_bucket_generation
      AND NEW.preview_object_key IS OLD.preview_object_key
    )
    THEN
      -- Only the pointers this row still uses may block it. A retired
      -- noncurrent alias — a promoted row's suppressed legacy key — is exactly
      -- what promotion was supposed to leave behind, and must not veto Restore.
      EXISTS (
        SELECT 1 FROM media_object_write_tombstones AS t
        WHERE t.suppression_started_at IS NOT NULL
          AND t.object_kind NOT IN ('export', 'cover')
          AND (
            (t.bucket_generation = NEW.object_bucket_generation AND t.object_key = NEW.object_key)
            OR (NEW.preview_object_key IS NOT NULL
              AND t.bucket_generation = 'legacy' AND t.object_key = NEW.preview_object_key)
          )
      )
    ELSE
      EXISTS (
        SELECT 1 FROM media_object_write_tombstones AS t
        WHERE t.suppression_started_at IS NOT NULL
          AND t.object_kind NOT IN ('export', 'cover')
          AND (
            (t.event_id = NEW.event_id AND t.media_id = NEW.id)
            OR (t.bucket_generation = NEW.object_bucket_generation AND t.object_key = NEW.object_key)
            OR (NEW.preview_object_key IS NOT NULL
              AND t.bucket_generation = 'legacy' AND t.object_key = NEW.preview_object_key)
          )
      )
    END
  )
BEGIN
  SELECT RAISE(ABORT, 'media object write target is permanently suppressed');
END;

DROP TRIGGER media_stored_legacy_guard_update;

CREATE TRIGGER media_stored_legacy_guard_update
BEFORE UPDATE OF event_id, upload_state, deleted_at, object_key,
  object_bucket_generation, mime_type, byte_size, width, height,
  trashed_at, restore_until ON media
WHEN NEW.deleted_at IS NULL
  AND NEW.upload_state = 'stored'
  AND NEW.object_bucket_generation = 'legacy'
  AND NOT (
    OLD.deleted_at IS NULL
    AND OLD.upload_state = 'stored'
    AND OLD.object_bucket_generation = 'legacy'
    AND OLD.event_id = NEW.event_id
    AND OLD.object_key = NEW.object_key
    AND OLD.mime_type = NEW.mime_type
    AND OLD.byte_size = NEW.byte_size
    AND OLD.width = NEW.width
    AND OLD.height = NEW.height
  )
  AND NOT (
    -- A grandfathered still-legacy stored row returning from Recently deleted.
    -- Nothing new is created: the same bytes, at the same key, resume being the
    -- same photograph.
    OLD.trashed_at IS NOT NULL
    AND OLD.deleted_at = OLD.trashed_at
    AND OLD.upload_state = 'stored'
    AND OLD.object_bucket_generation = 'legacy'
    AND NEW.trashed_at IS NULL
    AND NEW.restore_until IS NULL
    AND OLD.event_id = NEW.event_id
    AND OLD.object_key = NEW.object_key
    AND OLD.mime_type = NEW.mime_type
    AND OLD.byte_size IS NEW.byte_size
    AND OLD.width IS NEW.width
    AND OLD.height IS NEW.height
  )
BEGIN
  SELECT RAISE(ABORT, 'legacy stored media creation is fenced');
END;

-- Durable export progress and attempt-owned execution.
--
-- Existing rows and old Workers remain `legacy`: migration-first deployment
-- must not reinterpret an in-flight run or require its SQL to know these
-- columns. New repository code opts a pristine queued job into `attempt-v2`.
-- The v2 triggers then make state, attempt, execution identity, and progress one
-- fenced state machine, so a pinned old callback loses before it can mutate a
-- row owned by a newer attempt.

ALTER TABLE export_jobs ADD COLUMN processed_media_count INTEGER
  CHECK (processed_media_count IS NULL OR processed_media_count >= 0);
ALTER TABLE export_jobs ADD COLUMN processed_bytes INTEGER
  CHECK (processed_bytes IS NULL OR processed_bytes >= 0);
ALTER TABLE export_jobs ADD COLUMN progress_updated_at TEXT;
ALTER TABLE export_jobs ADD COLUMN execution_protocol TEXT NOT NULL DEFAULT 'legacy'
  CHECK (execution_protocol IN ('legacy', 'attempt-v2'));
ALTER TABLE export_jobs ADD COLUMN execution_transition INTEGER NOT NULL DEFAULT 0
  CHECK (execution_transition >= 0);
ALTER TABLE export_jobs ADD COLUMN execution_started_at TEXT;

-- Progress is either absent or a complete durable milestone. Include the
-- frozen totals in the UPDATE trigger: lowering a total below already-recorded
-- progress must fail in the statement that tries to create the contradiction.
CREATE TRIGGER export_jobs_progress_insert
BEFORE INSERT ON export_jobs
WHEN NOT (
  (
    NEW.processed_media_count IS NULL
    AND NEW.processed_bytes IS NULL
    AND NEW.progress_updated_at IS NULL
  )
  OR (
    NEW.processed_media_count IS NOT NULL
    AND NEW.processed_bytes IS NOT NULL
    AND NEW.progress_updated_at IS NOT NULL
    AND NEW.processed_media_count >= 0
    AND NEW.processed_media_count <= NEW.media_count
    AND NEW.processed_bytes >= 0
    AND NEW.processed_bytes <= NEW.total_bytes
  )
)
BEGIN
  SELECT RAISE(ABORT, 'export progress is invalid');
END;

CREATE TRIGGER export_jobs_progress_update
BEFORE UPDATE OF processed_media_count, processed_bytes, progress_updated_at,
  media_count, total_bytes ON export_jobs
WHEN NOT (
  (
    NEW.processed_media_count IS NULL
    AND NEW.processed_bytes IS NULL
    AND NEW.progress_updated_at IS NULL
  )
  OR (
    NEW.processed_media_count IS NOT NULL
    AND NEW.processed_bytes IS NOT NULL
    AND NEW.progress_updated_at IS NOT NULL
    AND NEW.processed_media_count >= 0
    AND NEW.processed_media_count <= NEW.media_count
    AND NEW.processed_bytes >= 0
    AND NEW.processed_bytes <= NEW.total_bytes
  )
)
BEGIN
  SELECT RAISE(ABORT, 'export progress is invalid');
END;

-- A v2 job is born pristine. A non-pristine historical row can enter v2 only
-- through the terminal Retry transition accepted by the UPDATE trigger below.
CREATE TRIGGER export_jobs_execution_insert
BEFORE INSERT ON export_jobs
WHEN NEW.execution_protocol = 'attempt-v2'
  AND NOT (
    NEW.state = 'queued'
    AND NEW.attempt = 1
    AND NEW.execution_transition = 0
    AND NEW.started_at IS NULL
    AND NEW.execution_started_at IS NULL
    AND NEW.processed_media_count IS NULL
    AND NEW.processed_bytes IS NULL
    AND NEW.progress_updated_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution transition is invalid');
END;

-- Evaluate whenever either side is v2. In particular, testing only NEW would
-- let an update evade every rule by downgrading the discriminator to legacy.
-- Nullable identity and progress fields use IS so NULL never becomes an
-- accidental successful comparison.
CREATE TRIGGER export_jobs_execution_update
BEFORE UPDATE ON export_jobs
WHEN (OLD.execution_protocol = 'attempt-v2' OR NEW.execution_protocol = 'attempt-v2')
  AND NOT (
    NEW.media_count = OLD.media_count
    AND NEW.total_bytes = OLD.total_bytes
    AND (
    -- Same-state writes do not advance the execution ledger. Only a running
    -- owner may change/reset progress within an attempt; terminal and queued
    -- rows preserve their milestone tuple.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND NEW.started_at IS NULL
      AND NEW.state = OLD.state
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND (
        OLD.state = 'running'
        OR (
          NEW.processed_media_count IS OLD.processed_media_count
          AND NEW.processed_bytes IS OLD.processed_bytes
          AND NEW.progress_updated_at IS OLD.progress_updated_at
        )
      )
    )
      OR
    -- First claim: establish the stable owner token and the zero milestone.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'queued'
      AND NEW.state = 'running'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND OLD.execution_started_at IS NULL
      AND NEW.execution_started_at IS NOT NULL
      AND NEW.started_at IS NULL
      AND OLD.processed_media_count IS NULL
      AND OLD.processed_bytes IS NULL
      AND OLD.progress_updated_at IS NULL
      AND NEW.processed_media_count = 0
      AND NEW.processed_bytes = 0
      AND NEW.progress_updated_at IS NOT NULL
    )
      OR
    -- Dispatch may fail before a queued attempt owns an execution.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'queued'
      AND NEW.state = 'failed'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND OLD.execution_started_at IS NULL
      AND NEW.execution_started_at IS NULL
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count IS NULL
      AND NEW.processed_bytes IS NULL
      AND NEW.progress_updated_at IS NULL
    )
      OR
    -- Ready is admitted only after the durable milestone reaches both totals.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'running'
      AND NEW.state = 'ready'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND NEW.execution_started_at IS NOT NULL
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count = NEW.media_count
      AND NEW.processed_bytes = NEW.total_bytes
      AND NEW.progress_updated_at IS NOT NULL
    )
      OR
    -- Failure records the last completed whole-part milestone unchanged.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'running'
      AND NEW.state = 'failed'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND NEW.execution_started_at IS NOT NULL
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count IS OLD.processed_media_count
      AND NEW.processed_bytes IS OLD.processed_bytes
      AND NEW.progress_updated_at IS OLD.progress_updated_at
    )
      OR
    -- Expiry preserves the completed attempt identity and inventory milestone.
      (
      OLD.execution_protocol = 'attempt-v2'
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state = 'ready'
      AND NEW.state = 'expired'
      AND NEW.attempt = OLD.attempt
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.execution_started_at IS OLD.execution_started_at
      AND NEW.started_at IS NULL
      AND NEW.processed_media_count IS OLD.processed_media_count
      AND NEW.processed_bytes IS OLD.processed_bytes
      AND NEW.progress_updated_at IS OLD.progress_updated_at
    )
      OR
    -- Retry starts a new v2 attempt. This is also the sole legacy-to-v2 gate;
    -- 0019's existing Retry source trigger independently proves the snapshot.
      (
      OLD.execution_protocol IN ('legacy', 'attempt-v2')
      AND NEW.execution_protocol = 'attempt-v2'
      AND OLD.state IN ('failed', 'expired')
      AND NEW.state = 'queued'
      AND NEW.attempt = OLD.attempt + 1
      AND NEW.execution_transition = OLD.execution_transition + 1
      AND NEW.started_at IS NULL
      AND NEW.execution_started_at IS NULL
      AND NEW.processed_media_count IS NULL
      AND NEW.processed_bytes IS NULL
      AND NEW.progress_updated_at IS NULL
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution transition is invalid');
END;

-- New HTTP code and the attempt-owned Workflow become active in separate
-- control-plane operations. The migration starts in legacy-open so the old
-- Worker remains fully usable. A release then closes admission only after all
-- active legacy work is terminal, promotes both sides, and opens v2 admission.
-- D1 serializes the close against old queued INSERT/Retry writes: whichever
-- commits first makes the other statement fail.
CREATE TABLE export_protocol_admission (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state TEXT NOT NULL CHECK (state IN ('legacy-open', 'closed', 'open')),
  closed_at TEXT,
  worker_version_id TEXT,
  admitted_at TEXT,
  CHECK (
    (
      state = 'legacy-open'
      AND closed_at IS NULL
      AND worker_version_id IS NULL
      AND admitted_at IS NULL
    )
    OR (
      state = 'closed'
      AND typeof(closed_at) = 'text'
      AND length(closed_at) = 24
      AND substr(closed_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) = closed_at
      AND worker_version_id IS NULL
      AND admitted_at IS NULL
    )
    OR (
      state = 'open'
      AND typeof(closed_at) = 'text'
      AND length(closed_at) = 24
      AND substr(closed_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', closed_at) = closed_at
      AND typeof(worker_version_id) = 'text'
      AND length(worker_version_id) = 36
      AND worker_version_id = lower(worker_version_id)
      AND substr(worker_version_id, 9, 1) = '-'
      AND substr(worker_version_id, 14, 1) = '-'
      AND substr(worker_version_id, 19, 1) = '-'
      AND substr(worker_version_id, 24, 1) = '-'
      AND length(replace(worker_version_id, '-', '')) = 32
      AND replace(worker_version_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      AND typeof(admitted_at) = 'text'
      AND length(admitted_at) = 24
      AND substr(admitted_at, 12, 2) BETWEEN '00' AND '23'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) = admitted_at
      AND admitted_at >= closed_at
    )
  )
);

INSERT INTO export_protocol_admission (
  singleton, state, closed_at, worker_version_id, admitted_at
) VALUES (1, 'legacy-open', NULL, NULL, NULL);

CREATE TRIGGER export_protocol_admission_no_insert
BEFORE INSERT ON export_protocol_admission
WHEN EXISTS (SELECT 1 FROM export_protocol_admission)
BEGIN
  SELECT RAISE(ABORT, 'export protocol admission row is immutable');
END;

CREATE TRIGGER export_protocol_admission_transition
BEFORE UPDATE ON export_protocol_admission
WHEN NOT (
  NEW.singleton = OLD.singleton
  AND NOT EXISTS (
    SELECT 1 FROM export_jobs
    WHERE execution_protocol = 'legacy'
      AND state IN ('queued', 'running')
  )
  AND (
    (
      OLD.state = 'legacy-open'
      AND OLD.closed_at IS NULL
      AND OLD.worker_version_id IS NULL
      AND OLD.admitted_at IS NULL
      AND NEW.state = 'closed'
      AND NEW.closed_at IS NOT NULL
      AND NEW.worker_version_id IS NULL
      AND NEW.admitted_at IS NULL
    )
    OR (
      OLD.state = 'closed'
      AND OLD.closed_at IS NOT NULL
      AND OLD.worker_version_id IS NULL
      AND OLD.admitted_at IS NULL
      AND NEW.state = 'open'
      AND NEW.closed_at IS OLD.closed_at
      AND NEW.worker_version_id IS NOT NULL
      AND NEW.admitted_at IS NOT NULL
    )
  )
)
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM export_jobs
      WHERE execution_protocol = 'legacy'
        AND state IN ('queued', 'running')
    )
    THEN RAISE(ABORT, 'active legacy export blocks protocol admission transition')
    ELSE RAISE(ABORT, 'export protocol admission transition is invalid')
  END;
END;

CREATE TRIGGER export_protocol_admission_no_delete
BEFORE DELETE ON export_protocol_admission
BEGIN
  SELECT RAISE(ABORT, 'export protocol admission row is immutable');
END;

-- Admission is about creating an active execution, not completing one that
-- already owns the row. Existing queued -> running and running -> terminal
-- callbacks therefore remain valid. Active INSERTs, terminal -> active Retry,
-- and active protocol changes must match the one protocol admitted by D1.
CREATE TRIGGER export_jobs_protocol_admission_insert
BEFORE INSERT ON export_jobs
WHEN NEW.state IN ('queued', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM export_protocol_admission
    WHERE singleton = 1
      AND (
        (state = 'legacy-open' AND NEW.execution_protocol = 'legacy')
        OR (state = 'open' AND NEW.execution_protocol = 'attempt-v2')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution protocol is not admitted');
END;

CREATE TRIGGER export_jobs_protocol_admission_update
BEFORE UPDATE ON export_jobs
WHEN NEW.state IN ('queued', 'running')
  AND (
    OLD.state NOT IN ('queued', 'running')
    OR NEW.execution_protocol IS NOT OLD.execution_protocol
  )
  AND NOT EXISTS (
    SELECT 1 FROM export_protocol_admission
    WHERE singleton = 1
      AND (
        (state = 'legacy-open' AND NEW.execution_protocol = 'legacy')
        OR (state = 'open' AND NEW.execution_protocol = 'attempt-v2')
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'export execution protocol is not admitted');
END;

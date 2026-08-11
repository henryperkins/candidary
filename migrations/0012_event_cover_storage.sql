-- Event cover storage: the durable inventory behind the bounded normalization,
-- receipt, and render-set pipeline.
--
-- Additive on purpose. `0011` is owned by release certifications, and this
-- migration must apply cleanly to a populated production database, so every
-- `events` column below uses a SQLite-safe constant default and no existing row
-- is rewritten. A pre-0012 event keeps its `cover_object_key` exactly as it is
-- and reads as `{"version":1,"source":{"kind":"none"}}` until something
-- publishes or backfills it.
--
-- WHY `ON DELETE RESTRICT`, against fifteen `CASCADE` precedents.
--
-- Every existing `REFERENCES events(id)` in this schema cascades. These tables
-- deliberately invert that, and it is not a style choice: each row is the only
-- record that a specific object exists in R2. A cascade would delete the
-- inventory row while its bytes were still in the bucket, and nothing would
-- ever be able to find them again — they would be charged for, would still
-- contain a host's private photo, and would be invisible to every query. The
-- rule the pipeline enforces instead is that an object is proven gone from R2
-- *first*, and only then may its row go. `RESTRICT` is what makes forgetting
-- that a hard error rather than a silent leak.
--
-- The direct consequence is that `deleteEventData()` must delete these children
-- in the explicit order in §14 before it may delete the event. The scheduled
-- purge fails with a foreign-key error otherwise, on the first event that ever
-- owned a cover. That order lands in the same candidate as this migration.
--
-- `event_cover_workflow_fences` is the single exception and has no foreign key
-- to `events` at all: it closes the gap between a D1 commit and a platform
-- dispatch, so it has to outlive the event row it protected.
--
-- WHAT IS NOT ENFORCED HERE.
--
-- §8's canonical invariants are cross-column ("a published upload has a
-- non-null master pointer AND a same-event active render set"). SQLite cannot
-- attach a cross-column constraint through `ALTER TABLE ADD COLUMN`, and a
-- table-level trigger would reject the legacy rows this release exists to carry.
-- Those invariants are therefore deliberately absent during phase 1 and are what
-- `0013_event_cover_invariants.sql` exists for — authored only after the
-- separately authorized production zero-legacy proof, and deliberately not
-- checked into this candidate.

-- The semantic recipe. Bounded to 4 KiB and required to be a JSON object, so a
-- row can never grow into a document store or hold a bare array the reader
-- would have to guess at. The default is the exact canonical `none` string
-- `shared/event-cover.ts` serializes, byte for byte.
ALTER TABLE events ADD COLUMN cover_config TEXT NOT NULL
  DEFAULT '{"version":1,"source":{"kind":"none"}}'
  CHECK (length(cover_config) <= 4096)
  CHECK (json_valid(cover_config))
  CHECK (json_type(cover_config) = 'object');

-- The monotonic counter every publication compare-and-swaps on. Starts at 0,
-- which is also the `expectedRevision` a manager who has never published sends.
ALTER TABLE events ADD COLUMN cover_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(cover_revision) = 'integer')
  CHECK (cover_revision >= 0);

-- The queryable server-only pointer at the active uploaded render set. Null for
-- `none`, for `preset`, and for every legacy row until backfill converts it.
-- Deliberately a column rather than a key inside `cover_config`: the backfill
-- inventory query is `cover_object_key IS NOT NULL AND cover_render_set_id IS
-- NULL`, and that must be an index-friendly predicate rather than a JSON probe.
ALTER TABLE events ADD COLUMN cover_render_set_id TEXT;

-- The normalized still master for an uploaded cover: immutable bytes, plus the
-- automatic focal point that lets a later edit reset from manual back to the
-- composition Candidary proposed. Never a delivery source, guest or manager.
CREATE TABLE event_cover_masters (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL
    CHECK (mime_type IN ('image/webp')),
  byte_size INTEGER NOT NULL
    CHECK (typeof(byte_size) = 'integer')
    CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64)
    CHECK (sha256 NOT GLOB '*[^0-9a-f]*'),
  normalization_version INTEGER NOT NULL CHECK (normalization_version > 0),
  -- Which rung of the five-attempt ladder actually produced these bytes.
  normalization_rung INTEGER NOT NULL
    CHECK (normalization_rung BETWEEN 1 AND 5),
  -- Null only while a new upload is merely `inspected`. Both become required
  -- before any draft using this master may reach `ready`.
  auto_focus_x REAL CHECK (auto_focus_x IS NULL OR (auto_focus_x >= 0 AND auto_focus_x <= 1)),
  auto_focus_y REAL CHECK (auto_focus_y IS NULL OR (auto_focus_y >= 0 AND auto_focus_y <= 1)),
  composition_model_version INTEGER
    CHECK (composition_model_version IS NULL OR composition_model_version > 0),
  created_at TEXT NOT NULL,
  -- Set only once no event pointer, live draft, render set, unexpired receipt,
  -- or backfill job refers to this master.
  cleanup_after TEXT
);

CREATE INDEX event_cover_masters_by_event ON event_cover_masters (event_id);
CREATE INDEX event_cover_masters_cleanup ON event_cover_masters (cleanup_after)
  WHERE cleanup_after IS NOT NULL;

-- One studio or create-flow editing intent. A `new_upload` draft owns a
-- temporary raw object; an `existing_upload` draft references the event's
-- active master, owns no raw, and may begin `ready`.
CREATE TABLE event_cover_drafts (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  source TEXT NOT NULL
    CHECK (source IN ('new_upload', 'existing_upload')),
  state TEXT NOT NULL
    CHECK (state IN (
      'reserved', 'transferred', 'inspected', 'ready',
      'publishing', 'published', 'failed', 'expired'
    )),
  -- The client persists this before its first request, so a lost reservation
  -- response replays into the same draft instead of consuming a second slot.
  draft_intent_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL
    CHECK (length(request_sha256) = 64)
    CHECK (request_sha256 NOT GLOB '*[^0-9a-f]*'),
  draft_revision INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(draft_revision) = 'integer')
    CHECK (draft_revision >= 0),
  -- Server-owned and never accepted back from a client. Ownership is always
  -- resolved from the event-scoped draft ID.
  raw_object_key TEXT UNIQUE,
  declared_filename TEXT,
  declared_mime_type TEXT
    CHECK (declared_mime_type IS NULL OR declared_mime_type IN (
      'image/jpeg', 'image/png', 'image/webp', 'image/heic'
    )),
  declared_byte_size INTEGER
    CHECK (declared_byte_size IS NULL OR declared_byte_size > 0),
  verified_raw_byte_size INTEGER
    CHECK (verified_raw_byte_size IS NULL OR verified_raw_byte_size > 0),
  raw_etag TEXT,
  master_id TEXT REFERENCES event_cover_masters(id) ON DELETE RESTRICT,
  -- Copied from the master once the composition write lands.
  focus_x REAL CHECK (focus_x IS NULL OR (focus_x >= 0 AND focus_x <= 1)),
  focus_y REAL CHECK (focus_y IS NULL OR (focus_y >= 0 AND focus_y <= 1)),
  composition_model_version INTEGER
    CHECK (composition_model_version IS NULL OR composition_model_version > 0),
  inspection_json TEXT
    CHECK (inspection_json IS NULL OR json_valid(inspection_json)),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reservation_expires_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX event_cover_drafts_intent
  ON event_cover_drafts (event_id, draft_intent_id);
CREATE INDEX event_cover_drafts_by_event_state
  ON event_cover_drafts (event_id, state);
CREATE INDEX event_cover_drafts_expiry ON event_cover_drafts (expires_at);
CREATE INDEX event_cover_drafts_master ON event_cover_drafts (master_id)
  WHERE master_id IS NOT NULL;

-- The preview files one draft owns, inventoried rather than inferred from an R2
-- listing. At most five per draft, one per effect at the current recipe version.
CREATE TABLE event_cover_draft_previews (
  id TEXT NOT NULL PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES event_cover_drafts(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  effect_id TEXT NOT NULL
    CHECK (effect_id IN ('natural', 'warm', 'film', 'soft', 'monochrome')),
  recipe_version INTEGER NOT NULL CHECK (recipe_version > 0),
  state TEXT NOT NULL CHECK (state IN ('rendering', 'ready', 'failed')),
  object_key TEXT UNIQUE,
  mime_type TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  ladder_rung INTEGER CHECK (ladder_rung IS NULL OR ladder_rung BETWEEN 1 AND 4),
  sha256 TEXT
    CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  failure_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Same-tuple replay returns the stored ready or permanent-failed result; only a
-- retryable failure may re-enter `rendering` under this key.
CREATE UNIQUE INDEX event_cover_draft_previews_tuple
  ON event_cover_draft_previews (draft_id, effect_id, recipe_version);
CREATE INDEX event_cover_draft_previews_by_event
  ON event_cover_draft_previews (event_id);

-- One complete rendering of one cover recipe. `staging` may be incomplete;
-- `ready` requires the exact manifest and is still unreachable from the event;
-- only the final revision transaction may select `active`.
CREATE TABLE event_cover_render_sets (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  master_id TEXT NOT NULL REFERENCES event_cover_masters(id) ON DELETE RESTRICT,
  draft_id TEXT REFERENCES event_cover_drafts(id) ON DELETE RESTRICT,
  recipe_json TEXT NOT NULL
    CHECK (json_valid(recipe_json))
    CHECK (json_type(recipe_json) = 'object'),
  recipe_sha256 TEXT NOT NULL
    CHECK (length(recipe_sha256) = 64)
    CHECK (recipe_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL
    CHECK (state IN ('staging', 'ready', 'active', 'retired', 'abandoned')),
  -- Server-derived: 12 through 24, both formats for every 1x profile plus the
  -- source-qualified 2x pairs.
  required_slots INTEGER NOT NULL CHECK (required_slots BETWEEN 12 AND 24),
  -- Null only while staging.
  manifest_sha256 TEXT
    CHECK (manifest_sha256 IS NULL
      OR (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
  published_revision INTEGER
    CHECK (published_revision IS NULL OR published_revision >= 0),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  published_at TEXT,
  retired_at TEXT,
  abandoned_reason TEXT,
  abandoned_at TEXT,
  cleanup_after TEXT
);

-- At most one active uploaded set per event. §9.3 treats a second as
-- impossible, and no later code re-checks it.
CREATE UNIQUE INDEX event_cover_render_sets_one_active_per_event
  ON event_cover_render_sets (event_id)
  WHERE state = 'active';
CREATE INDEX event_cover_render_sets_by_event_state
  ON event_cover_render_sets (event_id, state);
CREATE INDEX event_cover_render_sets_cleanup
  ON event_cover_render_sets (cleanup_after)
  WHERE cleanup_after IS NOT NULL;

-- One row per required profile/density/format slot. The compound key is what
-- makes a missing or duplicated slot representable as a constraint rather than
-- as a count nobody re-reads.
CREATE TABLE event_cover_render_objects (
  id TEXT NOT NULL PRIMARY KEY,
  render_set_id TEXT NOT NULL REFERENCES event_cover_render_sets(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  profile_id TEXT NOT NULL
    CHECK (profile_id IN (
      'short-lookup', 'compact-default', 'standard-default',
      'framed-default', 'compact-expanded', 'wide-expanded'
    )),
  density TEXT NOT NULL CHECK (density IN ('1x', '2x')),
  format TEXT NOT NULL CHECK (format IN ('webp', 'jpeg')),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('image/webp', 'image/jpeg')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  quality_rung INTEGER NOT NULL CHECK (quality_rung BETWEEN 1 AND 4),
  sha256 TEXT NOT NULL
    CHECK (length(sha256) = 64)
    CHECK (sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX event_cover_render_objects_slot
  ON event_cover_render_objects (render_set_id, profile_id, density, format);
CREATE INDEX event_cover_render_objects_by_event
  ON event_cover_render_objects (event_id);

-- Durable publication acceptance. A committed receipt is the promise that work
-- was accepted even if the client never saw a response, which is why an ordinary
-- discard cannot touch a `publishing` draft until this row is terminal.
CREATE TABLE event_cover_publish_receipts (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  draft_id TEXT REFERENCES event_cover_drafts(id) ON DELETE RESTRICT,
  render_set_id TEXT REFERENCES event_cover_render_sets(id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL
    CHECK (length(request_sha256) = 64)
    CHECK (request_sha256 NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK (action IN ('publish', 'remove')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'rendering', 'finalizing', 'applied', 'conflict', 'failed')),
  -- Deterministic, derived from event and operation. Unique so a competitor can
  -- never be allocated for the same operation.
  workflow_instance_id TEXT UNIQUE,
  -- Every resolver version this operation was pinned to, so a deployment during
  -- a restart window cannot silently re-render under newer recipes.
  dependency_versions_json TEXT NOT NULL
    CHECK (json_valid(dependency_versions_json))
    CHECK (json_type(dependency_versions_json) = 'object'),
  completed_profiles INTEGER NOT NULL DEFAULT 0
    CHECK (completed_profiles BETWEEN 0 AND 6),
  required_profiles INTEGER NOT NULL DEFAULT 0
    CHECK (required_profiles BETWEEN 0 AND 6),
  applied_revision INTEGER CHECK (applied_revision IS NULL OR applied_revision >= 0),
  result_cover_json TEXT
    CHECK (result_cover_json IS NULL OR json_valid(result_cover_json)),
  failure_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  -- Separate from `status` so an absent platform instance is never confused
  -- with an in-flight create or restart.
  dispatch_state TEXT NOT NULL
    CHECK (dispatch_state IN (
      'pending', 'creating', 'confirmed', 'resuming', 'restarting', 'failed', 'blocked'
    )),
  dispatch_generation INTEGER NOT NULL DEFAULT 0
    CHECK (dispatch_generation >= 0),
  last_dispatch_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (event_id, operation_id)
);

-- One preparing publication per event. A `failed` receipt stops blocking only
-- once its retry window closes and expiry clears `retryable`.
CREATE UNIQUE INDEX event_cover_receipts_one_preparing_per_event
  ON event_cover_publish_receipts (event_id)
  WHERE status IN ('queued', 'rendering', 'finalizing')
     OR (status = 'failed' AND retryable = 1);
CREATE INDEX event_cover_receipts_expiry
  ON event_cover_publish_receipts (expires_at);
CREATE INDEX event_cover_receipts_by_draft
  ON event_cover_publish_receipts (draft_id)
  WHERE draft_id IS NOT NULL;

-- The commit/dispatch gap. Keyed by binding plus instance ID and deliberately
-- carrying no foreign key to `events`: a fence has to survive the event row it
-- protected, or a late dispatcher could do cover work for a purged event.
CREATE TABLE event_cover_workflow_fences (
  workflow_binding TEXT NOT NULL
    CHECK (workflow_binding IN ('COVER_RENDER_WORKFLOW', 'COVER_BACKFILL_WORKFLOW')),
  workflow_instance_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'deletion-blocked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 31 days after terminal verification, exceeding the platform's 30-day
  -- completed-instance retention so an ID can never be recreated behind us.
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workflow_binding, workflow_instance_id)
);

CREATE INDEX event_cover_workflow_fences_by_event
  ON event_cover_workflow_fences (event_id);
CREATE INDEX event_cover_workflow_fences_expiry
  ON event_cover_workflow_fences (expires_at);

-- Persisted mutation budgets. In D1 rather than a rate-limit binding, so every
-- count and every non-counting replay is reconstructable after a restart.
CREATE TABLE event_cover_rate_events (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN ('reservation', 'inspection', 'preview', 'publication')),
  -- Server-validated: draft intent, draft plus recipe, draft plus effect and
  -- recipe, or operation ID. A replay matches here and consumes no capacity.
  replay_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL
    CHECK (length(request_sha256) = 64)
    CHECK (request_sha256 NOT GLOB '*[^0-9a-f]*'),
  -- floor(serverUnixSeconds / 3600) * 3600.
  window_start INTEGER NOT NULL
    CHECK (typeof(window_start) = 'integer')
    CHECK (window_start >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX event_cover_rate_events_replay
  ON event_cover_rate_events (event_id, action, replay_key);
CREATE INDEX event_cover_rate_events_window
  ON event_cover_rate_events (event_id, action, window_start);
CREATE INDEX event_cover_rate_events_expiry
  ON event_cover_rate_events (expires_at);

-- The only recovery inventory for a displaced pre-0012 original. Written in the
-- same transaction that moves the pointer, never after: an eager delete is what
-- this table exists to replace.
CREATE TABLE event_cover_retired_legacy_objects (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  -- The actual key, server-only. Never projected into any response.
  object_key TEXT NOT NULL UNIQUE,
  key_fingerprint TEXT NOT NULL
    CHECK (length(key_fingerprint) = 64)
    CHECK (key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL
    CHECK (reason IN ('replaced', 'removed', 'backfilled')),
  retired_at TEXT NOT NULL,
  cleanup_after TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX event_cover_retired_legacy_objects_by_event
  ON event_cover_retired_legacy_objects (event_id);
CREATE INDEX event_cover_retired_legacy_objects_cleanup
  ON event_cover_retired_legacy_objects (cleanup_after)
  WHERE deleted_at IS NULL;

-- Bounded, restartable event purge. One row per event being hard-deleted; the
-- phase may only advance when a fresh query proves the previous one is finished.
CREATE TABLE event_cover_purge_progress (
  event_id TEXT NOT NULL PRIMARY KEY REFERENCES events(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('fences', 'r2', 'relational')),
  workflow_binding TEXT,
  workflow_instance_id TEXT,
  fences_resolved INTEGER NOT NULL DEFAULT 0 CHECK (fences_resolved >= 0),
  platform_mutations INTEGER NOT NULL DEFAULT 0 CHECK (platform_mutations >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Release-only ledgers. Neither is ever returned through a Manager or guest
-- contract; both exist so a backfill can be interrupted and resumed truthfully.
CREATE TABLE event_cover_backfill_runs (
  id TEXT NOT NULL PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('inventory', 'execute', 'verify')),
  cursor TEXT,
  inventory_sha256 TEXT
    CHECK (inventory_sha256 IS NULL
      OR (length(inventory_sha256) = 64 AND inventory_sha256 NOT GLOB '*[^0-9a-f]*')),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  queued_count INTEGER NOT NULL DEFAULT 0 CHECK (queued_count >= 0),
  applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  resolved_count INTEGER NOT NULL DEFAULT 0 CHECK (resolved_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  needs_replacement_count INTEGER NOT NULL DEFAULT 0 CHECK (needs_replacement_count >= 0),
  status TEXT NOT NULL
    CHECK (status IN ('inventorying', 'executing', 'verified', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT
);

CREATE TABLE event_cover_backfill_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES event_cover_backfill_runs(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  -- The exact original this job was created against. A job whose fingerprint is
  -- no longer current becomes `resolved` rather than blocking phase 3 forever.
  legacy_key_fingerprint TEXT NOT NULL
    CHECK (length(legacy_key_fingerprint) = 64)
    CHECK (legacy_key_fingerprint NOT GLOB '*[^0-9a-f]*'),
  master_id TEXT REFERENCES event_cover_masters(id) ON DELETE RESTRICT,
  render_set_id TEXT REFERENCES event_cover_render_sets(id) ON DELETE RESTRICT,
  workflow_instance_id TEXT NOT NULL UNIQUE,
  dispatch_state TEXT NOT NULL
    CHECK (dispatch_state IN (
      'pending', 'creating', 'confirmed', 'resuming', 'restarting', 'failed', 'blocked'
    )),
  dispatch_generation INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_generation >= 0),
  status TEXT NOT NULL
    CHECK (status IN (
      'queued', 'normalizing', 'rendering', 'finalizing', 'applied',
      'skipped', 'resolved', 'needs_replacement', 'failed'
    )),
  -- Pinned at job creation and source-independent, so a restart inside the
  -- window renders under exactly the resolvers the first attempt used.
  dependency_versions_json TEXT NOT NULL
    CHECK (json_valid(dependency_versions_json))
    CHECK (json_type(dependency_versions_json) = 'object'),
  -- Null until successful normalization reveals the winning master dimensions;
  -- required and immutable from `rendering` onward.
  manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  manifest_sha256 TEXT
    CHECK (manifest_sha256 IS NULL
      OR (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
  failure_code TEXT,
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  terminal_at TEXT,
  reference_release_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX event_cover_backfill_jobs_run_event
  ON event_cover_backfill_jobs (run_id, event_id);
CREATE INDEX event_cover_backfill_jobs_status
  ON event_cover_backfill_jobs (run_id, status);
CREATE INDEX event_cover_backfill_jobs_by_event
  ON event_cover_backfill_jobs (event_id);

-- RSVP, and the permanent printed entry that leads to it.
--
-- Two independent things land together because they are two halves of one
-- promise: an invitation carries a QR that must keep working from the day it is
-- printed until the last photo is delivered, and behind that QR the household
-- first answers the invitation and later drops photos.
--
-- `event_entry_credentials` is the durable half. The existing guest row in
-- `event_access_tokens` stays exactly where it is and keeps authorizing uploads;
-- rotating it signs out guest devices without changing a single printed sign.
--
-- This migration is additive and deliberately backfills nothing. Events created
-- before it have no entry credential, and there is no compatibility path for the
-- old guest link. Release must prove there are none.

ALTER TABLE events
  ADD COLUMN event_timezone TEXT NOT NULL DEFAULT 'UTC'
  CHECK (length(event_timezone) BETWEEN 1 AND 64);
ALTER TABLE events
  ADD COLUMN rsvp_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (rsvp_enabled IN (0, 1));
-- The last millisecond of the host's chosen local day, as an absolute instant.
ALTER TABLE events ADD COLUMN rsvp_deadline_at TEXT;
-- Bumped by every roster change so a host page editing a stale view loses.
ALTER TABLE events
  ADD COLUMN rsvp_roster_version INTEGER NOT NULL DEFAULT 0
  CHECK (rsvp_roster_version >= 0);

-- An open RSVP with no deadline would never close. A CHECK constraint cannot be
-- added to an existing table, so the invariant is a trigger instead.
CREATE TRIGGER events_rsvp_deadline_insert
BEFORE INSERT ON events
WHEN NEW.rsvp_enabled = 1 AND NEW.rsvp_deadline_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RSVP deadline required');
END;

CREATE TRIGGER events_rsvp_deadline_update
BEFORE UPDATE OF rsvp_enabled, rsvp_deadline_at ON events
WHEN NEW.rsvp_enabled = 1 AND NEW.rsvp_deadline_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'RSVP deadline required');
END;

-- One printed credential per event, for the life of the event. `disabled_at` is
-- the emergency stop and is irreversible: there is no replacement, because a
-- replacement would not be on the signs already standing at the venue.
CREATE TABLE event_entry_credentials (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  secret_digest TEXT NOT NULL,
  -- Kept so a host who loses the printed card can be shown the link again. The
  -- manager token deliberately has no such ciphertext.
  secret_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE rsvp_households (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- The host's own stable identifier from the imported file.
  household_key TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- The last successful submission, kept so a lost response can be replayed
  -- rather than re-asked. This is a receipt, not a revision history.
  last_submission_key TEXT,
  last_submission_digest TEXT,
  last_submission_result_version INTEGER,
  first_responded_at TEXT,
  latest_responded_at TEXT,
  latest_actor_kind TEXT CHECK (
    latest_actor_kind IS NULL OR latest_actor_kind IN ('household', 'host')
  ),
  -- Archiving is irreversible. The rows stay for the host list and the export.
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, household_key),
  -- Carries the composite foreign key below, so an invitee or a session can
  -- never be attached to a household belonging to a different event.
  UNIQUE (event_id, id),
  CHECK (
    (last_submission_key IS NULL
      AND last_submission_digest IS NULL
      AND last_submission_result_version IS NULL)
    OR
    (last_submission_key IS NOT NULL
      AND last_submission_digest IS NOT NULL
      AND last_submission_result_version IS NOT NULL)
  )
);

-- One row per invited person: a named guest from the roster, or a fixed
-- plus-one slot the household may fill.
--
-- Only named guests carry a `lookup_digest`, so a plus-one can never be used to
-- open somebody's invitation, and a plus-one holds a name only while attending.
CREATE TABLE rsvp_invitees (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('named', 'plus_one')),
  display_name TEXT CHECK (
    display_name IS NULL OR length(display_name) BETWEEN 1 AND 80
  ),
  lookup_digest TEXT,
  attendance TEXT NOT NULL DEFAULT 'pending'
    CHECK (attendance IN ('pending', 'attending', 'declined')),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id, household_id)
    REFERENCES rsvp_households(event_id, id) ON DELETE CASCADE,
  UNIQUE (household_id, sort_order),
  CHECK (
    (kind = 'named' AND display_name IS NOT NULL AND lookup_digest IS NOT NULL)
    OR
    (kind = 'plus_one' AND lookup_digest IS NULL
      AND (
        (attendance = 'attending' AND display_name IS NOT NULL)
        OR
        (attendance IN ('pending', 'declined') AND display_name IS NULL)
      ))
  )
);

CREATE INDEX rsvp_invitees_lookup
  ON rsvp_invitees(event_id, lookup_digest, kind);

-- Every successful submission key is kept until the event is purged, so a guest
-- whose confirmation was lost on a bad connection can retry and be told it
-- already worked, rather than being asked to answer twice.
CREATE TABLE rsvp_submission_receipts (
  event_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK (result_version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (household_id, idempotency_key),
  FOREIGN KEY (event_id, household_id)
    REFERENCES rsvp_households(event_id, id) ON DELETE CASCADE
);

-- A third credential scope, beside the event guest session and the host account
-- session. `write_authority_deadline` is the deadline captured when the guest
-- proved who they were; shortening the event deadline beats it, extending does
-- not, so an extension requires proving identity again.
CREATE TABLE rsvp_sessions (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL,
  csrf_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  write_authority_deadline TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id, household_id)
    REFERENCES rsvp_households(event_id, id) ON DELETE CASCADE
);

CREATE INDEX rsvp_sessions_household
  ON rsvp_sessions(event_id, household_id, revoked_at, expires_at);
CREATE INDEX rsvp_sessions_cleanup
  ON rsvp_sessions(expires_at, revoked_at);

-- Defence in depth behind the edge limiter. Only keyed digests are stored, so
-- this table never holds a guest's name or a visitor's address.
CREATE TABLE rsvp_lookup_rate_limits (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('lookup_ip', 'lookup_name')),
  scope_digest TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  PRIMARY KEY (event_id, action, scope_digest, window_started_at)
);

CREATE INDEX rsvp_households_manager_page
  ON rsvp_households(event_id, archived_at, updated_at, id);
CREATE INDEX rsvp_lookup_rate_limits_cleanup
  ON rsvp_lookup_rate_limits(window_started_at);

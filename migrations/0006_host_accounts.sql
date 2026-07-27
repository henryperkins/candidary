-- Host accounts give the host a durable identity, so losing the management link
-- stops being unrecoverable. The link survives as a delegate credential: a host
-- can still hand `/manage/<token>` to a planner who will never sign up.
--
-- `event_sessions` keeps its name even though it now also carries account
-- sessions that belong to no event. Renaming it would force a rebuild of `media`
-- and `guest_messages`, which reference it with ON DELETE RESTRICT, and neither
-- table has anything to do with this change.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE host_accounts (
  id TEXT PRIMARY KEY,
  -- Normalized by the application to trimmed lowercase before it reaches here,
  -- so UNIQUE is the real one-account-per-address guarantee.
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  -- Self-describing scrypt encoding, `scrypt$N$r$p$salt$hash`. The parameters
  -- travel with the hash so they can be raised later and rehashed on next
  -- sign-in, rather than needing every row migrated at once.
  password_hash TEXT NOT NULL,
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  -- Verification gates notifications, never access. A bounced verification mail
  -- must not be able to lock a host out of an event they already own.
  email_verified_at TEXT,
  notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK (notifications_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  disabled_at TEXT
);

-- One row per emailed code. The code itself is never stored, only its keyed
-- digest, on the same terms as an access token secret.
--
-- `bind_event_id` carries the anonymous-creation path: the host proves they hold
-- the event's management session when they REQUEST the code, and the code proves
-- they own the address. Verification joins the two.
CREATE TABLE host_login_challenges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  secret_digest TEXT NOT NULL,
  bind_event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX host_login_challenges_account
  ON host_login_challenges(account_id, purpose, consumed_at, created_at);

-- Ownership lives here rather than on `events`, so co-hosts and a multi-event
-- list are a query rather than a second schema change.
CREATE TABLE event_hosts (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'cohost')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, account_id)
);

CREATE INDEX event_hosts_account ON event_hosts(account_id, created_at);

-- The send ledger. The daily cron re-examines every live event on every run, so
-- without a record of what already went out it would resend the same reminder
-- each night. The UNIQUE index is the idempotency guarantee, not the query that
-- selects candidates.
CREATE TABLE host_notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('getting_started', 'event_reminder', 'retention_warning')),
  sent_at TEXT NOT NULL
);

CREATE UNIQUE INDEX host_notifications_once
  ON host_notifications(account_id, event_id, kind);

-- One session table for all three subjects. A guest or manager session is
-- authorized by an access token against one event; a host session is authorized
-- by an account and spans every event that account hosts. The CHECK is what
-- keeps a row from claiming both authorities or neither.
DROP TABLE event_sessions;

CREATE TABLE event_sessions (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL,
  csrf_digest TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('guest', 'manager', 'host')),
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  access_token_id TEXT REFERENCES event_access_tokens(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES host_accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (role IN ('guest', 'manager')
      AND event_id IS NOT NULL AND access_token_id IS NOT NULL AND account_id IS NULL)
    OR
    (role = 'host'
      AND account_id IS NOT NULL AND event_id IS NULL AND access_token_id IS NULL)
  )
);

CREATE INDEX event_sessions_event_role ON event_sessions(event_id, role, revoked_at);
CREATE INDEX event_sessions_token ON event_sessions(access_token_id, revoked_at);
CREATE INDEX event_sessions_account ON event_sessions(account_id, revoked_at);

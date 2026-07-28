-- Host accounts give the host a durable identity, so losing the management link
-- stops being unrecoverable. The link survives as a delegate credential: a host
-- can still hand `/manage/<token>` to a planner who will never sign up.
--
-- `event_sessions` remains the event credential table. Account credentials live
-- in dedicated `host_sessions`, so adding host identity does not require
-- rebuilding the event table that `media` and `guest_messages` reference with
-- ON DELETE RESTRICT.

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
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
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

CREATE UNIQUE INDEX host_login_challenges_one_live
  ON host_login_challenges(account_id, purpose) WHERE consumed_at IS NULL;

-- Registration is an untrusted proposal until both the opaque browser secret and
-- the mailbox code are proved. In particular, this table has no account foreign
-- key: no durable identity exists yet.
CREATE TABLE host_registration_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  password_hash TEXT NOT NULL,
  display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80),
  browser_secret_digest TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  bind_event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  creator_session_id TEXT REFERENCES event_sessions(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  activation_nonce TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX host_registration_one_live_address
  ON host_registration_challenges(email) WHERE consumed_at IS NULL;

CREATE INDEX host_registration_expiry
  ON host_registration_challenges(expires_at, consumed_at);

CREATE TABLE host_auth_rate_limits (
  scope_digest TEXT NOT NULL,
  action TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  PRIMARY KEY (scope_digest, action, window_started_at)
);

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

CREATE UNIQUE INDEX event_hosts_one_owner
  ON event_hosts(event_id) WHERE role = 'owner';

-- The historical send ledger. It predates the outbox and is retained so an already
-- delivered message is not resent when this migration lands. Scheduling and delivery
-- now live in `host_notification_outbox` below; nothing writes to this table on the
-- dispatch path any more.
CREATE TABLE host_notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('getting_started', 'event_reminder', 'retention_warning')),
  sent_at TEXT NOT NULL
);

CREATE UNIQUE INDEX host_notifications_once
  ON host_notifications(account_id, event_id, kind);

-- Durable lifecycle work. Task 2 only schedules these rows; dispatch and lease
-- transitions are added in the notification task.
CREATE TABLE host_notification_outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('getting_started', 'event_reminder', 'retention_warning')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  available_at TEXT NOT NULL,
  retry_at TEXT NOT NULL,
  discard_after TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_at TEXT,
  claim_token TEXT,
  lease_expires_at TEXT,
  sent_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX host_notification_outbox_once
  ON host_notification_outbox(account_id, event_id, kind);

CREATE INDEX host_notification_outbox_due
  ON host_notification_outbox(status, retry_at, id);

CREATE TABLE host_sessions (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL,
  csrf_digest TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  auth_version INTEGER NOT NULL CHECK (auth_version >= 1),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX host_sessions_account
  ON host_sessions(account_id, revoked_at, expires_at);

-- Keep the event-session table in place: media and guest messages restrict-delete
-- against it. A creator session can later claim the ownership of its own event;
-- exchanged link sessions never receive that authority.
ALTER TABLE event_sessions
  ADD COLUMN can_claim_owner INTEGER NOT NULL DEFAULT 0 CHECK (can_claim_owner IN (0, 1));

-- Events created before host accounts existed are eligible for a one-time legacy
-- ownership claim. New rows retain the schema default of zero.
ALTER TABLE events
  ADD COLUMN legacy_owner_claim_open INTEGER NOT NULL DEFAULT 0 CHECK (legacy_owner_claim_open IN (0, 1));

UPDATE events SET legacy_owner_claim_open = 1;

-- First-visit guidance is account-scoped; an event or a link session cannot own it.
CREATE TABLE host_tours (
  account_id TEXT NOT NULL REFERENCES host_accounts(id) ON DELETE CASCADE,
  tour_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('dismissed', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, tour_key, version)
);

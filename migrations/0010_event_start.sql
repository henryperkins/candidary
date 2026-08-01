-- The event's own schedule, so one printed QR changes what it opens without a
-- host remembering to flip a checkbox on the morning of the event.
--
-- Two host intents that shared one boolean are separated into three concepts:
-- whether photo delivery is *permitted* (`uploads_enabled`, unchanged), when it
-- is *scheduled* to open (`event_start_at`), and whether the host *opened it
-- early* (`photos_open_from`).

-- An absolute instant, derived from the host's `event_date`, their local start
-- time, and `event_timezone`. NOT NULL with a constant default is available on
-- ADD COLUMN, so the column is genuinely non-nullable rather than policed by a
-- trigger.
ALTER TABLE events ADD COLUMN event_start_at TEXT NOT NULL
  DEFAULT '1970-01-01T00:00:00.000Z';
-- NULL means "open automatically at the event start". A non-null value holds
-- the server instant at which the host opened photo delivery early.
ALTER TABLE events ADD COLUMN photos_open_from TEXT;

-- An approximation, and deliberately not a harmless one. SQLite has no IANA
-- database, so this lands a legacy start at UTC midnight rather than local
-- midnight — up to roughly fourteen hours off. For an uploads-off event with an
-- active roster that is not a cosmetic error: guest RSVP routes would begin
-- refusing at the approximate start, potentially most of a day early or late.
--
-- Release therefore gates on a data-aware backfill that resolves every
-- inventoried event's start through its own IANA zone *before* the new Worker
-- is deployed. This migration must not be treated as safe on the strength of
-- the `photos_open_from` stamp below alone. See docs/deployment.md.
--
-- The untouched epoch default remains as an intermediate sentinel for the one
-- row this statement cannot reach: an event created by the *old* Worker after
-- the migration was applied. The new Worker recognizes that exact value and
-- keeps such a row on the pre-0010 lifecycle until the final scan corrects it.
UPDATE events SET event_start_at = event_date || 'T00:00:00.000Z';

-- Preserves every event currently showing `photos-primary`: with photo delivery
-- already on, an early-open stamp makes the approximate start irrelevant.
-- `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` reproduces the millisecond-precision
-- ISO form `toISOString()` writes everywhere else in this schema.
UPDATE events SET photos_open_from = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE uploads_enabled = 1;

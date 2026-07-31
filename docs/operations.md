# Operations runbook

## Scheduled lifecycle work

Two triggers share one handler and are selected by `controller.cron`.

The hourly `47 * * * *` handler delivers lifecycle email from the outbox. It is
independent of retention cleanup: neither can abort the other.

The daily `17 3 * * *` handler performs five idempotent jobs:

1. Sweep expired and consumed pending registrations, expired login challenges, and rate-limit buckets older than the enforcement window, in repeated bounded passes until each table is drained.
2. Sweep expired or revoked RSVP sessions and lookup rate windows older than one 15-minute bucket, in the same bounded 100-row passes capped at 50 per run. Both statements report counts only; neither can name a household, a guest, or a scope.
3. Delete objects for upload reservations older than fifteen minutes and release event counters.
4. Delete every manifest and numbered archive for exports past their 24-hour window, then mark those jobs expired.
5. Retire retention-due events. This selects rows that are already soft-deleted as well as rows that have reached `purge_after`, so a purge whose object deletion failed is retried instead of stranding objects. Each purge revokes every credential and disables the printed entry, sweeps the R2 event prefix, then deletes `media` and `guest_messages` before the event row — those two tables reference event sessions with `ON DELETE RESTRICT`, so the event cascade alone cannot remove a populated event. The final delete lets the remaining cascades clear the entry credential, households, invitees, receipts, RSVP sessions, and rate windows.

Re-running cleanup is safe because D1 transitions and R2 deletes are idempotent.

## Delivery and publication

A finalized `stored` media row is a private host delivery. Its `publication_status` is independently `unpublished`, `published`, or `hidden`; changing publication never changes private retention or export eligibility. Originals are never guest-readable. Cached previews use separate R2 keys and can be regenerated without changing the original.

One event permits 10,000 photos, 100 GiB of originals, and 20 MB per photo. Guests reserve metadata in ordered batches of 20 with one aggregate event-counter write, then transfer at most two files concurrently per device. Capacity failures are per-file; accepted siblings remain valid.

An expired PUT URL is refreshed against the same reservation. If cleanup or finalization already marked that reservation failed, retry reopens the same media row and reacquires quota before issuing a replacement URL. A transient confirmation failure resumes finalization without sending the original bytes again.

Closed gallery, delivery-history, and notes sections do not fetch their data or previews. The manager's visible Live intake refreshes event counts and private media every five seconds; polling pauses outside Intake and while the document is hidden.

## Export jobs

Only one queued or running export exists per event. A request snapshots every stored, non-deleted original at `snapshot_at`, regardless of publication. The Workflow partitions source payload at 2 GiB, streams numbered store-mode ZIP archives through multipart R2 upload, and creates `candidary-export-manifest.csv` covering every file and part.

Each retry increments `attempt`, uses a new attempt prefix, and clears prior persisted part rows. Partial attempt objects are deleted after a failure. Ready objects expire after 24 hours; manager download URLs expire after 15 minutes.

Investigate:

- `EXPORT_SOURCE_MISSING` as an R2/D1 consistency failure.
- `EXPORT_SNAPSHOT_CHANGED` as deletion or mutation inside a captured snapshot.
- `EXPORT_PART_LIMIT_EXCEEDED` as a configuration error because one accepted original is far below the 2 GiB part limit.

## RSVP and photo entry

One permanent credential is printed on the invitation. `GET /api/manage/events/:eventId/entry` returns
`{ eventLink, disabledAt }` and is the only way to redisplay it; the response is `no-store` because it
carries the credential in full.

Two host actions look similar and are not:

- **Sign out guest devices** (`POST .../guest-sessions/rotate`) replaces the internal guest grant.
  Every guest must rescan. The event link and every printed QR are byte-identical afterwards. Confirm
  by typing the exact event name.
- **Disable printed event QR** (`POST .../entry/disable`) is irreversible. It pauses RSVP and photo
  intake, revokes guest and household sessions, and makes every printed invitation and sign stop
  working. There is no replacement and no re-enable. Rehearse it only on a disposable event, and
  verify afterwards that manager access still works while both future scans and existing guest and
  household sessions do not.

RSVP opens only when the event has a deadline and the active roster passes collision and capacity
validation. The deadline is a calendar date in the event's IANA time zone; the server stores the final
millisecond of that local day. Shortening a deadline takes effect immediately for sessions already
issued; extending one requires each household to look itself up again before it regains write
authority. A host may correct any household after the deadline.

The first CSV import can commit only while RSVP is disabled and the event has no household rows,
active or archived. Every later change is an explicit manager edit. The contract, limits, and export
columns are in [rsvp-csv.md](rsvp-csv.md).

## Load harnesses

Both commands print a plan and make no network requests unless their explicit confirmation is set. A
live run writes real objects and rows, so use only a disposable rehearsal event and watch account
limits and cost.

```powershell
$env:CANDIDARY_LOAD_BASE_URL='https://staging.example.com'
$env:CANDIDARY_LOAD_EVENT_LINK='https://staging.example.com/join#REDACTED'
$env:CANDIDARY_LOAD_GUESTS='500'
$env:CANDIDARY_LOAD_PHOTOS='10000'
$env:CANDIDARY_LOAD_CONFIRM='I_UNDERSTAND'
npm run test:load:wedding
```

The photo harness creates separate guest sessions from the one durable entry link, reserves in batches
of 20, performs valid 64-byte PNG PUTs with two transfers per guest, and finalizes every object. It
intentionally leaves the data for host/export inspection; delete the disposable event afterward.

```powershell
$env:CANDIDARY_RSVP_BASE_URL='https://staging.example.com'
$env:CANDIDARY_RSVP_EVENT_ID='REDACTED'
$env:CANDIDARY_RSVP_EVENT_LINK='https://staging.example.com/join#REDACTED'
$env:CANDIDARY_RSVP_MANAGER_COOKIE='REDACTED'
$env:CANDIDARY_RSVP_MANAGER_CSRF='REDACTED'
$env:CANDIDARY_RSVP_CONFIRM='I_UNDERSTAND'
npm run test:load:rsvp
```

The RSVP harness imports a 500-capacity roster (250 households of one named guest and one plus-one
slot), reconciles the fully pending summary against the server's own totals, then uses the same entry
link for exactly 20 lookup and submission attempts from the harness address and requires the
twenty-first to return a generic `429` with `Retry-After: 900`. It reconciles those 20 responses plus
the remaining pending capacity and prints latency percentiles and error counts by code — never a name,
a cookie, a token, or a URL.

This is not a 500-household concurrency test and must not be reported as one. Every request comes from
one address, which is the only way to exercise the durable per-IP boundary without weakening a
production abuse control. The 500-row import and D1 parameter bounds are proved by Worker integration
tests; a true distributed lookup test needs separately provisioned source addresses and its own
authorized rehearsal.

## Support signals

Ask for the response request ID and inspect Worker logs. Common expected codes:

- `TOKEN_REVOKED`, `SESSION_EXPIRED`, `EVENT_EXPIRED`, `EVENT_DELETED` — use a current link or confirm lifecycle state.
- `FILE_TYPE_UNSUPPORTED`, `FILE_TOO_LARGE` — a selected or stored object failed type/signature/20 MB validation.
- `EVENT_MEDIA_LIMIT`, `EVENT_STORAGE_LIMIT` — the 10,000-photo or 100-GiB event quota is full.
- `MEDIA_STATE_CONFLICT` — a conditional host action lost a race; refresh.
- `RESOURCE_FORBIDDEN` — a host action referred to a photo, note, cover, or export outside the current event.
- `OWNER_CLAIM_REQUIRED` — save an ownerless event from its original creator session before rotating its management link.
- `EVENT_ENTRY_UNAVAILABLE` — the printed entry is missing or was disabled. It cannot be replaced; the event needs a new event and a new printed code. This is also what a **Sign out guest devices** attempt returns once the entry has been disabled.
- `EVENT_EXPIRED` on a scan — the printed credential is valid but the event's internal guest grant has expired. The event's own guest window has ended; nothing about the QR is wrong. (`GUEST_LINK_UNAVAILABLE` is retired: the route that raised it was replaced by `GET /api/manage/events/:eventId/entry`, and no code path emits it any more.)
- `RSVP_UNAVAILABLE` — RSVP is disabled or paused for this event.
- `RSVP_CLOSED` — the earlier of the event deadline and the session's captured write deadline has passed. A prior response is still readable; a host may still correct it.
- `RSVP_SESSION_REQUIRED` — the household session is missing, expired, revoked, or archived. The guest looks the invitation up again.
- `RSVP_HOUSEHOLD_CONFLICT` — the version the write was built on is no longer current, and nothing was written. The response carries a message only, deliberately: the caller re-reads the household (`GET /api/event/:slug/rsvp/household`, or the manager household detail) and submits again against the current version. A host roster edit that changes who is in a household reports this too, rather than a validation failure.
- `RSVP_SUBMISSION_CONFLICT` — a previously successful idempotency key was reused with different content. Use a new key rather than editing the old payload.
- `RSVP_ROSTER_INVALID` — the roster cannot be opened or edited into this shape: a collision no second name can resolve, an active household with no named guest, a capacity limit, or a plus-one reduction that would remove an attending slot.
- `RSVP_IMPORT_CONFLICT` — the file, the roster version, or the event's emptiness changed since preview. Preview the same file again.
- `RATE_LIMITED` on a lookup — the edge budget (30/IP/minute, `Retry-After: 60`) or a D1 budget (20/event/IP or 8/event/name per 15 minutes, `Retry-After: 900`) is spent. The body is deliberately generic.
- `EXPORT_ALREADY_ACTIVE`, `EXPORT_EMPTY`, `EXPORT_FAILED` — inspect the active job and its persisted parts.

## Recovery boundaries

The application does not promise recovery for a lost management link, explicit deletion, or retention purge. There is also no recovery for a disabled printed entry or an archived household: both are irreversible in v1 and both are confirmed by typing the exact name before they run. Do not restore an object without its matching D1 lifecycle state. Preview generation can be retried safely; an unavailable preview does not mean the original failed delivery. Never copy an original into the preview key as a fallback: every served derivative must pass through the Images binding so original metadata is not exposed.

## Host notifications

Three lifecycle emails are scheduled as `host_notification_outbox` rows in the same D1 batch that commits a host's ownership of an event: a getting-started guide, a reminder the day before the event date, and a warning seven days before management access ends. Because the rows are written with the membership, a refused or rolled-back ownership claim can never leave mail scheduled that implies ownership.

The warning is keyed to `management_access_expires_at`, not `purge_after`. Management access ends 90 days after the event and photos are deleted at 120, so a warning keyed to deletion would reach the host a month after they could still act on it.

The hourly `47 * * * *` dispatcher reclaims leases older than ten minutes, claims at most 100 due rows in one conditional UPDATE under one random claim token, loads them with account and event data in one explicit-column join, then obtains a fresh conditional authorization immediately before each provider call. That authorization is the durable send permit: a row that opts out, becomes unverified or disabled, is deleted, or expires after page load is retired without a send. The ceiling is therefore 203 D1 statements per run, and 100 messages per run is inside the account's 1,000-per-day quota.

Row states are `pending → sending → sent`. A transient provider failure returns the row to `pending` with an incremented attempt count and a retry at 5 minutes, 1 hour, 6 hours, then 24 hours; the fifth failed attempt is terminal. A missed run does not erase eligibility because `available_at` is immutable and `retry_at` only moves forward. `discard_after` retires a reminder once its event has passed and a warning once its deadline has, rather than sending either late.

Rows whose account is disabled, unverified, or opted out are retired with a non-sensitive `last_error_code` and no send. A provider call already holding its authorization permit may finish if an opt-out commits just before the external invocation; every later row must obtain a new permit and is suppressed. Scheduled jobs use wall-clock execution time for both dispatch and cleanup, while recording the nominal schedule time separately in telemetry. Delivery is at least once: an isolate that dies between provider acceptance and the fenced success update will resend on the next run.

Investigate a growing count of `status = 'failed'` rows by `last_error_code`. `suppressed_by_preference`, `address_unverified`, `account_disabled`, `event_deleted`, and `obsolete` are ordinary; repeated provider codes are not.

## Email preferences

`GET /host/unsubscribe/:token` renders a confirmation form and changes nothing — inbox links are followed by scanners, prefetchers, and preview generators before a person reads them. The signed `POST` to the same URL performs the opt-out, which is what mail providers issue for one-click `List-Unsubscribe`. A signed-in host re-enables lifecycle email from the account page through the authenticated preferences endpoint.

Cloudflare Queues remain the next scaling step rather than part of this design. A durable D1 row would still be written first, because publishing a queue message cannot be atomic with the account and event transaction.

Sending is capped at 1,000 messages per day for the account. Outbound sends appear as **dropped** in the Email Routing summary even when delivered; use the Email Sending metrics instead. A hard-bounced address is added to Cloudflare's suppression list, after which its codes silently stop arriving — the management link is the remaining route for that host.

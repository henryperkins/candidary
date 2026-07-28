# Operations runbook

## Scheduled lifecycle work

Two triggers share one handler and are selected by `controller.cron`.

The hourly `47 * * * *` handler delivers lifecycle email from the outbox. It is
independent of retention cleanup: neither can abort the other.

The daily `17 3 * * *` handler performs four idempotent jobs:

1. Sweep expired and consumed pending registrations, expired login challenges, and rate-limit buckets older than the enforcement window, in repeated bounded passes until each table is drained.
2. Delete objects for upload reservations older than fifteen minutes and release event counters.
3. Delete every manifest and numbered archive for exports past their 24-hour window, then mark those jobs expired.
4. Mark retention-due events inaccessible, revoke tokens and sessions, and sweep their R2 event prefix.

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

## Wedding load harness

`npm run test:load:wedding` prints the default 500-guest/10,000-photo plan and makes no network requests. A live run writes real objects and rows, so use only a disposable rehearsal event and watch account limits and cost.

```powershell
$env:CANDIDARY_LOAD_BASE_URL='https://staging.example.com'
$env:CANDIDARY_LOAD_GUEST_LINK='https://staging.example.com/join/REDACTED'
$env:CANDIDARY_LOAD_GUESTS='500'
$env:CANDIDARY_LOAD_PHOTOS='10000'
$env:CANDIDARY_LOAD_CONFIRM='I_UNDERSTAND'
npm run test:load:wedding
```

The harness creates separate guest sessions, reserves in batches of 20, performs valid 64-byte PNG PUTs with two transfers per guest, and finalizes every object. It intentionally leaves the data for host/export inspection; delete the disposable event afterward.

## Support signals

Ask for the response request ID and inspect Worker logs. Common expected codes:

- `TOKEN_REVOKED`, `SESSION_EXPIRED`, `EVENT_EXPIRED`, `EVENT_DELETED` — use a current link or confirm lifecycle state.
- `FILE_TYPE_UNSUPPORTED`, `FILE_TOO_LARGE` — a selected or stored object failed type/signature/20 MB validation.
- `EVENT_MEDIA_LIMIT`, `EVENT_STORAGE_LIMIT` — the 10,000-photo or 100-GiB event quota is full.
- `MEDIA_STATE_CONFLICT` — a conditional host action lost a race; refresh.
- `EXPORT_ALREADY_ACTIVE`, `EXPORT_EMPTY`, `EXPORT_FAILED` — inspect the active job and its persisted parts.

## Recovery boundaries

The application does not promise recovery for a lost management link, explicit deletion, or retention purge. Do not restore an object without its matching D1 lifecycle state. Preview generation can be retried safely; an unavailable preview does not mean the original failed delivery. Never copy an original into the preview key as a fallback: every served derivative must pass through the Images binding so original metadata is not exposed.

## Host notifications

Three lifecycle emails are scheduled as `host_notification_outbox` rows in the same D1 batch that commits a host's ownership of an event: a getting-started guide, a reminder the day before the event date, and a warning seven days before management access ends. Because the rows are written with the membership, a refused or rolled-back ownership claim can never leave mail scheduled that implies ownership.

The warning is keyed to `management_access_expires_at`, not `purge_after`. Management access ends 90 days after the event and photos are deleted at 120, so a warning keyed to deletion would reach the host a month after they could still act on it.

The hourly `47 * * * *` dispatcher reclaims leases older than ten minutes, claims at most 100 due rows in one conditional UPDATE under one random claim token, loads them with account and event data in one explicit-column join, and writes each outcome back fenced by that token. The ceiling is therefore about 105 D1 statements per run, and 100 messages per run is inside the account's 1,000-per-day quota.

Row states are `pending → sending → sent`. A transient provider failure returns the row to `pending` with an incremented attempt count and a retry at 5 minutes, 1 hour, 6 hours, then 24 hours; the fifth failed attempt is terminal. A missed run does not erase eligibility because `available_at` is immutable and `retry_at` only moves forward. `discard_after` retires a reminder once its event has passed and a warning once its deadline has, rather than sending either late.

Rows whose account is disabled, unverified, or opted out are retired with a non-sensitive `last_error_code` and no send. A preference change after a page is materialized may still allow one in-flight message; every row materialized after the change is suppressed. Delivery is at least once: an isolate that dies between provider acceptance and the fenced success update will resend on the next run.

Investigate a growing count of `status = 'failed'` rows by `last_error_code`. `suppressed_by_preference`, `address_unverified`, `account_disabled`, `event_deleted`, and `obsolete` are ordinary; repeated provider codes are not.

## Email preferences

`GET /host/unsubscribe/:token` renders a confirmation form and changes nothing — inbox links are followed by scanners, prefetchers, and preview generators before a person reads them. The signed `POST` to the same URL performs the opt-out, which is what mail providers issue for one-click `List-Unsubscribe`. A signed-in host re-enables lifecycle email from the account page through the authenticated preferences endpoint.

Cloudflare Queues remain the next scaling step rather than part of this design. A durable D1 row would still be written first, because publishing a queue message cannot be atomic with the account and event transaction.

Sending is capped at 1,000 messages per day for the account. Outbound sends appear as **dropped** in the Email Routing summary even when delivered; use the Email Sending metrics instead. A hard-bounced address is added to Cloudflare's suppression list, after which its codes silently stop arriving — the management link is the remaining route for that host.

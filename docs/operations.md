# Operations runbook

## Scheduled lifecycle work

The daily `17 3 * * *` handler performs three idempotent jobs:

1. Delete objects for upload reservations older than fifteen minutes and release event counters.
2. Delete every manifest and numbered archive for exports past their 24-hour window, then mark those jobs expired.
3. Mark retention-due events inaccessible, revoke tokens and sessions, and sweep their R2 event prefix.

Re-running cleanup is safe because D1 transitions and R2 deletes are idempotent.

## Delivery and publication

A finalized `stored` media row is a private host delivery. Its `publication_status` is independently `unpublished`, `published`, or `hidden`; changing publication never changes private retention or export eligibility. Originals are never guest-readable. Cached previews use separate R2 keys and can be regenerated without changing the original.

One event permits 10,000 photos, 100 GiB of originals, and 20 MB per photo. Guests reserve metadata in ordered batches of 20 and transfer at most two files concurrently per device. Capacity failures are per-file; accepted siblings remain valid.

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

The application does not promise recovery for a lost management link, explicit deletion, or retention purge. Do not restore an object without its matching D1 lifecycle state. Preview generation can be retried safely; an unavailable preview does not mean the original failed delivery.

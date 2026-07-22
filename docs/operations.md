# Operations runbook

## Scheduled lifecycle work

The `17 3 * * *` handler performs three idempotent jobs:

1. Delete objects for upload reservations older than fifteen minutes and release their event counters.
2. Delete ready export objects after their 24-hour window and mark those jobs expired.
3. Mark retention-due events inaccessible, revoke every token/session, and sweep their R2 event prefix.

Run the scheduled handler locally with Wrangler when validating cleanup changes. Re-running cleanup is safe because row transitions and R2 deletes are idempotent.

## Export jobs

Only one queued or running export may exist per event. The request captures approved media IDs/count/bytes at `snapshot_at`. The Workflow reads those originals in deterministic order, streams a store-mode ZIP, adds `media.csv`, and uploads in 5 MiB multipart R2 parts. Each retry increments `attempt` and uses an attempt-specific key. Partial uploads abort on failure.

Investigate `EXPORT_SOURCE_MISSING` as an object/record consistency issue and `EXPORT_SNAPSHOT_CHANGED` as unexpected mutation of already-approved snapshot rows. A host can retry failed or expired jobs. Ready objects expire after 24 hours; manager download URLs expire after 15 minutes.

## Quota and support signals

Stable API codes are the primary support key. Ask for the response request ID and inspect Worker logs around it. Common expected codes:

- `TOKEN_REVOKED`, `SESSION_EXPIRED`, `EVENT_EXPIRED`, `EVENT_DELETED` — use a current link or confirm lifecycle state.
- `FILE_TYPE_UNSUPPORTED`, `FILE_TOO_LARGE` — the client-selected or stored object failed validation.
- `EVENT_MEDIA_LIMIT`, `EVENT_STORAGE_LIMIT` — the fixed 50-photo or 300 MB event quota was reached.
- `MEDIA_STATE_CONFLICT` — another manager action won a conditional transition; refresh.
- `EXPORT_ALREADY_ACTIVE`, `EXPORT_EMPTY`, `EXPORT_FAILED` — inspect the active job or approve originals first.

## Recovery boundaries

The MVP does not promise recovery for a lost management link, explicit deletion, or retention purge. Do not restore individual objects without their matching D1 lifecycle state. A failed cover upload does not roll back event creation and can be retried from an authenticated manager session.

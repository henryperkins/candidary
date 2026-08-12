# Task 3 report: bounded idempotent creation and permanent deletion

## Status

Implemented and locally verified in the isolated worktree on
`codex/curated-private-guestbook`.

Implementation commit: `799e2b8` (`Implement bounded guestbook note writes`)

No push, deployment, remote migration, or other remote-state mutation was
performed.

## Files

- Created `worker/security/guest-message.ts`.
- Modified `worker/db/messages.ts`.
- Modified `worker/routes/messages.ts`.
- Modified `worker/workflows/cleanup.ts`.
- Modified `tests/worker/helpers.ts`.
- Modified `tests/worker/messages-api.test.ts`.
- Modified `tests/worker/cleanup.test.ts`.
- Modified `tests/unit/security.test.ts`.
- `worker/http/client-ip.ts` was inspected but did not require a change: its
  existing helper already accepts only `CF-Connecting-IP`, ignores forwarding
  fallbacks, and uses a shared fail-closed `unknown` scope when absent.

## RED evidence

Baseline before Task 3 tests:

- Worker focus: 106 passed.
- Unit security: 7 passed.

Behavior clusters were written and run before their production implementation:

1. Persisted-data HMACs: 2 failed, 7 passed. Payload/session/IP helpers threw
   their explicit not-implemented errors.
2. Edge boundary and replay accounting: 2 failed, 11 skipped. Invalid JSON was
   parsed and returned 422 instead of edge 429; initial creation stored zero
   durable rate rows instead of one.
3. Required normalized bounds: 1 failed, 13 skipped. A missing idempotency key
   was accepted with 201 instead of 422.
4. Durable fixed windows: 2 failed, 14 skipped. The sixth session note and the
   121st trusted-IP note after re-entry were both accepted with 201.
5. Phase ownership/race: 2 failed, 16 skipped. A genuinely new note after pause
   and a pause winning immediately before the D1 batch were both accepted.
6. Retained event cap: 1 failed, 18 skipped. The 1,001st retained note was
   accepted even though half the existing rows were soft-deleted.
7. State actions: 1 failed, 19 skipped. A stale note action returned the legacy
   `MEDIA_STATE_CONFLICT` instead of `MESSAGE_STATE_CONFLICT`.
8. Purge/tombstones: 2 failed, 20 skipped after correcting the trigger fixture.
   Both purge requests returned 422 because purge was not implemented.
9. Cleanup: 1 failed, 94 skipped. All 119 rate rows older than a full window
   remained.

## GREEN evidence

- HMAC cluster: 9 passed.
- Edge/replay cluster: 2 passed, 11 skipped.
- Validation cluster: 1 passed, 13 skipped.
- Durable session/IP/fixed-window cluster: 2 passed, 14 skipped.
- Phase and SQL-race cluster: 2 passed, 16 skipped.
- Retained-cap cluster: 1 passed, 18 skipped.
- State-action cluster: 1 passed, 19 skipped.
- Purge/tombstone/rollback cluster: 2 passed, 20 skipped.
- Bounded cleanup cluster: 1 passed, 94 skipped.

Fresh final gates:

- `npx vitest run --config vitest.worker.config.ts tests/worker/messages-api.test.ts tests/worker/cleanup.test.ts`
  - 2 files passed, 117 tests passed.
- `npx vitest run --config vitest.config.ts tests/unit/security.test.ts`
  - 1 file passed, 9 tests passed.
- Task 2 Worker regression, `tests/worker/guestbook-repository.test.ts`
  - 1 file passed, 6 tests passed.
- Task 2 unit regressions, `guestbook-contracts`, `guestbook-cursor`, and `errors`
  - 3 files passed, 10 tests passed.
- Total focused and regression assertions: 142 passed, 0 failed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings.
- `git diff --check` and `git diff --cached --check`: passed.

## Implementation notes

- The coarse edge limiter runs after guest authorization and CSRF validation but
  before body parsing. Per approved Sections 11.1-11.2, it may refuse replays;
  replay exemptions apply only to the durable D1 counters. No idempotency
  preflight was added.
- Payload receipts use HMAC-SHA-256 over
  `guest-message-payload:v1:` plus the stable JSON tuple of already-normalized
  `[guestName, body]`. Session and trusted-IP rate scopes use separate domain
  labels and include the event ID.
- One D1 batch performs the guarded `INSERT ... SELECT ... ON CONFLICT DO
  NOTHING` and inserts its rate event only when `changes() = 1`. SQL owns phase,
  current moderation choice, session/IP counts, tombstone exclusion, and the
  retained-note cap.
- Post-batch discrimination is exact replay, changed replay, purge receipt,
  phase, durable quota, then event cap.
- Purge uses one state-guarded D1 batch. The receipt is content-free and is
  inserted only for a row with an idempotency key; the hard delete is guarded on
  receipt presence. A forced-delete trigger test proves batch rollback.
- Scheduled cleanup deletes stale rate events in 100-row pages with a 50-pass
  ceiling. Purge receipts are untouched until event purge.
- The Worker test environment uses a generated-`RateLimit`-compatible fixture
  because Miniflare does not instantiate the rate-limit binding. Production code
  continues to consume generated `Cloudflare.Env` through `AppEnv` only.

## Self-review and concerns

- Safe Task 2 serializers and cursor paths were not widened; no response exposes
  session IDs, idempotency keys, digests, or raw IPs.
- The rate-event table receives only event ID, domain-separated digests, fixed
  window, row ID, and timestamps; it receives no name, body, idempotency key, or
  raw IP.
- Exact and changed live-row replays, then exact and changed purge receipts, are
  discriminated before current phase/quota/cap failures.
- The retained cap counts all note rows, including soft-deleted legacy rows, and
  permanent deletion releases capacity by hard-deleting exactly one guarded row.
- Local Worker runs print Wrangler's existing missing-process-environment-secret
  warning even though the test-pool bindings are supplied; all asserted Worker
  and unit gates pass. The native edge service itself remains an external,
  eventually consistent Cloudflare behavior and is represented by the supported
  binding fixture; durable enforcement is independently exercised against D1.
- No unresolved implementation concern remains within Task 3 scope.

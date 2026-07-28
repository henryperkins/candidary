# Task 2 report — verify pending registration and close auth races

## Status and commit

Complete.

Implementation commit:

```text
0eef048 feat(auth): verify pending host registration
```

The report is committed separately after the implementation so the implementation
commit can be recorded exactly.

## Implementation

- Replaced immediate account creation with a pending-registration challenge that
  stores only a normalized proposal, keyed browser/code digests, optional event
  binding and exact creator-session ID, attempt state, expiry, and timestamps.
- Added the `candidary_registration` cookie with `HttpOnly`, `Secure`,
  `SameSite=Lax`, path `/`, and a 15-minute max age. Registration start and resend
  return the same generic `202` response; completion clears the cookie and mints
  the first host session only after mailbox proof.
- Added atomic, fixed-window auth rate reservations. Scope values are HMACed as
  `rate-limit:<action>:<scope-kind>:<normalized-value>` with `LOGIN_HMAC_KEY`,
  and the repository uses one UPSERT ending in `RETURNING attempts`.
- Enforced all specified 15-minute budgets: registration 10/IP and 3/email;
  registration resend 10/IP and 5/pending registration; login 20/IP and
  10/email; verification resend 10/IP and 5/account; password-reset request
  10/IP and 3/email. Missing `CF-Connecting-IP` consistently uses `unknown`.
- Added a sole-owner partial unique index and made owner activation transactional.
  Registration activation and signed-in adoption revalidate the exact live
  manager session inside the D1 batch, refuse pre-existing cohost membership,
  support the one still-open legacy claim, and close the legacy flag only after
  the durable owner row exists.
- Added the future-compatible notification outbox schema and
  `NotificationOutboxRepository.scheduleStatements()`. It returns exactly three
  idempotent lifecycle inserts, and each insert is gated by the owner membership
  created at the claim timestamp. No dispatch, lease-transition, or queue work
  was added.
- Made registration activation atomic across challenge consumption, account
  creation/selection, verification, owner claim, legacy closure, and all three
  outbox rows. Existing accounts keep their password hash, display name, and
  authentication version.
- Kept the Task 1 stale-login rehash compare-and-swap intact. Password reset now
  updates the password and authentication version and revokes prior host sessions
  in one D1 batch, with the revocation gated on the resulting version/hash.
- Made forgotten-password responses account-neutral: normalized lookup and both
  reservations happen for every request, the known-account issue/send operation
  is tracked through `executionCtx.waitUntil()` with internal error handling, and
  known and unknown addresses receive the same immediate `202` body.
- Normalized unknown, missing, expired, consumed, and otherwise unusable reset
  challenges to the same `400 LOGIN_CODE_INVALID` response.
- Extended daily cleanup with bounded batches for consumed/expired pending
  registrations, expired login challenges, and rate buckets strictly older than
  the active enforcement window.

## Interface notes

- `HostAuthService.completeRegistration` accepts the currently resolved creator
  session ID in addition to the token and code. This lets the service compare it
  to the exact session captured at registration start before the repository
  revalidates that same row inside the activation batch.
- `AccountsRepository.claimInitialOwnerAndSchedule` likewise accepts the exact
  creator session ID. The extra argument closes the gap that would exist if the
  repository trusted a previously resolved capability without rechecking its
  revocation, expiry, event, and role in the claim transaction.
- `worker/auth/service.ts` did not need another Task 2 change: Task 1 already
  introduced the guarded, versioned host-session insertion required by the
  concurrent-reset regression. The implementation exercised that existing
  boundary rather than duplicating it.
- `src/components/States.tsx` received only the exhaustive `RATE_LIMITED` error
  mapping required by the new shared error code. No registration, recovery, or
  frontend flow from Task 3 was implemented.

## TDD evidence

### RED — registration remained durable before mailbox proof

Command:

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/host-auth.test.ts
```

Before the implementation, three new registration assertions failed against
the immediate-account behavior. The old route returned:

```text
{ registered: true, boundEvent: true }
```

and immediately created an account and host cookie, rather than returning
`{ registrationPending: true }` with only the pending-registration cookie.

### RED — cleanup boundary

The new cleanup regression initially failed because the cleanup entry point did
not exist:

```text
cleanupAuthScratch is not a function
```

### RED — cohost promotion

The adversarial ownership regression initially observed:

```text
expected boundEvent false, got true
```

This caught a result-calculation bug that treated any event membership as a
successful owner claim. The result now requires `role === 'owner'`, and the SQL
refuses promotion when any membership already exists.

### GREEN — focused Task 2 matrix

Command:

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run \
  tests/worker/migration-0006.test.ts \
  tests/worker/host-auth.test.ts \
  tests/worker/repositories.test.ts \
  tests/worker/cleanup.test.ts
```

Result:

```text
Test Files  4 passed (4)
     Tests  71 passed (71)
```

The matrix covers pending durability, new/existing response parity, resend
replacement and budgets, five-attempt exhaustion, exact creator-session
revalidation, revoked/different-session refusal, cohost refusal, transaction
rollback on forced outbox failure, fixed-window rate reservations, outbox kinds,
legacy closure, reset races, neutral forgotten-password behavior, reset error
normalization, migration shape, and cleanup boundaries.

### GREEN — required focused command

Command:

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run \
  tests/worker/host-auth.test.ts tests/worker/repositories.test.ts
```

Result:

```text
Test Files  2 passed (2)
     Tests  67 passed (67)
```

## Full verification

Commands:

```bash
npm run typecheck
npm run lint
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm test
git diff --check
```

Results:

```text
typecheck: passed
lint: passed

test:unit
Test Files  11 passed (11)
     Tests  85 passed (85)

test:worker
Test Files  13 passed (13)
     Tests  129 passed (129)

diff check: passed
```

## Self-review

- Confirmed registration start creates no account, event host, or host session,
  and new/existing addresses have the same status, body, cookie name, and cookie
  attributes.
- Confirmed challenge attempts are spent atomically before digest comparison,
  live registration and login challenges are unique at the database layer, and
  resends atomically replace their code and reset their attempt counter.
- Confirmed rate reservations increment atomically under concurrency and every
  action uses both exact scopes and exact budgets.
- Confirmed creator authorization is not inferred from a different valid manager
  session: the persisted session ID must match, remain live, belong to the event,
  retain the manager role, and carry either creator claim authority or the open
  legacy path at transaction time.
- Confirmed owner uniqueness is enforced by a partial unique index, cohosts cannot
  be promoted by this path, and an existing owner is reported as a refusal.
- Confirmed all outbox inserts depend on the durable owner membership itself,
  never on `changes()` from an earlier statement. A trigger-forced outbox abort
  proves account creation, membership, legacy closure, challenge consumption, and
  all outbox writes roll back together.
- Confirmed password reset invalidates old sessions and rejects a login that
  authenticated at the old version but attempts to create its session afterward.
- Confirmed forgotten-password known/unknown responses are identical and the
  email operation is attached to the Worker lifetime through `waitUntil()`.
- Confirmed cleanup is bounded to 100 rows per scratch table and retains records
  exactly on the expiry/window boundary.
- Confirmed Task 3 recovery UI, Task 4 notification dispatch, Cloudflare Queues,
  and outbox lease transitions remain outside this change.

## Concerns

None.

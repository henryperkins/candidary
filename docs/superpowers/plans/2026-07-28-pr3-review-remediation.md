# PR 3 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every accepted PR 3 review finding without changing the
credential model or adding infrastructure, then commit and push the verified
patch to `claude/user-auth-host-50qbya`.

**Architecture:** Preserve the creator session in the browser, keep ownership
claims and manager-link rotation behind explicit database predicates, make
registration activation a nonce-guarded D1 compare-and-swap, expose the
existing registration flow at a resumable route, and authorize each claimed
notification from current database state immediately before delivery.

**Tech Stack:** TypeScript 6, Hono, React 19, React Router 7, Cloudflare
Workers and D1, Wrangler 4, Vitest Workers pool, Testing Library.

## Global Constraints

- Keep this a remediation patch: no Queues, Durable Objects, dependencies,
  credential redesign, or unrelated refactor.
- The connected Cloudflare account was checked read-only on 2026-07-28. It has
  one Candidary D1 database, `candidary-core`; the repository has no preview or
  staging D1 binding; and that database's `d1_migrations` table contains only
  0001–0005. Therefore add `activation_nonce` directly to unapplied migration
  0006, not a new 0007.
- Do not deploy or apply migration 0006 remotely.
- A post-0006 event's first durable owner can come only from its still-live
  creator session. Preserve the explicit legacy one-time claim for older
  events.
- Manager-link rotation must never destroy a still-usable ownership path, but
  it must remain available once an ownerless event is permanently link-only.
- Registration codes are superseded by resend, single-use, and may produce at
  most one successful completion even when requests share the same timestamp.
- Cleanup may delete consumed challenge rows without changing a committed
  activation result.
- A notification provider call already in flight may finish after opt-out. No
  later row in the claimed page may start delivery after the opt-out commits.
- Keep notification dispatch at 100 rows and no more than 203 D1 statements:
  three page statements plus authorization and outcome statements per row.
- Scheduled authorization and lifecycle decisions use wall-clock execution
  time. `scheduledTime` is telemetry only.
- Start every production change with a focused failing behavioral test.
- Preserve the original workspace's unrelated `package-lock.json` change.

---

### Task 1: Preserve creator ownership and make adoption idempotent

**Files:**

- Modify: `src/pages/CreatePage.tsx`
- Modify: `worker/db/accounts.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `worker/routes/host-auth.ts`
- Test: `tests/ui/app.test.tsx`
- Test: `tests/worker/manage-api.test.ts`
- Test: `tests/worker/host-auth.test.ts`

**Interfaces:**

- Produce:
  `AccountsRepository.getEventOwnershipState(eventId, now): Promise<{ hasOwner: boolean; claimStillPossible: boolean } | null>`
- Consume: `AccountsRepository.getEventHost(eventId, accountId)`
- Keep: `AccountsRepository.claimInitialOwnerAndSchedule(...)` as the
  authoritative committing claim check.

- [ ] **Step 1: Write failing creator-CTA and rotation regressions**

Add a UI assertion that the success card still displays and copies the bearer
manager URL, while the “Open event manager” link points to the internal route:

```ts
expect(screen.getByRole('link', { name: /open event manager/i }))
  .toHaveAttribute('href', `/manage/event/${eventId}`);
expect(screen.getByText(managerBearerUrl)).toBeInTheDocument();
```

Add route tests for these database-backed cases:

1. An ownerless event with a live, unrevoked `can_claim_owner = 1` manager
   session returns HTTP 409 / `OWNER_CLAIM_REQUIRED` before rotation. The old access
   token and creator session still resolve afterward.
2. The same event may rotate after the creator session expires when
   `legacy_owner_claim_open = 0`: expire the creator cookie, exchange the
   still-active bearer link into a fresh ineligible manager session, and use
   that session for the successful rotation request.
3. An owned event may rotate as before.
4. A legacy ownerless event with `legacy_owner_claim_open = 1` is blocked.
5. A cohost row without an owner does not count as durable ownership: while a
   live creator or legacy claim remains, rotation still returns 409 and leaves
   the existing credentials usable.

- [ ] **Step 2: Run the focused tests and observe the intended failures**

```bash
npm run test:unit -- tests/ui/app.test.tsx
npm run test:worker -- tests/worker/manage-api.test.ts
```

Expected: the CTA still uses the bearer URL and live-claim rotation is not
guarded.

- [ ] **Step 3: Preserve the creator session in the success CTA**

Change only the CTA destination:

```tsx
<Link to={`/manage/event/${created.event.id}`}>Open event manager</Link>
```

Do not change the copyable bearer link.

- [ ] **Step 4: Add the narrow ownerless-rotation predicate**

Implement `getEventOwnershipState` as one read whose values come from current
database state:

- `hasOwner` is true only for an `event_hosts.role = 'owner'` row.
- `claimStillPossible` is true when
  `events.legacy_owner_claim_open = 1`, or when a same-event manager
  `event_session` has `can_claim_owner = 1`, `revoked_at IS NULL`, and
  `expires_at > now`.
- Return `null` for an unknown event.

Before calling `LinkService.rotate`, have only the `role === 'manager'`
rotation branch read this state. Guest-link rotation does not affect ownership
eligibility and must remain unchanged. If `!hasOwner && claimStillPossible`,
throw
`OWNER_CLAIM_REQUIRED` with status 409 and guidance that the event must be saved
from its original creator session first. Perform no token/session mutation in
that branch. Otherwise rotate normally.

- [ ] **Step 5: Write failing owner/cohost adoption regressions**

In `host-auth.test.ts`, cover:

- an existing owner with only a host cookie receives 200 and
  `{ adopted: true, existing: true }`;
- an existing cohost with only a host cookie receives the same idempotent
  success, and remains `cohost`;
- a non-member without the same-event creator or legacy manager cookie remains
  403;
- an event owned by another account remains 409 when the caller does present a
  manager cookie.

- [ ] **Step 6: Run the adoption regressions and observe the intended failures**

```bash
npm run test:worker -- tests/worker/host-auth.test.ts
```

Expected: an existing owner/cohost without an event-manager cookie receives
403.

- [ ] **Step 7: Put exact membership before link authentication**

After host authentication, call `getEventHost(eventId, accountId)`. Return
idempotent success for either existing role before reading the event-manager
cookie. Do not call the claim method and do not promote a cohost.

For a non-member, preserve the current manager-cookie validation and then call
`claimInitialOwnerAndSchedule`. Keep its `claimed`, `owned_by_other`, and
`not_authorized` outcomes unchanged.

- [ ] **Step 8: Verify and commit Task 1**

```bash
npm run test:unit -- tests/ui/app.test.tsx
npm run test:worker -- tests/worker/manage-api.test.ts tests/worker/host-auth.test.ts
npm run typecheck
git diff --check
```

Commit only Task 1 files:

```bash
git commit -m "fix: preserve event ownership recovery"
```

---

### Task 2: Make registration activation atomic and resend resumable

**Files:**

- Modify: `migrations/0006_host_accounts.sql`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/accounts.ts`
- Modify: `worker/db/notification-outbox.ts`
- Modify: `worker/services/host-auth.ts`
- Modify: `worker/routes/host-auth.ts`
- Modify: `worker/http/cookies.ts`
- Test: `tests/worker/migration-0006.test.ts`
- Test: `tests/worker/repositories.test.ts`
- Test: `tests/worker/host-auth.test.ts`
- Test: `tests/worker/cleanup.test.ts`

**Interfaces:**

- Add: `PendingRegistrationRecord.activationNonce: string | null`
- Add to parsed registration token:
  `{ id: string; secret: string; token: SecretToken }`
- Change:
  `HostAuthService.resendRegistration(...): Promise<SecretToken>`
- Change:
  `setRegistrationCookie(context, token, maxAgeSeconds = 15 * 60)`
- Extend:
  `NotificationOutboxRepository.scheduleStatements(input, activationGuard?)`
  where the optional guard is
  `{ challengeId: string; activationNonce: string }`.

- [ ] **Step 1: Write failing migration and activation race tests**

Add `activation_nonce TEXT` to the expected challenge schema test, then add
repository/service regressions for:

1. Load a valid registration snapshot, replace its code via resend, and attempt
   completion with the stale snapshot: activation returns `null` and creates no
   account, membership, or outbox row.
2. Launch two completions from the same valid snapshot at an identical `now`:
   exactly one returns success.
3. Delete the consumed challenge immediately after a successful batch but
   before result construction: the committed activation still returns the
   durable account/membership result.
4. Force one guarded outbox statement to fail: the D1 batch rolls back,
   including `consumed_at` and `activation_nonce`.

Use a narrow test database wrapper or repository seam only where required to
place cleanup between batch completion and durable result loading. Do not add
production abstractions solely for tests.

Also exercise the superseded completion through the HTTP/service path for an
already-existing account. Assert `LOGIN_CODE_INVALID`, no new
`candidary_host` cookie, unchanged `host_sessions`, and no membership or
outbox write.

- [ ] **Step 2: Run the focused tests and observe the intended failures**

```bash
npm run test:worker -- tests/worker/migration-0006.test.ts tests/worker/repositories.test.ts tests/worker/host-auth.test.ts tests/worker/cleanup.test.ts
```

Expected: the schema lacks the nonce, stale snapshots can consume the replaced
row, and success still depends on re-reading scratch state.

- [ ] **Step 3: Add and map the activation nonce**

Add nullable `activation_nonce` to the original
`host_registration_challenges` table in migration 0006. Update the D1 row type,
mapping, and record type. Do not add or apply migration 0007 because the remote
precondition was verified before this edit.

- [ ] **Step 4: Turn activation into one nonce-guarded batch**

Generate `activationNonce = crypto.randomUUID()`. Make the first batch
statement:

```sql
UPDATE host_registration_challenges
SET consumed_at = ?, activation_nonce = ?, updated_at = ?
WHERE id = ?
  AND consumed_at IS NULL
  AND expires_at > ?
  AND browser_secret_digest = ?
  AND code_digest = ?
  AND NOT EXISTS (
    SELECT 1 FROM host_accounts
    WHERE email = host_registration_challenges.email
      AND disabled_at IS NOT NULL
  )
```

Guard every account insert/update, verification write, ownership insert,
legacy-claim close, and outbox insert in the same batch with an `EXISTS`
predicate matching that challenge ID and activation nonce. For outbox rows,
append the same optional guard inside `scheduleStatements`; keep non-activation
callers unchanged.

Inspect the first `D1Result` from `db.batch`. Return `null` unless its changed
row count is exactly one. Remove the post-batch challenge re-read. Load only
durable account and membership rows afterward to construct `{ account,
boundEvent }`.

- [ ] **Step 5: Write failing resend-cookie regressions**

Assert:

- a successful resend returns `Set-Cookie` with the exact same opaque cookie
  value and `Max-Age=900`;
- a rejected or rate-limited resend does not send a replacement registration
  cookie;
- the server still replaces the code digest/expiry.

- [ ] **Step 6: Run the resend regressions and observe the missing cookie**

```bash
npm run test:worker -- tests/worker/host-auth.test.ts
```

Expected: successful resend sends no renewed registration cookie.

- [ ] **Step 7: Reissue the same browser token after successful resend**

Have `parseRegistrationToken` retain its unchanged typed raw `SecretToken`.
Return it from `resendRegistration` only after the code replacement and email
work have succeeded. Accept an optional max age in `setRegistrationCookie` and
have the route call it with the returned token and 900 seconds. Do not mint a
new token or renew a failed resend.

- [ ] **Step 8: Verify and commit Task 2**

```bash
npm run test:worker -- tests/worker/migration-0006.test.ts tests/worker/repositories.test.ts tests/worker/host-auth.test.ts tests/worker/cleanup.test.ts
npm run typecheck
git diff --check
```

Commit only Task 2 files:

```bash
git commit -m "fix: fence registration activation"
```

---

### Task 3: Expose a resumable registration route

**Files:**

- Create: `src/pages/HostRegisterPage.tsx`
- Modify: `src/app/recovery.ts`
- Modify: `src/app/router.tsx`
- Modify: `src/components/EventAccountCard.tsx`
- Modify: `src/components/HostAccountPanel.tsx`
- Modify: `src/pages/CreatePage.tsx`
- Modify: `src/pages/HostLoginPage.tsx`
- Modify: `docs/security.md`
- Test: `tests/unit/recovery.test.ts`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**

- Produce:
  `hostRegisterHref(eventId?: string, returnTo?: string, pending?: boolean)`
- Add to `HostAccountPanel`:
  `onStarted?: () => void`
- Add to `HostAccountPanel`:
  `onRestarted?: () => void`
- Keep `onCompleted` and the server's `boundEvent` value as the only authority
  for claiming successful recovery.

- [ ] **Step 1: Write failing route, context, and resume tests**

Cover:

1. `/host/register` renders the account form.
2. The manager account card exposes “Create account” beside “Sign in”, and both
   URLs preserve the safe manager return path and event ID.
3. Unsafe `returnTo` values are rejected by the existing safe-return helper.
4. If `returnTo` names event A while `adopt` names event B, the helper and page
   discard the mismatched adoption target instead of binding event B.
5. Switching from sign-in to registration and back preserves the identical
   validated recovery context.
6. The validated `adopt` target is passed as `HostAccountPanel.bindEventId`,
   and the registration-start POST contains that exact event ID.
7. A successful registration start invokes `onStarted`, changes the same route
   to `pending=1`, and a remount/reload starts at code entry.
8. “Start over” clears notices/errors, removes `pending=1`, returns to the
   account form, and a later remount/reload stays on that form.
9. The create-success surface uses the same pending transition.
10. Creation success and registration both disclose the 12-hour creator
   ownership window.

- [ ] **Step 2: Run focused UI tests and observe the intended failures**

```bash
npm run test:unit -- tests/unit/recovery.test.ts tests/ui/app.test.tsx
```

Expected: there is no addressable registration route, no manager registration
link, and code entry cannot be recovered after remount.

- [ ] **Step 3: Add the registration URL and page**

Add `hostRegisterHref` alongside the existing sign-in recovery helpers. Encode
only validated navigation context and an optional `pending=1` hint.

Register `/host/register` in the router. The page:

- validates `returnTo` and `adopt` using the existing recovery helpers;
- passes the validated adoption target to `HostAccountPanel.bindEventId`;
- chooses `initialStage="code"` only when `pending=1`;
- passes `onStarted` that replaces/navigates to the same safe URL with
  `pending=1`;
- after completion, navigates using the safe context and reports event
  attachment only when `boundEvent` is true.

The query string is a presentation hint, not proof; cookie/database validation
remains on the server.

- [ ] **Step 4: Add local Start over behavior**

Add optional `onStarted` and invoke it only after start registration succeeds.
In the code stage, expose “Start over” that resets the component to the form,
clears transient errors/notices, and calls optional `onRestarted`. The
registration page uses that callback to replace the URL without `pending=1`,
so reload does not revive stale code entry. Do not consume or mutate server
state.

Keep hooks unconditional and keep URL-derived state in the route rather than
copying it through new global state.

- [ ] **Step 5: Connect existing entry surfaces and disclose the window**

- Add “Create account” to `EventAccountCard` next to “Sign in.”
- Add reciprocal sign-in/register navigation where the host auth pages already
  cross-link, preserving safe recovery context.
- Have `CreatePage` use `onStarted` to move registration into the addressable
  pending state.
- State plainly on creation success and registration UI that the creator
  session's ownership eligibility ends at the earlier of the management
  deadline and 12 hours after creation.
- Record the same rule in `docs/security.md`.

- [ ] **Step 6: Verify and commit Task 3**

```bash
npm run test:unit -- tests/unit/recovery.test.ts tests/ui/app.test.tsx
npm run typecheck
npm run lint
git diff --check
```

Commit only Task 3 files:

```bash
git commit -m "feat: make host registration resumable"
```

---

### Task 4: Fence notification delivery and use execution time

**Files:**

- Modify: `worker/db/notification-outbox.ts`
- Modify: `worker/services/notifications.ts`
- Modify: `worker/index.ts`
- Modify: `docs/operations.md`
- Test: `tests/worker/notifications.test.ts`
- Test: `tests/worker/cleanup.test.ts`

**Interfaces:**

- Produce:
  `NotificationOutboxRepository.authorizeClaimedDelivery(id, claimToken, now)`
- Return one of:
  `{ status: 'authorized' }`,
  `{ status: 'retired'; reason: string }`, or `null` for a lost/expired claim.
- Change:
  `NotificationService.dispatchPending(now?, limit?)` so `now` remains useful
  for deterministic claim-page tests, but each row obtains a fresh wall clock
  immediately before live authorization.
- Define the successful authorization CAS as the durable send permit and the
  linearization point at which that row begins sending. A provider call holding
  a permit may finish if opt-out commits in the small interval before the
  external invocation; every later row must obtain a new permit and be
  suppressed. Do not add cross-system locking to close that interval.

- [ ] **Step 1: Write failing live-authorization tests**

Use two claimed rows and a controlled email sender:

1. During the first provider call, commit
   `notifications_enabled = 0`.
2. Assert the first call may finish but no second provider call starts.
3. Assert the second row becomes `failed` exactly once with
   `last_error_code = 'suppressed_by_preference'`.
4. Assert its `claim_token`, `claimed_at`, and `lease_expires_at` are all null.
5. Separately assert an expired/reclaimed claim produces no provider call.

Add a deadline test whose first send advances the clock past the second row's
`discard_after`; the second row must be retired as `obsolete`.

Add a controlled gap test that commits opt-out after the second row's
authorization CAS but immediately before its provider invocation. That
permitted call may finish, while a following row receives no permit and never
calls the provider. This makes the linearization boundary explicit.

- [ ] **Step 2: Run the focused notification tests and observe the stale-page failure**

```bash
npm run test:worker -- tests/worker/notifications.test.ts
```

Expected: both rows use the eligibility snapshot and timestamp loaded at page
claim time.

- [ ] **Step 3: Implement the single-statement authorization fence**

Implement one `UPDATE ... RETURNING`, matching:

```sql
WHERE id = ?
  AND status = 'sending'
  AND claim_token = ?
  AND lease_expires_at > ?
```

Compute suppression precedence in SQL:

1. `account_disabled`
2. `address_unverified`
3. `suppressed_by_preference`
4. `event_deleted`
5. `obsolete`

Use the same predicate in `CASE` expressions across all delivery fields:

- suppressed: set `status = 'failed'`, set `last_error_code`, clear
  `claim_token`, `claimed_at`, and `lease_expires_at`, and set `updated_at`;
- eligible: leave `status = 'sending'` and every claim field unchanged so
  `markSent`/`retryOrFail` can still match.

Return enough from `RETURNING` to distinguish authorized from retired. No row
means the claim/lease was lost and grants no permission.

- [ ] **Step 4: Authorize immediately before every provider call**

Remove the service-level `suppressionReason` function and its cached-row branch.
For every claimed row:

```ts
const authorized = await outbox.authorizeClaimedDelivery(
  row.id,
  claimToken,
  new Date().toISOString(),
);
```

- `authorized` proceeds to build and send.
- `retired` increments the retired count once and continues.
- `null` skips silently because another worker owns the outcome.

Use a fresh outcome timestamp for `markSent`/`retryOrFail` as well. Preserve
the 100-row limit and the 203-statement bound.

- [ ] **Step 5: Write the delayed-cron regression**

Invoke the scheduled handler with an old `controller.scheduledTime` while
controlling current wall time. Assert both notification dispatch and cleanup
receive wall-clock execution time, not nominal schedule time, and that logs
distinguish `scheduledAt` from `executedAt`.

For notification dispatch, seed a row whose `discard_after` falls between the
nominal schedule and fake wall-clock execution times, await the real scheduled
handler, and assert no provider call plus one `obsolete` retirement with
cleared claim metadata. Exercise the cleanup cron branch separately with data
whose lifecycle boundary also falls between those two times and assert the
wall-clock-eligible cleanup occurs.

- [ ] **Step 6: Run the delayed-cron regressions and observe stale decisions**

```bash
npm run test:worker -- tests/worker/notifications.test.ts tests/worker/cleanup.test.ts
```

Expected: the scheduled handler authorizes and cleans up using the older
nominal schedule time.

- [ ] **Step 7: Switch scheduled work to execution time and update docs**

In `worker/index.ts`, create `executedAt = new Date()` in the scheduled
handler and pass it to dispatch and cleanup. Retain
`new Date(controller.scheduledTime)` only as `scheduledAt` in structured
telemetry. Rewrite the comment that currently defends scheduled time and the
matching section in `docs/operations.md`.

- [ ] **Step 8: Verify and commit Task 4**

```bash
npm run test:worker -- tests/worker/notifications.test.ts tests/worker/cleanup.test.ts
npm run typecheck
git diff --check
```

Commit only Task 4 files:

```bash
git commit -m "fix: authorize notifications at send time"
```

---

### Task 5: Whole-branch review, verification, and publication

**Files:**

- Modify only if a review or verification failure requires a scoped fix.

- [ ] **Step 1: Review the complete branch against the approved design**

Review all commits from `origin/main...HEAD` for security, race behavior,
error contracts, statement bounds, React behavior, and missing regressions.
Resolve every actionable finding with another red-green cycle.

- [ ] **Step 2: Run the full verification gate**

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run cf-typegen -- --check
git diff --check
git status --short
```

If `wrangler types --check` is unsupported by the installed version, generate
to a temporary file and compare it to the tracked binding file without
modifying tracked output.

- [ ] **Step 3: Verify a current-main synthetic merge**

Fetch current `origin/main`, create a disposable detached worktree or merge
tree, and run at least typecheck plus both test suites against the synthetic
merge. Do not rewrite this branch merely to perform the check. If a real merge
conflict or regression exists, fix it in the feature worktree and repeat the
gate.

- [ ] **Step 4: Inspect final scope and publish**

Confirm:

- only intended remediation, tests, and documentation changed;
- no secrets, generated caches, or local SDD artifacts are tracked;
- the original `/workspaces/candidary` worktree and its unrelated
  `package-lock.json` change are untouched;
- the local branch has the intended commit series and is ahead of its matching
  remote branch.

Push:

```bash
git push origin claude/user-auth-host-50qbya
```

Then confirm the remote branch SHA and PR #3 check state. Do not merge or
deploy.

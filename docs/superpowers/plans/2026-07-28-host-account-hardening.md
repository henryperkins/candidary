# Host Account Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pull request 3 safe to migrate onto the populated production
database and close its account, ownership, recovery, notification, and
deployment defects.

**Architecture:** Keep link sessions in the existing `event_sessions` table and
store account sessions separately. Create accounts only after a pending
registration proves mailbox control, version password authority, restrict link
adoption to the first owner, and send lifecycle mail from a bounded D1 outbox.

**Tech Stack:** TypeScript 6, Hono, React 19, Cloudflare Workers, D1, Email
Service, Wrangler 4, Vitest Workers pool, Testing Library.

## Global Constraints

- Production currently has migrations 0001–0005, 8 events, and 24 event
  sessions; migration 0006 must preserve every row and foreign key.
- Do not deploy or apply migration 0006 to production in this branch task.
- No account, membership, or host session exists before mailbox-code proof.
- Registration start remains enumeration-safe for new and existing addresses.
- Only an event's creator session may create its first durable owner; exchanged
  management-link sessions are delegates and cannot claim ownership.
- Notification dispatch is bounded to 100 rows and about 105 D1 statements
  per scheduled run.
- GET requests are read-only.
- Use failing behavioral tests before every production change.
- Do not add a Cloudflare Queue resource in this PR.

---

### Task 1: Preserve event sessions and add versioned host sessions

**Files:**

- Modify: `migrations/0006_host_accounts.sql`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/sessions.ts`
- Modify: `worker/auth/service.ts`
- Modify: `worker/env.ts`
- Test: `tests/worker/migration-0006.test.ts`
- Test: `tests/worker/host-auth.test.ts`

**Interfaces:**

- Produces: `HostSessionRecord`
- Produces: `HostSessionsRepository.create(input)`
- Produces: `HostSessionsRepository.createIfAuthVersion(input): Promise<HostSessionRecord | null>`
- Produces: `HostSessionsRepository.getById(id)`
- Produces: `HostSessionsRepository.revoke(id, revokedAt)`
- Produces: `HostSessionsRepository.revokeForAccount(accountId, revokedAt)`
- Consumes: `host_accounts.auth_version`
- Produces: `SessionRecord.canClaimOwner`

- [ ] **Step 1: Turn the populated migration test into a normal regression test**

Add a `guest_messages` fixture as well as the existing media fixture, remove
`.fails`, apply 0006, and assert all three parent/child rows survive:

```ts
it('applies 0006 without rebuilding populated event sessions', async () => {
  // Apply 0001–0005 and insert an event, link session, media, and guest message.
  await applyD1Migrations(env.DB, [only('0006')]);
  expect(await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM event_sessions WHERE id = 'session-1'",
  ).first('count')).toBe(1);
  expect(await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM media WHERE uploader_session_id = 'session-1'",
  ).first('count')).toBe(1);
  expect(await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM guest_messages WHERE guest_session_id = 'session-1'",
  ).first('count')).toBe(1);
});
```

- [ ] **Step 2: Run the migration test and verify the current DROP fails**

Run:

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/migration-0006.test.ts
```

Expected: failure with `SQLITE_CONSTRAINT_FOREIGNKEY`.

- [ ] **Step 3: Replace the `event_sessions` rebuild**

Leave `event_sessions` and both existing indexes untouched. Add:

```sql
ALTER TABLE host_accounts
  ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1);

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
```

Fold `auth_version` into the original `CREATE TABLE host_accounts` rather than
using the shown `ALTER TABLE`, because migration 0006 has never been applied.
Add `event_sessions.can_claim_owner INTEGER NOT NULL DEFAULT 0`, backfill only
the earliest manager session for each event, and add a boolean CHECK. New
creator sessions write 1; link exchanges write 0.

- [ ] **Step 4: Split account-session persistence from event sessions**

Keep `SessionsRepository` event-only. Add `HostSessionsRepository` with exact
row mapping and an authenticated insert:

```sql
INSERT INTO host_sessions (
  id, secret_digest, csrf_digest, account_id, auth_version, expires_at, created_at
)
SELECT ?, ?, ?, id, auth_version, ?, ?
FROM host_accounts
WHERE id = ? AND auth_version = ? AND disabled_at IS NULL
```

Return `null` when the insert changes no row.

- [ ] **Step 5: Resolve host cookies through `host_sessions`**

`AuthService.resolve()` remains event-only. `resolveHostSession()` parses and
verifies a host-session token directly, rejects expiry/revocation, loads the
account, and rejects an authentication-version mismatch.

`createHostSession(accountId, authVersion)` calls
`createIfAuthVersion`; an empty insert becomes
`LOGIN_CREDENTIALS_INVALID`.

- [ ] **Step 6: Run focused tests**

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/migration-0006.test.ts tests/worker/host-auth.test.ts
```

Expected: migration regression and existing session tests pass.

### Task 2: Verify pending registration and close auth races

**Files:**

- Modify: `migrations/0006_host_accounts.sql`
- Modify: `shared/contracts.ts`
- Modify: `shared/errors.ts`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/accounts.ts`
- Create: `worker/db/auth-rate-limits.ts`
- Modify: `worker/services/host-auth.ts`
- Modify: `worker/routes/host-auth.ts`
- Modify: `worker/http/cookies.ts`
- Modify: `worker/auth/service.ts`
- Modify: `worker/workflows/cleanup.ts`
- Test: `tests/worker/host-auth.test.ts`
- Test: `tests/worker/repositories.test.ts`

**Interfaces:**

- Produces: `PendingRegistrationRecord`
- Produces: `HostAuthService.startRegistration(input, requestScope)`
- Produces: `HostAuthService.completeRegistration(rawToken, code)`
- Produces: `AccountsRepository.activateRegistration(pending, now)`
- Produces: `AccountsRepository.claimInitialOwnerAndSchedule(eventId, accountId, createdAt): Promise<'claimed' | 'existing' | 'owned_by_other'>`
- Produces: `AccountsRepository.resetPasswordAndAdvanceVersion(...)`
- Produces: `AuthRateLimitsRepository.reserve(input): Promise<boolean>`

- [ ] **Step 1: Write failing registration-state tests**

Cover these externally observable breaks:

```ts
it('creates no account, owner, or host session before mailbox proof', async () => {
  const started = await register('host@example.com', { bindEventId }, managerHeaders);
  expect(started.status).toBe(202);
  expect(await count('host_accounts')).toBe(0);
  expect(await count('event_hosts')).toBe(0);
  expect(await count('host_sessions')).toBe(0);
});

it('completes a pending registration and reports the true owner claim', async () => {
  const pending = registrationCookiesFrom(await register(...));
  const code = await forceRegistrationCode('host@example.com');
  const completed = await post('/api/host/register/complete', { code }, pending.headers);
  expect(await completed.json()).toMatchObject({ data: { boundEvent: true } });
});
```

Also assert new and existing addresses return the same status, body keys, and
registration-cookie names.

- [ ] **Step 2: Run the focused test and verify it fails against immediate account creation**

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/host-auth.test.ts
```

Expected: the pre-verification account/session assertions fail.

- [ ] **Step 3: Add pending-registration and rate-limit tables**

`host_registration_challenges` stores the normalized email, password hash,
optional display name, browser-secret digest, code digest, optional event ID,
the creator session ID authorizing that claim, attempts, expiry, consumption,
and timestamps. Add `host_notification_outbox` here as well so activation and
membership can schedule durable mail in the same transaction.

`host_auth_rate_limits` uses:

```sql
CREATE TABLE host_auth_rate_limits (
  scope_digest TEXT NOT NULL,
  action TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  PRIMARY KEY (scope_digest, action, window_started_at)
);
```

The reservation statement is one UPSERT ending in `RETURNING attempts`.

- [ ] **Step 4: Add registration-cookie helpers**

Create `candidary_registration`, `HttpOnly`, `Secure`, `SameSite=Lax`,
path `/`, and 15-minute max age. It carries the same `id.secret` shape used by
session tokens and is cleared after completion.

- [ ] **Step 5: Implement start and completion**

Start:

1. reserve the IP and email scopes;
2. hash the password;
3. verify any requested creator-session binding and retain its session ID;
4. replace the pending challenge;
5. send one generic confirmation code;
6. return the generic 202 response and registration cookie.

Completion:

1. verify browser token, code attempt, expiry, and single use;
2. re-resolve the same live creator session for any pending event claim;
3. call `activateRegistration`, which uses one D1 batch to create or verify the
   account, conditionally claim the owner, and insert lifecycle outbox rows only
   through committed membership;
4. create a host session at the account's current auth version;
5. clear the pending cookie;
6. return `{ registered: true, boundEvent }`.

- [ ] **Step 6: Write and fail the concurrent-reset login test**

Exercise the repository boundary deterministically:

```ts
const authenticated = await service.authenticate(email, oldPassword);
await accounts.resetPasswordAndAdvanceVersion(account.id, newHash, now);
const session = await auth.createHostSession(account.id, authenticated.authVersion);
await expect(session).rejects.toMatchObject({ code: 'LOGIN_CREDENTIALS_INVALID' });
```

- [ ] **Step 7: Implement versioned reset**

Use one D1 batch to increment `host_accounts.auth_version`, change the password,
verify the address, and revoke all `host_sessions`. Load the new version before
creating the reset response's replacement session.

Change opportunistic password rehash to:

```sql
UPDATE host_accounts SET password_hash = ?
WHERE id = ? AND password_hash = ? AND auth_version = ?
```

The login continues with the version it authenticated; session insertion is
the final authority check.

- [ ] **Step 8: Restrict adoption**

Add a partial unique index on `event_hosts(event_id) WHERE role = 'owner'`.
Implement `claimInitialOwnerAndSchedule` with one D1 batch. Make registration
completion and `/host/events/:eventId/adopt` require
`session.canClaimOwner === true` and report refusal when a different membership
already exists.

- [ ] **Step 9: Make forgotten-password responses timing-neutral**

Perform the normalized lookup and IP/email rate-limit reservations before the
response. Track challenge replacement and email delivery with:

```ts
context.executionCtx.waitUntil(issueResetCodeIfAccountExists(...));
```

Return the identical 202 response immediately for known and unknown addresses.
The tracked operation catches rate-limit and delivery errors internally and
never leaks account existence.

- [ ] **Step 10: Expire auth scratch state**

Extend daily cleanup to delete consumed/expired pending registrations, expired
login challenges, and rate-limit buckets older than their enforcement window.

- [ ] **Step 11: Run auth and repository tests**

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/host-auth.test.ts tests/worker/repositories.test.ts
```

Expected: all pending-registration, version, rate-limit, and ownership tests
pass.

### Task 3: Complete account attachment and recovery UX

**Files:**

- Modify: `worker/routes/public.ts`
- Modify: `worker/services/events.ts`
- Modify: `worker/auth/manager.ts`
- Modify: `src/pages/CreatePage.tsx`
- Modify: `src/components/HostAccountPanel.tsx`
- Modify: `src/components/EventAccountCard.tsx`
- Modify: `src/pages/HostLoginPage.tsx`
- Modify: `src/pages/HostEventsPage.tsx`
- Modify: `src/components/States.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Test: `tests/worker/core-journey.test.ts`
- Test: `tests/worker/host-auth.test.ts`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**

- Produces: event-create response field `savedToAccount: boolean`
- Consumes: registration-complete response field `boundEvent: boolean`
- Consumes: query fields `returnTo` and `adopt`

- [ ] **Step 1: Write failing Worker and UI tests**

Assert:

- signed-in event creation inserts one owner membership and returns
  `savedToAccount: true`;
- registration start leaves the lost-link warning intact;
- registration completion changes the copy only when `boundEvent` is true;
- the manager sign-in link contains the event and a same-origin return path;
- login calls adoption before navigating;
- an expired account-originated manager route offers a sign-in action.
- account lifecycle errors survive a failed management-link fallback.

- [ ] **Step 2: Run focused tests and confirm the current false-success flows fail**

```bash
npm run test:unit -- --run tests/ui/app.test.tsx
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/core-journey.test.ts tests/worker/host-auth.test.ts
```

- [ ] **Step 3: Attach signed-in creation server-side**

Resolve the optional host cookie in `POST /api/events`. Pass its account ID into
`EventService.create`; after the event is created, claim its initial owner and
return the result as `savedToAccount`.

- [ ] **Step 4: Make registration completion authoritative**

`HostAccountPanel` calls `/api/host/register/complete` from the code stage.
Rename `onRegistered` to:

```ts
onCompleted?: (result: { boundEvent: boolean }) => void;
```

Only a true binding calls `setSaved(true)`. Copy before completion says the
event still depends on its management link.

- [ ] **Step 5: Preserve login recovery context**

Generate:

```text
/host/login?returnTo=%2Fmanage%2Fevent%2F<id>&adopt=<id>
```

Accept only local paths matching `/host/events` or
`/manage/event/<uuid>`. After successful login, call adoption when `adopt`
matches the return event; navigate only after adoption succeeds.

- [ ] **Step 6: Offer sign-in from account-session failure**

Classify a dead host-only credential as `HOST_SESSION_REQUIRED`. Extend
`ErrorState` with an optional action link and have `ManagerPage` render
“Sign in” with the validated manager return path.

Preserve a specific account-side `EVENT_EXPIRED`, `EVENT_DELETED`, or
`ACCOUNT_DISABLED` failure while trying an independent management-link
credential; if that fallback also fails, rethrow the original lifecycle error
instead of flattening it to `ROLE_FORBIDDEN`.

- [ ] **Step 7: Run focused UI and Worker tests**

Use the commands from Step 2. Expected: all new attachment/recovery behaviors
pass.

### Task 4: Replace notification scans with a durable bounded outbox

**Files:**

- Modify: `migrations/0006_host_accounts.sql`
- Modify: `shared/contracts.ts`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/accounts.ts`
- Create: `worker/db/notification-outbox.ts`
- Modify: `worker/services/notifications.ts`
- Modify: `worker/services/host-auth.ts`
- Modify: `worker/services/events.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `worker/index.ts`
- Modify: `wrangler.jsonc`
- Test: `tests/worker/notifications.test.ts`
- Test: `tests/worker/cleanup.test.ts`

**Interfaces:**

- Produces: `NotificationOutboxRepository.scheduleEvent(account, event, now)`
- Produces: `NotificationOutboxRepository.listDue(now, limit)`
- Produces: `NotificationOutboxRepository.claim(id, now, staleBefore)`
- Produces: `NotificationOutboxRepository.markSent(id, now)`
- Produces: `NotificationOutboxRepository.retryOrFail(id, code, retryAt, maxAttempts)`
- Produces: `NotificationService.dispatchPending(now, limit = 100)`

- [ ] **Step 1: Write failing durability and isolation tests**

Use a deterministic email test double at the `EmailService` boundary and assert:

```ts
it('retains a failed getting-started message for retry', async () => {
  await scheduleGettingStarted();
  await dispatchWithFirstSendFailing();
  expect(await outboxState()).toMatchObject({ status: 'pending', attemptCount: 1 });
  await dispatchAgainAfterRetry();
  expect(await outboxState()).toMatchObject({ status: 'sent', attemptCount: 2 });
});

it('continues after one recipient fails', async () => {
  expect(await dispatchThreeWithMiddleFailure()).toMatchObject({ sent: 2, retried: 1 });
});
```

Also assert a missed due run remains eligible and `listDue` returns no more
than 100 rows.

- [ ] **Step 2: Run notification tests and verify the ledger implementation fails them**

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/notifications.test.ts tests/worker/cleanup.test.ts
```

- [ ] **Step 3: Implement the repository over `host_notification_outbox`**

The table created in Task 2 stores `status`, `attempt_count`, immutable
`available_at`, mutable `retry_at`, `discard_after`, `claimed_at`,
`claim_token`, `sent_at`, `last_error_code`, and `created_at`; it retains one
unique row per account, event, and kind with an index on
`(status, retry_at, id)`. Add the typed repository methods that operate on it.

- [ ] **Step 4: Schedule lifecycle rows**

Insert all three unique rows when a verified owner attaches to an event:

- getting started: `available_at = now`;
- reminder: one UTC calendar day before `event_date`;
- access warning: seven days before `management_access_expires_at`.

Do not calculate eligibility from a one-run SQL window.

- [ ] **Step 5: Implement an atomic bounded dispatcher**

Reclaim stale leases, then use one claim token and one
`UPDATE … WHERE id IN (SELECT … LIMIT 100)` to claim the page. Load account and
event fields in one explicit-column JOIN by claim token. For each row, render
from the joined data, catch the email result, and update with
`WHERE id = ? AND status = 'sending' AND claim_token = ?`.

Use retry delays of 5 minutes, 1 hour, 6 hours, and 24 hours, then mark the
fifth failed attempt `failed`.

Initialize `retry_at = available_at`. Set `discard_after` to the end of the
event date for reminders and the management deadline for warnings. Mark an
obsolete row terminal rather than sending it.

- [ ] **Step 6: Add an hourly notification trigger**

Add `"47 * * * *"` beside the existing `"17 3 * * *"` trigger. In
`worker/index.ts`, branch on `controller.cron`: hourly invokes
`dispatchPending`; daily invokes cleanup. Use `controller.scheduledTime` as the
operation time. Let dispatcher-level failure fail that Cron event; per-recipient
failures stay isolated in the outbox.

- [ ] **Step 7: Keep cleanup independent**

Remove notification delivery from `scheduledCleanup`; retention deletion no
longer shares its failure boundary. Add structured notification summary/error
logging without email addresses in the hourly handler.

- [ ] **Step 8: Run notification and cleanup tests**

Use the command from Step 2. Expected: durability, isolation, bound, and cleanup
tests pass.

### Task 5: Make unsubscribe, preferences, and logout intentional

**Files:**

- Modify: `worker/routes/host-public.ts`
- Modify: `src/pages/HostEventsPage.tsx`
- Test: `tests/worker/host-auth.test.ts`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**

- GET `/host/unsubscribe/:token`: confirmation only
- POST `/host/unsubscribe/:token`: signed preference mutation
- PATCH `/api/host/preferences`: existing authenticated mutation

- [ ] **Step 1: Write failing GET/POST and UI tests**

Assert a valid-token GET leaves `notifications_enabled = 1`, the signed POST
sets it to 0, the account toggle can set it back to 1, and a rejected logout
does not navigate.

- [ ] **Step 2: Run focused tests and verify current behavior fails**

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run test:worker -- --run tests/worker/host-auth.test.ts
npm run test:unit -- --run tests/ui/app.test.tsx
```

- [ ] **Step 3: Split unsubscribe confirmation and mutation**

Render a real POST form on GET. Keep the same signed endpoint in
`List-Unsubscribe`, so mail-provider one-click POST remains valid. Only POST
calls `setNotificationsEnabled`.

- [ ] **Step 4: Add account preference controls**

Render a labeled checkbox/button from `session.account.notificationsEnabled`.
PATCH the inverse value, update local account state only after success, and
show a retryable error on failure.

- [ ] **Step 5: Stop redirecting after failed logout**

Move `navigate('/host/login')` into the successful branch. Preserve the page,
session state, and error on rejection.

- [ ] **Step 6: Re-run focused tests**

Use the commands from Step 2. Expected: all preference and logout tests pass.

### Task 6: Enforce Cloudflare deployment requirements

**Files:**

- Modify: `wrangler.jsonc`
- Regenerate: `worker-configuration.d.ts`
- Modify: `docs/deployment.md`
- Modify: `docs/security.md`
- Modify: `docs/operations.md`
- Modify: `README.md`

**Interfaces:**

- Produces: Wrangler `secrets.required`
- Requires: `TOKEN_HMAC_KEY`, `SESSION_HMAC_KEY`,
  `GUEST_TOKEN_ENCRYPTION_KEY`, `LOGIN_HMAC_KEY`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`

- [ ] **Step 1: Add required secrets and the missing provisioning command**

```json
"secrets": {
  "required": [
    "TOKEN_HMAC_KEY",
    "SESSION_HMAC_KEY",
    "GUEST_TOKEN_ENCRYPTION_KEY",
    "LOGIN_HMAC_KEY",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY"
  ]
}
```

Add `npx wrangler secret put LOGIN_HMAC_KEY` to deployment instructions.

- [ ] **Step 2: Regenerate binding types**

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm run cf-typegen
XDG_CONFIG_HOME=/tmp/candidary-wrangler npx wrangler types --check
```

Expected: the generated origin and email sender match `wrangler.jsonc`, and all
six secrets appear as string bindings.

- [ ] **Step 3: Update operational documentation**

Document pending registration, initial-owner-only adoption, versioned session
revocation, outbox retry state, the 100-row dispatch bound, GET/POST
unsubscribe semantics, and the fact that Queues are a later scaling option.

### Task 7: Verify, review, and publish the branch

**Files:**

- Review all files changed from `f3253f2`
- Update PR branch: `claude/user-auth-host-50qbya`

- [ ] **Step 1: Run the complete local verification matrix**

```bash
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm test
npm run typecheck
npm run lint
npm run build
XDG_CONFIG_HOME=/tmp/candidary-wrangler npx wrangler types --check
XDG_CONFIG_HOME=/tmp/candidary-wrangler npx wrangler deploy --dry-run
npm run test:e2e
```

Record exact pass/fail counts. Treat an environment-only browser startup
failure separately from an application failure.

- [ ] **Step 2: Review the complete diff**

Check every invariant in the design spec against the final code and inspect:

```bash
git diff --check
git diff --stat f3253f2
git diff f3253f2 -- migrations worker src shared tests wrangler.jsonc docs README.md
```

- [ ] **Step 3: Provision the missing production secret**

After the branch has passed verification, use the Cloudflare API to add a new
random 32-byte `LOGIN_HMAC_KEY` to Worker `candidary`. Never print or persist
the value.

- [ ] **Step 4: Publish one intentional GitHub commit**

Create the commit from the exact verified tree and advance
`refs/heads/claude/user-auth-host-50qbya` only if it still points at
`f3253f23ab86a6e8fbae36eb2a8eb912aa95e392`. Do not merge PR 3 or deploy the
Worker.

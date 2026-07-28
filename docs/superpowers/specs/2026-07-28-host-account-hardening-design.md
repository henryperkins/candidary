# Host Account Hardening Design

**Scope:** Repair the production-breaking and security defects identified in
`henryperkins/candidary` pull request 3 without changing the guest contribution
model or deploying the feature before it is merged.

**Evidence boundary:** The production D1 database has migrations 0001–0005
applied, 8 events, and 24 event sessions. Migration 0006 has not been applied.
The deployed Worker has a daily `17 3 * * *` trigger and no Queue resource.

## Invariants

1. Applying migration 0006 must preserve every existing event session, media
   row, guest message, and foreign-key relationship.
2. An email address does not become an account and an event does not become
   recoverable until the six-digit code proves mailbox control.
3. Registration, recovery, and reset responses do not disclose whether an
   account already exists.
4. A password reset invalidates every authentication decision made against the
   previous password, including a login that started before the reset.
5. For events created after migration 0006, only the creator session may claim
   the first owner. Because pre-0006 data cannot distinguish a creator from a
   delegate, each legacy event gets one explicit first-owner claim through a
   live management credential; the successful claim closes that legacy path.
   No later link exchange may add another durable owner.
6. A notification remains retryable after a transient send failure or a missed
   scheduled run. One target cannot abort later targets.
7. A GET request never changes notification preferences.
8. Every scheduled notification run remains below Cloudflare D1's per-invocation
   query limit by construction.

## Chosen architecture

### Preserve `event_sessions`; add `host_sessions`

Migration 0006 will not drop or rebuild `event_sessions`. Guest and management
link sessions keep their current schema and foreign-key identity. Account
sessions move to a separate `host_sessions` table containing the account ID,
secret and CSRF digests, authentication version, expiry, revocation, and
timestamps.

This is safer than rebuilding `event_sessions`, `media`, and `guest_messages`
because it leaves all production rows and the schema changes from migrations
0002–0005 untouched. It also gives the two credential classes honest database
types instead of nullable columns and a compound CHECK constraint.

### Verify a pending registration before creating the account

`POST /api/host/register` will validate the request, reserve rate-limit capacity
before scrypt or email work, and create a short-lived
`host_registration_challenges` row. The row stores:

- a normalized email address;
- the proposed password hash and optional display name;
- a digest of an opaque browser registration token;
- a digest of the six-digit mailbox code;
- an event ID only when the request held that event's live management session;
- the exact creator-session ID that authorized any pending owner claim;
- attempt, expiry, consumption, and creation state.

The response is always the same 202 shape and sets the same opaque registration
cookie whether the email is new or already registered. No host session or event
membership is created.

`POST /api/host/register/complete` validates both the browser token and mailbox
code. It then creates a verified account or selects the existing account owned
by that mailbox, claims the event only if it has no different owner, creates a
host session, clears the registration cookie, and returns the authoritative
`boundEvent` result. For an existing account, the proposed password is ignored;
the verified code acts as a passwordless recovery for that request and never
overwrites the existing credential.

The create-success UI says that a code may be on its way, does not call the
event saved, and does not relax the lost-link warning until completion returns
`boundEvent: true`.

Pending registration has its own resend endpoint authenticated by the opaque
registration cookie. The standalone account-verification page retains the
existing host-session verification flow; it is not silently redirected through
registration completion.

### Rate-limit before expensive or external work

`host_auth_rate_limits` stores HMAC-digested scopes in fixed time buckets.
One atomic UPSERT increments and returns the count for each IP and
address/account scope. Registration, login, verification resend, and password
reset-code requests reserve their limits before scrypt or email work.

The limits are:

- registration start: 10 requests per IP and 3 per email in 15 minutes;
- registration resend: 10 per IP and 5 per pending registration in 15 minutes;
- login: 20 per IP and 10 per email in 15 minutes;
- existing-account verification resend: 10 per IP and 5 per account in
  15 minutes;
- password-reset request: 10 per IP and 3 per email in 15 minutes.

The IP scope is `CF-Connecting-IP`; a missing header uses one shared `unknown`
scope rather than trusting a client-supplied alternative. Scope digests use
`LOGIN_HMAC_KEY` with explicit domain separation:
`rate-limit:<action>:<scope-kind>:<normalized-value>`. Exhaustion returns the
same `429 RATE_LIMITED` response for new and existing addresses.

Challenge replacement uses one D1 batch so concurrent requests cannot both
leave live codes. Code attempts and consumption remain conditional single-row
updates.

Forgot-password performs the same lookup and rate-limit work for every address,
returns the generic 202 response, and tracks challenge creation/email with
`ExecutionContext.waitUntil()`. A known account therefore does not hold the
response open for database writes and an external mail send while an unknown
address returns immediately.

### Version password authority

`host_accounts.auth_version` starts at 1. Every host session records the
version authenticated. Session resolution requires the session and account
versions to match.

Login passes the version it verified to an `INSERT … SELECT` that creates the
session only if the account still has that version. Password reset atomically
increments the account version and revokes existing host sessions before
creating the replacement session. A concurrent login authenticated with the
old password therefore cannot mint a valid post-reset session.

The opportunistic rehash path is a compare-and-swap on the old password hash
and authentication version. A login may upgrade the representation of the same
password without advancing authority, but it cannot overwrite a concurrent
reset and resurrect the previous password.

### Make creator ownership explicit

Migration 0006 adds `event_sessions.can_claim_owner`, defaulting to false, and
`events.legacy_owner_claim_open`, defaulting to false. Existing events are
backfilled with the legacy flag true because their sessions contain no reliable
creator provenance. New event creation marks only the management session
created in the same operation as claim-capable; every later management-link
exchange remains false.

`claimInitialOwner(eventId, accountId)` is one conditional database write:

- it succeeds idempotently when the account already hosts the event;
- it inserts an owner when the event has no host;
- it refuses when a different host already exists.

Registration start may retain an event claim only when the current session has
that capability or the event's one-time legacy claim remains open. Completion
re-resolves the same live event session before claiming, so rotation, expiry,
or a different browser cannot replay the pending claim.
`/host/events/:eventId/adopt` enforces the same rule. A successful legacy claim
closes `legacy_owner_claim_open` in the same batch.

A partial unique index permits only one `owner` row per event. A signed-in host
creating an event gets the event, creator session, owner row, and three outbox
rows in the same D1 batch, and the create response reports
`savedToAccount: true`. An invalid or expired optional host cookie falls back to
link-only creation and reports `savedToAccount: false`; it never claims account
recovery. The current PR does not add a cohost invitation or removal system;
durable cohost access remains out of scope.

Account activation, any authorized owner claim, and the three corresponding
outbox rows are committed in one D1 batch. The outbox inserts select through
the committed `event_hosts` row, so a failed or refused ownership claim cannot
schedule mail that implies ownership.

The manager's “Sign in to save it” link carries a validated same-origin return
path and event ID. After login, the client calls the adoption endpoint while
the management-link cookie is still present, then returns to the manager. The
same return/adopt flow runs after a successful password reset. Manager session
errors always offer sign-in as a safe recovery option because a plain manager
URL cannot prove whether it came from an account page or a copied link.

Manager authorization preserves lifecycle errors from the account credential
while trying an independent management-link fallback. If fallback also fails,
an expired or deleted account-owned event remains expired or deleted instead of
being flattened into a generic role error.

### Use a bounded D1 outbox for lifecycle mail

Because Candidary already has D1 and a daily scheduled Worker, and has no Queue
resource, this PR will use `host_notification_outbox` rather than provision a
new Cloudflare Queue.

Each account-event pair gets unique outbox rows for getting started, the event
reminder, and the access warning. Immutable `available_at` records the first due
time; mutable `retry_at` records the next attempt; `discard_after` prevents a
late reminder or warning from outliving the action it describes. A missed cron
therefore does not erase eligibility.

Rows move through `pending → sending → sent`; explicit failures return to
`pending` with `attempt_count`, a new `retry_at`, and the provider error code.
Exhausted or obsolete rows become terminal `failed` rows. `sending` is a leased
claim identified by a random `claim_token`. Every outcome update is fenced by
that token, so an expired worker cannot overwrite the result of a worker that
reclaimed the lease. Reclaiming still accepts the normal at-least-once duplicate
risk after an isolate dies between provider acceptance and the final D1 update.
Leases expire after 10 minutes.

An hourly `47 * * * *` Cron Trigger runs notification delivery separately from
the existing daily `17 3 * * *` cleanup. The shared scheduled handler selects
the operation using `controller.cron`.

The dispatcher:

1. reclaims expired leases;
2. claims at most 100 due row IDs in one conditional UPDATE and one token;
3. loads those rows with account and event data in one explicit-column JOIN;
4. catches and records each send independently with claim-token fencing;
5. stops stale reminder delivery after the event and stale warning delivery
   after management access ends.

Claimed rows whose account is disabled, unverified, or opted out become
terminal `failed` rows with a non-sensitive reason. A preference change after
materialization may allow one already in-flight message; later rows are
suppressed. Concurrent dispatchers cannot process the same live claim, and an
expired claim token cannot update a reclaimed row.

The query ceiling is therefore about five materialization/claim queries plus
one outcome write per target, bounded near 105 statements per run. This is
below the current 1,000-query Paid-plan limit. The 100-message batch is also
below the account's 1,000-message daily email quota.

Cloudflare Queues remain the next scaling step. A durable D1 row would still be
written first because publishing a Queue message cannot be atomic with the
account/event transaction. A Queue relay could then replace the hourly
dispatcher with independent delivery, configurable retry delay, autoscaling,
and a dead-letter queue. It would still require idempotency because Queue
delivery is at least once, and it would not fix any migration or auth defect.

### Make preferences intentional

`GET /host/unsubscribe/:token` renders a confirmation page and performs no
write. Its signed `POST` changes the preference and returns a confirmed state.
The account page exposes the existing authenticated preferences endpoint so a
host can disable or re-enable lifecycle email.

Logout only navigates away after the server confirms revocation. A failed
logout remains visible and retryable.

## Error handling

- Registration start remains enumeration-safe with one generic accepted
  response.
- Invalid, expired, exhausted, or replayed codes use the existing stable login
  error codes.
- A lost authentication-version race returns an ordinary invalid-login result
  and sets no cookie.
- Adopting an already owned event returns a stable conflict/forbidden response
  without changing membership.
- Notification failures are structured logs plus outbox state; they never abort
  retention cleanup or later recipients.
- A malformed unsubscribe token renders the same safe confirmation surface but
  cannot mutate an account.

## Test strategy

Every behavior change begins with a failing Worker or UI test:

- populated 0001–0005 migration with media and messages survives 0006;
- registration creates no account, membership, or session before code proof;
- new and existing addresses have indistinguishable start responses;
- successful completion creates or recovers the account and reports the true
  event-binding result;
- existing-account completion creates no duplicate account, preserves its
  password and authentication version, and authenticates only after mailbox
  proof;
- registration resend uses the pending-registration cookie while standalone
  account verification retains its host-session flow;
- rate-limit reservations are atomic and occur before hashing/sending;
- an old-version login cannot create a session after reset;
- a second link holder cannot become a second durable owner, and a legacy
  event's one-time first claim closes atomically;
- signed-in creation attaches the new event and its outbox rows atomically,
  while a stale host cookie remains explicitly link-only;
- login return context adopts only the intended event;
- outbox rows survive send failure, retry independently, and process no more
  than the fixed batch; stale leases are reclaimed and old claim tokens are
  fenced out;
- unsubscribe GET is read-only, signed POST opts out, and authenticated
  preferences can opt back in;
- failed logout does not navigate.

The final gate is the complete unit and Worker suites, typecheck, lint,
production build, generated-binding check, and browser tests when the sandbox
runtime permits them.

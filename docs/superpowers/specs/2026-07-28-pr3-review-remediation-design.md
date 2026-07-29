# Pull Request 3 Review Remediation Design

**Scope:** Fix the nine actionable findings from the independent review of
pull request 3. Keep the patch narrow: no new infrastructure, no credential
model redesign, and no unrelated refactoring.

**Branch:** `claude/user-auth-host-50qbya`

## Constraints

1. Before changing migration 0006, verify it is absent from every configured
   remote D1 database, including preview or staging. If any remote has applied
   it, add migration 0007 for new columns instead. Migrations 0001-0005 and
   their production data must remain untouched.
2. A post-0006 event may acquire its first durable owner only through its
   creator session. A legacy event retains its existing one-time claim rule.
3. A registration code is superseded by resend, single-use, and successful for
   at most one completion request.
4. Cleanup may remove consumed registration scratch state without changing the
   result of an activation that already committed.
5. An opt-out may allow the provider call already in flight to finish, but no
   later row in the claimed page may begin sending after the opt-out commits.
6. Notification dispatch remains bounded to 100 rows. The extra live
   eligibility fence raises the bounded database work to at most 203 statements
   per run: three page-level statements plus authorization and outcome writes
   for each of 100 rows.
7. Scheduled work uses execution time for authorization and lifecycle
   decisions. The nominal scheduled time is telemetry only.
8. Every production change starts with a failing behavioral regression test.
9. Do not add Queues, Durable Objects, dependencies, or a new deployment step.

## Ownership and manager-link behavior

The event-creation success page will keep the bearer management link in the
copyable link card, but “Open event manager” will navigate directly to
`/manage/event/:eventId`. This preserves the creator session already installed
by event creation instead of exchanging the bearer token into an ineligible
session.

Manager-link rotation will remain unchanged for events with a durable owner.
For an event with no `owner` row, the route will query whether ownership is
still possible: either the event has a live, unrevoked manager session with
`can_claim_owner = 1`, or `legacy_owner_claim_open = 1`. While either path
exists, rotation returns a conflict before revoking any token or session. The
message directs the host to use the creator session to save the event first; it
does not imply that every current link holder can claim ownership. A cohost row
without an owner does not relax this guard.

Once no live creator session and no legacy claim remain, the event is already
permanently link-only. Rotation is allowed in that state so a leaked management
link can still be revoked. This is the narrower fix: it does not transfer
creator capability to a replacement session or redesign link credentials.

The creator session expires at the earlier of the event's management deadline
and 12 hours after creation. That is also the end of post-0006 ownership
eligibility unless the event was attached sooner. The creation-success and
account-registration copy will disclose this 12-hour recovery window, and the
security documentation will record it.

The adoption route will authenticate the host account and call
`getEventHost(eventId, accountId)` before requiring an event-manager cookie. An
existing owner or cohost returns idempotent success and is never promoted. Only
a new first-owner claim requires the current same-event creator or legacy
management credential. `claimInitialOwnerAndSchedule` remains authoritative
for the committing ownership check.

## Registration activation and cleanup

Migration 0006 will add nullable `activation_nonce` to
`host_registration_challenges`.

`AccountsRepository.activateRegistration` will generate a random UUID and use
its first batch statement as a compare-and-swap. The update must match:

- the challenge ID;
- `consumed_at IS NULL`;
- a live expiry;
- the browser-secret digest from the verified snapshot;
- the code digest from the verified snapshot; and
- no disabled account for the challenge email.

The winning update writes both `consumed_at` and `activation_nonce`. Every
account, verification, ownership, legacy-claim, and outbox statement in that
batch is guarded by the same challenge ID and activation nonce. The method
checks the first batch result and returns `null` unless exactly one row was
consumed.

Success is determined from the batch result, not by re-reading the consumed
challenge. The method may load the durable account and membership after the
batch to construct its response; cleanup cannot delete those records.

Registration resend keeps the existing opaque browser token and reissues the
same `candidary_registration` cookie with a fresh 15-minute `Max-Age` only
after the server successfully replaces the code. `resendRegistration` returns
the parsed existing `SecretToken` after replacement;
`parseRegistrationToken` adds the unchanged raw `token` field to its current
`id` and `secret` result.
`setRegistrationCookie` accepts that token plus an optional max age. Failed and
rate-limited resends do not renew the cookie.

## Resumable registration UI

Add an addressable `/host/register` page using the existing
`HostAccountPanel`. It accepts the same validated `returnTo` and `adopt`
navigation context as sign-in. Those query values affect navigation only;
cookies and database state remain the sole authority.

The manager account card will offer “Create account” beside “Sign in.” The
registration link carries the manager return path and event ID. The registration
page starts on the account form by default. After a registration start succeeds,
the app navigates to the same route with a `pending=1` UI hint, which makes the
code form survive reloads. If the cookie or challenge is no longer usable, the
code form exposes a “Start over” action that returns to the account form.

`HostAccountPanel` gains an `onStarted` callback used by both entry surfaces to
navigate to the pending URL after a successful start. Its code stage gains a
local “Start over” action that clears notices and returns to the form; this is a
UI reset only and grants no authority.

The creation-success panel uses the same transition after registration start.
Completion continues to trust only the server's `boundEvent` response before
claiming that the event is recoverable.

## Notification fencing and cron time

Add one repository operation,
`authorizeClaimedDelivery(id, claimToken, now)`, immediately before each
provider call. It is one `UPDATE ... RETURNING`, fenced by the row ID,
`status = 'sending'`, the current claim token, and an unexpired lease. It
re-evaluates the current account and event state:

- disabled account;
- unverified address;
- notifications disabled;
- deleted event; and
- a reminder or warning past `discard_after`.

The statement uses `CASE` expressions across the row's delivery fields. When
suppressed it sets `status = 'failed'`, records the existing non-sensitive
`last_error_code`, clears `claim_token`, `claimed_at`, and `lease_expires_at`,
and updates `updated_at`. When eligible it returns `status = 'sending'` with
the claim metadata unchanged, so the later `markSent` or `retryOrFail` fence
still matches. A missing, reclaimed, or expired claim returns no row and no
permission. This adds one statement per claimed row while preserving the
existing outcome write and claim-token fencing.

The service-level `suppressionReason` path will be removed. Live suppression
and its precedence have one authority in the repository statement, preventing
double retirement, double counting, or disagreement about the recorded reason.

`NotificationService.dispatchPending` obtains a fresh wall-clock timestamp
before each authorization statement. This prevents a long-running page from
using eligibility cached at page load.

The scheduled handler creates `executedAt = new Date()` and passes it to both
notification dispatch and cleanup. `controller.scheduledTime` is retained only
as `scheduledAt` in structured logs. The current comment in `worker/index.ts`
and the scheduled-work explanation in `docs/operations.md` will be rewritten
because they presently defend the stale scheduled-time behavior this change
removes.

## Error handling

- Rotation of an ownerless event returns HTTP 409 with
  `OWNER_CLAIM_REQUIRED` only while a live creator or legacy claim remains. Its
  guidance names the creator session as the required path. If no claim path
  remains, rotation is allowed.
- Existing membership adoption returns HTTP 200 without requiring a management
  cookie.
- Losing the registration compare-and-swap returns the existing invalid-code
  response and creates no host session, membership, or outbox row.
- A registration page with stale pending state remains recoverable through
  “Start over.”
- A notification row that loses its claim or lease is skipped without calling
  the provider.

## Test strategy

Focused regressions will cover:

1. The creation CTA uses `/manage/event/:eventId` while the copied management
   link remains the bearer URL.
2. Manager-link rotation while a live creator claim exists returns 409 and
   leaves the creator session and token usable. Rotation succeeds after
   ownership and also after the 12-hour creator session has expired with no
   legacy claim.
3. Existing-owner and existing-cohost adoption succeed with only a host cookie
   and do not change roles, while a new claim without a creator or legacy
   credential remains forbidden.
4. A completion using a snapshot superseded by resend loses the activation
   compare-and-swap.
5. Concurrent completions sharing the same timestamp produce one winner.
6. Cleanup after the activation batch cannot turn committed success into
   `null`.
7. Resend returns the same registration cookie value with a renewed
   `Max-Age=900`.
8. `/host/register` is reachable from the manager, preserves safe recovery
   context, and reloads into code entry after registration starts.
9. Opting out during the first of two claimed sends prevents the second
   provider call; the second row is retired once, has cleared claim metadata,
   and records the repository-selected suppression reason.
10. A delayed cron invocation and a page that crosses a discard deadline use
    actual wall-clock time and retire obsolete work.

Before the first migration edit, a read-only remote migration listing confirms
whether 0006 may be amended or requires a new 0007. After focused red-green
cycles, the final gate is the full unit and Worker suites, typecheck, lint,
production build, generated-binding check, and a current-main synthetic merge
verification. No deployment or production migration is part of this change.

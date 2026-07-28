# Tasks 3–7 report — attachment, outbox, preferences, deployment, publication

## Status

Tasks 3, 4, 5, and 6 are complete. Task 7 is complete except for the two steps
recorded under "Blocked and deviations".

| Commit | Task | Subject |
| --- | --- | --- |
| `309e5cd` | 3 | feat(host): attach and recover events through the account |
| `11f7f85` | 4 | feat(notifications): dispatch lifecycle mail from a durable outbox |
| `a6947f6` | 5 | fix(host): make unsubscribe, preferences, and sign out intentional |
| `c067c07` | 6 | chore(deploy): declare required secrets and document the hardened flows |
| `250a5fd` | 7 | fix(notifications): let the outbox own every lifecycle send |

## Task 3 — account attachment and recovery

Signed-in creation now resolves the optional host cookie in `POST /api/events`
and commits the event, both access tokens, the creator session, the sole owner
membership, and the three lifecycle outbox rows in one `DB.batch`. The response
reports `savedToAccount` from what committed, read back after the batch, not
from the request's intent. An invalid or revoked host cookie falls through to
the anonymous path.

`EventsRepository`, `TokensRepository`, and `SessionsRepository` gained
`createStatement()` so the batch is possible; their `create()` methods now
delegate to it, so no existing caller changed behaviour.

Registration completion became the only thing that can call an event saved.
`HostAccountPanel` posts to `/api/host/register/complete` and
`/api/host/register/resend`, reports the server's `boundEvent` through
`onCompleted`, and has explicit `registration` and `verification` modes.
`HostVerifyPage` keeps the host-session flow. `CreatePage` initialises `saved`
from `savedToAccount` and hides the panel entirely when creation already
attached the event.

`src/app/recovery.ts` builds and validates the recovery URL. `returnTo` is
accepted only as a local `/host/events` or `/manage/event/<uuid>` path, and
adoption only runs when `adopt` matches the event in `returnTo` — so the
parameter cannot become an open redirect or claim an unrelated event. Login and
password reset both call adoption before navigating, while the management-link
cookie that authorises the claim is still present.

`resolveManager` no longer flattens account-side lifecycle failures. An
`EVENT_EXPIRED`, `EVENT_DELETED`, `EVENT_NOT_FOUND`, or `ACCOUNT_DISABLED`
error is held while the link fallback is tried and rethrown if that also fails,
instead of surfacing as `ROLE_FORBIDDEN`.

## Task 4 — durable bounded outbox

`NotificationOutboxRepository` gained `reclaimExpired`, `claimDue`, `loadClaim`,
`markSent`, `retire`, `retryOrFail`, and `reviveUnverified`. A dispatch run is
one reclaim, one claim under a single random token, one explicit-column join,
and one fenced outcome write per row — about 105 statements at the 100-row
default. Every outcome update carries `AND status = 'sending' AND claim_token = ?`,
so a worker whose lease was reclaimed cannot overwrite the successor's result.

Retry delays are 5 minutes, 1 hour, 6 hours, and 24 hours; the fifth failed
attempt is terminal. Rows for disabled, unverified, or opted-out accounts,
deleted events, and reminders past `discard_after` are retired with a
non-sensitive code and no send.

The hourly `47 * * * *` trigger was added beside the daily one, and
`worker/index.ts` selects the job from `controller.cron` using
`controller.scheduledTime` as the operation time. `scheduledCleanup` no longer
sends mail, so retention and delivery no longer share a failure boundary.

## Task 5 — intentional preferences

`GET /host/unsubscribe/:token` renders a confirmation form and performs no
write; the signed `POST` to the same URL performs the opt-out and remains what
`List-Unsubscribe` advertises. The account page gained a labelled toggle whose
local state follows the server. Sign out navigates only after the server
confirms revocation, and a refused sign out keeps the page and shows a
retryable error.

## Task 6 — deployment requirements

`wrangler.jsonc` declares all six secrets under `secrets.required`, which is
what puts `LOGIN_HMAC_KEY` into the generated bindings. `worker/env.ts` is now
`export type AppEnv = Cloudflare.Env` rather than redeclaring the six secrets,
so configuration and code cannot disagree silently — which is how the binding
came to be missing in the first place. Deployment, security, operations, and
README docs were updated for pending registration, versioned revocation, the
rate limits, creator-only ownership with the one legacy claim, the outbox retry
states and dispatch bound, the hourly trigger, and the read-only unsubscribe GET.

No comment was added to `wrangler.jsonc`: `tests/unit/static-headers.test.ts`
parses it with `JSON.parse`, so despite the `.jsonc` extension the file must
stay comment-free. A comment added during Task 4 broke that test and was removed.

## Task 7 — review findings and fix wave

Reviewing the branch against the design invariants surfaced two defects that
the task suites had not caught, both fixed in `250a5fd`:

1. **`POST /api/host/verify` still sent the getting-started guide inline.** That
   left one lifecycle message on the non-durable path the outbox exists to
   replace: a transient provider failure lost it, the response blocked on an
   external send, and it could duplicate the outbox row scheduled at ownership.
   Verification now only calls `reviveUnverified`, which returns a row retired
   for `address_unverified` to `pending`; delivery happens on the hourly trigger.

2. **The nightly scan was dead but still present.** `NotificationService.run()`
   and `targets()` performed a `getById` per event and per account — the
   unbounded N+1 path in the reported issue list. Nothing in production reached
   it once dispatch moved to the outbox, so it was removed along with the eight
   tests that kept it alive. Its scheduling coverage is now asserted directly
   against the outbox rows that ownership commits.

The second fix is why the Worker test count moved from 140 to 135: eight legacy
scan tests were removed and three were added (one scheduling assertion and two
for the verification path).

## Verification

Final run at `250a5fd`:

```text
XDG_CONFIG_HOME=/tmp/candidary-wrangler npm test
  test:unit    Test Files  11 passed (11)   Tests  95 passed (95)
  test:worker  Test Files  13 passed (13)   Tests 135 passed (135)   EXIT=0
npm run typecheck                            EXIT=0
npm run lint                                 EXIT=0
npm run build                                EXIT=0
npx wrangler types --check                   EXIT=0  (types up to date)
npx wrangler deploy --dry-run                EXIT=0
git diff --check                             EXIT=0
```

## Blocked and deviations

- **Independent task reviews could not be obtained.** Three review subagents
  were dispatched and all three were killed before producing output. The reviews
  recorded here are therefore self-review against the design invariants, not
  independent review. This is a real deviation from the requested process and
  the two Task 7 findings above show the kind of defect that survives a task
  suite, so an independent pass before merge is still worth running.
- **Browser E2E cannot run against the pinned browser.** `@playwright/test`
  1.61.1 expects Chromium build 1228; this container ships build 1194 at
  `/opt/pw-browsers`. `npm run test:e2e` therefore fails to launch. Running the
  same specs against the installed binary passes, so this is an environment
  limitation and not an application result. The visual-qa baselines are
  `-win32` and are correctly reported as missing on Linux by design.

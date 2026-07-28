# Host account hardening — SDD progress ledger

Feature: PR 3 hardening for `henryperkins/candidary`.
Branch: `claude/user-auth-host-50qbya` (PR 3), base `f3253f23ab86a6e8fbae36eb2a8eb912aa95e392`.

## Ledger recovery note (2026-07-28)

The original working checkout was lost. Recovery used the packaged handoff
bundle, which restored all seven local commits and every tracked file
byte-for-byte (23 paths, 3,307 insertions, 271 deletions verified against the
packaged manifest and source overlay).

`.superpowers/` is listed in `.gitignore`, so the earlier ledger files were
never tracked by Git and were not recoverable:

- `progress.md` — lost; this file replaces it.
- `task-1-report.md` — lost.
- `task-2-brief.md` — lost.

`task-2-report.md` survived because it had been force-added to the repository
in commit `0f617a8`. Subsequent ledger files in this directory are likewise
force-added so a future workspace loss cannot repeat this.

The substantive authority — `docs/superpowers/plans/2026-07-28-host-account-hardening.md`
and `docs/superpowers/specs/2026-07-28-host-account-hardening-design.md` — is
tracked and survived intact. Task 1's outcomes are additionally recorded in the
commit history and re-verified by the current test suite, so the loss of
`task-1-report.md` does not require reimplementing Task 1.

## Commits

| Commit | Task | Subject |
| --- | --- | --- |
| `7d8edb9` | 1 | docs: define PR 3 hardening plan |
| `75a5ac4` | 1 | docs: close hardening edge cases |
| `77c332c` | 1 | feat(auth): version host sessions |
| `a2b822c` | 1 | fix(auth): advance version on password reset |
| `a17404e` | 1 | fix(auth): guard login rehashes |
| `0eef048` | 2 | feat(auth): verify pending host registration |
| `0f617a8` | 2 | docs: report task 2 auth hardening |

## Task status

| Task | Status | Review |
| --- | --- | --- |
| 1 — Preserve event sessions, versioned host sessions | Complete | Approved (report lost; re-verified by suite) |
| 2 — Verify pending registration, close auth races | Complete | Self-review only — see deviation below |
| 3 — Account attachment and recovery UX | Complete (`309e5cd`) | Self-review only |
| 4 — Durable bounded D1 notification outbox | Complete (`11f7f85`) | Self-review only |
| 5 — Intentional unsubscribe, preferences, logout | Complete (`a6947f6`) | Self-review only |
| 6 — Cloudflare deployment requirements and docs | Complete (`c067c07`) | Self-review only |
| 7 — Verify, review, publish | Complete (`250a5fd`) | Two findings fixed; see report |

### Deviation: independent review unavailable

Three review subagents were dispatched for Task 2 and all three were killed
before producing any output. Every review recorded for Tasks 2–7 is therefore
self-review against the design invariants, not the independent review the
process calls for. The two defects found at the Task 7 stage — an inline
lifecycle send that bypassed the outbox, and the dead N+1 scan — are exactly
the kind a task suite passes over, so an independent pass before merge is still
worth running.

Detailed report for Tasks 3–7: `task-3-to-7-report.md`.

## Fresh verification after recovery (2026-07-28)

Re-run in the recovered checkout at `0f617a8`, not carried over from the lost
workspace:

```text
focused Task 2 matrix (migration-0006, host-auth, repositories, cleanup)
  Test Files  4 passed (4)
       Tests  71 passed (71)

npm test
  test:unit    Test Files  11 passed (11)   Tests  85 passed (85)
  test:worker  Test Files  13 passed (13)   Tests 129 passed (129)
  exit 0

npm run typecheck   exit 0
npm run lint        exit 0
git diff --check    exit 0
```

These reproduce the counts claimed in `task-2-report.md` exactly.

## Known open issues carried into the remaining tasks

Confirmed present in the code at `0f617a8`:

- `src/pages/CreatePage.tsx` marks the event saved when registration *starts*
  (`onRegistered`), not when mailbox proof completes — Task 3.
- `src/components/HostAccountPanel.tsx` still posts to `/api/host/verify`, which
  Task 2's pending-registration change left unreachable before a host session
  exists — Task 3.
- `worker/routes/public.ts` never resolves the optional host cookie, so
  signed-in creation does not attach ownership and reports no
  `savedToAccount` — Task 3.
- `worker/auth/manager.ts` flattens account-side lifecycle errors with
  `.catch(() => null)` before the link fallback — Task 3.
- `worker/routes/host-public.ts` mutates notification preferences on GET —
  Task 5.
- `src/pages/HostEventsPage.tsx` navigates away in `finally` after a failed
  logout — Task 5.
- `worker/index.ts` ignores `controller.cron`; `wrangler.jsonc` has only the
  daily trigger — Task 4.
- `wrangler.jsonc` declares no `secrets.required`, so the generated
  `worker-configuration.d.ts` omits `LOGIN_HMAC_KEY` — Task 6.

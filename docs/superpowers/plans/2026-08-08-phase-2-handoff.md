# Phase-2 hand-off — Event Appearance Cover Studio (Tasks 5–9)

Supersedes the earlier hand-off written at Task 3. Paste everything below the line
as the opening prompt for a fresh session.

---

You are continuing an in-progress implementation of
`docs/superpowers/plans/2026-08-05-event-appearance-cover-studio-phase-2.md`
(the "phase-2 plan"), which implements phase 2 of
`docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md` §9.5
plus the §9.4/§14 purge-fence coordinator.

**Both documents are committed on the branch.** Read the plan from the worktree,
not from the main checkout.

Your job is two things, in order: **review what has already been done**, then
**continue the plan from Task 5 through Task 9**.

## Where to work

- **Worktree:** `C:\Users\htper\candidary\.worktrees\cover-studio-phase-2`
- **Branch:** `agent/event-cover-studio-phase-2`
- **Branch point:** `85fa9278b05a0af73091e17a2306b97ac2504617` (tip of `agent/event-cover-studio-phase-1`)
- **Current head:** `7e32362`, worktree clean
- Dependencies are installed there. Run every command from that directory.
- Do **not** touch the main checkout at `C:\Users\htper\candidary`. It has a
  modified `worker/services/email.ts` and several untracked user-owned files
  that must be preserved. It is unchanged at `c20f54b`.

## The merge model — read this before anything else

**Phase 1 is deliberately not merged into `main`, and phase 2 must not merge it.**
The cover-studio branch line accumulates phases and lands as one integration only
after every phase of the design spec is complete. Phase 2 stacks directly on the
phase-1 tip. Do not merge, rebase onto `main`, push, or open a PR.

Phase 2's only file overlap with `main`'s post-divergence commits is
`docs/deployment.md`, which Task 9 touches. Nothing in worker, shared, scripts,
or tests collides.

**`--base-sha` is not a branch point.** `scripts/verify-release.ts:153` compares
it against a pinned `APPROVED_RELEASE_BASE_SHA` and throws
`--base-sha is not the approved Increment 1 base` for any other value. The
correct value is always `0b92387d2e237d568d2514373dcc3044e7960d4b`. The phase-2
branch point `85fa927…` is a *different* SHA used only for `git diff --check`.

## Completed work to review

Read the actual diffs. The summaries tell you what to look for, not what to assume.

| Commit | What |
| --- | --- |
| `d382b2e` | Task 1 — conservative Workflow lookup adapter (`worker/workflows/cover-platform.ts`) |
| `bb013bd` | Task 2 — deletion-fence purge coordinator; both preflights fail closed |
| `61d82b8` | Task 3 — launcher resumes from the durable ledger; five planner phases |
| `fa21d19` | Review fix — a refused render no longer strands its draft |
| `c0822ab` | The phase-2 plan document itself |
| `7e32362` | Task 4 — claim, confirm, and recover initial dispatch |

A six-lens adversarial review ran over `d382b2e` and `bb013bd` and found them
sound. Two defects were confirmed: one is fixed in `fa21d19`, the other is still
open and described under "Outstanding decisions" below.

## Deliberate decisions that read as defects

Do not "fix" any of these. Each is load-bearing and each has cost time already.

1. **`isCertifiedWorkflowNotFound` certifies nothing.** Its matcher registry is
   empty, every lookup failure classifies as `unknown`, and confirmed-missing
   recreation is disabled by construction. Cloudflare's `Workflow.get(id)` throws
   for "does not exist **or** is invalid" and exposes only `e.message`, which
   embeds the instance ID verbatim. Task 11 appends exactly one matcher only if it
   proves a stable discriminator against the deployed platform. **Never match on
   `error.message`.**
2. **`complete` is not a stored purge phase.** `event_cover_purge_progress.phase`
   allows only `fences | r2 | relational`; "complete" is the row no longer
   existing. That row is `REFERENCES events(id) ON DELETE RESTRICT`, so it must be
   deleted before the event row. `0012` has no room and phase 2 adds no migration.
3. **`FENCE_PURGE_HOLD_EXPIRES_AT` (`'9999-12-31T23:59:59.999Z'`) does double
   duty.** It marks an unresolved fence by exact equality *and* keeps it out of the
   bounded expiry sweep, which deletes by `expires_at`. Settling stamps `now + 31d`.
4. **`dispatch` and `confirm` are launcher phases, not run modes.** `0012`
   constrains `event_cover_backfill_runs.mode` to `inventory | execute | verify`.
   Never write `mode = 'dispatch'`.
5. **In-flight is not the same set as nonterminal.** `LIVE_COVER_DISPATCH_STATES`
   (`creating|confirmed|resuming|restarting`) is platform capacity;
   `NONTERMINAL_COVER_BACKFILL_STATUSES` (`queued|normalizing|rendering|finalizing`)
   is ledger capacity. A `pending` job has no instance behind it. Collapsing these
   two into one set is a real bug that was already made once and fixed: it makes
   any run of more than 25 jobs refuse its own first dispatch forever.
6. **`--remote` is not universal.** Verified against wrangler 4.113 `--help`:
   `d1 execute` has it; `workflows trigger` and `workflows instances terminate` do
   **not** — they take `--local` or nothing, and passing `--remote` is an
   unknown-argument error. The plan's blanket "every generated remote command must
   include `--remote`" is wrong for the Workflow commands, which are pinned instead
   by carrying `--config wrangler.jsonc` and never `--local`. A test asserts this.
7. **A generation mismatch in `coverRenderPreflight` writes nothing and returns
   `skipped`.** Supersession is not failure: `restartCoverPublication` moves the
   receipt and fence in one batch, so a divergence means another generation owns
   that receipt. Writing a terminal status there poisons the live run.
8. **`confirmCoverBackfillDispatch` never writes the fence.** The fence's
   `updated_at` is the durable dispatch-claim clock the rolling-minute budget is
   measured from. Confirming must not touch it.
9. **Initial-create recovery performs no lookup at all.** The fake accessor in the
   tests throws from `lookup` to enforce it. Replaying a claim is safe because the
   claim is a commitment, not an inference from a status read.
10. **The launcher restates `0012`'s CHECK vocabularies.** `scripts/` cannot import
    `worker/db/types.ts` — different build project, and Node's type stripping
    cannot follow the extensionless imports beneath it. The unit test parses the
    migration's CHECK lists and asserts the copies against them.
11. **`shared/cover-dispatch.ts` must stay dependency-free.** It is loaded from
    `scripts/` by dynamic `.ts` import under Node type stripping. Adding any import
    to it breaks the launcher at runtime, not at typecheck.
12. **Artifacts and payloads are refused inside the repo unless under `output/`.**
    They carry object keys and exact production commands. A path outside the
    checkout is allowed.

## Outstanding decisions

### 1. Confirmed defect, unfixed — the manager delete route lies

`worker/routes/manage.ts:186` still answers `{ deleted: true }`. `deleteEventData`
became may-return-incomplete in `bb013bd` (two early returns: unresolved fence, and
prefix not yet empty) but the wrapper is a bare `await reconcileEventCoverPurge(...)`
returning `void`, discarding the `CoverPurgeProgressSummary` and its `remainder`.
A host deleting an event with an unresolved cover fence is told their data is gone
while every `media` row and R2 object is still present.

Spec §14 requires 202 with a `deletionScheduled` result; that field appears nowhere
in the tree. The fix: return the summary from `deleteEventData`, branch at
`manage.ts:186` on `remainder`, add the field to the manage response type, and
soften the confirm-dialog copy (`src/.../ManagerPage.tsx`, around the danger-zone
text). Two mitigations reported by the review's verifier and worth re-checking
yourself: the client discards the response body and redirects, so the false
assurance rides on the 200 plus the danger-zone copy; and `scheduledCleanup`
re-selects `deleted_at IS NOT NULL`, so residue normally clears on the next daily
pass — "indefinite" applies only while the fence keeps failing to settle.

**It was left unfixed because it widens into `src/` and no plan task owns it** —
Task 2's file list omits `worker/routes/manage.ts`. Either claim it explicitly in
Task 6 or ask before doing it.

### 2. Unresolved in the plan itself

The plan defers merging to the whole-spec landing while the design spec sequences
the production backfill *before* phase 3 is built. That conflict is settled when
Task 11 is authorized, **not by an implementing agent**. Do not resolve it
implicitly by merging.

## Review findings not yet acted on

**Confirmed by adversarial verification** — the manage-route defect above.

**Reported by a review lens but NOT independently verified. Check each against the
code before acting on it.** Line numbers are as the review reported them.

- `event_cover_purge_progress.fences_resolved` is incremented by rows *inspected*,
  not resolved (`cleanup.ts:667`, `:711`), and re-counts unresolved fences on every
  pass, so it can exceed the number of fences the event ever had. It is the only
  durable signal §14 defines for observing a stalled purge.
- `queued_count` is recomputed twice with two different definitions inside one
  purge — the canonical four-status form in the fencing batch (`cleanup.ts:780-783`)
  and a narrower `status = 'queued'` in the relational batch (`:880-881`), which
  runs last and wins.
- §14 step 2 — "stop while a `creating`/`resuming`/`restarting` claim is younger
  than `STALE_DISPATCH_CLAIM_MS`" — is absent from the coordinator.
  `STALE_DISPATCH_CLAIM_MS` is not imported by `cleanup.ts`. Task 4's recovery pass
  reduces the exposure but does not add the wait. **Relevant to Task 5.**
- The purge phase transitions (`cleanup.ts:815-817`, `:831-833`) are read-then-write
  with no `AND phase = <expected>` and no `changes()` check, contrary to CLAUDE.md's
  guarded-batch rule. No wrong outcome was shown to be reachable today.
- `purgeActionFor` (`cleanup.ts:559`) switches over raw platform status strings
  rather than a `CoverPlatformDisposition`. No harmful divergence today, but
  **Task 11 must update `purgeActionFor` and `mapPlatformStatus` together** or the
  purge and publication paths will disagree about a new status.

**Coverage gaps worth closing, ideally in Task 8's rehearsal:**

- The purge's bounded paging branch has never executed. Every purge test seeds
  exactly one fence, so `exhausted === false` and cursor persistence, resumption,
  and reset are all unexercised. Add a >100-fence case.
- `materializeForPurge`'s backfill arm is dead in tests: `seedEventCoverGraph`
  writes a fence for the render instance but none for `backfill-<suffix>`.
- No test asserts a publish *receipt* reaching `EVENT_DELETED`; the seeded receipt
  is `applied` (terminal), so the coordinator's receipt statement matches zero rows
  in its own test.
- The `'throw'` affordance in `purgeAccessors` (`tests/worker/cleanup.test.ts:80-89`)
  has no call site, so the coordinator's `.catch()` on a rejecting accessor is
  untested.
- `tests/worker/event-cover-publication.test.ts:397,599` hand-write
  `state = 'deletion-blocked'` with the original `expires_at` — a shape the
  coordinator never produces. Pre-existing and out of Task 2's scope; do not copy it.

## Next: Task 5 — reconcile platform status, take the one guarded restart edge

Not started. Files per the plan: `worker/workflows/cover-backfill.ts`,
`worker/workflows/cleanup.ts`, and the two corresponding test files. It is the
largest remaining task and the first whose gate is the **complete** Worker suite.

Reconnaissance already done, so you do not need to redo it:

- **Already built and reusable.** `worker/workflows/cover-backfill.ts` now exports
  `confirmCoverBackfillDispatch`, `coverBackfillConfirmStep`,
  `recoverStaleInitialBackfillDispatches`, `StaleInitialDispatchSummary`,
  `CoverBackfillDispatchConfirmation`, `recomputeBackfillRunCounters`,
  `backfillPredicatesHold`, `coverBackfillDependencyVersions`, and
  `BACKFILL_RESTART_WINDOW_MS` (24h, defined at line 68).
- `shared/cover-dispatch.ts` holds the canonical claim/confirm/block predicates and
  the two status vocabularies. Task 5's restart claim belongs there too if the
  launcher ever needs to render it; otherwise keep it Worker-side.
- `STALE_DISPATCH_CLAIM_MS` is `2 * 60 * 1000`, exported from
  `worker/services/event-cover-publication.ts:43`.
- `worker/workflows/cover-platform.ts` gives you `dispositionForLookup`,
  `mapPlatformStatus`, `CoverBackfillWorkflowAccessor`, and
  `defaultCoverBackfillWorkflowAccessor`. Route every status read through them.
- Bounds in `shared/constants.ts`: `COVER_CLEANUP_ROWS_PER_CLASS = 100`,
  `MAX_COVER_PURGE_FENCES_PER_PASS = 10`,
  `MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS = 5`,
  `MAX_COVER_BACKFILL_IN_FLIGHT / _CREATE_BATCH / _CREATIONS_PER_MINUTE = 25`,
  `MAX_COVER_BACKFILL_PAGE_SIZE = 100`.
- **Current `scheduledCleanup` order** (`cleanup.ts`): auth scratch → RSVP scratch →
  expired reservations → expired exports → `cleanupEventCovers` →
  `recoverStaleInitialBackfillDispatches` → event purge loop. Task 5 inserts
  reconciliation after recovery and before the purge; Task 6 fixes the final order.
- **Test fixtures ready to use** in `tests/worker/cover-backfill-workflow.test.ts`:
  `seedJob(access, SeedOptions)` now takes
  `{ revision, dispatchState, dispatchGeneration, fenceGeneration, fenceState, claimedAt, status }`;
  `recordingBackfillAccessor({ failCreate })` records created IDs and throws from
  `lookup`; `blockingAccessors()` parks a purge in its fence phase; the `STALE`
  constant is `now - 5min`.
- Counter recomputation must be batched with the transition it summarizes — see
  `recordTerminal`.

After Task 5, continue with Tasks 6, 7, 8, and 9 in order. **Tasks 10, 11, and 12
are separately authorized and must not be started** — Task 10 is the immutable
candidate gate, 11 is staging deployment, 12 is production execution. Stop after
Task 9 and report.

## Gates and conventions

Run before every commit, from the worktree:

```powershell
npm run typecheck        # tsc -b --pretty false
npm run lint             # eslint . --max-warnings=0
# plus the task's focused tests from the plan
```

- **Baselines at `7e32362`, all passing:** Worker **740 tests / 39 files** (~45–85s,
  `vitest.worker.config.ts`, real workerd). Unit **1190 tests / 49 files**
  (`vitest.config.ts`).
- Write a failing focused test before each new behavior. Documentation, generated
  artifacts, and recorded evidence are exempt.
- **Explicit staging allowlists only.** Never `git add -A`, `git add worker`, or
  `git add docs`.
- Commit style: a subject line, a substantive body explaining *why* (not what), and
  a trailing `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Errors use `ApiError` with a code from the `ApiErrorCode` union in
  `shared/errors.ts`. D1 concurrency is enforced in SQL via guarded
  `db.batch([...])` — first statement carries the guard, later statements append
  `AND changes() = 1`, then check `results[0].meta.changes === 1`. Never
  read-then-write.
- `@typescript-eslint/consistent-type-imports` is an error;
  `noUncheckedIndexedAccess` is on in both projects.

### Validating generated SQL locally

Every statement the launcher emits has been executed against a real migrated D1
before commit, and new ones should be too. It is local-only and contacts nothing:

```powershell
npx wrangler d1 migrations apply candidary-core --local
npx wrangler d1 execute candidary-core --local --file output/<file>.sql --json
```

Write a small emitter to `output/` (gitignored) that imports the script by absolute
`file:///` URL under `node --experimental-strip-types`. Re-running an unguarded
new-run `INSERT` fails on the primary key the second time; that is correct, not a
defect. `INSERT … SELECT … WHERE … ON CONFLICT DO NOTHING` parses only because the
`SELECT` has a `WHERE` — SQLite requires it to disambiguate the upsert.

## Traps that already cost time

- `.dev.vars` does not exist in either worktree. The
  `Missing required secrets: TOKEN_HMAC_KEY, …` warning on every worker test run is
  benign. Do not create one.
- In `tests/worker/cleanup.test.ts`, several `vi.spyOn` sites call `mockRestore()`
  *after* an assertion with no `try/finally`, and the file has no `afterEach`;
  `vitest.worker.config.ts` sets neither `restoreMocks` nor `clearMocks`. If an
  assertion fails, the mock leaks into later tests in the same file. A confusing
  failure in `bounded cover storage sweep` is usually this — check whether an
  earlier test in the file failed first. Same shape at `:377`, `:725`, `:912`,
  `:1064`, and a `vi.useFakeTimers()` at `:608`.
- `seedEventCoverGraph` in `tests/worker/helpers.ts` creates a
  `COVER_RENDER_WORKFLOW` fence at `dispatch_generation = 1` and a matching receipt.
  A seeded graph therefore carries an **open** fence, so any purge test must supply
  accessors that say what the platform reports — `purgeSettled()` does this.
- **When a purge blocks a fence through the coordinator, the same batch makes the
  receipt/job terminal.** A preflight or confirmation run afterwards exits on the
  *row* before it reads the fence, so it reports `EVENT_DELETED`, not the fence
  branch. The working pattern: run the real coordinator, then reset only the job
  back to a live claim (`dispatch_state='creating', status='queued'`, clear
  `failure_code`/`terminal_at`) and leave the coordinator-produced fence untouched.
  That isolates the fence branch without hand-writing a fence state.
- **`tests/unit/verify-release.test.ts` has two tests on a 5s timeout that flake
  under CPU load** (they pass 77/77 in isolation). If the full unit suite shows
  exactly those two timing out while nothing else fails, re-run that file alone
  before investigating. Do not chase it.
- The plan's per-task file allowlists are not always right, and three tasks have now
  needed files the plan describes but does not list. Stage what actually changed and
  say so in the commit body.

## Boundaries

Do not merge, push, deploy, apply a remote migration, trigger a remote Workflow, or
mutate remote D1/R2. Do not add a migration — `migrations/` must contain exactly
twelve files at candidate time. Do not add an authentication surface, operator HTTP
route, release key, cron expression, or rate-limit binding. Do not implement any
phase-3 work (`0013`, projections, responsive delivery routes, Cover Studio
activation, `EventAppearanceCanvas`, client wiring).

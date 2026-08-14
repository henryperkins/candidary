# Phase-2 completion hand-off — Event Appearance Cover Studio (Task 10)

Supersedes `2026-08-08-phase-2-handoff.md`, which stopped at Task 5. Paste
everything below the line as the opening prompt for a fresh session.

---

You are finishing phase 2 of
`docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md` §9.5
plus the §9.4/§14 purge-fence coordinator.

**All implementation and review work is done.** Two plans governed it, both
committed on the branch — read them from the worktree, not the main checkout:

- `docs/superpowers/plans/2026-08-05-event-appearance-cover-studio-phase-2.md`
  (original, Tasks 1–12)
- `docs/superpowers/plans/2026-08-08-event-cover-phase-2-remediation-completion.md`
  (superseding, Tasks 1–8)

Original Tasks 1–9 (remediation Tasks 1–8) and the final pre-candidate review are
complete and committed. **Your job is the immutable candidate gate, original
Task 10, and nothing beyond it.**

## Where to work

- **Worktree:** `C:\Users\htper\candidary\.worktrees\cover-studio-phase-2`
- **Branch:** `agent/event-cover-studio-phase-2`
- **Current head:** `c391896488f708cb9430dd2535d2168d01062a75`, worktree clean
- **Phase-2 branch point:** `85fa9278b05a0af73091e17a2306b97ac2504617` (phase-1 tip)
- Dependencies are installed there. Run every command from that directory.
- Do **not** touch the main checkout at `C:\Users\htper\candidary`. It is on `main`
  at `c20f54b` with a modified `worker/services/email.ts` and seven untracked
  user-owned files that must be preserved.

## What this hand-off authorizes

Task A (below) and original Task 10. **Nothing else.** Original Tasks 11 and 12 —
staging deployment and production backfill — require a new explicit instruction
from the user and cannot be performed by an implementing agent. Stop after Task 10
Step 6 and report.

## Current state — verified at `c391896`

```
typecheck 0 · lint 0 · unit 1222/1222 (50 files) · worker 999/999 (40 files)
git diff --check 85fa9278…HEAD → 0 · migrations 12 · worktree clean
33 commits since the phase-1 tip
```

The last four commits are the final pre-candidate review's fix wave:

| Commit | Files | What |
| --- | --- | --- |
| `f556ecc` | 4 | shared cover writers admit on proven operation ownership |
| `ee41dd2` | 7 | publication dispatch is a generation-fenced claim; cleanup proves terminal platform state before release |
| `bf8e27b` | 9 | render manifests verified by identity; both claim rows stamped from D1 |
| `c391896` | 2 | backfill preflight gates tightened; platform observations recorded |

The original five-commit cut of that wave is retained at
`backup/cover-phase-2-wave-5commit` (`a99d1fd`). Do not build on it; it contains
two red intermediate states.

## The merge model — read this before anything else

**Phase 1 is deliberately not merged into `main`, and phase 2 must not merge it.**
The cover-studio branch line accumulates phases and lands as one integration only
after every phase of the design spec is complete. Do not merge, rebase onto `main`,
push, or open a PR.

**`--base-sha` is not a branch point.** `scripts/verify-release.ts` compares it
against a pinned `APPROVED_RELEASE_BASE_SHA` and throws `--base-sha is not the
approved Increment 1 base` for any other value. The correct value is always
`0b92387d2e237d568d2514373dcc3044e7960d4b`. The phase-2 branch point `85fa927…` is
a *different* SHA used only for `git diff --check`.

---

## Task A — close the one open review finding

**Recommended before Task 10, because any change after the candidate SHA
invalidates the gate and forces a new exact-head run.** Skip it only if the user
says so.

`tests/worker/event-cover-publication.test.ts:468` — the test
`rechecks the retained-receipt cap in the winning acceptance statement` asserts
only `code` and `status`. Both the generic conflict (`event-cover-publication.ts`
~453) and the cap-specific one (~664) throw `COVER_PUBLICATION_CONFLICT` at 409,
so deleting the `await assertStorageCaps(env, event.id)` re-read at
`event-cover-publication.ts:658` leaves the test passing. A manager who filled the
receipt cap between the optimistic read and the serialized INSERT would then be
told to wait for a concurrent publication that does not exist, with no hint that
the daily cleanup is what unblocks them.

Add a `message` assertion pinning the cap-specific text. Confirm it is RED with
line 658 removed and GREEN with it restored before committing.

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-publication.test.ts
npm run typecheck
npm run lint
git add -- tests/worker/event-cover-publication.test.ts
git commit -F <message-file>
```

Then re-run the full pre-candidate evidence block below before Task 10, because
the candidate head has changed.

```powershell
npm run typecheck
npm run lint
npx vitest run --config vitest.config.ts
npx vitest run --config vitest.worker.config.ts
git diff --check 85fa9278b05a0af73091e17a2306b97ac2504617 HEAD
(Get-ChildItem migrations -Filter '*.sql' -File).Count
git status --short --branch
```

Expected: every command exits 0, exactly 12 migrations, clean worktree.

---

## Task 10 — fix the immutable candidate and run the release gate

**Not deployment. Not remote migration. Not staging certification. Not production
execution.**

- [ ] **Step 1: Confirm the worktree contains only phase-2-owned changes and every prior task is committed**
- [ ] **Step 2: Re-read the actual `verify:release` runner and candidate-manifest schema from this head** — do not assume its behavior from this document
- [ ] **Step 3: Record the full candidate SHA**
- [ ] **Step 4: Run the immutable aggregate gate**

```powershell
$phase2Head   = (git rev-parse HEAD).Trim()
$releaseBase  = '0b92387d2e237d568d2514373dcc3044e7960d4b'  # APPROVED_RELEASE_BASE_SHA; fixed for every phase
$phase2Branch = '85fa9278b05a0af73091e17a2306b97ac2504617'  # phase-1 tip; what phase 2 branched from
npm run verify:release -- --sha $phase2Head --base-sha $releaseBase
if ($LASTEXITCODE -ne 0) { throw 'Phase-2 release verification failed.' }
git diff --check $phase2Branch $phase2Head
if ($LASTEXITCODE -ne 0) { throw 'Phase-2 candidate has whitespace errors.' }
```

- [ ] **Step 5: Inspect the emitted manifest, prove its recorded SHA / base / migration count / gates, and commit only an allowed local evidence pointer if repository policy requires one**
- [ ] **Step 6: Stop for independent review. Do not merge, push, or deploy.**

`verify:release` imports the target commit's own dependency-free runner in a
detached temporary worktree and leaves the caller checkout untouched. It creates
local evidence only. Any code or document change after the recorded SHA
invalidates this task and requires a new exact-head run.

---

## Tasks 11 and 12 — do not start

Task 11 is staging deployment and platform conformance. Task 12 is the production
backfill that produces the zero-legacy proof. Both need a new explicit instruction.

Two things the next authorizer needs to know:

1. **Task 11 is structurally guaranteed to force a second candidate.**
   `CERTIFIED_NOT_FOUND_MATCHERS` in `worker/workflows/cover-platform.ts` is
   deliberately `[]`, so confirmed-missing recreation is disabled by construction.
   Proving a stable missing-instance discriminator requires deploying, probing the
   real platform, appending exactly one matcher, and therefore producing a new
   candidate SHA, re-running Task 10, redeploying, and repeating Task 11.
   `docs/deployment.md` documents this round trip. It is the designed path, not a
   mistake — do not try to shortcut it, and never match on `error.message`.
2. **An unresolved policy conflict sits in front of both.** The plan defers merging
   to the whole-spec landing while the spec sequences the production backfill
   *before* phase 3 is built. Whether Tasks 11–12 deploy from the unmerged
   cover-studio line or force an earlier partial integration into `main` is settled
   when Task 11 is authorized, **not by an implementing agent**. Do not resolve it
   implicitly by merging.

---

## Deliberate decisions that read as defects — do not "fix" any of these

1. **`isCertifiedWorkflowNotFound` certifies nothing.** Empty matcher registry;
   every lookup failure classifies `unknown`. See above.
2. **`complete` is not a stored purge phase.** `event_cover_purge_progress.phase`
   allows only `fences | r2 | relational`; "complete" is the row no longer existing.
3. **The non-expiring fence sentinel `9999-12-31T23:59:59.999Z` does double duty.**
   It marks an unresolved fence by exact equality *and* keeps it out of the bounded
   expiry sweep. Settling stamps `now + 31d`.
4. **`dispatch`, `launch`, and `confirm` are launcher phases, not run modes.**
   `event_cover_backfill_runs.mode` is constrained to `inventory | execute | verify`.
5. **In-flight is not the same set as nonterminal.** `LIVE_COVER_DISPATCH_STATES`
   (`creating|confirmed|resuming|restarting`) is platform capacity;
   `NONTERMINAL_COVER_BACKFILL_STATUSES` (`queued|normalizing|rendering|finalizing`)
   is ledger capacity. Collapsing them makes any run of more than 25 jobs refuse its
   own first dispatch forever. This bug was made once and fixed.
6. **`--remote` is not universal.** `d1 execute` has it; `workflows trigger` and
   `workflows instances terminate` do not — they carry `--config wrangler.jsonc` and
   never `--local`. A test asserts this.
7. **A generation mismatch in `coverRenderPreflight` writes nothing and returns
   `skipped`.** Supersession is not failure; a terminal status there poisons the
   live run.
8. **`confirmCoverBackfillDispatch` never writes the fence.** The fence's
   `updated_at` is the durable dispatch-claim clock the rolling-minute budget is
   measured from.
9. **Initial-create recovery performs no lookup at all.** The fake accessor throws
   from `lookup` to enforce it. Replaying a claim is safe because a claim is a
   commitment, not an inference from a status read.
10. **The launcher restates `0012`'s CHECK vocabularies.** `scripts/` cannot import
    `worker/db/types.ts`. A unit test parses the migration and asserts the copies.
11. **`shared/cover-dispatch.ts` must stay dependency-free.** It is loaded from
    `scripts/` by dynamic `.ts` import under Node type stripping. Any import breaks
    the launcher at runtime, not at typecheck.
12. **Artifacts and payloads are refused inside the repo unless under `output/`.**
13. **`ee41dd2` is ~6,100 lines and cannot be split.**
    `tests/worker/cleanup.test.ts` drives `restartCoverPublication` and
    `reconcileEventCoverPurge` in one interleaving assertion ("keeps a late restart
    blocked after relational cleanup removes its receipt"), so publication and
    cleanup are coupled irreducibly at file granularity. Splitting them leaves
    whichever half lands first asserting behavior the other half defines — this was
    attempted and measured red. Read that commit by concern, not top to bottom.
14. **`bf8e27b` must follow `ee41dd2`.** `worker/workflows/cover-backfill.ts`
    imports `emitCoverPlatformTelemetry` from `./cover-platform`. Reordering them
    fails typecheck.

## What the final pre-candidate review already established — do not redo it

A four-lens review ran over the whole wave at `bd5598b..c391896`: D1 guard
discipline, design-spec §9.4/§9.5/§14 conformance, privacy and phase-2 scope, and
test integrity. It surfaced 9 candidate findings; 8 went to independent adversarial
verification prompted to refute, and **none survived**. The single finding that
remains is Task A above. Per-commit greenness was executed, not inferred: every
intermediate state typechecks, lints, and passes both suites, proven by tree-hash
equality against separately gated trees.

If you want independent assurance before the gate, review the four commits
directly. Do not re-run the same four lenses.

## Gates and conventions

Run before every commit, from the worktree:

```powershell
npm run typecheck        # tsc -b --pretty false
npm run lint             # eslint . --max-warnings=0
# plus the task's focused tests
```

- **Baselines at `c391896`, all passing:** Worker **999 tests / 40 files** (~85s,
  `vitest.worker.config.ts`, real workerd). Unit **1222 tests / 50 files** (~95s,
  `vitest.config.ts`).
- Write a failing focused test before each new behavior. Documentation, generated
  artifacts, and recorded evidence are exempt.
- **Explicit staging allowlists only.** Never `git add -A`, `git add worker`, or
  `git add docs`. Verify the staged set matches the allowlist before committing.
- Commit style: a conventional-commit subject with no scope (`fix:`, `feat:`,
  `docs:`, `test:`, `refactor:`), a substantive body explaining *why* wrapped at
  ~78 characters, and a trailing
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Errors use `ApiError` with a code from the `ApiErrorCode` union in
  `shared/errors.ts`. D1 concurrency is enforced in SQL via guarded
  `db.batch([...])` — first statement carries the guard, later statements append
  `AND changes() = 1`, then check `results[0].meta.changes === 1`. Never
  read-then-write.
- `@typescript-eslint/consistent-type-imports` is an error;
  `noUncheckedIndexedAccess` is on in both projects.

## Traps that already cost time

- `.dev.vars` does not exist in either worktree. The `Missing required secrets:
  TOKEN_HMAC_KEY, …` warning on every Worker test run is benign. Do not create one.
- **`tests/unit/verify-release.test.ts` has two tests on a 5s timeout that flake
  under CPU load** (they pass 77/77 in isolation). If the full unit suite shows
  exactly those two timing out while nothing else fails, re-run that file alone
  before investigating. Do not chase it. This matters for Task 10 specifically.
- In `tests/worker/cleanup.test.ts`, several `vi.spyOn` sites call `mockRestore()`
  after an assertion with no `try/finally`, and the file has no `afterEach`;
  `vitest.worker.config.ts` sets neither `restoreMocks` nor `clearMocks`. If an
  assertion fails, the mock leaks into later tests in the same file. A confusing
  failure in `bounded cover storage sweep` is usually this — check whether an
  earlier test in the file failed first.
- `seedEventCoverGraph` in `tests/worker/helpers.ts` creates a
  `COVER_RENDER_WORKFLOW` fence at `dispatch_generation = 1` and a matching receipt,
  so a seeded graph carries an **open** fence. Any purge test must supply accessors
  that say what the platform reports — `purgeSettled()` does this.
- The plans' per-task file allowlists are not always right. Stage what actually
  changed and say so in the commit body.

## Boundaries

Do not merge, push, deploy, apply a remote migration, trigger a remote Workflow, or
mutate remote D1/R2. Do not add a migration — `migrations/` must contain exactly
twelve files at candidate time. Do not add an authentication surface, operator HTTP
route, release key, cron expression, or rate-limit binding. Do not implement any
phase-3 work (`0013`, projections, responsive delivery routes, Cover Studio
activation, `EventAppearanceCanvas`, client wiring). Do not resolve the merge
conflict described above by merging.

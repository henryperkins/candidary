# PR 33 Review Remediation and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every verified finding against pull request 33, prove the repaired album workspace in clean local and hosted environments, merge the exact reviewed commit, and deploy it safely to both production origins.

**Architecture:** Keep the existing React/Router manager workspace, Hono Worker, D1 repositories, Cloudflare Workflows, R2 export inventory, and fragment-to-cookie album-share design. Repair liveness at the repository/route boundary, bound share-session growth with an atomic D1 admission fence and indexed cleanup, preserve album capacity invariants while making **Start empty** genuinely empty, and centralize repeated UI state behavior without widening any public data contract. Migrations 0017 and 0018 remain additive and backward compatible; because neither target has applied 0018 at review time, its not-yet-deployed session indexes may be corrected in place after rechecking both remote ledgers.

**Tech Stack:** TypeScript 6, React 19, React Router 7, Hono, Cloudflare Workers/Workflows/D1/R2/Images, Vite 8, Vitest 4, Playwright 1.61, Wrangler 4.123, GitHub CLI.

**Spec:** [Album workspace end-to-end design](../specs/2026-08-23-album-workspace-end-to-end-design.md) plus the review decisions and release gates in this plan.

## Global constraints

- The reviewed PR head is `9a55a9e3a0b0b1e2adc500ae446053c6f0dd9513`; re-read the live PR head before work and never merge a different SHA without repeating review and verification.
- Preserve the user's untracked `Candidary Design System-handoff.zip` and `src/features/print/` exactly. Start implementation with `superpowers:using-git-worktrees` so no remediation commit can absorb them.
- Use test-driven development for every behavior change: add or tighten the failing test, run the narrow command and observe the expected failure, make the smallest implementation change, then rerun to green.
- Never weaken production snapshot boundaries, authorization, current-membership checks, capacity checks, or generic unavailable responses to make a test pass.
- Never print, persist in the repository, or reuse secret values. Preview and production receive independently generated album-share HMAC and encryption keys.
- Do not run `wrangler d1 migrations apply` until the exact pending filenames have been inspected. Do not edit 0018 in place if either remote ledger has applied it; in that case stop, add a reviewed 0019 containing only the new indexes, and update the migration assertions before proceeding.
- Do not use `gh pr merge --admin`. GitHub's billing lock must be cleared and all required checks must actually execute and pass.
- Production is deployed only from the merge result on `main`. Do not delete the PR branch until post-deploy verification completes.
- D1 migrations are additive and are not rolled back. A failed code deployment rolls back only the Worker version.
- Add focused JSDoc to newly introduced exported contracts and non-obvious concurrency fences. Do not bulk-add low-value docstrings merely to satisfy a third-party percentage warning that is not a repository gate.

## Verified starting state

- PR 33 changes 85 files with 14,175 additions and is reported mergeable but `UNSTABLE`.
- GitHub's six first-party jobs did not execute any steps. Every job annotation says the account is locked for billing; Smoke was skipped because Build never started.
- The Cloudflare branch-preview check failed. Both preview and production secret inventories are missing `ALBUM_SHARE_HMAC_KEY` and `ALBUM_SHARE_ENCRYPTION_KEY`.
- Preview D1 has pending migrations 0016, 0017, and 0018. Production D1 has pending migrations 0017 and 0018.
- A clean tracked checkout passes install, audit, binding verification, E2E typecheck, lint, Cloudflare build, PWA verification, Wrangler dry run, and fresh-D1 migration verification.
- Unit/UI tests pass 1,389 tests. Worker tests pass 1,314 of 1,316 and fail two album-export tests because a fixed noon snapshot boundary is now earlier than media timestamps created later on 2026-08-23.
- The current production version tag is the base `main` commit `2fde8ae9b98297aeb8498790aa3c84a2f3faa4b7`.

## Finding-to-task coverage

| Finding | Disposition | Task |
| --- | --- | --- |
| Two date-sensitive Worker failures | Normalize fixture media timestamps; keep production boundary SQL unchanged | 1 |
| Retry Workflow retained as `errored`, `terminated`, or `complete` leaves attempt queued forever | Guarded queued-to-failed reconciliation for the exact pristine retry attempt | 2 |
| **Start empty** rejects legacy pick sets above the album cap | Remove capacity guards only from the empty reconciliation path | 3 |
| Bulk favorite validation occurs before dedupe; removal branch contains a dead conditional | Validate unique IDs in the repository and use the literal removal predicate | 3 |
| Share-session ingress is unbounded; cleanup removes only 100/day; no expiry/share indexes | 2,000-live-session atomic cap, accurate `Retry-After`, two indexes, and a bounded 5,000-row sweep | 4 |
| Duplicate seven-day literal and duplicate event read in album exchange | Import the shared seconds constant and return the validated event with the credential | 4 |
| Concurrent enable/stop comment | Document linearization, retain the client generation fence, and add a concurrency regression; do not promise a link cannot be revoked after a valid response | 4 |
| `dispose()` can leave `waitForSettled()` stuck in rebasing; `discardPending()` is untested | Clear `rebasing` before emit and add direct settlement tests | 5 |
| Blocked Router destination can change while `blocker.state` remains `blocked` | Key album preparation by `blocker.location.key` and test blocked-to-blocked navigation | 5 |
| Disabled **Leave now** has no explanation; one test clicks the disabled button | Add visible/live progress copy and assert disabled state directly | 5 |
| Duplicate export labels/live-region markup; legacy export type assertions | Shared status component/constants and an optional `kind: 'complete'` normalization function | 6 |
| Gallery tile has unreachable screen-reader state text | Remove the text hidden by the button's `aria-label`; keep `aria-pressed` and action name | 6 |
| Hard-coded “50 of 50” | Generate the message from `MANAGER_BULK_SELECTION_MAX` in one helper | 6 |
| Nested state setters and announcements inside selection updaters | Pure selection transitions, followed by explicit state and announcement updates | 6 |
| `ManagerSharedGallery.live` is unused | Remove the prop and its caller argument | 6 |
| Public cover failure survives a changed `mediaId` | Key/reset cover image failure by media ID and test rerender | 6 |
| Check icon communicates removal in `SelectionTray` | Use `Minus` for removal | 6 |
| Album cookie reload always rewrites URL to `/album` | Strip only a present hash and preserve pathname/search | 6 |
| Visual evidence uses a fixed POSIX `/tmp` path | Use `testInfo.outputPath()` | 6 |
| Responsive locators interpolate unescaped captions into regexes | Use exact accessible names | 6 |
| `Set` assertions use `.toHaveLength(1)` | Assert `.size === 1` explicitly | 1 |
| Design spec says only 0018; operations/deployment say eight secrets; cleanup docs say 100/day | Correct spec, implementation plan, security, operations, deployment, and contributor guidance | 7 |
| Preview `send_email` emits a Wrangler “undefined” diagnostic despite schema-valid `name` and an explicit empty preview array | Preserve the proven empty preview topology, add a regression assertion, and document the pinned Wrangler false-positive; never add an `undefined` binding | 7 |
| GitHub checks show failure but ran zero steps | Restore billing, rerun, and require six genuinely executed green jobs | 9 |
| Remote secrets and migrations are absent | Provision preview before branch deployment and production before merge | 9–10 |
| Sourcery/large-diff limits and Amazon Q's partial scan | Use an independent whole-diff review plus the full local/hosted verification matrix | 8 |
| Third-party docstring coverage warning | Add documentation only to new exported concurrency contracts; record as non-blocking | 7–8 |

## File structure map

**Create**

- `src/features/gallery/export-control-status.tsx` — shared export state labels and the persistent live-region bridge.
- `src/features/gallery/selection-state.ts` — pure bounded selection transitions and shared capacity copy.
- `tests/unit/gallery-selection-state.test.ts` — deterministic tests for single, many, moment-toggle, and cap transitions.

**Modify: Worker and persistence**

- `worker/routes/exports.ts`
- `worker/db/exports.ts`
- `worker/db/album.ts`
- `worker/db/media.ts`
- `worker/db/album-shares.ts`
- `worker/services/album-share.ts`
- `worker/routes/album-share.ts`
- `worker/workflows/cleanup.ts`
- `shared/constants.ts`
- `migrations/0018_album_end_to_end.sql`
- `scripts/verify-fresh-d1.ts`

**Modify: frontend**

- `src/components/UnsavedSettingsPrompt.tsx`
- `src/pages/ManagerPage.tsx`
- `src/pages/AlbumSharePage.tsx`
- `src/features/settings/autosave-queue.ts`
- `src/features/gallery/AlbumExportControl.tsx`
- `src/features/gallery/GalleryExportControl.tsx`
- `src/features/gallery/GalleryMoment.tsx`
- `src/features/gallery/ManagerGalleryWorkspace.tsx`
- `src/features/gallery/ManagerPrivateGallery.tsx`
- `src/features/gallery/ManagerSharedGallery.tsx`
- `src/features/gallery/PublicAlbum.tsx`
- `src/features/gallery/SelectionTray.tsx`

**Modify: tests**

- `tests/worker/export-api.test.ts`
- `tests/worker/album-api.test.ts`
- `tests/worker/manage-api.test.ts`
- `tests/worker/album-share-api.test.ts`
- `tests/worker/cleanup.test.ts`
- `tests/worker/migration-0018.test.ts`
- `tests/unit/settings-autosave-queue.test.ts`
- `tests/unit/verify-fresh-d1.test.ts`
- `tests/unit/wrangler-environments.test.ts`
- `tests/unit/deploy-built.test.ts`
- `tests/unit/guestbook-export.test.ts`
- `tests/ui/app.test.tsx`
- `tests/ui/album-share-page.test.tsx`
- `tests/ui/album-workspace.test.tsx`
- `tests/ui/manager-settings-autosave.test.tsx`
- `tests/e2e/album-workspace.visual.spec.ts`
- `tests/e2e/manager-responsive.spec.ts`
- `tests/e2e/security.spec.ts`

**Modify: operational contract**

- `docs/superpowers/specs/2026-08-23-album-workspace-end-to-end-design.md`
- `docs/superpowers/plans/2026-08-23-album-workspace-end-to-end.md`
- `docs/deployment.md`
- `docs/operations.md`
- `docs/security.md`
- `CLAUDE.md`

---

### Task 1: Isolate the branch and restore a deterministic test baseline

**Files:**

- Modify: `tests/worker/export-api.test.ts:68-88, 1267-1341, 1801-1865`
- Modify: `tests/worker/album-share-api.test.ts:279-315, 495-517`

- [ ] **Step 1: Create an isolated remediation worktree.**

  Invoke `superpowers:using-git-worktrees`. Fetch the PR and assert that its live head is still the reviewed SHA:

  ```bash
  git fetch origin pull/33/head
  test "$(git rev-parse FETCH_HEAD)" = "9a55a9e3a0b0b1e2adc500ae446053c6f0dd9513"
  ```

  Create a local remediation branch from `origin/claude/album-workspace`. Confirm `git status --short` in the isolated worktree is empty before editing.

- [ ] **Step 2: Reproduce both time-sensitive failures before changing the fixture.**

  ```bash
  npm run test:worker -- tests/worker/export-api.test.ts -t "cross-kind retry conflict|rejects every Guestbook field"
  ```

  Expected: both tests fail with `EXPORT_EMPTY: Pick a photo before preparing an album export.` from `worker/db/exports.ts`; no production assertion is changed.

- [ ] **Step 3: Normalize source timestamps in `setAlbumSnapshotSource`.**

  Keep `timeline_at` untouched because ordering tests set it deliberately. Set `created_at`, `stored_at`, and the selected `favorited_at` to the existing fixture instant before creating a fixed-boundary export:

  ```ts
  const ALBUM_SNAPSHOT_SOURCE_AT = '2026-08-23T00:00:00.000Z';

  UPDATE media SET
    created_at = ?2,
    stored_at = ?2,
    favorited_at = CASE
      WHEN id IN (SELECT value FROM json_each(?1)) THEN ?2 ELSE NULL END
  WHERE event_id = ?3
  ```

  Tests that exercise post-boundary storage/pick behavior continue to overwrite their chosen rows after this helper runs.

- [ ] **Step 4: Make the two non-enumeration assertions portable and explicit.**

  Replace both `expect(new Set(shapes...)).toHaveLength(1)` calls with:

  ```ts
  expect(new Set(shapes.map((shape) => JSON.stringify(shape))).size).toBe(1);
  ```

- [ ] **Step 5: Prove the narrow and full Worker baseline.**

  ```bash
  npm run test:worker -- tests/worker/export-api.test.ts tests/worker/album-share-api.test.ts
  npm run test:worker
  ```

  Expected: all Worker tests pass, including the two previously failing tests.

- [ ] **Step 6: Commit the deterministic baseline.**

  ```bash
  git add tests/worker/export-api.test.ts tests/worker/album-share-api.test.ts
  git commit -m "test: make album export snapshots deterministic"
  ```

---

### Task 2: Reconcile terminal retry Workflows without stranding exports

**Files:**

- Modify: `tests/worker/export-api.test.ts:644-1081`
- Modify: `worker/db/exports.ts:723-784`
- Modify: `worker/routes/exports.ts:72-138, 349-371`

- [ ] **Step 1: Add failing terminal-retry tests.**

  Add a table-driven route test for `errored`, `terminated`, and `complete` retained Workflow statuses. For each status, make retry `createBatch` throw, make `workflow.get(id).status()` return the terminal status, and assert:

  - the deterministic Workflow ID is `${job.id}-2`;
  - the response is 202 with attempt 2 in `failed` state;
  - D1 stores `EXPORT_WORKFLOW_DISPATCH_FAILED`;
  - no export parts exist for the pristine attempt;
  - a subsequent retry advances to attempt 3 and can dispatch.

  Add a race test in which the Workflow claims attempt 2 (`queued` to `running`) before the repository's failure fence. Assert that the guarded failure update loses and the response reports `running`.

- [ ] **Step 2: Run the new tests and observe the liveness defect.**

  ```bash
  npm run test:worker -- tests/worker/export-api.test.ts -t "terminal retry Workflow|retry claim wins"
  ```

  Expected: terminal statuses currently return a queued attempt or the new failure expectation fails.

- [ ] **Step 3: Add an exact-attempt repository fence.**

  Add the documented public method:

  ```ts
  async markRetryDispatchFailed(
    id: string,
    attempt: number,
    errorCode: string,
  ): Promise<{ changed: boolean; job: ExportRecord | null }>
  ```

  Its update must require `state = 'queued'`, the exact `attempt`, `attempt > 1`, null error/object/manifest/Guestbook artifact/timing fields, zero parts, and no `export_parts` rows. It must not overwrite a Workflow that already claimed or populated the attempt.

- [ ] **Step 4: Make retry dispatch return an outcome and reconcile it.**

  Change `ensureRetryWorkflow` to return `'dispatched' | 'failed'`. A successful create is dispatched; after a failed create, `errored`, `terminated`, and `complete` are failed; any other observable retained status is dispatched; `unknown` or an unobservable lookup preserves the existing recoverable error path.

  In the retry route, make `job` mutable, apply `markRetryDispatchFailed` on a proven terminal outcome, then return the repository winner. Keep deletion of prior-attempt R2 keys after the dispatch/reconciliation decision so an ambiguous failure still retains them for replay.

- [ ] **Step 5: Run focused liveness and existing idempotency tests.**

  ```bash
  npm run test:worker -- tests/worker/export-api.test.ts -t "Workflow|retry|attempt-specific"
  npm run test:worker -- tests/worker/export-api.test.ts
  ```

  Expected: terminal attempts fail durably, ambiguous attempts remain replayable on the same ID, concurrent retries converge, and a claimed attempt wins the failure fence.

- [ ] **Step 6: Commit the export repair.**

  ```bash
  git add worker/db/exports.ts worker/routes/exports.ts tests/worker/export-api.test.ts
  git commit -m "fix: reconcile terminal export retry workflows"
  ```

---

### Task 3: Make Start empty unconditional and simplify bulk pick semantics

**Files:**

- Modify: `tests/worker/album-api.test.ts:598-620`
- Modify: `tests/worker/manage-api.test.ts:620-770`
- Modify: `worker/db/album.ts:368-471`
- Modify: `worker/db/media.ts:630-669`

- [ ] **Step 1: Split the legacy-over-cap start matrix into two explicit contracts.**

  Keep a `from-picks` test that expects `ALBUM_FULL` and no mutation. Add an `empty` test with `ALBUM_MAX_ENTRIES + 1` legacy picks that expects 200, `started: true`, every ID returned in `cleared`, a saved empty album, and zero remaining favorites.

- [ ] **Step 2: Add a duplicate-ID bulk pick regression.**

  Exercise the `/album/picks` route with repeated copies of the same valid ID. Assert one changed row, one favorite transition, and the existing raw request-size ceiling. Add a repository-level assertion that unique IDs—not duplicate occurrences—drive its defensive capacity check.

- [ ] **Step 3: Run the tests and observe the current failures.**

  ```bash
  npm run test:worker -- tests/worker/album-api.test.ts -t "legacy set above|Start empty"
  npm run test:worker -- tests/worker/manage-api.test.ts -t "duplicate.*album pick"
  ```

  Expected: the over-cap empty request returns `ALBUM_FULL`; the repository semantics test exposes validation before dedupe.

- [ ] **Step 4: Remove capacity predicates only from the empty path.**

  In `AlbumRepository.start`, retain `saved_at IS NULL` on both empty-path updates but remove the pick-count `<= ALBUM_MAX_ENTRIES` predicates from the media clear and album save. Raise the over-cap diagnostic only when `choice === 'from-picks'`. Preserve the batch and stale-retry fence, so a later pick cannot be cleared after another request has saved the album.

- [ ] **Step 5: Dedupe before repository validation and remove dead SQL selection.**

  In `MediaRepository.setFavoriteBulk`, build `unique` before checking its length. After the non-null add branch returns, use `favorited_at IS NOT NULL` directly for removal instead of a conditional whose alternative cannot execute. Keep the route's raw-array maximum to bound request parsing.

- [ ] **Step 6: Prove capacity, concurrency, undo, and duplicate behavior.**

  ```bash
  npm run test:worker -- tests/worker/album-api.test.ts tests/worker/manage-api.test.ts
  ```

  Expected: from-picks still refuses 501 entries, empty clears 501 entries atomically, stale empty retries cannot clear later picks, and duplicates change one row.

- [ ] **Step 7: Commit the album semantics repair.**

  ```bash
  git add worker/db/album.ts worker/db/media.ts tests/worker/album-api.test.ts tests/worker/manage-api.test.ts
  git commit -m "fix: let legacy albums start empty"
  ```

---

### Task 4: Bound album-share sessions and prove revocation linearization

**Files:**

- Modify: `shared/constants.ts:39-47`
- Modify: `migrations/0018_album_end_to_end.sql:15-24`
- Modify: `worker/db/album-shares.ts:98-132`
- Modify: `worker/services/album-share.ts:21-189`
- Modify: `worker/routes/album-share.ts:40-51`
- Modify: `worker/workflows/cleanup.ts:113-123`
- Modify: `scripts/verify-fresh-d1.ts:220-276`
- Modify: `tests/worker/migration-0018.test.ts:97-142`
- Modify: `tests/unit/verify-fresh-d1.test.ts:251-299`
- Modify: `tests/worker/album-share-api.test.ts:201-426`
- Modify: `tests/worker/cleanup.test.ts:5101-5138`

- [ ] **Step 1: Reconfirm that 0018 is unapplied in both remote environments.**

  ```bash
  npx wrangler d1 migrations list candidary-preview-core --remote --env preview --config wrangler.jsonc
  npx wrangler d1 migrations list candidary-core --remote --config wrangler.jsonc
  ```

  Expected at this point: preview lists 0016–0018 pending and production lists 0017–0018 pending. If 0018 is no longer pending in either output, follow the global constraint and add 0019 instead of editing deployed history.

- [ ] **Step 2: Add failing schema and capacity tests.**

  Require these indexes in migration and fresh-D1 tests:

  ```sql
  CREATE INDEX event_album_share_sessions_expiry
    ON event_album_share_sessions(expires_at, id);
  CREATE INDEX event_album_share_sessions_share_expiry
    ON event_album_share_sessions(share_id, expires_at, id);
  ```

  Remove the redundant `(id, share_id, event_id)` index expectation because `id` is already the primary key.

  Add API tests that seed 1,999 active sessions, race two exchanges, and assert exactly one 200, one 429, and exactly 2,000 active rows. Assert the 429 has an accurate positive `Retry-After`. Add a case proving expired rows do not consume the active cap.

- [ ] **Step 3: Add failing cleanup and lifetime tests.**

  Replace the one-page cleanup expectation with 250 expired plus one future row; expect all 250 expired rows deleted in one scheduled invocation and the future row retained. Add a boundedness case with 5,001 expired rows; expect exactly 5,000 removed and one left. Assert session expiry derives from `ALBUM_SHARE_SESSION_SECONDS` rather than another seven-day literal.

- [ ] **Step 4: Run the new tests and observe the defects.**

  ```bash
  npm run test:worker -- tests/worker/migration-0018.test.ts tests/worker/album-share-api.test.ts tests/worker/cleanup.test.ts
  npm run test:unit -- tests/unit/verify-fresh-d1.test.ts
  ```

  Expected: index assertions, capacity admission, and multi-page cleanup fail against the current implementation.

- [ ] **Step 5: Define the bounded session contract.**

  Add these single-source constants with explanatory comments:

  ```ts
  export const ALBUM_SHARE_MAX_ACTIVE_SESSIONS = 2_000;
  export const ALBUM_SHARE_SESSION_CLEANUP_BATCH = 100;
  export const ALBUM_SHARE_SESSION_CLEANUP_MAX_BATCHES = 50;
  ```

  The 2,000 cap supports the 500-guest event ceiling with four devices per guest. The cleanup invocation is capped at 5,000 deletes, so it is bounded while draining more than one maximum live generation per day.

- [ ] **Step 6: Implement atomic admission in `AlbumSharesRepository`.**

  Replace unconditional `createSession` with a documented bounded insert whose `INSERT … SELECT` succeeds only when the share still exists and the live count for that share is below the limit. In the same D1 batch, return whether the share exists and the earliest live expiry. Expose a typed result:

  ```ts
  interface AlbumShareSessionAdmission {
    created: boolean;
    shareExists: boolean;
    retryAt: string | null;
  }
  ```

  Count `expires_at > activeAt`, so naturally expired rows never block a legitimate exchange. The one D1 batch is the concurrency linearization point.

- [ ] **Step 7: Remove duplicate reads/literals and surface capacity correctly.**

  Import `ALBUM_SHARE_SESSION_SECONDS`; compute milliseconds from it. Make `credential` return both the verified share and the active event so exchange does not read the event twice. When admission says the share disappeared, return the existing generic `ALBUM_SHARE_UNAVAILABLE`. When the valid share is at capacity, throw a typed 429 carrying seconds until `retryAt`; the route sets that exact `Retry-After` before rethrowing.

- [ ] **Step 8: Drain expired sessions in bounded pages.**

  Loop `deleteExpiredSessions(now, 100)` for at most 50 batches, accumulating the total and stopping on a short page. Return the accumulated count. Keep the scheduled cleanup's other classes independent.

- [ ] **Step 9: Harden and close the enable/stop race finding.**

  Add a repository/service concurrency test that pauses an enable read while stop deletes the row. Assert one valid linearization: either enable returns the share observed before the later stop and that link is then unavailable, or enable observes revocation and returns unavailable—never a 500 and never resurrection of the deleted credential. Preserve `ManagerAlbum`'s existing `shareRequestGeneration`/`shareOperationPending` client fence.

  Add a service comment stating that a returned link can be revoked by a later concurrent operation, exactly like any authorization credential; no server can guarantee post-response liveness.

- [ ] **Step 10: Prove schema, abuse, cleanup, revocation, and projection behavior.**

  ```bash
  npm run test:worker -- tests/worker/migration-0018.test.ts tests/worker/album-share-api.test.ts tests/worker/cleanup.test.ts
  npm run test:unit -- tests/unit/verify-fresh-d1.test.ts
  npm run verify:fresh-d1
  ```

  Expected: exact cap under concurrent ingress, accurate retry timing, current-membership authorization, generic invalid/revoked responses, full 250-row drain, 5,000-row ceiling, and both new indexes.

- [ ] **Step 11: Commit the session-retention repair.**

  ```bash
  git add shared/constants.ts migrations/0018_album_end_to_end.sql worker/db/album-shares.ts worker/services/album-share.ts worker/routes/album-share.ts worker/workflows/cleanup.ts scripts/verify-fresh-d1.ts tests/worker/migration-0018.test.ts tests/unit/verify-fresh-d1.test.ts tests/worker/album-share-api.test.ts tests/worker/cleanup.test.ts
  git commit -m "fix: bound album share session retention"
  ```

---

### Task 5: Settle autosave disposal and changing blocked destinations

**Files:**

- Modify: `tests/unit/settings-autosave-queue.test.ts:267-370`
- Modify: `src/features/settings/autosave-queue.ts:267-313`
- Modify: `tests/ui/app.test.tsx:2370-2474`
- Modify: `tests/ui/manager-settings-autosave.test.tsx:448-495`
- Modify: `src/pages/ManagerPage.tsx:254-298, 1177-1188`
- Modify: `src/components/UnsavedSettingsPrompt.tsx:5-53`

- [ ] **Step 1: Add direct autosave settlement regressions.**

  Add one test that puts the queue in `rebasing`, calls `waitForSettled()`, then calls `dispose()` and expects the waiter to resolve instead of hanging. Add another that queues scheduled and pending drafts behind an in-flight request, calls `discardPending()`, resolves the in-flight request, and asserts no discarded draft is sent and the waiter settles.

- [ ] **Step 2: Add a blocked-to-blocked Router regression.**

  Start an Album `prepareToLeave` for `/privacy`, then issue a second blocked navigation to a different route key before the first preparation resolves. Assert the first completion cannot proceed to either destination, the second destination triggers a fresh Album preparation, and only the second matching result may proceed.

- [ ] **Step 3: Tighten the disabled-button test.**

  In the rejected-conflict test, replace the click on disabled **Leave now** with `expect(leaveNow).toBeDisabled()`. Assert visible text explains that Album changes are still being checked and that the current route remains mounted.

- [ ] **Step 4: Run the tests and observe failures.**

  ```bash
  npm run test:unit -- tests/unit/settings-autosave-queue.test.ts
  npm run test:unit -- tests/ui/app.test.tsx tests/ui/manager-settings-autosave.test.tsx
  ```

  Expected: dispose settlement and changing-destination tests fail; the prompt has no progress explanation.

- [ ] **Step 5: Clear rebase ownership on disposal.**

  In `dispose()`, set `rebasing = false` before `emit()`. Do not cancel an already-sent request. Preserve `discardPending()`'s current clearing of `latest`, scheduled, pending, failure, and rebasing state.

- [ ] **Step 6: Key preparation by the blocked location.**

  Make the preparation effect depend on `blockedNavigationKey`, not only `blocker.state`. Continue using the generation ref and compare the result's navigation key before calling `blocker.proceed()`.

- [ ] **Step 7: Explain the temporary disabled state accessibly.**

  When `leaveDisabled` is true, render visible status copy such as “Finishing Album checks before Leave now is available.” Associate it with the prompt/button and use the persistent prompt region so screen readers receive the state without focus movement.

- [ ] **Step 8: Prove the full autosave/navigation contract.**

  ```bash
  npm run test:unit -- tests/unit/settings-autosave-queue.test.ts tests/ui/app.test.tsx tests/ui/manager-settings-autosave.test.tsx
  ```

  Expected: no stranded waiter, no post-discard send, no stale navigation completion, and clear disabled-state copy.

- [ ] **Step 9: Commit the navigation repair.**

  ```bash
  git add src/features/settings/autosave-queue.ts src/pages/ManagerPage.tsx src/components/UnsavedSettingsPrompt.tsx tests/unit/settings-autosave-queue.test.ts tests/ui/app.test.tsx tests/ui/manager-settings-autosave.test.tsx
  git commit -m "fix: settle album navigation guards"
  ```

---

### Task 6: Close UI, accessibility, URL, and E2E maintainability findings

**Files:**

- Create: `src/features/gallery/export-control-status.tsx`
- Create: `src/features/gallery/selection-state.ts`
- Create: `tests/unit/gallery-selection-state.test.ts`
- Modify: `src/features/gallery/AlbumExportControl.tsx:1-95`
- Modify: `src/features/gallery/GalleryExportControl.tsx:1-115`
- Modify: `src/features/gallery/GalleryMoment.tsx:93-111`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx:1-21, 167-174, 214-269`
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx:479-555`
- Modify: `src/features/gallery/ManagerSharedGallery.tsx:41-99`
- Modify: `src/features/gallery/PublicAlbum.tsx:18-67`
- Modify: `src/features/gallery/SelectionTray.tsx:1-50`
- Modify: `src/pages/AlbumSharePage.tsx:45-90`
- Modify: `tests/unit/guestbook-export.test.ts`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/album-share-page.test.tsx:69-293`
- Modify: `tests/e2e/album-workspace.visual.spec.ts:1-88, 137-328`
- Modify: `tests/e2e/manager-responsive.spec.ts:441-510`
- Modify: `tests/e2e/security.spec.ts:129-180`

- [ ] **Step 1: Add failing tests for shared export rendering and legacy type normalization.**

  Assert both export controls use the same label for every `ExportView['state']`, retain one persistent live region, and normalize a legacy complete-export object without `kind` to `{ kind: 'complete' }` before calling download/retry. The test must compile without `as ExportView` at the call site.

- [ ] **Step 2: Add pure selection-transition tests.**

  Cover select, deselect, select-many, whole-moment clear, cap truncation, and a capacity message generated from `MANAGER_BULK_SELECTION_MAX`. Assert transition helpers return new sets/messages and perform no React state writes.

- [ ] **Step 3: Add public album and URL regressions.**

  In `album-share-page.test.tsx`, fail the current cover, rerender with a different `coverMediaId`, and assert the new cover renders an `<img>`. Start at `/album?source=email#token` and assert the scrubbed URL is `/album?source=email`; on a cookie-only `/album?source=email` reload, assert `replaceState` is not called.

- [ ] **Step 4: Add/adjust accessibility assertions.**

  Assert the gallery pick button's accessible name and `aria-pressed` expose membership without a redundant hidden “In the album” string. Assert the selection tray uses a removal glyph whose semantics do not imply completion. Assert removing `live` from `ManagerSharedGallery` leaves the workspace's single live host intact.

- [ ] **Step 5: Run the narrow UI tests and observe failures.**

  ```bash
  npm run test:unit -- tests/unit/guestbook-export.test.ts tests/unit/gallery-selection-state.test.ts tests/ui/album-workspace.test.tsx tests/ui/album-share-page.test.tsx
  ```

  Expected: shared utility, selection purity, changed-cover reset, and URL-preservation expectations fail before implementation.

- [ ] **Step 6: Extract the shared export status contract.**

  `export-control-status.tsx` owns:

  ```ts
  export const EXPORT_STATE_LABELS: Record<ExportView['state'], string>;

  export function ExportStatusAnnouncement(props: {
    live: boolean;
    message: string;
    onAnnouncement?(message: string): void;
  }): ReactElement;
  ```

  Both controls consume it. Define the legacy complete type as `Omit<ExportView, 'kind'> & { kind?: 'complete' }` and normalize it through a real function returning `ExportView`; remove both assertions.

- [ ] **Step 7: Move selection calculations outside React updaters.**

  Put the bounded set transformations in `selection-state.ts`. In `ManagerPrivateGallery`, keep an authoritative `selectedIdsRef` that is advanced synchronously by one `commitSelection(action)` helper and reset whenever selection is cleared. The helper calculates the pure transition, updates the ref, then calls `setSelectedIds(transition.next)` and `setAnnouncement(transition.message)` separately. Consecutive events therefore cannot use a stale rendered set. Change `toggleSelecting` so `clearSelection()` is not invoked from inside a `setSelecting` updater. This keeps updater functions pure and StrictMode-safe.

- [ ] **Step 8: Apply the remaining component corrections.**

  - Remove the hidden album-state span from `GalleryMoment`; retain the action-oriented `aria-label` and `aria-pressed`.
  - Import/use the capacity-copy helper in `ManagerGalleryWorkspace` instead of “50 of 50”.
  - Remove the unused `live` prop from `ManagerSharedGallery` and its caller.
  - Key the cover `AlbumImage` by `album.coverMediaId` (or key failure state by `mediaId`) so a new source resets failure.
  - Replace `Check` with `Minus` for **Remove n from album**.
  - In `AlbumSharePage`, call `replaceState` only when a token-bearing hash is present, using `${window.location.pathname}${window.location.search}`.

- [ ] **Step 9: Make visual evidence portable.**

  Remove `node:fs/promises`, `evidenceRoot`, and manual directory creation from `album-workspace.visual.spec.ts`. Pass `testInfo` into `capture` and use:

  ```ts
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: false,
  });
  ```

  Update each call mechanically.

- [ ] **Step 10: Replace caption regex interpolation with exact names.**

  For all three responsive locators, use the actual accessible name:

  ```ts
  page.getByRole('button', {
    name: `Select ${row.caption}, from ${row.guestName}`,
    exact: true,
  })
  ```

  This remains correct when captions contain regex metacharacters.

- [ ] **Step 11: Run UI, type, and focused browser verification.**

  ```bash
  npm run test:unit -- tests/unit/guestbook-export.test.ts tests/unit/gallery-selection-state.test.ts tests/ui/album-workspace.test.tsx tests/ui/album-share-page.test.tsx
  npm run typecheck:e2e
  npx playwright test tests/e2e/manager-responsive.spec.ts tests/e2e/security.spec.ts tests/e2e/album-workspace.visual.spec.ts --project=desktop --project=mobile
  ```

  Expected: exact locators pass with punctuation, evidence lands below Playwright's configured output, token fragments are scrubbed without dropping search parameters, and the accessibility/live-region assertions remain green.

- [ ] **Step 12: Commit the UI quality pass.**

  ```bash
  git add src/features/gallery/export-control-status.tsx src/features/gallery/selection-state.ts src/features/gallery/AlbumExportControl.tsx src/features/gallery/GalleryExportControl.tsx src/features/gallery/GalleryMoment.tsx src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/ManagerPrivateGallery.tsx src/features/gallery/ManagerSharedGallery.tsx src/features/gallery/PublicAlbum.tsx src/features/gallery/SelectionTray.tsx src/pages/AlbumSharePage.tsx tests/unit/gallery-selection-state.test.ts tests/unit/guestbook-export.test.ts tests/ui/album-workspace.test.tsx tests/ui/album-share-page.test.tsx tests/e2e/album-workspace.visual.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/security.spec.ts
  git commit -m "fix: polish album workspace state and accessibility"
  ```

---

### Task 7: Align schema, security, operations, and deployment documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-08-23-album-workspace-end-to-end-design.md:252-315`
- Modify: `docs/superpowers/plans/2026-08-23-album-workspace-end-to-end.md:70-130, 250-310, 630-637`
- Modify: `docs/deployment.md:1-138`
- Modify: `docs/operations.md:91-125, 338-348`
- Modify: `docs/security.md:134-165`
- Modify: `CLAUDE.md`
- Modify: `tests/unit/wrangler-environments.test.ts`
- Modify: `tests/unit/deploy-built.test.ts`

- [ ] **Step 1: Correct the migration history.**

  State that this scope uses two ordered additive migrations: 0017 creates the curated album/order foundation and 0018 adds metadata, sharing, sessions, and album-export snapshot fields. Update the schema snippets to show both session indexes and remove the redundant lookup index.

- [ ] **Step 2: Document the bounded session model.**

  Record the 2,000 active-session cap per share, expired-row exclusion, accurate 429 `Retry-After`, 100-row cleanup batch, 50-batch invocation ceiling, revocation cascade, and enable/stop linearization. Update the original implementation plan so it no longer claims cleanup deletes at most 100/day.

- [ ] **Step 3: Correct the secret inventory everywhere.**

  Change “eight application secrets” to ten and list both album keys in preview and production provisioning. Specify at least 32 random bytes for HMAC and exactly 32 decoded base64url bytes for AES-256-GCM. State that preview and production values are independent and that binding verification proves names, not remote material.

- [ ] **Step 4: Make migration-before-deploy ordering explicit.**

  Update `docs/deployment.md` to say automatic Cloudflare builds do not apply D1 migrations. For a migration-bearing release, require: inspect pending ledger, provision required secrets, apply additive preview migrations, verify preview, provision/apply production prerequisites, then merge so the new Worker never runs against old schema.

- [ ] **Step 5: Record the Wrangler email diagnostic accurately.**

  Extend config/deploy tests to assert production generates `send_email: [{ name: 'EMAIL' }]` and preview generates `send_email: []`. Document that Wrangler 4.123 emits a false “undefined” non-inheritance warning even though the pinned schema requires `name`; the invariant is the generated preview topology. Do not add a fake email binding or rename the schema-valid field.

- [ ] **Step 6: Resolve review-tool meta-findings.**

  Record in the release notes/PR summary that large-diff review limits are covered by an independent whole-diff review and the full verification matrix. Add focused JSDoc to the new repository admission/failure-fence interfaces; explicitly decline a bulk docstring-only rewrite because it is not a codebase gate and would obscure the concurrency contracts that matter.

- [ ] **Step 7: Verify documentation and config assertions.**

  ```bash
  npm run test:unit -- tests/unit/wrangler-environments.test.ts tests/unit/deploy-built.test.ts tests/unit/verify-fresh-d1.test.ts
  npm run verify:bindings
  rg -n "eight application secrets|only migration|at most 100.*expired session|event_album_share_sessions_lookup" docs CLAUDE.md scripts tests migrations
  ```

  Expected: tests pass and the search finds no stale claim except an explicitly quoted historical/review explanation in this remediation plan.

- [ ] **Step 8: Commit the operational contract.**

  ```bash
  git add docs/superpowers/specs/2026-08-23-album-workspace-end-to-end-design.md docs/superpowers/plans/2026-08-23-album-workspace-end-to-end.md docs/deployment.md docs/operations.md docs/security.md CLAUDE.md tests/unit/wrangler-environments.test.ts tests/unit/deploy-built.test.ts
  git commit -m "docs: gate the album workspace release"
  ```

---

### Task 8: Run the complete verification and independent review gate

**Files:**

- Verify: all files changed by PR 33 plus remediation commits
- Update only if a test/reviewer finds a concrete defect

- [ ] **Step 1: Install exactly the locked dependency graph in the isolated worktree.**

  ```bash
  npm ci
  npm audit --omit=dev
  ```

  Expected: audit reports zero production vulnerabilities.

- [ ] **Step 2: Run all static, unit, Worker, migration, and build checks.**

  ```bash
  npm run verify:bindings
  npm run typecheck:e2e
  npm run lint
  npm test
  CI_BASE_SHA="$(git merge-base origin/main HEAD)" CI_HEAD_SHA="$(git rev-parse HEAD)" npm run ci:migrations
  WORKERS_CI_BRANCH=claude/album-workspace npm run build:cloudflare
  npm run verify:pwa-build
  npx wrangler deploy --dry-run --strict --config dist/candidary/wrangler.json --outdir output/wrangler-dry-run
  npm run test:smoke
  ```

  Expected: every command exits 0. The local clean build may warn that secret values are absent; it must still generate all ten required names. The documented Wrangler email diagnostic may appear, but generated preview `send_email` must remain empty.

- [ ] **Step 3: Run the complete Playwright matrix.**

  ```bash
  npm run test:e2e
  ```

  Expected: all configured desktop/mobile tests pass; visual artifacts live under the configured Playwright output directory.

- [ ] **Step 4: Scan the completed diff for accidental placeholders and hygiene failures.**

  ```bash
  git diff --check origin/main...HEAD
  git diff --name-only origin/main...HEAD | xargs rg -n "TODO|FIXME|XXX|NotImplemented|placeholder" -- || true
  git status --short
  ```

  Expected: no whitespace errors, no newly introduced implementation placeholders, and a clean isolated worktree.

- [ ] **Step 5: Request an independent whole-diff review.**

  Invoke `superpowers:requesting-code-review`. Require the reviewer to inspect at least:

  - exact-attempt export failure fences and claim races;
  - session admission atomicity, indexes, cleanup ceiling, enumeration behavior, and revocation;
  - Start empty/stale retry invariants;
  - autosave/navigation generation handling;
  - fragment scrubbing and public projection;
  - remote migration/secret ordering and rollback.

  Resolve every critical/important finding with another red-green cycle. For suggestions not changed, record an evidence-backed disposition in the PR summary.

- [ ] **Step 6: Record the reviewed remediation head.**

  ```bash
  git status --short
  git rev-parse HEAD
  git log --oneline origin/claude/album-workspace..HEAD
  ```

  Expected: the isolated worktree is clean and the output contains only the planned remediation commits. Record this SHA for the push and hosted checks in Task 9.

---

### Task 9: Provision preview, publish the reviewed head, and restore hosted CI

**Files:** none; these are remote environment and GitHub checks.

- [ ] **Step 1: Verify Cloudflare identity and names-only secret state.**

  ```bash
  npx wrangler whoami
  npx wrangler secret list --env preview --config wrangler.jsonc
  ```

  Expected: the intended Henry Flare account; the list contains no values. Stop if the account or Worker target is unexpected.

- [ ] **Step 2: Generate and pipe independent preview secrets without displaying them.**

  Ensure shell tracing is off, then run each pipeline independently:

  ```bash
  node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_HMAC_KEY --env preview --config wrangler.jsonc
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_ENCRYPTION_KEY --env preview --config wrangler.jsonc
  npx wrangler secret list --env preview --config wrangler.jsonc
  ```

  Expected: the names-only list contains all ten required secrets.

- [ ] **Step 3: Apply and verify preview migrations.**

  ```bash
  npx wrangler d1 migrations list candidary-preview-core --remote --env preview --config wrangler.jsonc
  npx wrangler d1 migrations apply candidary-preview-core --remote --env preview --config wrangler.jsonc
  npx wrangler d1 migrations list candidary-preview-core --remote --env preview --config wrangler.jsonc
  ```

  Expected: the first list contains exactly 0016–0018 pending; the apply succeeds; the final list has no pending migrations.

- [ ] **Step 4: Clear the GitHub Actions account lock.**

  Restore the repository owner's GitHub billing/account status before publishing the reviewed head. The old annotations must no longer say “The job was not started because your account is locked due to a billing issue.” This is an external account prerequisite, not a code change and not a reason to bypass checks.

- [ ] **Step 5: Push the reviewed remediation to the PR branch.**

  ```bash
  git fetch origin claude/album-workspace
  test "$(git rev-parse origin/claude/album-workspace)" = "9a55a9e3a0b0b1e2adc500ae446053c6f0dd9513"
  git push origin HEAD:claude/album-workspace
  test "$(gh pr view 33 --json headRefOid --jq .headRefOid)" = "$(git rev-parse HEAD)"
  ```

  Expected: a fast-forward push only; the PR head is the exact locally reviewed SHA, with no unrelated user files.

- [ ] **Step 6: Wait for and verify the branch preview.**

  ```bash
  gh pr checks 33 --watch
  npx wrangler versions list --name candidary-preview --env preview --config wrangler.jsonc --json
  ```

  Confirm the newest preview version metadata/tag equals the pushed PR SHA. Open the preview URL reported by the Cloudflare check and verify `/`, `/album`, `robots.txt`, and an invalid `/api/album-share/exchange` request. The invalid exchange must return the generic unavailable response with `private, no-store` and must not echo the credential.

- [ ] **Step 7: Inspect the new GitHub workflow run.**

  Find and watch the workflow run created for the pushed PR head:

  ```bash
  CURRENT_HEAD="$(git rev-parse HEAD)"
  CURRENT_RUN_ID="$(gh run list --workflow CI --branch claude/album-workspace --event pull_request --limit 10 --json databaseId,headSha --jq ".[] | select(.headSha == \"$CURRENT_HEAD\") | .databaseId" | head -n 1)"
  test -n "$CURRENT_RUN_ID"
  gh run watch "$CURRENT_RUN_ID" --exit-status
  gh run view "$CURRENT_RUN_ID"
  gh pr checks 33
  ```

  Inspect job steps with `gh run view --job`; do not accept a green/skipped shell that executed zero steps.

- [ ] **Step 8: Require all hosted gates to be green.**

  Expected: Quality, Unit and UI, Worker, Build, Smoke, Migration safety, and the Cloudflare preview check all pass against the same PR head. Any failure returns to the relevant task; no admin bypass.

---

### Task 10: Provision production, merge the exact head, and observe automatic deployment

**Files:** none; these are remote durable-state, merge, and deployment operations.

- [ ] **Step 1: Capture the rollback target before changing production.**

  ```bash
  npx wrangler deployments list --name candidary --config wrangler.jsonc --json > /tmp/candidary-pre-pr33-deployments.json
  npx wrangler versions list --name candidary --config wrangler.jsonc --json > /tmp/candidary-pre-pr33-versions.json
  PRE_RELEASE_VERSION_ID="$(node -e "const fs=require('node:fs');const rows=JSON.parse(fs.readFileSync('/tmp/candidary-pre-pr33-deployments.json','utf8'));rows.sort((a,b)=>Date.parse(a.created_on)-Date.parse(b.created_on));const active=rows.at(-1)?.versions.find((item)=>item.percentage===100);if(active)process.stdout.write(active.version_id)")"
  test -n "$PRE_RELEASE_VERSION_ID"
  printf '%s\n' "$PRE_RELEASE_VERSION_ID" > /tmp/candidary-pre-pr33-version-id
  ```

  Read and record the currently deployed production version ID and confirm its tag is `2fde8ae9b98297aeb8498790aa3c84a2f3faa4b7` (or deliberately investigate any newer deployment before continuing). These files contain IDs/metadata, not secret values.

- [ ] **Step 2: Provision independent production album-share secrets.**

  ```bash
  node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_HMAC_KEY --config wrangler.jsonc
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_ENCRYPTION_KEY --config wrangler.jsonc
  npx wrangler secret list --config wrangler.jsonc
  ```

  Expected: the production names-only list contains all ten required secrets. Never reuse the preview values.

- [ ] **Step 3: Apply and verify production migrations before new code can deploy.**

  ```bash
  npx wrangler d1 migrations list candidary-core --remote --config wrangler.jsonc
  npx wrangler d1 migrations apply candidary-core --remote --config wrangler.jsonc
  npx wrangler d1 migrations list candidary-core --remote --config wrangler.jsonc
  ```

  Expected: the first list contains exactly 0017 and 0018 pending; both additive migrations apply; the final list has no pending migrations. The old Worker remains compatible throughout.

- [ ] **Step 4: Recheck the immutable merge gate.**

  ```bash
  PR_HEAD="$(gh pr view 33 --json headRefOid --jq .headRefOid)"
  test "$PR_HEAD" = "$(git rev-parse HEAD)"
  test "$(gh pr view 33 --json mergeable --jq .mergeable)" = "MERGEABLE"
  gh pr checks 33
  ```

  Expected: the live PR head is the independently reviewed local head and every required check is green.

- [ ] **Step 5: Merge without deleting the branch.**

  ```bash
  gh pr merge 33 --merge --match-head-commit "$PR_HEAD"
  gh pr view 33 --json state,mergedAt,mergeCommit
  ```

  Expected: state `MERGED` and a recorded merge commit on `main`.

- [ ] **Step 6: Verify the merged tree in a fresh clean checkout.**

  Fetch `origin/main`, create a fresh temporary clone/worktree at the merge commit, and run:

  ```bash
  npm ci
  npm test
  npm run build:cloudflare
  npm run verify:pwa-build
  ```

  Expected: the merged tree—not the PR worktree—passes.

- [ ] **Step 7: Observe the one automatic production deployment.**

  Do not run `npm run deploy` while the connected Cloudflare `main` build is active. Wait for the Cloudflare production check/build to complete, then run:

  ```bash
  npx wrangler deployments list --name candidary --config wrangler.jsonc --json
  npx wrangler versions list --name candidary --config wrangler.jsonc --json
  ```

  Expected: the active deployment's version tag equals the GitHub merge commit SHA. If the connected build fails and no deployment is active, diagnose it; only then may `npm run deploy` be used from the clean `main` checkout.

---

### Task 11: Run production smoke checks and close or roll back

**Files:** none unless a concrete post-deploy defect requires a new PR.

- [ ] **Step 1: Verify both public origins and discovery controls.**

  ```bash
  curl --fail --silent --show-error --head https://candidary.app/
  curl --fail --silent --show-error --head https://candidary.online/
  curl --fail --silent --show-error https://candidary.app/robots.txt
  curl --fail --silent --show-error https://candidary.app/sitemap.xml
  ```

  Expected: both origins are healthy; robots disallows `/api/`, `/manage/`, `/join`, and `/album`; the sitemap contains only public pages.

- [ ] **Step 2: Verify the private album refusal boundary without creating production data.**

  Send a same-origin POST with a deliberately invalid token to `/api/album-share/exchange`. Expect HTTP 410, `Cache-Control: private, no-store`, code `ALBUM_SHARE_UNAVAILABLE`, the generic message, and no echoed token. Open `/album` in a browser and confirm the page sets `noindex, nofollow` and renders no console error.

- [ ] **Step 3: Verify deployed identity and remote ledgers one final time.**

  ```bash
  npx wrangler versions list --name candidary --config wrangler.jsonc --json
  npx wrangler d1 migrations list candidary-core --remote --config wrangler.jsonc
  npx wrangler secret list --config wrangler.jsonc
  ```

  Expected: deployed tag equals the merge commit, no pending migrations, and all ten secret names are present.

- [ ] **Step 4: Roll back code only if a production smoke check fails.**

  Use the recorded pre-release version ID:

  ```bash
  PRE_RELEASE_VERSION_ID="$(tr -d '\n' < /tmp/candidary-pre-pr33-version-id)"
  test -n "$PRE_RELEASE_VERSION_ID"
  npx wrangler rollback "$PRE_RELEASE_VERSION_ID" --name candidary --config wrangler.jsonc --message "Rollback PR 33 after failed production smoke" --yes
  ```

  Then recheck both origins. Leave migrations 0017/0018 and the independently provisioned secrets in place; they are additive and compatible with the old Worker. Open a follow-up PR for the defect rather than patching production from an unreviewed checkout.

- [ ] **Step 5: Close the release.**

  Post a concise PR/release summary containing the merge SHA, deployed version ID/tag, migration ledgers, hosted check results, smoke results, and evidence-backed dispositions for non-code review comments. Only after this record is complete may the PR branch or temporary worktrees be removed.

## Completion criteria

- Every finding in the coverage table is implemented, verified, or explicitly closed with technical evidence.
- `npm test`, all static/build/migration checks, Smoke, and the full Playwright matrix pass in a clean checkout.
- Independent review reports no unresolved critical or important finding.
- Both remote environments have ten required secret names and no pending release migrations.
- All GitHub jobs and the Cloudflare preview actually execute and pass against the reviewed head.
- PR 33 merges without an admin bypass; production deploys the merge commit once.
- Both production origins pass live smoke checks, or the Worker is rolled back to the recorded version while additive schema remains.

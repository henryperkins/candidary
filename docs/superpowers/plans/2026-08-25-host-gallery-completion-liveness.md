# Host Gallery Completion and Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one checkpoint at a time. Use test-driven development, preserve all existing Slice 1–2 work, and do not commit unless the user asks.

**Goal:** Make export snapshots and progress truthful, make every autosave/leave path recoverable, keep one accessible Undo offer alive across Manager navigation, and complete Cover-style readiness without replacing Candidary's existing workflows.

**Architecture:** Extend the current export repository/Workflow with migration `0020_export_progress.sql` and an `attempt-v2` ownership fence; keep the existing export controls, autosave queue, Router blocker, Manager resource owner, Undo implementation, and Cover preview loader. Add shared code only where two current consumers require the same contract. Do not add a second export engine, save queue, navigation blocker, Undo system, network manager, or Cover request controller.

**Tech Stack:** React 19, React Router, TypeScript, Hono on Cloudflare Workers, D1, R2, Cloudflare Workflows, Vitest/Testing Library, and Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-completion-liveness-design.md`

## Global constraints and preflight rulings

- Start from worktree `/home/henry/candidary/.worktrees/gallery-roadmap-remediation`, branch `codex/gallery-roadmap-remediation`, starting repository revision `332d6d2a3ce3233da8f7aa9b54a4d3e5ea231db8` plus the intentional unstaged Slice 1–2 diff.
- Never discard, overwrite, stage, commit, push, deploy, migrate a remote database, mutate a pull request, or change secrets as part of this plan.
- Before the first Slice 3 production edit, record the current status/diff summary and reconfirm both preserved matrix prefixes: Slice 1 lines 1–76 SHA-256 `5627b1e2319edde14d769b42e092699e4ff8666813dfb49912d89327a08c7bcd`, and Slice 1–2 lines 1–96 SHA-256 `385411e0ed16105b5915fd32b8f30c6d8848dfd853ffe615169756a26f218800`.
- Existing migrations `0001`–`0019` are immutable. Slice 3 creates exactly `0020_export_progress.sql`; it must pass fresh-D1 and populated-0019 upgrade tests.
- Migration-first compatibility is binding: the 0019 Worker may continue creating and completing
  `legacy` rows after migration 0020 while admission remains `legacy-open`; the one-way close then
  blocks its active INSERT/Retry writes. Frozen old Workflow callback DML must fail closed against
  `attempt-v2` rows; this is not a claim that the full old scheduled-cleanup control flow is safe.
- The old cleanup deletes Ready artifacts before its D1 transition, and an inert Worker upload does not activate its Workflow implementations. Migration 0020 therefore installs one immutable three-state export-protocol admission row in `legacy-open`. D1 admits active INSERT/Retry only for `legacy` while legacy-open, neither protocol while closed, and `attempt-v2` while open. The isolated preview cutover freezes uploads, applies 0020, uploads and verifies one inert preflight candidate, records all three Workflow version IDs, drains active legacy work, closes atomically, proves the full preview config has no unrelated trigger side effects, then uses pinned `wrangler deploy` from that same clean exact-SHA artifact. Production must prove the exact frozen old revision `df2b66510ccee6893ca91ab752337df8e52c6207`, retain the helper's upload-only preflight, generate Cron-only and full no-Cron cutover configs, detach and drain old daily Cron, record and drain all queued/running legacy exports, atomically close, and use pinned `wrangler deploy` from that same clean exact-SHA artifact. Before either row opens, require one new sole 100% active exact-SHA Worker version and all three latest Workflow version IDs changed from their pre-cutover baselines. Open once with the new active lowercase UUID and exact canonical audit values, then restore Crons. Closing is the forward-only export-availability point; the cutover deployment remains the trash/data rollback point. Keep the exclusive freeze through the later matching daily cleanup proof; canonical commands live only in `docs/deployment.md`.
- `ExportsRepository`, `ExportWorkflow`, `GalleryExportControl`, `AlbumExportControl`, `export-control-status.tsx`, `createAutosaveQueue`, `useBlocker`, `UnsavedSettingsPrompt`, `useUndo`/`UndoBar`, and the Cover session's existing preview maps/controllers are reuse boundaries.
- C-13's blocked-to-blocked Router destination generation is already implemented and regressed in `tests/ui/app.test.tsx`; retain it and mark it `verified-existing` unless a new RED proves otherwise.
- C-25 already has Loading/Retry presentation. Extend preview ownership, bounded visible-step prefetch, and last-usable-image retention; do not rebuild the picker or loader.
- The code currently has three independent `useUndo()` owners and no `ManagerUndoProvider`. Slice 3 converts that existing implementation into the sole Manager-owned provider and removes every child owner/bar.
- Complete live count comes from the adopted `EventView.storedMediaCount`. Album live count comes from Slice 2's trusted Gallery audience summary. No new count endpoint or local Album count authority is allowed.
- A stale live count may remain visible, but no export card may claim snapshot equality or a precise delta from stale data.
- Equal counts do not prove an unchanged collection: replacement, order, metadata, and caption changes can preserve `N`. Every valid terminal card therefore keeps a separate Prepare-current action whenever neither export kind is active; trusted counts are used only for numeric context/delta copy, never to suppress that action.
- A new complete export requires at least one delivered photo even if Guestbook-only content exists. Historical frozen zero-photo complete exports remain viewable and retryable when their snapshot is valid.
- Discard drops only unsent Album work, retires the local draft generation, and proceeds to the exact current destination. It never cancels or rolls back an accepted request, and copy must say so.
- Persistent Undo offers are mount-independent inverse commands registered only after their exact forward outcome is canonically classified—fully confirmed, or a directly confirmed membership change with an exact unchanged Album revision. They may call existing API clients and use Manager-owned invalidators; they may not capture child setters, DOM/draft refs, operation journals, or autosave queues.
- Cover style prefetch begins only when the fixed five-choice Style step is visible. The existing five-effect list is the bound; do not add viewport observers, a second scheduler, or speculative prefetch outside that step unless a failing browser regression requires it.
- Each task records RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-25-host-gallery-completion-liveness/`, then receives an independent spec and code review. Fix every P1/P2 before advancing.

---

### Task 1: StrictMode-safe Settings and Appearance autosave generations

**Findings:** C-07

**Files:**

- Modify: `src/features/settings/autosave-queue.ts` only if a minimal shared lifecycle owner is needed; do not duplicate queue semantics.
- Modify: `src/components/EventSettingsEditor.tsx`
- Modify: `src/components/EventAppearanceEditor.tsx`
- Modify: `tests/unit/settings-autosave-queue.test.ts`
- Modify: `tests/ui/event-settings-editor.test.tsx`
- Modify: `tests/ui/event-appearance-editor.test.tsx`

**Interfaces:**

- Retains `createAutosaveQueue`, `AutosaveQueue`, `AutosaveOutcome`, and `dispose()` as the only persistence queue.
- Produces one queue per mounted editor effect generation and an ownership check for post-request adoption.

- [ ] **Step 1: Write StrictMode RED regressions**

Wrap each editor in `<StrictMode>`, allow effect replay to complete, edit one field, and assert:

- exactly one write is sent;
- the UI does not say `Saved` while the response is pending;
- `Saved` appears only after the Worker answer is adopted;
- resolving a request owned by a retired/unmounted generation cannot call `onSettingsSaved` / `onThemeSaved` or restore stale UI.

- [ ] **Step 2: Run the focused RED suite**

```bash
npx vitest run --config vitest.config.ts \
  tests/unit/settings-autosave-queue.test.ts \
  tests/ui/event-settings-editor.test.tsx \
  tests/ui/event-appearance-editor.test.tsx
```

Expected: the new StrictMode editor tests fail because replay cleanup disposes the render-created queue that the live editor retains.

- [ ] **Step 3: Give each effect generation one queue owner**

Create the queue during the committed layout/effect generation, not as an immortal render-time ref. Cleanup must dispose exactly that queue. If both editors need identical ownership plumbing, extract only a small lifecycle owner around `createAutosaveQueue`; it must delegate every submit/flush/wait/discard/baseline operation to the existing queue and contain no save semantics.

- [ ] **Step 4: Guard response adoption by generation**

Capture the editor generation before each Settings or Appearance write. After the response, adopt normalized fields, call the parent saved callback, and permit `Saved` only if that generation is still current. A retired response may finish on the network but has no UI owner.

- [ ] **Step 5: Verify GREEN and adjacent autosave behavior**

Run the Step 2 command plus:

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/manager-settings-autosave.test.tsx \
  tests/unit/autosave-status-text.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 6: Record and independently review Task 1**

Record the exact RED/GREEN counts, confirm one existing queue remains, and require no P1/P2 before Task 2.

---

### Task 2: One Album offline failure and one reconnect retry

**Findings:** C-26

**Files:**

- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/e2e/error-recovery.spec.ts` only if its fixture can deterministically drive browser offline/online state.

**Interfaces:**

- Reuses the Album `createAutosaveQueue`, `applyDraft`, `AutosaveStatus`, and current queue generation.
- Does not change global `describeLoadFailure` or add a network-status service.

- [ ] **Step 1: Replace raw-network expectations with RED regressions**

Assert one normalized Album-save message, one `Retry album` action, no raw `Failed to fetch`, and no competing notice. Drive multiple edits while offline, dispatch one `online` event, and assert exactly one retry of the newest valid draft. A second `online` event after the listener fires must do nothing.

- [ ] **Step 2: Run focused RED**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/album-workspace.test.tsx -t 'offline|online|Failed to fetch|reconnect'
```

Expected: fail on raw copy, duplicate presentation, or missing reconnect ownership.

- [ ] **Step 3: Normalize only Album autosave network failures**

For non-`ClientApiError` request failures, return one stable action-oriented message from the Album queue's existing failure mapper. Do not call `setNotice` for the same queue failure; `AutosaveStatus` remains the sole visible error and Retry owner.

- [ ] **Step 4: Attach one generation-owned `online` listener**

Listen only while the active Album queue has a retryable failed newest draft. On the first `online` transition, remove the listener and immediately resubmit that current valid draft through `applyDraft`. Remove it on success, draft replacement where it no longer applies, queue retirement, event change, and unmount.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx
npm run typecheck
git diff --check
```

Run the scoped browser regression only if deterministic offline fixtures were added.

- [ ] **Step 6: Record and independently review Task 2**

Require evidence of one message, one Retry, one listener, and one newest-draft request with no P1/P2.

---

### Task 3: Discriminated Album leave preparation and exact-destination discard

**Findings:** C-13 (`verified-existing` destination race), C-14

**Files:**

- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/components/UnsavedSettingsPrompt.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/manager-settings-autosave.test.tsx` only for preserved combined-domain behavior.

**Interfaces:**

- Replaces only `ManagerAlbumHandle.prepareToLeave(): Promise<boolean>` with:

```ts
export type AlbumLeavePreparation =
  | { status: 'ready' }
  | { status: 'waiting' }
  | { status: 'invalid'; field: string }
  | { status: 'failed'; message: string };
```

- Extends the same handle with one explicit child-owned `discardPendingAlbumChanges()` operation. Only the destination owner may navigate afterwards.
- Retains the existing Router `useBlocker`, `blocker.location.key`, and monotonic preparation generation.

- [ ] **Step 1: Write RED contract tests in the Album owner**

Cover `ready`, `waiting`, invalid title with its field, retryable/nonretryable failed save, Retry, discard of scheduled work, and an in-flight request that may settle after discard without rolling back confirmed server state.

- [ ] **Step 2: Write RED destination tests**

In `tests/ui/app.test.tsx`, preserve the existing blocked-to-blocked route replacement regression and replace the dead-end expectation with:

- waiting copy and disabled Leave while preparation is unsettled;
- Retry, Stay, and `Discard unsent Album changes and leave` after invalid/failed preparation;
- exact Router location key ownership;
- a replacement Router destination while the first preparation is pending;
- section and Gallery-mode destinations receiving the same outcome semantics;
- the already-sent-request caveat.
- prompt focus on arrival, Retry retaining a stable action target, and Stay returning to the invalid Album field or nearest Album heading.

- [ ] **Step 3: Run RED**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/album-workspace.test.tsx \
  tests/ui/app.test.tsx \
  tests/ui/manager-settings-autosave.test.tsx
```

- [ ] **Step 4: Implement the exact preparation outcome**

Map the existing queue/pending-operation/canonical-trust state to the discriminated result without adding another queue. `invalid` names the current field. `failed` carries the normalized recovery message.

Every caller must install `{ destination, generation, outcome: { status: 'waiting' } }` synchronously before it awaits settlement; a pending Promise is not allowed to leave the prior destination's result on screen. `prepareToLeave()` resolves only a terminal `ready` / `invalid` / `failed` outcome for its captured Album generation. The coordinator-owned state uses the full union, with `waiting` as the explicit period before that Promise settles. Only the still-current destination/generation may adopt the terminal result. Gallery-mode transitions keep the same tuple locally in `ManagerGalleryWorkspace`; Router and Manager-section transitions keep it in `ManagerPage`, and both render the same prompt contract. A RED test must prove `waiting` automatically advances on successful settlement without a second user action.

- [ ] **Step 5: Implement discard without rollback claims**

`discardPendingAlbumChanges()` calls the existing `queue.discardPending()` and retires the local draft generation and operation intent that has not been sent. It never receives or owns a Router/section/mode destination. After it returns, the still-current Manager/workspace coordinator alone proceeds to its captured destination. Do not abort or reverse a request already accepted by the Worker. A late result from a retired draft generation cannot unblock a replacement destination.

- [ ] **Step 6: Extend the existing prompt, not the blocker**

Keep Settings' current `Leave now` semantics. Extend `UnsavedSettingsPrompt` with explicit Album preparation/result props and callbacks rather than inferring from prose: `albumOutcome`, `onRetryAlbum`, `onDiscardAlbum`, and an Album-aware `onStay`. Its Album heading/action copy says `Album changes are not saved yet`, `Retry`, `Stay in Album`, and `Discard unsent Album changes and leave`; it must not say `Stay and fix settings`. Use a small local destination union for Router location, Manager section, and Gallery mode; do not implement Slice 4 query-parameter routing early.

Retry synchronously creates a new preparation generation for the same destination, returns to `waiting`, and keeps focus on the stable Retry action until a terminal result changes the available actions. Stay retires the tuple and restores focus to the invalid Album field or nearest Album heading. Discard retires it only after `discardPendingAlbumChanges()` returns and the coordinator rechecks the exact destination identity. A late settlement from any earlier generation is ignored.

- [ ] **Step 7: Verify GREEN and Router behavior**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/album-workspace.test.tsx \
  tests/ui/app.test.tsx \
  tests/ui/manager-settings-autosave.test.tsx
npm run typecheck
npm run typecheck:e2e
git diff --check
```

- [ ] **Step 8: Record and independently review Task 3**

Require the C-13 existing regression to remain green and no new navigation owner/framework to appear.

---

### Task 4: Migration 0020 progress and execution invariants

**Findings:** Backend foundation for C-32, C-33, and C-54

**Files:**

- Create: `migrations/0020_export_progress.sql`
- Create: `tests/worker/migration-0020.test.ts`
- Modify: `scripts/verify-fresh-d1.ts`
- Modify: `tests/unit/verify-fresh-d1.test.ts`
- Modify: `docs/operations.md` only to correct/complete the migration-first and forward-fix gate; retain accurate Slice 1 text.
- Modify: `docs/deployment.md` so the canonical migration-bearing release and rollback procedure names the 0020 Cron-drain/version gate and its forward-fix-only boundary.

**Interfaces:**

- Adds nullable `processed_media_count`, `processed_bytes`, `progress_updated_at`.
- Adds non-null `execution_protocol` (`legacy|attempt-v2`, default `legacy`), non-negative `execution_transition` (default `0`), and nullable `execution_started_at`.
- Adds immutable singleton `export_protocol_admission` with one-way `legacy-open -> closed -> open`
  transitions, zero-active-legacy checks, and exact lowercase UUID/canonical UTC audit values.

- [ ] **Step 1: Write populated-0019 upgrade RED tests**

Prove:

- legacy rows acquire exact defaults without changing state, attempt, `started_at`, or artifacts;
- progress is all-null or all-non-null, non-negative, and bounded by frozen totals;
- an `attempt-v2` insert/update cannot use legacy `started_at`, and v2 `execution_started_at` follows the exact queued/running lifecycle;
- every v2 state/attempt transition increments `execution_transition` exactly once;
- an increment without a state/attempt transition is refused;
- every transition rule is evaluated whenever either `OLD.execution_protocol` or `NEW.execution_protocol` is `attempt-v2`, so a protocol rewrite cannot bypass it;
- v2-to-legacy is always refused, and legacy-to-v2 is permitted only as one validated terminal-to-queued Retry transition that increments attempt/transition and clears run/progress fields atomically;
- queued v2 requires `execution_started_at IS NULL`, queued-to-running sets it, same-run updates preserve it, and Retry clears it;
- the progress trigger also runs when `media_count` or `total_bytes` changes, not only when one of the three progress fields changes;
- pre-migration/old-Worker legacy state changes remain permitted for `legacy` rows;
- fresh 0001–0020 schema, data seeded under 0018 then upgraded through 0019+0020, and a running legacy row created after 0019 but before 0020 all obey the intended compatibility contract.
- the admission row starts `legacy-open`; D1 gates active INSERT and terminal-to-active Retry by the
  admitted protocol; it closes only with zero queued/running legacy rows and then opens only once with
  exact audit values; it cannot be inserted/replaced/deleted/returned/reclosed/retargeted.

- [ ] **Step 2: Run migration RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0020.test.ts
```

Expected: fail because migration 0020 and its columns/triggers do not exist.

- [ ] **Step 3: Implement the additive all-or-nothing migration**

Use additive columns and named insert/update triggers. Do not rebuild `export_jobs`, edit 0019, or reinterpret existing rows as v2. Update triggers evaluate both OLD and NEW protocols, prohibit downgrade bypasses, and validate protocol upgrade, state, attempt, transition, start, totals, and progress as one transition. Legacy SQL remains valid for legacy rows; old callback DML loses before mutating any v2 row.

- [ ] **Step 4: Extend fresh-D1 verification**

Add exact schema/default/trigger checks to the existing verifier and its unit fixture, including the
`legacy-open` admission row and all five admission trigger bodies. Keep the current migration ordering
mechanism; do not add a second migration runner.

- [ ] **Step 5: Record the operational boundary**

Document migration-before-deploy, legacy compatibility, the frozen preview and production candidates,
protocol-gated active writes, atomic zero-legacy close, Cron-only detach/drain, full no-Cron cutover
deployment, Worker/Workflow version evidence, one-way D1 open, Cron restoration, and gate-state-aware forward fixes.
`docs/deployment.md` is the sole command source; the design and operations docs explain the invariant
without duplicating a second procedure.

- [ ] **Step 6: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/migration-0019.test.ts \
  tests/worker/migration-0020.test.ts
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
npm run verify:fresh-d1 -- \
  --run-root <absolute-os-temp-directory-named-candidary-release-*> \
  --report-file <that-directory>/migration-verification.json
git diff --check
```

`npm run ci:migrations` is reserved for CI, or for an authorized committed head with explicit full `CI_BASE_SHA` and `CI_HEAD_SHA` values. It cannot verify this unstaged worktree and a skipped revision diff must not be reported as migration evidence.

- [ ] **Step 7: Record and independently review Task 4**

Require a schema/rollout review before repository code can depend on migration 0020.

---

### Task 5: Attempt-v2 repository ownership and durable progress

**Findings:** C-32, C-33 backend

**Files:**

- Modify: `worker/db/types.ts`
- Modify: `worker/db/exports.ts`
- Create: `tests/worker/export-progress.test.ts`
- Modify: `tests/worker/export-api.test.ts` only where public API setup is the real owner.

**Interfaces:**

- Extends `ExportRecord`/`ExportRow` with protocol, transition, v2 start, and progress fields.
- Changes active-run ownership from `{ id, startedAt }` to `{ id, executionProtocol: 'attempt-v2', attempt, executionStartedAt, state }`.
- Adds absolute monotonic `recordProgress()` and a guarded same-run reset used only after deterministic-prefix cleanup.

Use one exact owner token throughout:

```ts
interface ExportRunOwner {
  id: string;
  executionProtocol: 'attempt-v2';
  attempt: number;
  executionStartedAt: string;
}

type ExportOwnedTransition = { changed: boolean; job: ExportRecord | null };

type ExportRunActivity =
  | { status: 'active'; job: ExportRecord }
  | { status: 'event-deleted'; job: ExportRecord }
  | { status: 'lost'; job: ExportRecord | null };

interface ExportArtifactInventory {
  objectKey: string | null;
  manifestObjectKey: string | null;
  guestbookHtmlObjectKey: string | null;
  guestbookCsvObjectKey: string | null;
  parts: readonly ReadyExportPart[];
}

interface ExportExpiryCandidate {
  id: string;
  executionProtocol: 'legacy' | 'attempt-v2';
  attempt: number;
  executionTransition: number;
  expiresAt: string;
}

interface ExpiredArtifactInventoryCandidate extends ExportExpiryCandidate {
  // This is the post-Ready-to-Expired transition value.
  inventory: ExportArtifactInventory;
}

type ExportExpiryResult =
  | { changed: false; job: ExportRecord | null }
  | { changed: true; job: ExportRecord; cleanup: ExpiredArtifactInventoryCandidate };
```

Repository signatures are:

```ts
claimRunning(id: string, attempt: number, executionStartedAt: string): Promise<ExportRunClaim>;
assertOwnedRunActive(owner: ExportRunOwner): Promise<ExportRunActivity>;
recordProgress(owner: ExportRunOwner, progress: {
  processedMediaCount: number;
  processedBytes: number;
  progressUpdatedAt: string;
}): Promise<boolean>;
resetOwnedRunProgress(owner: ExportRunOwner, progressUpdatedAt: string): Promise<boolean>;
markReady(owner: ExportRunOwner, inventory: ReadyExportInventory,
  completedAt: string, expiresAt: string): Promise<ExportOwnedTransition>;
markOwnedFailed(owner: ExportRunOwner, errorCode: string,
  completedAt: string): Promise<ExportOwnedTransition>;
markExpired(candidate: ExportExpiryCandidate, now: string): Promise<ExportExpiryResult>;
listExpiredWithInventory(limit: number): Promise<ExpiredArtifactInventoryCandidate[]>;
clearExpiredInventory(candidate: ExpiredArtifactInventoryCandidate): Promise<boolean>;
```

`claimRunning` matches the exact queued `{id, attempt}` and returns `claimed` with the owner token on first success, `resumed` with the same token for the exact same `{attempt, executionStartedAt}`, or `lost`. A resumed claim is a true no-op: it neither advances `execution_transition` nor resets progress. Every subsequent method includes `state = 'running'` plus the complete owner token in its D1 predicate. A false/unchanged result means ownership was lost and must never be broadened into a retrying write.

- [ ] **Step 1: Write repository RED tests**

Cover:

- new complete and Album jobs explicitly insert `attempt-v2` after the operational release gate;
- first claim initializes processed counters to zero while preserving the frozen nonzero totals, writes the real `execution_started_at`, and advances the transition once;
- an exact same-owner re-claim returns `resumed` without changing the row, transition, counters, or progress timestamp;
- stale attempt or start identity cannot assert, record progress, mark Ready, or mark Failed;
- an equal absolute progress replay returns success as a true no-op and preserves `progress_updated_at`; regression/decrease is rejected;
- deterministic-prefix cleanup completes before the guarded same-owner reset; that reset is the only in-attempt decrease, and a different attempt/start cannot invoke it;
- Ready requires processed totals to equal frozen totals;
- Failed retains the last completed-part milestone;
- retry increments attempt, advances the transition, changes protocol where applicable, and resets both start columns and progress to null in one transition that cannot downgrade back to legacy;
- a valid terminal legacy job upgrades to v2 on Retry, while a legacy snapshot lacking both valid frozen photo entries and a complete valid Guestbook snapshot returns `EXPORT_SOURCE_REMOVED` without mutation. Zero photo entries alone do not invalidate the historical complete Guestbook snapshot.

- [ ] **Step 2: Run repository RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/export-progress.test.ts
```

- [ ] **Step 3: Extend rows and mappings exactly once**

Keep one `mapExport`. For Manager/public projection, raw stored error strings and protocol internals remain server-only. Use `execution_started_at` for v2 ownership and retain legacy `started_at` solely for legacy rows.

- [ ] **Step 4: Fence every repository transition**

Update create, claim, assert, progress, Ready, owned Failed, initial/retry dispatch failure, Retry, and Expiry statements to match the exact protocol/attempt/start/state they own and to increment `execution_transition` exactly once whenever current code changes state or attempt. Old SQL may continue changing a legacy row without a transition increment. `assertOwnedRunActive` distinguishes an active owner, a deleted/missing event still attached to the exact owner, and lost ownership. The Workflow terminalizes only the `event-deleted` exact owner with `EXPORT_EVENT_DELETED`; `lost` returns without changing the winner.

`listExpiredReady()` returns exact id/protocol/attempt/transition/expiry candidates rather than detached jobs. `markExpired()` uses one D1 batch/transaction to win that exact Ready-to-Expired transition and read the winner row plus every `export_parts` row; it returns a cleanup candidate only when the guarded update changed exactly one row. The candidate's transition is the post-transition value and its immutable inventory names the top-level artifact keys plus all parts. This is the sole handoff from D1 ownership to R2 deletion; a separately loaded `ExportRecord` is not sufficient.

After successful idempotent R2 deletion, `clearExpiredInventory()` uses one exact Expired/protocol/attempt/post-transition/expiry predicate and a D1 batch to null the matching top-level keys and delete part rows only when that guard changed one row. `listExpiredWithInventory()` returns the same candidate shape for bounded recovery after an R2 failure. Because Expired inventory is immutable except for guarded clear or Retry, the transition identifies the captured part set without adding a second fingerprint column. Retry changes state, attempt, and transition and establishes a new deterministic prefix in its existing atomic batch, so a stale expiry clear loses and can touch neither the replacement row nor its parts. A zero-row stale write is not retried as a broader update.

- [ ] **Step 5: Preserve source-hold atomicity**

Ready/Failed must release the derived active source hold in the same fenced D1 transition that records final inventory/error/progress. Ready already has no active hold; Ready-to-Expired preserves that terminal no-hold state while removing its artifacts. Do not delete R2 or source state merely because a stale D1 write lost.

- [ ] **Step 6: Verify GREEN and Slice 1 safeguards**

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/export-progress.test.ts \
  tests/worker/export-api.test.ts \
  tests/worker/media-recovery-api.test.ts \
  tests/worker/migration-0019.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 7: Record and independently review Task 5**

Require focused review of every state/attempt transition and exact zero-row behavior before changing Workflow dispatch.

---

### Task 6: Attempt-owned Workflow, cleanup, and old-SQL compatibility

**Findings:** C-32 and C-33 backend; release safety for C-05/C-54

**Files:**

- Modify: `worker/index.ts`
- Modify: `worker/routes/exports.ts`
- Modify: `worker/workflows/export.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `tests/worker/export-progress.test.ts`
- Modify: `tests/worker/export-api.test.ts`
- Modify: `tests/worker/cleanup.test.ts`
- Modify: `tests/worker/core-journey.test.ts`
- Modify: `tests/worker/notifications.test.ts` for version-attributed `cleanup_completed` telemetry.
- Modify: `tests/worker/migration-0020.test.ts` for verbatim old-SQL fixtures.
- Create: `tests/worker/fixtures/export-worker-0019.ts` as a test-only frozen ownership/control-flow prelude, not production compatibility code.
- Modify: `scripts/deploy-built.ts` to add production upload-only plus preview/production cutover modes that reuse the existing provenance/topology checks.
- Modify: `tests/unit/deploy-built.test.ts` for upload, Cron-only/full-cutover projections, cutover commands, and the refusal matrix.
- Modify: `package.json` to expose `upload:production-version:built`, `prepare:production-cutover-configs:built`, `deploy:preview-cutover:built`, and `deploy:production-cutover:built`; leave the routine deploy scripts unchanged.
- Modify: `docs/operations.md` to replace every old delete-before-Expired description and record the exact exceptional release commands.
- Modify: `docs/deployment.md` to make the exclusive no-deploy window, native version release, and post-admission forward-fix rule canonical.

**Interfaces:**

- Changes the Workflow payload to `{ jobId, attempt }`.
- Uses stable `WorkflowEvent.timestamp` as `executionStartedAt`.
- Keeps `multipartPut`, immutable snapshots, deterministic attempt prefixes, and current R2 inventory/cleanup machinery.
- Changes `processExport` to `processExport(env, payload: { jobId: string; attempt: number }, now, maxPartBytes, executionStartedAt)` and passes one `ExportRunOwner` to every repository call.

- [ ] **Step 1: Write Workflow/progress RED tests**

Use deferred fake-R2 barriers at whole multipart completions, never timing sleeps. Cover:

- no completed part (processed counters `0` while frozen media/byte totals remain nonzero; `0 / 0` is reserved for a genuinely historical zero-photo snapshot);
- one completed part and cumulative uncompressed source bytes;
- callback replay with absolute idempotent progress;
- resumed deterministic-prefix cleanup followed by the only allowed in-attempt reset to zero;
- retry-attempt progress reset to null;
- stale `{ attempt, executionStartedAt }` progress/Ready/Failed calls changing zero rows;
- event deletion between claim and assertion terminalizing only the exact owner with `EXPORT_EVENT_DELETED`, releasing its hold so purge can continue; the same assertion from a stale owner changes nothing and cannot terminalize the winner;
- Ready equality and Failed partial progress;
- historical valid zero-photo completion at `0 / 0`.

- [ ] **Step 2: Write cross-version RED tests using frozen old SQL and an R2 sentinel harness**

The repository has no runnable 0018 Worker artifact. Freeze the exact pre-0020 claim/assert/Ready/Failed/Retry/expiry statements as test fixtures, with comments naming their source revision. SQL-only tests prove D1 mutation and derived source-hold safety; do not claim they prove R2 behavior.

Add a small test-only frozen pre-0020 Workflow callback prelude that executes the old claim/ownership control flow against fake R2 methods instrumented as side-effect sentinels. For v2 queued and running rows, prove ownership fails/exits before the callback can call R2 `list`, `delete`, `get`, `put`, or multipart work. For a legacy row, prove the prelude still reaches its expected R2 boundary. Keep this out of production code.

Separately freeze the old `cleanupExpiredExports()` ordering and prove an expired v2 Ready fixture reaches R2 deletion before its old `markExpired()` loses. That is an expected RED safety demonstration, not a compatibility success. Add a production upload-only mode to the existing `scripts/deploy-built.ts`: it runs the same `main` branch, exact `WORKERS_CI_COMMIT_SHA`, clean-tree, regular generated-config, and full production-topology checks as `deploy:built`; its sole command-plan difference is native `wrangler versions upload --config dist/candidary/wrangler.json --strict --tag <full-sha>`. Unit tests prove every existing production refusal also blocks upload-only mode and that no upload-only command contains `deploy`, trigger mutation, or a preview alias. Do not add a second release script.

Extend the existing `deploy-built.ts` rather than adding a release script. Besides upload-only mode, it
projects `wrangler.cron-only.json` and a full `wrangler.cutover.json` only after validating the full
production artifact. Unit tests prove the Cron projection cannot contain Workflows, routes, queues, or
event triggers and that the cutover projection's only delta is `triggers.crons: []`. Preview cutover
uses the full verified no-Cron preview config. Both cutover modes require clean trees and use pinned
`wrangler deploy --strict --tag <full-sha>`; production also requires `main` and regenerates the cutover
file from the full artifact. `triggers deploy` remains limited to Cron detach/restore and is never
treated as a Workflow implementation deployment.

The separately authorized rollout follows only the canonical commands in `docs/deployment.md`: first
cut over preview with an inert exact candidate and its three-state gate; then prove the exact frozen old
production version/tag, install 0020 in `legacy-open`, upload the immutable candidate, generate the two
cutover configs, record Workflow version baselines, drain old daily Cron and all active legacy exports,
atomically close, deploy Worker code and all three Workflows together, require one new sole active
exact-SHA Worker version and three changed latest Workflow version IDs, open admission once with exact audit values,
restore Crons, and retain the freeze through matching daily cleanup evidence. `worker/index.ts` adds `workerVersionId`,
`cleanupKind: 'hourly-maintenance'|'daily-lifecycle'`, and exact `cron` to cleanup-success logs. If any
post-cutover gate fails, recovery is a reviewed current forward fix. A closed gate continues toward
its original one-time open; an already-open gate stays open and accepts only `attempt-v2`-compatible
Worker/Workflow changes. Remote Build, merge, D1, trigger, and deployment mutations remain outside
this implementation plan.

- [ ] **Step 3: Run RED**

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/export-progress.test.ts \
  tests/worker/cleanup.test.ts \
  tests/worker/migration-0020.test.ts \
  tests/worker/notifications.test.ts
npx vitest run --config vitest.config.ts tests/unit/deploy-built.test.ts
```

- [ ] **Step 4: Make dispatch and execution attempt-owned**

Pass `{ jobId, attempt }` for new initial and retry Workflow creation and carry the exact execution identity through claim, assert, progress, Ready, and owned Failed. An old deterministic instance cannot claim a newly queued attempt. Update `commitOrRecoverRetry()` and `isRecoverableQueuedRetry()` to accept an ambiguously committed Retry only when protocol, exact attempt/transition, both start columns, null progress, pristine inventory/artifact fields, and immutable snapshot identity all match the expected queued retry. Pre-deploy legacy jobs remain owned by their pinned old Workflow artifact; the new repository retains explicit legacy cleanup/projection paths but does not reinterpret an active legacy run as v2.

- [ ] **Step 5: Record only durable whole-part milestones**

After each `multipartPut()` completes, add that part's photo count and uncompressed source bytes to cumulative absolute progress and call the repository once. Do not invent entry-level ZIP durability or report transferred/ZIP bytes.

On a real owned failure, first win the exact `markOwnedFailed` D1 transition; only that winner may clean its recorded attempt objects. If ownership was lost, return the current row and do not delete any R2 key—the apparent objects may belong to the winner. Ready reconciliation follows the same rule.

- [ ] **Step 6: Make cleanup and purge protocol-aware**

Make cleanup D1-first for both protocols: win the exact Ready-to-Expired transition and atomically capture its full top-level/part inventory before deleting only those returned artifacts. If R2 deletion fails, the Expired row retains its inventory and a bounded `listExpiredWithInventory()` sweep retries it; only successful idempotent deletion may clear the exact expired inventory/part rows. Name and test separately: legacy and v2 Ready expiry; mark-expiry atomically capturing all part rows; an R2 failure followed by successful artifact retry; Expired-cleanup versus Retry with a barrier after expiry wins; Retry winning before stale inventory clear; proof that both interleavings delete only the prior deterministic prefix and never clear the replacement attempt; legacy and v2 queued event-purge terminalization; running-v2 purge hold; the old bulk queued-to-failed purge SQL losing before relational or R2 purge; and recoverable-trash fixtures at queued, running, and Ready. Retry already owns cleanup of a captured or deterministically rediscovered prior-attempt prefix, so expiry recovery does not add a second orphan mechanism. Restoring trash or terminalizing the current exact owner must release holds and allow purge to finish.

Preserve `ExportsRepository.listForEvent()` as the full internal-history enumerator used by event cleanup. Add a cleanup regression with at least three historical jobs proving every artifact remains discoverable even after the Manager route later adopts a latest-per-kind query.

- [ ] **Step 7: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/export-progress.test.ts \
  tests/worker/export-api.test.ts \
  tests/worker/core-journey.test.ts \
  tests/worker/cleanup.test.ts \
  tests/worker/notifications.test.ts \
  tests/worker/migration-0019.test.ts \
  tests/worker/migration-0020.test.ts
npx vitest run --config vitest.config.ts tests/unit/deploy-built.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 8: Record and independently review Task 6**

Require a race/fence review and explicit confirmation that stale callbacks cannot release another attempt's source hold.

---

### Task 7: Latest-per-kind Manager export contract and safe error projection

**Findings:** C-05, C-32, C-47, C-54 backend/API

**Files:**

- Modify: `shared/contracts.ts`
- Modify: `src/app/types.ts`
- Modify: `worker/db/exports.ts`
- Modify: `worker/routes/exports.ts`
- Modify: `tests/worker/export-api.test.ts`
- Modify: `tests/worker/export-progress.test.ts`
- Modify: `tests/worker/helpers.ts` only if `seedExportJob()` is extended for the valid historical zero-photo snapshot.
- Modify: `tests/unit/guestbook-export.test.ts`

**Interfaces:**

- Defines one shared runtime allowlist and corresponding `ManagerExportErrorCode` type.
- Returns the existing `{ data: { exports }, requestId }` envelope with an array containing at most the server-selected latest complete job and latest Album job.
- Adds required `createdAt` plus nullable normalized `startedAt`, `completedAt`, progress, and safe `errorCode` fields to `ExportView`.
- Preserves `listForEvent()` for full internal cleanup history and adds a route-only `listLatestForManager(eventId)` projection query.

- [ ] **Step 1: Write exact projection/order RED tests**

Seed unsorted and equal-time jobs and assert the route returns at most one per kind in deterministic server order (`created_at DESC`, then `id DESC`). Assert exact response keys, required non-null `createdAt: string`, and normalized start time: v2 uses `execution_started_at`, legacy uses `started_at`. Give `snapshotAt` and `createdAt` deliberately different values and prove Manager's `Prepared` timestamp uses `snapshotAt`, never job creation time.

Also seed three-plus historical jobs with artifacts and prove the internal cleanup query still returns all of them. Manager projection and cleanup history are separate repository contracts.

- [ ] **Step 2: Write the error allowlist RED matrix**

Project exactly:

- `EXPORT_SOURCE_MISSING`
- `EXPORT_SOURCE_REMOVED`
- `EXPORT_EVENT_DELETED`
- `EXPORT_GUESTBOOK_SNAPSHOT_INVALID`
- `EXPORT_SNAPSHOT_CHANGED`
- `EXPORT_WORKFLOW_DISPATCH_FAILED`
- `EXPORT_FAILED`

Every unknown/internal stored value, including `EXPORT_PART_LIMIT_EXCEEDED`, must project as `EXPORT_FAILED`. No raw string crosses the route.

- [ ] **Step 3: Write zero-photo RED tests**

Change notes-only current complete creation to expect `409 EXPORT_EMPTY` with no job/Workflow. Seed a fully valid historical frozen zero-photo complete job directly: non-null Guestbook counts/event metadata plus valid HTML/CSV inventory. Prove Failed and Expired forms remain listable and retryable and can reach terminal `0 / 0`; a valid Ready form remains downloadable. New current creation still returns `409 EXPORT_EMPTY` and creates/dispatches nothing. Album current creation remains disabled/refused at zero Album photos. Do not add a blanket zero-media database trigger.

- [ ] **Step 4: Run RED**

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/export-api.test.ts \
  tests/worker/export-progress.test.ts
npx vitest run --config vitest.config.ts tests/unit/guestbook-export.test.ts
```

- [ ] **Step 5: Implement latest-per-kind ordering and exact projection**

Keep `listForEvent()` unchanged as the full-history cleanup owner. Add `listLatestForManager()` with a server query/window that selects the latest row per kind and deterministic final order, and use it only in the Manager GET route. Keep the outer envelope and existing endpoints. Map only the shared safe error allowlist and required Manager fields.

- [ ] **Step 6: Enforce new-current zero-photo rules without harming history**

Require at least one active delivered photo in `createActive`; Guestbook rows alone no longer qualify. Do not add a blanket zero-media trigger that would invalidate historical jobs.

- [ ] **Step 7: Preserve retry refusal atomicity**

`EXPORT_SOURCE_REMOVED` must still return 409 before attempt/state mutation, artifact deletion, or Workflow dispatch. Retain all Slice 1 source/tombstone proofs.

Retry must also atomically prove that the candidate is still the server-selected latest job of its kind (`created_at`, then `id`). A stale tab retrying an older terminal job returns `409 EXPORT_ALREADY_ACTIVE` with refresh-oriented copy before attempt/state mutation, artifact deletion, or dispatch. The client reloads the export resource after this refusal so it adopts the newer job. Add a two-tab race: tab A retains older failed A, tab B creates newer terminal B, and tab A cannot queue hidden A or make Manager liveness disappear.

- [ ] **Step 8: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/export-api.test.ts \
  tests/worker/export-progress.test.ts \
  tests/worker/media-recovery-api.test.ts
npx vitest run --config vitest.config.ts tests/unit/guestbook-export.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 9: Record and independently review Task 7**

Require exact allowlist, deterministic ordering, and historical-zero compatibility review with no P1/P2.

---

### Task 8: Frozen-versus-current export UI, progress, and global liveness

**Findings:** C-05, C-32, C-33, C-41, C-47, C-54

**Files:**

- Modify: `src/features/gallery/export-control-status.tsx`
- Modify: `src/features/gallery/GalleryExportControl.tsx`
- Modify: `src/features/gallery/AlbumExportControl.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/host-private-gallery.test.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/manager-resources.test.tsx`
- Modify: `tests/unit/guestbook-export.test.ts`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/album-workspace.spec.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**

- Reuses `eventDateTimeDisplay` for prepared/started/completed instants.
- Consumes complete count/trust from the adopted event resource and Album count/trust from Slice 2's audience summary, both owned at Manager scope.
- Reuses the existing 10-second active export poll; polling is no longer gated by the Gallery section.

The moved audience owner produces exactly:

```ts
interface GalleryAudienceAuthority {
  summary: GalleryAudienceSummaryView | null;
  freshness: 'fresh' | 'stale' | 'unavailable';
  failure: LoadFailure | null;
  reload(): Promise<void>;
  invalidate(): void;
}
```

`fresh` means the current Manager resource generation reached Ready. A retained prior value after a failed or invalidated reload is `stale`, never fresh merely because `summary` remains non-null. With no usable value, authority is `unavailable`.

- [ ] **Step 1: Write terminal-card RED matrices for both controls**

For every terminal job assert `Prepared <event-zone snapshotAt> · N photos · <state>`. The action matrix is exact: Ready keeps Download; ordinary Failed/Expired keeps `Retry this prepared export`; `EXPORT_SOURCE_REMOVED` omits Retry and offers only the current-source path; and every valid terminal card also offers separate `Prepare current collection` / `Prepare current Album` whenever neither kind is active. Never hide Prepare current merely because live and frozen counts are equal.

Cover equal counts, positive/negative deltas, and retained-but-stale live reads. Stale state may show the last count but must not claim `matches current` or a precise delta. Even a trusted equal count is only numeric context and must not claim source identity; do not invent membership hashing in Slice 3.

- [ ] **Step 2: Write state/error/cross-kind RED matrices**

Assert:

- queued and running have distinct labels;
- running shows coarse elapsed time from normalized `startedAt` and `processed / total` when present;
- failed partial progress remains visible;
- every allowed error has one action-oriented message and unknown errors use the generic safe message;
- the inactive kind names which kind is active and why Prepare/Retry must wait;
- terminalization unlocks the other kind.

Use the existing poll/render cadence for elapsed copy (`less than a minute`, whole minutes, whole hours); do not add a second per-card timer.

- [ ] **Step 3: Write zero-photo and authority RED tests**

Complete export is disabled at `storedMediaCount === 0`, even with Guestbook summaries, with a local reason. Album uses trusted `summary.albumPhotoCount`, never `ManagerAlbum`'s locally loaded `photos.length`. A stale summary cannot assert equality. Move—not duplicate—the existing audience `useManagerResource` ownership from `ManagerGalleryWorkspace` to `ManagerPage`, derive `GalleryAudienceAuthority`, and pass that interface back into the workspace. The workspace handle and Album mutations delegate to that Manager-owned invalidator. Test one owner/request plus a retained stale count that produces neither equality nor delta copy.

- [ ] **Step 4: Write global-polling RED tests**

Extend the existing generation/race tests to prove polling and the Manager-owned audience authority continue after leaving Gallery, one compact active-kind status stays visible outside Gallery, no duplicate request/interval is created, stale/event-A results cannot enter event B, terminal jobs stop polling, and returning to Gallery does not create a second live announcement or second audience resource.

- [ ] **Step 5: Run UI RED**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/host-private-gallery.test.tsx \
  tests/ui/album-workspace.test.tsx \
  tests/ui/app.test.tsx \
  tests/ui/manager-resources.test.tsx \
  tests/unit/guestbook-export.test.ts
```

- [ ] **Step 6: Centralize presentation in the existing status module**

Add prepared snapshot, queue/run/progress/elapsed, safe failure, and cross-kind wait formatting to `export-control-status.tsx`. Both controls consume it. Do not add another status component hierarchy or full-history UI.

- [ ] **Step 7: Wire trusted counts and current actions**

Pass complete count with event-resource trust and Album count with the Manager-owned audience-resource trust. Move the current resource owner out of `ManagerGalleryWorkspace`; pass one authority object into that workspace so its presentation, Retry, and invalidation continue to use the same generation. Preserve the frozen terminal card while always showing a separate current-source action when no job is active. Source-removed jobs do not offer a retry the Worker must refuse; their action is the current-source path.

- [ ] **Step 8: Keep liveness at Manager scope**

Remove only the `section === 'gallery'` poll guard. Render one compact active-kind status adjacent to the persistent Manager notice/recovery region when Gallery controls are absent. Reuse one live owner so compact and full status do not compete.

- [ ] **Step 9: Verify UI and browser GREEN**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/host-private-gallery.test.tsx \
  tests/ui/album-workspace.test.tsx \
  tests/ui/app.test.tsx \
  tests/ui/manager-resources.test.tsx \
  tests/unit/guestbook-export.test.ts
npx playwright test \
  tests/e2e/album-workspace.spec.ts \
  tests/e2e/manager-responsive.spec.ts \
  tests/e2e/accessibility.spec.ts
npm run typecheck
npm run typecheck:e2e
git diff --check
```

- [ ] **Step 10: Record and independently review Task 8**

Require exact frozen/current language, authoritative-count sourcing, no duplicate polling/live regions, and no P1/P2.

---

### Task 9: One Manager-owned Undo controller with exact remaining time

**Findings:** Foundation for C-19, C-36, C-42

**Files:**

- Modify: `src/features/gallery/undo.tsx`
- Create: `tests/ui/manager-undo.test.tsx`

**Interfaces:**

- Converts and extends the current `useUndo`/`UndoBar` implementation; it does not create a parallel Undo engine.
- Adds `TRASH_UNDO_WINDOW_MS = 30_000`, `ManagerUndoProvider({ eventId, children })`, `useManagerUndo()`, and the sole provider-bound `ManagerUndoBar`.
- Adds one exported normalized failure sentence: `UNDO_FAILED_MESSAGE = 'Undo could not be completed. Check the current Manager state, then try Undo again.'`
- Uses the spec's `ManagerUndoOffer` and `ManagerUndoController` contract.
- `useManagerUndo()` is the only public registration/controller hook. The bar consumes private context presentation state internally; remove or make the old standalone `useUndo()` private after all consumers migrate.
- `present(offer, { fallback })` passes the already-established `HTMLElement | null` only as provider-owned focus metadata; the offer and its `run()` command never retain a DOM reference.

- [ ] **Step 1: Write provider/controller RED tests**

Cover:

- idle/failed offer replacement;
- running slot lock and `canPresent === false`;
- event-ID mismatch rejection;
- event change clearing offer/error/timers/holds and ignoring stale settlement;
- exact remaining-duration pause/resume with nested focus and pointer holds;
- running pause and failed run returning with the pre-run remainder, not a fresh window;
- trash's nonpausable absolute `restoreUntil` cap during holds and near-deadline activation;
- keyboard focus to Undo, pointer stability, connected origin restoration, and disconnected-origin heading fallback;
- delayed canonical confirmation: keyboard focus moves to Undo only if focus is still on the established fallback or `<body>`; if the host moved into another control while saving, presentation preserves that focus and announces without stealing it;
- a failed reversal always uses normalized stable copy and exposes Retry while the same offer remains valid; raw thrown/API messages never render. Consumer tests, not this generic controller test, own canonical invalidation assertions.

- [ ] **Step 2: Run controller RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-undo.test.tsx
```

Expected: current `useUndo` has no provider/event contract and restarts a full duration after an expired hold or failed run.

- [ ] **Step 3: Convert the existing controller**

Track monotonic deadline and exact remaining duration. The first hold captures remaining time; nested holds do not reset it; final release resumes only that remainder. Running pauses duration expiry. A failed run returns to Offered with its pre-run remainder. The absolute cap runs independently and can retire trash while held.

- [ ] **Step 4: Add Manager context and focus ownership**

The provider owns event generation, one slot, input origin, fallback target, timer/error state, and stale-settlement guards. `present()` returns false on event mismatch or while running. Convert `UndoBar` into the provider-bound `ManagerUndoBar`; it reads private presentation state internally while consumers receive only `useManagerUndo()`. Render `UNDO_FAILED_MESSAGE` and the same Undo action for retry; never expose a caught message. Keep the provider data-agnostic: each Task 10 inverse command invalidates/reloads its affected Manager resources before rejecting an uncertain or partial reversal.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/manager-undo.test.tsx \
  tests/ui/album-workspace.test.tsx
npm run typecheck
git diff --check
```

- [ ] **Step 6: Record and independently review Task 9**

Review timer math with fake time and ensure there remains one implementation, not wrapper-plus-old competing state.

---

### Task 10: Mount-independent inverse commands and the sole persistent Undo bar

**Findings:** C-19, C-36, C-42

**Files:**

- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx`
- Modify: `src/features/gallery/album-api.ts`
- Modify: `src/features/gallery/SelectionTray.tsx` only if the running-slot disabled state must be surfaced there.
- Modify: `src/features/gallery/undo.tsx`
- Modify: `tests/ui/manager-undo.test.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/host-private-gallery.test.tsx`
- Modify: `tests/ui/manager-recovery.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**

- Uses existing `fetchAlbum`, `setAlbumPicks`, `saveAlbumOrder`, trash Restore, and Manager resource invalidators.
- Removes child `useUndo()`/`UndoBar` instances from Album and Library and the Intake-only recovery bar.
- Adds only one Manager-owned monotonic `galleryMutationEpoch` plus a stable `invalidateGalleryAfterMutation()` callback. The workspace consumes the epoch to retire/reload its current Library, Album, and Shared presentation while preserving the selected Gallery mode; this is invalidation of existing owners, not a new cache or command bus.

- [ ] **Step 1: Write persistence and inverse RED tests**

For trash, Album photo removal, bulk Library removal, section removal, Reset, and Start empty, assert that the offer survives a Gallery mode or Manager section unmount and completes through API clients plus Manager invalidation. Assert no offer's `run` closes over child dispatch, draft refs, journals, queues, or DOM callbacks by proving it succeeds after those children unmount. Add a deferred Album-membership-success/order-save case: no Undo is registered while the exact forward Album save is pending, navigation preparation keeps Album mounted, and the eventual confirmed offer survives unmount and restores the photo at its original position. With unchanged keyboard fallback, confirmation focuses Undo; if the host moved focus into another Album control during the save, confirmation preserves it and only announces the offer. Add the partial-forward case: unpick succeeds, order save fails or loses its response, canonical reconciliation completes before leave preparation becomes terminal, then Discard/unmount still leaves the exact appropriate API-only offer. Exercise that repick-only inverse while Album remains mounted: the Manager epoch must retire the failed queue/draft generation, Retry cannot replay the old unpick/order intent, the selected Gallery mode stays Album, and an unmount/remount shows canonical restored state. Add rapid/coalesced forward mutations proving only the newest exact classified mutation can register the slot.

- [ ] **Step 2: Write the complete fallback matrix RED**

Cover next, previous, then heading fallback for:

- Album photo removal;
- section removal;
- Reset;
- Start-empty reconciliation;
- filtered-Library removal.

Keyboard activation focuses Undo after the mutation owner first establishes the fallback. Pointer activation leaves focus on the surviving fallback. Provider restoration uses only a still-connected target, otherwise the current section heading.

- [ ] **Step 3: Establish canonical inverse payloads**

Capture one immutable inverse payload and the already-established focus fallback before each mutation, then associate them with the existing Album operation cursor/draft key. Force undoable queued drafts to send immediately through the existing autosave queue, but call `present(offer, { fallback })` only after that exact forward outcome is canonically classified. The provider decides focus at that moment: keyboard presentation focuses Undo only if the host is still on the fallback or `<body>`; otherwise it preserves the control they moved to. Navigation preparation already keeps Album mounted while save/reconciliation is unsettled. If a newer/coalesced draft supersedes the key, the older classification registers nothing; only the newest exact classified mutation may own the slot. The registered command contains only immutable payload/revision plus API clients and the stable Manager-owned invalidator—never the queue, operation journal, focus element, refs, dispatch, workspace ref method, or child callback. Do not add a forward-receipt abstraction, second save queue, or command bus.

Define one narrow Album inverse runner beside the existing clients in `album-api.ts`. It fetches canonical Album state, verifies the captured forward revision/state, and uses `setAlbumPicks` plus `saveAlbumOrder` with captured pre-mutation entries/metadata. Section removal and Reset need order/metadata restoration only. ManagerAlbum photo removal is not normally membership-only: after both unpick and Album-order save confirm, register the full inverse against that canonical revision. If unpick confirms but the order save fails or its response is lost, reconcile before surfacing terminal preparation: exact full-forward state gets the full inverse; exact pre-state means no mutation/no offer; exact pre-save revision plus the expected unpicked projection gets a repick-only inverse because the retained stored order still owns the original position; anything else fails closed with canonical reload and no overwrite. Library bulk removal remains membership-only and can register after its direct response.

For photo restoration, verify the canonical forward state before restoring membership, refetch the resulting revision, then restore captured order/metadata. If membership succeeds but order save fails, call the Manager invalidator before rejecting and retain the normalized failed-reversal offer; Retry detects already-restored membership, verifies the expected intermediate canonical state, and resumes the order write without repeating or journal-replaying. Any unrelated revision/state conflict fails closed, invokes the same Manager invalidator, and never overwrites newer Album work.

`ManagerPage` owns the monotonic epoch because it stays mounted across Manager sections. Its stable invalidator increments that epoch and invalidates/reloads the already-owned audience plus affected event/intake/Guestbook resources; it does not call a child ref. `ManagerGalleryWorkspace` preserves `mode`, but keys/remounts the current Album and Library data owners from the epoch and invalidates its existing Shared resource, so a mounted failed Album queue cannot replay stale forward intent after Undo. When Gallery is unmounted, the next mount receives the current epoch and starts from canonical reads. Every inverse success and every uncertain/partial reversal path invokes this same boundary before resolving or rejecting.

- [ ] **Step 4: Mount the sole provider/bar at event scope**

Wrap the event-scoped Manager once. Render the only `ManagerUndoBar` immediately after the existing Manager visible notice/live-recovery region and outside conditional sections/modes. On event change clear the controller before new children can present.

- [ ] **Step 5: Migrate consumers and enforce the running lock**

Every offer includes `eventId`, exact duration, optional trash absolute deadline, and keyboard/pointer input. Disable operations that would register another offer while Undo runs. A second idle/failed offer replaces atomically. Task 8's Manager-owned audience invalidator is the one summary refresh path used after inverse success or failed/conflicted reversal.

- [ ] **Step 6: Add Reset's pre-action consequence**

Before activation, associate `Reset to timeline order` with copy stating it removes every section and can be undone for nine seconds. Derive the duration wording from the shared Undo constant/helper, not a second magic value or modal.

- [ ] **Step 7: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/manager-undo.test.tsx \
  tests/ui/album-workspace.test.tsx \
  tests/ui/host-private-gallery.test.tsx \
  tests/ui/manager-recovery.test.tsx \
  tests/ui/app.test.tsx
npx playwright test \
  tests/e2e/manager-responsive.spec.ts \
  tests/e2e/accessibility.spec.ts
npm run typecheck
npm run typecheck:e2e
git diff --check
```

- [ ] **Step 8: Record and independently review Task 10**

Require a source scan proving exactly one provider/bar owner and no child-state closure in any inverse, plus no P1/P2.

---

### Task 11: Complete Cover-style preview readiness through the existing loader

**Findings:** C-25

**Files:**

- Modify: `src/features/cover/CoverStylePicker.tsx`
- Modify: `src/features/cover/use-cover-studio-session.ts`
- Modify: `src/features/cover/CoverStudio.tsx`
- Modify: `tests/ui/cover-studio.test.tsx`
- Modify: `tests/ui/cover-studio-session.test.tsx`
- Modify: `tests/e2e/event-cover-studio.spec.ts`

**Interfaces:**

- Reuses `ensureEffectPreview`, preview byte/URL/promise maps, attempted set, and per-effect AbortControllers.
- The fixed `EVENT_COVER_EFFECTS` list is the prefetch bound, and prefetch begins only while the Style step is visible.

- [ ] **Step 1: Write hook/presentation RED tests**

Prove:

- entering the visible Style step asks once for each of the five current choices and never before it;
- an existing in-flight/cached effect is deduplicated;
- Retry clears only that effect's failed-attempt marker and reuses its existing controller path;
- loading or failed refresh retains the last usable preview URL until a replacement succeeds;
- replacement revokes the prior URL exactly once;
- discard/unmount aborts owned requests and no second controller exists;
- the working event cover/canvas remains unchanged when a style tile fails.

- [ ] **Step 2: Run RED**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/cover-studio.test.tsx \
  tests/ui/cover-studio-session.test.tsx
```

- [ ] **Step 3: Expose one bounded prefetch entry point**

Return a narrow session method that calls the existing `ensureEffectPreview` for the fixed visible choices. `CoverStudio` invokes it on entry to the Style step. Do not add an IntersectionObserver, global queue, second cache, or second abort owner.

- [ ] **Step 4: Retain last usable tile imagery**

Allow loading/error thumbnail state to carry a prior URL. Render that image while announcing Loading or presenting Retry. Swap/revoke only when a new blob succeeds or the owning session is retired.

- [ ] **Step 5: Verify GREEN and the real flow**

```bash
npx vitest run --config vitest.config.ts \
  tests/ui/cover-studio.test.tsx \
  tests/ui/cover-studio-session.test.tsx
npx playwright test tests/e2e/event-cover-studio.spec.ts
npm run typecheck
npm run typecheck:e2e
git diff --check
```

- [ ] **Step 6: Record and independently review Task 11**

If the component-level Loading/Retry behavior already passes, record it as retained and limit production changes to the missing ownership/prefetch/last-usable behavior.

---

### Task 12: Slice 3 matrix, broad verification, and final independent review

**Findings:** C-05, C-07, C-13, C-14, C-19, C-25, C-26, C-32, C-33, C-36, C-41, C-42, C-47, C-54

**Files:**

- Modify only the `## Slices 3–6` tail of `docs/superpowers/host-gallery-verification-matrix.md`.
- Create/update Slice 3 reports under `.superpowers/sdd/2026-08-25-host-gallery-completion-liveness/`.

- [ ] **Step 1: Fill all 14 Slice 3 matrix rows**

Use only `implemented` or `verified-existing`, with C-13 expected to be `verified-existing` if its unchanged regression remains authoritative. Each row names concrete behavior and exact test titles. Retain a `Slices 4–6` placeholder and preserve lines 1–96 byte-for-byte unless a review proves a prior row false.

- [ ] **Step 2: Run the focused unit/UI matrix**

```bash
npx vitest run --config vitest.config.ts \
  tests/unit/settings-autosave-queue.test.ts \
  tests/unit/autosave-status-text.test.ts \
  tests/ui/event-settings-editor.test.tsx \
  tests/ui/event-appearance-editor.test.tsx \
  tests/ui/manager-settings-autosave.test.tsx \
  tests/ui/app.test.tsx \
  tests/ui/manager-undo.test.tsx \
  tests/ui/album-workspace.test.tsx \
  tests/ui/host-private-gallery.test.tsx \
  tests/ui/manager-recovery.test.tsx \
  tests/ui/manager-resources.test.tsx \
  tests/ui/cover-studio.test.tsx \
  tests/ui/cover-studio-session.test.tsx \
  tests/unit/guestbook-export.test.ts \
  tests/unit/deploy-built.test.ts
```

- [ ] **Step 3: Run the focused Worker/migration matrix**

```bash
npx vitest run --config vitest.worker.config.ts \
  tests/worker/migration-0019.test.ts \
  tests/worker/migration-0020.test.ts \
  tests/worker/export-progress.test.ts \
  tests/worker/export-api.test.ts \
  tests/worker/core-journey.test.ts \
  tests/worker/media-recovery-api.test.ts \
  tests/worker/cleanup.test.ts \
  tests/worker/notifications.test.ts
npx vitest run --config vitest.config.ts tests/unit/ci-migration-check.test.ts
npm run verify:fresh-d1 -- \
  --run-root <absolute-os-temp-directory-named-candidary-release-*> \
  --report-file <that-directory>/migration-verification.json
```

- [ ] **Step 4: Run the focused browser matrix**

```bash
npx playwright test \
  tests/e2e/album-workspace.spec.ts \
  tests/e2e/error-recovery.spec.ts \
  tests/e2e/manager-responsive.spec.ts \
  tests/e2e/accessibility.spec.ts \
  tests/e2e/event-cover-studio.spec.ts
```

- [ ] **Step 5: Run static/build gates**

```bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run build
npm run verify:fresh-d1 -- \
  --run-root <absolute-os-temp-directory-named-candidary-release-*> \
  --report-file <that-directory>/migration-verification.json
git diff --check
```

- [ ] **Step 6: Verify preservation and inspect the complete source diff**

Recompute both preserved prefix hashes—lines 1–76 must remain `5627b1e2319edde14d769b42e092699e4ff8666813dfb49912d89327a08c7bcd`, and lines 1–96 must remain `385411e0ed16105b5915fd32b8f30c6d8848dfd853ffe615169756a26f218800`—resolve every quoted matrix test title with fixed-string searches, inspect `git status --short` and `git diff --stat`, and remove only Slice 3 accidental churn or temporary artifacts. Do not clean the intentional Slice 1–2 diff.

- [ ] **Step 7: Independent final reviews**

Obtain separate code/race review and spec/UX/accessibility review. Run the Impeccable detector exactly once over scoped Slice 3 frontend files, inspect the rendered desktop/mobile paths, and fix every P1/P2 before declaring Slice 3 complete. Record any narrow P3 or intentional advisory honestly.

## Slice 3 task order and overlap rulings

1. Tasks 1–3 close the autosave/navigation P1s first and establish the exact discard contract.
2. Tasks 4–7 are schema-first and strictly sequential: migration, repository, Workflow/cleanup, then public projection.
3. Task 8 consumes Task 7's contract and Slice 2's trusted counts; it must not infer new server behavior from mocked UI fixtures.
4. Tasks 9–10 are sequential because consumer migration depends on the completed provider/timer contract.
5. Task 11 is code-independent but executes after the higher-severity work to keep reviews and the shared dirty worktree legible.
6. Task 12 runs only after every task review is free of P1/P2.

Highest-overlap files (`ManagerPage.tsx`, `ManagerAlbum.tsx`, `ManagerGalleryWorkspace.tsx`, `ManagerPrivateGallery.tsx`, `undo.tsx`, `app.test.tsx`, `album-workspace.test.tsx`, Manager responsive/accessibility specs) are edited sequentially. Parallel agents may perform read-only review or work on non-overlapping files, but only one implementer owns an overlap surface at a time.

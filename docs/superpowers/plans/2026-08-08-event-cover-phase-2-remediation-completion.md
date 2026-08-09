# Event Cover Phase 2 Remediation and Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the reviewed Task 2–5 safety and operator-contract defects, then complete original Phase-2 Tasks 6–9 without entering the separately authorized candidate, staging, or production gates.

**Architecture:** D1 remains the durable authority for every dispatch, fence, and proof transition. Workflow platform calls occur only after a committed D1 claim, every deletion fence remains non-expiring until terminal state is observed, and restart reuses already-pinned render identity. The release-only launcher becomes a two-stage claim/launch protocol so stale remote SQL cannot cause an unclaimed platform creation.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers Workflows, D1, R2, Vitest, Wrangler 4.x, React/Vite.

## Global Constraints

- Binding sources are `docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md` sections 9.4, 9.5, 14, and the corrected `docs/superpowers/plans/2026-08-05-event-appearance-cover-studio-phase-2.md`.
- Work only in `.worktrees/cover-studio-phase-2` on `agent/event-cover-studio-phase-2`; preserve the caller's main checkout and unrelated artifacts.
- Do not merge, push, deploy, apply remote migrations, trigger remote Workflows, or mutate remote D1/R2. Stop after original Task 9.
- Do not add a migration. Candidate inventory remains exactly `0001` through `0012`.
- Do not add an authentication surface, release key, cron expression, binding, or phase-3 code.
- `STALE_DISPATCH_CLAIM_MS` remains exactly two minutes. A younger `creating`, `resuming`, or `restarting` claim stops that purge pass.
- `MAX_COVER_PURGE_FENCES_PER_PASS = 10` and `MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS = 5`. A status read consumes a fence slot; create, resume, restart, or terminate consumes a platform-mutation slot.
- `unknown` platform lookup is telemetry-only: no D1 mutation, no platform mutation, and no fence release. A Workflow instance can outlive completed-state retention.
- An open fence uses the non-expiring sentinel `9999-12-31T23:59:59.999Z`. Its real expiry is stamped exactly 31 days after an observed or self-recorded terminal outcome.
- Backfill creation batch, in-flight, and rolling-minute limits remain 25. Inventory page and generic cleanup limits remain 100 outside the separately bounded event-purge fence loop.
- The restart window remains 24 hours. Existing `master_id`, `render_set_id`, `manifest_json`, and `manifest_sha256` are immutable once present.
- Raw private object keys stay only in ignored `output/` or outside the checkout. Tracked artifacts contain no secrets, raw object keys, or private payloads.
- Every behavioral change uses strict red-green TDD: add one behavior test, run it and observe the expected failure, implement minimally, rerun it green, then run the affected file gate.
- Use explicit staging allowlists for every commit. Each task is one independently reviewable commit unless its scoped reviewer requires a follow-up fix commit.

---

### Task 1: Reconcile the authoritative Phase-2 plan with the binding design

**Files:**

- Modify: `docs/superpowers/plans/2026-08-05-event-appearance-cover-studio-phase-2.md`
- Add: `docs/superpowers/plans/2026-08-08-event-cover-phase-2-remediation-completion.md`

**Interfaces:**

- Consumes: the binding constraints above and the completed read-only review at SHA `629d107a871878f1b39225fa43c26d2fa98562b2`.
- Produces: one internally consistent execution contract for Tasks 2–9; it does not change runtime behavior.

- [ ] **Step 1: Correct Task 2 ownership and bounds**

Add `shared/constants.ts`, `worker/services/event-cover-publication.ts`, `worker/routes/manage.ts`, `src/pages/ManagerPage.tsx`, and their focused tests to Task 2. Replace the generic purge limit with the exact rule:

```md
Inspect at most `MAX_COVER_PURGE_FENCES_PER_PASS = 10` fences and perform at most
`MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS = 5` platform mutations. Stop on a
young dispatch claim or `unknown`; neither condition advances the cursor or phase.
```

State that an open fence receives the sentinel expiry and only a terminal transition stamps `now + 31 days`. Add the Manager route's `202 { deletionScheduled: true }` and UI-copy obligation.

- [ ] **Step 2: Correct the launcher command and claim protocol**

Replace the blanket remote-command sentence with:

```md
D1 commands include `--remote --config wrangler.jsonc --json`. Workflow trigger,
terminate, resume, and restart commands include `--config wrangler.jsonc` and never
`--local`; they do not accept `--remote` in Wrangler 4.113.
```

Update Tasks 3–4 so dispatch has two durable stages: a transactional claim artifact followed by a saved post-claim read; only that saved read may produce Workflow trigger steps.

- [ ] **Step 3: Correct Task 5 restart and total-map requirements**

Record these exact edges:

```md
paused -> resume regardless of retryable failed/nonterminal D1 status;
complete + already-terminal D1 -> no mutation;
certified missing + restorable confirmed job -> recreate same ID;
blocked or missing fence -> EVENT_DELETED;
restart with pinned derived state -> validate the frozen manifest and at most 24 exact
render-object rows, use whole-profile completeness only to claim rendering vs finalizing,
preserve master_id, render_set_id, manifest_json, and manifest_sha256 byte-for-byte,
then call restart(id) without from options;
restart without pinned derived state -> claim queued and call restart(id) without from options.
```

- [ ] **Step 4: Verify documentation consistency and Wrangler syntax**

Run:

```powershell
npx wrangler workflows trigger --help
npx wrangler workflows instances terminate --help
git diff --check
```

Expected: help exits 0; Workflow commands show `--local` and `--config` but no `--remote`; diff check exits 0.

- [ ] **Step 5: Commit the reconciled plans**

```powershell
git add -- docs/superpowers/plans/2026-08-05-event-appearance-cover-studio-phase-2.md docs/superpowers/plans/2026-08-08-event-cover-phase-2-remediation-completion.md
git commit -m "docs: reconcile phase 2 completion contract"
```

---

### Task 2: Make deletion fencing terminal-proof and bounded

**Files:**

- Modify: `shared/constants.ts`
- Modify: `worker/services/event-cover-publication.ts`
- Modify: `worker/workflows/cover-render.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `scripts/cover-backfill.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/worker/cleanup.test.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/cover-render-workflow.test.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
- Modify: `tests/unit/cover-backfill-launcher.test.ts`

**Interfaces:**

- Produces: `COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT`, `coverWorkflowFenceTerminalExpiry(now)`, and `deleteEventData(...): Promise<CoverPurgeProgressSummary>`.
- Preserves: `reconcileEventCoverPurge(...)`, deterministic Workflow IDs, and the existing relational deletion order.

- [ ] **Step 1: Write RED fence-lifetime tests**

Add behavior tests proving all of the following:

```ts
// An open render/backfill fence is created with 9999-12-31T23:59:59.999Z.
// Generic expiry cleanup does not delete that open fence after 32 days.
// unknown + age > 31 days + terminate failure keeps deletion-blocked and blocks R2.
// a verified terminal lookup stamps now + 31 days, after which bounded cleanup may delete.
// render/backfill self-recorded terminal outcomes stamp the same terminal expiry.
```

Run each changed test file and observe failure against the creation-relative TTL or age-based settlement.

- [ ] **Step 2: Implement the shared hold and terminal-expiry contract**

Add to `shared/constants.ts`:

```ts
export const COVER_WORKFLOW_FENCE_HOLD_EXPIRES_AT = '9999-12-31T23:59:59.999Z';
export const COVER_WORKFLOW_FENCE_TERMINAL_TTL_MS = 31 * 24 * 60 * 60 * 1000;
export function coverWorkflowFenceTerminalExpiry(now: Date): string {
  return new Date(now.getTime() + COVER_WORKFLOW_FENCE_TERMINAL_TTL_MS).toISOString();
}
```

Use the hold value for every initial render/backfill fence and every create/resume/restart claim. In the D1 batches that record render/backfill terminal outcomes, update the matching fence to the derived terminal expiry. Do not stamp terminal expiry on a retry claim; a later claim restores the hold value.

- [ ] **Step 3: Write RED purge-bound and young-claim tests**

Create fixtures with 11 fences and six active instances. Assert one pass inspects exactly 10, performs no more than five platform mutations, persists the last fully settled cursor, and reports `remainder: true`. Add `creating`, `resuming`, and `restarting` fixtures at 119 seconds and 121 seconds; young claims make zero platform calls while stale claims enter normal lookup resolution.

- [ ] **Step 4: Implement the bounded purge loop**

Shape the loop around both budgets:

```ts
for (const fence of held.results.slice(0, MAX_COVER_PURGE_FENCES_PER_PASS)) {
  if (isYoungClaim(fence, now)) break;
  const lookup = await purgeLookup(...); // consumes one fence slot
  if (lookup.kind === 'unknown') break;
  if (requiredMutations(lookup) > remainingMutationBudget) break;
  // materialize/terminate as required, re-read, and settle only observed terminal.
}
```

The initial soft-delete/revocation batch may terminalize the ledger result, but it must preserve the prior `creating`, `resuming`, or `restarting` dispatch state and its claim timestamp until the fence coordinator resolves that claim. Extend `HeldFenceRow` by joining the render receipt or backfill job on binding/instance ID so `isYoungClaim` reads the durable claim state and clock rather than fence creation time.

Remove `FENCE_UNRESOLVABLE_AFTER_MS` and every age-based unknown release. A failed terminate keeps the fence blocked. Advance the cursor only after the current fence is terminal and its expiry update changes one row. A fresh zero-fence query remains the only transition to `r2`.

- [ ] **Step 5: Write RED Manager deletion contract tests**

Assert a parked purge returns HTTP 202 with exactly `data.deletionScheduled === true`; a synchronously completed purge may return HTTP 200 with `data.deleted === true`. Assert the danger-zone copy promises immediate access revocation and scheduled cleanup, not immediate physical removal.

- [ ] **Step 6: Return purge progress and expose safe HTTP semantics**

Change the wrapper and route along this shape:

```ts
export async function deleteEventData(...): Promise<CoverPurgeProgressSummary> {
  return reconcileEventCoverPurge(...);
}

const summary = await deleteEventData(context.env, auth.event.id);
return summary.remainder
  ? context.json({ data: { deletionScheduled: true }, requestId }, 202)
  : context.json({ data: { deleted: true }, requestId });
```

Keep the client redirect behavior, but change its confirmation copy so it does not claim every file is already gone while cleanup is pending.

- [ ] **Step 7: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cleanup.test.ts tests/worker/manage-api.test.ts tests/worker/cover-render-workflow.test.ts tests/worker/cover-backfill-workflow.test.ts
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-launcher.test.ts
npm run typecheck
npm run lint
git add -- shared/constants.ts worker/services/event-cover-publication.ts worker/workflows/cover-render.ts worker/workflows/cover-backfill.ts worker/workflows/cleanup.ts scripts/cover-backfill.ts worker/routes/manage.ts src/pages/ManagerPage.tsx tests/worker/cleanup.test.ts tests/worker/manage-api.test.ts tests/worker/cover-render-workflow.test.ts tests/worker/cover-backfill-workflow.test.ts tests/unit/cover-backfill-launcher.test.ts
git commit -m "fix: retain cover fences through terminal proof"
```

---

### Task 3: Couple committed launcher claims to platform triggers

**Files:**

- Modify: `shared/cover-dispatch.ts`
- Modify: `scripts/cover-backfill.ts`
- Modify: `package.json`
- Modify: `tests/unit/cover-backfill-launcher.test.ts`

**Interfaces:**

- Produces: launcher mode `launch`, `claimedDispatchSql(runId, candidates)`, and a claim artifact that contains no Workflow trigger.
- Consumes: the same deterministic job, event, Workflow ID, generation, fence, in-flight, and rolling-minute predicates used by Worker recovery.

- [ ] **Step 1: Write RED run-state and stale-claim tests**

Execute generated SQL against migrated local D1 and prove:

```ts
// inventorying, verified, failed, and mode != execute runs expose zero dispatchable rows.
// a run changed from executing after the read causes every claim to change zero rows.
// capacity filled after the read causes the guarded claim to change zero rows.
// a zero-row claim leaves no newly inserted generation-zero fence.
```

- [ ] **Step 2: Guard both the dispatch read and committed claim by run state**

Join the target run and require the following in both the read and claim SQL:

```sql
r.id = j.run_id AND r.mode = 'execute' AND r.status = 'executing'
```

Keep the claim/fence statements in one D1 file. After a refused job claim, remove only the just-proposed open generation-zero fence while the same job is still `pending` at the old generation; never delete a concurrently claimed fence.

- [ ] **Step 3: Write RED two-stage operator tests**

Assert `dispatch` emits identity checks, the claim file, and a post-claim read only. It must contain zero `trigger` steps. Feed a saved claimed-row payload containing one accepted and one refused candidate into `launch`; assert exactly one deterministic Workflow trigger and its confirm/receipt reads are emitted. Reject wrong run, generation, fence, status, duplicate row, or unknown row.

- [ ] **Step 4: Implement the claim/launch split**

Extend the mode vocabulary and package script:

```ts
export type CoverBackfillMode =
  | 'inventory' | 'execute' | 'dispatch' | 'launch' | 'confirm' | 'verify';

export function claimedDispatchSql(
  runId: string,
  candidates: readonly DurableDispatchRow[],
): string;
```

`dispatch` writes the transactional claim SQL and a read restricted to the exact candidate `(job_id, event_id, workflow_instance_id, old_generation + 1)` tuples. `launch` consumes that saved read and emits Workflow trigger, confirm-read, and receipt-read steps only for rows currently `creating` with an open matching fence. Workflow commands include `--config wrangler.jsonc`, never `--local` or `--remote`.

- [ ] **Step 5: Run the focused gate and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-launcher.test.ts
npm run typecheck
npm run lint
git add -- shared/cover-dispatch.ts scripts/cover-backfill.ts package.json tests/unit/cover-backfill-launcher.test.ts
git commit -m "fix: trigger only committed cover backfill claims"
```

---

### Task 4: Make platform reconciliation total and restart derived work immutably

**Files:**

- Modify: `worker/workflows/cover-platform.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `tests/worker/event-cover-publication.test.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`

**Interfaces:**

- Produces: `CoverBackfillWorkflowAccessor.restart(id)` and a migration-free restart claim that derives the guarded D1 stage from the frozen manifest plus exact adopted-object rows without changing pinned fields.
- Preserves: the same Workflow instance ID, dependency equality, current-source fingerprint/revision, rate, fence, purge, and restart-window guards.

- [ ] **Step 1: Write RED total-map tests**

Add literal cases for:

```ts
// failed + paused -> one resume call, zero restart calls.
// failed + complete -> no platform/D1 mutation.
// failed + certified missing + valid immutable dependencies -> recreate same ID.
// any blocked or absent fence -> terminal EVENT_DELETED.
// active/waiting/queued status -> no mutation unless confirming a stale recovery claim.
```

- [ ] **Step 2: Implement the total map before the generic restart tail**

Branch on platform disposition first. Paused always takes the guarded resume claim. Complete returns unchanged when D1 is already terminal. Certified missing uses a claim valid for both nonterminal and retryable failed/restorable rows. Change the absent-fence terminal code to `EVENT_DELETED`.

- [ ] **Step 3: Write RED immutable-restart tests**

Seed a retryable failed job with literal existing `master_id`, `render_set_id`, `manifest_json`, and `manifest_sha256`. The frozen manifest contains the expected `(profile, density, format)` tuples. Query at most 24 `event_cover_render_objects` rows using the exact `(render_set_id, event_id)` pair, then validate the manifest SHA, shape, unique known tuples, and every actual row against it. A profile is durably complete only when every expected tuple for that profile exists; one or more rows for a partial profile never count as profile completion.

Cover complete profiles, a partial profile, no adopted objects, invalid SHA/shape, duplicate or unknown manifest tuples, and unexpected object tuples. Invalid manifest/object evidence refuses the guarded restart claim and makes no platform call. After valid reconciliation and Workflow replay, assert the four pinned fields are byte-identical, no replacement master/render set is inserted, and the restart accessor receives only the same Workflow ID. Also cover a failure before normalization, which legitimately claims `queued` and restarts from the beginning.

- [ ] **Step 4: Derive the D1 stage and restart from the beginning**

Use durable object adoption only to choose the guarded D1 stage:

```ts
if (!job.master_id || !job.render_set_id || !job.manifest_json || !job.manifest_sha256) {
  restartStatus = 'queued';
} else if (everyManifestProfileIsDurablyComplete(manifest, adoptedRows)) {
  restartStatus = 'finalizing';
} else {
  restartStatus = 'rendering';
}
await workflow.restart(job.workflow_instance_id);
```

Do not pass `from` options. Cloudflare requires `from.name` to exist in Workflow execution history, while D1 object adoption may commit before that step reaches history and the binding exposes no history API. Restart therefore begins at the Workflow start. Preflight and normalization no-op for guarded `rendering`/`finalizing` jobs, and profile writes replay idempotently against frozen object keys and tuple UPSERTs. The claim sets `queued` only when no pinned derived state exists, clears terminal/reference/expiry fields, restores the fence hold sentinel, increments job/fence generation transactionally, and never rewrites `master_id`, `render_set_id`, `manifest_json`, or `manifest_sha256`.

- [ ] **Step 5: Run the focused gate and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-publication.test.ts tests/worker/cover-backfill-workflow.test.ts
npm run typecheck
npm run lint
git add -- worker/workflows/cover-platform.ts worker/workflows/cover-backfill.ts tests/worker/event-cover-publication.test.ts tests/worker/cover-backfill-workflow.test.ts
git commit -m "fix: preserve derived state across backfill recovery"
```

---

### Task 5: Resolve superseded jobs under one global bound

**Files:**

- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
- Modify: `tests/worker/cleanup.test.ts`

**Interfaces:**

```ts
export interface CoverBackfillLedgerSweepSummary {
  inspectedJobs: number;
  resolvedJobs: number;
  closedVerifiedRuns: number;
  closedFailedRuns: number;
  expiredRunsStamped: number;
  remainder: boolean;
}

export async function resolveSupersededBackfillJobsBounded(
  env: AppEnv,
  now?: Date,
): Promise<CoverBackfillLedgerSweepSummary>;
```

- [ ] **Step 1: Write RED global-bound, fairness, remainder, and expiry-eligibility tests**

Seed 101 blocking jobs ordered so the oldest 100 are still-current blockers and the newer final row is superseded. Assert pass one inspects exactly 100, resolves none, CAS-touches only `updated_at` on those 100, preserves every other job field byte-for-byte, and reports `remainder: true`; assert pass two reaches and resolves the previously starved row. Add boundary cases proving: exactly 100 all-resolved rows report `remainder: true` and a confirming empty pass reports `false`; 99 still-current blockers report `true`; and equal `updated_at` values break ties by `id`. Keep current `needs_replacement` and retryable-inside-window `failed` fixtures blocking with neither reference release nor expiry. Add revision-only movement that remains current and classification-to-write event mutations for both resolution and rotation; each lost CAS must leave the row unresolved and force `remainder: true`. Assert no pass inspects more than 100 rows and only distinct runs containing a job actually resolved in that pass are recounted.

- [ ] **Step 2: Replace the per-run resolver with one global fair selection**

Select globally before grouping by run:

```sql
SELECT ... FROM event_cover_backfill_jobs
WHERE status IN ('needs_replacement', 'failed')
ORDER BY updated_at, id
LIMIT 100
```

A selected row is still current if and only if its event exists with `deleted_at IS NULL`, `cover_object_key IS NOT NULL`, `cover_render_set_id IS NULL`, and the exact stored legacy fingerprint matches that key. Revision movement alone is not supersession. Resolve only rows that fail this currentness predicate. Both the superseded-to-`resolved` write and the fairness-rotation write must compare-and-swap the selected job `id`, status, original `updated_at`, and stored fingerprint together with the exact observed event `cover_object_key`, `deleted_at`, `cover_render_set_id`, and `cover_revision` snapshot, including an observed missing event. Any lost CAS leaves the row unresolved and forces `remainder: true`. A successful fairness rotation sets only `updated_at` to a clock strictly later than both the sweep clock and the selected value, for example `new Date(Math.max(now.getTime(), Date.parse(selected.updated_at)) + 1).toISOString()`. This scheduling-only touch rotates still-current blockers behind previously uninspected rows and must preserve every other job column, including `status`, `dispatch_state`, `retryable`, `failure_code`, `terminal_at`, `reference_release_at`, `expires_at`, run/event/Workflow identity, source revision/fingerprint, dependency pins, and derived-state fields. `terminal_at`, not the fairness touch, remains the restart and retention clock, and existing release/expiry timestamps are never recomputed.

Recompute only distinct runs containing a job actually resolved in this pass; rotating a current blocker alone never triggers a run recount. Keep reference release at seven days and settled job expiry at thirty days. Define `remainder` conservatively as `inspectedJobs === 100 || unresolvedInspectedJobs > 0`, where unresolved includes every inspected row not proven resolved after guarded writes. Thus saturation requires a confirming pass, any current or lost-CAS row keeps `remainder` true, and a sub-limit pass whose inspected rows all resolve returns false.

- [ ] **Step 3: Wire superseded resolution before recovery**

```ts
await resolveSupersededBackfillJobsBounded(env, now);
await recoverStaleInitialBackfillDispatches(env, now);
await reconcileCoverBackfillJobs(env, now);
```

Do not short-circuit recovery or reconciliation when resolution reports `remainder`.

- [ ] **Step 4: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts
npm run typecheck
npm run lint
git add -- worker/workflows/cover-backfill.ts worker/workflows/cleanup.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts
git commit -m "feat: resolve superseded cover backfill jobs globally"
```

---

### Task 6: Make proof atomic and close run lifecycles truthfully

**Files:**

- Create: `shared/cover-backfill-proof.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `scripts/cover-backfill.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
- Modify: `tests/worker/cleanup.test.ts`
- Modify: `tests/unit/cover-backfill-launcher.test.ts`

**Interfaces:**

```ts
export interface ZeroLegacyProof {
  legacyRows: number;
  blockingJobs: number;
  incompleteActiveSets: number;
  uploadsWithoutActiveSet: number;
  proven: boolean;
}

export async function recordZeroLegacyVerification(
  env: AppEnv,
  runId: string,
  now?: Date,
): Promise<{ proof: ZeroLegacyProof; transition: 'verified' | 'failed' | 'unchanged' }>;

export async function closeCoverBackfillRuns(
  env: AppEnv,
  now?: Date,
): Promise<CoverBackfillLedgerSweepSummary>;
```

- [ ] **Step 1: Write RED parity, atomicity, stale-payload, idempotency, and closure tests**

Assert Worker and launcher import the same four predicate builders. A saved green CLI payload followed by a new legacy row must not verify the run. A second Worker call must not restamp `verified_at`. Missing, duplicate, negative, or noninteger CLI count rows are red display evidence and emit no verified update. Assert inventorying/executing runs with incomplete inventory, nonterminal jobs, current `needs_replacement`, or retryable-inside-window failures do not close or receive expiry.

- [ ] **Step 2: Implement canonical proof SQL and the single writer**

Put all four count expressions and zero predicates in `shared/cover-backfill-proof.ts`. The guarded Worker `UPDATE` contains the zero predicates and requires a closable target run in mode `execute` or `verify`. In the same statement set `status = 'verified'`, `verified_at`, `updated_at`, and closed-run expiry. If it changes zero rows, reread counts; guardedly fail only a genuinely closable red run.

- [ ] **Step 3: Remove CLI authority**

The launcher may render counts and issues, but no syntactically green saved payload emits a verified `UPDATE`. `closeCoverBackfillRuns` is the only production caller of `recordZeroLegacyVerification`.

- [ ] **Step 4: Close only eligible runs and wire the final scheduled order**

Select a bounded set of candidate runs. For each genuinely closable run, call `recordZeroLegacyVerification`: green becomes `verified`, red becomes `failed`. Stamp expiry 30 days after the later of closure and the latest job terminal time. Never stamp an `inventorying` or `executing` run that remains incomplete.

```ts
await resolveSupersededBackfillJobsBounded(env, now);
await recoverStaleInitialBackfillDispatches(env, now);
await reconcileCoverBackfillJobs(env, now);
await closeCoverBackfillRuns(env, now);
await cleanupEventCovers(env, now);
await resumeDeletedEventPurges(env, now);
```

Every bounded phase runs even when an earlier phase reports `remainder`; no later phase treats that flag as proof of quiescence.

- [ ] **Step 5: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-launcher.test.ts
npm run typecheck
npm run lint
git add -- shared/cover-backfill-proof.ts worker/workflows/cover-backfill.ts worker/workflows/cleanup.ts scripts/cover-backfill.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts tests/unit/cover-backfill-launcher.test.ts
git commit -m "feat: close cover backfill runs with atomic proof"
```

---

### Task 7: Rehearse the complete interrupted loop on populated local D1

**Files:**

- Create: `tests/worker/cover-backfill-rehearsal.test.ts`
- Create: `tests/unit/cover-backfill-operator-loop.test.ts`
- Modify: `tests/worker/helpers.ts`

**Interfaces:**

- Consumes: Tasks 2–6 production interfaces and generated launcher artifacts.
- Produces: deterministic local orchestration evidence only; it does not claim real Images or deployed Workflow conformance.

- [ ] **Step 1: Build the populated Worker rehearsal fixture**

Seed more than one inventory page and more than one 25-row dispatch batch, including: a conforming cover; same-cover `needs_replacement` later replaced/removed; host replacement before finalize; deletion before dispatch confirmation; deletion after preflight before R2 write; platform error during rendering; missing stale initial create; arbitrary `unknown`; and an already-active complete set.

- [ ] **Step 2: Execute and assert every interrupted transition**

Assert literal proof counts/run counters after each stage, exact IDs and generations, all `remainder` boundaries, zero post-fence objects, no regenerated job ID or pinned render identity, and green proof only after Worker-side atomic transition.

- [ ] **Step 3: Execute the generated operator loop against migrated local D1**

Run inventory, empty-page closure, dispatch claim, saved post-claim read, launch, confirm, receipt read, interruption/re-entry, and verification-display artifacts in exact order. Assert a refused claim cannot reach the trigger list and a failed SQL unit leaves no partial claim/fence pair.

- [ ] **Step 4: Run and time gates, then commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-rehearsal.test.ts
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-operator-loop.test.ts
Measure-Command { npx vitest run --config vitest.worker.config.ts }
npm run typecheck
npm run lint
git add -- tests/worker/cover-backfill-rehearsal.test.ts tests/unit/cover-backfill-operator-loop.test.ts tests/worker/helpers.ts
git commit -m "test: rehearse the interrupted cover backfill loop"
```

---

### Task 8: Write the executable runbook and reconcile release documents

**Files:**

- Create: `docs/cover-backfill-runbook.md`
- Modify: `docs/deployment.md`
- Modify: `docs/operations.md`
- Modify: `design-qa.md`

**Interfaces:**

- Consumes: the exact CLI modes, SQL artifacts, summaries, stop conditions, and evidence boundaries implemented by Tasks 2–7.
- Produces: an operator document that can be dry-walked locally without contacting remote resources.

- [ ] **Step 1: Write the standalone runbook**

Document, in order: authorization boundaries; account/Worker/D1/Workflow/version/migration/SHA identity checks; D1 `--remote --config wrangler.jsonc --json` syntax; private artifact location/deletion; restartable inventory; two-stage claim then launch; one-batch-per-minute `notBefore`; 25-in-flight stop; confirm/receipt handling; Worker-owned recovery; bounded cleanup observation; same-cover `needs_replacement`; Worker-owned atomic proof; seven-day rollback; and every identity/status/fence/proof/SHA stop condition.

Workflow commands use `--config wrangler.jsonc` and never `--remote` or `--local`. Operators never issue raw resume or restart.

- [ ] **Step 2: Reconcile the three release documents**

`docs/deployment.md` separates Phase-2 candidate verification, staging conformance, and production backfill into three authorizations. `docs/operations.md` lists only signals the candidate produces. `design-qa.md` labels deterministic fake orchestration separately from real Images/codec/platform evidence.

- [ ] **Step 3: Dry-walk commands against disposable local D1**

Apply migrations locally and seed the rehearsal fixture. Execute only the generated D1 equivalents, substituting `--local` for `--remote` in the disposable D1 invocation. Do not execute any generated Workflow command during this dry-walk, including trigger or terminate; validate Workflow syntax and ordering only as generated artifact strings. Production Workflow commands remain `--config wrangler.jsonc` with neither `--local` nor `--remote`. Verify D1 exit codes, artifact paths, JSON parsing, and Workflow artifact ordering without authenticating or contacting remote resources.

- [ ] **Step 4: Run documentation/static checks and commit**

```powershell
git diff --check
npm run typecheck
npm run lint
git add -- docs/cover-backfill-runbook.md docs/deployment.md docs/operations.md design-qa.md
git commit -m "docs: make the cover backfill operation executable"
```

---

## Final Pre-Candidate Gate — Stop Before Original Task 10

After Tasks 1–8 receive clean task-scoped reviews, run a whole-branch review against base `85fa9278b05a0af73091e17a2306b97ac2504617`. Resolve any Critical or Important findings in one final fix wave and one scoped re-review.

Then run fresh local pre-candidate evidence:

```powershell
npm run typecheck
npm run lint
npx vitest run --config vitest.config.ts
npx vitest run --config vitest.worker.config.ts
git diff --check 85fa9278b05a0af73091e17a2306b97ac2504617 HEAD
(Get-ChildItem migrations -Filter '*.sql' -File).Count
git status --short --branch
```

Expected: all commands exit 0, exactly 12 migrations, and a clean worktree. Do **not** run `npm run verify:release`, deploy, merge, push, or perform remote/staging/production operations without a new explicit instruction.

# Event Appearance Cover Studio — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert every pre-`0012` legacy cover onto the responsive pipeline and produce the durable zero-legacy proof that phase 3 is gated on. This remediation/completion contract ends after original Task 9 and its pre-candidate local checks: it completes the dispatch, interruption recovery, platform reconciliation, guarded restart, event-purge fencing, ledger lifecycle, atomic verification edges, populated local rehearsal, and local documentation required for independent follow-up planning. It does not execute a candidate gate, deployment, staging conformance, or production backfill.

**Architecture:** The Node launcher remains a dry-run-first **planner**, not a network driver. It reads saved `wrangler d1 execute --json` payloads and emits explicit, ordered artifacts. D1 is the durable source of truth: the launcher never reconstructs a job that already exists, never hard-codes the in-flight count, and emits a Workflow command only for a committed job selected back from D1. Each dispatch generation is claimed on the job and fence together before `wrangler workflows trigger`; the Workflow's first step requires the matching open fence and confirms the generation before Images or R2 work. A bounded Worker reconciler heals an interrupted initial create through idempotent `createBatch`, maps real platform status conservatively, persists platform failure before taking the one guarded restart edge, and leaves every unclassified lookup as `unknown` with no mutation. Event purge uses the existing `event_cover_purge_progress` table to block and settle every cover Workflow fence before deleting R2. The canonical proof has one authoritative Worker-side writer: bounded cleanup re-derives all four predicates in the same guarded D1 transition that records `verified`.

**Tech Stack:** TypeScript 6, Cloudflare Workers/Wrangler 4.113, D1/SQLite, R2, the Images binding, Cloudflare Workflows, Vitest (jsdom + `vitest-pool-workers`/workerd), and Node.js 24 native type stripping for scripts.

---

## Global Constraints

- Implement phase 2 of `docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md` §9.5 plus the §9.4/§14 purge-fence coordinator that must exist before either cover Workflow may be operated remotely. This safety coordinator is not a phase-3 UI or projection feature.
- **`migrations/` must contain exactly twelve files at candidate time.** Phase 2 adds no migration. It uses the job/fence `dispatch_generation` and timestamps already in `0012`; it does **not** invent a nonexistent `event_cover_backfill_jobs.last_dispatch_at` column.
- Phase 2 does not merge, push, deploy, apply a remote migration, trigger a remote Workflow, mutate remote D1/R2, or run a candidate gate. This remediation/completion contract stops after original Task 9 and its pre-candidate local checks. Original Tasks 10–12 are archived future-phase reference only, are not executable under this contract, and require a new explicit plan plus separate authorization.
- Work in a new isolated worktree created from the phase-1 branch tip. Phase 1 is deliberately **not** merged to `main`, and phase 2 does not merge it: the cover-studio branch line accumulates phases and lands as one integration only after every phase of the design spec is complete. Preserve the main checkout's modified `worker/services/email.ts` and all user-owned untracked files.
- Write a failing focused test before each new behavior. Documentation, generated operational artifacts, and recorded evidence are exempt from manufacturing a RED test.
- No new authentication surface, operator HTTP route, release key, cron expression, or rate-limit binding.
- Object keys, R2 pointers, recipes, checksums, raw platform status names, account tokens, and D1 payloads containing private keys never appear in a response body, client module, ticket, PR body, or committed evidence artifact.
- Every D1 transition derived from platform status is Worker-side. The launcher may create the initial run/jobs, claim and confirm an explicitly authorized initial dispatch generation, and create a verification run; it never performs resume/restart reconciliation or writes a `verified` result.
- Use explicit staging allowlists for every commit. Never use `git add worker scripts tests`, `git add docs`, or `git add -A`.
- Run `npm run typecheck`, `npm run lint`, and the task's focused tests before each commit. A future explicit plan may define an immutable aggregate candidate gate after its final candidate head is fixed; this contract does not run it.

## Preconditions and authority boundaries

### Development preconditions

Phase 2 stacks directly on the phase-1 branch tip. It does not require, and must not perform, a merge into `main`.

Phase-2 implementation may start only after:

1. the phase-1 branch tip is fixed and recorded verbatim as the phase-2 base SHA;
2. that recorded base has a passing `verify:release` manifest against `APPROVED_RELEASE_BASE_SHA` (`0b92387d2e237d568d2514373dcc3044e7960d4b`) — a fixed constant the runner validates, never a per-phase branch point;
3. local/test databases contain exactly migrations `0001` through `0012`; and
4. a new isolated phase-2 worktree has been created from that recorded tip.

Merging into `main`, remote `0012`, deployment, Images conformance, Workflow lifecycle proof, and the candidate gate are outside this remediation/completion contract. They require a future explicit plan and authorization.

Phase 2's only overlap with `main`'s post-divergence commits is `docs/deployment.md`; no worker, shared, script, or test target collides. Rebasing the cover-studio line onto `main` is therefore optional during phase 2 and buys nothing for this phase's work. It stays available at any point before the final integration.

### Historical reference only — retired original Tasks 10–12

The following preconditions and original Tasks 10–12 are retained only as historical/future-phase reference. They are **not executable** under this remediation/completion contract, are not "separately authorized" work within it, and must not be used as an instruction to run a candidate gate, deploy, or mutate remote resources. Any future use requires a new explicit plan and a new explicit authorization.

The historical Task 12 text required all of the following independently recorded facts:

1. the exact phase-2 candidate SHA passed `npm run verify:release -- --sha <head> --base-sha <approved-base>`;
2. that exact SHA was reviewed and deployed under separate authorization;
3. `CF_VERSION_METADATA` proves the deployed Worker version corresponds to that exact phase-2 source;
4. remote D1 has `0012_event_cover_storage.sql` and no `0013`;
5. `COVER_RENDER_WORKFLOW`, `COVER_BACKFILL_WORKFLOW`, `DB`, `MEDIA_BUCKET`, and `IMAGES` are bound to the intended production resources, and the preset assets are present;
6. the historical Task 11 staging artifact proves the phase-2 adapter, initial-create recovery, restart, termination, purge-fence, and Images behavior against the real platform; and
7. no other backfill run is inventorying/executing and no unresolved event purge already owns a cover fence.

Local verification, merge, deployment, staging certification, production migration, production backfill, and phase-3 authorization remain distinct activities; none after the pre-candidate local checks belongs to this contract.

**Historical unresolved note.** A future plan must resolve the former Task 11/12 integration question before it can authorize any staging or production operation. It does not affect original Tasks 1–9 and must not be resolved implicitly by merging.

## Current planning state

These values are orientation, not permission to implement. Re-read them immediately before creating the phase-2 worktree.

| Ref/fact | Verified 2026-08-08 value |
| --- | --- |
| **phase-2 base** | `agent/event-cover-studio-phase-1`, tip `85fa9278b05a0af73091e17a2306b97ac2504617` |
| `main` / `origin/main` | `c20f54b579231247763753669f72c2acda53b852` (unchanged since 2026-08-07) |
| merge base | `e3d7d20a236e02259dc1749415e04f888ecc8462` |
| divergence | `main...phase-1` = 6 / 24 commits |
| phase-1 on any remote | no — local only, never pushed, no PR opened |
| paths both sides touched | `CLAUDE.md`, `docs/deployment.md`, `worker-configuration.d.ts`, `worker/routes/manage.ts`, `wrangler.jsonc` |
| of those, phase-2 targets | `docs/deployment.md` only |
| migrations on `main` | 11, ending at `0011_release_certifications.sql` |
| migrations on phase 1 | 12, ending at `0012_event_cover_storage.sql` |
| wrangler on phase 1 | 4.113.0 |

`85fa927` is the implementation base. Phase 2 branches from it and stacks on it. Do not rebase it onto `main`, reconcile it, or merge it as a precondition of this phase — the cover-studio line stays unmerged until the whole design spec is complete, and phase 2's work does not touch anything `main` has changed since the fork.

## Platform facts this plan depends on

- Wrangler 4.113 creates a deterministic instance with `wrangler workflows trigger <name> '<params>' --id <id>`; params are positional. `workflows instances create` does not exist.
- The binding status union is `queued`, `running`, `paused`, `errored`, `terminated`, `complete`, `waiting`, `waitingForPause`, or `unknown`. It has no `not-found` member.
- `Workflow.get(id)` throws when an ID does not exist or is invalid. An arbitrary thrown error is **not** proof of absence.
- `Workflow.createBatch()` is idempotent for retained IDs: existing IDs are skipped rather than duplicated. Phase 2 uses that property only to heal a durable, stale initial `creating` claim whose immutable payload is already in D1.
- `D1Database.batch()` is transactional and rolls back the sequence on failure. Worker-side job/fence transitions use it; a generated CLI claim artifact must be verified against Wrangler 4.113 local D1 before any remote use.
- Wrangler `instances describe`/`list` has no machine-readable JSON status output. Human-formatted CLI output is never parsed as evidence.

Primary platform references:

- <https://developers.cloudflare.com/workflows/build/workers-api/>
- <https://developers.cloudflare.com/workers/wrangler/commands/workflows/>
- <https://developers.cloudflare.com/d1/worker-api/d1-database/#batch>

## Interpretation decisions

1. **Missing is a classified lookup result, not a status string.** Introduce `status | missing | unknown`. The real adapter returns `missing` only for the exact absent-instance discriminator a future explicitly planned staging gate must prove. Every other exception is `unknown`, emits bounded sanitized telemetry, and performs no D1 or platform mutation. If the platform supplies no stable discriminator, confirmed-missing recreation remains disabled.
2. **Interrupted initial create is not missing-instance reconciliation.** A stale `creating` claim may call idempotent `createBatch()` with its already-recorded ID/payload whether the instance exists or not. That is safe because the claim represents an accepted create, not an inference from an unknown status read.
3. **No `last_dispatch_at` is added.** A dispatch claim updates both job and fence `dispatch_generation`; the fence's `updated_at` is the durable dispatch-claim clock. Confirmation does not rewrite that fence timestamp. The launcher and Worker use it for the rolling one-minute creation/restart budget.
4. **The Workflow preflight is a mandatory second fence.** The operator performs the generated post-trigger confirm step, but a lost terminal or interrupted shell cannot be trusted. Before Images/R2, the Workflow independently requires a present open fence whose generation matches the job and atomically confirms `creating → confirmed`. A missing fence fails closed.
5. **Recovery is Worker-side.** Operators do not issue raw `instances resume` or `instances restart` commands. Bounded cleanup claims the generation in D1/fence state, invokes the platform, rechecks the fence, and confirms or records failure. This leaves one authoritative D1 writer for every platform-derived transition.
6. **A run closes to `verified` or `failed`.** Once inventory is exhausted and no current `needs_replacement` or restartable job remains, the Worker re-derives the global proof. Green closes the run as `verified`; red closes it as `failed`. Here `failed` means “this run did not establish the global cutover proof,” not necessarily that every job failed. Only those two closed statuses receive run expiry.
7. **The proof writer is singular and atomic.** The CLI may display the four counts and create a `mode = 'verify'` run. Only Worker cleanup may record `verified`, using a guarded SQL transition that re-evaluates all four predicates at commit time. A saved JSON payload can never authorize the transition.

---

### Task 1: Build the conservative Workflow lookup adapter

**Files:**

- Create: `worker/workflows/cover-platform.ts`
- Modify: `worker/services/event-cover-publication.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `tests/worker/event-cover-publication.test.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`

**Interfaces:**

```ts
export type CoverWorkflowLookup =
  | { kind: 'status'; status: CoverPlatformStatus }
  | { kind: 'missing' }
  | { kind: 'unknown'; telemetry: string };

export interface CoverBackfillWorkflowAccessor {
  lookup(id: string): Promise<CoverWorkflowLookup>;
  createBatch(input: Array<{ id: string; params: CoverBackfillPayload }>): Promise<void>;
  resume(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  terminate(id: string): Promise<void>;
}
```

Move the total platform-status vocabulary and disposition mapping into the shared Worker-only module so publication, backfill, and purge import one implementation. Keep backfill payload typing separate from publication's `{eventId, operationId}` payload.

`lookup()` returns `missing` only through `isCertifiedWorkflowNotFound(error)`. Initially pin the narrowest documented/runtime shape available and keep every unmatched value `unknown`. A future explicitly planned staging gate must exercise the deployed adapter against a deliberately absent valid ID. Do not parse `error.message`, Wrangler table text, or an arbitrary numeric property without staging evidence.

- [ ] **Step 1: Write RED tests for all nine statuses, a default status, certified missing, invalid ID, and arbitrary binding failure**
- [ ] **Step 2: Implement the adapter and move the shared map**
- [ ] **Step 3: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/event-cover-publication.test.ts tests/worker/cover-backfill-workflow.test.ts
npm run typecheck
npm run lint
git add -- worker/workflows/cover-platform.ts worker/services/event-cover-publication.ts worker/workflows/cover-backfill.ts tests/worker/event-cover-publication.test.ts tests/worker/cover-backfill-workflow.test.ts
git commit -m "refactor: classify cover workflow lookups conservatively"
```

---

### Task 2: Complete the deletion-fence purge coordinator before any backfill dispatch

**Files:**

- Modify: `shared/constants.ts`
- Modify: `worker/services/event-cover-publication.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `worker/workflows/cover-render.ts`
- Modify: `tests/worker/cleanup.test.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
- Modify: `tests/worker/cover-render-workflow.test.ts`

**Interfaces:**

```ts
export interface CoverPurgeProgressSummary {
  eventId: string;
  phase: 'fences' | 'r2' | 'relational' | 'complete';
  inspected: number;
  platformMutations: number;
  remainder: boolean;
}

export async function reconcileEventCoverPurge(
  env: AppEnv,
  eventId: string,
  now?: Date,
  accessors?: CoverPurgeWorkflowAccessors,
): Promise<CoverPurgeProgressSummary>;
```

Replace the current soft-delete → prefix-delete → relational-delete shortcut with §14's persisted phases:

1. In one D1 batch, soft-delete the event, revoke all credentials, mark nonterminal publication/backfill rows `EVENT_DELETED`, change every event fence to `deletion-blocked`, and create/resume `event_cover_purge_progress`.
2. Inspect at most `MAX_COVER_PURGE_FENCES_PER_PASS = 10` fences and perform at most
   `MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS = 5` platform mutations. Stop on a
   young dispatch claim or `unknown`; neither condition advances the cursor or phase.
3. For stale claims and every other unresolved instance, apply the shared lookup result: `unknown` stops; active/paused is terminated; errored/terminated/complete is verified terminal; certified missing is materialized from the immutable receipt/job payload under the same deletion-blocked ID and then terminated. Persist the cursor/progress within the explicit fence and platform-mutation bounds.
4. Do not call `deletePrefix` until a fresh query proves zero unresolved cover fences for the event.
5. Delete and verify the R2 prefix, then execute the existing load-bearing relational order and complete the progress row.

Both Workflow preflights must change from “reject a present blocked fence” to “require a present open, generation-matching fence.” A missing fence is failure, never permission to work. An open fence receives the non-expiring sentinel expiry; only a terminal transition stamps `now + 31 days`.

The Manager deletion route returns `202 { deletionScheduled: true }` while bounded purge work remains, and the danger-zone UI copy promises immediate access revocation plus scheduled cleanup rather than immediate physical removal.

Cover these races explicitly: deletion before create; deletion after create but before confirmation; deletion after Workflow preflight; stale create with missing instance; arbitrary lookup failure; terminate failure/retry; R2 deletion failure/retry; and a late dispatcher after relational deletion. No test may manually write `deletion-blocked` without also exercising the production coordinator.

- [ ] **Step 1: Write the failing purge/fence race tests**
- [ ] **Step 2: Implement the bounded coordinator and fail-closed preflights**
- [ ] **Step 3: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cleanup.test.ts tests/worker/manage-api.test.ts tests/worker/cover-render-workflow.test.ts tests/worker/cover-backfill-workflow.test.ts
npm run typecheck
npm run lint
git add -- shared/constants.ts worker/services/event-cover-publication.ts worker/routes/manage.ts src/pages/ManagerPage.tsx worker/workflows/cleanup.ts worker/workflows/cover-backfill.ts worker/workflows/cover-render.ts tests/worker/cleanup.test.ts tests/worker/manage-api.test.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cover-render-workflow.test.ts
git commit -m "fix: settle cover workflow fences before event purge"
```

---

### Task 3: Make the launcher resume from the durable ledger

**Files:**

- Modify: `scripts/cover-backfill.ts`
- Modify: `package.json`
- Modify: `tests/unit/cover-backfill-launcher.test.ts`

**Interfaces:**

```ts
export type CoverBackfillMode = 'inventory' | 'execute' | 'dispatch' | 'launch' | 'confirm' | 'verify';

export interface DurableDispatchRow {
  runId: string;
  jobId: string;
  eventId: string;
  workflowInstanceId: string;
  dispatchState: CoverDispatchState;
  dispatchGeneration: number;
  status: CoverBackfillJobStatus;
  fenceState: CoverFenceState;
  fenceGeneration: number;
}
```

Split planning into explicit phases:

- `inventory` emits only the next read-only page query and, from a saved page payload, ledger SQL. It records a rolling inventory digest and never emits Workflow commands.
- `execute` creates or advances one run and inserts jobs. Resuming an existing run requires a saved run-state payload; it preserves its last durable cursor/digest, never sets the cursor back to null after an empty page, and never creates commands for proposed IDs.
- An empty page sets `mode = 'execute'` and changes the run from `inventorying` to `executing`; that pair is the durable end-of-inventory marker.
- `dispatch` emits a transactional claim artifact for actual committed pending/retryable rows, followed by a saved post-claim read restricted to the exact claimed identities. Only that saved post-claim read may produce Workflow trigger steps; `dispatch` itself contains zero trigger steps.
- `launch` consumes the saved post-claim read and emits Workflow trigger, confirm-read, and receipt-read steps only for rows whose matching job/fence claim remains accepted.
- `confirm` consumes the saved post-trigger fence/job query for one generation. It emits a guarded confirmation statement only for an open matching fence; a blocked result emits the exact terminate/failure unit; stale, missing, malformed, or ambiguous payloads emit no success mutation.
- `verify` prints the proof query by default. Under its separate confirmation gate it may emit an INSERT for a new `mode = 'verify', status = 'executing'` run; it never emits `status = 'verified'`.

Remove `buildDispatchBatch({ nonterminal: 0 })`. A resumed page may emit guarded duplicate inserts, but the subsequent dispatch payload must contain the actual stored job ID; a newly generated ID whose insert lost `NOT EXISTS` can never be triggered.

D1 commands include `--remote --config wrangler.jsonc --json`. Workflow trigger,
terminate, resume, and restart commands include `--config wrangler.jsonc` and never
`--local`; they do not accept `--remote` in Wrangler 4.113. Every generated command names the exact database or Workflow and follows a resource-identity check. Generated JSON records the expected account/database/Worker identity, exact command order, `generatedAt`, and `notBefore`; it never contains an object key. Raw inventory payloads remain local, ignored, and are deleted after the ledger statements are applied and verified.

- [ ] **Step 1: Write RED tests for cursor resumption, duplicate pages, real in-flight counts, actual stored IDs, active-run exclusion, command targeting, and the two durable dispatch stages**
- [ ] **Step 2: Implement the six planner modes and add the `dispatch`/`launch`/`confirm` npm scripts**
- [ ] **Step 3: Run focused gates and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-launcher.test.ts
npm run typecheck
npm run lint
git add -- scripts/cover-backfill.ts package.json tests/unit/cover-backfill-launcher.test.ts
git commit -m "fix: resume cover backfill from its durable ledger"
```

---

### Task 4: Claim, confirm, and recover initial dispatch without a gap

**Files:**

- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `scripts/cover-backfill.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
- Modify: `tests/unit/cover-backfill-launcher.test.ts`

**Interfaces:**

```ts
export async function confirmCoverBackfillDispatch(
  env: AppEnv,
  input: { runId: string; jobId: string; eventId: string; generation: number; now: Date },
): Promise<'confirmed' | 'blocked' | 'stale'>;

export async function recoverStaleInitialBackfillDispatches(
  env: AppEnv,
  now?: Date,
  workflow?: CoverBackfillWorkflowAccessor,
): Promise<{ inspected: number; materialized: number; confirmed: number; blocked: number; remainder: boolean }>;
```

A dispatch/launch unit has exactly four ordered parts:

1. a generated transactional claim artifact changes one actual job `pending → creating`, increments its generation, applies the same generation/timestamp to its open fence, and refuses the claim when another run is active, in-flight headroom is zero, the same job was claimed inside the last minute, or 25 open fences with `dispatch_generation > 0` have a claim timestamp inside the rolling minute;
2. a saved post-claim read restricted to the exact claimed job, event, Workflow ID, and generation; only this saved read may produce the exact PowerShell-safe `wrangler workflows trigger` command with `{runId, jobId,eventId}` and `--id`;
3. the post-trigger read query followed by the launcher's `confirm` mode, which emits a guarded confirm command only for the claimed generation while the fence remains open; if the saved read shows blocked state it emits the matching terminate/failure unit, and every emitted SQL statement rechecks the fence so a later deletion race records no success; and
4. a read-only receipt query proving the job/fence generation and dispatch state after the unit.

The Workflow's first `step.do` calls `confirmCoverBackfillDispatch` again before its existing preflight. This is the Worker-side production caller and crash-safe backstop. It requires the fence to exist, be open, match the event and generation, and then uses `DB.batch()` to confirm without bumping the generation. It uses `job.updated_at` for the confirmation time and does not rewrite `fence.updated_at`, which remains the dispatch-claim clock. The launcher and Worker confirmation paths import or generate the same canonical SQL predicates, and a parity test fails if one becomes weaker.

After `STALE_DISPATCH_CLAIM_MS`, cleanup selects bounded `creating` jobs. It calls idempotent `createBatch()` with the immutable stored ID/payload; existing IDs are skipped, absent IDs are created. It then performs the same post-call fence check and confirmation. Any platform failure leaves the claim recoverable; any blocked fence terminates/settles through Task 2. This recovery does not classify a lookup error as missing.

Tests must cover every interruption point: before claim, after claim/before trigger, trigger succeeded/output lost, after trigger/before confirm, confirm replay, duplicate trigger ID, fence blocked during create, and a job already `rendering`/terminal. Prove the rolling-minute and in-flight bounds across two launcher invocations, not just within one call.

- [ ] **Step 1: Write the failing claim/confirm/interruption tests**
- [ ] **Step 2: Implement the dispatcher artifacts, Workflow confirmation, and stale-create recovery**
- [ ] **Step 3: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-workflow.test.ts
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-launcher.test.ts
npm run typecheck
npm run lint
git add -- worker/workflows/cover-backfill.ts scripts/cover-backfill.ts tests/worker/cover-backfill-workflow.test.ts tests/unit/cover-backfill-launcher.test.ts
git commit -m "feat: recover every cover backfill dispatch generation"
```

---

### Task 5: Reconcile platform status and take the one guarded restart edge

**Files:**

- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
- Modify: `tests/worker/cleanup.test.ts`

**Interfaces:**

```ts
export interface CoverBackfillReconcileSummary {
  inspected: number;
  resumed: number;
  restarted: number;
  recreated: number;
  failuresRecorded: number;
  blocked: number;
  unchanged: number;
  remainder: boolean;
}

export async function reconcileCoverBackfillJobs(
  env: AppEnv,
  now?: Date,
  workflow?: CoverBackfillWorkflowAccessor,
): Promise<CoverBackfillReconcileSummary>;
```

Select, in one globally bounded pass:

- `confirmed` jobs in `queued`, `normalizing`, `rendering`, or `finalizing`;
- retryable `failed` jobs still inside their restart window; and
- stale `creating`, `resuming`, or `restarting` claims.

Apply the total lookup map:

- active status → no mutation;
- paused → resume regardless of retryable failed/nonterminal D1 status; atomically claim `resuming`, require unchanged immutable dependencies/current source, an open matching fence, rate capacity, and no purge, then call `resume()`, recheck the fence, and confirm;
- errored/terminated → first persist a safe retryable platform failure (`status = 'failed'`, `retryable = 1`, `terminal_at`, failure code, run recount), then take Task 5's guarded restart claim;
- complete + already-terminal D1 → no mutation; complete with D1 nonterminal → persist the same retryable divergence failure before restart;
- certified missing + restorable confirmed job → recreate same ID; claim `creating`, call `createBatch()` with the immutable payload, recheck, and confirm;
- unknown → sanitized telemetry only, no D1 write and no platform call;
- blocked or missing fence → `EVENT_DELETED`, never resume/restart/create.

The one guarded restart edge requires all predicates together: retryable; exact `coverBackfillDependencyVersions()` equality; unchanged derived manifest digest when present; current legacy fingerprint/revision/null-set predicates; `terminal_at` inside `BACKFILL_RESTART_WINDOW_MS`; open matching fence; rolling-minute capacity; and no event purge.

Restart recovery is migration-free and never guesses a Workflow history checkpoint. For pinned `master_id`, `render_set_id`, `manifest_json`, and `manifest_sha256`, validate the manifest SHA and shape, require unique known `(profile, density, format)` tuples, and query at most 24 exact `event_cover_render_objects` rows by `(render_set_id, event_id)`. Validate every actual row against the frozen manifest. Invalid manifest/object evidence refuses the guarded restart claim and makes no platform call. A profile is durably complete only when every expected tuple for that profile exists; a partial profile never counts as complete. Use that checkpoint only to set the guarded D1 status to `rendering` when any profile remains incomplete or `finalizing` when every profile is complete, preserving all four pinned fields byte-for-byte. With no pinned derived state, set `queued` for a legitimate beginning restart.

In every case call `workflow.restart(id)` with no `from` option. Cloudflare requires `from.name` to exist in Workflow execution history, but object adoption may commit in D1 before that step appears in history and the binding exposes no history API. A restart begins at the start; preflight and normalization no-op for guarded `rendering`/`finalizing` jobs, and profile writes replay idempotently against frozen object keys and tuple UPSERTs. The claim clears terminal/reference/expiry fields, increments job and fence generation in one `DB.batch()`, and sets `dispatch_state = 'restarting'` before the platform call. A replay while `restarting` is a no-op and cannot call the platform twice.

`scheduledCleanup` runs stale-initial recovery and reconciliation after cover ledger resolution but before event purge. A job belonging to a deleted event routes to the purge coordinator rather than ordinary reconciliation.

- [ ] **Step 1: Write one failing test for every map branch and every restart predicate**
- [ ] **Step 2: Implement failure mapping, resume/recreate, and guarded restart**
- [ ] **Step 3: Run the complete Worker suite, focused unit gates, and commit**

```powershell
npx vitest run --config vitest.worker.config.ts
npm run typecheck
npm run lint
git add -- worker/workflows/cover-backfill.ts worker/workflows/cleanup.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts
git commit -m "feat: reconcile and restart cover backfill jobs safely"
```

---

### Task 6: Resolve superseded jobs and close run lifecycles truthfully

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

export async function closeCoverBackfillRuns(
  env: AppEnv,
  now?: Date,
): Promise<CoverBackfillLedgerSweepSummary>;
```

Do not iterate every run and then apply a per-run limit. Select at most `COVER_CLEANUP_ROWS_PER_CLASS` blocking jobs globally, ordered by `(updated_at, id)`. A selected row is still current if and only if its event exists with `deleted_at IS NULL`, `cover_object_key IS NOT NULL`, `cover_render_set_id IS NULL`, and the exact stored legacy fingerprint matches that key. Revision movement alone is not supersession. Resolve only rows that fail this currentness predicate. Both the superseded-to-`resolved` write and the fairness-rotation write must compare-and-swap the selected job `id`, status, original `updated_at`, and stored fingerprint together with the exact observed event `cover_object_key`, `deleted_at`, `cover_render_set_id`, and `cover_revision` snapshot, including an observed missing event. Any lost CAS leaves the row unresolved and forces `remainder: true`. A successful fairness rotation sets only `updated_at` to a clock strictly later than both the sweep clock and the selected value, for example `new Date(Math.max(now.getTime(), Date.parse(selected.updated_at)) + 1).toISOString()`. This scheduling-only touch rotates still-current blockers behind previously uninspected rows and preserves every other job column. In particular, it must not change status, retryability, failure data, `terminal_at`, reference-release/expiry timestamps, identities, dependencies, or derived state. `terminal_at`, not the fairness touch, remains the restart and retention clock.

Recompute only distinct runs containing a job actually resolved in the pass; rotating a blocker never recounts its run. Report `remainder` conservatively when `inspectedJobs === COVER_CLEANUP_ROWS_PER_CLASS || unresolvedInspectedJobs > 0`. Saturation therefore requires a confirming pass, while any inspected row not proven resolved keeps the result true.

After Task 5's recovery/reconciliation pass, select a bounded set of closable runs. A run is not closable while inventory is incomplete, any job is nonterminal, any current `needs_replacement` exists, or a retryable failure remains inside its restart window. For a closable run, invoke Task 7's atomic proof transition: green becomes `verified`; red becomes `failed`. Stamp `expires_at` only on `verified` or `failed` runs, thirty days after the later of verification/failure closure and the last job terminal timestamp. Never stamp an `inventorying` or `executing` run.

Jobs retain existing rules: current `needs_replacement` and retryable-inside-window rows do not age out; settled jobs release references after seven days and expire after thirty. Cleanup releases references, deletes expired jobs, and then deletes only expired closed runs with zero remaining jobs.

The final `scheduledCleanup` order is explicit: bounded superseded resolution → stale initial-create recovery → platform reconciliation/restart → bounded run closure/atomic proof → existing cover expiry phases → event purge coordination. An earlier phase may leave `remainder`; later safety phases still run within their own bounds, but no phase treats that remainder as proof of quiescence.

- [ ] **Step 1: Write RED tests for global fairness, truthful remainder, run closure, and expiry eligibility**

Prove that 100 oldest still-current blockers rotate so a newer 101st superseded row resolves on the second pass; exactly 100 all-resolved rows report `remainder: true` followed by an empty `false` pass; 99 current blockers report `true`; and equal timestamps use `id` as the deterministic tie-breaker. Assert rotated rows change only `updated_at`, current `needs_replacement` and retryable-inside-window failures receive no release or expiry, revision-only movement remains current, and classification-to-write event mutations make both resolution and rotation lose their CAS, leave the row unresolved, and report `remainder: true`. No pass may inspect more than the global bound, and only runs with actually resolved jobs are recounted.
- [ ] **Step 2: Implement the bounded ledger sweep and wire it before existing cover expiry phases**
- [ ] **Step 3: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts
npm run typecheck
npm run lint
git add -- worker/workflows/cover-backfill.ts worker/workflows/cleanup.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts
git commit -m "feat: close and expire cover backfill ledgers truthfully"
```

---

### Task 7: Make the zero-legacy transition atomic and single-writer

**Files:**

- Create: `shared/cover-backfill-proof.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `scripts/cover-backfill.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
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
```

Put the four canonical predicates in one pure SQL-builder module imported by both Worker and Node so the proof query and guarded update cannot drift. The Worker function is called by `sweepCoverBackfillLedger`; it is not dead test-only code.

The `verified` UPDATE itself contains all four zero predicates and requires the target run to be `executing`, mode `execute`/`verify`, and otherwise closable; an `inventorying` run is never closable. The update sets `status = 'verified'`, `verified_at`, `updated_at`, and the closed-run expiry in the same statement. If it changes zero rows, re-read the counts for diagnostics and guardedly close a genuinely closable red run as `failed`; never turn an active/incomplete run into failed merely because one count was nonzero.

The CLI's saved count payload is display evidence only. Missing/duplicate/negative count rows make its evaluation red, but even a syntactically green payload emits no verified UPDATE. Tests must include a race in which the displayed payload is green and D1 becomes red before the Worker transition; the run must not be verified. A second call must not restamp `verified_at`.

- [ ] **Step 1: Write the failing parity, atomicity, stale-payload, and idempotency tests**
- [ ] **Step 2: Implement the shared predicates and single Writer transition**
- [ ] **Step 3: Run focused gates and commit**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-workflow.test.ts
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-launcher.test.ts
npm run typecheck
npm run lint
git add -- shared/cover-backfill-proof.ts worker/workflows/cover-backfill.ts scripts/cover-backfill.ts tests/worker/cover-backfill-workflow.test.ts tests/unit/cover-backfill-launcher.test.ts
git commit -m "feat: record cover cutover proof atomically"
```

---

### Task 8: Rehearse the complete interrupted loop on a populated database

**Files:**

- Create: `tests/worker/cover-backfill-rehearsal.test.ts`
- Create: `tests/unit/cover-backfill-operator-loop.test.ts`
- Modify: `tests/worker/helpers.ts`

Run one population through inventory → durable job creation → dispatch claim → interrupted create recovery → Workflow execution → status reconciliation → purge fencing → superseded resolution → run closure → final verification.

Seed, at minimum:

- a conforming legacy cover;
- a source too small to normalize whose **same cover** is later removed/replaced so `needs_replacement` resolves;
- a host replacement after inventory but before finalize;
- event deletion before dispatch confirmation;
- event deletion after Workflow preflight but before an R2 write;
- an errored platform instance whose D1 job is still `rendering` and must be failed before restart;
- an absent stale initial-create instance healed by `createBatch`;
- an arbitrary lookup exception that remains `unknown` and causes no write;
- an already-active complete render set; and
- more than one page and more than one dispatch batch.

Assert proof counts and run counters after each stage, all bounds and `remainder`, exact instance IDs/generations, no object written after purge fencing, no regenerated job ID on resume, and green proof only after the final Worker-side transition. The Worker rehearsal uses deterministic Images/Workflow fakes and proves orchestration, not codec/platform conformance. The operator-loop unit test executes the generated SQL against a local migrated D1 and validates the exact artifact order and rollback behavior.

- [ ] **Step 1: Write and run the populated rehearsal**
- [ ] **Step 2: Measure the complete Worker suite and keep it within the repository's gate budget**
- [ ] **Step 3: Commit only the rehearsal files**

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

### Task 9: Write the executable runbook and reconcile release documents

**Files:**

- Create: `docs/cover-backfill-runbook.md`
- Modify: `docs/deployment.md`
- Modify: `docs/operations.md`
- Modify: `design-qa.md`

The runbook must stand alone and contain, in order:

1. authority boundaries and the development/staging/production preconditions;
2. commands proving account, Worker, D1 database ID, Workflow names, deployed `CF_VERSION_METADATA`, migration set, and candidate SHA;
3. exact `--remote --config wrangler.jsonc --command/--file --json` D1 commands, with `$LASTEXITCODE` checks;
4. where private inventory payloads live temporarily, how permissions are constrained, and when they are deleted;
5. new-run inventory, rolling digest/cursor persistence, empty-page completion, and restart after interruption;
6. durable dispatch query, one-batch-per-minute `notBefore`, 25-in-flight stop, ordered claim/trigger/confirm/receipt unit, and what to do after an uncertain shell result;
7. the rule that operators never run raw resume/restart commands—Worker reconciliation owns those transitions;
8. how to observe bounded cleanup/reconciliation without parsing human CLI tables;
9. `needs_replacement`: only that host replacing/removing the same cover can clear it;
10. verification-run creation, waiting for Worker closure, the four direct counts, and how to prove the ledger's `verified_at`/SHA association;
11. rollback/recovery: originals remain in `event_cover_retired_legacy_objects` for seven days and phase 3 remains closed; and
12. stop conditions for unknown platform status, identity mismatch, migration drift, version drift, fence backlog, red proof, or changed candidate SHA.

`docs/deployment.md` places phase-2 candidate verification, staging deployment/conformance, and production backfill as three separate authorization gates. `docs/operations.md` documents only support signals the candidate actually produces. `design-qa.md` distinguishes deterministic fake-transform orchestration evidence from real Images/codec evidence.

- [ ] **Step 1: Write the runbook and reconcile all three documents**
- [ ] **Step 2: Dry-walk local D1 equivalents and validate Workflow command artifacts; do not contact remote resources**

Execute only D1 equivalents after substituting `--local` for `--remote` in a disposable D1 invocation. Never execute a generated Workflow command during the dry-walk, including trigger or terminate; validate Workflow syntax and ordering only as generated artifact strings. Do not add `--local` or `--remote` to production Workflow commands, which retain only `--config wrangler.jsonc`.
- [ ] **Step 3: Run documentation/static checks and commit**

```powershell
git diff --check
npm run typecheck
npm run lint
git add -- docs/cover-backfill-runbook.md docs/deployment.md docs/operations.md design-qa.md
git commit -m "docs: make the cover backfill operation executable"
```

---

### Historical reference only — retired original Task 10: Fix the immutable phase-2 candidate and run the release gate

**Non-executable under this remediation/completion contract. Requires a new explicit plan and authorization.**

- [ ] **Step 1: Confirm the worktree contains only phase-2-owned changes and every prior task is committed**
- [ ] **Step 2: Re-read the actual `verify:release` runner and candidate-manifest schema from this head**
- [ ] **Step 3: Record the full candidate SHA**
- [ ] **Step 4: Run the immutable aggregate gate**

`--base-sha` is **not** a branch point and must not be set to the phase-1 tip. `verify-release.ts` pins `APPROVED_RELEASE_BASE_SHA` and throws `--base-sha is not the approved Increment 1 base` for any other value. It is the fixed release-lineage constant and is the same for every phase.

Two different SHAs are in play and must not be conflated: the fixed release-lineage base the gate validates, and the phase-2 branch point the whitespace check should span.

```powershell
$phase2Head    = (git rev-parse HEAD).Trim()
$releaseBase   = '0b92387d2e237d568d2514373dcc3044e7960d4b'  # APPROVED_RELEASE_BASE_SHA; fixed for every phase
$phase2Branch  = '85fa9278b05a0af73091e17a2306b97ac2504617'  # phase-1 tip; what phase 2 branched from
npm run verify:release -- --sha $phase2Head --base-sha $releaseBase
if ($LASTEXITCODE -ne 0) { throw 'Phase-2 release verification failed.' }
git diff --check $phase2Branch $phase2Head
if ($LASTEXITCODE -ne 0) { throw 'Phase-2 candidate has whitespace errors.' }
```

- [ ] **Step 5: Inspect the emitted manifest, prove its recorded SHA/base/migration count/gates, and commit only an allowed local evidence pointer if repository policy requires one**
- [ ] **Step 6: Stop for independent review. Do not merge, push, or deploy unless separately requested**

Any code/document change after the recorded SHA invalidates this task and requires a new exact-head run.

---

### Historical reference only — retired original Task 11: phase-2 staging deployment and platform conformance

**Non-executable under this remediation/completion contract. Requires a new explicit plan and authorization.**

Deploy the exact reviewed Phase-2 SHA to the staging resources named in the runbook, then prove:

- `CF_VERSION_METADATA` identifies that exact candidate;
- real Images behavior required by §15.5;
- `CoverBackfillWorkflow` create, first-step confirmation, automatic step retry, deterministic profile replay, resume, restart, terminate, and retained-ID behavior;
- the exact missing-instance error discriminator used by `isCertifiedWorkflowNotFound`; an invalid ID and a synthetic platform failure still classify `unknown`;
- idempotent `createBatch` recovery of an interrupted initial claim;
- errored/terminated/complete D1 mapping before restart;
- the rolling in-flight/creation bounds;
- deletion before/after dispatch and before/after Workflow preflight, with zero post-fence R2 writes;
- persisted purge progress, unknown-status retry, confirmed-missing materialize/terminate, terminal verification, and R2-before-relational ordering; and
- verification-run closure without a stale-payload authorization path.

Record staging account/resource identities, deployed version ID, candidate SHA, timestamps, sanitized results, and cleanup. Do not include secrets, object keys, or raw private payloads. If the missing discriminator differs or is not stable, change the adapter, create a new candidate SHA, rerun Task 10, redeploy, and repeat this entire gate. A phase-1-only staging artifact does not satisfy Task 11.

---

### Historical reference only — retired original Task 12: production execution

**Non-executable under this remediation/completion contract. Requires a new explicit plan and authorization.**

- [ ] **Step 1: Re-verify every production-operation precondition and record the exact identities/SHA**
- [ ] **Step 2: Create one production inventory run; record its run ID, first digest, cursor, and starting counts**
- [ ] **Step 3: Inventory all pages, applying only guarded ledger artifacts and verifying each durable cursor/digest before deleting its local raw payload**
- [ ] **Step 4: Mark inventory exhausted, then dispatch actual stored jobs in bounded batches, never before `notBefore`, never above 25 in flight**
- [ ] **Step 5: After every uncertain dispatch result, stop; let stale-create recovery/reconciliation settle it from D1 rather than inventing another ID**
- [ ] **Step 6: Repeat new inventory/execution runs until every current legacy row is applied, skipped, resolved, or explicitly `needs_replacement`**
- [ ] **Step 7: Stop for host action while any current `needs_replacement` remains; an operator cannot waive it**
- [ ] **Step 8: Create the canonical verification run and wait for Worker cleanup to close it**
- [ ] **Step 9: Re-run the read-only four-count query, require four present zeroes, and correlate it with the run's immutable `verified_at` and deployed SHA**
- [ ] **Step 10: Publish the sanitized run ledger/staging/candidate references as the phase-3 authorization artifact**

A green proof authorizes exactly one later action: opening a phase-3 candidate for review. It does not authorize `0013`, responsive routes/projections, Cover Studio activation, deployment, or any remote mutation.

---

## Review boundaries

| Unit | Tasks | What it establishes |
| --- | --- | --- |
| Platform truth | 1 | Status, missing, and unknown are distinguishable without guessing |
| Deletion safety | 2 | No cover Workflow can write after purge owns its fence; R2 waits for terminal proof |
| Durable dispatch | 3–4 | Resumption uses stored IDs/counts and every initial create/confirmation interruption heals safely |
| Recovery | 5 | Platform failure is persisted before one fully guarded resume/restart/recreate edge |
| Ledger/proof | 6–7 | Resolution is globally bounded; closed runs expire; `verified` is atomic and single-writer |
| Local evidence | 8–9 | The interrupted loop is rehearsed, documented, and stopped at pre-candidate local checks |

## What this plan deliberately does not do

- Add a migration, cron expression, operator route, authentication surface, or rate-limit binding.
- Add `last_dispatch_at`; the existing job/fence generation and timestamps are sufficient when confirmation leaves the fence claim timestamp intact.
- Parse human Wrangler output, treat an arbitrary binding exception as missing, or mutate on `unknown`.
- Let an operator bypass D1 generation/fence claims with raw resume/restart commands.
- Implement phase-3 `0013`, projections, responsive delivery routes, Cover Studio activation, `EventAppearanceCanvas`, or client wiring.
- Claim production readiness from local fakes, a phase-1 staging run, merge, or deployment alone.
- Execute the archived original Tasks 10–12; any candidate, staging, or production work requires a new explicit plan and authorization.
- Claim physical-device support.
- Delete a legacy original outside the existing retired-object inventory and recovery-window sweep.

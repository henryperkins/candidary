# Event Appearance Cover Studio — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the phase-1/phase-2 compatibility window only after the separately authorized production zero-legacy proof, enforce the responsive cover invariants in `0013_event_cover_invariants.sql`, replace the transitional cover fields and revisionless reader with the safe nested projections and revisioned delivery routes, and turn on the already-designed live Event Appearance canvas and Cover Studio without changing the create-flow boundary.

**Architecture:** Phase 3 is one end-state candidate stacked on the exact phase-2 proof-producing line and explicitly reconciled with the then-current `main`. D1 remains authoritative: source/pointer and exact-manifest triggers reject invalid committed states; publication batches retain phase-2 optimistic/fence ownership and end in either a complete `applied` graph or a complete `conflict` graph. Manager and guest projections expose only semantic cover state and source-qualified density capability. Every event-bound image request reauthorizes the current revision and resolves one allowlisted slot; presets redirect temporarily to immutable public release assets, while uploads stream only an object from the current same-event active set. React uses one measured responsive image component for Manager and guest surfaces; Cover Studio owns only draft/session interaction, while durable publication/recovery stays in the existing operation controller and Manager-level reconciler.

**Tech Stack:** TypeScript 6, React 19, Vite 8, Hono 4, Cloudflare Workers/Wrangler 4.113, D1/SQLite JSON and triggers, private R2, Workers Static Assets, Cloudflare Images and Workflows, Vitest/jsdom, `vitest-pool-workers`/workerd, Playwright 1.61, and axe-core.

---

## Global Constraints

- The governing design is `docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md`, especially §§5–6, §8, Phase 3 of §9.5, §§10.3–16. Copy its interaction and contract decisions; do not reopen the approved six presets, five effects, four-step upload path, three-step preset path, measured profile rules, or no-feature-flag decision.
- **Do not create `migrations/0013_event_cover_invariants.sql`, a phase-3 branch, or a phase-3 worktree until the phase-2 production artifact records one exact deployed SHA, one immutable `verified_at`, and all four canonical counts present and zero, and an authorizer has recorded which Phase-2 integration policy produced that SHA.** The current local phase-2 tip is orientation only.
- Once authorized, `migrations/` contains exactly thirteen files, ending in `0013_event_cover_invariants.sql`. `0012` remains unchanged and its populated-legacy test continues to prove the additive compatibility state before `0013`.
- Work from a new isolated worktree. Preserve the main checkout's modified `worker/services/email.ts`, `CandidaryDesignSystem.zip`, `candidaryhomepageredesign.patch`, and every existing untracked plan/handoff. Never stage or edit them.
- Phase 3 is the whole-spec integration point. Consume the exact `main` SHA named by the Phase-2 authorization record: merge it into the accumulated cover line once when the authorized Phase-2 proof was produced from the unmerged line, or prove it is already an ancestor when the authorizer selected earlier partial integration. Resolve known security/config/document conflicts deliberately; do not rebase, duplicate the integration merge, or silently choose one side.
- Write a failing focused test before each behavior. A migration must be red against an invalid fixture before its SQL is written. Documentation, generated snapshots, and evidence recording do not require a manufactured red test.
- Keep every commit buildable: run the task's focused tests plus `npm run typecheck` and `npm run lint` before committing. Use explicit path allowlists with `git add --`; never use `git add -A`, `git add .`, or broad directory staging.
- Retain the current manager Origin, CSRF, owner/delegate, event-prefix, request-ID, and credential rules on every cover mutation. The revisioned guest and Manager readers remain separately authenticated.
- No client receives an R2 key, master ID, render-set ID, draft raw key, checksum, recipe, Workflow ID, raw platform status, arbitrary URL, or arbitrary image transform parameter.
- Delivery is read-only. It never invokes Images, warms a cache, repairs a manifest, falls back to a normalized master/retired set/legacy object, or generates a derivative lazily.
- Remove the two revisionless compatibility endpoints and the transitional top-level `coverObjectKey`, `coverPreparation`, and `coverRevision` contract fields before the candidate is fixed. Do not ship both client contracts or both URL shapes.
- Preserve the create-flow boundary: `CreatePage` may keep the simple automatic/natural `publishCoverUpload` wrapper after event creation. It does not mount Cover Studio.
- A local candidate, staging conformance, exact-SHA landing/push, remote migration, production deployment, and physical-device acceptance are separate claims. Tasks 1–13 stop at a reviewable local candidate. Tasks 14–17 each require their own explicit authorization; none implies another.
- One Manager-level cover-operation reconciler owns status polling per event. Cover Studio subscribes to that reconciler while open; it never creates a competing poll loop, and closing the sheet never abandons accepted or ambiguous work.
- Any tracked source, test, generated asset, or documentation edit after candidate fixation invalidates the candidate SHA and every downstream landing/staging artifact. Operational evidence is written only beneath ignored `output/` paths and is checksummed separately; it never mutates the candidate tree.

## Preconditions and pinned planning state

### Mandatory phase-2 evidence

Execution stops until all of these are independently true:

1. an explicit operator authorization record beneath `output/operations/event-cover/$phase2Sha/` names one full Phase-2 SHA, one full approved `main` SHA, the intended production Worker, `authorizedAt`, `authorizedBy`, and exactly one decision: `deploy_unmerged_phase2` or `integrate_main_before_phase2_proof`;
2. the exact phase-2 SHA passed `npm run verify:release` with that SHA and approved base `0b92387d2e237d568d2514373dcc3044e7960d4b`, with an intact candidate manifest;
3. that exact SHA was independently reviewed and deployed to the intended production Worker at 100% traffic under the recorded decision;
4. `CF_VERSION_METADATA`, D1, R2, Images, Email, both rate-limit namespaces, assets, and all three Workflow bindings identify the reviewed production topology;
5. remote D1 contains exactly `0001` through `0012`, with no `0013`;
6. the phase-2 staging artifact passed real Images/Workflow/backfill/purge conformance;
7. one canonical production verification run is durably `verified`; and
8. a fresh read-only query correlates that run's immutable `verified_at` and deployed SHA with these four present zeroes:
   - legacy live rows;
   - current blocking backfill jobs;
   - incomplete active manifests; and
   - uploaded covers without exactly one same-event active set.

The authorization record and proof artifact are both inputs. Validate that both are regular nonsymlinked files, that their SHA fields agree byte-for-byte, and that the recorded decision matches ancestry: `deploy_unmerged_phase2` requires the approved `main` SHA not to be an ancestor of the proof SHA, while `integrate_main_before_phase2_proof` requires it to be an ancestor. Any other graph stops execution. These artifacts authorize opening and reviewing a phase-3 candidate; they do not authorize a merge, push, remote migration, staging deployment, production deployment, or physical-device claim.

### Orientation snapshot — re-read before execution

| Ref/fact | Verified 2026-08-09 value | Meaning |
| --- | --- | --- |
| `main` / `origin/main` | `c20f54b579231247763753669f72c2acda53b852` | Clean ref; the main checkout itself has unrelated user changes |
| inspected phase-2 tip | `faea599193b58029a5faad32afad13381db56b24` | Clean local branch, not yet the production proof artifact |
| common merge base | `e3d7d20a236e02259dc1749415e04f888ecc8462` | The cover line and current `main` diverged here |
| divergence | `main...phase-2` = 6 / 59 commits | Recompute after phase-2 operations |
| known both-modified paths | `CLAUDE.md`, `docs/deployment.md`, `worker/routes/manage.ts`, `wrangler.jsonc` | Resolve by union of responsibilities, not side selection |
| generated overlap | `worker-configuration.d.ts` | Regenerate from the merged Wrangler config |
| migration count on cover line | 12 | Phase 3 alone changes this to 13 |

The implementation base is the exact SHA named by the production proof, not automatically the snapshot above. The integration SHA is the authorization record's exact `approvedMainSha`, which Task 1 must prove still equals freshly fetched `origin/main`; it is not automatically today's `c20f54b` or a later implementing-agent choice.

### Phase 1 and Phase 2 ownership carried forward

- Phase 1 already owns additive `0012`, the bounded master/draft/preview/render inventory, normalization/rendering services, draft/publication/restart HTTP surface, compatibility reader, scheduled cover cleanup, preset asset build and 720-file matrix, CreatePage's automatic/natural wrapper, and the currently unwired `CoverStudio`, `EventAppearanceCanvas`, and `ResponsiveEventCover` modules. Phase 3 modifies and wires those units; it does not build a second pipeline.
- Phase 2 already owns durable backfill dispatch/recovery, conservative platform reconciliation, restart edges, purge-fence coordination, ledger lifecycle, four-predicate proof writer, runbook, and populated local rehearsal. Phase 3 consumes the eventual production proof; it does not add another backfill ledger, operator route, or Workflow.
- The phase-1 top-level preparation field and revisionless reader are compatibility scaffolding, not APIs to preserve. The phase-2 production proof is the only authority to remove them.

## Selected approach and rejected alternatives

1. **Selected: one strict phase-3 candidate, with migration-first production cutover.** `0013` accepts the exact transactional intermediate state used by the deployed phase-2 upload writer only when an exact nonterminal receipt or backfill owner exists and the complete same-event manifest is already present. At commit, the writer activates the set. This lets production apply `0013` while the old compatibility Worker is still serving; a failed later deploy can safely remain on or roll back to that Worker.
2. **The new writer still becomes stricter.** It records `ready`/`finalizing` before the final swap, makes preset/removal semantic publications short and synchronous, and ends every final batch with a CHECK-backed assertion that aborts the entire D1 batch unless the receipt, event, draft, set, and fence form one complete `applied` or `conflict` graph.
3. **Rejected: deploy new projections before `0013`.** That creates an avoidable interval in which the new contract is live without the invariant release it depends on.
4. **Rejected: a temporary runtime feature flag or dual response shape.** The design explicitly excludes a new flag system, and two owners for cover presence/revision reintroduce the compatibility ambiguity Phase 3 exists to close.
5. **Rejected: migration triggers that require the new Worker ordering only.** Applying them first would break the deployed phase-2 writer; deploying code first would break rollback safety.
6. **Rejected: permissive triggers plus application-only validation.** The migration must fail closed on a red proof and reject invalid live pointers, incomplete manifests, and deletion of live references directly in D1 tests.

Tasks 6–9 may keep the two revisionless route registrations locally while their callers move, solely so each commit stays executable. That overlap is never a deployable candidate: Task 10 removes the routes, builders, hook, tests, and sentinels before the complete candidate gate.

The sole pre-`0013` Phase-3 deployment is Task 14's route-disabled `workflow-conformance` topology. It exposes neither application routes nor `workers.dev`, uses isolated disposable resources, and exists only to execute the Phase-3-modified `CoverBackfillWorkflow` against the compatibility schema. It is not a user-serving cutover, never shares resources with cutover staging, and does not weaken migration-first ordering for staging or production traffic.

## Phase-3 contract map

| Owner | Produces | Consumed by |
| --- | --- | --- |
| `shared/event-cover.ts` | strict semantic config, profile/effect/preset registries, nested cover views, surface treatment, measured profile resolver | Worker projection/delivery and React |
| `worker/http/event-cover-view.ts` | `EventCoverView` and `GuestEventCoverView` from canonical D1 state | every event response |
| `worker/routes/content.ts` | current-revision guest/Manager slot delivery | `ResponsiveEventCover` |
| `src/features/cover/cover-draft-client.ts` | replay-safe draft primitives and a retained simple create-flow wrapper | Cover Studio session and `CreatePage` |
| `src/features/cover/use-cover-operation-reconciler.ts` | one persisted controller, polling cadence, terminal event adoption, and recovery per Manager event | Cover Studio session and Manager status |
| `src/features/cover/use-cover-studio-session.ts` | local draft/source/focus/effect/blob state over the shared reconciler | `EventAppearanceEditor` and `CoverStudio` |
| `EventAppearanceCanvas` | one live guest-like themed surface with neutral Manager controls | Settings and Cover Studio |
| `ResponsiveEventCover` | measured `<picture>`, density advertisement, one JPEG recovery, gradient fallback | Manager canvas and every guest hero |
| `scripts/staging-release.ts` | validated staging overlay, exact-candidate staging commands, and checksummed conformance artifact | separately authorized Workflow/cutover staging only |
| `scripts/migrate-release.ts` | exact-candidate, canonical-topology, bookmark-bound `0013` production migration guard | separately authorized production cutover only |

---

### Task 1: Establish the authorized end-state branch and reconcile current `main`

**Files:**

- Resolve: `CLAUDE.md`
- Resolve: `docs/deployment.md`
- Resolve: `worker/routes/manage.ts`
- Resolve: `wrangler.jsonc`
- Regenerate: `worker-configuration.d.ts`
- Verify only: every other path brought in by the merge

**Interfaces:**

- Consumes: the exact phase-2 proof SHA, the exact reviewed `origin/main` SHA, and the validated Phase-2 authorization decision.
- Produces: a clean `agent/event-cover-studio-phase-3` worktree containing the union of cover-platform work and main's multi-origin/security changes.
- Preserves: main's `ALTERNATE_ORIGINS`/origin hardening, all phase-2 Workflow bindings and cover routes, and the fixed release-base contract.

- [ ] **Step 1: Validate the Phase-2 authorization record and proof before creating anything**

  The authorizing instruction supplies `$phase2AuthorizationPath` and `$phase2ProofPath`, each beneath the ignored `output/operations/event-cover/$phase2Sha/` evidence root. Resolve each path, require a regular nonsymlinked file, parse the authorization decision, and require full lowercase 40-character `phase2Sha` and `approvedMainSha` values. Re-read the proof and compare its SHA byte-for-byte with both the authorization record and the local Phase-2 branch tip. Record the decision, SHA, `verified_at`, deployed version ID, migration list, and four zero counts in the execution log. Stop on any mismatch, stale read, missing field, or unknown decision.

- [ ] **Step 2: Fetch and pin the authorized integration head, then re-inspect every checkout**

  ```powershell
  git fetch --prune origin
  if ($LASTEXITCODE -ne 0) { throw 'Could not refresh origin.' }
  $authorization = Get-Content -Raw -LiteralPath $phase2AuthorizationPath | ConvertFrom-Json
  $phase2Sha = [string]$authorization.phase2Sha
  $mainSha = (git rev-parse origin/main).Trim()
  $localMainSha = (git rev-parse main).Trim()
  $phase2BranchSha = (git rev-parse agent/event-cover-studio-phase-2).Trim()
  if ($mainSha -ne [string]$authorization.approvedMainSha) { throw 'origin/main is not the authorized integration SHA.' }
  if ($localMainSha -ne $mainSha) { throw 'Local main and origin/main differ; do not update the dirty main checkout implicitly.' }
  if ($phase2BranchSha -ne $phase2Sha) { throw 'The Phase-2 branch tip is not the proved SHA.' }
  git worktree list --porcelain
  git status --short --branch
  git -C .worktrees/cover-studio-phase-2 status --short --branch
  ```

  Expected: Phase 2 is clean; main still shows only the user's pre-existing changes; local `main`, `origin/main`, and the authorization record name one SHA. Do not update, clean, switch, or stash main. A changed remote head requires a new reviewed authorization, not an implementing-agent choice.

- [ ] **Step 3: Create the isolated phase-3 worktree from the exact proof SHA**

  ```powershell
  $phase3Worktree = 'C:\Users\htper\candidary\.worktrees\cover-studio-phase-3'
  git worktree add $phase3Worktree -b agent/event-cover-studio-phase-3 $phase2Sha
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the Phase-3 worktree.' }
  Set-Location -LiteralPath $phase3Worktree
  $actualPhase3Root = [IO.Path]::GetFullPath((git rev-parse --show-toplevel).Trim())
  $expectedPhase3Root = [IO.Path]::GetFullPath($phase3Worktree)
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($actualPhase3Root, $expectedPhase3Root)) { throw 'Commands are not running in the Phase-3 worktree.' }
  if ((git branch --show-current).Trim() -ne 'agent/event-cover-studio-phase-3') { throw 'Unexpected Phase-3 branch.' }
  if ((git rev-parse HEAD).Trim() -ne $phase2Sha) { throw 'Phase-3 worktree is not based on the proof SHA.' }
  if (git status --porcelain) { throw 'The new Phase-3 worktree is not clean.' }
  ```

  Before continuing, recompare `$phase2Sha` to the proof and record `$mainSha` plus the authorization decision as the approved integration inputs.

- [ ] **Step 4: Prove the authorized ancestry branch and preview only the required merge**

  ```powershell
  git merge-base $phase2Sha $mainSha
  git diff --name-status "${phase2Sha}..${mainSha}"
  git merge-base --is-ancestor $mainSha $phase2Sha
  $mainAlreadyIntegrated = $LASTEXITCODE -eq 0
  if ($LASTEXITCODE -gt 1) { throw 'Could not evaluate the authorized ancestry.' }
  if ($authorization.decision -eq 'deploy_unmerged_phase2' -and $mainAlreadyIntegrated) { throw 'Authorization says unmerged, but main is already an ancestor.' }
  if ($authorization.decision -eq 'integrate_main_before_phase2_proof' -and -not $mainAlreadyIntegrated) { throw 'Authorization says integrated, but main is not an ancestor.' }
  if ($authorization.decision -eq 'deploy_unmerged_phase2') {
    git merge --no-ff --no-commit $mainSha
    if ($LASTEXITCODE -ne 0 -and -not (git diff --name-only --diff-filter=U)) { throw 'The integration merge failed without reviewable conflicts.' }
  }
  git status --short
  ```

  Under `deploy_unmerged_phase2`, expected conflicts include the four pinned paths above. If new conflicts appear, inspect both histories and add each exact resolution path to the task record before editing. Under `integrate_main_before_phase2_proof`, require a clean no-op: do not create a redundant merge commit.

- [ ] **Step 5: Resolve the known conflicts by responsibility**

  - `CLAUDE.md`: retain both the multi-origin update rule and the independent cover MIME/migration rules.
  - `docs/deployment.md`: retain main's origin/security/release procedure and phase 2's backfill/proof runbook; do not yet claim Phase 3 is deployed.
  - `worker/routes/manage.ts`: retain main's security/current behavior and the cover line's route ownership/projection call sites; no cover mutation route moves back here.
  - `wrangler.jsonc`: retain current origins/secrets plus `COVER_RENDER_WORKFLOW`, `COVER_BACKFILL_WORKFLOW`, Images, D1, R2, assets, and version metadata.

- [ ] **Step 6: Regenerate the binding declaration and prove the merged config**

  ```powershell
  npm run cf-typegen
  npm run verify:bindings
  npm run test:unit -- tests/unit/origins.test.ts
  npm run test:worker -- tests/worker/origins.test.ts tests/worker/event-cover-api.test.ts tests/worker/cover-render-workflow.test.ts
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 7: Stage the exact resolutions, inspect the complete merge, and commit noninteractively**

  ```powershell
  if ($authorization.decision -eq 'deploy_unmerged_phase2') {
    git add -- CLAUDE.md docs/deployment.md worker/routes/manage.ts wrangler.jsonc worker-configuration.d.ts
    $unmerged = @(git diff --name-only --diff-filter=U)
    if ($unmerged.Count -ne 0) { throw "Unresolved merge paths: $($unmerged -join ', ')" }
    git status --short
    git diff --cached --name-status
    git diff --cached --stat
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw 'The staged merge failed diff validation.' }
    git commit -m "merge: reconcile main before cover studio phase 3"
    if ($LASTEXITCODE -ne 0) { throw 'The Phase-3 integration commit failed.' }
  } else {
    if (git status --porcelain) { throw 'The already-integrated Phase-3 worktree drifted.' }
  }
  ```

  If Step 5 approved any additional conflict path, append that literal path to `git add --` before inspection. Confirm the worktree is clean and that `$mainSha` is an ancestor of `HEAD` before Task 2.

---

### Task 2: Make preset and removal publications one strict synchronous transaction

**Files:**

- Modify: `worker/db/events.ts`
- Modify: `worker/services/event-cover-publication.ts`
- Modify: `worker/routes/event-cover.ts`
- Modify: `tests/worker/event-cover-publication.test.ts`
- Modify: `tests/worker/event-cover-api.test.ts`
- Modify: `tests/worker/cleanup.test.ts`
- Verify only: `worker/workflows/cleanup.ts`

**Interfaces:**

- Consumes: `EventCoverPublishRequestV1` for `source.kind = 'preset' | 'none'`, `operationId`, `expectedRevision`, the current event pointers, and a canonical digest.
- Produces: `applySemanticCoverPublication(...) -> CoverPublicationOutcome`, with an `applied` or `conflict` receipt and the resulting Manager event projection input.
- Produces helper: `coverPublicationTerminalAssertionStatement(db, owner)` deliberately violates the existing receipt status CHECK when the exact expected terminal graph is incomplete, forcing the whole D1 batch to roll back.
- Produces helper: `coverDisplacedUploadRetentionStatements(db, owner) -> D1PreparedStatement[]`, which retires a displaced normalized set and assigns both it and its master `cleanup_after = max(retired_at + 7 days, every referencing receipt.expires_at)` inside the winning publication batch.
- Invariant: preset pins `assetVersion: 1`, keeps both event-owned pointers null, and never enters removal SQL with a preset config.

- [ ] **Step 1: Add RED service tests for the dangerous current preset branch**

  Prove that a preset request is currently rejected and, if the route guard were removed, the non-upload path could select canonical `none`. Add expectations for:

  - exact preset config/effect/asset version;
  - prior active upload set retirement;
  - null master/set pointers without clearing the preset config;
  - one revision increment;
  - same-digest replay returning the stored result;
  - operation-ID digest collision and stale revision returning `409`; and
  - a preset request never satisfying the `action = 'remove'` guard; and
  - preset-over-upload and removal-over-upload retiring the old set and scheduling its normalized master at the exact retention floor, including a referencing receipt whose expiry exceeds seven days;
  - preset/none predecessors scheduling no master, displaced normalized masters never entering `event_cover_retired_legacy_objects`, and retained R2 bytes remaining until scheduled cleanup; and
  - fault-injected zero-row applied/conflict/set/master-retention tails rolling the event, revision, receipt, retirement, and cleanup deadlines back together.

  ```powershell
  npm run test:worker -- tests/worker/event-cover-publication.test.ts tests/worker/event-cover-api.test.ts tests/worker/cleanup.test.ts
  ```

  Expected: the new preset assertions fail.

- [ ] **Step 2: Generalize the short publication guard without weakening it**

  Replace `coverPointerStatements`' hard-coded removal receipt guard with an explicit semantic-publication guard carrying `action: 'publish' | 'remove'`, operation ID, digest, expected revision, and the exact null Workflow/set/draft requirements. Keep render and backfill owner guards separate.

- [ ] **Step 3: Implement `applySemanticCoverPublication`**

  The service must canonicalize either preset or none, insert/load and classify the receipt before revision rejection, and run one `DB.batch()` with guarded winning and losing branches. The winning sequence changes the event pointer/config/revision, marks the receipt applied with its final expiry, retires the previous active set, applies `coverDisplacedUploadRetentionStatements`, inventories a displaced legacy key only where the pre-Phase-3 compatibility fixture requires it, and then executes the terminal assertion. The assertion requires the displaced set/master retention graph whenever the old source was a normalized upload; a zero-row retirement or scheduling statement deliberately fails the whole batch. The losing branch leaves the event, old set, and old master untouched and records conflict. Never inventory a normalized master as legacy and never repair retention after commit. A terminal replay returns before allocating or mutating anything.

- [ ] **Step 4: Delete the route-level preset rejection and route only uploads to Workflow dispatch**

  `source.kind === 'upload'` retains `acceptCoverPublication` plus dispatch. `preset` and `none` call the semantic service and return `200`/`409`; neither names a Workflow instance, render set, or draft.

- [ ] **Step 5: Run focused tests and inspect the stored graphs**

  ```powershell
  npm run test:worker -- tests/worker/event-cover-publication.test.ts tests/worker/event-cover-api.test.ts tests/worker/cleanup.test.ts
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 6: Commit only the semantic publication slice**

  ```powershell
  git add -- worker/db/events.ts worker/services/event-cover-publication.ts worker/routes/event-cover.ts tests/worker/event-cover-publication.test.ts tests/worker/event-cover-api.test.ts tests/worker/cleanup.test.ts
  git diff --cached --check
  git commit -m "feat: apply semantic cover publications atomically"
  ```

---

### Task 3: Close the upload finalization state machine before adding triggers

**Files:**

- Modify: `worker/db/events.ts`
- Modify: `worker/workflows/cover-render.ts`
- Modify: `worker/workflows/cover-backfill.ts`
- Modify: `worker/services/event-cover-publication.ts`
- Modify: `tests/worker/cover-render-workflow.test.ts`
- Modify: `tests/worker/cover-backfill-workflow.test.ts`
- Modify: `tests/worker/event-cover-publication.test.ts`
- Modify: `tests/worker/cleanup.test.ts`

**Interfaces:**

- Consumes: a verified exact manifest, a `publishing` draft, an exact nonterminal receipt/fence generation, and the expected event revision/pointers.
- Produces: before the swap, `staging -> ready` and `rendering -> finalizing`; after the authoritative batch, exactly one complete `applied` or `conflict` graph.
- Reuses and extends: `coverPublicationTerminalAssertionStatement(db, owner)` and `coverDisplacedUploadRetentionStatements(db, owner)` from Task 2 for upload and retained backfill terminal graphs.

- [ ] **Step 1: Add RED tests for the missing `ready`/`finalizing` checkpoint**

  Assert manifest verification records `manifest_sha256`, `ready_at`, `state = 'ready'`, and receipt `status = 'finalizing'` before the pointer swap. A replay must reuse that checkpoint.

- [ ] **Step 2: Add RED tests for an atomic final conflict**

  Race the event revision after the ready checkpoint. Assert one final batch leaves the winner untouched, receipt `conflict`, set `abandoned`, draft `ready`, fence terminal, no retired-current inventory, no displaced-master deadline, and no intermediate pointer. For upload-over-upload success, require the prior normalized set and master to receive the exact later of seven days and every referencing receipt expiry; a first upload schedules neither. Keep legacy replacement in `event_cover_retired_legacy_objects` only. Add fault injections that make an expected applied/conflict or displaced set/master retention update change zero rows and assert the whole batch rolls back.

- [ ] **Step 3: Implement the ready checkpoint**

  After exact R2/manifest verification, use a guarded D1 batch to move only the exact staging set and receipt to `ready`/`finalizing`. No event pointer changes here. A stale owner takes the existing safe conflict/failure path.

- [ ] **Step 4: Refactor the authoritative final transaction**

  Branch on the final event guard inside the batch:

  - the winning branch writes config/master/set/revision exactly once, publishes the draft, applies the receipt with its final expiry, retires the old active set, applies the Task-2 retention helper to the displaced normalized master, activates the ready set with `published_revision = expected + 1`, and closes the fence;
  - the losing branch leaves the event, old active set, and old master unchanged, abandons the ready set, returns the draft to ready, records conflict, and closes the fence;
  - the terminal assertion statement matches the exact receipt unconditionally and includes the required displaced set/master retention graph. It assigns an out-of-domain status when either terminal graph is incomplete, so the table CHECK throws and rolls the complete D1 batch back.

- [ ] **Step 5: Apply the same terminal-assertion discipline to the retained backfill finalizer**

  Phase 3 has no current legacy source, but the implementation and migration compatibility fixture retain the phase-2 backfill writer. Its batch must either produce a complete applied job/event/set graph or roll back; no zero-change tail may commit a partial pointer.

- [ ] **Step 6: Run the focused state-machine suites**

  ```powershell
  npm run test:worker -- tests/worker/cover-render-workflow.test.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/event-cover-publication.test.ts tests/worker/cleanup.test.ts
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 7: Commit only the state-machine slice**

  ```powershell
  git add -- worker/db/events.ts worker/workflows/cover-render.ts worker/workflows/cover-backfill.ts worker/services/event-cover-publication.ts tests/worker/cover-render-workflow.test.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/event-cover-publication.test.ts tests/worker/cleanup.test.ts
  git diff --cached --check
  git commit -m "fix: make cover finalization transaction complete"
  ```

---

### Task 4: Add fail-closed migration 0013 and pin the fresh-D1 schema

**Files:**

- Create: `migrations/0013_event_cover_invariants.sql`
- Create: `tests/worker/migration-0013.test.ts`
- Modify: `tests/worker/migration-0012.test.ts`
- Modify: `tests/worker/helpers.ts`
- Modify: `tests/worker/cleanup.test.ts`
- Modify: `scripts/verify-fresh-d1.ts`
- Modify: `tests/unit/verify-fresh-d1.test.ts`

**Interfaces:**

- Consumes: a database already migrated through `0012` and satisfying the current four-count zero proof.
- Produces: exactly these phase-3 trigger names, pinned in both migration and verifier tests:
  - `event_cover_source_pointer_insert`
  - `event_cover_source_pointer_update`
  - `event_cover_render_set_manifest_insert`
  - `event_cover_render_set_manifest_update`
  - `event_cover_render_object_manifest_insert`
  - `event_cover_render_object_manifest_update`
  - `event_cover_render_object_manifest_delete`
  - `event_cover_master_live_reference_delete`
  - `event_cover_render_set_live_reference_delete`
- Preserves: the exact deployed Phase-2 hard-purge transaction—durable `event_cover_purge_progress.phase = 'relational'`, soft-deleted event pointer clearing to canonical none/null/null, then explicit child-before-parent deletion—without permitting any other ready/active object deletion.

- [ ] **Step 1: Write RED migration tests over four fixtures**

  1. empty/fresh database;
  2. valid none, preset, and complete active-upload rows;
  3. a populated `0012` legacy row; and
  4. an invalid upload graph with incomplete or cross-event manifest ownership.

  The last two must reject `0013`. After rejection, assert no phase-3 trigger and no migration-ledger row was installed.

- [ ] **Step 2: Add RED direct-invariant tests**

  Attempt and reject:

  - none/preset with either event-owned pointer;
  - upload with null, cross-event, non-master, or non-owned set pointer;
  - unknown preset/effect/source, invalid focus/zoom, or malformed JSON;
  - ready/active sets missing a mandatory 1x pair, containing a singleton 2x format, holding a wrong slot count/checksum, or naming another event/master;
  - render-object insert, update, movement, or ordinary delete beneath ready or active sets;
  - deletion after only soft-delete, after only pointer clearing, or without exact same-event `event_cover_purge_progress.phase = 'relational'`; and
  - deletion of a master or set referenced by a live event.

- [ ] **Step 3: Add the exact phase-2 writer and hard-purge compatibility fixtures**

  Replay the deployed Phase-2 upload finalization and removal statement order under `0013`: the event may point transiently to a complete staging/ready set only when the exact same-event receipt/draft/fence or backfill job owns it inside the D1 batch; the batch must commit active/retired terminal state. The same SQL without its owner graph must fail.

  Separately replay the exact deployed hard-purge batch: require a soft-deleted event, completed R2/fence phases, durable same-event purge progress already in `relational`, canonicalize the event to none/null/null, then delete active render objects, their set, and their master in the existing child-before-parent order. Prove the batch succeeds only with that complete predicate. A live event, a merely soft-deleted event, cleared pointers without relational progress, wrong-event progress, or progress in any earlier phase must reject the first protected deletion and roll the whole batch back.

- [ ] **Step 4: Author the migration's proof guard first**

  The first executable section creates a uniquely named one-migration guard with `CHECK (proof = 1)`, inserts exactly one `CASE` result (`1` only when all four canonical predicates are zero, otherwise `0`), and drops the guard before creating triggers. Test migration atomicity so a failed CHECK leaves neither the guard table nor any trigger. Do not rely on a saved JSON artifact as the SQL predicate.

- [ ] **Step 5: Add semantic source/pointer triggers**

  Enforce the strict v1 source union, canonical pointer nullability, same-event master/set ownership, exact revision relationships, and the narrow phase-2 transactional owner exception. A live upload must commit with a complete active set; a soft-deleted event may clear to canonical none/null/null without incrementing the cover revision during purge.

- [ ] **Step 6: Add exact-manifest and reference-deletion triggers**

  A ready/active set has exactly all six 1x WebP/JPEG pairs and only paired optional 2x slots, with the required slot count, manifest SHA, same-event objects/master, and published revision for active. No object may be inserted into, updated beneath, or moved into/out of a ready/active set. Deletion is also rejected unless the owning event is soft-deleted, already canonical none/null/null, and has exact same-event durable purge progress in `relational`; this is the only exception and exists solely for the deployed Phase-2 child-before-parent hard purge. A live event blocks deletion of its current master or set; a cleared soft-deleted event without relational progress remains blocked.

- [ ] **Step 7: Update the fresh-D1 verifier from 12 to 13**

  Pin the migration filename/order, all old plus nine new trigger names, and exact trigger SQL normalized only for whitespace. Keep `migration-0012.test.ts` explicitly proving no phase-3 trigger exists when only `0001`–`0012` are applied.

- [ ] **Step 8: Run migration and verifier tests**

  ```powershell
  npm run test:worker -- tests/worker/migration-0012.test.ts tests/worker/migration-0013.test.ts tests/worker/cover-render-workflow.test.ts tests/worker/cleanup.test.ts
  npm run test:unit -- tests/unit/verify-fresh-d1.test.ts
  npm run verify:fresh-d1
  npm run typecheck
  npm run lint
  ```

  Expected: exactly 13 migrations, no foreign-key/integrity failures, exact trigger set, and safe ordered purge.

- [ ] **Step 9: Commit the invariant release**

  ```powershell
  git add -- migrations/0013_event_cover_invariants.sql tests/worker/migration-0013.test.ts tests/worker/migration-0012.test.ts tests/worker/helpers.ts tests/worker/cleanup.test.ts scripts/verify-fresh-d1.ts tests/unit/verify-fresh-d1.test.ts
  git diff --cached --check
  git commit -m "feat: enforce phase 3 cover invariants"
  ```

---

### Task 5: Replace transitional event fields with safe nested projections

**Files:**

- Create: `worker/http/event-cover-view.ts`
- Modify: `shared/contracts.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `worker/routes/event.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `worker/routes/public.ts`
- Modify: `worker/routes/event-cover.ts`
- Modify: `src/components/EventAppearanceEditor.tsx`
- Modify: `src/components/EventAppearancePreview.tsx`
- Modify: `src/components/GuestEventHero.tsx`
- Modify: `src/components/ManagerCoverPreparationStatus.tsx`
- Modify: `src/features/guest/GuestBeforeStart.tsx`
- Modify: `src/features/guest/GuestWaiting.tsx`
- Modify: `src/features/rsvp/RsvpShell.tsx`
- Modify: `src/features/settings/event-merge.ts`
- Modify: `src/features/uploads/GuestUploadFlow.tsx`
- Create: `tests/worker/event-cover-view.test.ts`
- Modify: `tests/worker/core-journey.test.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `tests/worker/event-theme-api.test.ts`
- Modify: `tests/worker/event-cover-api.test.ts`
- Modify: `tests/worker/event-cover-delivery.test.ts`
- Modify: `tests/unit/event-cover.test.ts`
- Modify: `tests/unit/event-settings-draft.test.ts`
- Modify: `tests/unit/manager-event-merge.test.ts`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/event-appearance-editor.test.tsx`
- Modify: `tests/ui/event-settings-editor.test.tsx`
- Modify: `tests/ui/event-theme-rendering.test.tsx`
- Modify: `tests/ui/guest-before-start.test.tsx`
- Modify: `tests/ui/guest-rsvp-flow.test.tsx`
- Modify: `tests/ui/guest-upload-flow.test.tsx`
- Modify: `tests/ui/manager-photo-intake.test.tsx`
- Modify: `tests/ui/manager-rsvp-panel.test.tsx`
- Modify: `tests/ui/manager-settings-autosave.test.tsx`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/event-theming.spec.ts`
- Modify: `tests/e2e/event-theming-visual.spec.ts`
- Modify: `tests/e2e/security.spec.ts`

**Interfaces:**

- `EventView.cover: EventCoverView`
- `GuestEventView.cover: GuestEventCoverView`
- `selectManagerEventCoverView(db, event, preparation) -> Promise<EventCoverView>`
- `guestCoverView(managerCover) -> GuestEventCoverView`
- Deletes: top-level `coverObjectKey`, `coverPreparation`, and `coverRevision` from both public contracts.

- [ ] **Step 1: Add RED projection tests for none, preset, complete upload, and impossible graphs**

  Assert the Manager shape has exactly `config`, `revision`, `hasCover`, `available2xProfiles`, `surfaceTreatment`, and `preparation`; the guest shape has exactly its four approved fields and no config/preparation/server pointer. Preset advertises all six 2x profiles in ASCII-lexical order; upload advertises only profiles with both current-set 2x formats; singleton/mismatched objects never become capability. `surfaceTreatment` comes from the stored effect. Preparation selects the one unresolved receipt or latest allowlisted terminal result from the last 24 hours without Workflow/platform fields.

- [ ] **Step 2: Implement `worker/http/event-cover-view.ts`**

  Strictly parse `event.coverConfig`; query only the event's current active set; derive density capability from paired inventory rather than browser geometry; and emit one sanitized `cover_projection_invariant_failed` observation before throwing on an impossible post-`0013` graph. Never fall back to the old sentinel.

- [ ] **Step 3: Make the core event projection consume an explicit nested cover view**

  Keep schedule/lifecycle projection pure. Add async manager/guest wrapper functions for routes that load D1 cover capability and preparation. Replace the settings-only `eventView(auth.event).eventStartTime` shortcut with the existing schedule helper so it does not perform an unnecessary cover read.

- [ ] **Step 4: Update every event response call site**

  Creation, manager GET/theme/settings/photo-intake responses, guest GET, publication recovery responses, and status results must all return the nested shape from one helper. No route assembles cover fields independently.

- [ ] **Step 5: Move client ownership and reconciliation to `cover`**

  Set `COVER_OWNED = ['cover']`. Mechanically move the still-temporary direct Manager controls, separate preview, and revisionless guest blob reader to `event.cover.hasCover`, `event.cover.revision`, and `event.cover.preparation`, so this commit remains type-clean before Tasks 9–10 replace those surfaces. Update every explicitly listed fixture to the nested manager or guest shape. Do not retain optional top-level compatibility fields or add a dual response.

- [ ] **Step 6: Run the projection/contract suites**

  ```powershell
  npm run test:worker -- tests/worker/event-cover-view.test.ts tests/worker/core-journey.test.ts tests/worker/manage-api.test.ts tests/worker/event-theme-api.test.ts tests/worker/event-cover-api.test.ts tests/worker/event-cover-delivery.test.ts
  npm run test:unit -- tests/unit/event-cover.test.ts tests/unit/event-settings-draft.test.ts tests/unit/manager-event-merge.test.ts tests/ui/event-appearance-editor.test.tsx tests/ui/event-settings-editor.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/guest-before-start.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/manager-photo-intake.test.tsx tests/ui/manager-rsvp-panel.test.tsx tests/ui/manager-settings-autosave.test.tsx tests/ui/app.test.tsx
  npm run typecheck
  npm run typecheck:e2e
  npm run test:e2e -- tests/e2e/accessibility.spec.ts tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/security.spec.ts
  npm run lint
  ```

- [ ] **Step 7: Commit the contract cutover**

  Stage only the paths explicitly listed in this task. Confirm `rg -n "coverObjectKey|coverPreparation|coverRevision" src` now finds no public-contract use; server-owned `EventRecord`/D1 fields remain intentionally named.

  ```powershell
  git add -- worker/http/event-cover-view.ts shared/contracts.ts worker/http/event-view.ts worker/routes/event.ts worker/routes/manage.ts worker/routes/public.ts worker/routes/event-cover.ts
  git add -- src/components/EventAppearanceEditor.tsx src/components/EventAppearancePreview.tsx src/components/GuestEventHero.tsx src/components/ManagerCoverPreparationStatus.tsx src/features/guest/GuestBeforeStart.tsx src/features/guest/GuestWaiting.tsx src/features/rsvp/RsvpShell.tsx src/features/settings/event-merge.ts src/features/uploads/GuestUploadFlow.tsx
  git add -- tests/worker/event-cover-view.test.ts tests/worker/core-journey.test.ts tests/worker/manage-api.test.ts tests/worker/event-theme-api.test.ts tests/worker/event-cover-api.test.ts tests/worker/event-cover-delivery.test.ts tests/unit/event-cover.test.ts tests/unit/event-settings-draft.test.ts tests/unit/manager-event-merge.test.ts
  git add -- tests/ui/app.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/event-settings-editor.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/guest-before-start.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/manager-photo-intake.test.tsx tests/ui/manager-rsvp-panel.test.tsx tests/ui/manager-settings-autosave.test.tsx tests/e2e/fixtures/routes.ts tests/e2e/accessibility.spec.ts tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/security.spec.ts
  git diff --cached --name-only
  git diff --cached --check
  git commit -m "feat: project nested event cover views"
  ```

---

### Task 6: Register strict revisioned delivery and immutable preset redirects

**Files:**

- Create: `shared/event-cover-assets.ts`
- Modify: `scripts/build-cover-presets.ts`
- Modify: `scripts/verify-cover-presets.ts`
- Modify: `worker/storage/event-cover-keys.ts`
- Modify: `worker/routes/content.ts`
- Modify: `src/app/api.ts`
- Modify: `tests/unit/cover-presets.test.ts`
- Modify: `tests/worker/event-cover-storage.test.ts`
- Modify: `tests/worker/event-cover-delivery.test.ts`
- Modify: `tests/ui/event-theme-rendering.test.tsx`

**Interfaces:**

- `guestEventCoverSlotPath(slug, { revision, profile, density, format })`
- `managerEventCoverSlotPath(eventId, { revision, profile, density, format })`
- `presetCoverAssetPath(assetVersion, presetId, effect, profile, density, format)` shared by build, Worker, and client preview code.
- Routes:
  - `GET /api/event/:slug/cover/:revision/:profile/:density.:format`
  - `GET /api/manage/events/:eventId/cover/:revision/:profile/:density.:format`

- [ ] **Step 1: Write RED route tests for the full slot matrix and rejection cases**

  Cover guest/manager authorization, canonical integer revision, all enum slots, wrong slug/event, stale/current revision, disabled/expired/deleted access, cross-event set, retired set, missing object, unsupported path values, and no fallback. Assert delivery performs zero Images calls and zero D1/R2 writes.

- [ ] **Step 2: Add RED preset redirect tests**

  A current preset returns `307 Temporary Redirect` to the exact versioned same-origin static path with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. The target contains no event identifier and stays covered by the existing immutable `_headers` rule.

- [ ] **Step 3: Extract the pure static-asset path contract**

  Move the duplicated preset path builder to `shared/event-cover-assets.ts`; update build/verify/Worker tests. Do not move Node filesystem code or R2 key construction into shared code.

- [ ] **Step 4: Implement one authorized slot resolver**

  After audience authorization, require path revision exactly equals `event.coverRevision`. For preset, validate the stored registry IDs and build the immutable target. For upload, select one object by current set/event/profile/density/format and require set `active`, `published_revision` equal current revision, and a valid event-prefixed key before R2 GET.

- [ ] **Step 5: Register the revisioned routes beside the local-only compatibility readers**

  Keep `/api/event/:slug/cover` and `/api/manage/events/:eventId/cover` only while Tasks 7–9 move their callers. Keep media preview/original routes unchanged. Add the new client slot builders beside the old builder names. Mark this overlap in the route test as local migration scaffolding and explicitly assert that it is removed in Task 10; no commit in Tasks 6–9 is a staging or production candidate.

- [ ] **Step 6: Run storage, route, and asset verification**

  ```powershell
  npm run test:worker -- tests/worker/event-cover-delivery.test.ts tests/worker/event-cover-storage.test.ts
  npm run test:unit -- tests/unit/cover-presets.test.ts tests/ui/event-theme-rendering.test.tsx
  npm run verify:cover-presets
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 7: Commit the reader slice**

  ```powershell
  git add -- shared/event-cover-assets.ts scripts/build-cover-presets.ts scripts/verify-cover-presets.ts worker/storage/event-cover-keys.ts worker/routes/content.ts src/app/api.ts tests/unit/cover-presets.test.ts tests/worker/event-cover-storage.test.ts tests/worker/event-cover-delivery.test.ts tests/ui/event-theme-rendering.test.tsx
  git diff --cached --check
  git commit -m "feat: serve revisioned event cover slots"
  ```

---

### Task 7: Split replay-safe draft primitives and build the single operation reconciler and Studio session

**Files:**

- Modify: `src/app/api.ts`
- Modify: `src/features/cover/cover-draft-client.ts`
- Create: `src/features/cover/use-cover-operation-reconciler.ts`
- Create: `src/features/cover/use-cover-studio-session.ts`
- Modify: `src/features/cover/cover-operation-controller.ts`
- Modify: `src/components/EventAppearanceEditor.tsx`
- Modify: `src/components/ManagerCoverPreparationStatus.tsx`
- Modify: `src/features/settings/event-merge.ts`
- Modify: `src/pages/CreatePage.tsx`
- Create: `tests/unit/api-envelope.test.ts`
- Create: `tests/ui/cover-operation-reconciler.test.tsx`
- Create: `tests/ui/cover-studio-session.test.tsx`
- Modify: `tests/ui/cover-studio.test.tsx`
- Modify: `tests/ui/event-appearance-editor.test.tsx`
- Modify: `tests/ui/manager-cover-preparation.test.tsx`
- Modify: `tests/unit/manager-event-merge.test.ts`

**Interfaces:**

- `apiEnvelope<T>(path, init) -> Promise<ApiEnvelopeResponse<T>>`, where `ApiEnvelopeResponse<T> = { status: number; data: T; location: string | null; retryAfterMs: number | null }`; the transport exposes only those selected headers and preserves valid `Retry-After` metadata on envelope-shaped non-2xx answers.
- `CoverOperationAnswer = { status: number; operation: EventCoverPreparationView; appliedRevision?: number; event?: EventView; receiptPath: string; retryAfterMs: number | null }`, returned consistently by publication, status, and restart. `Location` is accepted only when it is the same-origin status path for the same event/operation; otherwise the client reconstructs that authorized path.
- Draft primitives: `createCoverDraft`, `transferCoverDraft`, `inspectCoverDraft`, `writeCoverComposition`, `readCoverDraft`, `discardCoverDraft`, `readCoverEffectPreview`, and `publishCoverIntent`.
- Retained wrapper: `publishCoverUpload(options)` composes the primitives with automatic focus/natural effect for `CreatePage` only.
- `useCoverOperationReconciler({ eventId, preparation, onCoverEvent, onFreshEventRequired })` owns exactly one controller and persisted operation ID per mounted Manager event. It consumes complete operation answers, merges an applied event through cover ownership, requests one guarded fresh event when a terminal answer omits it, and continues after Studio closes.
- New Studio hook result includes: `open`, `selection`, `draft`, `draftState`, `operation`, `operationState`, `canvasPreview`, `styleThumbnails`, `accessFailure`, `openStudio`, `chooseSource`, `chooseFile`, `enterCompose`, `setFocus`, `resetFocus`, `setEffect`, `publish`, `discard`, and `close`. It consumes the Manager reconciler; it never creates another polling controller.

- [ ] **Step 1: Add RED transport and primitive tests for new and existing drafts**

  Prove persisted `draftIntentId` before reserve, same-intent replay, expected active revision for existing upload, no client object key, transfer/inspect/composition guards, preview abort signal, discard `If-Match`, and persisted operation ID before publication dispatch. At the transport boundary prove:

  - publication `202` preserves the safe operation, exact same-operation `Location`, and `Retry-After: 2`;
  - restart `503` remains a typed envelope, preserves a longer valid `Retry-After`, and never degrades into a generic exception;
  - status `200 applied` carries `appliedRevision` plus the full nested event;
  - malformed, cross-origin, or wrong-event/operation `Location` is rejected and replaced with the locally constructed authorized path;
  - malformed, negative, date-form, or non-finite `Retry-After` is ignored because this API contract emits integer delta-seconds; and
  - terminal consumption clears persisted operation state only after its event or guarded-refresh handoff, while retryable or ambiguous work retains it.

- [ ] **Step 2: Refactor the monolithic client without changing CreatePage behavior**

  Export the primitives, retain guarded session-storage helpers, and rewrite `publishCoverUpload` as a thin sequential wrapper. Its observable progress and error semantics must stay unchanged.

- [ ] **Step 3: Add RED hook tests for initial semantic state**

  - none opens with no source and natural style;
  - preset opens with its preset/effect and skips Compose;
  - existing upload opens with current effect/focus, but `Reset to automatic` uses the master's stored automatic point;
  - current authoritative cover stays on the canvas until a local draft preview is ready.

- [ ] **Step 4: Implement draft/session lifecycle and object-URL ownership**

  `enterCompose()` is the only existing-upload edit-draft caller. On Choose → Compose it persists/replays one draft intent, sends the current expected cover revision, requests the edit draft once, and exposes loading/error/ready state without replacing the authoritative canvas before a preview is ready. Back → Compose reuses the same intent/draft; a stale `409` adopts the winning nested cover and focuses the first actionable correction. For a new file, reserve/transfer/inspect/compose before enabling continuation. Revoke every blob URL on replacement/close/unmount; abort superseded preview requests; never discard after dispatch becomes ambiguous.

- [ ] **Step 5: Implement bounded real effect thumbnails**

  Natural reuses the inspected preview. The other four effects call the authorized preview endpoint at most once per `(draft,effect,recipe)`, expose loading/ready/error state, and cannot exceed five total preview files. A different draft cancels outstanding requests and clears the cache.

- [ ] **Step 6: Install the single Manager-level operation reconciler**

  `EventAppearanceEditor` creates one `useCoverOperationReconciler` instance per event and passes it to both the Studio session and `ManagerCoverPreparationStatus`; the status component becomes a view over reconciler state and does not schedule a second request. Persist the operation ID before `Done`. The controller consumes `CoverOperationAnswer` and schedules each next read after `max(the local 2/4/8/10-second cadence, retryAfterMs)`, pauses while hidden, and resumes on visibility/network/auth recovery. An applied answer immediately merges its full event through `mergeCoverResponse`; a terminal answer without an event requests exactly one guarded Manager read. Lost publication/status responses retain the operation ID and receipt path, so closing, session loss, or sheet unmount leaves the Manager reconciler polling the same operation. Elapsed time changes copy after 60 seconds but never invents failure. A retryable action sends only the existing operation ID to restart the server-pinned request; it never reconstructs the recipe or allocates a new ID. Clear persisted operation state only after terminal adoption completes.

  Add a discriminated `accessFailure` with `phase: 'before_dispatch' | 'after_dispatch'`. Before dispatch, retain the draft and send nothing; after accepted or ambiguous dispatch, retain the operation and never discard or republish. The reconciler waits for Manager access recovery, performs a guarded fresh event read, and resumes the server-selected operation.

- [ ] **Step 7: Run focused client orchestration tests**

  ```powershell
  npm run test:unit -- tests/unit/api-envelope.test.ts tests/ui/cover-operation-reconciler.test.tsx tests/ui/cover-studio-session.test.tsx tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/manager-cover-preparation.test.tsx tests/unit/manager-event-merge.test.ts
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 8: Commit the session slice**

  ```powershell
  git add -- src/app/api.ts src/features/cover/cover-draft-client.ts src/features/cover/use-cover-operation-reconciler.ts src/features/cover/use-cover-studio-session.ts src/features/cover/cover-operation-controller.ts src/components/EventAppearanceEditor.tsx src/components/ManagerCoverPreparationStatus.tsx src/features/settings/event-merge.ts src/pages/CreatePage.tsx
  git add -- tests/unit/api-envelope.test.ts tests/ui/cover-operation-reconciler.test.tsx tests/ui/cover-studio-session.test.tsx tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/manager-cover-preparation.test.tsx tests/unit/manager-event-merge.test.ts
  git diff --cached --check
  git commit -m "feat: own cover studio draft sessions"
  ```

---

### Task 8: Finish the Cover Studio sheet/dialog state machine

**Files:**

- Modify: `src/features/cover/CoverStudio.tsx`
- Modify: `src/features/cover/CoverSourcePicker.tsx`
- Modify: `src/features/cover/CoverComposer.tsx`
- Modify: `src/features/cover/CoverStylePicker.tsx`
- Modify: `src/styles.css`
- Modify: `tests/ui/cover-studio.test.tsx`
- Modify: `tests/ui/cover-studio-session.test.tsx`

**Interfaces:**

- `CoverStudioDraft` separates `initialFocus` from `automaticFocus` and keeps server-owned `master.width`, `master.height`, and `safeZoomMaximum`; the session recomputes `available2xProfiles` locally with the shared crop geometry whenever focus or zoom moves.
- `CoverStylePicker.thumbnail(effect)` returns a discriminated loading/ready/error thumbnail state, not an invented URL.
- `CoverStudio` receives controlled `composeState` and `onEnterCompose()`, and reports controlled source/focus/effect changes to the session so the single canvas updates immediately. Advancing local step state alone never creates an edit draft.
- The open Studio instance owns one browser-history sentinel with explicit `arm`, `consume`, and `rearm` transitions.

- [ ] **Step 1: Add RED interaction tests for every approved path**

  Upload: Choose → Compose → Style → Done. Preset: Choose → Style → Done. Removal: Choose → Done. Cover accurate `Step n of m`, separately focusable step headings, Continue-heading focus, Back-origin focus, Escape, backdrop, dirty confirmation, discard, retry, session expiry, 60-second slow-preparation copy, Close-after-dispatch, successful auto-close, and exact focus restoration to `Change cover`.

  Exercise real history transitions, not only a synthetic `popstate`: browser Back opens discard confirmation; `Keep editing` synchronously re-arms the sentinel before restoring focus; a second Back opens confirmation again; `Discard draft` closes without an extra navigation; and ordinary Close consumes exactly the Studio-owned entry without a popstate loop. Prove the alertdialog traps focus and returns it to the initiating Studio control.

- [ ] **Step 2: Make upload choice explicit and accessible**

  Replace the nested radio/file-input ambiguity with a visible `Upload a photo` source choice and a labelled `Choose photo` file control. Canceling the native picker must not leave a fake upload draft or advance the step. Render the six preset tiles in exactly two columns on the narrow sheet and three columns in the wide dialog, with the approved names and `Ready for every size` copy. Show `Remove cover` only as a secondary action when a cover is active; confirmation creates the canonical none intent rather than a seventh choice.

- [ ] **Step 3: Make selection/focus/effect controlled by the session**

  Initialize from the semantic event config. Advancing an existing upload from Choose to Compose calls `onEnterCompose()` exactly once for the persisted intent. Compose renders loading/error/ready states and Continue remains disabled until ready; Back → Compose reuses the same intent/draft instead of reserving another. A stale `409` adopts the winning cover and focuses the first actionable correction. Reset uses `automaticFocus`, while Back preserves the current controlled selection.

- [ ] **Step 4: Render real thumbnail states and actionable errors**

  Keep the style radios named and usable while individual tiles load. An effect-preview failure stays in Style, associates the message with that tile/retry, focuses the first actionable correction, and preserves the active cover and all other choices. Upload, inspection, preparation, success, and failure transitions use settled live-region announcements rather than announcing every pointer/range movement.

- [ ] **Step 5: Correct local crop geometry without network transforms**

  Use the uncropped preview with measured cover-frame geometry, object-fit cover, focal translation, and server-capped zoom. Automatic mode shows the resolved proposal. `Adjust focus` copies that point into the three native ranges with no visual jump; Reset returns to it. Pointer and range movement update only local state and recompute 2x eligibility from shared geometry plus the server-reported master size. When no profile remains 2x-safe, show the approved non-blocking high-density softness message without disabling the mandatory 1x path. Keep range order, exact value text, Arrow one-step behavior, Page Up/Down ten-step behavior, Home/End bounds, retained focus, and the settled polite summary; browser pinch remains native.

- [ ] **Step 6: Complete viewport/focus mechanics**

  Keep the stable accessible name `Cover Studio`. At widths `<= 760px`, use a `100dvh` sheet with a 56-pixel sticky header, safe-area footer, inert/scroll-locked Manager, `min-height: 0` work area, and only the step-control pane scrolling in normal height. Keep the sticky canvas at least 144 pixels at 320×568, compact it to 96 pixels below a 500-pixel visual viewport without selecting a new crop/profile, bind the sheet to `visualViewport.offsetTop/height`, and use one dialog-level scroller with in-flow header/canvas/footer at visual height `<= 420px`. Above 760px, use the centered dialog. Respect reduced motion and 44×44 targets. If Back consumed the sentinel and the host chooses `Keep editing`, push its replacement before closing the alertdialog; restore focus inside Studio, never to the page behind it.

- [ ] **Step 7: Run UI tests at default, compact, and short visual heights**

  ```powershell
  npm run test:unit -- tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 8: Commit the interaction slice**

  ```powershell
  git add -- src/features/cover/CoverStudio.tsx src/features/cover/CoverSourcePicker.tsx src/features/cover/CoverComposer.tsx src/features/cover/CoverStylePicker.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx
  git diff --cached --check
  git commit -m "feat: complete the cover studio interaction"
  ```

---

### Task 9: Replace the Manager preview with the live Event Appearance canvas

**Files:**

- Create: `src/app/cover-observability.ts`
- Modify: `src/components/EventAppearanceEditor.tsx`
- Modify: `src/components/EventAppearanceCanvas.tsx`
- Delete: `src/components/EventAppearancePreview.tsx`
- Modify: `src/components/EventThemePresetSelector.tsx`
- Modify: `src/components/ManagerCoverPreparationStatus.tsx`
- Modify: `src/features/settings/event-merge.ts`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/styles.css`
- Modify: `tests/ui/event-appearance-editor.test.tsx`
- Modify: `tests/ui/event-theme-rendering.test.tsx`
- Modify: `tests/ui/manager-cover-preparation.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/unit/manager-event-merge.test.ts`

**Interfaces:**

- `EventAppearanceCanvas` receives the full resolved theme, authoritative cover/source builder, optional local draft preview, neutral summary/actions, `onCoverUnavailable(detail)`, and `onRefreshCoverEvent()`, with no nested interactive guest controls. Recovery callbacks attach only to authoritative responsive covers, never local blob previews.
- `EventAppearanceEditor` owns theme autosave, cover-owned event merging, the Task-7 operation reconciler, and guarded Manager event refresh; `useCoverStudioSession` owns only sheet/draft mechanics.
- `EventAppearanceEditor` adds `onCoverAccessFailure(failure: LoadFailure | null)`. `ManagerPage` maps it into the existing `ManagerNotice`/`ManagerAccessRecovery` surface rather than generic in-editor prose.
- `emitCoverUnavailable({ audience: 'manager' | 'guest', profile, revision })` emits once per audience/revision/profile and contains no object key, storage path, raw URL, arbitrary error, or platform state.

- [ ] **Step 1: Add RED tests proving the separate preview is gone**

  Assert no `Guest preview` heading or `EventAppearancePreview` exists. Theme preset/custom color changes update the canvas immediately; Manager errors, retry, focus rings, and controls retain global tokens. Prove one reconciler schedules status reads while Studio and Manager status subscribe concurrently, and neither close nor rerender allocates another controller.

- [ ] **Step 2: Apply all theme tokens to the guest-like canvas**

  Use `eventThemeStyle(theme.tokens)`, not only primary/accent. Render the event identity, welcome copy, inert action samples, current responsive cover, runtime treatment, overlay, and scrim in guest order. Constrain the Manager canvas to the guest's 620-pixel maximum and the non-expanded profile branch unless an explicit rehearsal state is added by the governing design.

- [ ] **Step 3: Render local Cover Studio intent on the same canvas**

  A local, unpublished preset intent may use its immutable static slot path. An authoritative preset or upload always uses the Manager revisioned route from Task 6. Upload drafts use the authorized uncropped blob plus local focus/zoom/effect treatment. None reveals the theme gradient. Closing without dispatch restores the authoritative event cover; an applied operation answer merges only `event.cover` and switches to server slot URLs. Pass unavailable/refresh callbacks through the canvas only for that authoritative picture.

- [ ] **Step 4: Replace direct upload/remove controls with one cover summary and `Change cover` action**

  Keep `ManagerCoverPreparationStatus` beside the summary and feed the Task-7 reconciler's state, seeded by `event.cover.preparation` or its persisted operation ID. It renders progress while Studio is open but never schedules its own competing loop. Pending work stays visible and the same controller continues after the sheet closes. On reload, adopt `event.cover.preparation`; if a lost response left only the persisted ID, show neutral preparing copy and perform the controller's immediate same-operation read. The summary is outside themed inheritance.

- [ ] **Step 5: Wire authoritative Manager delivery and access recovery**

  Final WebP/JPEG failure suppresses the picture, shows the theme gradient, emits one Manager observation, and asks `EventAppearanceEditor` for at most one guarded whole-event refresh per audience/revision/profile. A failed refresh preserves the current event/canvas and surfaces a global Manager notice; a newer revision resets the guard. A terminal operation answer without an event performs exactly one guarded refresh, while an applied answer with an event performs none.

  Treat authorization loss as a Manager load/access failure. Before `Done`, retain the draft and dispatch nothing; after `Done` or an ambiguous response, retain the operation ID and never discard or republish. `ManagerPage` presents its existing latest-link/sign-in recovery, and successful remount/recovery performs a fresh event read before the same reconciler resumes the server-selected operation.

- [ ] **Step 6: Upgrade theme choices from three dots to a real surface/action/accent sample**

  Keep native radios, visible names/descriptions, non-color selected state, and global control semantics. The sample itself is inert and uses the preset's real surface, primary action/foreground, accent, border, and radius tokens.

- [ ] **Step 7: Verify cover-owned merging, recovery, and stale theme autosave remain independent**

  A cover response replaces only `event.cover`; a theme response replaces only `event.theme`. An older whole-event read cannot revert either domain while its write is in flight. Prove: close after `202`, restart `503`, and lost response retain the same operation ID; applied response merges without a redundant read; terminal-without-event performs one read; reload with cleared client operation storage resumes `event.cover.preparation`; auth loss before/after `Done` retains the correct draft/operation; and Manager WebP→JPEG final failure emits/refreshes once without stale-state replacement.

- [ ] **Step 8: Run Manager UI and merge tests**

  ```powershell
  npm run test:unit -- tests/ui/event-appearance-editor.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/manager-cover-preparation.test.tsx tests/ui/app.test.tsx tests/unit/manager-event-merge.test.ts
  npm run typecheck
  npm run lint
  ```

- [ ] **Step 9: Commit the live-canvas slice**

  ```powershell
  git add -- src/app/cover-observability.ts src/components/EventAppearanceEditor.tsx src/components/EventAppearanceCanvas.tsx src/components/EventThemePresetSelector.tsx src/components/ManagerCoverPreparationStatus.tsx src/features/settings/event-merge.ts src/pages/ManagerPage.tsx src/styles.css tests/ui/event-appearance-editor.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/manager-cover-preparation.test.tsx tests/ui/app.test.tsx tests/unit/manager-event-merge.test.ts
  git rm -- src/components/EventAppearancePreview.tsx
  git diff --cached --check
  git commit -m "feat: turn on the live event appearance canvas"
  ```

---

### Task 10: Wire the responsive guest hero and remove the last compatibility client

**Files:**

- Create: `src/features/guest/GuestEventRefreshContext.tsx`
- Modify: `src/app/cover-observability.ts`
- Modify: `src/components/ResponsiveEventCover.tsx`
- Modify: `src/components/GuestEventHero.tsx`
- Modify: `src/pages/EventPage.tsx`
- Modify: `src/features/uploads/GuestUploadFlow.tsx`
- Modify: `src/features/guest/GuestBeforeStart.tsx`
- Modify: `src/features/guest/GuestWaiting.tsx`
- Modify: `src/features/rsvp/RsvpShell.tsx`
- Modify: `src/features/rsvp/RsvpLookup.tsx`
- Modify: `src/app/api.ts`
- Modify: `worker/routes/content.ts`
- Delete: `src/app/use-event-cover.ts`
- Modify: `src/styles.css`
- Modify: `tests/worker/event-cover-delivery.test.ts`
- Modify: `tests/ui/responsive-event-cover.test.tsx`
- Modify: `tests/ui/guest-upload-flow.test.tsx`
- Modify: `tests/ui/guest-rsvp-flow.test.tsx`
- Modify: `tests/ui/guest-before-start.test.tsx`
- Modify: `tests/ui/event-theme-rendering.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/security.spec.ts`

**Interfaces:**

- `GuestEventHero` consumes `event.cover: GuestEventCoverView`, a slot path builder, and explicit `lookup` state; it no longer consumes presence sentinel or blob URL.
- `GuestEventRefreshContext` provides the existing ticketed event recheck without prop-drilling through RSVP screens.
- `emitCoverUnavailable({ audience: 'manager' | 'guest', profile, revision })` retains the Task-9 signature and logs one allowlisted client observation per audience/revision/profile with no storage state. Every guest caller passes `audience: 'guest'`; Manager and guest failures never suppress one another.

- [ ] **Step 1: Add RED hero tests for measured profile and revision changes**

  Assert no request before first container measurement; exact short lookup/compact/standard/framed/expanded profile selection; optional 2x only when advertised; source URLs and React key changing on revision; and removal unmounting the picture without remounting the page.

- [ ] **Step 2: Add RED recovery tests**

  A failed WebP selection removes WebP once and tries the verified JPEG candidates. Final failure suppresses the image immediately, shows the theme gradient, emits one sanitized guest observation, and requests at most one event refresh for that audience/revision/profile. The same tuple never loops; a newer revision resets.

- [ ] **Step 3: Make `ResponsiveEventCover` a real positioned hero layer**

  Size its measured frame to the actual hero/canvas container, position picture/image/treatment/scrim beneath copy, keep the empty alt, and preserve the exact runtime layer order. Do not add `sizes` to density-descriptor `srcset`.

- [ ] **Step 4: Connect the existing ticketed event refresh**

  Wrap guest surfaces in `GuestEventRefreshContext`. Include `event.cover.revision`, presence, density capability, and treatment in `guestLifecycleKey`, so a cover-only refresh installs the new view while a semantic no-op keeps the existing anti-spin floor.

- [ ] **Step 5: Replace every hero call site with the nested cover view**

  `GuestUploadFlow`, before-start, waiting, and primary RSVP use the same component. Add an explicit `lookup` prop from `RsvpLookup` through `RsvpShell`; never infer profile state from a CSS class or user agent. Expanded welcome passes its actual state.

- [ ] **Step 6: Delete the compatibility routes, blob hook, and old path builders**

  Remove the two revisionless registrations from `worker/routes/content.ts`, delete `use-event-cover.ts`, and delete `guestEventCoverPath` and `managerEventCoverPath`. Change the route test from the temporary-overlap assertion to explicit 404/not-registered coverage. Update `tests/e2e/security.spec.ts` from its obsolete `coverObjectKey`/blob-background assertion to the nested cover contract: a decorative `<picture>/<img>` uses one current-revision, same-origin, allowlisted profile/density/format route, and no master/object key or revisionless route enters the DOM. Retain the shipped `img-src 'self' blob: data:` CSP assertion because authorized local Studio previews still use blob URLs. `rg` must find no old contract field, route/builder, `--event-cover` CSS variable, or compatibility sentinel in the Worker/client surface.

  ```powershell
  rg -n -- "coverObjectKey|guestEventCoverPath|managerEventCoverPath|useEventCover|cover-present|--event-cover" src
  rg -n "contentRoutes\.get\('/event/:slug/cover'|contentRoutes\.get\('/manage/events/:eventId/cover'" worker/routes/content.ts
  ```

  Expected: no matches.

- [ ] **Step 7: Run all affected component suites**

  ```powershell
  npm run test:worker -- tests/worker/event-cover-delivery.test.ts
  npm run test:unit -- tests/ui/responsive-event-cover.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/guest-before-start.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/app.test.tsx
  npm run typecheck
  npm run typecheck:e2e
  npm run test:e2e -- tests/e2e/security.spec.ts
  npm run lint
  ```

- [ ] **Step 8: Commit the responsive client cutover**

  ```powershell
  git add -- src/features/guest/GuestEventRefreshContext.tsx src/app/cover-observability.ts src/components/ResponsiveEventCover.tsx src/components/GuestEventHero.tsx src/pages/EventPage.tsx src/features/uploads/GuestUploadFlow.tsx src/features/guest/GuestBeforeStart.tsx src/features/guest/GuestWaiting.tsx src/features/rsvp/RsvpShell.tsx src/features/rsvp/RsvpLookup.tsx src/app/api.ts worker/routes/content.ts src/styles.css tests/worker/event-cover-delivery.test.ts tests/ui/responsive-event-cover.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/guest-before-start.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/app.test.tsx tests/e2e/security.spec.ts
  git rm -- src/app/use-event-cover.ts
  git diff --cached --check
  git commit -m "feat: use responsive revisioned guest covers"
  ```

---

### Task 11: Prove the complete interaction in real browsers and recapture only invalidated baselines

**Files:**

- Create: `tests/e2e/event-cover-studio.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/fixtures/cover-images.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/event-theming-visual.spec.ts`
- Verify: `tests/e2e/security.spec.ts`
- Modify as behavior requires: `tests/e2e/guest-responsive.spec.ts`
- Modify as behavior requires: `tests/e2e/guest-lifecycle.spec.ts`
- Update only reviewed files under:
  - `tests/e2e/event-theming-visual.spec.ts-snapshots/`
  - `tests/e2e/event-cover-studio.spec.ts-snapshots/`

**Interfaces:**

- Consumes: production Vite preview plus API stubs for browser/UI behavior; it does not claim workerd, real Images, or Workflow behavior.
- Produces: desktop/mobile network, interaction, axe, zoom, and visual evidence for the final React contract.

- [ ] **Step 1: Extend fixtures to the nested event and revisioned slot contract**

  Stub manager/guest event refresh, upload draft stages, existing-upload edit drafts, five bounded previews, semantic and upload publications, receipt polling/restart, preset redirects, and current/stale slot responses. Record every transform/publication/status/slot request with its timestamp and selected response headers. Support controllable `202`, longer `Retry-After`, status-applied-with-event, restart `503`, dropped publication responses, auth loss/recovery, and server-selected preparation after client operation storage is cleared. Export deterministic `portrait-edge-dark` and `landscape-centered-light` upload fixtures in addition to minimal transport fixtures.

- [ ] **Step 2: Add the complete Cover Studio journey**

  Test upload, preset, existing-upload reset/re-edit, removal, Cancel/discard, applied/conflict/permanent outcomes, retryable same-operation restart, `202` Location/Retry-After polling, hidden-document pause/resume, close/reopen, lost response, reload after clearing client operation storage, and Manager-level reconciliation. Assert one polling owner at every transition, longer server retry delays, applied-event consumption without a redundant GET, terminal-without-event guarded refresh, same-ID handoff, access recovery, and no duplicate publication or operation ID.

- [ ] **Step 3: Add mobile, keyboard, and zoom geometry cases**

  Exercise exact widths 760 and 761, 320×568, 390×844, desktop, a 200%-equivalent 640×450 CSS viewport, deterministic `visualViewport` keyboard states immediately above and below the 500-pixel compact threshold, and approximately 320×180 at 400% zoom. Prove one usable scroll region, reachable headings/ranges/footer, safe-area spacing, native page zoom, 44×44 targets, no hidden focused control, repeated Back → Keep editing → Back, alertdialog focus containment, and exact invoker restoration. Label simulated `visualViewport` evidence as browser geometry only; physical keyboard behavior remains Task 17.

- [ ] **Step 4: Add responsive network assertions**

  Cover profile boundaries 360/361, 390/391, 699/700; heights 599/600/601 and 759/760; and each exact profile ID: `short-lookup`, `compact-default`, `standard-default`, `framed-default`, `compact-expanded`, and `wide-expanded`. Assert only advertised candidates appear in `srcset`; record the candidate Chromium chooses without generalizing it to every browser.

- [ ] **Step 5: Complete the explicit visual, recovery, keyboard, and accessibility matrix**

  | Evidence | Required coverage |
  | --- | --- |
  | Responsive visuals | Each of the six profiles with both `portrait-edge-dark` and `landscape-centered-light`; exact crop/clipping, no master or old-revision request, and image → grain → overlay → scrim → copy order |
  | Theme/preset/effect | Representative immutable preset plus upload effects across all four themes, including light and dark surfaces |
  | Delivery recovery | Manager and guest WebP → JPEG once, final gradient fallback, one sanitized observation, one refresh, unchanged-revision no-loop, and newer-revision reset |
  | Studio geometry | Mobile sheet, desktop dialog, visual-keyboard compact state, 200%-equivalent viewport, and 400%-equivalent short-height viewport |
  | Keyboard/focus | Range Arrow/Page/Home/End and `aria-valuetext`, settled crop announcement, first-actionable-error focus, dialog trap/return, and repeated browser Back |
  | Motion and announcements | With `prefers-reduced-motion: reduce`, nonessential transitions/scroll animation are absent and focus/state remain correct; upload, inspection, preparation, success, and failure each announce once only after the corresponding settled transition |
  | Dynamic accessibility | Axe on Choose, Compose, Style, Done, discard alertdialog, loading, actionable error, preparing/slow, retryable/permanent/success, Manager canvas, and guest hero |

  Also prove zero transform requests during drag/range changes, no more than five draft previews, no duplicate/intermediate live-region announcements, and no broken-image icon. Keep image-background contrast evidence in deterministic compositor tests, not axe claims.

- [ ] **Step 6: Capture and inspect only the baselines invalidated by the live canvas/hero**

  ```powershell
  npm run test:e2e -- tests/e2e/event-cover-studio.spec.ts tests/e2e/event-theming-visual.spec.ts --project=mobile --update-snapshots
  npm run test:e2e -- tests/e2e/event-cover-studio.spec.ts tests/e2e/event-theming-visual.spec.ts --project=desktop --update-snapshots
  git status --short -- tests/e2e
  ```

  Capture the six-profile × two-directional-fixture matrix plus the Manager/Studio geometry states named above. Inspect each PNG at full size. Reject unrelated baseline churn, clipped controls, incorrect focal placement, false theme inheritance, placeholder tiles, or unreadable copy.

- [ ] **Step 7: Run the complete browser and per-commit buildability gate**

  ```powershell
  npm run typecheck
  npm run typecheck:e2e
  npm run lint
  npm run test:e2e -- tests/e2e/event-cover-studio.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/guest-lifecycle.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/security.spec.ts
  ```

- [ ] **Step 8: Commit the explicit browser-evidence allowlist**

  Stage every named source file that actually changed, then add each inspected PNG as one literal path. Never stage either snapshot directory, use a wildcard, or omit a conditionally modified guest spec.

  ```powershell
  git add -- tests/e2e/event-cover-studio.spec.ts tests/e2e/fixtures/routes.ts tests/e2e/fixtures/cover-images.ts tests/e2e/accessibility.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/guest-lifecycle.spec.ts
  git diff --cached --name-only
  git diff --cached --check
  git commit -m "test: prove cover studio and responsive heroes"
  ```

  Before `git diff --cached`, stage each inspected PNG with a separate `git add --` command using its exact repository-relative path from `git status --short -- tests/e2e`. Remove a conditionally named guest spec from the source command only when its own exact `git diff` is empty. Require a clean worktree after commit.

---

### Task 12: Build the guarded staging topology, deployment, and evidence path

**Files:**

- Create: `scripts/release-candidate.ts`
- Modify: `scripts/deploy-release.ts`
- Create: `scripts/migrate-release.ts`
- Create: `scripts/staging-release-evidence.ts`
- Create: `scripts/staging-release.ts`
- Modify: `package.json`
- Create: `tests/unit/release-candidate.test.ts`
- Modify: `tests/unit/deploy-release.test.ts`
- Create: `tests/unit/migrate-release.test.ts`
- Create: `tests/unit/staging-release-evidence.test.ts`
- Create: `tests/unit/staging-release.test.ts`

**Interfaces:**

- `verifyExactReleaseCandidate({ candidateRoot, sha, manifestPath }) -> VerifiedReleaseCandidate` owns the clean exact-HEAD/tree, candidate-manifest/sidecar, approved-base, migration, generated-artifact, and source-topology checks currently private to `deploy-release.ts`. Production deployment imports it without changing production command semantics.
- `buildPhase2BootstrapBundle({ verifiedPhase2Candidate, through: '0012_event_cover_storage.sql', outputPath }) -> { path, sha256, migrations }` creates one owned ephemeral SQL import: the pinned Wrangler `d1_migrations` table definition followed by the exact manifest-hashed bytes of `0001`–`0012` in order and one wrapper-owned ledger insert after each file. It never edits a migration or emits another `--through` boundary.
- `buildAtomicMigrationBundle({ verifiedCandidate, expectedLedger, migration: '0013_event_cover_invariants.sql', outputPath }) -> { path, sha256, migrationHash }` creates one owned ephemeral import containing the exact manifest-hashed `0013` bytes and its deterministic ledger insert. Staging and production use this file-import path rather than Wrangler's compound-SQL `migrations apply` parser.
- `StagingTargetDescriptorV1` is one exact-schema, regular nonsymlinked JSON input beneath ignored `output/staging-input/`. It names `purpose: 'workflow-conformance' | 'cutover'`, account, Worker routes/`workers_dev`/preview policy, D1, R2, Images, assets, `EMAIL`, both rate-limit namespaces, all three Workflows (`EXPORT_WORKFLOW`, `COVER_RENDER_WORKFLOW`, `COVER_BACKFILL_WORKFLOW`), cron policy, every nonsecret var (`APP_ORIGIN`, `ALTERNATE_ORIGINS`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `EMAIL_FROM`), exact required secret names, observability, placement, expiry, and cleanup owner. It contains no token, secret value, object key, or private URL.
- `StagingConformanceArtifactV1` is canonical JSON plus an atomic `.sha256` sidecar beneath `output/staging/$candidateSha/$runId/`. It binds both source candidates/manifests, approved-main SHA, review-authorization digest, staging-authorization digest, target digests, migration ledger plus source/bootstrap/`0013` bundle hashes, deployed versions/tags/traffic, Images and both cover-Workflow results, route/browser results, timestamps, complete resource destruction/fixture cleanup, and overall status.
- `scripts/staging-release.ts` provides `initialize`, `deploy`, `migrate`, `finalize`, and `verify`. Every remote mode requires the exact external target descriptor and explicit review/staging authorization digests; no mode can target the canonical production topology or call `scripts/deploy-release.ts`.
- `scripts/migrate-release.ts` is the production-only migration runner. It verifies the exact Phase-3 candidate/manifest, canonical production topology, authorization and Time Travel bookmark artifacts, a remote ledger ending exactly at `0012`, and the sole pending migration `0013` before invoking only the repository-pinned Wrangler with the hashed atomic single-migration file; afterward it requires exactly `0001`–`0013`, the expected migration/bundle hashes, and the exact post-`0013` schema fingerprint.
- Exact CLI grammar, with every variable loaded from the authorizing record or a verified artifact:

  ```powershell
  npm run release:staging -- initialize --candidate-root $phase2Root --sha $phase2Sha --manifest $phase2Manifest --target $targetDescriptor --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId --through 0012_event_cover_storage.sql
  npm run release:staging -- deploy --candidate-root $candidateRoot --sha $sourceSha --manifest $sourceManifest --target $targetDescriptor --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId
  npm run release:staging -- migrate --candidate-root $phase3Root --sha $candidateSha --manifest $candidateManifest --target $cutoverTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId
  npm run release:staging -- finalize --sha $candidateSha --manifest $candidateManifest --phase2-manifest $phase2Manifest --workflow-target $workflowTarget --cutover-target $cutoverTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --evidence-input $sanitizedEvidenceInput --run-id $runId
  npm run release:staging -- verify --artifact $stagingArtifact --sidecar $stagingArtifactSidecar --manifest $candidateManifest --phase2-manifest $phase2Manifest --review-authorization $reviewAuthorization --authorization $stagingAuthorization
  npm run release:migrate -- --sha $candidateSha --manifest $candidateManifest --authorization $productionAuthorization --bookmark $timeTravelBookmarkArtifact
  ```

  Reject unknown, duplicate, missing, empty, symlinked, or path-escaping arguments. `deploy` derives purpose from the target descriptor; callers cannot override it with another flag.

- [ ] **Step 1: Write RED exact-candidate, target, and deploy-root tests**

  Prove rejection of a dirty, wrong-HEAD, wrong-tree, wrong-base, sidecar-mismatched, or symlinked candidate/manifest; an unknown/missing target field; missing expiry/cleanup owner; any secret-shaped field; a production Worker/D1/R2/Images/Email/rate-limit/Workflow identity; wrong purpose; public route, preview URL, `workers_dev`, or cron in `workflow-conformance`; topology substitution after validation; use of a non-repository Wrangler binary; untagged/wrong-SHA upload; and a source config/artifact hash that differs from the candidate manifest.

  Enumerate every production-capable surface from the generated config and prove each is replaced or explicitly disabled: Worker name/routes/`workers_dev`/preview URLs, D1, R2, Images, assets, `EMAIL`, `HOST_AUTH_RATE_LIMIT`, `RSVP_LOOKUP_RATE_LIMIT`, `EXPORT_WORKFLOW`, `COVER_RENDER_WORKFLOW`, `COVER_BACKFILL_WORKFLOW`, cron triggers, placement, observability, `APP_ORIGIN`, `ALTERNATE_ORIGINS`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, and `EMAIL_FROM`. Require the exact secret-name set through a read-only secret listing while forbidding values in descriptors, logs, or artifacts. Any retained production identity or unclassified generated-config field fails closed.

  Prove the staging command validates either exact Phase-2 proof checkout/manifest or exact Phase-3 candidate checkout/manifest supplied through `candidateRoot`, without switching, cleaning, or modifying either checkout. Add real repository-pinned Wrangler checks from the owned deploy root: `deploy --dry-run --config dist/candidary/wrangler.json --outdir <owned-path>` must resolve `main` and assets; `d1 migrations list DB --local --config dist/candidary/wrangler.json --persist-to <owned-path>` must discover the manifest-bound `migrations_dir`; and `d1 execute DB --local --config dist/candidary/wrangler.json --file <bootstrap.sql> --persist-to <owned-path>` must apply the complete generated `0001`–`0012` bootstrap including the real `0008`. Adapter-only command tests do not satisfy these path checks.

- [ ] **Step 2: Extract exact-candidate verification without weakening production deployment**

  Move only pure/read-only candidate identity and rebuilt-artifact verification into `release-candidate.ts`. `deploy-release.ts` must retain its existing `--sha`/`--manifest` interface, exact production config, command plan, required secrets, tag, clean-checkout recheck, and topology hash behavior. Its existing unit suite plus new parity tests must prove byte-for-byte equivalent production commands and failures.

- [ ] **Step 3: Implement an owned deploy root and complete staging topology overlay**

  Add these package commands:

  ```json
  "release:staging": "node --experimental-strip-types scripts/staging-release.ts",
  "release:migrate": "node --experimental-strip-types scripts/migrate-release.ts"
  ```

  For every `initialize`, `deploy`, or `migrate` invocation that calls Wrangler, resolve the target descriptor plus review/staging authorization records as regular nonsymlinked inputs, validate all three digests and cross-references, verify the supplied candidate root/SHA/manifest, and rebuild with repository-pinned dependencies. Materialize an owned, nonsymlinked snapshot at `output/staging/$candidateSha/$runId/deploy-root/` containing only manifest-hashed inputs in their verified relative layout: `dist/candidary/wrangler.json`, `dist/candidary/index.js` and its Worker files, `dist/client/`, and `migrations/`. Rehash every copied file before and after use. Run Wrangler with the deploy root as its working directory and the overlaid config still at `dist/candidary/wrangler.json`; never place a bare config elsewhere where `main: "index.js"`, assets `../client`, or `migrations_dir: "../../migrations"` would resolve differently. Delete the deploy root after the command and prove both source checkouts remained exact, clean, and unchanged.

  Apply a closed-schema overlay to every surface enumerated in Step 1. `workflow-conformance` sets `workers_dev = false`, disables preview URLs, routes, and crons, and uses isolated staging identities or explicitly disabled bindings for Email, both rate-limit namespaces, all three Workflows, D1, R2, Images, and assets; every var is a descriptor-bound staging value. `cutover` uses only its descriptor's user-serving staging identities and also disables crons unless that exact trigger set is separately named in the staging authorization. A read-only secret-name check must match the descriptor before upload. Reject unknown/missing fields, production reuse, schema features the overlay cannot safely disable, or any generated topology whose canonical digest differs from the descriptor.

  `workflow-conformance` deploys the exact Phase-3 bundle against isolated resources ending at `0012`. `cutover` can deploy either the exact Phase-2 proof or exact Phase-3 candidate, and its `migrate` mode first requires a remote ledger of exactly `0001`–`0012` before applying the sole pending `0013` through the atomic single-migration file import. Every upload carries the supplied source SHA in both `workers/tag` and `CF_VERSION_METADATA`; cutover deploy requires one version at 100% traffic.

- [ ] **Step 4: Implement guarded empty-D1 initialization through the Phase-2 boundary**

  Write RED tests proving `initialize --through 0012_event_cover_storage.sql` rejects a nonempty D1, an existing migration ledger or application table, a target not named by the staging authorization, a source other than the exact Phase-2 proof, a Phase-2 manifest whose ordered migration names/hashes do not end at `0012`, another `--through` value, or any pending/applied mismatch. The initializer must recognize the repository's recorded Wrangler 4.113.0 `migrations apply --remote` parser failure on `0008_event_rsvp.sql`; that command is forbidden for bootstrap, and upgrading Wrangler inside an execution run is forbidden.

  After a read-only inventory proves the remote D1 has no application object and no `d1_migrations` table, generate the exact bootstrap bundle above inside the owned deploy root and hash it. Resolve `$repositoryPinnedWrangler` only from that verified candidate's `node_modules/.bin`, require a regular nonsymlinked executable whose version equals `package.json` and lockfile (`4.113.0` for the Phase-2 proof), and never fall back to `PATH`, `npx`, or an install. Invoke only this command plan through the closed command adapter:

  ```powershell
  & $repositoryPinnedWrangler d1 execute DB --remote --config dist/candidary/wrangler.json --file $ownedBootstrapPath
  if ($LASTEXITCODE -ne 0) { throw 'Atomic Phase-2 D1 bootstrap failed.' }
  ```

  The file-import path is one atomic bootstrap boundary: it contains the exact source bytes plus only deterministic ledger DDL/inserts, and a command failure must return D1 to the verified empty pre-state. Unit tests assert the exact argv, bundle bytes/order/hash, real local execution through `0012`, and a fault-injected local rollback with neither application objects nor ledger rows left behind. Remote execution occurs only in Task 14, where a failed import triggers a read-only empty-state proof before any retry. If any application object or ledger row remains, stop, classify the run non-passing, destroy that disposable D1 through the named cleanup owner, verify absence, and require a new target descriptor and staging authorization; never synthesize a ledger entry, resume a prefix, or reuse a partially initialized database.

  On success, re-read ordered `0001`–`0012`, bind each name/hash to the exact Phase-2 manifest and bootstrap hash, run integrity/foreign-key checks, and require no `0013` before fixtures. This is the only staging empty-D1 bootstrap path.

- [ ] **Step 5: Implement the separately guarded production migration wrapper**

  Write RED tests for `scripts/migrate-release.ts` covering wrong/dirty candidate, altered manifest or sidecar, wrong account/config/D1, production-topology digest mismatch, missing or mismatched production authorization, missing/invalid Time Travel bookmark evidence, ledger not exactly `0001`–`0012`, any pending migration besides exact manifest-bound `0013`, non-repository Wrangler, altered atomic-bundle bytes, command failure, residual post-failure schema/ledger state, and post-apply ledger/hash/integrity mismatch. The wrapper must recheck the clean exact candidate immediately before invocation, build/hash the exact `0013` atomic bundle, and execute only the repository-pinned `d1 execute DB --remote --config dist/candidary/wrangler.json --file <owned-0013-bundle>` command against the canonical production config. It checks the exit code, requires ordered `0001`–`0013` plus the post-migration schema fingerprint on success, and on failure requires the ledger/schema to remain exactly at the verified `0012` pre-state before stopping. It never calls `migrations apply`, inserts a ledger row separately, retries production automatically, or invokes Time Travel restore. Unit tests use command adapters for remote calls and the pinned local Wrangler to prove real `0012` → `0013` success plus fault-injected rollback.

- [ ] **Step 6: Write RED staging-artifact tests and implement immutable evidence**

  Reject noncanonical JSON, checksum mismatch, another candidate/manifest/approved-main SHA, a mismatched review-authorization or staging-authorization digest, another target digest, a bootstrap/`0013` bundle hash not derived from the bound source migrations, incomplete ledger or trigger results, incomplete Images/Workflow/route/browser matrices, missing cleanup evidence, non-100% cutover traffic, unknown status, and any secret, raw object key, raw platform error, private image, or private URL. `finalize` writes `staging-conformance.json` and `staging-conformance.json.sha256` atomically and exclusively only after all required sanitized inputs are present; it never edits the candidate manifest. A quarantined or merely expired Workflow-conformance topology is non-passing: a `passed` artifact requires verified destruction and absence of every disposable resource and fixture. `verify` rehashes both authorization records, both source manifests, source migrations, derived bundle hashes, and the staging artifact, validates exact schemas/identities, and fails unless status is `passed` and destruction/cleanup is complete.

- [ ] **Step 7: Run and commit the release-tooling slice**

  ```powershell
  npm run test:unit -- tests/unit/release-candidate.test.ts tests/unit/deploy-release.test.ts tests/unit/migrate-release.test.ts tests/unit/staging-release-evidence.test.ts tests/unit/staging-release.test.ts
  npm run typecheck
  npm run lint
  git add -- scripts/release-candidate.ts scripts/deploy-release.ts scripts/migrate-release.ts scripts/staging-release-evidence.ts scripts/staging-release.ts package.json tests/unit/release-candidate.test.ts tests/unit/deploy-release.test.ts tests/unit/migrate-release.test.ts tests/unit/staging-release-evidence.test.ts tests/unit/staging-release.test.ts
  git diff --cached --check
  git commit -m "feat: guard phase 3 release operations"
  ```

  Expected: remote commands use adapter fakes, while local tests execute the exact repository-pinned/config-bound Wrangler dry-run, migration-list, complete/fault-injected bootstrap import, and successful/fault-injected atomic `0013` import plans defined above against owned local paths. This task performs no Cloudflare write and leaves a clean worktree.

---

### Task 13: Reconcile documentation and fix the immutable local candidate

**Files:**

- Modify: `CLAUDE.md`
- Modify: `docs/security.md`
- Modify: `docs/operations.md`
- Modify: `docs/deployment.md`
- Modify: `design/design-system.md`
- Modify: `design/fidelity-ledger.md`
- Modify: `design-qa.md`
- Modify if it enumerates the old contract: `README.md`
- Modify if it enumerates the old contract: `2026-07-21-candidary-core-design.md`

**Interfaces:**

- Produces: source-truth documentation for exactly 13 migrations, nested cover views, revisioned authorized delivery, single-owner operation reconciliation, route-disabled Workflow conformance, guarded staging topology/evidence, migration-first cutover, Manager/guest recovery, and the explicit landing/deployment/device boundaries.
- Does not produce: deployment, remote migration, staging conformance, or physical-device evidence.

- [ ] **Step 1: Use `rg` to enumerate every stale compatibility statement**

  ```powershell
  rg -n "coverObjectKey|coverPreparation|coverRevision|revisionless|compatibility reader|phase 1|phase 2|0013|Guest preview" README.md CLAUDE.md docs design 2026-07-21-candidary-core-design.md
  ```

  Classify historical plan/spec text separately; do not rewrite append-only design history to pretend phases never existed.

- [ ] **Step 2: Update security and operations truth**

  Document per-request authorization/current-revision checks, private/no-store event-bound responses, temporary preset redirects, no master fallback, sanitized projection/delivery observations, receipt recovery, and the exact no-key response boundary.

- [ ] **Step 3: Write the Phase 3 staging/production runbook in `docs/deployment.md`**

  Separate local candidate, route-disabled Workflow-conformance staging, migration-first cutover staging, staging artifact finalization, exact-SHA landing/push, production proof recheck, guarded remote `0013`, production deploy, rollback, runtime checks, and physical evidence. Document `npm run release:staging` modes, `npm run release:migrate`, the owned deploy-root layout, the atomic empty-D1 bootstrap and atomic `0013` import that bypass the pinned Wrangler 4.113.0 compound-SQL `migrations apply` defect, and exact input/output schemas without including a real account ID, secret, object key, or private image. State that remote migration is deliberately first because `0013` is tested against the Phase-2 writer; the migration uses only `npm run release:migrate`, while Worker deployment retains only `npm run deploy`.

- [ ] **Step 4: Update design-system and QA evidence**

  Replace the separate-preview scope with live-canvas layering, global Manager semantics, responsive hero/source rules, exact inspected screenshots, axe results, and deterministic contrast evidence. Label Playwright/fake Images evidence honestly.

- [ ] **Step 5: Run all focused static and generated-asset checks before the documentation commit**

  ```powershell
  npm run verify:cover-presets
  npm run verify:bindings
  npm run verify:fresh-d1
  npm run test:unit -- tests/unit/release-candidate.test.ts tests/unit/deploy-release.test.ts tests/unit/migrate-release.test.ts tests/unit/staging-release-evidence.test.ts tests/unit/staging-release.test.ts
  npm run typecheck
  npm run typecheck:e2e
  npm run lint
  git diff --check
  ```

- [ ] **Step 6: Commit the documentation allowlist**

  ```powershell
  git add -- CLAUDE.md docs/security.md docs/operations.md docs/deployment.md design/design-system.md design/fidelity-ledger.md design-qa.md
  ```

  Add `README.md` and/or `2026-07-21-candidary-core-design.md` only if Step 1 proved they contained active stale truth. Inspect the staged diff, then:

  ```powershell
  git diff --cached --check
  git commit -m "docs: define the phase 3 cover contract"
  ```

- [ ] **Step 7: Run the complete local verification on the now-clean head**

  ```powershell
  npm run verify:cover-presets
  npm run verify:bindings
  npm run verify:fresh-d1
  npm run typecheck
  npm run typecheck:e2e
  npm run lint
  npm test
  npm run test:e2e
  git status --short --branch
  ```

  Expected: all commands exit 0, exactly 13 migrations, and a clean phase-3 worktree.

- [ ] **Step 8: Fix the immutable head and run the aggregate release gate**

  ```powershell
  $candidateSha = (git rev-parse HEAD).Trim()
  npm run verify:release -- --sha $candidateSha --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
  ```

  Inspect the candidate manifest's SHA, approved base, approved integration-head ancestry, migration count/hash, artifact hashes, test gates, and explicit `not_run` `remoteMigration`, `deployment`, `runtimeCertification`, and `physicalDevices` claims. The candidate manifest has no staging claim; Task 14 writes the separate checksummed artifact. Any tracked source, configuration, test, fixture, snapshot, generated asset, or documentation edit after this command creates a new head and requires the complete local gate and independent review again. Staging/landing evidence is written only beneath ignored `output/`; it never edits or amends this manifest.

- [ ] **Step 9: Stop for independent source review**

  Record the independently accepted candidate SHA, candidate-manifest path/digest, and approved `main` SHA in a separate ignored review-authorization record. Do not merge, push, apply `0013` remotely, deploy, operate Workflows, or claim staging/device support without the separately named authorization for that action.

---

### Task 14: Separately authorized Phase-3 staging migration and deployed conformance

**Not part of local implementation authorization. The staging instruction must name two disposable `StagingTargetDescriptorV1` files and cleanup owners: (1) a route-disabled `workflow-conformance` topology with isolated D1-through-`0012`; and (2) a user-serving `cutover` topology initially running the exact Phase-2 proof SHA at 100% with a separate clean D1-through-`0012`. Each descriptor must account for every Task-12 Worker, route/preview/cron, R2, Images, assets, Email, rate-limit, Workflow, var, secret-name, observability, and placement field. The instruction must also name both exact source checkouts/manifests, the Phase-3 review-authorization digest, fixtures, expiration, and evidence root.**

- [ ] **Step 1: Verify both source candidates, review authority, and target descriptors**

  Run the Task-12 verifier against the exact clean Phase-2 and Phase-3 roots, candidate manifests/sidecars, full SHAs, approved-base/integration ancestry, authorization digest, and both topology descriptors. Rebuild each source artifact and require its source topology hash before any staging overlay. Stop if `origin/main` moved from the approved Task-1 SHA; staging does not choose a new integration head.

- [ ] **Step 2: Prepare the route-disabled Workflow-conformance topology through exactly `0012`**

  Create the fresh isolated D1, prove it has no migration ledger or application tables, then run the exact Task-12 `initialize` command from the clean Phase-2 proof root/manifest with `--through 0012_event_cover_storage.sql`. Confirm its sole write is the validated repository-pinned Wrangler `d1 execute DB --remote --config dist/candidary/wrangler.json --file <owned-bootstrap>` plan, never `migrations apply --remote`. On failure, permit a retry only after the wrapper reproves the same D1 is empty; any residue forces verified destruction plus a new descriptor/authorization. Require the manifest-bound ordered `0001`–`0012` ledger/hashes, bootstrap hash, integrity/foreign keys, and no `0013` before installing only the sanctioned disposable legacy/backfill fixtures. Deploy the exact Phase-3 candidate with `npm run release:staging -- deploy` in `workflow-conformance` mode. Require no route, preview URL, `workers_dev`, or cron; isolated/disabled identities for every enumerated production-capable surface; matching tag/metadata SHA; and a topology digest equal to the descriptor.

- [ ] **Step 3: Prove the modified Phase-3 `CoverBackfillWorkflow` against the real platform**

  Prove creation, initial confirmation, automatic step retry, retained-ID replay, deterministic per-profile replay, conditional-object adoption, early and final revision conflict, conservative `status | missing | unknown` reconciliation, same-instance restart, termination, purge fencing, and zero post-fence R2 writes. Finish with a complete terminal graph, four present zero counts, and no legacy/incomplete rows. Phase-2 staging evidence cannot substitute because Task 3 changed this finalizer.

- [ ] **Step 4: Destroy the Workflow-conformance topology and verify absence**

  The cleanup owner destroys the disposable D1, R2, Worker/version, Images-facing fixture resources, Email/rate-limit identities, all three Workflow identities/instances, assets, and remaining fixtures, then verifies their absence. No job, object, identity, or evidence input may cross into cutover staging. A failed deletion may be quarantined for incident containment, but that run is `incomplete`/non-passing and stops before cutover deployment or artifact finalization; it can never satisfy Task 14. Record only sanitized destruction results for final evidence.

- [ ] **Step 5: Deploy and prove the exact Phase-2 proof on cutover staging**

  Prove the fresh cutover D1 has no migration ledger or application tables, run the same single-file atomic Task-12 `initialize` command from the clean Phase-2 proof root/manifest through `0012_event_cover_storage.sql`, and apply the same empty-only retry/destruction rule before verifying the ordered ledger/hashes and bootstrap hash. Then use `npm run release:staging -- deploy` with the Phase-2 root/SHA/manifest and cutover descriptor. Require exactly one 100% version with matching `workers/tag` and `CF_VERSION_METADATA`, every descriptor-bound/disabled surface, D1 exactly `0001`–`0012`, and all four canonical predicates present and zero.

- [ ] **Step 6: Apply only pending `0013` to cutover staging**

  Record the pre-migration ledger and D1 recovery bookmark, then use `npm run release:staging -- migrate`. Require its only write to be the Task-12 hashed atomic `0013` bundle through repository-pinned `d1 execute --remote --file`, never `migrations apply` or a separate ledger insert. Re-read exactly `0001`–`0013`, the bundle/migration hash, exact nine-trigger set, integrity/foreign keys, and all four zero counts. A failed import must leave the exact `0012` ledger/schema pre-state; any failure or mismatch stops before Phase 3 deployment.

- [ ] **Step 7: Prove the still-deployed Phase-2 Worker under `0013`**

  Use separate authorized disposable events so post-deploy checks retain one event. Prove the authenticated compatibility reader and one upload/removal publication. On the purge fixture, replay the exact deployed hard-purge path through fenced/settled Workflows, verified R2 absence, durable `phase = 'relational'`, canonical none/null/null pointer clearing, then active object → set → master relational deletion. Re-read integrity, triggers, zero counts, and fixture R2 inventory. Any failure preserves evidence and stops; do not deploy Phase 3 or weaken/drop triggers.

- [ ] **Step 8: Deploy the exact Phase-3 candidate to cutover staging**

  Use `npm run release:staging -- deploy` with the reviewed Phase-3 root/SHA/manifest and cutover descriptor. Require exactly one 100% version whose tag, metadata, bindings, and topology digest match the reviewed candidate and descriptor.

- [ ] **Step 9: Run the full §15.5 real Images matrix**

  Cover JPEG, opaque/transparent PNG, WebP, iPhone HEIC, rejected HEIF/sequence, exact upload limits, every master/preview/output quality rung, complete/partial 2x, orientation, metadata/GPS removal, crops, all five effects, matte parity, MIME, dimensions, checksums, no upscaling, and every byte ceiling. Record the approved lowest quality rung.

- [ ] **Step 10: Prove `CoverRenderWorkflow` and Phase-3 purge behavior**

  Prove creation, initial confirmation, automatic retry, retained-ID replay, deterministic per-profile replay, conditional-object adoption, early/final conflicts, status polling/reconciliation, same-instance restart, termination, event purge, platform limits, and zero delivery-time Images calls.

- [ ] **Step 11: Prove deployed readers and browser journeys**

  Prove nested projections, every revisioned guest/Manager slot, preset redirects/static headers, stale revision rejection, missing WebP/JPEG recovery, no private/master response, and desktop/mobile Cover Studio and guest journeys including interruption, same-operation retry, access recovery, one polling owner, and cover-only refresh.

- [ ] **Step 12: Finalize and independently verify immutable staging evidence**

  Capture the final sanitized cutover evidence, then clean its events, objects, and Workflow instances; destroy the cutover Worker/version, D1, R2, Images-facing fixture resources, Email/rate-limit identities, all three Workflow identities, and assets exactly as authorized. Independently verify absence of every resource from both staging descriptors. Run `npm run release:staging -- finalize`, then independently run the exact Task-12 `verify` command with `staging-conformance.json`, its sidecar, both source manifests, and both authorization records. The artifact must bind both source manifests, approved main, the review-authorization digest, the staging-authorization digest, both target digests, ledgers, versions, all matrices, timestamps, and verified destruction/cleanup without a secret, object key, raw platform error, private URL, or private image. Quarantine or incomplete destruction is a non-passing artifact and stops landing.

- [ ] **Step 13: Invalidate on any candidate-tree change**

  Any tracked source, configuration, test, fixture, snapshot, generated asset, or documentation change invalidates the candidate and staging artifact. Create a new candidate, rerun Task 13 and independent review, recreate both staging databases/topologies, redeploy, and repeat this entire task. An ignored evidence-file write alone does not alter the candidate.

Staging success is exact deployed-platform evidence. It does not authorize landing/push, production migration/deployment, or physical-device claims.

---

### Task 15: Separately authorized exact-SHA landing

**Requires a passed, independently reviewed Task-14 artifact and an explicit instruction naming `origin`, `refs/heads/main`, the expected old remote-main SHA, the exact candidate SHA, and permission to push. It is not staging or production deployment and never changes the dirty main checkout.**

- [ ] **Step 1: Verify the candidate, staging artifact, and expected remote head**

  Independently run the candidate-manifest and staging-artifact verifiers from the exact clean Phase-3 worktree. Load `$candidateSha`, `$candidateManifest`, `$stagingArtifact`, and `$approvedMainSha` only from the authorization/artifacts; fetch `origin` and require `origin/main` still equals `$approvedMainSha`.

- [ ] **Step 2: Prove fast-forward landing preserves the reviewed SHA**

  ```powershell
  git fetch --prune origin
  if ($LASTEXITCODE -ne 0) { throw 'Could not refresh origin.' }
  $remoteMainSha = (git rev-parse origin/main).Trim()
  if ($remoteMainSha -ne $approvedMainSha) { throw 'Remote main advanced; do not land this candidate.' }
  git merge-base --is-ancestor $approvedMainSha $candidateSha
  if ($LASTEXITCODE -ne 0) { throw 'Candidate does not descend from the approved main SHA.' }
  if ((git rev-parse HEAD).Trim() -ne $candidateSha -or (git status --porcelain)) { throw 'Candidate checkout is not the exact clean reviewed SHA.' }
  ```

- [ ] **Step 3: Push only the exact reviewed commit, then prove the remote ref**

  ```powershell
  git push origin "${candidateSha}:refs/heads/main"
  if ($LASTEXITCODE -ne 0) { throw 'Exact-SHA landing failed.' }
  git fetch origin main
  if ((git rev-parse origin/main).Trim() -ne $candidateSha) { throw 'origin/main is not the reviewed candidate SHA.' }
  ```

  Never force-push. If branch protection requires a SHA-changing merge commit, or if `main` advanced, hard stop: the pinned integration authority is exhausted. Obtain a new immutable Phase-3 integration authorization naming the prior candidate, the new exact `origin/main` SHA, ancestry policy, authorized action, authorizer, and timestamp. In an isolated Phase-3 worktree, rerun the Task-1 fetch, exact-head/cleanliness assertions, ancestry and merge-preview checks, explicit conflict-resolution allowlist, noninteractive integration, and complete verification. Then create a fresh Task-13 candidate/manifest, obtain independent review, and repeat all Task-14 staging evidence. Never silently reconcile a later main head or reuse the old authorization, manifest, review, or staging artifact.

---

### Task 16: Separately authorized production migration-first cutover

**Not part of candidate, staging, or landing authorization. Execute only after a new production instruction names the exact Phase-2 proof, landed Phase-3 candidate/manifest, verified staging artifact path/digest, production account/resources, no-deploy-window owner, rollback owner, and two disposable canary events: one retained for post-deploy checks and one dedicated to the Phase-2 hard-purge canary.**

- [ ] **Step 1: Verify landing and start the owned no-deploy window**

  Independently verify the candidate manifest and staging artifact, fetch `origin`, require `origin/main = $candidateSha`, and then re-read the production account, 100% Phase-2 Worker version/tag, bindings, D1 ID, migration ledger, Phase-2 verification run, and all four zero counts.
- [ ] **Step 2: Record a D1 Time Travel bookmark/restore point and the pre-cutover deployment/version evidence**
- [ ] **Step 3: Apply only `0013_event_cover_invariants.sql` through the guarded production wrapper; stop on any error**

  Load `$candidateSha`, `$candidateManifest`, `$productionAuthorization`, and `$timeTravelBookmarkArtifact` only from the verified production instruction/artifacts, then run:

  ```powershell
  npm run release:migrate -- --sha $candidateSha --manifest $candidateManifest --authorization $productionAuthorization --bookmark $timeTravelBookmarkArtifact
  if ($LASTEXITCODE -ne 0) { throw 'Guarded production migration failed; do not deploy Phase 3.' }
  ```

  The Task-12 wrapper must re-prove the exact clean landed candidate, canonical production account/config/D1/topology, authorization and bookmark digests, ledger ending exactly at `0012`, and exact `0013` as the sole pending manifest-bound migration immediately before invoking the repository-pinned Wrangler. It must hash and run only the atomic `0013` `d1 execute --remote --file` plan, check the Wrangler exit code, and refuse `migrations apply`, a separate ledger insert, or any other command, configuration, database, or migration set. Failure must leave and re-prove the exact `0012` pre-state before control returns to the rollback owner.
- [ ] **Step 4: Re-read the migration ledger, exact nine-trigger phase-3 set, integrity/foreign keys, and four zero counts**
- [ ] **Step 5: While Phase 2 remains at 100%, verify its reader, publication, removal, and hard purge under `0013`**

  Keep the primary canary for post-deploy checks. Use the second event to repeat the fenced/settled/R2-verified/relational hard purge proven in Task 14. If either compatibility path fails, do not deploy Phase 3: keep the exact Phase-2 Worker at 100%, stop cutover actions, preserve the Time Travel bookmark plus D1/R2/runtime evidence, and hand control to the named rollback owner. Do not drop triggers, edit the migration ledger, or automatically restore the database; Time Travel could discard unrelated post-bookmark writes and requires a separately reviewed restore decision.
- [ ] **Step 6: Load `$candidateSha` and `$candidateManifest` from the reviewed staging artifact, then deploy only that exact pair with `npm run deploy -- --sha $candidateSha --manifest $candidateManifest`**
- [ ] **Step 7: Require exactly one 100% Worker version whose `workers/tag` and `CF_VERSION_METADATA` match the reviewed SHA and whose bindings match the approved topology**
- [ ] **Step 8: Verify public health, protected negative requests, nested manager/guest projections, current/stale revision routes, preset redirect/static immutable headers, upload no-store delivery, and cover-only event refresh on the disposable canary**
- [ ] **Step 9: Re-run D1 integrity, four-count proof, and canary R2 inventory; assert no master/legacy/private key was publicly returned and no delivery request invoked Images**
- [ ] **Step 10: Close the no-deploy window only after before/after version evidence, migration evidence, runtime requests, and D1/R2 safety all correlate to the same SHA**

Rollback rules:

- If `0013` fails, do not deploy; the phase-2 Worker remains current and the failed migration must be diagnosed from a restored/local copy before retry.
- If `0013` succeeds but the Phase-2 reader/publication/removal/purge canary fails, keep Phase 2 at 100%, freeze the cutover, preserve evidence, and require the rollback owner to choose a reviewed forward repair or restore after accounting for every post-bookmark write. Do not proceed to Phase 3 merely because the migration ledger says `0013`.
- If phase-3 deployment fails after `0013`, keep or restore the exact phase-2 Worker; it is explicitly tested as trigger-compatible. Do **not** drop triggers or restore a pre-migration D1 merely to make the deployment command green.
- If new runtime reads fail, stop traffic changes, preserve D1/R2 evidence, and restore the exact phase-2 Worker while diagnosing. No lazy fallback, legacy endpoint, or master response may be enabled.

This task proves production cutover, not physical-device support or wedding-readiness certification.

---

### Task 17: Separately authorized physical-device acceptance

**Requires the exact deployed Phase-3 SHA from Task 16 and access to the named devices. Automated emulation does not satisfy it.**

- [ ] **Step 1: Record deployed SHA/version, event, date, network, device model, OS, and browser for a small iPhone Safari and current iPhone Safari**
- [ ] **Step 2: On iPhone portrait/landscape, choose a real HEIC from Photos; verify automatic crop, ranges/drag, native pinch/page zoom, style, interruption/retry, Done, and final RSVP/photo hero**
- [ ] **Step 3: Repeat the complete journey on current Android Chrome in portrait/landscape with its native photo picker**
- [ ] **Step 4: Run VoiceOver on iPhone through source, compose ranges/reset, style, Done/progress, errors, close/reopen, and guest hero**
- [ ] **Step 5: Run TalkBack on Android through the same semantics and recovery path**
- [ ] **Step 6: Record sanitized evidence references and failures; do not store private event links or photos in the repository**
- [ ] **Step 7: Mark physical support passed only when every required device/AT row is present; otherwise keep the claim explicitly incomplete**

---

## Review boundaries

| Unit | Tasks | What it establishes |
| --- | --- | --- |
| Integration | 1 | Current security/main and accumulated cover work coexist on one clean line |
| Publication correctness | 2–3 | Semantic/upload publications terminate atomically and schedule displaced normalized sets/masters without partial pointer or retention graphs |
| Database invariants | 4 | `0013` fails closed, remains exact Phase-2 writer/hard-purge compatible, and permits only progress-proven ordered purge deletion |
| Public contract | 5–6 | Nested safe views and current-revision slot readers replace the compatibility shape |
| Client orchestration | 7–8 | Draft/session ownership, Retry-After-aware single polling, edit-draft entry, real previews, and repeatable Back behavior work without a second durable owner |
| Product surfaces | 9–10 | One live Manager canvas and one responsive guest cover consume the new contract with guarded failure/access recovery |
| Local evidence and staging tooling | 11–13 | Real-browser, accessibility, visual, static, unit, Worker, migration, guarded staging tooling, and exact-head release evidence |
| Deployed platform | 14 | The exact candidate passes route-disabled Phase-3 Backfill Workflow proof plus migration-first Images/Render/D1/R2/assets/browser cutover staging |
| Exact-SHA landing | 15 | The staging-proven SHA becomes `origin/main` by separately authorized fast-forward without changing the reviewed commit |
| Production cutover | 16 | Migration-first rollback-safe switch to the strict responsive contract, including the post-`0013` Phase-2 canary branch |
| Physical devices | 17 | Separate iPhone/Android/VoiceOver/TalkBack evidence |

## What this plan deliberately does not do

- Start before the canonical phase-2 production proof or treat the current local tip as equivalent evidence.
- Modify `0012`, preserve a valid legacy/null-set reader after Phase 3, or add a second migration beyond `0013`.
- Add a feature flag, dual event shape, revisionless compatibility endpoint, arbitrary width/quality route, public upload object, lazy transform, or master fallback.
- Put Cover Studio in event creation, add intensity controls, add more presets/effects/themes, or change approved product copy/flow outside the live canvas and cover surfaces.
- Let the browser author crop dimensions, effect recipes, object keys, asset versions, or density eligibility.
- Make Manager controls inherit event theme semantics or make inert canvas action samples interactive.
- Run separate Studio and Manager status pollers, discard an accepted/ambiguous operation on close or auth loss, or ignore a longer valid server `Retry-After`.
- Reuse production resource identities in staging, expose the route-disabled Workflow-conformance Worker publicly, or write staging claims into the immutable candidate manifest.
- Treat local fake Images/Workflows, Playwright device emulation, a merge, a remote migration, or a deployment as evidence for another gate.
- Push, merge to `main`, deploy, mutate remote D1/R2, operate a remote Workflow, or certify device support without the separately named authorization for that action.

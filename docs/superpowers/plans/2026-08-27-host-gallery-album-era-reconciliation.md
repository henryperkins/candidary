# Host Gallery Album Era Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use strict focused RED, minimal implementation, focused GREEN, then a fresh implementer handoff and independent review for every task. Do not commit this task or checkpoint: all five Slice 5 plans receive exactly one final commit only after every task and final Slice review gate passes.

**Goal:** Stop telling a host a false "before Albums" story about picks they made minutes ago, and make Album capacity honest about the retained slots a timely Restore depends on.

**Architecture:** Provenance is a durable per-row fact (`media.album_pick_version`) and an event-owned counter (`events.album_pick_generation`), both installed by migration `0021` in the first Slice 5 checkpoint. The Worker never increments the generation; the migration's triggers do, so a predecessor Worker's writes are counted exactly once. `AlbumView` gains a computed `reconciliation` category and the generation, never the raw version fields. `POST /album/start` gains an expectation triple so a same-count substitution conflicts as loudly as a category change, and a successful Start advances the album revision so the editor a cohost was already holding cannot write over it. The existing `AlbumRepository.start` guarded transaction, `ALBUM_MAX_ENTRIES`, the Slice 1 retained-slot markers, the revision guard, and the autosave queue are reuse boundaries.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, D1, React 19, Vitest with `vitest-pool-workers` and Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- Preserve unrelated and untracked files plus all authored/custom content. Keep Slice 6 findings C-34, C-38, and C-62 out of scope.
- Every task is independently testable and receives a fresh implementer handoff plus an independent task review. Record focused RED/GREEN evidence; resolve every P1/P2 before advancing.
- Do not run repository-wide verification, full builds, full lint/typecheck, full E2E, `npm test`, or `ci:migrations`. Use only named test files/spec filters, changed-file lint where applicable, the matrix parser, and `git diff --check`.
- Do not make task-level or checkpoint commits. The release owner creates exactly one final Slice 5 commit only after all five plans, focused gates, and final independent Slice review are complete.
- **Depends on** `2026-08-27-host-gallery-manager-upload-authority.md`. Migration `0021` has been drafted and reviewed by that checkpoint but remains part of the one uncommitted Slice 5 change set until the single final commit/deployment. This checkpoint creates **no** migration. If its Album-era review or focused RED exposes a defect, correct `0021` in place and repeat the migration task plus every affected task review before proceeding; do not create `0022` for an uncommitted migration.
- Provenance may never be inferred from `event_albums.created_at`, `media.created_at`, `favorited_at` ordering, or any clock comparison. Every reconciliation test uses identical timestamps so no assertion can pass by ordering.
- `AlbumView` exposes `pickGeneration` and `reconciliation` only. `album_pick_version` is a repository-internal fact and must not appear in any response.
- Every "pick" count in reconciliation — the category decision, `pickCount`, `historicalPickCount`, and the cap comparison — includes **active and retained-trash** picked rows, including expired cleanup-pending rows, even though only active photos render.
- The legacy `{ start }` body stays accepted for exactly one compatibility release with its existing manual semantics. It never activates the automatic path. Add a contract test that marks it for removal; do not maintain two start implementations.
- New clients always send both `expectedReconciliation` and `expectedPickGeneration`.
- `Start empty` remains unconditional. The 500-entry check applies only to `Start from picks`. C-49's post-review repair already exists — add a boundary regression, do not reimplement it.
- Retained slots count toward `ALBUM_MAX_ENTRIES`. A timely Restore is unconditional because Slice 1 reserved both event and Album capacity; no code path may make Restore conditional on free space.
- Public and Preview projections continue to omit retained entries. Do not change what a link holder sees.
- The existing revision guard applies unchanged to every new Start and reset path.
- **Start-advances-revision ruling.** Matching `expectedRevision` is only half of a revision guard; the other half is that a successful write moves it. At `153d05f` `AlbumRepository.start` writes `entries`, `saved_at`, and `updated_at` and never touches `revision` — the only two `revision = revision + 1` sites in `worker/db/album.ts` are on the save and metadata paths. Adding the expectation without the increment leaves the real hazard open: a cohost who read the album before the Start still holds a revision the server accepts afterwards, so their `PUT /album` — composed against the pre-Start entries — succeeds and silently replaces everything the Start just materialized. **Every successful new-client Start increments `revision` in the same guarded statement that sets `saved_at`**, on both `from-picks` and `empty`. A Start that conflicts must not increment. The legacy branch is unchanged, which is one more reason the compatibility window is one release and not more.
- Every behavior change follows RED → minimal GREEN → scoped refactor.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-album-era-reconciliation/`; the task review checkpoint records the fresh implementer and independent reviewer outcome without committing.

## Checkpoint boundary

This checkpoint owns C-17 and the C-49 boundary regression. It does **not** own the Album title default (C-53, a later checkpoint), the Album badge or Minus icon regressions, registration, rotation, or the safety ladder. Do not implement them opportunistically.

---

### Task 1: The reconciliation projection

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `worker/db/album.ts`
- Modify: `tests/worker/album-api.test.ts`

**Interfaces:**
- Produces:

```ts
export type AlbumReconciliation =
  | { kind: 'initialize' }
  | { kind: 'historical'; historicalPickCount: number }
  | { kind: 'over-capacity'; pickCount: number; historicalPickCount: number }
  | null;

export interface AlbumView {
  /** Event-owned. Increments on every actual Album-eligibility change. */
  pickGeneration: number;
  reconciliation: AlbumReconciliation;
  // …existing Album fields
}
```

`null` means the Album is saved, or there are no picks at all.

Category rules, evaluated on the **complete retained picked cohort**:

| Condition | `reconciliation` |
| --- | --- |
| Album saved | `null` |
| Zero picks | `null` |
| More than `ALBUM_MAX_ENTRIES` picks | `over-capacity` — always, including an all-version-`1` cohort whose `historicalPickCount` is `0` |
| Any unversioned pick, within cap | `historical` |
| Every pick version `1`, within cap | `initialize` |

- [ ] **Step 1: Write the failing projection table**

In `tests/worker/album-api.test.ts`, build fixtures with identical timestamps and assert the exact `reconciliation` object and `pickGeneration` for: saved album; zero picks; one unversioned pick; all-version-`1` under the cap; mixed under the cap; 500 picks all version `1`; 501 picks all version `1` (`over-capacity` with `historicalPickCount: 0`); 501 mixed; a cohort whose count only reaches the cap once retained-trash picks are included; and a cohort containing an expired cleanup-pending retained pick.

Assert no response anywhere contains `album_pick_version` or `albumPickVersion`.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts -t 'reconciliation'
```

Expected: FAIL — `AlbumView` has neither field.

- [ ] **Step 3: Implement the projection**

Compute the category in one repository read that counts active and retained-trash picked rows together. Do not add a second query per category.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts
```

- [ ] **Step 5: Task review checkpoint**

Record projection RED/GREEN and no-raw-provenance evidence. Obtain fresh-implementer and independent review; resolve P1/P2 before Task 2. Do not stage or commit.

---

### Task 2: An expectation-guarded `/album/start`

**Files:**
- Modify: `worker/routes/manage.ts`
- Modify: `worker/db/album.ts`
- Modify: `tests/worker/album-api.test.ts`

**Interfaces:**
- Request schema becomes a discriminated accept:

```ts
// New clients
{ start: 'from-picks' | 'empty',
  expectedReconciliation: 'initialize' | 'historical' | 'over-capacity',
  expectedPickGeneration: number,
  expectedRevision: number }

// Legacy, one compatibility release only
{ start: 'from-picks' | 'empty' }
```

`expectedRevision` is a third new field, not an existing one. At `153d05f` the start path carries **no** revision: `albumStartSchema` is `z.object({ start }).strict()`, the route passes only `(eventId, choice, now)`, and `AlbumRepository.start` has no revision parameter. Only `PUT /album` guards a revision, through `albumSaveSchema.revision` and `AlbumRepository.replace`. Start must therefore acquire the guard rather than inherit it, and `AlbumView.revision` — which the editor already holds — is what the client sends.

The three expectations answer three different questions and none substitutes for another: `expectedPickGeneration` catches a changed *pick cohort*, `expectedReconciliation` catches a changed *category*, and `expectedRevision` catches a concurrent *album write* — a cohost saving entries, metadata, or order between the read and the start. All three mismatches produce the same canonical conflict.

`expectedRevision` is also the field a successful Start must *advance*, per the start-advances-revision ruling. Reading it and not writing it protects the Start from a concurrent save but leaves the save unprotected from the Start, which is the direction that actually loses a host's work: the entries a Start materializes are the ones an unaware cohost's in-flight `PUT` would overwrite. The increment belongs in the same statement as `saved_at = ?`, so a conflicting Start cannot advance it and a succeeding one cannot fail to.

The first and decisive mutation is one Album-row expectation/revision CAS. It matches `expectedRevision` and `expectedPickGeneration`, derives the expected category/count/cap, rechecks provenance, saved state, and the complete retained picked cohort, sets the selected entries/saved state, and increments revision in that one statement. `from-picks` ends there: it remains one guarded update. `empty` performs one immediately following and final mutation that clears every active/retained pick with `AND changes() = 1`. No mutation follows or depends on that variably sized clear. Every diagnostic after the mutation block is read-only.

- [ ] **Step 1: Write the failing conflict table**

- a matching new-client request succeeds and marks the Album saved;
- a stale `expectedPickGeneration` returns the canonical conflict and writes nothing;
- a **same-count substitution** — one pick removed and another added between read and write, leaving the count identical — conflicts;
- a restored historical pick between read and write conflicts;
- a concurrent first save conflicts for the loser and leaves exactly one saved Album;
- two cohosts starting concurrently produce exactly one winner;
- an `expectedReconciliation` that no longer matches the server's category conflicts;
- `start: 'empty'` succeeds at 501 picks and clears every active **and** retained-trash pick (C-49 boundary regression);
- `start: 'from-picks'` at 501 picks is refused;
- `start: 'from-picks'` materializes both active and retained-trash picked IDs in timeline order, so a retained slot keeps its position;
- a legacy `{ start }` body still works with the existing manual semantics and never auto-starts;
- a stale `expectedRevision` — a concurrent `PUT /album` landed between the read and the start — returns the canonical conflict and writes nothing, on both `from-picks` and `empty`;
- **a successful Start advances the revision.** For each of `from-picks` and `empty`: read the album, run a successful new-client Start, and assert the returned `AlbumView.revision` is strictly greater than the one sent. Then replay a `PUT /album` carrying the **pre-Start** revision and assert it returns the canonical conflict and changes no entry — this is the row that fails when the increment is missing, and asserting only the returned revision is not enough, because a projection can report a number no guard actually enforces;
- a Start that conflicts on any of the three expectations leaves `revision` exactly where it was, so a refused attempt cannot invalidate a cohost's live editor;
- stale category, generation, or revision on either start choice leaves favorites, entries, saved state, and revision byte-for-byte unchanged; assert all four facts, not only the HTTP conflict;
- the increment is exactly one per successful Start: a Start followed by an ordinary save advances the revision twice in total, not three times;
- a legacy `{ start }` body does not advance the revision, matching today's behavior, and the contract test that names the branch for removal says so;
- a legacy `{ start }` body, which carries no revision, keeps exactly today's unguarded behavior. Say so in the contract test that marks the branch for removal, so the compatibility window is not mistaken for a hole in the new guard.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts -t 'expectedPickGeneration'
```

Expected: FAIL — `albumStartSchema` is `.strict()` on `{ start }` alone.

- [ ] **Step 3: Implement the guard**

Extend `albumStartSchema` to accept both shapes — a discriminated accept, not an optional-field widening, so a new client that omits one expectation is refused rather than silently taking the legacy branch. Thread all three expectations into `AlbumRepository.start`, whose signature becomes `(eventId, choice, expectations | null, now)`; `null` is the legacy branch.

Implement the expectation-bearing branch in the exact mutation order above. For `from-picks`, the one-row CAS computes/materializes the retained cohort and increments revision atomically; there is no dependent mutation. For `empty`, the one-row CAS saves the empty Album and increments revision, then the immediately following final statement clears every active/retained favorite with `AND changes() = 1`. Check `results[0].meta.changes === 1`; after statement 2 perform only SELECT diagnostics/classification. Do not attach another mutation to statement 2's `changes()`, because clearing zero picks is a legitimate successful Start empty. Add the contract test that names the legacy branch for removal after one release.

The client is not updated here. `startAlbum` in `src/features/gallery/album-api.ts` still sends `{ start }` alone until Task 4, and the legacy branch is what keeps an old browser tab/client compatible when the server and new client ship together in the Slice's single final deployment. This is an old-client compatibility window, not a two-commit sequence, so do not add a required field to the legacy shape to close it early.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts tests/worker/manage-api.test.ts
```

- [ ] **Step 5: Task review checkpoint**

Record CAS ordering, stale-state non-mutation, and legacy compatibility evidence. A fresh implementer and independent reviewer must confirm no mutation follows Start empty's guarded clear. Resolve P1/P2; do not stage or commit.

---

### Task 3: Capacity that counts retained slots

**Files:**
- Modify only after a focused RED proves a gap: `worker/db/album.ts`
- Modify only after a focused RED proves a gap: `worker/db/media.ts`
- Modify only after an actual Reset-path RED proves the client lacks retained ordering: `shared/contracts.ts`
- Modify only after that RED proves the gap: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `tests/worker/album-api.test.ts`
- Modify: `tests/worker/media-recovery-api.test.ts`
- Modify: `tests/worker/export-api.test.ts`
- Modify only for the actual Reset-path regression: `tests/ui/album-workspace.test.tsx`

**Interfaces:**
- No new exported contract. Album capacity comparisons switch from "currently visible photos" to internal entries: saved section entries, active photo entries, and retained trashed-photo entries all consume a slot.
- Unsaved reconciliation and the new-pick guard count active plus retained-trash picked rows.
- Reset uses timeline order across active and retained-trash picks. Only `Start empty` clears them.
- The Manager-only retained marker may carry its ordering-only `timelineAt` fact so Reset can interleave it with live photos. Public and Preview still omit the marker, and it must not gain image, caption, guest, filename, or Album-era provenance fields.
- This task is regression-first: the principal guards already exist. Inventory current named coverage before adding tests and do not edit production for a row that already passes.

- [ ] **Step 1: Inventory current focused coverage**

Run only the existing named files and record which of the required rows already exists and passes:

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts tests/worker/media-recovery-api.test.ts tests/worker/export-api.test.ts -t "(album capacity|retained slot|restore|cover|reset|cleanup|export hold)"
```

Map each existing test name to cap edge, repeated trash/replace/restore, export hold, reset, cover, and cleanup. Do not count a nearby happy path as the named edge.

- [ ] **Step 2: Add only missing capacity and retention regressions**

- an Album at `ALBUM_MAX_ENTRIES` counting sections and retained slots refuses a new pick;
- a timely Restore at that cap **succeeds** unconditionally;
- repeated trash → replace → restore of the same slot converges and never double-counts;
- trash → reorder → save → timely Restore returns the photo to the same slot;
- a retained slot whose recovery window expires under an export hold still allows the Album to be saved and reordered;
- trashing the cover and replacing it, then restoring, resolves deterministically;
- cleanup removes the marker and frees the slot exactly once;
- reset materializes active and retained-trash picks in timeline order.
- Exercise that reset assertion through the real Album editor Reset control. An ordinary Worker `PUT` whose request already supplies the desired order is not Reset evidence.
- the `ALBUM_MAX_ENTRIES - 1`, exact-cap, and cap-plus-one edges include sections and retained slots;
- expiry under an accepted export hold keeps the retained slot saveable/reorderable until cleanup owns removal.

- [ ] **Step 3: Run each new row and classify RED or verified-existing**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts tests/worker/media-recovery-api.test.ts tests/worker/export-api.test.ts -t "(album capacity|retained slot|restore|cover|reset|cleanup|export hold)"
```

If every new regression passes against current production, record `verified-existing` and make no production change. If a named row fails for the intended capacity invariant, preserve that RED output and make the smallest production edit in the two conditional files.

If the actual UI Reset regression fails because the retained marker lacks a comparable timeline fact, preserve that RED and add only the Manager-side ordering projection plus unified live/retained sort. Keep the existing autosave queue, revision guard, and Undo path; do not create a second Reset request owner.

- [ ] **Step 4: Verify focused GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts tests/worker/media-recovery-api.test.ts tests/worker/export-api.test.ts -t "(album capacity|retained slot|restore|cover|reset|cleanup|export hold)"
```

- [ ] **Step 5: Prove the public projection is unchanged**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-share-api.test.ts
```

Expected: PASS unchanged — a link holder still never sees a retained entry.

- [ ] **Step 6: Task review checkpoint**

Record the coverage inventory, each new regression's initial result, and any minimal production diff justified by a focused RED. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 4: Honest reconciliation in the Album editor

**Files:**
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/album-api.ts`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`

**Interfaces:**
- The client renders one of four states from `reconciliation`, and never decides the category itself:
  - `null` → the ordinary Album, with no prompt;
  - `initialize` → a bounded initializing state that automatically issues the CSRF-protected `POST /album/start` with `from-picks` and all three expectation fields, taking `expectedRevision` from the same `AlbumView` it read `pickGeneration` and `reconciliation` from, so the three describe one observation;
  - `historical` → the one-time prompt, whose copy says **existing picks from before this update** and whose choice applies to the complete current picked set;
  - `over-capacity` → `Start empty` available, `Start from picks` truthfully unavailable with its reason.

- [ ] **Step 1: Write the failing editor tests**

- a fresh Album whose picks are all current shows the bounded initializing state, issues exactly one auto-start carrying the server's `pickGeneration`, `reconciliation`, and `revision` from one observation, and never shows the prompt;
- a manual `Start from picks` and a manual `Start empty` each send all three expectations too — the guard is not auto-start-only;
- the auto-start is issued once even under StrictMode double-mounting;
- a conflict response from auto-start does not retry silently: it lands on the canonical conflict/reload path;
- the editor adopts the **post-Start** revision from the start response, so the first autosave after a Start carries the advanced number and does not immediately conflict with the write the host just made;
- an unversioned pick shows the prompt, and its copy contains no "before Albums" phrasing;
- `over-capacity` disables `Start from picks` with a focusable `aria-disabled` control and an adjacent reason, and leaves `Start empty` enabled;
- `over-capacity` renders even when `historicalPickCount` is `0`;
- zero picks renders the ordinary empty Album with no prompt;
- a retired Album generation drops a late start response.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t 'reconciliation'
```

- [ ] **Step 3: Implement**

Reuse the existing Album draft generation guard and the autosave queue's settlement contract; do not add a second Album request owner.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx
```

- [ ] **Step 5: Task review checkpoint**

Record UI reconciliation, one-observation expectations, StrictMode, revision adoption, and generation-retirement evidence. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 5: Evidence and checkpoint gates

**Files:**
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`

- [ ] **Step 1: Record C-17 and C-49**

C-17 is `implemented`: name the durable version/generation pair, the four projected categories, the expectation-guarded start, the start-advances-revision ruling and the stale-`PUT` regression that proves it, and the owning Worker and UI tests. C-49 is `verified-existing`: name the post-review repair already in the code and the new 501-pick boundary regression that proves it. Do not claim capacity or retention behavior under C-17 that is not covered by a named test.

- [ ] **Step 2: Run the complete checkpoint gates**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts tests/worker/album-share-api.test.ts tests/worker/media-recovery-api.test.ts tests/worker/export-api.test.ts tests/worker/migration-0021.test.ts
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx
git diff --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | xargs -r npx eslint --
git diff --check -- shared/contracts.ts worker/db/album.ts worker/db/media.ts worker/routes/manage.ts src/features/gallery/ManagerAlbum.tsx src/features/gallery/album-api.ts src/features/gallery/ManagerGalleryWorkspace.tsx tests/worker/album-api.test.ts tests/worker/album-share-api.test.ts tests/worker/media-recovery-api.test.ts tests/worker/export-api.test.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx docs/superpowers/host-gallery-verification-matrix.md
```

Expected: every focused command exits zero. Do not substitute a full test, build, lint, typecheck, E2E, or migration run.

- [ ] **Step 3: Checkpoint review handoff**

Record the matrix rows and focused outputs, run the scoped `git diff --check`, and obtain independent checkpoint review. Keep the entire Slice diff uncommitted for later plans.

Do not push. The next Slice 5 checkpoint is account lifecycle, rotation, and the safety ladder.

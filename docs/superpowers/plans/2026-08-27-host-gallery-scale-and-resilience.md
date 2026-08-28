# Host Gallery Scale and Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use test-driven development, preserve all existing Slice 1–5 work, and do not commit unless the user asks.

**Goal:** Make a thousand-photo event browsable and publishable without a partial write, a lost scroll position, a focus drop onto `body`, or one failed panel taking the Manager with it.

**Architecture:** One strict itemized bulk request replaces the client's sequential status-group loop, backed by a single CTE-fenced `UPDATE ... RETURNING` whose global eligible-count guard makes SQLite match every item or none. The item array is bound **once as JSON** and expanded with `json_each()`, so a 50-item request stays inside D1's 100-parameter bound. Guest gallery adopts Library's existing page size, `selection-state.ts` transitions, and capacity vocabulary rather than growing its own. Position preservation reuses the Slice 4 anchor module. Panel independence extends the Slice 1 resource controllers to paging, polling, and the Gallery summary; it does not add a late replacement for `ManagerPage.refresh()`.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, D1, React 19, React Router, Vitest with `vitest-pool-workers` and Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-scale-resilience-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- **Depends on** Slices 1–5. In particular: Slice 1's `src/features/manager/resources.ts` controllers, Slice 4's `src/features/gallery/gallery-anchor.ts` and `src/app/manager-location.ts`, and Slice 6's own use of `selection-state.ts`.
- No migration belongs to this slice. The HTTP path stays exactly `POST /api/manage/events/:eventId/media/bulk` and the response envelope stays `{ data: { changed: ManagerMediaView[] }, requestId }`.
- The 48-row page and the 50-action selection cap are the bounds. Do not add an all-results selection, an unbounded mutation, a client-side event cache, or a new data-fetching or state-management library.
- The repository must not perform a post-update fetch. The current implementation's `SELECT * FROM media WHERE id IN (…)` after the `UPDATE` is a read that can race a concurrent write; the replacement returns rows from `RETURNING` and orders them through the validated input array.
- The itemized array binds **once as JSON**. Do not expand 50 IDs into 50 placeholders; that is how the 100-parameter bound gets breached and it is against the repository's stated convention.
- A conflict must never identify the conflicting ID. Any missing, cross-event, changed, deleted, or trashed row produces the same `MEDIA_STATE_CONFLICT` 409.
- Duplicate IDs, more than 50 items, missing fields, or unknown keys are `VALIDATION_FAILED` 422 — the same code the route returns today.
- The legacy `{ ids, action, expectedStatus }` payload stays accepted for exactly one compatibility release. It is translated to itemized inputs **before** the repository call and receives the same all-or-nothing response. Add a contract test that marks the legacy parser for removal; do not maintain two mutation implementations.
- Optimistic partial success is an explicit non-goal. A failed atomic write leaves rows, selection, position, and filter unchanged and adds the existing recoverable notice.
- Filter ownership does not move. Intake owns contributor, status, and Recently deleted; Library owns search and order; Guest gallery owns its publication filter. This slice adds paging and reconciliation to those owners.
- Any intentional reset of a destination-local selection or filter must be named in the existing visible notice and live region.
- Tests assert D1 state after conflicts and partial-read failures, not only UI messages.
- Every behavior change follows RED → GREEN → REFACTOR.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-scale-and-resilience/`, then take an independent spec and code review. Fix every P1/P2 before advancing.

## Checkpoint boundary

This is the final slice in the program. It owns C-34, C-38, and C-62, and it closes the verification matrix. When it completes, all 66 combined-review findings must carry a disposition.

---

### Task 1: The atomic itemized repository write

**Files:**
- Modify: `worker/db/media.ts`
- Modify: `tests/worker/repositories.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BulkPublicationItem {
  id: string;
  expectedStatus: PublicationStatus;
}

/**
 * All-or-nothing. Returns every requested row in request order, including an
 * allowed no-op whose expected status already equals the target.
 */
setPublicationBulkExpected(
  eventId: string,
  items: readonly BulkPublicationItem[],
  target: PublicationStatus,
  changedAt: string,
): Promise<MediaRecord[]>;
```

- One statement. A requested-items CTE from `json_each(?)` feeds an eligible-row CTE; the update predicate carries a global eligible-count-equals-request-count guard, so the statement matches every item in its own snapshot or matches none.
- Eligibility: the authorized event, `upload_state = 'stored'`, `deleted_at IS NULL`, `trashed_at IS NULL`, and the row's own supplied `expectedStatus`.
- An item already at the target is **allowed** and preserves its existing timestamps. `publish` accepts expected `unpublished`, `published`, or `hidden`; `hide` accepts the same three.
- A returned count other than the validated request count means conflict, and because the global guard matched nothing, no write occurred.

- [ ] **Step 1: Write the failing repository suite**

- 50 mixed-state rows publish in one statement and return in **request order**, not row order;
- an already-published row inside a `publish` request is returned unchanged and its `published_at` is byte-identical afterwards;
- one stale `expectedStatus` among 50 produces zero changes — assert D1 state row by row, not just the thrown error;
- a cross-event ID produces zero changes;
- a trashed row produces zero changes;
- a `deleted_at` row produces zero changes;
- an ID that does not exist produces zero changes;
- every one of those failures raises the same `MEDIA_STATE_CONFLICT` 409 and its message names no ID;
- a 50-item request issues exactly one `UPDATE` and performs no follow-up `SELECT`;
- the bound parameter count stays well under 100 regardless of item count;
- two concurrent requests over overlapping items leave exactly one winner and a consistent table.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/repositories.test.ts -t 'setPublicationBulkExpected'
```

Expected: FAIL — the method does not exist, and `setPublicationBulk` takes one uniform `expected`.

- [ ] **Step 3: Implement the statement**

Keep `setPublicationBulk` in place for the compatibility release, implemented as a thin translation onto the new method so there is one mutation implementation.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/repositories.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add worker/db/media.ts tests/worker/repositories.test.ts
git commit -m "feat: make bulk publication one atomic statement"
```

---

### Task 2: The strict itemized route

**Files:**
- Modify: `worker/routes/manage.ts`
- Modify: `shared/contracts.ts`
- Modify: `tests/worker/manage-api.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BulkPublicationRequest {
  action: 'publish' | 'hide';
  items: Array<{ id: string; expectedStatus: 'unpublished' | 'published' | 'hidden' }>;
}
```

`items` holds 1–50 **unique** IDs. The legacy `{ ids, action, expectedStatus }` body is translated to itemized inputs before the repository call.

- [ ] **Step 1: Write the failing route suite**

- an itemized 50-item mixed-state request succeeds and returns `changed` in request order;
- 51 items → `VALIDATION_FAILED` 422;
- duplicate IDs → 422;
- a missing `expectedStatus` → 422;
- an unknown key → 422 (the schema is `.strict()`);
- an unknown `expectedStatus` value → 422;
- an empty `items` array → 422;
- a legacy uniform payload still succeeds with identical all-or-nothing semantics and the same response order;
- one stale expected state → 409 with no ID disclosed and no D1 change;
- authorization, CSRF, origin, and cross-event refusals are unchanged from the existing suite.

Add the contract test naming the legacy branch for removal after one release.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t 'itemized'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add worker/routes/manage.ts shared/contracts.ts tests/worker/manage-api.test.ts
git commit -m "feat: accept itemized bulk publication"
```

---

### Task 3: One bounded selection model in Guest gallery

**Files:**
- Modify: `shared/constants.ts`
- Modify: `worker/routes/gallery.ts`
- Modify: `src/features/gallery/ManagerSharedGallery.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `tests/unit/gallery-selection-state.test.ts`
- Modify: `tests/worker/gallery-audience-summary.test.ts`
- Modify: `tests/ui/album-workspace.test.tsx`

**Interfaces:**
- Guest gallery adopts Library's page size through a **new dedicated constant**, not by moving an existing one:

```ts
/** Guest gallery reads the same page depth Library does. */
export const MANAGER_GUEST_GALLERY_PAGE_SIZE = PRIVATE_GALLERY_PAGE_SIZE; // 48
```

  `MANAGER_MEDIA_PAGE_SIZE` stays at `24`. It is the default for **two** reads — `GET /manage/events/:eventId/media` (Guest gallery) and `GET /manage/events/:eventId/media/trash` (Recently deleted) — and Recently deleted's page depth is not in this slice's scope. Change only `mediaLimitSchema`'s default in `worker/routes/manage.ts`; leave `trashLimitSchema` alone. `48` remains inside the existing `MANAGER_MEDIA_MAX_PAGE_SIZE` of `50`, so the schema bound does not move either.
- Guest gallery uses `transitionSelection`, `selectionCountMessage`, and `selectionCapacityMessage` from `selection-state.ts`. Its bulk vocabulary is **`Select all N loaded photos`** — never a promise about unloaded or all-event results.
- At the cap: unchecked row controls are disabled with the shared capacity explanation; checked rows stay removable; row publication actions that would conflict with the running batch are disabled while it runs; pagination and the current filter stay visible.

- [ ] **Step 1: Write the failing selection tests**

- 49, 50, and 51 selection attempts behave exactly as Library's do, driven through the same `transitionSelection` table;
- at the cap, an unchecked control is disabled and describes the shared capacity message; a checked control is still operable;
- while a bulk write runs, a row action that would conflict with the batch is disabled, and one that would not is unaffected;
- pagination controls and the active filter remain rendered during a running batch;
- the bulk affordance's accessible name says **loaded**, and no copy claims all results;
- a filter change that clears selection announces the clearing in the existing live region and the visible notice (C-62);
- the Guest-gallery read defaults to 48 rows and the Worker honors it;
- **Recently deleted still pages at 24** — a regression that fails if `MANAGER_MEDIA_PAGE_SIZE` was moved instead of a new constant being added.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/unit/gallery-selection-state.test.ts tests/ui/album-workspace.test.tsx -t 'loaded photos'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/unit/gallery-selection-state.test.ts tests/ui/album-workspace.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/gallery-audience-summary.test.ts tests/worker/manage-api.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add shared/constants.ts worker/routes/gallery.ts src/features/gallery/ManagerSharedGallery.tsx src/features/gallery/ManagerGalleryWorkspace.tsx tests/unit/gallery-selection-state.test.ts tests/worker/gallery-audience-summary.test.ts tests/ui/album-workspace.test.tsx
git commit -m "fix: give guest gallery one bounded selection model"
```

---

### Task 4: Replace the sequential loop, and keep position

**Files:**
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `src/features/gallery/gallery-anchor.ts`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/gallery-anchor.test.ts`

**Interfaces:**
- `bulkSharedPublication` sends **one** itemized request. The `retryGroups` parameter, the status-grouping `Map`, and the per-group partial-confirmation announcements are deleted; a retry replays the same single request.
- Position preservation: the list keeps an anchor ID and current cursor ownership. A row that remains in the filter updates without a refetch jump. A row leaving the filter is removed and the next or previous card becomes the anchor. A bounded first-page reconciliation fills visible gaps without resetting document scroll. `Load more` continues only from a cursor belonging to the same filter generation.
- Focus after a removing write, in order: the next surviving card, the previous card, then the Guest-gallery results heading. Bulk focus resolves from the **earliest removed focused or selected position**, not response order. Pointer activation leaves focus on that fallback only when its invoking control disappeared. The success announcement follows the focus move and never leaves focus on `body`.

- [ ] **Step 1: Write the failing write-and-position suite**

For each of the four publication filters — all, unpublished, published, hidden — and for both single and bulk writes:
- a row that stays in the filter updates in place with no scroll jump and no refetch;
- a row that leaves the filter is removed and the anchor moves to the next surviving card;
- when no next card exists, the anchor and focus move to the previous card;
- when neither exists, focus lands on the results heading;
- the announcement is made **after** the focus move;
- focus is never on `document.body` at any assertion point;
- bulk focus resolves from the earliest removed selected position even when the server returns rows in a different order;
- a conflict leaves rows, selection, scroll position, and filter byte-identical and shows the existing recoverable notice;
- exactly one request is sent for a mixed-state bulk action — assert the call count and the body shape;
- a retry after a network failure replays that same one request;
- a filter change during an in-flight page read discards the stale page and keeps the new filter's cursor.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t 'one request'
```

Expected: FAIL — the loop currently issues one request per status group.

- [ ] **Step 3: Implement**

Delete the grouping and per-group announcement paths rather than leaving them unreachable. Reuse `gallery-anchor.ts` for capture and restoration; do not add a second anchor owner.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx tests/ui/gallery-anchor.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/gallery-anchor.ts tests/ui/album-workspace.test.tsx tests/ui/app.test.tsx tests/ui/gallery-anchor.test.ts
git commit -m "fix: publish in one request and keep the reading position"
```

---

### Task 5: Panel-independent paging, polling, and summaries

**Files:**
- Modify: `src/features/manager/resources.ts`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/features/gallery/ManagerGalleryWorkspace.tsx`
- Modify: `tests/ui/manager-resources.test.tsx`
- Modify: `tests/ui/manager-recovery.test.tsx`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- No new module. Paging reads, background polling, and the Gallery and Guestbook summary reads adopt the existing per-resource controller ownership: their own generation guard, their own local result, their own panel error and **Try again**.
- The event identity and lifecycle result remains the only shell-critical read. A credential or lifecycle failure from any resource still escalates once to the Manager recovery surface. A stale completion may never replace a newer write or filter result.

- [ ] **Step 1: Write the failing independence matrix**

Table-drive one failing resource at a time and assert every other panel still renders its last trusted value:
- an export failure cannot erase Intake;
- a Guestbook-summary failure cannot erase Gallery;
- a media failure cannot remove Settings or Share;
- a printed-entry failure cannot remove Gallery;
- a Gallery-summary failure cannot remove the media list;
- background polling failure stays inside its own panel;
- an event-identity failure — and only that — reaches the recovery surface;
- a retryable failure keeps the last trusted value across **Try again**;
- a stale page response arriving after a filter change is dropped;
- a stale poll arriving after a successful write does not overwrite it.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-resources.test.tsx tests/ui/manager-recovery.test.tsx -t 'independent'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-resources.test.tsx tests/ui/manager-recovery.test.tsx tests/ui/app.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/features/manager/resources.ts src/pages/ManagerPage.tsx src/features/gallery/ManagerGalleryWorkspace.tsx tests/ui/manager-resources.test.tsx tests/ui/manager-recovery.test.tsx tests/ui/app.test.tsx
git commit -m "fix: let each manager panel fail alone"
```

---

### Task 6: Scale evidence

**Files:**
- Modify: `tests/worker/host-private-gallery-scale.test.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**
- Reuse the **existing** Worker and Playwright scale fixtures. Do not build a third fixture generator.

- [ ] **Step 1: Write the failing scale cases**

- 1,000+ stored photos paged at 48 rows, with the last page's boundary asserted exactly;
- Guest-gallery filters across multiple pages, with the cursor belonging to one filter generation;
- a mixed-state 50-row atomic write at that scale;
- allowed publish and hide no-ops inside such a write, returned in request order;
- the legacy uniform payload translated at that scale;
- one stale expected state causing zero changes — assert D1;
- concurrent single and bulk requests with one clear winner;
- preserved anchor, next/previous/results-heading focus, and cursor after rows stay, leave, or conflict, under every publication filter;
- a filter change during an in-flight page read.

- [ ] **Step 2: Add the browser evidence**

Extend Slice 4's named Axe inventory with the Guest-gallery at-cap state, the running-batch state, and the post-write focus target, updating the exact-order inventory assertion in the same commit. Add a keyboard trace proving focus lands on the next surviving card after a removing write at 390 px.

- [ ] **Step 3: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/host-private-gallery-scale.test.ts
npm run build
npx playwright test tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts --project=desktop --project=mobile
```

- [ ] **Step 4: Commit**

```bash
git add tests/worker/host-private-gallery-scale.test.ts tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts
git commit -m "test: prove bulk publication at scale"
```

---

### Task 7: Close the program

**Files:**
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`
- Modify: `docs/operations.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Record C-34, C-38, and C-62**

Name the single atomic statement and its global guard, the removal of the sequential loop, the 48-row Guest-gallery page and shared selection model, the anchor and focus fallback order, the panel-independence matrix, and the owning tests for each.

- [ ] **Step 2: Replace the `## Slices 5–6 — Not started.` placeholder**

That line must be gone. Slice 6 gets its own completed section on the same terms as Slices 1–4.

- [ ] **Step 3: Prove every finding is dispositioned**

```bash
for n in $(seq -w 1 66); do
  rg -q "\*\*C-$n\*\*" docs/superpowers/host-gallery-verification-matrix.md || echo "MISSING C-$n";
done
```

Expected: no output. Every one of C-01 through C-66 has a row. Confirm the export/delete retention race row is still present, and that exactly one finding is `deferred-approved` (cross-audience withdrawal) and one `out-of-scope-approved` (broader ownerless recovery), as the program design permits.

- [ ] **Step 4: Document the bulk contract**

In `docs/operations.md`, record the all-or-nothing bulk write, the generic 409, the one-release legacy payload with its removal marker, and the 48-row Guest-gallery page. In `CLAUDE.md`, note the itemized bulk shape beside the existing D1 concurrency and parameter-bound conventions.

- [ ] **Step 5: Run the complete program gates**

```bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run verify:bindings
npm test
npm run build
CI_BASE_SHA="$(git merge-base origin/main HEAD)" CI_HEAD_SHA="$(git rev-parse HEAD)" npm run ci:migrations
npm run test:e2e
git diff --check
git status --short
```

Expected: every command exits zero and the worktree is clean apart from intended changes. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 6: Commit the closing record**

```bash
git add docs/superpowers/host-gallery-verification-matrix.md docs/operations.md CLAUDE.md
git commit -m "docs: close the host gallery roadmap record"
```

Do not push, open a pull request, or deploy. Merging this branch and releasing migrations `0019`–`0021` is a separate, separately authorized release plan; note that it carries three migrations and the migration-first ordering rulings recorded in `docs/deployment.md`.

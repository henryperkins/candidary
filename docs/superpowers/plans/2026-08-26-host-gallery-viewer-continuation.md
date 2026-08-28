# Host Gallery Viewer Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Let the Manager viewer cross a loaded-page boundary without closing, losing the current photo, duplicating rows, or introducing a second pagination owner.

**Architecture:** 'ManagerPrivateGallery' retains the only Library cursor, list, request generation, and append owner. 'GalleryViewer' becomes identity-driven at the boundary and asks that owner for one explicit continuation outcome. Viewer-local state owns only presentation while the request is pending or recoverably failed.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, Playwright

**Spec:** 'docs/superpowers/specs/2026-08-23-host-gallery-navigation-responsive-accessibility-design.md'

## Global Constraints

- Reuse the existing Gallery API and cursor path; do not add a Worker route, query, cache, or store.
- Keep the current photo visible throughout a page request and a recoverable failure.
- Append unique rows through the existing Library owner and advance only when the immediate successor exists.
- At most one viewer continuation may run at a time, whether started by click or ArrowRight.
- At the loaded boundary, name the control 'Load next photo' while another page exists.
- Failure keeps the dialog open, exposes an in-dialog alert and Try again, and focuses Try again.
- Exhaustion is not an error; retain the photo and disable the normal 'Next photo' control.
- Closing retains successfully appended rows and preserves the current invoker-focus contract.
- Closing while continuation is pending may still allow the owner to retain a successful append, but it must retire viewer presentation so settlement cannot advance or reopen the dialog.
- Keep the viewer's inert background, focus trap, Escape behavior, live announcement, and preview fallback unchanged.
- Empty or duplicate-only pages do not loop automatically. If no immediate successor exists after the one requested page, return 'exhausted' only when no cursor remains; otherwise return 'failed' with the normal recoverable presentation.
- No history-envelope, anchor, filter, URL, API, schema, package, or dependency work belongs to this checkpoint.
- Every behavior change follows RED -> GREEN -> REFACTOR; observe the intended RED before production edits.
- Work only in '/home/henry/candidary/.worktrees/gallery-roadmap-remediation'; do not push, deploy, merge, or open a PR.

## File Structure

- Keep presentation and keyboard behavior in 'src/features/gallery/GalleryViewer.tsx'.
- Keep list, cursor, request, deduplication, and result classification in 'src/features/gallery/ManagerPrivateGallery.tsx'.
- Add 'tests/ui/gallery-viewer.test.tsx' for the presentation contract and extend 'tests/ui/host-private-gallery.test.tsx' for owner/request/focus races.
- Add a scoped two-page Gallery route to 'tests/e2e/accessibility.spec.ts'; do not globally alter the fixture's current all-rows Gallery response.

---

### Task 1: Identity-based viewer continuation contract

**Files:**
- Modify: 'src/features/gallery/GalleryViewer.tsx'
- Create: 'tests/ui/gallery-viewer.test.tsx'

**Interfaces:**
- Produces:

~~~ts
export type ViewerContinuationOutcome =
  | { status: 'advanced'; nextPhotoId: string }
  | { status: 'exhausted' }
  | { status: 'failed' };

interface GalleryViewerProps {
  photos: ManagerGalleryMediaView[];
  photoId: string;
  timeZone: string;
  hasMore: boolean;
  favoritePendingIds: ReadonlySet<string>;
  onPhotoChange(photoId: string): void;
  loadNextAfter(photoId: string): Promise<ViewerContinuationOutcome>;
  onClose(): void;
  onFavorite(photo: ManagerGalleryMediaView): void;
  live?: boolean;
  onAnnouncement?(message: string): void;
}
~~~

- [ ] **Step 1: Write failing viewer presentation tests**

Render `GalleryViewer` directly with a one-photo loaded page, `hasMore: true`, and a deferred continuation. Assert:

~~~ts
expect(within(dialog).getByRole('button', { name: 'Load next photo' })).toBeEnabled();
await user.keyboard('{ArrowRight}');
expect(within(dialog).getByText('First dance')).toBeVisible();
expect(loadNextAfter).toHaveBeenCalledOnce();
~~~

Add result cases: 'advanced' changes by ID, 'exhausted' renders a disabled 'Next photo', and 'failed' renders an alert plus focused Try again while retaining the current title. Add `ignores a stale continuation after Previous changes the current photo` and `ignores a stale continuation after Close` with deferred successful results.

- [ ] **Step 2: Run focused tests and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/gallery-viewer.test.tsx
~~~

Expected: FAIL because Next is disabled at the last loaded index and no continuation callback exists.

- [ ] **Step 3: Implement minimal viewer presentation**

Derive the current index from 'photoId'. Previous and ordinary in-page Next call 'onPhotoChange(photos[index +/- 1].id)'. At the last loaded row with 'hasMore', invoke one ref-held promise:

~~~ts
const continuationRef = useRef<Promise<ViewerContinuationOutcome> | null>(null);
const viewerMounted = useRef(true);
const viewerRequestGeneration = useRef(0);
const currentPhotoId = useRef(photoId);
currentPhotoId.current = photoId;

function continueForward() {
  if (continuationRef.current) return;
  setContinuationFailure(false);
  const requestedPhotoId = photoId;
  const request = loadNextAfter(requestedPhotoId);
  continuationRef.current = request;
  const generation = viewerRequestGeneration.current;
  void request.then((outcome) => {
    if (
      !viewerMounted.current
      || generation !== viewerRequestGeneration.current
      || currentPhotoId.current !== requestedPhotoId
    ) return;
    if (outcome.status === 'advanced') onPhotoChange(outcome.nextPhotoId);
    if (outcome.status === 'failed') setContinuationFailure(true);
  }).finally(() => {
    if (continuationRef.current === request) continuationRef.current = null;
  });
}
~~~

Keep one Next button mounted. Use 'aria-label' to switch between 'Load next photo' and 'Next photo'. Set `viewerMounted.current = false` and increment the viewer presentation generation in effect cleanup; increment it synchronously before invoking `onClose` as well. A later owner settlement may append rows but cannot call `onPhotoChange` or set dialog-local failure state after Close or after the user has moved to another photo. On failure, render a dialog-local 'role=\"alert\"' and Try again, then focus the retry ref in an effect. Include Try again in the existing disabled-aware focus-trap query.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run Step 2 again. Expected: viewer presentation tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add src/features/gallery/GalleryViewer.tsx tests/ui/gallery-viewer.test.tsx
git commit -m "feat: request viewer continuation"
~~~

---

### Task 2: Owner-side page append and explicit outcome

**Files:**
- Modify: 'src/features/gallery/ManagerPrivateGallery.tsx'
- Modify: 'tests/ui/host-private-gallery.test.tsx'

**Interfaces:**
- Consumes: 'ViewerContinuationOutcome' from Task 1.
- Produces:

~~~ts
async function loadNextAfter(photoId: string): Promise<ViewerContinuationOutcome>;
~~~

- [ ] **Step 1: Write failing owner integration tests**

Add all five named cases. The success case must prove the second request's duplicate is not appended and the immediate successor becomes current:

~~~ts
it('loads one next page in the viewer, deduplicates it, and advances to the immediate successor', async () => {
  await user.click(screen.getByRole('button', { name: 'Load next photo' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Second photo');
  expect(document.querySelectorAll('[data-photo-id="p1"]')).toHaveLength(1);
  expect(galleryRequests.filter((url) => url.includes('cursor=page-2'))).toHaveLength(1);
});
~~~

The other cases are named `keeps the viewer photo and focuses Try again after a continuation failure`, `marks viewer continuation exhausted without an alert when no successor remains`, `coalesces click and ArrowRight while viewer continuation is pending`, and `retains an appended page without reopening a viewer closed during continuation`. The success fixture returns `[p1]` then `[p1, p2]` to prove deduplication. Hold the response and assert p1 stays rendered and only one `cursor=page-2` request exists. Retry must reuse that cursor and then show p2; exhaustion must leave no alert; simultaneous inputs must share the one held request; close-before-resolve must restore invoker focus, keep the dialog absent, and leave p2 in the mosaic after settlement.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/host-private-gallery.test.tsx -t "loads one next page in the viewer|continuation failure|continuation exhausted|coalesces click|closed during continuation"
~~~

- [ ] **Step 3: Implement owner classification**

Share the existing Gallery request path, abort controller, and generation fence. Initialize and synchronize `rowsRef`/`cursorRef` on the first confirmed page, every successful replacement, every append, and every query/order reset; add assertions that replacement retires old ref data before a later continuation. Maintain them synchronously before resolving. Calculate the merged result from the request response rather than reading reducer state after dispatch.

~~~ts
const known = new Set(rowsRef.current.map(({ id }) => id));
const merged = [
  ...rowsRef.current,
  ...page.media.filter(({ id }) => !known.has(id)),
];
const currentIndex = merged.findIndex(({ id }) => id === photoId);
const successor = currentIndex >= 0 ? merged[currentIndex + 1] : undefined;
rowsRef.current = merged;
cursorRef.current = page.nextCursor;
dispatchRows({ type: 'append', rows: page.media });
setCursor(page.nextCursor);
if (successor) return { status: 'advanced', nextPhotoId: successor.id };
return page.nextCursor === null ? { status: 'exhausted' } : { status: 'failed' };
~~~

Use a ref-held in-flight request so two boundary inputs return the same promise rather than aborting and replacing each other. Query/order replacement still retires and aborts the owner. An aborted result after the viewer unmounts must not render an alert.

- [ ] **Step 4: Preserve ordinary Load more**

Extract one lower-level page primitive that returns data/error without choosing presentation. `loadMore()` wraps it and retains the existing out-of-dialog notice plus exact-cursor Retry. `loadNextAfter()` wraps it into the viewer's scoped `failed` result and must not also publish the mosaic notice. Add a regression proving an ordinary Load more failure still shows its current notice while viewer failure appears only inside the dialog.

- [ ] **Step 5: Run the whole Library UI file and verify GREEN**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/host-private-gallery.test.tsx
~~~

Expected: all existing search, paging, selection, viewer, focus, and export cases pass.

- [ ] **Step 6: Commit**

~~~bash
git add src/features/gallery/ManagerPrivateGallery.tsx tests/ui/host-private-gallery.test.tsx
git commit -m "feat: continue viewer across gallery pages"
~~~

---

### Task 3: Real-browser continuation, failure focus, and modal regression

**Files:**
- Modify: 'tests/e2e/accessibility.spec.ts'
- Modify: 'src/styles.css' only if the new in-dialog alert or retry lacks the existing dialog contrast/focus floor

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: Chromium evidence across a real cursor boundary plus retained modal behavior.

- [ ] **Step 1: Add a scoped two-page route and failing test**

In one test, override the Manager Gallery GET so the first response contains one row plus 'viewer-page-2'; the next request fails once and then returns a duplicated first row plus the second row. Do not change 'stubManagerRoutes' globally.

Assert the initial 'Load next photo', current-photo retention, in-dialog alert, focused Try again, successful advance, Axe pass, Escape close, and restoration to the original tile that invoked the viewer.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "viewer crosses a Gallery page boundary"
~~~

Expected: FAIL at the current disabled Next control.

- [ ] **Step 3: Apply only evidence-driven styling**

If the new alert needs styling, reuse the opaque danger treatment and fixed focus outline:

~~~css
.gallery-viewer__continuation-error {
  padding: 12px;
  border: 1px solid var(--danger);
  background: #fff1ee;
  color: var(--danger);
}
~~~

Do not change viewer geometry, image treatment, background opacity, or motion without a failing rendered assertion.

- [ ] **Step 4: Run browser and focused static gates**

~~~bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "viewer crosses a Gallery page boundary|manager private gallery mosaic"
npx vitest run --config vitest.config.ts tests/ui/gallery-viewer.test.tsx tests/ui/host-private-gallery.test.tsx
npm run typecheck
npm run typecheck:e2e
npm run lint
~~~

Expected: all commands exit zero.

- [ ] **Step 5: Commit**

~~~bash
git add tests/e2e/accessibility.spec.ts src/styles.css
git commit -m "test: verify viewer page continuity"
~~~

If 'src/styles.css' did not change, omit it from 'git add'.

---

### Task 4: C-46 evidence and checkpoint gates

**Files:**
- Modify: 'docs/superpowers/host-gallery-verification-matrix.md'

**Interfaces:**
- Produces the C-46 matrix row and final checkpoint evidence.

- [ ] **Step 1: Record C-46**

Name the identity bridge, single-flight owner append, failure/Retry focus, clean exhaustion, and exact UI/E2E owning tests. Do not claim responsive or Axe-matrix findings here.

- [ ] **Step 2: Run complete checkpoint gates**

~~~bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npx vitest run --config vitest.config.ts tests/ui/gallery-viewer.test.tsx tests/ui/host-private-gallery.test.tsx tests/ui/app.test.tsx
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "viewer crosses a Gallery page boundary|manager private gallery mosaic"
npm test
npm run build
git diff --check
~~~

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 3: Commit the matrix record**

~~~bash
git add docs/superpowers/host-gallery-verification-matrix.md
git commit -m "docs: record viewer continuity evidence"
~~~

Do not push. The next independent Slice 4 checkpoint is responsive layout and reorder focus.

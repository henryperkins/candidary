# Host Gallery History Intents and Anchors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Preserve each Gallery mode's loaded position and carry exact, one-use Manager tasks through Share, Settings, and Recently deleted without widening the durable URL contract.

**Architecture:** A pure 'manager-history-state.ts' module validates and rewrites the versioned '__candidaryManager' Router-state envelope while preserving every foreign Router-state key. 'ManagerPage' remains the sole Router-state and navigation owner; Gallery children expose only bounded rendered-item capture, restore, filter, and focus methods through the existing workspace handle. All pushes and Back/Forward adoptions continue through the current pending-work and Album-settlement gates.

**Tech Stack:** TypeScript, React 19, React Router 7, Vitest, Testing Library, Playwright

**Spec:** 'docs/superpowers/specs/2026-08-23-host-gallery-navigation-responsive-accessibility-design.md'

## Global Constraints

- Durable location remains '/manage/event/:eventId' with 'section' and Gallery-only 'mode'; filters, anchors, selection, and intent stay out of the query.
- Only a plain-object '__candidaryManager' with 'version === 1' and the exact current 'eventId' is read.
- Preserve every non-Candidary Router-state key; remove invalid, incompatible, consumed, or cross-event Candidary state with 'replace'.
- Preserve the one existing 'useBlocker' and its ordinary Settings, Appearance, RSVP, and Album settlement order.
- Extend that same blocker/coordinator to pause Back/Forward departures from every Gallery mode long enough to replace the departing entry's anchor; do not add a second blocker.
- Capture at most 20 rendered IDs before and 20 after the first item crossing the effective visible top.
- Restore rendered rows only: never fetch, change a filter, advance a cursor, or scan an unrendered page to find an anchor.
- Selection is intentionally not serialized. A mode transition that clears selection announces the reset.
- Reload may lose all transient state and falls back to the canonical durable URL.
- No Worker route, API contract, database schema, migration, package, or dependency change belongs to this checkpoint.
- Every behavior change follows RED -> GREEN -> REFACTOR; observe the intended RED before production edits.
- Work only in '/home/henry/candidary/.worktrees/gallery-roadmap-remediation'; do not push, deploy, merge, or open a PR.

## File Structure

- Create 'src/app/manager-history-state.ts' for pure envelope validation, compatibility, updates, consumption, and fallback ordering.
- Create 'src/features/gallery/gallery-anchor.ts' for bounded DOM capture/restoration against already-rendered items.
- Keep Router reads/writes and adoption generations in 'src/pages/ManagerPage.tsx'.
- Extend 'ManagerGalleryWorkspaceHandle' with narrow rendered-anchor and focus-target methods; it must not read Router state.
- Create 'tests/e2e/manager-navigation-intents.spec.ts' for real layout, Back, and focus evidence.

---

### Task 1: Versioned Manager history-state contract

**Files:**
- Create: 'src/app/manager-history-state.ts'
- Create: 'tests/unit/manager-history-state.test.ts'
- Read: 'src/app/manager-location.ts'

**Interfaces:**
- Consumes: 'ManagerLocation' and 'GalleryMode'.
- Produces:

~~~ts
export type PublicationFilter = 'all' | 'unpublished' | 'published' | 'hidden';
export type GalleryAnchor =
  | { kind: 'media'; mediaId: string; viewportOffset: number; fallbackScrollY: number; before: string[]; after: string[] }
  | { kind: 'album-entry'; entryId: string; viewportOffset: number; fallbackScrollY: number; before: string[]; after: string[] };
export type ManagerNavigationIntent =
  | { kind: 'focus-complete-export' }
  | { kind: 'focus-intake-heading' }
  | { kind: 'open-recently-deleted'; focusMediaId: string }
  | { kind: 'edit-guest-gallery-availability'; returnTo: {
      section: 'gallery'; mode: 'guest-gallery'; publicationFilter: PublicationFilter;
    } };
export type ManagerHistoryStateV1 = {
  version: 1; eventId: string;
  anchors?: Partial<Record<GalleryMode, GalleryAnchor>>;
  intent?: ManagerNavigationIntent;
};
export type RouterHistoryState = Record<string, unknown> & {
  __candidaryManager?: ManagerHistoryStateV1;
};
export function sanitizeManagerHistoryState(
  rawState: unknown, eventId: string, location: ManagerLocation,
): { state: RouterHistoryState; envelope: ManagerHistoryStateV1 | null; needsReplace: boolean };
export function withGalleryAnchor(
  rawState: unknown, eventId: string, mode: GalleryMode, anchor: GalleryAnchor | null,
): RouterHistoryState;
export function withManagerIntent(
  rawState: unknown, eventId: string, intent: ManagerNavigationIntent,
): RouterHistoryState;
export function consumeManagerIntent(
  rawState: unknown, eventId: string, location: ManagerLocation,
): { state: RouterHistoryState; intent: ManagerNavigationIntent | null };
export function anchorCandidateIds(anchor: GalleryAnchor): string[];
~~~

- [ ] **Step 1: Write the failing contract tests**

Cover plain-object/version/event validation, exact intent compatibility, foreign-key preservation, anchor survival through intent consumption, empty-envelope removal, 20-ID bounds, alternating fallback order, and mode-to-anchor-kind compatibility. Strip `album-entry` anchors from Library/Guest gallery and `media` anchors from Album while retaining valid sibling anchors.

~~~ts
it('consumes a compatible intent while preserving foreign state and anchors', () => {
  const anchor: GalleryAnchor = {
    kind: 'media', mediaId: 'm21', viewportOffset: 18, fallbackScrollY: 2450,
    before: ['m20'], after: ['m22'],
  };
  const result = consumeManagerIntent({
    source: 'share',
    __candidaryManager: {
      version: 1, eventId: 'event-a', anchors: { library: anchor },
      intent: { kind: 'focus-complete-export' },
    },
  }, 'event-a', { section: 'gallery', mode: 'library' });
  expect(result.intent).toEqual({ kind: 'focus-complete-export' });
  expect(result.state).toEqual({
    source: 'share',
    __candidaryManager: { version: 1, eventId: 'event-a', anchors: { library: anchor } },
  });
});

it('orders exact, then alternating after and before IDs', () => {
  expect(anchorCandidateIds({
    kind: 'media', mediaId: 'm3', viewportOffset: 0, fallbackScrollY: 900,
    before: ['m2', 'm1'], after: ['m4', 'm5'],
  })).toEqual(['m3', 'm4', 'm2', 'm5', 'm1']);
});
~~~

- [ ] **Step 2: Run the new unit file and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/manager-history-state.test.ts
~~~

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure transforms**

Use explicit plain-object, finite-number, nonempty-ID, array, mode, filter, and discriminant checks. Clone valid state; never mutate Router input. Compatibility is exact: export -> Library, Intake intents -> Intake, and availability intent -> Settings or Guest gallery.

~~~ts
export function anchorCandidateIds(anchor: GalleryAnchor): string[] {
  const exact = anchor.kind === 'media' ? anchor.mediaId : anchor.entryId;
  const nearby = Array.from(
    { length: Math.max(anchor.after.length, anchor.before.length) },
    (_, index) => [anchor.after[index], anchor.before[index]]
      .filter((value): value is string => typeof value === 'string'),
  );
  return [exact, ...nearby.flat()];
}
~~~

- [ ] **Step 4: Run the unit file and verify GREEN**

Run Step 2 again. Expected: all tests pass.

- [ ] **Step 5: Commit**

~~~bash
git add src/app/manager-history-state.ts tests/unit/manager-history-state.test.ts
git commit -m "feat: define manager history state"
~~~

---

### Task 2: Bounded rendered Gallery anchors

**Files:**
- Create: 'src/features/gallery/gallery-anchor.ts'
- Create: 'tests/ui/gallery-anchor.test.ts'
- Modify: 'src/features/gallery/GalleryTimeline.tsx'
- Modify: 'src/features/gallery/ManagerPrivateGallery.tsx'
- Modify: 'src/features/gallery/ManagerSharedGallery.tsx'
- Modify: 'src/features/gallery/ManagerAlbum.tsx'
- Modify: 'src/features/gallery/ManagerGalleryWorkspace.tsx'

**Interfaces:**
- Consumes: 'GalleryAnchor' and 'anchorCandidateIds()' from Task 1.
- Produces:

~~~ts
export function captureRenderedGalleryAnchor(
  root: HTMLElement, kind: GalleryAnchor['kind'], effectiveVisibleTop: number,
): GalleryAnchor | null;
export function restoreRenderedGalleryAnchor(
  root: HTMLElement, anchor: GalleryAnchor, effectiveVisibleTop: number,
): 'item' | 'fallback';
~~~

'ManagerGalleryWorkspaceHandle' adds:

~~~ts
captureAnchor(mode: GalleryMode): GalleryAnchor | null;
restoreAnchor(mode: GalleryMode, anchor: GalleryAnchor): 'item' | 'fallback';
focusCompleteExport(): void;
focusGuestGallerySettingsAction(): void;
setGuestGalleryFilter(filter: PublicationFilter): void;
~~~

- [ ] **Step 1: Write failing DOM tests**

Render ordered 'data-gallery-anchor-id' elements with mocked rectangles. Assert the first item whose bottom crosses the obstruction is captured, neighbors are bounded, exact/alternating fallback works, 'viewportOffset' is restored, and raw fallback scroll is clamped to document bounds.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/gallery-anchor.test.ts
~~~

Expected: FAIL because the helper and anchor attributes do not exist.

- [ ] **Step 3: Implement capture/restore and child reporters**

Add 'data-gallery-anchor-id={photo.id}' to Library and Guest-gallery item roots and 'data-gallery-anchor-id={entryKey(entry)}' to Album list items. Each child keeps a root ref; Workspace delegates only to the requested mode.

~~~ts
const item = elements.find((element) =>
  element.getBoundingClientRect().bottom > effectiveVisibleTop);
const viewportOffset = Math.round(
  item.getBoundingClientRect().top - effectiveVisibleTop,
);
~~~

Restoration tries 'anchorCandidateIds(anchor)' against rendered elements and otherwise scrolls to 'Math.min(Math.max(0, fallbackScrollY), maxScrollY)' with instant behavior.

- [ ] **Step 4: Run focused coverage and verify GREEN**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/gallery-anchor.test.ts tests/ui/host-private-gallery.test.tsx tests/ui/album-workspace.test.tsx
~~~

- [ ] **Step 5: Commit**

~~~bash
git add src/features/gallery/gallery-anchor.ts src/features/gallery/GalleryTimeline.tsx src/features/gallery/ManagerPrivateGallery.tsx src/features/gallery/ManagerSharedGallery.tsx src/features/gallery/ManagerAlbum.tsx src/features/gallery/ManagerGalleryWorkspace.tsx tests/ui/gallery-anchor.test.ts
git commit -m "feat: expose bounded gallery anchors"
~~~

---

### Task 3: Router-owned capture and generation-safe restoration

**Files:**
- Modify: 'src/pages/ManagerPage.tsx'
- Modify: 'tests/ui/app.test.tsx'
- Create: 'tests/e2e/manager-navigation-intents.spec.ts'

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: each outgoing Gallery history entry carries its bounded anchor; a returning mode restores only after adoption and one animation frame.

- [ ] **Step 1: Write failing Manager tests**

Add the four named tests below. In the first, drive the real mode controls and History Back, then inspect both Router state and the restored tile offset:

~~~ts
it('captures a Library anchor before Guest gallery and restores it after Back', async () => {
  let frame: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  }));
  const tile = document.querySelector<HTMLElement>('[data-photo-id="p21"]')!;
  const effectiveTop = () => Math.max(
    document.querySelector<HTMLElement>('.manager-nav')!.getBoundingClientRect().bottom,
    document.querySelector<HTMLElement>('.gallery-control-row')?.getBoundingClientRect().bottom ?? 0,
  );
  const before = tile.getBoundingClientRect().top - effectiveTop();
  await user.click(screen.getByRole('button', { name: 'Guest gallery' }));
  expect((router.state.location.state as RouterHistoryState)
    .__candidaryManager?.anchors?.library?.kind).toBe('media');
  await router.navigate(-1);
  act(() => { frame?.(0); });
  expect(tile.getBoundingClientRect().top - effectiveTop()).toBe(before);
});
~~~

The other tests are named `uses nearby rendered IDs then clamped scroll without fetching`, `captures Library and Guest-gallery anchors before Back or Forward adopts another location`, and `cancels queued Gallery restoration after a newer adoption`. Mock animation frames, item rectangles, scroll, and document bounds. Assert state content, alternating fallback order, unchanged Gallery GET count, clamped fallback, and no stale scroll after the generation changes.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t "captures a Library anchor|uses nearby rendered IDs|captures Library and Guest-gallery anchors|cancels queued Gallery restoration"
~~~

Expected: FAIL because navigation never writes or restores anchors.

- [ ] **Step 3: Integrate without bypassing settlement**

Before every in-app push, replace the current entry with 'withGalleryAnchor(...)'. Expand the predicate and coordinator of the single existing `useBlocker` so Back/Forward from Library, Album, or Guest gallery pauses before adoption, replaces the current entry with its anchor through an explicitly authorized same-location replace, and only then proceeds. Preserve the current Settings, Appearance, RSVP, and Album settlement checks before that proceed; anchor capture never authorizes work they rejected. Pass a cloned sanitized envelope into the target 'navigate(..., { state })'. On adoption, consume state before side effects, increment a restoration generation, then restore after one frame.

~~~ts
const generation = ++galleryRestorationGeneration.current;
requestAnimationFrame(() => {
  if (generation !== galleryRestorationGeneration.current) return;
  galleryWorkspace.current?.restoreAnchor(galleryMode, anchor);
});
~~~

Keep the existing top reset for ordinary cross-section adoption with no valid returning anchor.

- [ ] **Step 4: Run focused tests and verify GREEN**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/manager-history-state.test.ts tests/ui/gallery-anchor.test.ts tests/ui/app.test.tsx
~~~

- [ ] **Step 5: Add the browser Back regression**

Load at least 96 Library rows, scroll a named tile beneath the sticky obstruction, switch to shorter Guest gallery, invoke Back, and assert the same tile returns within one CSS pixel of its prior effective offset without another page fetch.

~~~bash
npx playwright test tests/e2e/manager-navigation-intents.spec.ts --project=desktop -g "deep Library anchor survives Guest gallery and Back"
~~~

- [ ] **Step 6: Commit C-44**

~~~bash
git add src/pages/ManagerPage.tsx tests/ui/app.test.tsx tests/e2e/manager-navigation-intents.spec.ts
git commit -m "feat: restore gallery history anchors"
~~~

---

### Task 4: Share export and Recently deleted intents

**Files:**
- Modify: 'src/pages/ManagerPage.tsx'
- Modify: 'src/features/gallery/GalleryExportControl.tsx'
- Modify: 'src/features/gallery/ManagerAlbum.tsx'
- Modify: 'src/features/gallery/ManagerGalleryWorkspace.tsx'
- Modify: 'tests/ui/app.test.tsx'
- Modify: 'tests/ui/album-workspace.test.tsx'
- Modify: 'tests/e2e/manager-navigation-intents.spec.ts'

**Interfaces:**
- Share pushes 'focus-complete-export'.
- 'ManagerAlbum.onOpenRecentlyDeleted' changes to '(mediaId: string) => void'.
- Gallery's complete-export region exposes an imperative focus method without owning export state.

- [ ] **Step 1: Write failing one-use tests**

Cover export loading, failure, trusted zero, another active job, and enabled action. Cover a retained row present on the first trash page, absent with a later cursor, malformed/cross-event state, Back, and reload.

~~~ts
expect(screen.getByRole('region', { name: 'Complete export' })).toHaveFocus();
expect(screen.getByRole('button', { name: 'Restore retained-photo.jpg' })).toHaveFocus();
expect(screen.getByText(/may be under Load more/u)).toBeVisible();
~~~

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx -t "complete export intent|retained marker intent"
~~~

- [ ] **Step 3: Implement the exact paths**

Wrap the existing export contents in one labelled 'tabIndex={-1}' region. Focus it while the resource loads, fails, is empty, or its action is disabled; move to the exact enabled action only after it renders.

Share's action pushes canonical Library with 'focus-complete-export'. The retained-slot action supplies its opaque media ID; Intake consumes before focus, selects Recently deleted, and focuses its first bounded page's Restore control or the heading with the Load-more guidance.

- [ ] **Step 4: Run focused coverage and verify GREEN**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/manager-history-state.test.ts tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/ui/manager-recovery.test.tsx
npx playwright test tests/e2e/manager-navigation-intents.spec.ts --project=desktop -g "Share opens complete export|retained Album slot opens Recently deleted"
~~~

- [ ] **Step 5: Commit**

~~~bash
git add src/pages/ManagerPage.tsx src/features/gallery/GalleryExportControl.tsx src/features/gallery/ManagerAlbum.tsx src/features/gallery/ManagerGalleryWorkspace.tsx tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/e2e/manager-navigation-intents.spec.ts
git commit -m "feat: preserve manager task intents"
~~~

---

### Task 5: Guest-gallery Settings round trip

**Files:**
- Modify: 'src/pages/ManagerPage.tsx'
- Modify: 'src/components/EventSettingsEditor.tsx'
- Modify: 'src/features/gallery/ManagerGalleryWorkspace.tsx'
- Modify: 'src/features/gallery/ManagerSharedGallery.tsx'
- Modify: 'tests/ui/app.test.tsx'
- Modify: 'tests/ui/event-settings-editor.test.tsx'
- Modify: 'tests/ui/host-private-gallery.test.tsx'
- Modify: 'tests/e2e/manager-navigation-intents.spec.ts'

**Interfaces:**
- 'ManagerSharedGallery.onOpenSettings(status: PublicationFilter): void'.
- 'EventSettingsEditor' accepts 'galleryVisibilityFocusEpoch: number'.
- Settings retains one valid return value only for that mounted visit.
- `ManagerSharedGallery` exposes the existing `all` query state as a literal **All** `aria-pressed` filter control so every valid `PublicationFilter` has a host-reachable state.

- [ ] **Step 1: Write failing round-trip tests**

First assert **All**, Unpublished, Published, and Hidden are host-reachable filter buttons and that **All** requests the unfiltered collection. From Hidden Guest gallery, press Open settings; assert the availability checkbox is focused. Start a deferred Settings save and press Return; assert navigation waits. Then assert Hidden and the existing Settings action are restored and focused. Back must not replay a consumed intent; unrelated navigation clears the task.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/event-settings-editor.test.tsx tests/ui/host-private-gallery.test.tsx -t "Guest gallery Settings|availability focus|Return to Guest gallery"
~~~

- [ ] **Step 3: Implement the round trip**

Add **All** to the current filter-tab map without changing workspace query ownership: `all` omits the `status` parameter as it already does in the resource loader. Manager pushes Settings with the current filter, consumes before focusing, and renders:

~~~tsx
<button type="button" className="button button--secondary" onClick={returnToGuestGallery}>
  Return to Guest gallery
</button>
~~~

The return path flushes current Settings/Appearance work, uses the existing settlement boundary, pushes Guest gallery with the same intent, restores its filter, consumes again, and focuses the existing Open settings action. Announce selection reset; never serialize selection.

- [ ] **Step 4: Run focused coverage and verify GREEN**

~~~bash
npx vitest run --config vitest.config.ts tests/unit/manager-history-state.test.ts tests/ui/app.test.tsx tests/ui/event-settings-editor.test.tsx tests/ui/host-private-gallery.test.tsx
npx playwright test tests/e2e/manager-navigation-intents.spec.ts --project=desktop -g "Guest gallery Settings round trip restores Hidden and focus"
~~~

- [ ] **Step 5: Commit**

~~~bash
git add src/pages/ManagerPage.tsx src/components/EventSettingsEditor.tsx src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/ManagerSharedGallery.tsx tests/ui/app.test.tsx tests/ui/event-settings-editor.test.tsx tests/ui/host-private-gallery.test.tsx tests/e2e/manager-navigation-intents.spec.ts
git commit -m "feat: return to guest gallery work"
~~~

---

### Task 6: C-44/C-45 evidence and checkpoint gates

**Files:**
- Modify: 'docs/superpowers/host-gallery-verification-matrix.md'

**Interfaces:**
- Produces matrix rows for C-44 and C-45 with exact owning test names.

- [ ] **Step 1: Record only C-44 and C-45**

C-44 names rendered-ID anchor restoration, bounded fallbacks, generation cancellation, and no fetching. C-45 names all three consumed-before-focus task paths. Leave other Slice 4 findings unclaimed.

- [ ] **Step 2: Run complete checkpoint gates**

~~~bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npx vitest run --config vitest.config.ts tests/unit/manager-history-state.test.ts tests/unit/manager-location.test.ts tests/unit/recovery.test.ts tests/ui/gallery-anchor.test.ts tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/ui/event-settings-editor.test.tsx tests/ui/host-private-gallery.test.tsx tests/ui/manager-recovery.test.tsx
npx playwright test tests/e2e/manager-navigation-intents.spec.ts --project=desktop
npm test
npm run build
git diff --check
~~~

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 3: Commit the matrix record**

~~~bash
git add docs/superpowers/host-gallery-verification-matrix.md
git commit -m "docs: record gallery continuity evidence"
~~~

Do not push. The next independent Slice 4 checkpoint is viewer page continuity.

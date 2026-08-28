# Host Gallery Responsive and Reorder Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Keep the first Library photo in the initial 390 px phone viewport, separate every 320 px Manager label, and make Album keyboard reorder retain the invoked control with a complete announcement.

**Architecture:** Preserve the existing Manager and Gallery information architecture while compacting only secondary Gallery explanation and export detail behind native disclosures. A narrow Gallery control row remains directly reachable and sticky; Manager navigation keeps all six labels by changing topology only at 360 px and below. Album reorder stores entry plus direction, keeps boundary direction controls focusable with 'aria-disabled', and announces item identity plus position.

**Tech Stack:** TypeScript, React 19, CSS, Vitest, Testing Library, Playwright

**Spec:** 'docs/superpowers/specs/2026-08-23-host-gallery-navigation-responsive-accessibility-design.md'

## Global Constraints

- Preserve the Quiet Event Ledger visual system, existing tokens, six Manager destinations, three Gallery modes, copy meaning, and data ownership.
- At 390 by 844 CSS pixels, the first Library photo must start before pixel 844 and intersect the initial viewport without scrolling.
- At 320 by 844 CSS pixels, all six navigation controls remain at least 44 by 44; labels retain at least 14 px text and every visible pair has an empty intersection.
- Gallery modes remain full-width stacked 44 px controls at 320 when necessary; they may form one compact row at 390.
- No reviewed destination gains page-level horizontal overflow, sticky overlap, a target below 44 px, or a 200 percent reflow regression.
- Album reorder keeps focus on the invoked directional control and announces the item name plus 'position N of M'.
- Do not add a new navigation owner, alternate mobile codebase, device sniffing, hidden core function, decorative motion, or new breakpoint above the existing content-driven bands.
- Browser emulation is layout evidence only; physical iPhone/Safari, Android/Chrome, VoiceOver, and TalkBack remain release-time gates.
- Browser plugin is absent in this session; use the repository Playwright workflow and record that reason.
- Before UI edits, load Impeccable's 'adapt' playbook and 'craft-floor'; after the final UI change run its detector once.
- Every behavior change follows RED -> GREEN -> REFACTOR; observe the intended RED before production edits.
- Work only in '/home/henry/candidary/.worktrees/gallery-roadmap-remediation'; do not push, deploy, merge, or open a PR.

## File Structure

- Keep reorder state and focus in 'src/features/gallery/ManagerAlbum.tsx'.
- Keep Gallery structure in 'src/features/gallery/ManagerGalleryWorkspace.tsx' and export presentation in 'GalleryExportControl.tsx'.
- Keep responsive rules in 'src/styles.css'; do not create a parallel stylesheet.
- Extend geometry assertions in 'tests/e2e/manager-responsive.spec.ts' and the current keyboard flow in 'tests/e2e/album-workspace.visual.spec.ts'.

---

### Task 1: Direction-stable Album keyboard reorder

**Files:**
- Modify: 'src/features/gallery/ManagerAlbum.tsx'
- Modify: 'src/styles.css'
- Modify: 'tests/ui/album-workspace.test.tsx'
- Modify: 'tests/e2e/album-workspace.visual.spec.ts'

**Interfaces:**
- Replace the key-only refocus request with:

~~~ts
type ReorderDirection = 'earlier' | 'later';
type ReorderFocusRequest = { entryKey: string; direction: ReorderDirection };
~~~

- 'move(from, to, direction)' records the invoked direction and emits a named message.

- [ ] **Step 1: Replace the incorrect unit expectation**

Replace 'keeps keyboard focus on an enabled move control at both order boundaries' with:

~~~ts
it('keeps the invoked reorder direction focused and announces item plus position', async () => {
  const earlier = await screen.findByRole('button', { name: 'Move p2.jpg earlier' });
  earlier.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(
    screen.getByRole('button', { name: 'Move p2.jpg earlier' }),
  ).toHaveFocus());
  expect(screen.getAllByRole('status').some((status) =>
    status.textContent === 'p2.jpg moved to position 1 of 2.')).toBe(true);
});
~~~

Assert the boundary control has 'aria-disabled=\"true\"' and a second Enter sends no save or announcement.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t "keeps the invoked reorder direction"
~~~

Expected: FAIL because focus moves to the opposite enabled arrow and copy omits the item name.

- [ ] **Step 3: Implement exact direction retention**

Store '{ entryKey, direction }'. Direction buttons use 'aria-disabled' at a boundary instead of native 'disabled', guard their handlers, and remain focusable. Keep native disabled semantics for unrelated pending controls.

~~~tsx
const unavailable = direction === 'earlier'
  ? index === 0
  : index === draft.entries.length - 1;
<button
  type="button"
  aria-disabled={unavailable}
  onClick={() => {
    if (unavailable) return;
    move(index, direction === 'earlier' ? index - 1 : index + 1, direction);
  }}
/>
~~~

The refocus effect queries the exact direction class for the same entry. Capture the moved entry before reordering and name it with the existing `entryName(entry)` helper. Announce:

~~~ts
const movedName = entryName(draft.entries[from]!);
setAnnouncement(movedName + ' moved to position ' + (to + 1) + ' of ' + entries.length + '.');
~~~

Style '[aria-disabled=\"true\"]' with the existing disabled opacity/cursor treatment.

- [ ] **Step 4: Update and run the real-browser keyboard trace**

Replace the visual trace's current exact `Moved to position 2 of 10.` status and its Earlier-control focus expectation with `${firstEntryName} moved to position 2 of 10.` and the originally invoked Later control on the moved entry.

~~~bash
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx -t "reorder|move control|position"
npx playwright test tests/e2e/album-workspace.visual.spec.ts --project=desktop -g "album mode is keyboard-operable and respects reduced motion"
~~~

- [ ] **Step 5: Commit**

~~~bash
git add src/features/gallery/ManagerAlbum.tsx src/styles.css tests/ui/album-workspace.test.tsx tests/e2e/album-workspace.visual.spec.ts
git commit -m "fix: retain album reorder focus"
~~~

---

### Task 2: 390 px Gallery fold and compact control row

**Files:**
- Modify: 'src/features/gallery/ManagerGalleryWorkspace.tsx'
- Modify: 'src/features/gallery/GalleryExportControl.tsx'
- Modify: 'src/styles.css'
- Modify: 'tests/e2e/helpers/geometry.ts'
- Modify: 'tests/e2e/manager-responsive.spec.ts'

**Interfaces:**
- 'gallery-control-row' contains the existing mode switch and fresh audience summary and is a direct child of the Gallery section.
- 'gallery-context-disclosure' owns mode explanation and live-link consequence copy.
- 'gallery-export__details' owns only the descriptive scope copy; Download/Prepare/Retry stays direct.
- `measureFoldBelowObstructions(target, obstructions, viewportHeight)` reports target bounds, the effective visible top below sticky obstructions, and visible height without changing the shared `measureFold(page, locator)` signature used by other suites.

- [ ] **Step 1: Write the failing fold test**

~~~ts
test('Library first photo intersects the initial 390 by 844 viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubManagerRoutes(page, {
    mediaPages: { first: { media: makeMedia(6), nextCursor: null } },
    event: { storedMediaCount: 6 },
    exports: [],
  });
  await page.goto(managerUrl);
  await destination(page, 'Gallery').click();
  const fold = await measureFoldBelowObstructions(
    page.locator('.gallery-mosaic__item').first(),
    [page.locator('.manager-nav'), page.locator('.gallery-control-row')],
    844,
  );
  expect(fold.top).toBeLessThan(844);
  expect(fold.top).toBeGreaterThanOrEqual(fold.effectiveVisibleTop);
  expect(fold.visibleHeight).toBeGreaterThanOrEqual(44);
});
~~~

Add and import this helper; leave the existing `measureFold(page, locator)` and all of its callers untouched:

~~~ts
export async function measureFoldBelowObstructions(
  target: Locator,
  obstructions: readonly Locator[],
  viewportHeight: number,
) {
  const [targetBox, ...obstructionBoxes] = await Promise.all([
    target.boundingBox(),
    ...obstructions.map((locator) => locator.boundingBox()),
  ]);
  if (!targetBox || obstructionBoxes.some((box) => box === null)) {
    throw new Error('Fold measurement requires every target and obstruction to be visible.');
  }
  const effectiveVisibleTop = Math.max(
    0,
    ...obstructionBoxes.map((box) => box!.y + box!.height),
  );
  const top = targetBox.y;
  const bottom = top + targetBox.height;
  return {
    top,
    bottom,
    effectiveVisibleTop,
    visibleHeight: Math.max(
      0,
      Math.min(bottom, viewportHeight) - Math.max(top, effectiveVisibleTop),
    ),
  };
}
~~~

Also assert 44 px mode controls, no horizontal overflow, and the first tile clears both sticky obstructions.

- [ ] **Step 2: Run and verify RED**

~~~bash
npx playwright test tests/e2e/manager-responsive.spec.ts --project=mobile -g "Library first photo intersects"
~~~

Expected: FAIL with the first tile below the fold.

- [ ] **Step 3: Restructure only Gallery chrome**

Move the existing mode switch and audience summary into a direct-child 'gallery-control-row'. Put 'MODE_NOTES[mode]' and Album-link live consequence inside one native disclosure:

~~~tsx
<details className="gallery-context-disclosure">
  <summary>About this Gallery view</summary>
  <p>{MODE_NOTES[mode]}</p>
  {albumLinkLiveCopy}
</details>
~~~

In 'GalleryExportControl', keep every action direct and wrap only its explanatory paragraph:

~~~tsx
<details className="gallery-export__details">
  <summary>What the complete download includes</summary>
  <p className="gallery-export__copy">{scopeCopy}</p>
</details>
~~~

Add keyboard assertions for both new summaries: each is at least 44 px high, Enter toggles `open`, its detail content is not visible while collapsed and becomes visible while expanded, and expanding it neither introduces horizontal overflow nor covers the first tile. The named Axe fixtures scan the resulting visible tree; do not claim a separate accessibility-tree snapshot unless the harness actually captures one.

- [ ] **Step 4: Apply the mobile-first layout**

At 390 use one three-column mode row, compact gaps, and a sticky opaque control row below the Manager header. At 360 and below stack the three modes and account for the now two-row Manager navigation with a shared sticky offset.

~~~css
.manager-shell {
  --manager-sticky-offset: 111px;
  --gallery-control-obstruction: 96px;
}
.gallery-control-row { display: grid; gap: 8px; }
@media (max-width: 760px) {
  .gallery-control-row {
    position: sticky;
    top: var(--manager-sticky-offset);
    z-index: 4;
    padding: 6px 0 8px;
    background: var(--paper);
  }
  .gallery-moment__heading h3,
  .gallery-mosaic__open,
  .gallery-mosaic__favorite,
  .gallery-moment__toggle {
    scroll-margin-top: calc(
      var(--manager-sticky-offset) + var(--gallery-control-obstruction) + 12px
    );
  }
}
@media (max-width: 360px) {
  .manager-shell {
    --manager-sticky-offset: 169px;
    --gallery-control-obstruction: 190px;
  }
  .gallery-mode-switch--three { grid-template-columns: 1fr; }
}
~~~

Move the exact `.gallery-mode-switch--three { grid-template-columns: 1fr; }` rule from the current `max-width: 760px` query into `max-width: 360px`; do not delete unrelated responsive rules. Validate the two obstruction variables against the rendered 390 and 320 fixture rectangles and increase them if the sticky stack is taller. Do not hide audience state, search, order, selection, or the first photo.

- [ ] **Step 5: Run and verify GREEN**

~~~bash
npx playwright test tests/e2e/manager-responsive.spec.ts --project=mobile -g "Library first photo intersects|mobile Library tray"
npx playwright test tests/e2e/album-workspace.visual.spec.ts --project=mobile
~~~

- [ ] **Step 6: Commit**

~~~bash
git add src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/GalleryExportControl.tsx src/styles.css tests/e2e/helpers/geometry.ts tests/e2e/manager-responsive.spec.ts
git commit -m "fix: compact mobile gallery controls"
~~~

---

### Task 3: Collision-free 320 px Manager labels

**Files:**
- Modify: 'src/styles.css'
- Modify: 'tests/e2e/helpers/geometry.ts'
- Modify: 'tests/e2e/manager-responsive.spec.ts'

**Interfaces:**
- Produces:

~~~ts
export async function boxesIntersect(first: Locator, second: Locator): Promise<boolean>;
~~~

- [ ] **Step 1: Write the pairwise collision assertion**

At 320 by 844 collect six visible labels and assert every pair is disjoint while retaining target size, 14 px text, count visibility, and containment.

~~~ts
for (let first = 0; first < labels.length; first += 1) {
  for (let second = first + 1; second < labels.length; second += 1) {
    expect(
      await boxesIntersect(labels[first]!, labels[second]!),
      DESTINATIONS[first] + ' and ' + DESTINATIONS[second] + ' labels',
    ).toBe(false);
  }
}
~~~

- [ ] **Step 2: Run and verify RED**

~~~bash
npx playwright test tests/e2e/manager-responsive.spec.ts --project=mobile -g "320 Manager navigation labels do not intersect"
~~~

- [ ] **Step 3: Change topology only at 360 px and below**

Use two rows of three destinations, preserve source order, keep targets at least 58 px high, and retain the shared 169 px Manager offset from Task 2. Assert the Gallery control row begins at or below the Manager-nav bottom and update heading and mosaic-control scroll margins for the taller combined sticky stack.

~~~css
@media (max-width: 360px) {
  .manager-nav nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .manager-nav button { min-height: 58px; }
  .manager-nav__label {
    max-width: 100%;
    line-height: 1.15;
    overflow-wrap: anywhere;
  }
  .manager-panel > h2,
  #intake-title { scroll-margin-top: calc(var(--manager-sticky-offset) + 12px); }
  #gallery-workspace-title {
    scroll-margin-top: calc(
      var(--manager-sticky-offset) + var(--gallery-control-obstruction) + 12px
    );
  }
}
~~~

Keep count text at 12 px or larger and inside its own control. In the 320 test, measure `.manager-nav` and `.gallery-control-row` and assert their rectangles do not intersect.

- [ ] **Step 4: Run all responsive geometry and verify GREEN**

~~~bash
npx playwright test tests/e2e/manager-responsive.spec.ts --project=mobile
~~~

- [ ] **Step 5: Commit**

~~~bash
git add src/styles.css tests/e2e/helpers/geometry.ts tests/e2e/manager-responsive.spec.ts
git commit -m "fix: separate narrow manager labels"
~~~

---

### Task 4: Retained Slice 4 focus and public regressions

**Files:**
- Verify: 'src/features/cover/CoverStudio.tsx'
- Verify: 'src/pages/AlbumSharePage.tsx'
- Verify: 'src/features/gallery/PublicAlbum.tsx'
- Verify: 'tests/ui/cover-studio.test.tsx'
- Verify: 'tests/ui/album-share-page.test.tsx'

**Interfaces:**
- C-21 remains owned by Cover Studio modal containment.
- C-63 remains owned by token-only fragment cleanup that preserves pathname/query and leaves cookie-only URLs untouched.
- C-64 remains owned by cover failure state keyed to the cover media ID.

- [ ] **Step 1: Run the exact retained regressions**

~~~bash
npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx -t "keeps focus inside the sheet|restores focus to what opened it|inerts and scroll-locks"
npx vitest run --config vitest.config.ts tests/ui/album-share-page.test.tsx -t "erases the fragment|reuses the narrow cookie|resets a failed cover"
~~~

Expected: all named tests pass without production changes.

- [ ] **Step 2: Verify source correspondence**

Confirm Cover Studio has 'aria-modal', inert siblings, Tab wrap, and invoker restoration. Confirm AlbumSharePage calls 'replaceState' only for a token fragment and preserves pathname/query. Confirm PublicAlbum keys failed cover state by media ID.

- [ ] **Step 3: Stop on drift**

If any named regression fails or no longer maps to source, use 'superpowers:systematic-debugging' before changing code. Otherwise create no code commit for this task.

---

### Task 5: Rendered QA, detector, matrix, and checkpoint gates

**Files:**
- Modify: 'docs/superpowers/host-gallery-verification-matrix.md'
- Inspect: all UI files changed in Tasks 1-3

**Interfaces:**
- Produces matrix rows for C-21, C-23, C-27, C-43, C-63, and C-64.

- [ ] **Step 1: Run the Impeccable detector once**

~~~bash
node /home/henry/.agents/skills/impeccable/scripts/detect.mjs --json src/features/gallery/ManagerAlbum.tsx src/features/gallery/ManagerGalleryWorkspace.tsx src/features/gallery/GalleryExportControl.tsx src/styles.css
~~~

Expected: no unresolved finding attributable to this checkpoint.

- [ ] **Step 2: Run one bounded rendered QA pass**

The flow under test is: Manager Gallery at 390 -> Library controls and first photo -> Album keyboard reorder; then Manager at 320 -> all six destinations.

Run mobile and desktop Playwright projects, inspect console output, and save temporary screenshots outside the repository. Confirm page identity, nonblank render, no framework overlay, console health, first-fold geometry, interaction proof, and no target/overflow regression. Record Browser plugin not available. Physical devices and assistive technology remain NEEDS RUN.

- [ ] **Step 3: Add matrix rows**

Record C-23, C-27, and C-43 as implemented with their owning tests. Record C-21, C-63, and C-64 as implemented by existing roadmap changes and exact retained regressions. Leave C-37 and C-46 to their checkpoints.

- [ ] **Step 4: Run complete checkpoint gates**

~~~bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npx vitest run --config vitest.config.ts tests/ui/album-workspace.test.tsx tests/ui/cover-studio.test.tsx tests/ui/album-share-page.test.tsx
npx playwright test tests/e2e/manager-responsive.spec.ts tests/e2e/album-workspace.visual.spec.ts
npm test
npm run build
git diff --check
~~~

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 5: Commit the evidence**

~~~bash
git add docs/superpowers/host-gallery-verification-matrix.md
git commit -m "docs: record responsive gallery evidence"
~~~

Do not push. The final independent Slice 4 checkpoint is the named Axe fixture matrix.

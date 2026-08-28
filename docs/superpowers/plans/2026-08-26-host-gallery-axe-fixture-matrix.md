# Host Gallery Named Axe Fixture Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Close C-37 with deterministic, named Axe fixtures for every Slice 4 Manager, Gallery, confirmation, and public Album state while keeping geometry and modal behavior under their existing dedicated assertions.

**Architecture:** `tests/e2e/accessibility.spec.ts` remains the single accessibility-matrix owner and reuses its full-document `expectNoAxeViolations()` helper. A typed fixture inventory gives every required state a stable name, an explicit setup action, and a readiness predicate before the scan. `stubManagerRoutes()` gains only narrow deterministic response controls that several fixtures genuinely share; one-off state is scoped to its test so the repository's default Manager fixture stays unchanged.

**Tech Stack:** TypeScript, Playwright, Axe Core 4.12.1, React 19

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-navigation-responsive-accessibility-design.md`

## Global Constraints

- Scan the whole rendered document with the existing Axe default rules plus explicitly enabled `target-size`; do not add `runOnly`, exclusions, disabled rules, or narrowed selectors.
- A fixture is evidence only after its named state has rendered and its readiness predicate passes. Merely navigating to a route is not evidence.
- Keep the 44 by 44 target floor, 320/390 geometry, focus containment, keyboard traces, and 200 percent reflow in their existing non-Axe tests. Axe's 24 px target rule does not replace them.
- Cover exactly: Intake default, filtered, and Recently deleted; RSVP; Library default, selection, tray, and viewer; Album editor, Preview, create-link dialog, live-link state, and stop-link alertdialog; Guest gallery all, unpublished, published, and hidden filters plus single-write and bulk-write states; Guestbook; Share; Settings; Album-leave prompt; RSVP/settings pending-work prompt; move-to-Recently-deleted dialog; entry rotation and disable confirmations; public Album nonempty and empty.
- Host upload is explicitly Slice 5 and must not be added to or claimed by this checkpoint.
- Prefer existing route fixtures and UI actions. Add a route option only when multiple named states need the same deterministic backend condition.
- Do not commit screenshots, HTML reports, traces, videos, or generated Axe output. Playwright artifacts remain ignored and temporary.
- If a named scan finds a real violation, stop matrix expansion, load `superpowers:systematic-debugging`, reproduce with the smallest named fixture, add a focused failing assertion, and make the minimal production fix in a separate commit.
- Browser plugin is absent in this session; use the repository Playwright workflow and record that limitation. Physical VoiceOver, TalkBack, iPhone/Safari, and Android/Chrome remain release-time `NEEDS RUN` gates.
- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation`; do not push, deploy, merge, or open a PR.

## File Structure

- Keep the matrix, descriptor type, readiness helpers, and scans in `tests/e2e/accessibility.spec.ts`.
- Modify `tests/e2e/fixtures/routes.ts` only for reusable, typed fixture controls that cannot be expressed through existing options.
- Modify production UI or `src/styles.css` only after an observed named-fixture violation and its focused RED assertion.
- Record C-37 and retained Slice 4 coverage in `docs/superpowers/host-gallery-verification-matrix.md` only after every named fixture passes.

---

### Task 1: Executable fixture inventory and readiness contract

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts` only if a reusable deterministic route state is missing

**Interfaces:**
- Produces:

~~~ts
const REQUIRED_MANAGER_AXE_FIXTURES = [
  'Intake default', 'Intake filtered', 'Intake Recently deleted', 'RSVP',
  'Library default', 'Library selection', 'Library selection tray', 'Library viewer',
  'Album editor', 'Album Preview', 'Album create-link dialog', 'Album live-link state',
  'Album stop-link alertdialog', 'Guest gallery all', 'Guest gallery unpublished',
  'Guest gallery published', 'Guest gallery hidden', 'Guest gallery single-write',
  'Guest gallery bulk-write', 'Guestbook', 'Share', 'Settings', 'Album-leave prompt',
  'RSVP pending-work prompt', 'Settings pending-work prompt',
  'Move to Recently deleted dialog', 'Entry rotation confirmation',
  'Entry disable confirmation',
] as const;

type ManagerAxeFixtureName = typeof REQUIRED_MANAGER_AXE_FIXTURES[number];
type ManagerAxeFixture = {
  name: ManagerAxeFixtureName;
  setup(page: Page): Promise<void>;
  ready(page: Page): Promise<void>;
  cleanup?(page: Page): Promise<void>;
};

async function scanManagerFixture(page: Page, fixture: ManagerAxeFixture) {
  try {
    await fixture.setup(page);
    await fixture.ready(page);
    await expectNoAxeViolations(page, fixture.name);
  } finally {
    await fixture.cleanup?.(page);
  }
}
~~~

- [ ] **Step 1: Add one failing named-fixture harness test**

Define the readonly name tuple and derived union above. Add the first descriptor and registry loop before `scanManagerFixture` exists:

~~~ts
const MANAGER_AXE_FIXTURES: ManagerAxeFixture[] = [{
  name: 'Intake default',
  async setup(page) {
    await stubManagerRoutes(page, {
      mediaPages: { first: { media: makeMedia(3), nextCursor: null } },
    });
    await openManagerSection(page, 'Intake');
  },
  ready: (page) => readyHeading(page, 'Live intake'),
}];

for (const fixture of MANAGER_AXE_FIXTURES) {
  test(`${fixture.name} is axe-clean`, async ({ page }) => {
    await scanManagerFixture(page, fixture);
  });
}
~~~

- [ ] **Step 2: Run the first fixture and verify RED**

~~~bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "Intake default is axe-clean"
~~~

Expected: TypeScript/Playwright FAIL because the new runner/readiness helpers do not exist yet.

- [ ] **Step 3: Add explicit readiness helpers**

Use role/name assertions for state identity and wait for state-specific network work before returning. Do not use a generic timeout.

~~~ts
async function readyHeading(page: Page, name: string | RegExp) {
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

async function readyModal(page: Page, role: 'dialog' | 'alertdialog', name: string | RegExp) {
  await expect(page.getByRole(role, { name })).toBeVisible();
}

async function openManagerSection(page: Page, name: typeof MANAGER_SECTIONS[number]['name']) {
  await page.goto(`/manage/event/${EVENT_FIXTURE.id}`);
  if (name !== 'Intake') {
    await page.getByRole('navigation', { name: 'Manager sections' })
      .getByRole('button', { name }).click();
  }
}

async function openGalleryMode(page: Page, mode: 'Library' | 'Album' | 'Guest gallery') {
  await openManagerSection(page, 'Gallery');
  await page.getByRole('group', { name: 'Gallery mode' })
    .getByRole('button', { name: mode }).click();
}
~~~

Every descriptor installs its own `stubManagerRoutes()` state before calling these navigation-only helpers; do not hide route setup inside them or let fixtures share mutable response state.

- [ ] **Step 4: Run the first fixture and verify GREEN**

Run Step 2 again. Expected: `Intake default is axe-clean` exits zero.

- [ ] **Step 5: Commit the green harness**

~~~bash
git add tests/e2e/accessibility.spec.ts tests/e2e/fixtures/routes.ts
git commit -m "test: define named gallery axe fixtures"
~~~

If `tests/e2e/fixtures/routes.ts` did not change, omit it from `git add`.

---

### Task 2: Intake, RSVP, Settings, and confirmation fixtures

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts` only for typed pending, trash, or confirmation response controls shared by fixtures

**Interfaces:**
- Adds descriptors for Intake default, filtered, Recently deleted, RSVP, Settings, separate RSVP and Settings pending-work prompt states, move-to-Recently-deleted dialog, entry rotation confirmation, and entry disable confirmation.
- Adds `trashedMedia?: readonly ManagerTrashedMediaView[]` to the Manager route options and serves `{ media: trashedMedia, nextCursor: null }` from `GET /api/manage/events/:eventId/media/trash`; the current generic fixture does not serve Recently deleted.

- [ ] **Step 1: Add the ten descriptors with exact setup actions**

For each descriptor, enter through the Manager UI, perform the action that creates the named state, and assert a unique visible marker before scanning. The filtered fixture must prove the filter control's value and a filtered row; Recently deleted must prove that recovery view, not ordinary Intake.

~~~ts
{
  name: 'Intake Recently deleted',
  async setup(page) {
    await openManagerSection(page, 'Intake');
    await page.getByRole('button', { name: 'Recently deleted' }).click();
  },
  async ready(page) {
    await expect(page.getByRole('heading', { name: 'Recently deleted' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Restore/u }).first()).toBeVisible();
  },
}
~~~

The two pending-work scans may share setup helpers, but one must originate from dirty RSVP work and prove the inline region headed **Your pending work is not saved**; the other must originate from dirty Settings work and prove the `UnsavedSettingsPrompt` region with its Settings-specific domain copy. Both regions must be focused before scanning. Scan move-to-Recently-deleted in its modal dialog. Entry rotation and entry disable are current inline, event-name confirmation fieldsets; prove each fieldset's legend, input, and still-disabled submit action before scanning. Do not mislabel those two inline confirmations as dialogs.

- [ ] **Step 2: Run the named subset and observe failures**

~~~bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "Intake|RSVP|Settings|Recently deleted|rotation|disable"
~~~

Expected: each named setup reaches its unique marker and every full-document scan exits zero. A readiness or Axe failure is actionable evidence, not a reason to weaken the fixture.

- [ ] **Step 3: Stabilize fixtures without weakening assertions**

Resolve ambiguous locators with a containing region/dialog, wait on the request caused by the action, and keep the full-document scan. Do not add retries, sleeps, Axe exclusions, or global fixture mutations.

- [ ] **Step 4: Commit**

~~~bash
git add tests/e2e/accessibility.spec.ts tests/e2e/fixtures/routes.ts
git commit -m "test: cover manager recovery axe states"
~~~

If the route fixture did not change, omit it from `git add`.

---

### Task 3: Library and Album named fixtures

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts` only for reusable Album share-state responses

**Interfaces:**
- Adds Library default, selection, selection tray, and viewer; Album editor, Preview, create-link dialog, live-link state, stop-link alertdialog, and Album-leave prompt.

- [ ] **Step 1: Add Library fixtures**

Use a deterministic multi-photo Library. Selection proves one selected tile; tray proves the persistent selection tray and its actions; viewer proves the named modal has loaded its current image/fallback and focus containment is ready before the scan.

~~~ts
{
  name: 'Library viewer',
  async setup(page) {
    await openGalleryMode(page, 'Library');
    await page.locator('.gallery-mosaic__open').first().click();
  },
  async ready(page) {
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close viewer' })).toBeFocused();
  },
}
~~~

- [ ] **Step 2: Add Album editor and share-state fixtures**

Populate an Album with at least two entries. Preview must scan the embedded public content. Create-link uses `readyModal(page, 'dialog', ...)`; stop-link uses `readyModal(page, 'alertdialog', ...)`. Live-link must assert the current live URL/action region before scanning.

- [ ] **Step 3: Add the Album-leave fixture**

Make a real draft edit, attempt to leave Album, wait for the existing settlement prompt, and scan while it is open. Do not construct the prompt by injecting component state.

- [ ] **Step 4: Run and verify the entire Gallery/Album subset**

~~~bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "Library|Album"
~~~

Expected: all named fixtures reach their unique readiness marker and every full-document scan passes.

- [ ] **Step 5: Commit**

~~~bash
git add tests/e2e/accessibility.spec.ts tests/e2e/fixtures/routes.ts
git commit -m "test: cover library and album axe states"
~~~

If the route fixture did not change, omit it from `git add`.

---

### Task 4: Guest-gallery filter and write fixtures

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts` only for deterministic deferred publication responses

**Interfaces:**
- Adds Guest gallery all, unpublished, published, hidden, single-write, and bulk-write fixtures.
- Adds `singlePublicationGate?: Promise<void>` beside the existing `bulkPublicationGate` in `AlbumWorkspaceRouteOptions`, plus an exact `PATCH /api/manage/events/:eventId/media/:mediaId` handler registered after the broad Guestbook media fixture. That handler awaits only the single gate, updates `galleryMedia`, and returns the ordinary Manager media projection.

- [ ] **Step 1: Add four exact filter fixtures**

This task depends on the history/intents checkpoint's literal **All** control; stop rather than injecting workspace state if that control is absent. Seed at least one row in every publication category. Select each UI filter and require its `aria-pressed` state plus the expected row before scanning; a heading shared by all filters is not sufficient readiness evidence.

~~~ts
async function readyGuestGalleryFilter(page: Page, filter: string, rowName: RegExp) {
  const group = page.getByRole('group', { name: 'Publication status' });
  await expect(group.getByRole('button', { name: filter, exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.moderation-grid article').filter({ hasText: rowName }).first())
    .toBeVisible();
}
~~~

- [ ] **Step 2: Add single-write and bulk-write fixtures**

Add a typed single-publication gate/handler beside the existing bulk gate; the current generic `PATCH /media/*` fixture does not model Guest-gallery writes. For each fixture, defer the matching publication request, invoke the action, and scan while the write is in flight. Single-write readiness proves the Gallery live status `Publishing <photo title>…` or `Hiding <photo title>…`; current card controls do not expose a pending state. Bulk readiness proves the matching button's busy label/state plus the selection count and bulk controls. Resolve the gate in `cleanup`.

- [ ] **Step 3: Run and verify the Guest-gallery subset**

~~~bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "Guest gallery"
~~~

Expected: six named scans pass without cross-test state leakage.

- [ ] **Step 4: Commit**

~~~bash
git add tests/e2e/accessibility.spec.ts tests/e2e/fixtures/routes.ts
git commit -m "test: cover guest gallery axe states"
~~~

If the route fixture did not change, omit it from `git add`.

---

### Task 5: Guestbook, Share, and public Album fixtures

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts` only for public empty/nonempty Album responses not already expressible

**Interfaces:**
- Completes Manager descriptors with Guestbook and Share.
- Adds two separately named public fixtures: `Public Album nonempty` and `Public Album empty`.
- Produces `REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES = ['Public Album nonempty', 'Public Album empty'] as const` and an exact completeness assertion beside the Manager inventory assertion.

- [ ] **Step 1: Add Guestbook and Share descriptors**

Prove the section-specific heading plus loaded content. For Share, wait for the export resource to settle so the scan does not accidentally cover only a loading placeholder.

- [ ] **Step 2: Add public Album nonempty and empty tests**

For each state, call `stubManagerRoutes()` with `album.shareActive: true`, the known `shareToken`, and the exact entry set, then visit `/album#${shareToken}` so the real exchange and narrow cookie path runs. The nonempty state supplies picked media IDs plus photo entries and proves cover/count/photo content. The empty state supplies `pickedMediaIds: []` and `entries: []`, proves the ordinary Album `h1`, a zero-photo count, and the paragraph **No photos in this Album yet.** Scan the whole public document in both states.

~~~ts
for (const fixture of PUBLIC_ALBUM_AXE_FIXTURES) {
  test(`${fixture.name} is axe-clean`, async ({ page }) => {
    await fixture.setup(page);
    await fixture.ready(page);
    await expectNoAxeViolations(page, fixture.name);
  });
}
~~~

- [ ] **Step 3: Add exact Manager and public completeness assertions**

Assert Manager descriptor names exactly equal `REQUIRED_MANAGER_AXE_FIXTURES` and public descriptor names exactly equal `REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES`; assert each set's size as well, so omission and duplication both fail.

~~~ts
test('the Slice 4 named Axe inventories are complete', () => {
  expect(MANAGER_AXE_FIXTURES.map(({ name }) => name))
    .toEqual([...REQUIRED_MANAGER_AXE_FIXTURES]);
  expect(PUBLIC_ALBUM_AXE_FIXTURES.map(({ name }) => name))
    .toEqual([...REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES]);
  expect(new Set(MANAGER_AXE_FIXTURES.map(({ name }) => name)).size)
    .toBe(REQUIRED_MANAGER_AXE_FIXTURES.length);
  expect(new Set(PUBLIC_ALBUM_AXE_FIXTURES.map(({ name }) => name)).size)
    .toBe(REQUIRED_PUBLIC_ALBUM_AXE_FIXTURES.length);
});
~~~

- [ ] **Step 4: Complete and run the inventories**

~~~bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "named Axe inventories|Guestbook|Share|Public Album"
~~~

Expected: both inventory assertions and every new named scan pass.

- [ ] **Step 5: Commit**

~~~bash
git add tests/e2e/accessibility.spec.ts tests/e2e/fixtures/routes.ts
git commit -m "test: complete gallery axe fixture matrix"
~~~

If the route fixture did not change, omit it from `git add`.

---

### Task 6: C-37 evidence and final Slice 4 gates

**Files:**
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`
- Verify: all Slice 4 code and tests from the four implementation plans

**Interfaces:**
- Produces the C-37 matrix row with exact fixture names and final Slice 4 evidence.
- Confirms every Slice 4 finding has exactly one current matrix row: C-15, C-21, C-23, C-27, C-37, C-43, C-44, C-45, C-46, C-63, and C-64.

- [ ] **Step 1: Audit row completeness before editing**

~~~bash
rg -n 'C-(15|21|23|27|37|43|44|45|46|63|64)' docs/superpowers/host-gallery-verification-matrix.md
~~~

The planning checkout begins with only C-15 recorded. At this final ordered checkpoint, the history, viewer, and responsive plans must have added the other rows they own. Stop if any expected earlier row is still absent, duplicated, or claims evidence that does not exist; do not manufacture it in the Axe checkpoint.

- [ ] **Step 2: Record C-37 with exact evidence**

Name the executable inventory assertion, all Manager descriptors, and public Album empty/nonempty tests. Record physical devices and assistive technology as `NEEDS RUN`; do not call Playwright emulation device evidence.

- [ ] **Step 3: Run final Slice 4 gates**

~~~bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop --project=mobile
npm test
npm run build
git diff --check
~~~

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 4: Commit the evidence**

~~~bash
git add docs/superpowers/host-gallery-verification-matrix.md
git commit -m "docs: complete gallery accessibility matrix"
~~~

- [ ] **Step 5: Stop at the authorized boundary**

Do not push, merge, open a PR, deploy, or run a migration. Report the immutable Slice 4 tip, exact gate results, browser/device coverage limits, and the remaining Slice 5 boundary.

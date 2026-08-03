# Event Start Time Native Input Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the create form's native event start-time control inside its field under iOS WebKit sizing.

**Architecture:** Extend the create form's existing native date-control compatibility rule to the paired time control. Protect the behavior with the existing real-browser iOS sizing simulation, measuring rendered control bounds rather than inspecting CSS text.

**Tech Stack:** React, CSS, TypeScript, Playwright

## Global Constraints

- Scope the CSS change to `.create-field` native date and time inputs.
- Preserve current desktop and Chromium layout, native picker affordances, padding, and touch-target height.
- Do not change schedule values, validation, the manager settings editor, or generic inputs.
- Exercise the production create page and computed layout; do not test CSS source text.
- Preserve all unrelated tracked and untracked working-tree content.

---

### Task 1: Contain the native event start-time control

**Files:**
- Modify: `tests/e2e/public-responsive.spec.ts:134-154`
- Modify: `src/styles.css:196-199`

**Interfaces:**
- Consumes: the create form's accessible labels `Event date` and `Event start time`, plus its `.create-field` grid layout.
- Produces: a layout invariant that each native picker starts and ends within its enclosing label under content-box sizing.

- [ ] **Step 1: Extend the real-browser test so the start-time defect fails**

Replace the date-only containment test with the paired native-control test:

```ts
test('native event date and start time stay inside their fields under iOS sizing', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/create');

  // iOS WebKit currently sizes a padded native picker with a percentage width as though its content
  // box owned that percentage. Reproduce that layout calculation without replacing the real fields.
  await page.addStyleTag({
    content: 'input[type="date"], input[type="time"] { box-sizing: content-box; }',
  });

  for (const label of ['Event date', 'Event start time']) {
    const field = page.getByLabel(label);
    const fieldBounds = await field.boundingBox();
    const labelBounds = await field.locator('..').boundingBox();
    if (!fieldBounds || !labelBounds) throw new Error(`${label} and its label must be laid out`);

    expect(fieldBounds.x, `${label} starts inside its label`).toBeGreaterThanOrEqual(labelBounds.x);
    expect(fieldBounds.x + fieldBounds.width, `${label} ends inside its label`)
      .toBeLessThanOrEqual(labelBounds.x + labelBounds.width + 1);
  }

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);
});
```

The production change that makes this test fail is removing either native
picker type from the scoped compatibility selector. The expected bounds are
derived from the enclosing label, independently of the production CSS.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx playwright test tests/e2e/public-responsive.spec.ts --project=mobile -g "native event date and start time"
```

Expected: FAIL only for `Event start time ends inside its label`, with the
control's right edge roughly 29 px beyond the label at the 320 px viewport.

- [ ] **Step 3: Extend the existing scoped CSS safeguard**

Update the compatibility comment and selector in `src/styles.css`:

```css
/* iOS WebKit miscalculates a padded native date or time control at width: 100%; grid stretch fills
   each field without invoking that percentage-width path. */
.create-field input[type='date'],
.create-field input[type='time'] { width: auto; min-width: 0; }
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npx playwright test tests/e2e/public-responsive.spec.ts --project=mobile -g "native event date and start time"
```

Expected: PASS, with both native controls ending inside their labels.

- [ ] **Step 5: Run focused regression and static verification**

Run:

```powershell
npx playwright test tests/e2e/public-responsive.spec.ts --project=mobile
npm run typecheck:e2e
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0. The build may retain the repository's existing
missing-local-secret and chunk-size warnings; no new error or warning is
introduced by this CSS-only fix.

- [ ] **Step 6: Review and commit only the owned implementation files**

Inspect `git diff -- src/styles.css tests/e2e/public-responsive.spec.ts`, then
commit only those two paths:

```powershell
git add -- src/styles.css tests/e2e/public-responsive.spec.ts
git diff --cached --check
git commit -m "fix: contain event start time input"
```

Expected: the commit contains the paired native-control regression test and the
scoped selector change, with all unrelated untracked files left untouched.

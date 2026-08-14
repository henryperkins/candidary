# Cover Studio Critique Remediation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for each behavioral change, superpowers:systematic-debugging for any unexpected failure, and superpowers:verification-before-completion before making a completion claim.

**Goal:** Remediate the approved Cover Studio critique without changing the established cover workflows, server contracts, asset corpus, or release boundary.

**Architecture:** Keep EventAppearanceEditor as the owner of the authoritative Manager canvas and the Cover Studio session. Resolve preset style thumbnails synchronously at that boundary, keep upload thumbnail state in the existing session, make CoverComposer a controls-only component, and let CoverStudio apply pointer deltas to the same EventAppearanceCanvas already shown in its sticky preview. Preserve the existing operation controller and publication receipt semantics while freezing the dispatched intent in the UI.

**Tech stack:** React 19, TypeScript, CSS, Vitest with Testing Library, Playwright, axe-core, Vite preview.

**Approved design:** docs/superpowers/specs/2026-08-12-cover-studio-critique-remediation-design.md

**Critique source:** .impeccable/critique/2026-08-12T20-58-02Z__src-features-cover-coverstudio-tsx.md

## Scope and evidence boundaries

- Preserve these paths exactly:
  - Upload: Choose → Compose → Style → Done.
  - Preset: Choose → Style → Done.
  - Removal: Choose → Done.
- Preserve all six preset IDs, all five effect IDs, existing publication/retry behavior, the native file input, browser page zoom, pinch zoom, the visual-viewport thresholds, and the current Manager canvas outside the Studio.
- “One real canvas” means exactly one EventAppearanceCanvas inside the open Cover Studio dialog. EventAppearanceEditor deliberately remains mounted and inert behind the modal, so two Manager-side canvas instances may exist globally while the dialog is open. Do not delete the underlying Manager canvas.
- Static preset thumbnails are a presentation concern at EventAppearanceEditor. Do not alter use-cover-studio-session thumbnail caching, draft creation, or upload preview behavior.
- Remove previewUrl only from CoverComposerProps and the narrower CoverStudioDraft type. Keep CoverSessionDraft.previewUrl in use-cover-studio-session.ts because EventAppearanceEditor still uses the draft URL to build its live canvas preview.
- Do not add Worker, API, D1, R2, Workflow, migration, deployment, rollout, or physical-device work. Local browser evidence is not production or device certification.
- The checkout is already dirty. Before every optional commit:
  - confirm each allowlisted file was clean at implementation start or contains only this plan’s edits;
  - require an empty starting index with:

    $stagedBefore = @(git diff --cached --name-only)
    if ($stagedBefore.Count -ne 0) {
      throw "Stop: the index already contains staged paths."
    }

  - stage only the task’s literal git add allowlist;
  - compare git diff --cached --name-only with that same literal allowlist by using Compare-Object and stop on any extra or missing path;
  - run git diff --cached --check and stop on a non-zero exit before git commit.
- Never use git add -A or git add .. If an earlier optional commit was skipped, do not make a later overlapping task commit. Continue uncommitted, or include every outstanding plan-owned path in a separately reviewed, user-authorized aggregate commit.
- Do not rewrite older specs or plans that document the historical “Adjust focus” labels. Update only current production code and current automated tests.

## Task 1: Make style metadata reusable and preset thumbnails immediately real

**Files:**

- Modify: src/features/cover/CoverStylePicker.tsx
- Modify: src/components/EventAppearanceEditor.tsx
- Test: tests/ui/cover-studio.test.tsx
- Test: tests/ui/event-appearance-editor.test.tsx

### 1.1 Write the failing style-state tests

- [ ] In tests/ui/cover-studio.test.tsx, add or extend the style-picker coverage so all four thumbnail states are explicit:
  - ready renders the supplied image;
  - loading renders “Loading Natural preview”;
  - error renders the existing retry control;
  - idle renders the exact visible text “Preview not ready”.
- [ ] Add a small assertion for the exported name helper:

    expect(coverStyleName('natural')).toBe('Natural');
    expect(coverStyleName('film')).toBe('Film');
    expect(coverStyleName('monochrome')).toBe('Monochrome');

- [ ] Run the focused test and verify that it fails because coverStyleName is not exported and idle has no visible state:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx

### 1.2 Implement the style helper and truthful idle state

- [ ] In CoverStylePicker.tsx, keep STYLE_NAMES as the single mapping and export this helper:

    export function coverStyleName(effect: EventCoverEffectId): string {
      return STYLE_NAMES[effect];
    }

- [ ] Use coverStyleName(effect) inside CoverStylePicker instead of indexing STYLE_NAMES directly.
- [ ] Render a neutral state for idle, parallel to loading and error:

    {preview.status === 'idle' && (
      <span className="cover-style-picker__state">Preview not ready</span>
    )}

- [ ] Do not disable any radio because its preview is idle, loading, or failed.

### 1.3 Write the failing preset-thumbnail boundary test

- [ ] In tests/ui/event-appearance-editor.test.tsx, open Cover Studio, choose Warm Linen, continue to Style, and assert that all five style items are ready immediately.
- [ ] Assert the exact five paths:
  - /assets/event-covers/v1/warm-linen/natural/standard-default-1x.webp
  - /assets/event-covers/v1/warm-linen/warm/standard-default-1x.webp
  - /assets/event-covers/v1/warm-linen/film/standard-default-1x.webp
  - /assets/event-covers/v1/warm-linen/soft/standard-default-1x.webp
  - /assets/event-covers/v1/warm-linen/monochrome/standard-default-1x.webp
- [ ] Assert that selecting the preset and entering Style creates no draft request and no upload preview/transform request in the existing fetch audit.
- [ ] Run the focused test and verify that it fails because EventAppearanceEditor currently returns coverSession.styleThumbnails for presets:

    npx vitest run --config vitest.config.ts tests/ui/event-appearance-editor.test.tsx

### 1.4 Resolve preset thumbnails at the Editor boundary

- [ ] Add this helper near canvasPreview in EventAppearanceEditor.tsx:

    function presetStyleThumbnail(
      presetId: EventCoverPresetId,
      effect: EventCoverEffectId,
    ): CoverStyleThumbnailState {
      return {
        status: 'ready',
        url: presetCoverAssetPath(
          1,
          presetId,
          effect,
          'standard-default',
          '1x',
          'webp',
        ),
        error: null,
      };
    }

- [ ] Import EventCoverEffectId, EventCoverPresetId, and CoverStyleThumbnailState as types from their current modules.
- [ ] Change only the CoverStudio styleThumbnail prop:

    styleThumbnail={(nextEffect) => (
      coverSession.selection.source?.kind === 'preset'
        ? presetStyleThumbnail(
            coverSession.selection.source.presetId,
            nextEffect,
          )
        : coverSession.styleThumbnails[nextEffect]
    )}

- [ ] Leave use-cover-studio-session.ts unchanged.

### 1.5 Verify and optionally commit Task 1

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx

- [ ] Inspect the scoped diff:

    git diff -- src/features/cover/CoverStylePicker.tsx src/components/EventAppearanceEditor.tsx tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx

- [ ] If the implementation session is authorized to commit, run the global empty-index guard, stage only these files, verify exact equality, and commit:

    git add -- src/features/cover/CoverStylePicker.tsx src/components/EventAppearanceEditor.tsx tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx
    $expected = @(
      'src/features/cover/CoverStylePicker.tsx'
      'src/components/EventAppearanceEditor.tsx'
      'tests/ui/cover-studio.test.tsx'
      'tests/ui/event-appearance-editor.test.tsx'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 1 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 1 staged diff check failed." }
    git commit -m "fix: load cover preset style previews locally"

## Task 2: Put the captioned guest canvas before Manager controls

**Files:**

- Modify: src/components/EventAppearanceCanvas.tsx
- Modify: src/components/EventAppearanceEditor.tsx
- Modify: src/styles.css
- Test: tests/ui/event-appearance-editor.test.tsx
- Test: tests/ui/event-theme-rendering.test.tsx
- Test: tests/e2e/event-cover-studio.spec.ts

### 2.1 Write failing semantic and ordering tests

- [ ] In tests/ui/event-theme-rendering.test.tsx, update the EventAppearanceCanvas contract to expect:
  - a figure with class event-appearance-canvas;
  - its first direct child is a figcaption;
  - the figcaption has the exact text “What guests see”;
  - the guest layer is still a normal div and is not exposed as role img;
  - summary and controls remain siblings after event-appearance-canvas__guest, not children of the themed guest layer.
- [ ] In tests/ui/event-appearance-editor.test.tsx, assert the exact truthful paragraph:

    Choose the colors and shape guests see. Theme and color changes save as you make them. Cover changes begin after you choose Done, and the current cover stays live until the new one is ready.

- [ ] Assert “Cover changes apply immediately” is absent.
- [ ] Assert the figure precedes the form controls in DOM order.
- [ ] In tests/e2e/event-cover-studio.spec.ts, use the exact test title “Event Appearance places the captioned guest canvas before theme and color controls”.

- [ ] In the browser test:
  - open Manager Settings without opening Studio;
  - assert figure.event-appearance-canvas exists;
  - assert its direct first child is a figcaption with exact text “What guests see”;
  - compare DOM positions using getByRole('group', { name: 'Event appearance' }), getByRole('textbox', { name: 'Primary color' }), and getByRole('textbox', { name: 'Accent color' }); the figure must precede all three;
  - assert there is one live Manager figure;
  - assert the summary and Change cover button are outside event-appearance-canvas__guest.
- [ ] Run the focused tests and confirm the expected failures:

    npx vitest run --config vitest.config.ts tests/ui/event-theme-rendering.test.tsx tests/ui/event-appearance-editor.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "Event Appearance places"

### 2.2 Implement the figure and Editor order

- [ ] In EventAppearanceCanvas.tsx, replace the outer div.event-appearance-canvas with figure.event-appearance-canvas, insert figcaption.event-appearance-canvas__caption with exact text “What guests see” as its first direct child, leave the existing event-appearance-canvas__guest subtree unchanged as the second direct child, and leave the existing conditional summary and controls as later direct children.

- [ ] Keep data-testid="event-appearance-canvas" on event-appearance-canvas__guest so existing rendering tests continue to address the themed layer.
- [ ] In EventAppearanceEditor.tsx:
  - replace the old paragraph with the approved truthful copy;
  - render canvas(true) immediately after event-appearance-editor__heading;
  - render the form and all theme/color/reset controls after that figure;
  - remove the old canvas(true) call from inside the form.
- [ ] In styles.css, reset the new figure’s browser margin and style the caption as neutral Manager chrome:

    .event-appearance-canvas {
      width: min(100%, 620px);
      margin: 0;
      display: grid;
      gap: 12px;
    }

    .event-appearance-canvas__caption {
      color: var(--muted);
      font-size: .78rem;
      font-weight: 700;
    }

- [ ] Do not add a role or aria-label to the figure; the visible figcaption supplies its accessible name.

### 2.3 Verify and optionally commit Task 2

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/event-theme-rendering.test.tsx tests/ui/event-appearance-editor.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "Event Appearance places"

- [ ] Inspect and, if authorized, run the global empty-index guard, stage only the scoped files, verify exact equality, and commit:

    git diff -- src/components/EventAppearanceCanvas.tsx src/components/EventAppearanceEditor.tsx src/styles.css tests/ui/event-theme-rendering.test.tsx tests/ui/event-appearance-editor.test.tsx tests/e2e/event-cover-studio.spec.ts
    git add -- src/components/EventAppearanceCanvas.tsx src/components/EventAppearanceEditor.tsx src/styles.css tests/ui/event-theme-rendering.test.tsx tests/ui/event-appearance-editor.test.tsx tests/e2e/event-cover-studio.spec.ts
    $expected = @(
      'src/components/EventAppearanceCanvas.tsx'
      'src/components/EventAppearanceEditor.tsx'
      'src/styles.css'
      'tests/ui/event-theme-rendering.test.tsx'
      'tests/ui/event-appearance-editor.test.tsx'
      'tests/e2e/event-cover-studio.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 2 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 2 staged diff check failed." }
    git commit -m "fix: lead event appearance with guest preview"

## Task 3: Isolate radio geometry and expose native file focus

**Files:**

- Modify: src/features/cover/CoverSourcePicker.tsx
- Modify: src/features/cover/CoverStylePicker.tsx
- Modify: src/styles.css
- Test: tests/ui/cover-studio.test.tsx
- Test: tests/e2e/event-cover-studio.spec.ts

### 3.1 Write failing markup and browser-geometry tests

- [ ] In tests/ui/cover-studio.test.tsx, assert:
  - the native file input remains the real focusable control;
  - it immediately precedes label.cover-source-picker__file-proxy;
  - the proxy’s htmlFor equals the input id;
  - each option keeps its radio and visible name in the same option label;
  - all six preset labels and five style labels remain at least semantically named.
- [ ] In tests/e2e/event-cover-studio.spec.ts, use the exact test title “source and style radios retain 20px glyphs, 44px labels, and a visible file-focus proxy at 320 and 390”.

- [ ] Reuse geometryPage(browser, width, height, visualHeight) and use fresh contexts for:
  - 320 by 568;
  - 390 by 844.
- [ ] For every source radio and, after Warm Linen → Continue, every style radio, assert:
  - bounding box width and height are exactly 20;
  - all computed padding values are 0px;
  - computed border widths are 0px;
  - width is not 100%;
  - min-height is not 48px;
  - accentColor is rgb(63, 109, 149);
  - the surrounding option label is at least 44 by 44.
- [ ] Assert the selected label retains its visible name and a 2px Denim selection ring.
- [ ] Assert cover-source-picker__upload has a dashed border.
- [ ] Assert cover-source-picker__upload-choice has min-width: 0. Count the upload name’s rendered lines with a DOM Range over its text node and the distinct rounded top values from range.getClientRects(); assert that count is no more than two at both widths. Do not count getClientRects() on the block span itself.
- [ ] Focus cover-source-picker__file and assert the adjacent proxy has a visible solid 2px Focus outline with positive outline offset.
- [ ] Do not require the proxy label to have tabIndex or its own keyboard handler.
- [ ] Run and confirm failure against the global input rule:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "source and style radios"

### 3.2 Restructure option headings without changing controls

- [ ] In CoverSourcePicker.tsx:
  - keep every native radio;
  - wrap each radio plus its visible name in a first-row span such as cover-source-picker__choice-heading;
  - keep the thumbnail and note as full-width rows;
  - move the native file input so it immediately precedes the visible Choose photo label;
  - add cover-source-picker__file-proxy to that label;
  - keep the file input sr-only, its accept list, cancellation guard, same-file reset, and onChoose/onUpload order unchanged.
- [ ] In CoverStylePicker.tsx:
  - wrap each radio plus style name in cover-style-picker__choice-heading;
  - keep the thumbnail or preview fallback and description as full-width rows;
  - preserve the status and retry control outside the option label.

### 3.3 Add narrowly scoped CSS overrides

- [ ] Add a shared radio reset after the global input rule and inside the existing Cover Studio block:

    .cover-source-picker input[type='radio'],
    .cover-style-picker input[type='radio'] {
      width: 20px;
      min-width: 20px;
      height: 20px;
      min-height: 20px;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      accent-color: var(--denim);
    }

- [ ] Make both heading wrappers a 44px minimum target row with min-width: 0, display flex, centered alignment, and a 10px gap.
- [ ] Make the upload card a wrapping grid or flex layout that:
  - uses border: 1px dashed var(--border);
  - keeps the choice at min-width: 0;
  - keeps the proxy at min-height: 44px;
  - places the MIME/size note on a full row;
  - does not create horizontal document overflow at 320px.
- [ ] Add the native focus proxy:

    .cover-source-picker__file:focus-visible + .cover-source-picker__file-proxy {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }

- [ ] Preserve the existing 2px Denim selected-state box shadow and visible text name.

### 3.4 Verify and optionally commit Task 3

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "source and style radios"

- [ ] Inspect and, if authorized, run the global empty-index guard, stage, verify exact equality, and commit:

    git diff -- src/features/cover/CoverSourcePicker.tsx src/features/cover/CoverStylePicker.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    git add -- src/features/cover/CoverSourcePicker.tsx src/features/cover/CoverStylePicker.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    $expected = @(
      'src/features/cover/CoverSourcePicker.tsx'
      'src/features/cover/CoverStylePicker.tsx'
      'src/styles.css'
      'tests/ui/cover-studio.test.tsx'
      'tests/e2e/event-cover-studio.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 3 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 3 staged diff check failed." }
    git commit -m "fix: isolate cover picker controls"

## Task 4: Turn CoverComposer into controls for the real canvas

**Files:**

- Modify: src/features/cover/CoverComposer.tsx
- Modify: src/features/cover/CoverStudio.tsx
- Modify: src/styles.css
- Test: tests/ui/cover-studio.test.tsx
- Update current-label selectors: tests/ui/event-appearance-editor.test.tsx
- Update current-label selectors: tests/e2e/event-cover-studio.spec.ts
- Update current-label selectors: tests/e2e/accessibility.spec.ts

### 4.1 Write failing controls-only tests

- [ ] Update current tests from “Adjust focus” to “Adjust framing”, “Horizontal focus” to “Left or right”, and “Vertical focus” to “Up or down”. Do not touch historical docs.
- [ ] In tests/ui/cover-studio.test.tsx, add exact assertions for automatic mode:
  - visible status “Automatic framing”;
  - instruction “Drag the preview to reposition it, or choose Adjust framing for precise controls.”;
  - button “Adjust framing”;
  - no sliders;
  - no cover-composer__surface and no composer-owned img.
- [ ] Add exact assertions for manual mode:
  - visible status “Manual framing”;
  - instruction “Drag the preview or use the controls below.”;
  - “Reset to automatic” precedes every range in DOM and focus order;
  - range names are “Left or right”, “Up or down”, and “Zoom”;
  - visible outputs are “50% from left”, “40% from top”, and “100%” for DRAFT;
  - aria-valuetext values are “50 percent from left”, “40 percent from top”, and “100 percent zoom”.
- [ ] Retain the existing Arrow, PageUp/PageDown, Home/End, safe-zoom ceiling, no-2x note, and 400ms settled-announcement tests.
- [ ] Add a ref-handle test that calls applyCanvasDrag with a new focus and verifies:
  - onChange receives the new value;
  - after 400ms, the existing screen-reader status reports the settled position.
- [ ] Run and confirm the expected failures:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx

### 4.2 Define the controls-only ref contract

- [ ] In CoverComposer.tsx, remove previewUrl, all pointer event imports, surfaceRef, dragOriginRef, move(), and the cover-composer__surface markup.
- [ ] Import useImperativeHandle and the Ref type.
- [ ] Export:

    export interface CoverComposerHandle {
      applyCanvasDrag(value: CoverFocusValue): void;
    }

- [ ] Add a React 19 ref prop:

    interface CoverComposerProps {
      ref?: Ref<CoverComposerHandle>;
      value: CoverFocusValue;
      safeZoomMaximum: number;
      available2xProfiles: readonly string[];
      manual: boolean;
      onChange(value: CoverFocusValue): void;
      onAdjust(): void;
      onReset(): void;
      disabled?: boolean;
    }

- [ ] Route the handle through the same interaction path as ranges:

    useImperativeHandle(ref, () => ({
      applyCanvasDrag(next) {
        interactedRef.current = true;
        onChange(next);
      },
    }), [onChange]);

- [ ] Keep the 400ms effect as the single settled announcement owner.

### 4.3 Render approved status, instructions, reset order, and outputs

- [ ] Automatic mode must render the exact status, instruction, and Adjust framing button.
- [ ] Manual mode must render the exact status and instruction, then Reset to automatic, then the three range labels in that order.
- [ ] For each range, render a visible output adjacent to its label:

    <output>50% from left</output>
    <output>40% from top</output>
    <output>100%</output>

- [ ] Keep Zoom’s accessible value as “100 percent zoom”.
- [ ] Keep Reset routed through onReset and mark it as an interaction so the settled announcement updates.
- [ ] In CoverStudio.tsx:
  - remove previewUrl from CoverStudioDraft;
  - remove previewUrl from the CoverComposer invocation;
  - import CoverComposerHandle for the next task.
- [ ] In tests/ui/cover-studio.test.tsx, remove previewUrl from its narrower DRAFT fixture. Do not remove previewUrl from session fixtures elsewhere.
- [ ] Remove obsolete cover-composer__surface CSS. Retain controls, note, range, mode, instruction, output, and button styles.

### 4.4 Verify and optionally commit Task 4

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx
    npm run typecheck
    npm run typecheck:e2e

- [ ] Inspect and, if authorized, run the global empty-index guard, stage, verify exact equality, and commit:

    git diff -- src/features/cover/CoverComposer.tsx src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx tests/e2e/event-cover-studio.spec.ts tests/e2e/accessibility.spec.ts
    git add -- src/features/cover/CoverComposer.tsx src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/ui/event-appearance-editor.test.tsx tests/e2e/event-cover-studio.spec.ts tests/e2e/accessibility.spec.ts
    $expected = @(
      'src/features/cover/CoverComposer.tsx'
      'src/features/cover/CoverStudio.tsx'
      'src/styles.css'
      'tests/ui/cover-studio.test.tsx'
      'tests/ui/event-appearance-editor.test.tsx'
      'tests/e2e/event-cover-studio.spec.ts'
      'tests/e2e/accessibility.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 4 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 4 staged diff check failed." }
    git commit -m "refactor: compose against the guest canvas"

## Task 5: Drag the live Studio canvas and promote framing after 3px

**Files:**

- Modify: src/features/cover/CoverStudio.tsx
- Modify: src/styles.css
- Test: tests/ui/cover-studio.test.tsx
- Test: tests/e2e/event-cover-studio.spec.ts

### 5.1 Write failing pointer-behavior tests

- [ ] In tests/ui/cover-studio.test.tsx, extend Harness with an optional canvasForFocus callback whose argument is the Harness-owned current focus. For this test, have it return a minimal canvas containing event-appearance-canvas__guest, event-appearance-canvas__local-cover, and a descendant img.responsive-cover__image whose objectPosition, transform, and transformOrigin are derived from that focus. Pass canvasForFocus(focus) to CoverStudio so the test canvas rerenders with Harness state; a pre-created ReactNode cannot prove that behavior.
- [ ] Stub the guest box to a deterministic non-zero rectangle.
- [ ] Exercise this sequence:
  - pointer down at 180,90;
  - pointer move to 178,89, whose distance is under 3px;
  - assert focus, automatic mode, ranges, and object position are unchanged;
  - pointer move to 160,90;
  - assert the delta is calculated from the original focus and original pointer, not from the touched point;
  - assert mode becomes manual and ranges appear;
  - assert a pointer down/up without movement remains automatic;
  - dispatch a primary pointer down followed by a non-primary pointer down before promotion; assert neither pointer is captured, focus stays automatic, and subsequent moves do nothing;
  - after a promoted drag, dispatch a non-primary pointer down and assert the original capture is released and the drag is cleared;
  - assert pointer cancel clears the drag and later moves do nothing;
  - assert disabled/not-ready states do not expose drag affordance and ignore pointer movement.
- [ ] Read object positioning from .event-appearance-canvas__local-cover .responsive-cover__image, because the img—not the wrapper—owns object-position.
- [ ] Use fake timers to prove the first promoted drag produces the existing 400ms settled announcement.
- [ ] Run and confirm failure because CoverStudio has no canvas pointer owner:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx

### 5.2 Add the canvas drag owner to CoverStudio

- [ ] Add:

    const composerRef = useRef<CoverComposerHandle>(null);
    const canvasRef = useRef<HTMLDivElement>(null);
    const editingDisabled = operationState.dispatched;

    type CanvasDragOrigin = {
      pointerId: number;
      clientX: number;
      clientY: number;
      focus: CoverFocusValue;
      moved: boolean;
    };

- [ ] Store the drag origin in a ref and compute:

    const dragEnabled =
      step === 'compose'
      && composeReady
      && Boolean(draft && effectiveFocus)
      && !editingDisabled;

- [ ] On primary pointer down:
  - if event.isPrimary is false, release any held primary capture, clear the existing origin, and return;
  - return unless dragEnabled and effectiveFocus exist;
  - record pointerId, clientX, clientY, the original focus, and moved: false;
  - do not set pointer capture yet;
  - do not change focus and do not call preventDefault.
- [ ] On pointer move:
  - ignore a missing or non-matching origin;
  - before promotion, return while Math.hypot(dx, dy) is less than 3;
  - measure the actual descendant event-appearance-canvas__guest rectangle;
  - return for zero width or height;
  - on the first qualifying single-primary-pointer move with valid bounds, set pointer capture and mark moved true;
  - calculate from the original focus:

    x = clamp01(origin.focus.x - dx / bounds.width)
    y = clamp01(origin.focus.y - dy / bounds.height)

  - call composerRef.current?.applyCanvasDrag with x, y, and the original zoom.
- [ ] On matching pointer up or pointer cancel, clear the origin and release capture only when held.
- [ ] Attach the ref and handlers to cover-studio__canvas and render:

    data-drag-enabled={dragEnabled ? 'true' : 'false'}

- [ ] Pass ref={composerRef} to CoverComposer.
- [ ] Do not call preventDefault, send a transform request, or add another image. The only multi-pointer logic is cancellation/release so the browser owns a two-pointer gesture.

### 5.3 Add the pointer affordance without capturing browser zoom

- [ ] Keep touch-action: pan-y pinch-zoom on cover-studio__canvas.
- [ ] Show cursor: grab only for data-drag-enabled="true"; use grabbing while a promoted pointer is held if a local state/class is needed.
- [ ] Disabled and not-ready states must have no grab cursor.

### 5.4 Add the real-browser drag/no-request test

- [ ] In tests/e2e/event-cover-studio.spec.ts, use the exact test title “Compose uses one real canvas, promotes the first 3px drag to manual framing, and requests no local transforms”.

- [ ] Reuse openManagerStudio, the upload fixture, records(), and settleRendering.
- [ ] After upload preparation is ready, record the initial transform count. The fixture currently performs three initial transform inspections, so assert zero additional records after interaction rather than absolute zero.
- [ ] Continue to Compose and scope all canvas-count assertions to the dialog:
  - exactly one event-appearance-canvas;
  - exactly zero cover-composer__surface;
  - no second composer img.
- [ ] Assert automatic copy and no sliders, then perform the under-3px and at-least-3px sequence against the real guest frame.
- [ ] Assert .event-appearance-canvas__local-cover .responsive-cover__image changes object position by the derived delta without a pressed-point jump.
- [ ] Assert manual copy, exact range names/outputs/aria-valuetext, Reset order, and Reset returning to the automatic values and status.
- [ ] Retain keyboard behavior and the settled status assertion.
- [ ] Assert cover-studio__canvas computes touch-action: pan-y pinch-zoom.
- [ ] Assert transform record count remains at its initial baseline and publication count remains zero after drag and range changes.
- [ ] Run:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "Compose uses one real canvas"

### 5.5 Verify and optionally commit Task 5

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "Compose uses one real canvas"

- [ ] Inspect and, if authorized, run the global empty-index guard, stage, verify exact equality, and commit:

    git diff -- src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    git add -- src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    $expected = @(
      'src/features/cover/CoverStudio.tsx'
      'src/styles.css'
      'tests/ui/cover-studio.test.tsx'
      'tests/e2e/event-cover-studio.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 5 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 5 staged diff check failed." }
    git commit -m "feat: drag the live cover canvas"

## Task 6: Make header and guest-frame geometry truthful at every mode

**Files:**

- Modify: src/features/cover/CoverStudio.tsx
- Modify: src/styles.css
- Test: tests/ui/cover-studio.test.tsx
- Test: tests/e2e/event-cover-studio.spec.ts

### 6.1 Preserve threshold characterization and add failing geometry coverage

- [ ] Keep existing boundary tests unchanged:
  - 500px → default;
  - 499px → compact;
  - 421px → compact;
  - 420px → short.
- [ ] In tests/ui/cover-studio.test.tsx, assert header DOM order is Cancel/Close, heading, then step counter.
- [ ] In tests/e2e/event-cover-studio.spec.ts, use the exact test title “default, compact, and short Studio modes size the real guest frame and retain one reachable scroller”.

- [ ] Use these exact cases:

    | Width | Height | Expected mode | Guest height |
    | ---: | ---: | --- | ---: |
    | 320 | 568 | default | 144 |
    | 390 | 844 | default | 144 |
    | 640 | 450 | compact | 96 |
    | 320 | 180 | short | 96 |

- [ ] For every case, assert:
  - data-viewport equals the expected mode;
  - computed and actual guest-frame height are within guestHeight through guestHeight + 1;
  - exactly one element among the Studio root and descendants is vertically scrollable;
  - document scrollWidth is no more than clientWidth + 1;
  - every footer action currently rendered on Choose, including Continue, is reachable after scrolling as needed and at least 44px high;
  - after choosing Warm Linen and advancing to Style, both Back and Continue are reachable after scrolling as needed and at least 44px high.
- [ ] At 320 by 568, assert the upload/source option and sticky footer are simultaneously inside the viewport.
- [ ] At 320 by 568, use the upload path to reach Compose and assert:
  - the header’s used height is exactly 56px;
  - Cancel, the full focused “Position the photo” heading, and “Step 2 of 4” remain within the header and viewport;
  - the three boxes do not overlap, using measureSeparation or equivalent bounding-box comparisons;
  - the title’s scrollWidth is no greater than clientWidth, so it is neither clipped nor truncated.
- [ ] Run and confirm the current 218px child minimum makes the test fail:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "default, compact, and short"

### 6.2 Put the header on one fixed 56px row

- [ ] Reorder CoverStudio header markup to Cancel/Close, h2, step counter.
- [ ] Change the header grid:

    .cover-studio__header {
      position: sticky;
      top: 0;
      z-index: 2;
      height: 56px;
      min-height: 56px;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 5px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--paper);
    }

- [ ] Remove the h2 grid-column span, constrain it with min-width: 0, and center it without hiding focus.
- [ ] Keep the step counter on one line. Add a max-width: 360px refinement with 8px inline header padding, a 6px column gap, and a .9rem single-line heading so the complete “Position the photo” title fits between the 44px-minimum Cancel control and “Step 2 of 4”; do not clip, ellipsize, or hide the title.
- [ ] Keep cover-studio__canvas sticky top at exactly 56px.

### 6.3 Size the actual guest frame, not only its wrapper

- [ ] Keep ordinary Manager canvases at their existing 218px minimum. Add only Studio-scoped overrides:

    .cover-studio__canvas .event-appearance-canvas__guest {
      height: 144px;
      min-height: 144px;
    }

    .cover-studio[data-viewport='compact']
      .event-appearance-canvas__guest,
    .cover-studio[data-viewport='short']
      .event-appearance-canvas__guest {
      height: 96px;
      min-height: 96px;
    }

- [ ] Also set explicit cover-studio__canvas min-heights of 144px/default and 96px/compact/short, while allowing its caption and padding to remain in normal layout.
- [ ] First apply only the explicit 144/96 guest heights and one-row header, then rerun the four geometry cases. If the browser proves internal overlap, use the smallest Studio-scoped reductions needed: zero the event/welcome margins, reduce copy padding from 12px to 8px 12px in compact/short mode, and reduce action padding/font size while retaining all text.
- [ ] In every mode, assert event name, date, complete welcome text, Add photos, and View gallery are visible and each painted box remains inside event-appearance-canvas__guest. Do not use display:none, nowrap, text-overflow:ellipsis, overflow clipping, or absolute repositioning to satisfy the height assertion.
- [ ] Preserve all cover, grain, scrim, theme-token, and local object-position layers.
- [ ] Preserve the one-scroller policy:
  - default/compact: cover-studio__controls owns overflow-y: auto;
  - short: cover-studio owns overflow-y: auto and controls use overflow: visible.
- [ ] Replace the stale “Unwired in this release” comment with a current description of the live Studio.

### 6.4 Verify and optionally commit Task 6

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "default, compact, and short"

- [ ] Inspect and, if authorized, run the global empty-index guard, stage, verify exact equality, and commit:

    git diff -- src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    git add -- src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    $expected = @(
      'src/features/cover/CoverStudio.tsx'
      'src/styles.css'
      'tests/ui/cover-studio.test.tsx'
      'tests/e2e/event-cover-studio.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 6 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 6 staged diff check failed." }
    git commit -m "fix: honor cover studio viewport geometry"

## Task 7: Show exact Done receipts and freeze the dispatched intent

**Files:**

- Modify: src/features/cover/CoverStudio.tsx
- Modify: src/styles.css
- Test: tests/ui/cover-studio.test.tsx
- Test: tests/e2e/event-cover-studio.spec.ts

### 7.1 Write failing receipt and freeze tests

- [ ] In tests/ui/cover-studio.test.tsx, cover all three exact receipt triplets.
- [ ] Preset:
  - “Warm Linen · Film”
  - “Guests see this at the top of RSVP and photo delivery.”
  - “Your current cover stays live until the new one is completely ready. If anything fails, nothing changes.”
- [ ] Upload:
  - “Your photo · Soft”
  - the same audience sentence;
  - the same non-destructive guarantee.
- [ ] Removal:
  - “Remove the current cover”
  - “Guests will see the event theme instead.”
  - “The current cover stays live until this change is completely applied. If anything fails, nothing changes.”
- [ ] Assert the receipt is visible before dispatch.
- [ ] Add a controlled Done harness that accepts source, effect, and focus as rerenderable props and exposes the operation controller. Dispatch a preparing result and assert:
  - Back and Done are disabled;
  - source, style, range, and canvas-drag controls are unreachable because the Studio remains on Done;
  - rerendering with different source/effect/focus props does not change the submitted receipt;
  - onPublish ran exactly once.
- [ ] Move the operation to retryable-failed and repeat the byte-for-byte unchanged receipt assertion.
- [ ] Add separate dispatched-at-step cases for Choose, Compose, and Style. Navigate before calling controller.beginDispatch(), then assert every mounted editing control is disabled/inert and its callback mock remains untouched:
  - Choose: source radios, native file input, Choose photo proxy, Remove cover, and Continue;
  - Compose: Adjust framing or Reset/ranges, canvas drag, Back, and Continue;
  - Style: style radios, preview retry, Back, and Continue.
- [ ] Extend the existing before-dispatch access-failure test: the exact selected receipt remains visible, precedes the alert in DOM order, Done is disabled, and onPublish is not called.
- [ ] In tests/e2e/event-cover-studio.spec.ts, use the exact test title “Done keeps the preset receipt visible before dispatch and while preparing or retryable failed”.

- [ ] Use the preset path with:

    publicationReplies: [{
      operationStatus: 'preparing',
      status: 202,
      retryAfter: '1',
    }],
    statusReplies: [{
      operationStatus: 'retryable-failed',
      status: 503,
      retryable: true,
      includeEvent: true,
    }],

- [ ] Assert receipt DOM precedes the preparing status and later retry alert/action, the receipt stays unchanged, Back and Done are disabled after dispatch, and the audit contains exactly one publication and one status read.
- [ ] Run and confirm failure because the ordinary Done pane is currently empty:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "Done keeps the preset receipt"

### 7.2 Snapshot the submitted intent and expand editingDisabled

- [ ] Import EVENT_COVER_PRESETS in CoverStudio.tsx and coverStyleName from CoverStylePicker.tsx.
- [ ] Export one named contract and use it in every location:

    export interface CoverPublishIntent {
      source: CoverSourceChoice | { kind: 'none' };
      focus: CoverFocusValue | null;
      effect: EventCoverEffectId;
    }

- [ ] Change CoverStudioProps.onPublish to (intent: CoverPublishIntent) => void, type the local intent as CoverPublishIntent, and add useState<CoverPublishIntent | null>(null) for submittedIntent. Reset it whenever open starts a new Studio session.
- [ ] In publish():
  - construct the intent once;
  - store that exact object in submitted-intent state;
  - pass the same object to onPublish.
- [ ] Derive the receipt from submitted intent after dispatch and from current selection before dispatch. This prevents external prop churn from changing what the user sees.
- [ ] Reuse the constant introduced with canvas dragging:

    const editingDisabled = operationState.dispatched;

- [ ] Expand editingDisabled beyond canvas dragging to:
  - CoverSourcePicker busy, in addition to compose loading;
  - CoverStylePicker disabled;
  - CoverComposer disabled;
  - canvas dragEnabled;
  - Back;
  - Continue;
  - source selection, upload, remove, advance, back, focus, reset, and style callbacks as defensive early returns.
- [ ] Keep Cancel changing to Close after dispatch and keep retry available.

### 7.3 Render the exact receipt before operation state

- [ ] Add a cover-studio__receipt block at the top of cover-studio__done.
- [ ] Resolve a preset name from EVENT_COVER_PRESETS and an effect name through coverStyleName.
- [ ] Render the exact strings from 7.1 with no optimistic “saved” or “live” language.
- [ ] Keep access failure, preparing status, and retryable-failed action after the receipt.
- [ ] Keep Done disabled after the first dispatch and preserve exactly one publication.

### 7.4 Verify and optionally commit Task 7

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "Done keeps the preset receipt"

- [ ] Inspect and, if authorized, run the global empty-index guard, stage, verify exact equality, and commit:

    git diff -- src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    git add -- src/features/cover/CoverStudio.tsx src/styles.css tests/ui/cover-studio.test.tsx tests/e2e/event-cover-studio.spec.ts
    $expected = @(
      'src/features/cover/CoverStudio.tsx'
      'src/styles.css'
      'tests/ui/cover-studio.test.tsx'
      'tests/e2e/event-cover-studio.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 7 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 7 staged diff check failed." }
    git commit -m "fix: preserve cover publication receipts"

## Task 8: Give applied preparation its own completion treatment

**Files:**

- Modify: src/components/ManagerCoverPreparationStatus.tsx
- Modify: src/styles.css
- Test: tests/ui/manager-cover-preparation.test.tsx
- Test: tests/e2e/event-cover-studio.spec.ts

### 8.1 Write the failing applied-state test

- [ ] In tests/ui/manager-cover-preparation.test.tsx, keep the exact live text and assert:

    const applied = screen.getByRole('status');
    expect(applied).toHaveTextContent('Your new cover is live.');
    expect(applied).toHaveClass('cover-preparation--success');
    expect(applied).not.toHaveClass('cover-preparation--warning');

- [ ] In tests/e2e/event-cover-studio.spec.ts, extend the existing immediate-applied preset-publication case to wait for cover-preparation--success and assert computed:
  - backgroundColor is rgb(232, 236, 216), the Moss Soft token;
  - color is rgb(78, 91, 40), Completion Ink;
  - border color is rgb(104, 118, 61), Moss.
- [ ] In an existing preparing publication case, assert cover-preparation is present but cover-preparation--success is absent.
- [ ] Run and confirm failure because applied currently uses only the neutral class and paint:

    npx vitest run --config vitest.config.ts tests/ui/manager-cover-preparation.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "preset publication consumes|server Retry-After controls"

### 8.2 Implement semantic completion styling

- [ ] Add --completion-ink: #4e5b28 to the global color tokens beside Moss.
- [ ] Render applied as:

    <p
      className="cover-preparation cover-preparation--success"
      role="status"
    >
      Your new cover is live.
    </p>

- [ ] Add:

    .cover-preparation--success {
      border-color: var(--moss);
      background: var(--moss-soft);
      color: var(--completion-ink);
    }

- [ ] Keep preparing neutral and failures/conflicts red. Do not use Moss for an in-progress state.

### 8.3 Verify and optionally commit Task 8

- [ ] Run:

    npx vitest run --config vitest.config.ts tests/ui/manager-cover-preparation.test.tsx
    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "preset publication consumes|server Retry-After controls"

- [ ] Inspect and, if authorized, run the global empty-index guard, stage, verify exact equality, and commit:

    git diff -- src/components/ManagerCoverPreparationStatus.tsx src/styles.css tests/ui/manager-cover-preparation.test.tsx tests/e2e/event-cover-studio.spec.ts
    git add -- src/components/ManagerCoverPreparationStatus.tsx src/styles.css tests/ui/manager-cover-preparation.test.tsx tests/e2e/event-cover-studio.spec.ts
    $expected = @(
      'src/components/ManagerCoverPreparationStatus.tsx'
      'src/styles.css'
      'tests/ui/manager-cover-preparation.test.tsx'
      'tests/e2e/event-cover-studio.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 8 staged paths do not match the allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 8 staged diff check failed." }
    git commit -m "fix: distinguish applied cover completion"

## Task 9: Complete browser accessibility and static-preset request coverage

**Files:**

- Modify: tests/e2e/event-cover-studio.spec.ts
- Modify: tests/e2e/accessibility.spec.ts
- Modify only if a production defect is exposed: src/features/cover/CoverStudio.tsx
- Modify only if a production defect is exposed: src/features/cover/CoverSourcePicker.tsx
- Modify only if a production defect is exposed: src/features/cover/CoverStylePicker.tsx
- Modify only if a production defect is exposed: src/styles.css

### 9.1 Add the static preset request-boundary tests

- [ ] In tests/e2e/event-cover-studio.spec.ts, use the exact test title “preset styles load five static effect thumbnails without draft or preview requests”.
- [ ] Reuse openManagerStudio, choosePreset, and records.
- [ ] For Warm Linen Style:
  - assert five list items have data-thumbnail-state="ready";
  - assert five images are visible;
  - before reading paths or audit counts, wait explicitly with expect.poll() until evaluating all five HTMLImageElements reports every image.complete and every image.naturalWidth greater than zero; settleRendering alone waits for fonts/frames, not image completion;
  - assert each image pathname exactly matches /assets/event-covers/v1/warm-linen/{effect}/standard-default-1x.webp;
  - assert all five named radios remain enabled.
- [ ] Assert records for draft, preview, transform, and publication are all empty. This preset path must not create any initial transform records.
- [ ] Add a second exact test title: “missing preset style artwork keeps its named radio usable without upload fallbacks”.
- [ ] Before navigation in that test, abort or fulfill 404 for /assets/event-covers/v1/warm-linen/film/standard-default-1x.webp. Enter Warm Linen Style and assert:
  - the Film radio is still named, enabled, checkable, and selected after checking;
  - expect.poll waits until the Film HTMLImageElement is complete with naturalWidth 0, proving this is the missing-artwork case;
  - no upload draft or preview fallback appears;
  - draft, preview, transform, and publication records remain empty.

### 9.2 Expand the existing accessibility journey

- [ ] Rename the current test to:

    Cover Studio Choose, Compose, Style, Done, and preparing states are axe-clean and focus-ordered

- [ ] Retain every existing full-document Axe checkpoint, heading/error/alertdialog focus assertion, and the explicit axe target-size rule.
- [ ] Set the long affected-state journey to a 390 by 844 viewport before opening Manager Settings, so its Choose, Compose automatic/manual, Style, Done, and preparing Axe checkpoints are mobile evidence rather than the desktop project default.
- [ ] Add:
  - heading → first option focus progression;
  - native file input focus → visible file proxy outline;
  - manual focus order Reset to automatic → Left or right → Up or down → Zoom;
  - no document overflow at 390;
  - Axe checkpoints for Choose, Compose automatic, Compose manual, Style, Done, and preparing.
- [ ] Add a companion exact test title: “Cover Studio Choose and Style are axe-clean with a native file-focus proxy at 320”. Use a fresh 320 by 568 page, run Axe at Choose and Style, prove the real file input drives the visible proxy outline, and assert no document overflow.
- [ ] Keep the separate reduced-motion test as the motion proof. Its computed transition duration must remain 0s or 1e-05s; do not duplicate that proof in the long journey.

### 9.3 Run the focused browser bundle

- [ ] Run:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "Event Appearance places|source and style radios|default, compact, and short|preset styles load|missing preset style artwork|Compose uses one real canvas|Done keeps the preset receipt"

- [ ] Run:

    npx playwright test tests/e2e/accessibility.spec.ts --project=desktop --workers=1 --grep "Cover Studio Choose, Compose, Style, Done, and preparing states are axe-clean and focus-ordered|Cover Studio Choose and Style are axe-clean with a native file-focus proxy at 320"

- [ ] If either test exposes a production defect, reproduce it with the narrowest grep, fix only the owning component/style, rerun that grep, then rerun both commands above.

### 9.4 Optionally commit Task 9

- [ ] Inspect and, if authorized, commit the tests-only Task 9 diff. Run the global empty-index guard, stage, verify exact equality, and commit:

    git diff -- tests/e2e/event-cover-studio.spec.ts tests/e2e/accessibility.spec.ts src/features/cover/CoverStudio.tsx src/features/cover/CoverSourcePicker.tsx src/features/cover/CoverStylePicker.tsx src/styles.css
    git add -- tests/e2e/event-cover-studio.spec.ts tests/e2e/accessibility.spec.ts
    $expected = @(
      'tests/e2e/event-cover-studio.spec.ts'
      'tests/e2e/accessibility.spec.ts'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 9 staged paths do not match the tests-only allowlist."
    }
    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 9 staged diff check failed." }
    git commit -m "test: cover studio responsive accessibility"

- [ ] If production files changed in 9.3, do not use the tests-only commit block. Leave Task 9 uncommitted and include its exact production and test paths only in a separately reviewed, user-authorized aggregate commit; do not improvise a broader git add command.

## Task 10: Review and update only the bounded visual baselines

**Files expected to change:**

- tests/e2e/event-cover-studio.spec.ts-snapshots/studio-sheet-760-desktop-win32.png
- tests/e2e/event-cover-studio.spec.ts-snapshots/studio-dialog-761-desktop-win32.png
- tests/e2e/event-cover-studio.spec.ts-snapshots/studio-zoom-200-desktop-win32.png
- tests/e2e/event-cover-studio.spec.ts-snapshots/studio-zoom-400-desktop-win32.png
- tests/e2e/event-cover-studio.spec.ts-snapshots/studio-keyboard-compact-desktop-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-event-appearance-390-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-candidary-default-preset-film-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-candidary-default-upload-natural-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-coastal-light-preset-film-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-coastal-light-upload-monochrome-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-garden-party-preset-film-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-garden-party-upload-warm-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-midnight-film-preset-film-mobile-win32.png
- tests/e2e/event-theming-visual.spec.ts-snapshots/manager-midnight-film-upload-soft-mobile-win32.png

### 10.1 Scan before updating

- [ ] Run the existing Studio geometry visual test without updating:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "sheet/dialog, compact keyboard, 200%, and 400% geometries retain one usable scroll region"

- [ ] Review the failure report. Only the five named Studio baselines above are expected because of the one-row header, visible caption, true 144/96 guest frame, and corrected picker layout.

### 10.2 Update and inspect the Studio baselines

- [ ] Update only that named test:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "sheet/dialog, compact keyboard, 200%, and 400% geometries retain one usable scroll region" --update-snapshots

- [ ] Use view_image on each of the five updated PNGs. Confirm:
  - one-row header;
  - visible, unclipped caption and guest frame;
  - no horizontal overflow;
  - reachable footer;
  - no clipped option labels or actions.
- [ ] Treat the named Compose DOM/drag regression in Task 5—not these Choose-step snapshots—as the proof that no duplicate composer preview exists.

### 10.3 Update and inspect only Manager canvas baselines

- [ ] Update the bounded Manager visuals:

    npx playwright test tests/e2e/event-theming-visual.spec.ts --project=mobile --workers=1 --grep "manager Event appearance keeps global chrome outside the preview|keeps an immutable preset inside the themed Manager canvas|keeps the .* upload effect inside the themed Manager canvas" --update-snapshots

- [ ] Use view_image on manager-event-appearance-390-mobile-win32.png to confirm the visible caption and canvas-before-controls hierarchy on the full Manager page.
- [ ] Use the eight cropped Manager canvas baselines only to confirm caption, theme, preset/upload effect, and neutral-chrome containment; they do not contain adjacent controls and are not hierarchy proof.
- [ ] Do not update the twelve guest responsive-profile snapshots or ordinary guest event-theme baselines. If one changes, treat it as an unexpected production regression and debug before proceeding.

### 10.4 Confirm both visual groups once

- [ ] Run both commands again without update:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1 --grep "sheet/dialog, compact keyboard, 200%, and 400% geometries retain one usable scroll region"
    npx playwright test tests/e2e/event-theming-visual.spec.ts --project=mobile --workers=1 --grep "manager Event appearance keeps global chrome outside the preview|keeps an immutable preset inside the themed Manager canvas|keeps the .* upload effect inside the themed Manager canvas"

### 10.5 Optionally commit Task 10

- [ ] Inspect and, if authorized, stage exactly the reviewed PNGs, never an entire snapshot directory:

    git status --short -- tests/e2e/event-cover-studio.spec.ts-snapshots tests/e2e/event-theming-visual.spec.ts-snapshots

- [ ] After passing the global empty-index guard, stage the fourteen reviewed files with this literal allowlist:

    git add -- tests/e2e/event-cover-studio.spec.ts-snapshots/studio-sheet-760-desktop-win32.png tests/e2e/event-cover-studio.spec.ts-snapshots/studio-dialog-761-desktop-win32.png tests/e2e/event-cover-studio.spec.ts-snapshots/studio-zoom-200-desktop-win32.png tests/e2e/event-cover-studio.spec.ts-snapshots/studio-zoom-400-desktop-win32.png tests/e2e/event-cover-studio.spec.ts-snapshots/studio-keyboard-compact-desktop-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-event-appearance-390-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-candidary-default-preset-film-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-candidary-default-upload-natural-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-coastal-light-preset-film-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-coastal-light-upload-monochrome-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-garden-party-preset-film-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-garden-party-upload-warm-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-midnight-film-preset-film-mobile-win32.png tests/e2e/event-theming-visual.spec.ts-snapshots/manager-midnight-film-upload-soft-mobile-win32.png

- [ ] Verify the same literal allowlist and commit:

    $expected = @(
      'tests/e2e/event-cover-studio.spec.ts-snapshots/studio-sheet-760-desktop-win32.png'
      'tests/e2e/event-cover-studio.spec.ts-snapshots/studio-dialog-761-desktop-win32.png'
      'tests/e2e/event-cover-studio.spec.ts-snapshots/studio-zoom-200-desktop-win32.png'
      'tests/e2e/event-cover-studio.spec.ts-snapshots/studio-zoom-400-desktop-win32.png'
      'tests/e2e/event-cover-studio.spec.ts-snapshots/studio-keyboard-compact-desktop-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-event-appearance-390-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-candidary-default-preset-film-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-candidary-default-upload-natural-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-coastal-light-preset-film-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-coastal-light-upload-monochrome-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-garden-party-preset-film-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-garden-party-upload-warm-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-midnight-film-preset-film-mobile-win32.png'
      'tests/e2e/event-theming-visual.spec.ts-snapshots/manager-midnight-film-upload-soft-mobile-win32.png'
    )
    $actual = @(git diff --cached --name-only)
    if (@(Compare-Object ($expected | Sort-Object) ($actual | Sort-Object)).Count -ne 0) {
      throw "Stop: Task 10 staged paths do not match the fourteen-file allowlist."
    }

    git diff --cached --check
    if ($LASTEXITCODE -ne 0) { throw "Stop: Task 10 staged diff check failed." }
    git commit -m "test: refresh cover studio visual baselines"

## Task 11: Run the bounded local regression gate

### 11.1 Static and component gates

- [ ] Run:

    npm run typecheck
    npm run typecheck:e2e
    npm run lint

- [ ] Run the focused component suite:

    npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/manager-cover-preparation.test.tsx

### 11.2 Browser gates

- [ ] Run the full desktop Cover Studio spec:

    npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop --workers=1

- [ ] Run the expanded accessibility journey:

    npx playwright test tests/e2e/accessibility.spec.ts --project=desktop --workers=1 --grep "Cover Studio Choose, Compose, Style, Done, and preparing states are axe-clean and focus-ordered|Cover Studio Choose and Style are axe-clean with a native file-focus proxy at 320"

- [ ] Run the bounded Manager visual group:

    npx playwright test tests/e2e/event-theming-visual.spec.ts --project=mobile --workers=1 --grep "manager Event appearance keeps global chrome outside the preview|keeps an immutable preset inside the themed Manager canvas|keeps the .* upload effect inside the themed Manager canvas"

- [ ] Playwright’s configured webServer already runs npm run build against vite preview. Do not add a duplicate manual build unless the configured server fails before test execution.

### 11.3 Diff and scope review

- [ ] Run:

    git diff --check
    git status --short
    git diff --stat

- [ ] Confirm:
  - no Worker, API, migration, asset-manifest, preset bytes, or deployment files changed;
  - no guest responsive-profile snapshots changed;
  - every requested critique item has a production change and a focused regression assertion;
  - unrelated dirty and untracked files remain untouched and unstaged.
- [ ] Do not run verify:cover-presets unless preset asset bytes or the manifest changed; this plan should not change either.
- [ ] Do not escalate this bounded UI gate to verify:release, deployment, remote migration, rollout enablement, or physical-device certification.

### 11.4 Final handoff

- [ ] Report separately:
  - implementation status;
  - exact local commands and results;
  - visual baselines reviewed;
  - Git commit/publication status;
  - deployment status;
  - physical-device status.
- [ ] Never describe local Playwright evidence as deployment, production runtime proof, or device acceptance.

## Requirement-to-test traceability

| Approved requirement | Primary production owner | Primary regression proof |
| --- | --- | --- |
| Canvas before controls with visible caption | EventAppearanceCanvas, EventAppearanceEditor | Editor UI test; “Event Appearance places the captioned guest canvas before theme and color controls” browser test |
| Truthful save/publication copy | EventAppearanceEditor | Editor UI test; same browser test |
| 20px radio glyphs and 44px labels | CoverSourcePicker, CoverStylePicker, styles.css | “source and style radios retain 20px glyphs, 44px labels, and a visible file-focus proxy at 320 and 390” browser test |
| Native file focus proxy | CoverSourcePicker, styles.css | UI adjacency assertion; browser computed-outline assertion |
| Five instant static preset style previews | EventAppearanceEditor | Editor UI request audit; successful and missing-artwork preset browser tests |
| One Compose canvas | CoverComposer, CoverStudio | Controls-only UI tests; “Compose uses one real canvas, promotes the first 3px drag to manual framing, and requests no local transforms” browser test |
| First drag at 3px promotes to manual | CoverStudio, CoverComposer ref handle | Pointer unit tests; real-browser drag test |
| Browser zoom and pinch remain native | CoverStudio, styles.css | computed touch-action; no preventDefault; secondary-pointer input cancels/releases the active drag so the browser owns the gesture |
| Exact automatic/manual copy and range names | CoverComposer | UI exact-text tests; accessibility journey |
| Header is one 56px row | CoverStudio, styles.css | header DOM test; geometry and visual tests |
| Guest frame is actually 144/96 | styles.css | four-case real-browser geometry test |
| Exactly one reachable scroller/no overflow | styles.css | four-case geometry test and accessibility journey |
| Exact preset/upload/removal Done receipts | CoverStudio | component receipt triplets; preset browser state test |
| Receipt remains stable after dispatch | CoverStudio | component freeze tests; preparing/retry browser test |
| Applied is visually completion, not neutral | ManagerCoverPreparationStatus, styles.css | manager preparation UI test; applied/preparing computed-style browser assertions |
| Reduced motion remains effective | existing reduced-motion CSS/test | existing standalone accessibility test |
| No local transform/publication side effects while editing | existing session boundary plus CoverStudio | browser audit counts |

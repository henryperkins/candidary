# Cover Studio Critique Remediation Design

**Date:** 2026-08-12
**Status:** Implemented on 2026-08-12 from the approved direction
**Source critique:** `.impeccable/critique/2026-08-12T20-58-02Z__src-features-cover-coverstudio-tsx.md`
**Supersedes:** Nothing. This is a narrow corrective addendum to `2026-08-03-event-appearance-cover-studio-design.md`.

## 1. Goal

Repair the six priority findings in the 2026-08-12 Cover Studio critique while
preserving the approved Cover Studio product contract, durable publication
machinery, event-cover data model, and incumbent Candidary design system.

The remediation keeps these paths unchanged:

- upload: **Choose → Compose → Style → Done**;
- preset: **Choose → Style → Done**; and
- removal: **Choose → Done**.

It does not collapse the studio into a single sheet, add another preview,
change the six presets or five effects, add a feature flag, change any Worker
API, or alter publication/reconciliation semantics.

## 2. Approved scope

The implementation resolves:

1. cover source and style radios inheriting the global full-width input rule;
2. the 218-pixel guest-frame minimum defeating 144/96-pixel studio canvas
   compaction;
3. preset-source style thumbnails remaining permanently idle;
4. the empty pre-dispatch Done state and false “apply immediately” copy;
5. the second, disagreeing composer preview and inert first drag; and
6. the Event Appearance canvas appearing after the controls it previews.

Closely coupled accessibility corrections are in scope where they are necessary
to make those repairs complete: a visible file-input focus proxy, visible crop
values, plain-language crop labels, a visible canvas caption, and an explicit
automatic/manual framing state.

The critique's other observations remain backlog. This addendum does not change
the discard-confirmation button hierarchy, add upload byte progress or cancel,
introduce style-only re-entry, confirm cover removal, rewrite the focus trap,
add motion, or restyle every photographic tile.

## 3. Product and visual invariants

The implementation must preserve all of the following:

- Cover changes remain draft-only until the host chooses **Done**.
- The current cover stays live until a replacement or removal commits
  successfully. A rejected, failed, closed, or interrupted experiment cannot
  damage it.
- The host sees one real `EventAppearanceCanvas`; there is no detached or
  differently cropped second preview.
- Event theme tokens remain confined to the simulated guest surface. Manager
  labels, errors, actions, status, focus, and success semantics use global
  Candidary tokens.
- Six preset IDs, five effect IDs, and the existing upload/preset/removal step
  counts remain unchanged.
- Every active control retains a target of at least 44 × 44 CSS pixels even
  when the native radio glyph is 20 × 20 pixels.
- Browser page zoom and pinch zoom remain available. Drag is a convenience;
  the three native ranges remain the complete keyboard and assistive-technology
  alternative.
- The approved viewport modes remain `default` at 500 pixels and taller,
  `compact` from 421 through 499 pixels, and `short` at 420 pixels and shorter.
  This remediation fixes the constraint that defeats those modes; it does not
  move their thresholds.
- No theme edit, drag, range change, or local preview causes a server image
  transform. Publication remains the only path to authoritative output.

## 4. Event Appearance workspace

### 4.1 Canvas order and caption

`EventAppearanceEditor` places the live canvas immediately after the section
heading and before the theme preset and color controls. There is no theme or
color card between the host's choice and the result it changes.

`EventAppearanceCanvas` changes its root from a generic `<div>` to a `<figure>`
with zero default margin and renders **“What guests see”** as its first-child
`<figcaption>`. The figure semantics associate the caption with the simulation
without flattening the event name, date, welcome text, or sample actions into
an opaque image role. The neutral cover summary and **Change cover** action
remain outside the theme-token layer.

The canvas is not made persistently sticky: a 218-pixel sticky guest frame plus
Manager navigation would obscure the editing controls at 320 × 568. Direct
adjacency solves the critique's 600-pixel separation without creating a second
narrow-height obstruction. This remediation does not add a split-column
workspace; the DOM order remains canvas first at every width.

### 4.2 Truthful section copy

Replace:

> Choose the colors and shape guests see. Changes save as you make them. Cover
> changes apply immediately.

with:

> Choose the colors and shape guests see. Theme and color changes save as you
> make them. Cover changes begin after you choose Done, and the current cover
> stays live until the new one is ready.

The copy distinguishes serialized theme autosave from asynchronous cover
publication and states the non-destructive guarantee before the host enters the
studio.

## 5. Choose step

### 5.1 Radio geometry

Cover-source and cover-style radios receive an explicit shared reset:

- 20 × 20-pixel native glyph;
- zero inherited padding and field border;
- no inherited full width;
- Denim accent color; and
- alignment beside the option name rather than above the thumbnail.

The surrounding label remains the interaction target and remains at least
44 × 44 pixels. Selected options continue to use a persistent text name plus a
thicker Denim outline, so the state does not depend on color or the radio glyph
alone.

The upload choice receives `min-width: 0`/flex containment so **Upload a
photo** stays readable without being crushed by the radio. Its outer border is
dashed, matching the established upload/empty-media affordance.

### 5.2 Native file chooser focus

The visually hidden file input remains the native file-selection control. When
it receives `:focus-visible`, its adjacent visible **Choose photo** label shows
the standard 2-pixel Focus outline and offset. The label is not converted into
a faux button with duplicate keyboard behavior.

## 6. Studio canvas geometry

The existing `.cover-studio__canvas` minimum is not sufficient because its
child `.event-appearance-canvas__guest` currently has a larger 218-pixel floor.
The remediation scopes the actual guest frame inside Cover Studio:

- default: 144-pixel minimum guest frame;
- compact: 96-pixel minimum guest frame; and
- short: 96-pixel minimum guest frame.

Outside Cover Studio, the ordinary Event Appearance canvas retains its current
guest-frame sizing.

The studio header becomes one 56-pixel row: Cancel/Close, the focused step
title, and the accurate step counter share the row. This recovers the space
currently consumed by a second title row while preserving the approved title,
counter, focus movement, and dismissal controls.

At 320 × 568, at least one source option must be visible without hiding the
footer. At compact and short heights, all controls remain reachable through the
single scroll region specified by the original design.

## 7. Style thumbnails

### 7.1 Preset sources

When the selected source is a preset, `EventAppearanceEditor` resolves every
style thumbnail locally with:

```text
presetCoverAssetPath(
  1,
  selectedPresetId,
  effect,
  'standard-default',
  '1x',
  'webp'
)
```

All five states supplied to `CoverStylePicker` are therefore `ready` and use
the already shipped preset/effect files. No draft is created, no preview API is
called, and no upload-only session behavior is borrowed for a preset.

### 7.2 Upload sources and explicit idle state

Uploaded-photo style previews continue to use the bounded draft preview flow.
`loading` and `error` keep their existing named text and retry action. A genuine
`idle` value is no longer rendered as an unexplained blank tile; it displays
**“Preview not ready”** while leaving the named radio operable. The selected
full canvas remains the authoritative comparison surface.

## 8. Compose step: one interactive canvas

### 8.1 Remove the second surface

`CoverComposer` no longer renders `.cover-composer__surface` or its own `<img>`.
The sticky `EventAppearanceCanvas` passed to `CoverStudio` is the only visual
composition surface and continues to show the real event name, date, welcome
copy, effect treatment, and mandatory readability scrim.

The `.cover-studio__canvas` wrapper becomes the pointer-drag target only when:

- the current step is Compose;
- the draft and automatic composition are ready; and
- publication has not disabled editing.

The wrapper keeps `touch-action: pan-y pinch-zoom`; it does not capture a
two-pointer gesture.

### 8.2 First-drag behavior

Pointer down records the starting pointer and the current automatic or manual
focus without changing the crop. Pointer movement of at least 3 CSS pixels,
measured with `Math.hypot(deltaX, deltaY)`, begins the drag; smaller movement is
treated as a tap. The first qualifying movement:

1. computes the focus delta from the drag origin rather than jumping to the
   pressed point;
2. calls the existing `onFocusChange` path, which promotes the selection to
   manual mode; and
3. reveals the native ranges at the values produced by that same movement.

Subsequent moves update only local focus. Pointer up or pointer cancel clears
the drag. A tap without movement leaves automatic mode intact.

### 8.3 Framing controls and exact copy

Automatic mode shows:

- status: **Automatic framing**;
- instruction: **Drag the preview to reposition it, or choose Adjust framing
  for precise controls.**; and
- action: **Adjust framing**.

Manual mode shows:

- status: **Manual framing**;
- instruction: **Drag the preview or use the controls below.**;
- **Reset to automatic** immediately before the ranges; and
- the following labels and visible outputs:

| Control | Visible label | Visible output and accessible value text |
| --- | --- | --- |
| X | Left or right | `n% from left` |
| Y | Up or down | `n% from top` |
| Zoom | Zoom | `n%` visually; `n percent zoom` accessibly |

Arrow, Page Up/Down, Home, End, the 400-millisecond settled announcement, safe
zoom ceiling, and reset semantics remain unchanged.

## 9. Done and completion states

### 9.1 Pre-dispatch receipt

Before dispatch, Done always contains a textual receipt. It never renders an
empty control pane.

For a preset:

- choice: **`<Preset name> · <Style name>`**;
- audience: **Guests see this at the top of RSVP and photo delivery.**; and
- guarantee: **Your current cover stays live until the new one is completely
  ready. If anything fails, nothing changes.**

For an upload, the choice is **`Your photo · <Style name>`** and the same
audience and guarantee apply.

For removal:

- choice: **Remove the current cover**;
- audience: **Guests will see the event theme instead.**; and
- guarantee: **The current cover stays live until this change is completely
  applied. If anything fails, nothing changes.**

The existing access-failure, preparing, slow, and retryable-failure messages
appear after this receipt rather than replacing all context.

### 9.2 Manager completion treatment

Applied completion remains announced by the Manager-level reconciler after the
studio closes. **Your new cover is live.** uses a success modifier with Moss
Soft background, Completion Ink text, and a Moss border. `src/styles.css` adds
the documented `--completion-ink: #4e5b28` root token rather than repeating the
literal in the new rule. Preparing remains neutral Paper/Muted, while
warning/failure states retain global danger semantics. Event theme colors never
style these states.

## 10. Component boundaries

The expected implementation ownership is:

- `src/components/EventAppearanceEditor.tsx`
  - move the canvas before theme/color controls;
  - install truthful section copy;
  - provide preset-aware style thumbnail states.
- `src/components/EventAppearanceCanvas.tsx`
  - render the visible, programmatically associated **What guests see**
    caption without changing cover resolution or theme containment.
- `src/features/cover/CoverStudio.tsx`
  - keep step/history/focus behavior;
  - make the one canvas wrapper the conditional drag target;
  - derive the receipt from its existing `source` and `effect` props using the
    preset registry and the exported style-name helper;
  - render the pre-dispatch receipt; and
  - expose the compact single-row header.
- `src/features/cover/CoverComposer.tsx`
  - remove duplicate image rendering;
  - retain range/keyboard/announcement behavior; and
  - render framing mode, instructions, visible values, and reachable reset.
- `src/features/cover/CoverSourcePicker.tsx`
  - retain native file/radio semantics and support the corrected visual
    arrangement.
- `src/features/cover/CoverStylePicker.tsx`
  - export one `coverStyleName(effect)` helper used by both the picker and Done
    receipt so visible style names cannot drift; and
  - render a named idle state instead of a silent blank placeholder.
- `src/components/ManagerCoverPreparationStatus.tsx`
  - apply an explicit success modifier to the applied message.
- `src/styles.css`
  - scope radio, canvas, header, composer-control, focus-proxy, caption, and
    success treatments to these surfaces.

No shared contract, Worker route, D1 migration, R2 key, Workflow, or operation
controller interface changes.

## 11. Error and edge-state behavior

- Missing preset artwork is a normal failed image request and must not trigger
  an upload preview API call. The named style radio remains usable.
- A preset cannot enter `idle` because all 30 preset/effect paths are derived
  synchronously. An unexpected `idle` supplied by another source is visible as
  **Preview not ready**.
- Drag does nothing while preparation is incomplete or editing is disabled,
  and the canvas does not advertise a grab cursor in those states.
- Pointer cancellation leaves the last applied focus intact and clears capture.
- Reset uses the master-owned automatic focus and returns the UI to **Automatic
  framing** without requesting a transform.
- Done remains disabled under the existing incomplete-upload,
  before-dispatch-access-failure, dispatching, and already-dispatched rules.
- The receipt remains readable while preparing or retryable-failed so the host
  knows which intent the operation owns.

## 12. Verification design

Implementation follows test-driven development. Every behavior change receives
a focused failing test before production code changes.

### 12.1 Component coverage

Add or update focused tests to prove:

- Event Appearance renders **What guests see** before the theme selector and
  uses the truthful autosave/publication copy.
- A preset selection supplies five ready static style images with the selected
  preset and each effect in the URL; it creates no draft preview work.
- `idle` style previews expose **Preview not ready** while their radios remain
  named and enabled.
- Compose contains one `EventAppearanceCanvas` and no
  `.cover-composer__surface` image.
- The first real pointer movement from automatic mode reveals the ranges and
  changes focus by delta; pointer down without movement does not.
- Automatic/manual labels, instructions, visible outputs, accessible value
  text, range keys, settled announcement, and reset all remain correct.
- Preset, upload, and removal Done states render the exact receipt copy before
  dispatch and keep it during preparation/retry.
- The existing viewport-mode boundary cases remain 500/default, 499/compact,
  421/compact, and 420/short.
- Applied Manager status receives the success modifier while preparing and
  warning states do not.

### 12.2 Real-browser coverage

Use the existing Cover Studio Playwright fixture and production-preview path to
verify, in one bounded desktop/mobile pass:

- at 320 × 568 and 390 × 844, source/style radio glyphs are 20 × 20, option
  labels remain at least 44 × 44, **Upload a photo** does not collapse to three
  lines, and the file proxy displays focus;
- the actual guest frame measures at the intended 144-pixel default and
  96-pixel compact/short floors without hiding all source options;
- 640 × 450 compact and 320 × 180 short modes retain one usable vertical scroll
  region and reachable footer actions;
- the Compose step displays one canvas, first drag changes its local crop, and
  drag/range movement records zero transform requests;
- preset style tiles load five real static thumbnails;
- **What guests see** precedes theme/color controls and remains visually
  associated with them; and
- axe, horizontal overflow, focus order, and reduced-motion checks remain
  clean on the affected surface.

Visual inspection is bounded to one batched desktop/mobile defect scan, one
consolidated correction pass if needed, and at most one confirmation pass.

### 12.3 Evidence boundaries

Passing component, lint, build, and Playwright checks proves only the local
candidate. It does not prove:

- a deployment or production asset version;
- remote D1 migration state;
- real Cloudflare Images or Workflow conformance;
- physical iPhone/Android behavior; or
- VoiceOver/TalkBack acceptance.

No deployment, remote write, migration, rollout, or physical-device claim is
authorized by this remediation.

## 13. Acceptance criteria

The remediation is complete when all of the following are true:

1. No cover-picker radio inherits the global full-width field geometry.
2. The studio's guest frame visibly compacts to 144/96 pixels at the approved
   viewport modes, with at least one choice visible at 320 × 568.
3. Every preset path presents five real effect thumbnails from the static
   preset matrix.
4. Done always states the selected intent, guest audience, and
   non-destructive guarantee before dispatch.
5. Compose contains one real canvas; dragging it works from automatic mode and
   the native controls expose visible values and a reachable reset.
6. The labelled canvas precedes the appearance choices it previews.
7. The false “Cover changes apply immediately” sentence is absent.
8. Successful completion is visually distinct from preparation without using
   event theme colors.
9. Focused component and browser regressions pass without changing Worker,
   storage, or publication contracts.

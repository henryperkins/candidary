# Mobile-First Host Views Design

**Date:** July 22, 2026
**Status:** Approved direction

> **Supersession note (2026-07-31):** The Manager is no longer five destinations. RSVP was inserted
> after Intake, so every "five destinations" statement below reads as six: the narrow bar is a
> six-column grid, and the wide rail carries six labelled entries. The responsive contract itself is
> unchanged — labels stay visible at the 14 px control-text floor, targets stay 44 × 44, and the
> shell stays contained from 320 px upward. Share also changed: it now carries the permanent event
> link, its QR, and the two entry controls, while manager-link rotation moved to Settings.

## Context

Candidary's create-success and event-manager host views currently adapt a desktop layout at narrow widths. The supplied iPhone screenshots and a 390 px local browser audit show two related problems:

- long guest and management URLs force host content wider than the viewport;
- the mobile manager compresses five destinations into unlabeled icon buttons and restacks the desktop utility rail below every section.

The manager Share view makes the overflow mechanism measurable. Its visible content column is 335 px wide, but the long guest URL gives the first grid item an automatic minimum width of about 824 px. `.manager-main { overflow: hidden; }` clips the copy and rotation controls instead of correcting the layout. The create-success view reuses the same link-card CSS, so it exhibits the same failure.

The current mobile visual suite does not protect this surface: the manager visual test explicitly skips the mobile project.

## Goals

- Make the create-success and manager host views mobile-first from 320 px upward.
- Keep every host surface within the viewport, including realistic secret-link lengths and long event names.
- Make all five manager destinations visually identifiable and comfortably tappable.
- Preserve the established Candidary palette, typography, icon library, and desktop information architecture.
- Remove duplicate or redundant utility content from the mobile reading order.
- Add automated mobile regression coverage for overflow, touch targets, active state, and the supplied host states.

## Non-goals

- No API, token, link-rotation, retention, export, or authorization changes.
- No new manager destinations, account system, bottom navigation, drawer, or separate mobile application.
- No redesign of the guest upload experience.
- No broad rewrite of the global stylesheet or desktop manager.

## Approaches Considered

### 1. CSS containment patch

Add `min-width: 0` and overflow rules to the existing link and grid selectors.

This is the smallest fix, but it leaves the unlabeled mobile navigation, duplicate guest-entry utility, misleading copy feedback, and missing regression coverage intact.

### 2. Responsive composition — selected

Keep one host experience while giving host-specific components explicit mobile and desktop compositions. Share one copyable-link component between Create and Manager, use a two-tier labeled manager header on mobile, retain the desktop rail above the breakpoint, and make utility content contextual.

This resolves the root cause and adjacent inconsistencies without duplicating the workflow.

### 3. Dedicated mobile manager

Build a separate mobile shell with its own navigation and screen composition.

This offers the most layout freedom, but it duplicates stateful manager behavior and increases the chance that mobile and desktop permissions, actions, and empty states drift apart.

## Selected Design

### Shared copyable-link control

Extract the duplicated link-card markup into a `CopyableLinkCard` component used by:

- the guest link on create success;
- the management link on create success;
- the guest link in Manager Share.

The component owns the label, full link value, copy action, and feedback state. Its visual row uses a shrinkable value track plus a fixed copy button: `minmax(0, 1fr) auto`. Every containing grid or flex item in the host views receives an explicit zero minimum width.

The full link remains available to the clipboard and selectable in the document, while the visible line truncates with an ellipsis. The copy button never shrinks below 48 px. A successful copy produces a visible and screen-reader status. A rejected or unavailable clipboard operation reports that copying was unavailable and does not claim success.

Horizontal clipping is not the containment strategy. Host content must measure no wider than its content column before any overflow rule is applied.

### Mobile manager navigation

At widths below 761 px, the manager navigation becomes a sticky two-tier header:

1. a compact 52 px brand row;
2. a five-column navigation row for Intake, Gallery, Notes, Share, and Settings.

Each destination shows its existing Lucide icon and a visible short label. Buttons are at least 52 px tall and occupy equal-width columns. The selected destination uses the existing apricot-soft surface, aubergine foreground, and a strong inset edge; focus retains the global focus ring. Inactive icons and labels retain sufficient contrast without competing with the selected state.

The selected button exposes `aria-pressed="true"`. Intake and Notes counts remain available to assistive technology and appear as compact badges only when nonzero. The brand and navigation do not horizontally scroll.

At 761 px and above, the same navigation data returns to the existing compact left rail. Above 1100 px, the rail expands to its current 184 px presentation with full labels and counts. The existing wide-screen utility rail remains unchanged.

### Mobile host content

Host-specific base rules start from the narrow layout and add columns at wider breakpoints.

- Create success uses one column, 20 px side padding, and a heading size that wraps cleanly at 320–430 px.
- The success copy, QR card, manager main, manager panel, share grid, link rows, and action groups all use `min-width: 0` and `max-width: 100%` where they participate in grid or flex layout.
- Event and section headings allow emergency wrapping for a single long word.
- Share rotation actions stack to full width on phones and return to an inline row when space permits.
- QR images scale to their container and retain their current maximum sizes.
- Gallery tabs and bulk controls wrap without changing their labels or behavior.
- Settings danger-zone controls stack on phones and return to their current inline layout at wider widths.

The current desktop layout and accepted visual language remain the reference above the mobile breakpoint.

### Contextual mobile utilities

The utility sections gain explicit purpose classes: guest entry, event capacity, and complete export.

On mobile:

- the separate guest-entry utility is hidden; the only guest link and QR appear in the primary Share section;
- event capacity is not repeated because the title lifecycle summary already provides photo and storage usage;
- complete export remains reachable as a full-width card after the primary section.

On desktop, all three utility sections remain in the right rail. This removes the duplicate QR and guest-link action from mobile Share and materially shortens every other mobile manager section without hiding export.

### Behavior and data flow

Manager section state, polling, API calls, confirmation dialogs, and server responses remain unchanged. Navigation still swaps the same in-memory panels. Responsive composition affects markup grouping, state presentation, and CSS only.

Clipboard feedback is the only refined client behavior:

1. the user activates Copy;
2. the component awaits `navigator.clipboard.writeText`;
3. success or failure is announced through a scoped status message;
4. the full link remains selectable regardless of clipboard availability.

Link rotation continues to use the current confirmation flow. Long rotated links receive the same responsive containment automatically.

## Accessibility

- Every manager destination has a visible label and a programmatic accessible name.
- Navigation and copy controls meet or exceed a 44 by 44 px target.
- Selected, hover, focus, success, and failure states do not rely on color alone.
- `aria-pressed` communicates the active manager section.
- Copy feedback uses an appropriate live status without moving focus.
- Responsive checks cover 320 px reflow and 200% zoom-equivalent narrow layouts.

These requirements reduce observable risks but do not constitute a full WCAG conformance claim.

## Testing and Verification

### Component and UI tests

- Verify `CopyableLinkCard` copies the complete value and reports success only after the clipboard promise resolves.
- Verify clipboard rejection produces accurate feedback.
- Verify Manager exposes visible destination labels and `aria-pressed` state.
- Preserve existing create, manager polling, filtering, publication, settings, and rotation behavior tests.

### Browser tests

At 390 by 844 and at 320 px wide:

- create an event with production-length guest and management links;
- assert the success heading, warning, link cards, copy buttons, manager CTA, and QR card stay within the viewport;
- open Manager Share with a production-length guest link and assert every visible element stays within the content column;
- assert the five navigation buttons are visible, labeled, and at least 44 by 44 px;
- assert only one guest QR and guest-link action are visible on mobile Share;
- visit Intake, Gallery, Notes, Share, and Settings and assert no section introduces horizontal overflow;
- verify long event names and danger-zone controls reflow;
- capture accepted mobile screenshots for create success and manager Share.

At 1440 px, retain the existing manager visual check and confirm the left and right rails remain intact.

### Completion gates

- Type checking, lint, UI/unit tests, worker tests, and targeted browser tests pass.
- Mobile screenshots are compared with the supplied failure states and the accepted desktop manager concept.
- Design QA records no P0, P1, or P2 mobile mismatch.
- No unrelated files or deployment configuration change.

## Expected Files

- `src/components/CopyableLinkCard.tsx`
- `src/pages/CreatePage.tsx`
- `src/pages/ManagerPage.tsx`
- `src/styles.css`
- `tests/ui/app.test.tsx`
- `tests/e2e/visual-qa.spec.ts`
- `tests/e2e/accessibility.spec.ts`

The implementation plan may split responsive checks into a focused host-layout test file if that keeps the existing suites clearer.

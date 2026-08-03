# Event Start Time Native Input Sizing Design

**Date:** 2026-08-03

**Status:** Approved for implementation

## Decision

Apply the existing create-form native-date sizing safeguard to the event start
time control. The change is limited to the creation flow and preserves the
current desktop and Chromium layout.

## Problem and root cause

The create form applies `width: 100%` and padding to all text-area and input
controls. The event date has a deliberate exception:

```css
.create-field input[type='date'] { width: auto; min-width: 0; }
```

It avoids iOS WebKit's native content-box calculation, where a padded native
picker at `width: 100%` can extend beyond its grid label. The date-driven guest
lifecycle added `input[type='time']` after that exception was written, so the
time field inherits the unsafe percentage width.

At a 320 px viewport, simulating the native content-box calculation leaves the
date input inside its label and places the time input about 29 px past the
label's right edge. This is a layout defect in the native time control, not a
change to the event schedule or form data.

## Chosen implementation

Change the existing selector in `src/styles.css` to match both native picker
types:

```css
.create-field input[type='date'],
.create-field input[type='time'] { width: auto; min-width: 0; }
```

The rule remains scoped to create-form fields. It does not alter the manager
settings editor, generic inputs, padding, touch-target height, submitted
`eventStartTime` value, or native picker affordances. In grid-capable Chromium
layouts, `width: auto` continues to stretch as it does for the event date; on
iOS it avoids the percentage-width path that causes the overflow.

## Alternatives considered

1. Make every input use `box-sizing: border-box`. This is too broad for a
   native-control compatibility issue and could change unrelated controls.
2. Add a separate time-only rule. It would duplicate the date workaround and
   let the paired native controls drift.
3. Extend the date selector to include time. This is the smallest change and
   expresses that both controls share the same platform constraint.

## Regression coverage

Extend the existing real-browser iOS native-date sizing test in
`tests/e2e/public-responsive.spec.ts` to simulate content-box sizing for both
native controls at 320 x 568. It will measure each control and its enclosing
label, asserting that the left edge starts inside the label and the right edge
does not exceed it. The existing document-width assertion remains.

Before the CSS change, the new event-time assertion fails because the control
extends past its label. After the selector change, both native controls remain
contained. The test exercises the production create page and its computed
layout; it does not inspect CSS source text.

## Non-goals

- Changing the visual width of the create form in browsers that already lay out
  the native control correctly.
- Changing date, time, time-zone, or RSVP validation behavior.
- Changing the manager's event-start-time editor.
- Adding a custom time picker or replacing the native input.

## Verification

Run the focused mobile Playwright specification, then the relevant static
checks and a production build. Confirm the create form at 320 px and 390 px in
a real browser, including that the time control remains a usable native input
with no horizontal layout overflow.

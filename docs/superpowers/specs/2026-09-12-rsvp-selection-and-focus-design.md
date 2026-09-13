# RSVP household selection and focus repair

Date: 2026-09-12
Status: Approved and implemented locally; named focused UI/browser checks, independent task reviews and the final whole-change review passed. Not published or deployed.
Baseline: `7990dab` on `main`.
Plan: [RSVP selection and focus implementation](../plans/2026-09-12-rsvp-selection-and-focus.md).

## Goal

Opening a household always shows the host's latest selection and brings its editor into view. Closing it returns focus to a useful dashboard control. Guest focus follows explicit lookup, submission, and Change RSVP actions without moving focus when a saved RSVP is restored automatically.

This repair is independent of photo export. It is the launch-priority change for the September 18, 2026 target discussed in this task; that date is a planning target from this conversation, not evidence of an existing repository release commitment.

## Existing systems retained

- `ManagerRsvpPanel`, `ManagerRsvpDashboard`, and `ManagerRsvpHouseholdEditor` keep their current dashboard/editor layout, staging workflow, server totals, and roster/version checks.
- The nested household editor already has the key `${detail.id}:${detail.version}:${detail.updatedAt}`. Preserve that key: committed/refetched versions must reset local draft state. Adding an ID-only key would weaken existing behavior.
- `GuestRsvpFlow` retains its request generation, server-derived lifecycle/access decisions, session restoration, exact-name lookup, idempotent submission, remembered-name ownership, and draft retention.
- `RsvpHouseholdForm` retains first-invalid-field focus and the conflict-review heading behavior. Primary, secondary, and embedded presentations keep their existing heading levels.
- Use existing design tokens, 44px minimum touch targets, keyboard behavior, and reduced-motion preferences.

## Verified problem

At the baseline, `openHousehold` accepted every response and reset the shared busy state in every `finally`. A slow earlier request could replace the latest household or re-enable controls while a newer operation was pending. Delayed mutation/conflict callbacks could write the same detail state.

Normal opens do not request heading focus. The editor follows the entire household list, so it can appear below the visible screen. Close currently clears detail without restoring focus.

Successful guest lookup and submission replace their controls with a new stage without moving focus. A blanket focus-on-mount repair would introduce a different problem by moving focus during automatic session restoration.

## Host selection ownership

Give detail selection its own monotonically increasing generation, distinct from list sequencing. Its owner includes event ID and requested household ID. Selecting another household, closing, changing events, and unmounting retire the previous owner.

At the start of an explicit open, record the originating button and selected household ID, clear the previous detail, and show a loading state with a Close household action. The selected dashboard row follows the requested ID while loading. A previous household is never editable under a new selection.

Only the current owner may apply a detail response, detail error, conflict-refresh result, focus request, or busy reset. Gate `finally` as well as `try` and `catch`. A stale operation must not reopen a closed editor, replace the current household, or clear the pending state for another request.

Apply the same ownership check to mutation detail results. A committed write for a household that was subsequently closed or replaced still updates the current event's observed roster version and refreshes its totals, but must not reopen that household. Ignore callbacks for a retired event or unmounted panel. A stale write's cleanup cannot unlock a newer request. Preserve `onEventWrite` around the actual server mutation.

## Host focus

After a current explicit open succeeds, focus the household heading and reveal it without animation. Request focus again after a current conflict refresh. Ordinary typing and successful writes do not request a new heading focus. Keep the existing editor key and explicitly account for household identity in the heading-focus effect.

On close, retire the request first, remove detail/loading state, then restore focus to the originating row if it remains connected. If a refresh replaced that node, use the current row for the same household. If that household is no longer in the dashboard, use the stable Guest list and RSVPs heading. A staged-import receipt that opens a household uses the same fallback because its originating control is removed.

Do not move the editor before the dashboard, add a modal, or change the normal reading order. Browser verification must establish that the focused heading is actually within the viewport and unobscured by persistent chrome.

## Guest focus

Carry an explicit heading-focus flag with the screen transition that earned it. The normal `screenForHousehold` and restore-on-load paths do not set that flag.

| Transition | Focus behavior |
| --- | --- |
| Explicit successful lookup to a household form or saved response | Focus the new stage heading |
| Explicit successful submission to receipt | Focus the receipt heading |
| Change RSVP to editing | Focus the household form heading |
| Conflict refresh while editing remains allowed | Keep the existing Review updated household focus |
| Automatic session restoration or lifecycle refresh | Do not request heading focus |
| Attendance/name edits, submission pending, or ordinary retry error | Do not request heading focus |
| Invalid submission | Preserve focus on the first invalid control |

Focusable stage headings use `tabIndex={-1}` and remain outside sequential tab navigation. The explicit form focus effect depends on the flag, household ID, and review-mode guard, not every draft or version change. Saving and ordinary error stages carry no explicit-focus flag. Keep conflict focus separate so its existing version-sensitive behavior survives. Never focus a text input merely to announce a new stage.

## Verification

The tracked regression tests are the reviewable reproduction. Existing discovery screenshots and scripts under ignored `output/playwright/` are supplemental local observations and are not a passing gate or repository evidence.

1. `tests/ui/manager-rsvp-panel.test.tsx`: controlled A/B response ordering; stale success/error/finally; close during loading; delayed mutation/conflict results; event retirement; normal open and conflict heading focus; repeat opens; close-to-row and missing-row fallback.
2. `tests/ui/guest-rsvp-flow.test.tsx`: explicit lookup/submit/change heading focus; primary and embedded heading levels; no focus theft during restoration or lifecycle changes; existing validation and conflict focus retained.
3. `tests/e2e/rsvp-responsive.spec.ts` and `tests/e2e/rsvp-journey.spec.ts`: focused additions named with the `RSVP focus` prefix. Use a long household list and 320/390px phone views plus desktop. Assert heading focus, viewport position, unobscured controls, return focus, containment, and normal guest navigation. Use fixture routes and fictional data only.

Named commands are in the implementation plan. Do not run repository-wide gates for this repair. Browser emulation does not establish physical iPhone keyboard or VoiceOver behavior; record those separately if performed. No new test result is claimed by this design.

## Non-goals

- Photo selection, exports, cloud providers, or an Apple integration.
- RSVP API, database, lifecycle, invitation lookup, authentication, or roster-policy changes.
- Guest-list staging redesign, new list/filter behavior, or broad UI restyling.
- Automatic focus on every render, passive restoration, or background refresh.
- Production writes, publication, deployment, or Git integration.

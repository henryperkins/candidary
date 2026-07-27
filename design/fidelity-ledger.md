# Candidary fidelity ledger

Reviewed on 2026-07-22 against the approved three-state wedding photo-drop concept at `.superpowers/brainstorm/1543-1784697424/content/camera-selection-flow-v3.html` and the established Candidary visual references in `design/concepts/`, and re-confirmed on 2026-07-27 against tracked evidence.

Evidence is now committed rather than disposable. Image names below are the baselines in
`tests/e2e/visual-qa.spec.ts-snapshots/`, stored with Playwright's default `-mobile-win32` suffixes
and asserted by `npm run test:e2e`; named tests are the specs that measure the claim. Nothing here
cites `output/`, which remains a disposable working folder. `design-qa.md` holds the full route,
state, width, and baseline matrix and the one open finding.

| Contract point | Accepted direction | Browser result | Disposition |
| --- | --- | --- | --- |
| Mobile first viewport | Event identity, required guest name, camera first, recent photos second | `guest-long-welcome-320.png`, `guest-responsive.spec.ts` fold cases | The complete primary decision fits within 320 x 568 without horizontal overflow, even on the longest welcome a host can save. Gallery, deliveries, and notes begin below that viewport and cannot compete with sending photos. |
| Required identity | One required name field, remembered on the device | `guest-long-welcome-320.png` plus core-journey test | The field is the only guest input before photo selection. Empty submission focuses the field with an inline error; a saved name is restored on the next visit and remains editable. |
| Capture and selection | `Take a photo` primary; `Choose recent photos` secondary | `guest-long-welcome-320.png`, `guest-landscape-844x390.png`, input-contract tests | The camera control invokes a single file input with `capture="environment"`; the library control accepts multiple recents. Both targets stay reachable in portrait, landscape, and at the 640 x 450 zoom equivalent. |
| Review before transfer | Selected-photo grid, edit/remove controls, explicit send | `guest-review-320.png`, automated core journey | Selection never starts a network transfer. Guests can inspect and remove files, then use one count-aware `Send` action. Unsupported or oversized files stay visible with a specific error inside the 12–14 px caption band. |
| Reliable progress | At most two active uploads with per-file progress, retries, and removal | Queue unit tests and core-journey partial-failure test | Reservation is batched, transfers run two at a time, and every file reports its own state. A partial failure preserves delivered items and exposes a retry for only the unresolved file. |
| Terminal receipt | Delivered count, host name, guest thanks, and no next action | Automated core journey, `guest-responsive.spec.ts` receipt case | The receipt replaces the entire guest journey only after every selected photo is delivered or explicitly removed. It has no redirect, gallery prompt, or fourth step. |
| Secondary features | Gallery, previous deliveries, and notes remain available but subordinate | `guest-secondary-long-content-320.png`, `fullscreen-long-caption-320.png` | These features are collapsed under `More from the event`, below the primary canvas, and disappear with the rest of the page after the terminal receipt. 80-character filenames wrap inside their column rather than widening the page. |
| Private-by-default delivery | Every original reaches the host; sharing is a separate decision | `manager-actions-320.png` and manager API tests | Gallery visibility defaults off. New photos arrive as `Unpublished` private originals in Live intake; publish/hide actions affect gallery projection without changing delivery or export inclusion. |
| Host operating view | Live intake first, with guest lookup, QR/link, capacity, originals, and export | `manager-nav-768.png`, `manager-nav-count-390.png`, `manager-export-first-390.png`, `manager-responsive.spec.ts` across 320–1440 | The manager opens on the recent private collection, can filter by required guest name, download any original, and prepare a complete partitioned export. The five destinations stay labelled from 320 px to 1440 px, and the 184 px navigation rail with the 330 px utility rail returns at 1101 px. |
| Visual system | Warm parchment, paper surfaces, aubergine actions, apricot accents, moss completion | Every baseline above | The implementation retains the established typography, palette, restrained borders, Lucide outlines, and explicit focus/status treatment while simplifying the guest composition around the approved photo-first flow. One contrast pairing on the guest and landing surfaces remains open; see `design-qa.md`. |

## Intentional adaptations

- The approved three-state concept used a schematic 260 px phone. The implementation expands naturally to the real 390 px mobile viewport and uses a compact centered panel on desktop without adding workflow steps.
- `Retake a photo` remains available during review because camera capture is a core entry scenario. It modifies the current selection; it is not a post-delivery action.
- The earlier image-led guest concept remains a visual-language reference, but its large cover, contribution strip, gallery, and notes no longer occupy the primary viewport. This is the approved product-priority change, not a fidelity mismatch.

## QA outcome

No material mismatch remains between the approved wedding photo-drop journey and the implemented browser experience. One serious `color-contrast` finding on the guest and landing surfaces is open and awaiting a design decision; it is recorded with measurements and options in `design-qa.md`.

Physical iPhone and Android checks remain release gates because desktop browser emulation cannot prove native camera-picker behavior. The automated accessibility engine, tracked baselines, and geometry assertions are supporting evidence, not a substitute for those gates — `docs/deployment.md` lists them.

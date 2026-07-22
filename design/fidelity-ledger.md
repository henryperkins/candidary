# Candidary fidelity ledger

Reviewed on 2026-07-22 against the approved three-state wedding photo-drop concept at `.superpowers/brainstorm/1543-1784697424/content/camera-selection-flow-v3.html` and the established Candidary visual references in `design/concepts/`. Final browser captures are in `output/playwright/screenshots/`.

| Contract point | Accepted direction | Browser result | Disposition |
| --- | --- | --- | --- |
| Mobile first viewport | Event identity, required guest name, camera first, recent photos second | `guest-mobile.png` | The complete primary decision fits within 390 x 844 without horizontal overflow. Gallery, deliveries, and notes begin below that viewport and cannot compete with sending photos. |
| Required identity | One required name field, remembered on the device | `guest-mobile.png` plus core-journey test | The field is the only guest input before photo selection. Empty submission focuses the field with an inline error; a saved name is restored on the next visit and remains editable. |
| Capture and selection | `Take a photo` primary; `Choose recent photos` secondary | Mobile and desktop guest captures plus input-contract tests | The camera control invokes a single file input with `capture="environment"`; the library control accepts multiple recents. A camera capture enters review marked `New`, where the guest can append recents or retake. |
| Review before transfer | Selected-photo grid, edit/remove controls, explicit send | Automated core journey | Selection never starts a network transfer. Guests can inspect and remove files, then use one count-aware `Send` action. Unsupported or oversized files stay visible with a specific error. |
| Reliable progress | At most two active uploads with per-file progress, retries, and removal | Queue unit tests and core-journey partial-failure test | Reservation is batched, transfers run two at a time, and every file reports its own state. A partial failure preserves delivered items and exposes a retry for only the unresolved file. |
| Terminal receipt | Delivered count, host name, guest thanks, and no next action | Automated core journey | The receipt replaces the entire guest journey only after every selected photo is delivered or explicitly removed. It has no redirect, gallery prompt, or fourth step. |
| Secondary features | Gallery, previous deliveries, and notes remain available but subordinate | `guest-mobile.png`, `guest-desktop.png` | These features are collapsed under `More from the event`, below the primary canvas, and disappear with the rest of the page after the terminal receipt. |
| Private-by-default delivery | Every original reaches the host; sharing is a separate decision | `manager-desktop.png` and manager API tests | Gallery visibility defaults off. New photos arrive as `Unpublished` private originals in Live intake; publish/hide actions affect gallery projection without changing delivery or export inclusion. |
| Host operating view | Live intake first, with guest lookup, QR/link, capacity, originals, and export | `manager-desktop.png` | The manager opens on the recent private collection, can filter by required guest name, download any original, and prepare a complete partitioned export. Gallery publication and notes remain separate navigation destinations. |
| Visual system | Warm parchment, paper surfaces, aubergine actions, apricot accents, moss completion | All accepted references and final captures | The implementation retains the established typography, palette, restrained borders, Lucide outlines, and explicit focus/status treatment while simplifying the guest composition around the approved photo-first flow. |

## Intentional adaptations

- The approved three-state concept used a schematic 260 px phone. The implementation expands naturally to the real 390 px mobile viewport and uses a compact centered panel on desktop without adding workflow steps.
- `Retake a photo` remains available during review because camera capture is a core entry scenario. It modifies the current selection; it is not a post-delivery action.
- The earlier image-led guest concept remains a visual-language reference, but its large cover, contribution strip, gallery, and notes no longer occupy the primary viewport. This is the approved product-priority change, not a fidelity mismatch.

## QA outcome

No material mismatch remains between the approved wedding photo-drop journey and the implemented browser experience. Physical iPhone and Android checks remain release gates because desktop browser emulation cannot prove native camera-picker behavior.

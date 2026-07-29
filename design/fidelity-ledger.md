# Candidary fidelity ledger

Reviewed on 2026-07-22 against the approved three-state wedding photo-drop concept at `.superpowers/brainstorm/1543-1784697424/content/camera-selection-flow-v3.html` and the established Candidary visual references in `design/concepts/`, re-confirmed on 2026-07-27, and extended on 2026-07-29 for the approved per-event theme contract.

Evidence is now committed rather than disposable. Image names below are the baselines in
`tests/e2e/visual-qa.spec.ts-snapshots/` and
`tests/e2e/event-theming-visual.spec.ts-snapshots/`, stored with Playwright's project/platform
suffixes and asserted by `npm run test:e2e`; named tests are the specs that measure the claim.
Nothing here cites `output/`, which remains a disposable working folder. `design-qa.md` holds the
full route, state, width, and baseline matrix.

| Contract point | Accepted direction | Browser result | Disposition |
| --- | --- | --- | --- |
| Mobile first viewport | Event identity, required guest name, camera first, recent photos second | `guest-long-welcome-320.png`, `guest-responsive.spec.ts` fold cases | The complete primary decision fits within 320 x 568 without horizontal overflow, even on the longest welcome a host can save. Gallery, deliveries, and notes begin below that viewport and cannot compete with sending photos. |
| Required identity | One required name field, remembered on the device | `guest-long-welcome-320.png` plus core-journey test | The field is the only guest input before photo selection. Empty submission focuses the field with an inline error; a saved name is restored on the next visit and remains editable. |
| Capture and selection | `Take a photo` primary; `Choose recent photos` secondary | `guest-long-welcome-320.png`, `guest-landscape-844x390.png`, responsive boundary and input-contract tests | The camera control invokes a single file input with `capture="environment"`; the library control accepts multiple recents. Both targets stay reachable in portrait, at 844 x 500/520/567, and at the 640 x 450 zoom equivalent; the 844 x 390 case proves a full camera target. |
| Review before transfer | Selected-photo grid, edit/remove controls, explicit send | `guest-review-320.png`, automated core journey | Selection never starts a network transfer. Guests can inspect and remove files, then use one count-aware `Send` action. Unsupported or oversized files stay visible with a specific error inside the 12–14 px caption band. |
| Reliable progress | At most two active uploads with per-file progress, retries, and removal | Queue unit tests and core-journey partial-failure test | Reservation is batched, transfers run two at a time, and every file reports its own state. A partial failure preserves delivered items and exposes a retry for only the unresolved file. |
| Terminal receipt | Delivered count, host name, guest thanks, and no next action | Automated core journey, `guest-responsive.spec.ts` receipt case | The receipt replaces the entire guest journey after every deliverable photo is delivered. Validation-rejected choices are summarized by its caveat rather than counted as delivered. It has no redirect, gallery prompt, or fourth step. |
| Secondary features | Gallery, previous deliveries, and notes remain available but subordinate | `guest-secondary-long-content-320.png`, `fullscreen-long-caption-320.png` | These features are collapsed under `More from the event`, below the primary canvas, and disappear with the rest of the page after the terminal receipt. 80-character filenames wrap inside their column rather than widening the page. |
| Private-by-default delivery | Every original reaches the host; sharing is a separate decision | `manager-actions-320.png` and manager API tests | Gallery visibility defaults off. New photos arrive as `Unpublished` private originals in Live intake; publish/hide actions affect gallery projection without changing delivery or export inclusion. |
| Host operating view | Live intake first, with guest lookup, QR/link, capacity, originals, and export | Layout and reachability: `manager-nav-768.png`, `manager-nav-count-390.png`, `manager-export-first-390.png`, `manager-responsive.spec.ts` across 320–1440. Behaviour behind it, which no baseline can carry: `tests/worker/manage-api.test.ts` (guest-name filtered intake), `tests/worker/upload-api.test.ts` (the original served to the manager session and refused to the guest one), `tests/worker/export-api.test.ts` (bounded parts, manifest, manager-only URLs) | The manager opens on the recent private collection, can filter by required guest name, download any original, and prepare a complete partitioned export. The five destinations stay labelled from 320 px to 1440 px, and the 184 px navigation rail with the 330 px utility rail returns at 1101 px. |
| Visual system | Warm parchment, paper surfaces, aubergine actions, apricot accents, moss completion | Every baseline above plus both theme suites | The current established global tokens remain binding and are unchanged by event theming for public, account, create, host, Manager, browser, and installed-app chrome. The intentional event-scoped 45-property overlay adds four guest appearances and the documented Default input/placeholder/Notes corrections without changing danger or delivery semantics, fixed typography, spacing, or host chrome. The automated engine reports no contrast violation on the rendered public, create, guest, full-screen, Manager, and manager credential-recovery surfaces; that claim excludes unrendered failed/action-refusal states and physical-device conformance. |
| Browser and installed-app chrome | Aubergine theme chrome with a Parchment launch background | `pwa-assets.test.ts`, `pwa.spec.ts`, and `verify:pwa-build` | The already-approved installed-app work changed the global browser theme from the undocumented `#32122f` to the documented Aubergine token `#42103b`. Event theming does not alter that global chrome. Browser chrome sits outside tracked page captures, so the correction does not churn visual snapshots. |

## Per-event theme evidence

| Contract point | Accepted direction | Automated/browser result | Disposition |
| --- | --- | --- | --- |
| Preset compatibility | Four stable presets: `candidary-default` (Candidary Default), `garden-party` (Garden Party), `midnight-film` (Midnight Film), and `coastal-light` (Coastal Light) | Unit tests pin all 45 values for each preset: 180 version-1 token values, stable IDs/names, deterministic serialization, and the fixed 45-key CSS adapter | Preset IDs never branch components or CSS. Default fallbacks reproduce Candidary Default on the three approved event scopes. |
| Constrained overrides | Optional primary and accent colors only | Unit, Worker, UI, and browser cases cover strict six-digit lowercase normalization, malicious/unknown input, custom black, white, dark/light colors, and custom `#767676` mid-tone | Primary and accent resolve only their documented families. Focus, danger, delivery, fonts, spacing, and hierarchy remain outside host control. |
| Guest lifecycle scope | One resolved theme across entry, cover, remembered/invalid name, review, reservation, queue, transfer, finalize, cancel, retry/failure, receipt, gallery, deliveries, Notes, footer, and full screen | `event-theming.spec.ts` rotates the eight primary state rows across 320 × 568, 390 × 844, and 1280 × 900; targeted lifecycle, keyboard, target-size, zoom, reduced-motion, and containment cases supplement the matrix | Loading and authorization errors remain globally branded. Fixed semantic labels, glyphs, retry behavior, failure red, delivered moss, and caption gradient remain recognizable in every preset. |
| No-cover and cover contrast | Preset-owned gradients; existing private cover plus localized scrim | Every preset checks all visible no-cover pixels at natural 390 × 205, expanded 390 × 420, and production 620 × 265 geometry. The mask includes straight edges and excludes clipped rounded corners. Cover text is checked over pure white, pure black, and the photographic fixture | Normal/control copy clears 4.5:1. Input boundary and focus checks clear 3:1 against applicable surfaces. No raw URL or second image pipeline was added. |
| Manager appearance isolation | Local controls and inert preview inside existing Settings | UI and browser evidence proves Manager chrome receives no event variables; preset/color changes, Reset, and preview are local until Save. A failed Save retains raw input, draft, preview, unsaved status, scroll position, and a retryable action; success adopts the server-normalized event | The editor adds no sixth destination, upload flow, local storage, live guest action, or duplicate page heading. |
| Persistence and API isolation | One canonical configuration per event | Migration 0007 backfills existing rows without table reconstruction and preserves sessions, media, messages, and ownership. Worker tests cover create/read view allowlists, canonical storage, manager-link/account authorization, credential-specific CSRF, update/reset, D1 refusal, and cross-event isolation | Only `events.theme_config` stores config. Resolved tokens are derived at event-view boundaries; guest reads omit manager fields, host lists omit theme, and upload authentication does not resolve presentation. |
| Browser and release boundary | Local automated evidence is supporting evidence, not deployment evidence | Playwright uses Chromium/Desktop Chrome only: a 1440 × 1000 desktop project and a 390 × 844 mobile/touch project, with explicit viewport-pinned cases | Firefox, WebKit/Safari, physical iPhone/Android, native camera-picker, Cloudflare deployment, remote D1 migration, and live production route/CSP/data validation were not performed. |

### New reviewed theme screenshots

| Tracked file | Accepted state | Pixels |
| --- | --- | ---: |
| `guest-default-cover-390-mobile-win32.png` | Default cover, localized scrim, and first-fold hierarchy | 390 × 844 |
| `guest-default-notes-390-mobile-win32.png` | Default Notes form, placeholder, feed, and divider crop | 390 × 1050 |
| `guest-garden-cover-390-mobile-win32.png` | Garden Party cover first fold | 390 × 844 |
| `guest-midnight-review-progress-320-mobile-win32.png` | Midnight Film review and getting-ready state | 320 × 625 |
| `guest-coastal-entry-390-mobile-win32.png` | Coastal Light no-cover entry | 390 × 844 |
| `guest-coastal-receipt-390-mobile-win32.png` | Coastal Light terminal delivery receipt | 390 × 844 |
| `manager-event-appearance-390-mobile-win32.png` | Complete Settings editor/preview with global chrome outside scope | 390 × 3297 |
| `fullscreen-midnight-1280x900-desktop-win32.png` | Six-photo Midnight Film full-screen composition | 1280 × 900 |

The Default Notes image is a new approved theme baseline, not one of the three
existing Default baseline updates. The final Task 8 evidence revision changed
no PNG.

Three existing Default baselines changed intentionally:

- `create-validation-focus-390-mobile-win32.png` — the approved preset selector;
- `guest-long-welcome-320-mobile-win32.png` — the corrected name-input boundary and placeholder; and
- `guest-landscape-844x390-mobile-win32.png` — the same input correction in phone landscape.

Three protected Default baselines remain pixel-identical to the pre-theme base:

| Protected file | SHA-256 |
| --- | --- |
| `guest-review-320-mobile-win32.png` | `914F0DE04AE35EE4C1EC139A91502647B3521E351DD3C5E5F81322B033DBD88C` |
| `guest-secondary-long-content-320-mobile-win32.png` | `04143911B1BBF8EACE58C43A632326C8184459F06E3F14C7DAFB36ECF6275F7F` |
| `fullscreen-long-caption-320-mobile-win32.png` | `FF034EF996F939E4641AD0A68CE2162B4EEA5A645EDFF8A9943B5D1EF0BD4AB2` |

## Intentional adaptations

- The approved three-state concept used a schematic 260 px phone. The implementation expands naturally to the real 390 px mobile viewport and uses a compact centered panel on desktop without adding workflow steps.
- `Retake a photo` remains available during review because camera capture is a core entry scenario. It modifies the current selection; it is not a post-delivery action.
- The earlier image-led guest concept remains a visual-language reference, but its large cover, contribution strip, gallery, and notes no longer occupy the primary viewport. This is the approved product-priority change, not a fidelity mismatch.

## QA outcome

No material mismatch remains between the approved wedding photo-drop journey and the reviewed browser evidence. The serious `color-contrast` finding the accessibility engine surfaced on the guest and landing surfaces has been resolved without changing a global design-system token; the scoped event overlay adds only the documented compatibility corrections and curated event appearances. `design-qa.md` records what moved, the resulting ratios, and the fact that global muted ink on parchment clears the threshold by only 0.0046.

Physical iPhone and Android checks remain release gates because desktop browser emulation cannot prove native camera-picker behavior. The automated accessibility engine, tracked baselines, and geometry assertions are supporting evidence, not a substitute for those gates — `docs/deployment.md` lists them.

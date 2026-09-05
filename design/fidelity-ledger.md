# Candidary fidelity ledger

Reviewed on 2026-07-22 against the approved three-state wedding photo-drop concept at `.superpowers/brainstorm/1543-1784697424/content/camera-selection-flow-v3.html` and the established Candidary visual references in `design/concepts/`, re-confirmed on 2026-07-27, extended on 2026-07-29 for the approved per-event theme contract, extended on 2026-08-29 for the three-mode manager Gallery workspace, and extended on 2026-09-05 for that workspace's phone pass.

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
| Terminal receipt | Delivered count, host name, guest thanks, and one quiet Guestbook follow-on | Automated core journey, `guest-responsive.spec.ts` receipt case, and `guest-coastal-receipt-390.png` | The receipt replaces the photo-delivery journey after every deliverable photo is delivered. Validation-rejected choices are summarized by its caveat rather than counted as delivered. Its sole follow-on is `Leave a guestbook note`; there is no redirect, gallery prompt, or fourth step. |
| Secondary features | Guestbook, gallery, and previous deliveries remain available but subordinate | `guest-secondary-long-content-320.png`, `guest-default-guestbook-390.png`, `fullscreen-long-caption-320.png` | These features remain under the secondary region below the primary canvas. Guestbook is the first disclosure and is the only secondary surface the terminal receipt can reopen. 500-character notes, 160-character prompts, and 80-character filenames wrap rather than widening the page. |
| Private-by-default delivery | Every original reaches the host; sharing is a separate decision | `manager-actions-320.png` and manager API tests | Gallery visibility defaults off. New photos arrive as `Unpublished` private originals in Live intake; publish/hide actions affect gallery projection without changing delivery or export inclusion. |
| Host operating view | Live intake first, with guest lookup, QR/link, capacity, originals, and export | Layout and reachability: `manager-nav-768.png`, `manager-nav-count-390.png`, `manager-export-first-390.png`, `manager-responsive.spec.ts` across 320–1440. Behaviour behind it, which no baseline can carry: `tests/worker/manage-api.test.ts` (guest-name filtered intake), `tests/worker/upload-api.test.ts` (the original served to the manager session and refused to the guest one), `tests/worker/export-api.test.ts` (bounded parts, manifest, manager-only URLs) | The manager opens on the recent private collection, can filter by required guest name, download any original, and prepare a complete partitioned export. The six destinations stay labelled from 320 px to 1440 px, and the 184 px navigation rail with the 330 px utility rail returns at 1101 px. |
| Manager Gallery workspace | One Gallery destination carrying three modes — `Library`, `Album`, `Guest gallery` — behind one pinned switch, with the active mode's own primary action reachable without leaving the photographs | Frame and containment: `manager-responsive.spec.ts` across 320–1440, and `album-workspace.visual.spec.ts`, whose axe, keyboard, zoom-proxy, and 320 px containment cases carry the claim while its own captures remain working files. Composition: `manager-private-mosaic-320.png`, `manager-shared-gallery-320.png`, `gallery-export-390.png` | The navigation row and the mode switch are the only pinned chrome; the audience facts, the search field, and the toolbar rail all scroll with the photographs. Below 761 px the active mode's one primary action is docked to the bottom edge, and from 761 px it returns to the heading baseline. Every mode raises exactly one selection tray, and the dock stands down while a tray exists, so two fixed bars never share the bottom edge. |
| Gallery workspace phone pass | The design system's `templates/gallery-workspace` as it stood on 4 September 2026: below 761 px the Library toolbar is one row of icon-sized 44 px controls whose words stay in the accessible names, the search field folds behind its own `Search photos` control, the tray's two verbs each take the row with `Clear selection` as a 44 px corner glyph, the pick pill clears 44 px, Album entries are thumbnail rows, Album details unfold cover-beside-caption, the three-mode switch stays one row at 320, and the reset consequence is styled at every width | Measured on this build with a replica of the design system's `scraps/gallery-phone-audit.html` at 320 × 568, 360 × 740 and 390 × 844 under mobile emulation, plus 1024 × 800: zero horizontal overflow in Library, selecting, Album folded and open, and Guest gallery; pinned chrome (nav plus mode row) 100 px at all three phone widths; Library toolbar one 48 px row at all three, every control 44 px, no control under 44 px in Library; Library tray 366 × 228 px at 390 and 296 × 246 px at 320 with both verbs full-width and Clear 44 × 44 at the corner; Album entry 118 px at 390, 109 px at 360, 150 px at 320 with the controls on their own row; Album details 60 px folded and 410 px open at 390; `--gallery-control-obstruction` 52 px at 320. Contracts: `manager-responsive.spec.ts` (320 mode tracks, obstruction budget, phone tray rows, the search fold), `host-private-gallery.test.tsx` and `album-workspace.test.tsx` (accessible names, word spans, selection controls, the stylesheet's narrow and phone-pass rules), `gallery-dock.test.ts` (the reservation reads the docked element's laid-out top). The design system's audit recorded the shipped layout it replaced against the same stylesheet: 194 px of pinned chrome at 320, six Library controls under 44 px, a 369 px Album card at 390, and a 231 px tray whose secondary verb wrapped beside Clear. | Production keeps the Manager title and lifecycle facts above the workspace, so the first photograph sits lower than in the template's isolated shell (555 px at 320 × 568 here against the template's 406) and that gap is retained deliberately. The Windows-captured `manager-private-mosaic-320.png` and `manager-shared-gallery-320.png` baselines need re-capture on Windows: the 320 pick pill and the Guest gallery toolbar changed by design, and this Linux run cannot compare or refresh a `-win32` image. |
| Visual system | Warm parchment, paper surfaces, chestnut actions, denim accents, moss completion | Every baseline above plus both theme suites | The established Chestnut/Denim global tokens remain binding for public, account, create, host, Manager, browser, and installed-app chrome. Event theming does not mutate those global tokens: its scoped 45-property overlay adds four guest appearances, with `candidary-default` remapped to the Chestnut/Denim compatibility appearance and the documented Default input/placeholder/Notes corrections, while danger and delivery semantics, typography, spacing, and host chrome remain fixed. The automated engine reports no contrast violation on the rendered public, create, guest, full-screen, Manager, and manager credential-recovery surfaces; that claim excludes unrendered failed/action-refusal states and physical-device conformance. |
| Browser and installed-app chrome | Chestnut strong theme chrome with a Parchment launch background | `pwa-assets.test.ts`, `pwa.spec.ts`, and `verify:pwa-build` | Browser and installed-app chrome use the documented Chestnut strong token `#31170c`; the undocumented `#32122f` and intermediate Aubergine value `#42103b` are retired from global Candidary and Default chrome. Event theming does not alter that global chrome. Browser chrome sits outside tracked page captures; the Manager appearance baseline includes global page chrome and must match the integrated palette. |

## Per-event theme evidence

| Contract point | Accepted direction | Automated/browser result | Disposition |
| --- | --- | --- | --- |
| Preset compatibility | Four stable presets: `candidary-default` (Candidary Default), `garden-party` (Garden Party), `midnight-film` (Midnight Film), and `coastal-light` (Coastal Light) | Unit tests pin all 45 values for each preset: 180 version-1 token values, stable IDs/names, deterministic serialization, and the fixed 45-key CSS adapter | Preset IDs never branch components or CSS. Default values and fallbacks reproduce the Chestnut/Denim Candidary Default on the three approved event scopes. |
| Constrained overrides | Optional primary and accent colors only | Unit, Worker, UI, and browser cases cover strict six-digit lowercase normalization, malicious/unknown input, custom black, white, dark/light colors, and custom `#767676` mid-tone | Primary and accent resolve only their documented families. Focus, danger, delivery, fonts, spacing, and hierarchy remain outside host control. |
| Guest lifecycle scope | One resolved theme across entry, cover, remembered/invalid name, review, reservation, queue, transfer, finalize, cancel, retry/failure, receipt, gallery, deliveries, Guestbook, footer, and full screen | `event-theming.spec.ts` rotates the eight primary state rows across 320 × 568, 390 × 844, and 1280 × 900; targeted lifecycle, keyboard, target-size, zoom, reduced-motion, and containment cases supplement the matrix | Loading and authorization errors remain globally branded. Fixed semantic labels, glyphs, retry behavior, failure red, delivered moss, and caption gradient remain recognizable in every preset. |
| No-cover and cover contrast | Preset-owned gradients; current revisioned cover plus localized runtime treatment | All 720 preset/effect/theme/profile assets are checked by the deterministic compositor, and uploaded-cover monotonicity is proved against the brightest possible source. Twelve inspected directional profile crops additionally prove image → optional grain → scrim → copy order without treating screenshots or axe as pixel-contrast measurement. | Normal/control copy clears 4.5:1. Input boundary and focus checks clear 3:1 against applicable surfaces. Delivery uses only same-origin current-revision slots; no storage key, master fallback, or lazy transform was added. |
| Manager appearance isolation | One live guest canvas inside existing Settings, with global Manager controls outside its theme layer | UI and browser evidence proves Manager chrome receives no event variables; theme edits, Cover Studio presets/uploads/effects/focus, Reset, and the live canvas remain local until the Worker confirms them. A failed theme autosave retains the newest draft and retry action; an accepted cover publication remains owned by one Manager reconciler across Studio close/reopen, hidden tabs, dropped responses, and access recovery. | The editor adds no sixth destination, duplicate page heading, second preview, or themed Manager action. `Change cover` opens the one sheet/dialog flow; its summary/progress/retry controls remain global. |
| Responsive cover delivery | Six total measured profiles and server-qualified density candidates | Browser evidence pins 360/361, 390/391, 599/600/601, 699/700, and 759/760 boundaries; WebP→JPEG recovery, final gradient fallback, one sanitized refresh, unchanged-revision anti-loop, and newer-revision reset pass for Manager and guest surfaces. | Nested views and revisioned same-origin routes replace the compatibility sentinel/reader. A missing current slot never causes an old revision, legacy object, cross-event set, or normalized master to render. |
| Persistence and API isolation | One canonical configuration per event | Migration 0007 backfills existing rows without table reconstruction and preserves sessions, media, messages, and ownership. Worker tests cover create/read view allowlists, canonical storage, manager-link/account authorization, credential-specific CSRF, update/reset, D1 refusal, and cross-event isolation | Only `events.theme_config` stores config. Resolved tokens are derived at event-view boundaries; guest reads omit manager fields, host lists omit theme, and upload authentication does not resolve presentation. |
| Browser and release boundary | Local automated evidence is supporting evidence, not deployment evidence | The Phase-3 focused browser gate passed 142 cases with 76 intentional project skips and zero failures in Chromium/Desktop Chrome. Dynamic axe covered Studio Choose/loading/error/Compose/Style/Done/discard/preparing/terminal states plus Manager canvas/preparation and guest hero. | Firefox, WebKit/Safari, physical iPhone/Android, native camera-picker, real Images/Workflow behavior, Cloudflare staging/deployment, remote D1 migration, and live production validation were not proved by this local run. |

### New reviewed theme screenshots

| Tracked file | Accepted state | Pixels |
| --- | --- | ---: |
| `guest-default-cover-390-mobile-win32.png` | Default cover, localized scrim, and first-fold hierarchy | 390 × 844 |
| `guest-default-guestbook-390-mobile-win32.png` | Default Guestbook prompt, composer, maximum RTL entry, and inherited event tokens | 390 × 1682 |
| `guest-garden-cover-390-mobile-win32.png` | Garden Party cover first fold | 390 × 844 |
| `guest-midnight-review-progress-320-mobile-win32.png` | Midnight Film review and getting-ready state | 320 × 625 |
| `guest-coastal-entry-390-mobile-win32.png` | Coastal Light no-cover entry | 390 × 844 |
| `guest-coastal-receipt-390-mobile-win32.png` | Coastal Light terminal delivery receipt | 390 × 844 |
| `manager-event-appearance-390-mobile-win32.png` | Complete Settings editor/preview, including Guestbook settings, with global chrome outside scope | 390 × 4218 |
| `fullscreen-midnight-1280x900-desktop-win32.png` | Six-photo Midnight Film full-screen composition | 1280 × 900 |

The Default Guestbook image supersedes the removed
`guest-default-notes-390-mobile-win32.png` baseline. The Guestbook evidence revision also
re-captured the complete Manager Settings state because prompt and review controls now precede the
event-appearance editor. The eight 350 × 415 Manager theme-canvas baselines were re-rasterized after
that approved Settings insertion shifted the live canvas within the document; original-resolution
inspection confirmed that their theme composition and Manager/event-scope boundary remain unchanged.

Three existing Default baselines changed intentionally:

- `create-validation-focus-390-mobile-win32.png` — the approved preset selector;
- `guest-long-welcome-320-mobile-win32.png` — the corrected name-input boundary and placeholder; and
- `guest-landscape-844x390-mobile-win32.png` — the same input correction in phone landscape.

Three Default baselines remain protected from event-theme layout or behavior churn. Their approved
Chestnut/Denim palette updates are pinned here:

| Protected file | SHA-256 |
| --- | --- |
| `guest-review-320-mobile-win32.png` | `EF8C537EC2177F47F2BE55463EF9B752F4A081F2879BF015CCD4690135C55F2C` |
| `guest-secondary-long-content-320-mobile-win32.png` | `445AAB2DB8C8FF3F05BFB013DC5EB4230816A8CCD11EA87E8E3A88824C1C3E17` |
| `fullscreen-long-caption-320-mobile-win32.png` | `FF034EF996F939E4641AD0A68CE2162B4EEA5A645EDFF8A9943B5D1EF0BD4AB2` |

## Phase 3 Cover Studio and responsive-cover evidence

Reviewed locally on 2026-08-10 against the live nested/revisioned contract. The focused production-
build browser gate passed 142 cases with 76 intentional project-specific skips and zero failures.
Twenty-nine changed PNGs were opened and inspected at original resolution; no unrelated baseline was
accepted. The exact inspected set is:

| Evidence group | Tracked files |
| --- | --- |
| Six profiles × two directional sources | `short-lookup-landscape-centered-light-desktop-win32.png`; `short-lookup-portrait-edge-dark-desktop-win32.png`; `compact-default-landscape-centered-light-desktop-win32.png`; `compact-default-portrait-edge-dark-desktop-win32.png`; `standard-default-landscape-centered-light-desktop-win32.png`; `standard-default-portrait-edge-dark-desktop-win32.png`; `framed-default-landscape-centered-light-desktop-win32.png`; `framed-default-portrait-edge-dark-desktop-win32.png`; `compact-expanded-landscape-centered-light-desktop-win32.png`; `compact-expanded-portrait-edge-dark-desktop-win32.png`; `wide-expanded-landscape-centered-light-desktop-win32.png`; `wide-expanded-portrait-edge-dark-desktop-win32.png` |
| Studio geometry | `studio-sheet-760-desktop-win32.png`; `studio-dialog-761-desktop-win32.png`; `studio-keyboard-compact-desktop-win32.png`; `studio-zoom-200-desktop-win32.png`; `studio-zoom-400-desktop-win32.png` |
| Intentionally invalidated hero/canvas baselines | `guest-default-cover-390-mobile-win32.png`; `guest-garden-cover-390-mobile-win32.png`; `guest-coastal-entry-390-mobile-win32.png`; `manager-event-appearance-390-mobile-win32.png` |
| Four-theme preset/upload-effect canvases | `manager-candidary-default-preset-film-mobile-win32.png`; `manager-candidary-default-upload-natural-mobile-win32.png`; `manager-garden-party-preset-film-mobile-win32.png`; `manager-garden-party-upload-warm-mobile-win32.png`; `manager-midnight-film-preset-film-mobile-win32.png`; `manager-midnight-film-upload-soft-mobile-win32.png`; `manager-coastal-light-preset-film-mobile-win32.png`; `manager-coastal-light-upload-monochrome-mobile-win32.png` |

The directional matrix proves focal placement, clipping, advertised current-revision candidates, and
runtime layer order. The geometry set proves the inclusive 760 px sheet/exclusive 761 px dialog split,
visual-keyboard compaction, and 200%/400%-equivalent reachability. The themed canvas set uses visibly
distinct deterministic sources/effects; it does not infer effect correctness from four identical
fixtures. Dynamic axe scanned Choose, loading, actionable error, Compose, Style, Done, discard,
preparing/slow, retryable, permanent, conflict, Manager canvas/preparation, and guest hero. Keyboard,
focus return/trap, repeated Back, reduced motion, live-region settling, zero transforms while dragging,
and the five-preview cap have separate assertions.

This is Chromium automation against local stateful route fixtures and deterministic image bytes. It
does not prove real Cloudflare Images codecs/HEIC/metadata stripping, Workflow lifecycle behavior,
remote D1, a deployed route, Safari/WebKit, a native picker, a physical device, VoiceOver, or TalkBack.
Use the isolated preview for Cloudflare platform behavior and separate manual checks for physical
devices; neither is a blanket gate on unrelated routine changes.

## Curated private Guestbook evidence

Reviewed locally on 2026-08-12 against
`docs/superpowers/specs/2026-08-12-curated-private-guestbook-design.md` with contract-version-2 guest
and safe Manager route fixtures.

| Contract point | Local automated result | Evidence boundary |
| --- | --- | --- |
| Guest placement and receipt | `core-journey.spec.ts`, `guest-responsive.spec.ts`, and `accessibility.spec.ts` cover the first secondary `Guestbook`, the sole terminal `Leave a guestbook note` action, post-commit heading focus, keyboard-only send, polite confirmation, gallery-off privacy, and reduced-motion `auto` rather than smooth scrolling. | The focused four-file Chromium matrix passed 116 cases with 12 intentional project skips. It does not establish native screen-reader or physical-device behavior. |
| Responsive and text containment | Guest and Manager cases exercise 320 × 844, 390 × 844, representative desktop, 640 × 450 as a 1280-at-200%-zoom equivalent, and 320-pixel 400%-zoom-equivalent containment with the 160-character prompt, 500-character body, 80-character name, Unicode, RTL, `dir="auto"`, 44-pixel targets, focus indicators, and no horizontal document overflow. | These are CSS-viewport Chromium checks, not browser UI zoom certification or Safari/WebKit evidence. |
| Manager curation | `manager-responsive.spec.ts` covers the `Guestbook` destination, `Guestbook from the day`, pending-only badge, all visibility/source controls, gallery-off captions, keyboard-only moderation, row-local live announcements, focus restoration with `preventScroll`, and preservation of the scroll position captured immediately before the confirmed row update. | Stubbed safe Manager endpoints prove client behavior, not deployed authorization, remote D1 state, or production polling. |
| Printable and private artifacts | `accessibility.spec.ts` renders the real `buildGuestbookHtml` output with `page.setContent`, verifies semantic `article[dir="auto"]`, escaped contributed text, no script/form/remote asset, zero requests, at least 7:1 body contrast, axe-clean screen and emulated print media, white print background, and `break-inside: avoid`. The printable HTML remains shared-keepsake-only; the complete non-deleted private CSV remains a separate labelled artifact. | Local Chromium screen and print-media emulation is not an operating-system print-dialog check, common-browser manual print proof, or common-spreadsheet CSV opening. Physical iPhone/Android, VoiceOver/TalkBack, degraded-network rehearsal, remote migration, and deployment are separate checks when the affected surface requires them. |

The final zero-tolerance snapshot matrix was inspected at original resolution. New evidence is
`guest-default-guestbook-390-mobile-win32.png` (390 × 1682) and
`manager-guestbook-390-mobile-win32.png` (390 × 1079). Intentional updates are
`guest-coastal-receipt-390-mobile-win32.png` (390 × 844),
`guest-secondary-long-content-320-mobile-win32.png` (320 × 1655),
`manager-event-appearance-390-mobile-win32.png` (390 × 4218),
`manager-nav-768-mobile-win32.png` (104 × 1244),
`manager-nav-count-390-mobile-win32.png` (390 × 112), and the eight theme canvases
`manager-candidary-default-preset-film-mobile-win32.png`,
`manager-candidary-default-upload-natural-mobile-win32.png`,
`manager-garden-party-preset-film-mobile-win32.png`,
`manager-garden-party-upload-warm-mobile-win32.png`,
`manager-midnight-film-preset-film-mobile-win32.png`,
`manager-midnight-film-upload-soft-mobile-win32.png`,
`manager-coastal-light-preset-film-mobile-win32.png`, and
`manager-coastal-light-upload-monochrome-mobile-win32.png` (each 350 × 415). The prior
`guest-default-notes-390-mobile-win32.png` (390 × 1050) was removed as superseded evidence. The 15
current named snapshot cases passed without update mode after inspection; no unrelated baseline was
accepted.

## RSVP and durable-entry evidence

Reviewed on 2026-07-31 against
`docs/superpowers/specs/2026-07-30-event-rsvp-and-photo-entry-design.md`.

| Contract point | Accepted direction | Browser result | Disposition |
| --- | --- | --- | --- |
| One permanent printed entry | The same URL opens RSVP before the event and photos on the day | `rsvp-journey.spec.ts` navigates the real `/join#…` shell in both phases and asserts the credential reaches only the same-origin POST body; `security.spec.ts` asserts it never appears in the address bar, a request line, the rendered page, or the console | The join shell reads the fragment once, erases it before any network call, and replaces the URL on success. A missing or refused credential lands on one token-free recovery page. Real cookie and header behaviour is proved in `tests/worker/event-entry-api.test.ts`, which a route stub could not do. |
| Exact-name lookup without browsing | A full name typed exactly, never a suggested or visible list | `rsvp-lookup-390.png`, `accessibility.spec.ts` lookup case, `rsvp-journey.spec.ts` ambiguity and miss cases | The first viewport at 320 × 568 holds identity, date, deadline, the field, the privacy sentence, and the complete action. No listbox or roster suggestion exists, an ambiguous name asks for a second one without naming anybody, and a miss reads exactly like a paused event. |
| Individual household answers | Every named guest and plus-one slot answers for itself | `rsvp-household-320.png`, `rsvp-receipt-390.png`, `accessibility.spec.ts`, `rsvp-responsive.spec.ts` | Each person is a `fieldset` with two labelled native radios and a 44 px target; an attending plus-one gains a name field; the selected state carries a thicker border as well as colour. The 20-named-plus-10-slot maximum household reflows at 320 and 390 with no sideways page. |
| Revision, closure, and conflict | Revisable until the deadline; read-only afterwards; never a silent overwrite | `rsvp-before-start-390.png`, `rsvp-journey.spec.ts` revision, stale-conflict, and closed cases | A reload restores the saved response, `Change RSVP` reopens it, a refused write replaces the draft with the winning roster and focuses its review heading, and the before-start read-only event shows the saved answer with no write action. |
| Host guest list | Server-derived totals, filters, import, editing, archive, export | `manager-rsvp-390.png`, `manager-rsvp-panel.test.tsx`, `rsvp-responsive.spec.ts` | All eight totals come from the server and are never recomputed from one page. CSV preview reports row, field, and message without echoing the file, commit is a separate explicit decision, and archive requires the exact household name. The issue list is the only region with its own scrollbar. |
| Six manager destinations | RSVP inserted after Intake at every width | `manager-nav-768.png`, `manager-nav-count-390.png`, `manager-responsive.spec.ts`, `rsvp-responsive.spec.ts` | Every label stays visible at the 14 px control-text floor from 320 px upward, the count badges do not collide with them, and the vertical rail stays packed at the top. |
| Durable-QR host controls | Signing devices out and disabling the QR are different decisions | `manager-export-first-390.png`, `app.test.tsx` entry-control cases | Share carries the event link, the QR, and both actions with their own copy; each requires the exact event name. Signing devices out leaves the QR input byte-identical; disabling removes the link, the QR, and both actions with no replacement offered. |
| Themed across every preset | RSVP is a themed guest surface like the photo drop | `event-theming.spec.ts` runs lookup → household → refusal → receipt for all four presets | Every preset clears 4.5:1 on identity, deadline, field labels, privacy copy, legends, counts, attendance labels, refusal copy, and receipt rows, and keeps 44 px attendance targets. |
| Photo journey unchanged | RSVP never becomes a prerequisite for sending photos | `rsvp-journey.spec.ts` event-day case, `core-journey.spec.ts`, unchanged upload baselines | On the day the camera and library controls precede any RSVP surface, the collapsed disclosure issues no request until it is opened, and the terminal receipt still hides every secondary section including RSVP. |

### New reviewed RSVP screenshots

| Tracked file | Accepted state | Pixels |
| --- | --- | ---: |
| `rsvp-lookup-390-mobile-win32.png` | Guest lookup first viewport | 390 × 844 |
| `rsvp-household-320-mobile-win32.png` | Household card at 320 with a named attend, a decline, and an attending plus-one | 292 × 1062 |
| `rsvp-receipt-390-mobile-win32.png` | Saved household receipt with `Change RSVP` | 350 × 497 |
| `rsvp-before-start-390-mobile-win32.png` | Before-start surface showing the saved response with no write action | 390 × 844 |
| `manager-rsvp-390-mobile-win32.png` | Manager guest list: totals, filters, list, editor entry, and import | 350 × 1146 |

The three element captures are narrower than their viewports because each is the card or panel
itself rather than the page, which is what makes them stable evidence of composition.

Three existing baselines changed intentionally and were inspected before acceptance:

- `manager-nav-768-mobile-win32.png` and `manager-nav-count-390-mobile-win32.png` — the sixth
  destination; and
- `manager-export-first-390-mobile-win32.png` — Share replacing manager-link rotation with the two
  entry controls.

`manager-event-appearance-390-mobile-win32.png` also changed, for the six-destination rail, the event
time-zone/RSVP-deadline/`Accept RSVPs` settings controls, and the `Manager access` section that now
holds manager-link rotation.

### Production release, 2026-07-31

| | |
| --- | --- |
| Deployed SHA | `07432ea` (`feat: keep printed pre-0008 QR codes working`) |
| Worker version | `5860f15f-ed73-4d91-906c-9b1e7c3d0761` |
| Account / database | Henry Flare `a77e479f…` / `candidary-core` `60bec5de-c8c7-41b5-a26b-2d3f7d184c71` |
| Migration | `0008_event_rsvp.sql`; ledger clean, `PRAGMA foreign_key_check` empty, 13 objects created |
| Events at deploy | 8 active, all with photo intake open, none with RSVP enabled |

`wrangler d1 migrations apply --remote` refused the migration with `incomplete input` and applied
nothing; it was applied through `d1 execute --remote --file` after the identical file was proved
against a throwaway remote database built from 0001–0007. The symptom and the recovery sequence are
in `docs/deployment.md`.

### Physical-device evidence

Two gates have passed. Each is recorded at exactly the strength it was observed, and no more.

| Gate | Result |
| --- | --- |
| A printed pre-0008 QR opens its event against the deployed Worker | **Passed** — confirmed by the operator on 2026-07-31 by scanning a real printed code on a physical phone. Device model, OS version, and browser were **not recorded**; `docs/deployment.md` requires them, so this entry is incomplete until they are supplied. |
| A printed QR opens its event during **RSVP-primary** on a physical device | **Passed** — confirmed by the operator. Date, device model, OS version, browser, and network condition were **not recorded**; `docs/deployment.md` and §14 of `docs/superpowers/specs/2026-08-02-support-free-event-reliability-design.md` both require them, so this entry is incomplete until they are supplied. |

Corroborating server-side evidence for the pre-0008 gate, which does not depend on the report: the
live `tracy-and-bill-s-wedding-celebration-tn9o3c` event holds an entry credential whose id equals its
guest access token id — an adoption of the printed token rather than a freshly minted credential, so
the code already in circulation is the one that now works.

The RSVP-primary gate has no equivalent server-side corroboration recorded here yet. It carries one
consequence beyond itself: a production event has had RSVP enabled, so the phase exists outside the
test suite. This section asserted the opposite from 2026-07-31 (`77e02b3`) until 2026-08-20, because
the original bullet's reasoning was never revisited as production state moved. A gate listed as
unproven for a reason that has expired is the failure mode this document exists to prevent, so the
reason is recorded here rather than quietly deleted.

### Not yet evidenced

Everything else in the physical and assistive-technology gate list remains unproven and may not be
recorded as passed on the strength of the automated suite or of the gates above:

- the printed QR scanned **after a *Sign out guest devices* rotation**, which is the specific claim
  that separates this design from a fragile one;
- **VoiceOver** and **TalkBack** over the RSVP lookup, household form, and manager guest list;
- **degraded-network** retry of an RSVP submission; and
- the **emergency-disable rehearsal** on a disposable event.

## Date-driven guest phase

Specified on 2026-08-01 in
`docs/superpowers/specs/2026-08-01-date-driven-guest-phase-design.md`, which moves the guest between
RSVP, before-start, photo delivery, and paused waiting from the event's own schedule rather than a
host flipping a checkbox on the morning of the event.

The converged local browser run measured the automated states named below. Partial rows retain the
exact unmeasured claim. None of these results proves a physical device, native assistive technology,
production runtime, or manual rehearsal; those gates remain explicitly outstanding.

| Contract point | Accepted direction | Browser result | Disposition |
| --- | --- | --- | --- |
| A designed pre-event surface | The post-deadline, pre-event window gets a page of its own instead of a fallback that talks about a deadline the guest can no longer act on | `guest-lifecycle.spec.ts` passed one `<h1>`, nested `<h2>`, Axe, and containment at 320 × 844 and 390 × 844; `rsvp-responsive.spec.ts` contained the maximum-name receipt at both widths; `visual-qa.spec.ts` passed `rsvp-before-start-390.png` at 390 × 844 | **Automated evidence recorded. Outstanding:** the 320 × 568 first-fold composition and all physical/manual checks. |
| Recognizing a saved response | A household that answered is thanked, including on a device that never held an RSVP session; one that never answered is neither thanked nor scolded and reads exactly like a miss | `rsvp-journey.spec.ts` passed the session-free saved-response lookup at the mobile project's 390 × 844 viewport; `guest-lifecycle.spec.ts` exercised unavailable access at 320 × 844 and 390 × 844 | **Partially evidenced. Outstanding:** exact unresponded/miss copy parity, an explicit no-household-request assertion, and physical/manual checks. |
| Waiting means one thing | Once the event has started and photo capability is withheld, `Photo delivery is paused` is the whole primary | `guest-lifecycle.spec.ts` passed the paused heading/copy, absence of RSVP lookup/receipt, Axe, and containment at 320 × 844 and 390 × 844 | **Automated evidence recorded.** Physical/manual checks remain outstanding. |
| The page changes itself | The phase moves with the schedule and with no user action, driven by a server-computed relative delay so a wrong browser clock cannot switch early or late | `guest-lifecycle.spec.ts` passed untouched crossing, quiet refresh failure, `pageshow`, long-delay slicing, and clocks four days behind/six days ahead at 320 × 844 and 390 × 844 | **Automated evidence recorded.** Physical/manual checks remain outstanding. |
| Manager photo intake | One server-derived state and the one action legal from it, never a browser clock comparison; a pre-start pause never withdraws capability | The selected browser suites did not exercise the manager status/action refetch across the event start | **Outstanding:** browser and physical/manual evidence. Unit/UI coverage is not promoted here. |

The responded before-start surface has the inspected 390 × 844 baseline named above. No waiting,
automatic-transition, or manager photo-intake screenshot is claimed.

## Intentional adaptations

- The approved three-state concept used a schematic 260 px phone. The implementation expands naturally to the real 390 px mobile viewport and uses a compact centered panel on desktop without adding workflow steps.
- `Retake a photo` remains available during review because camera capture is a core entry scenario. It modifies the current selection; it is not a post-delivery action.
- The earlier image-led guest concept remains a visual-language reference, but its large cover, contribution strip, gallery, and notes no longer occupy the primary viewport. This is the approved product-priority change, not a fidelity mismatch.

## QA outcome

No material mismatch remains between the approved wedding photo-drop journey and the reviewed browser evidence. The original serious `color-contrast` finding on the guest and landing surfaces was resolved without changing a global design-system token. The later Chestnut/Denim migration changed the documented global palette while preserving those contrast relationships; the scoped event overlay adds only the documented compatibility corrections and curated event appearances. `design-qa.md` records what moved, the resulting ratios, and the fact that global muted ink on parchment clears the threshold by only 0.0046.

Physical iPhone and Android checks remain separate manual acceptance checks because desktop browser
emulation cannot prove native camera-picker behavior. They are required when accepting changes to
that surface, not as a blanket blocker for unrelated deployments.

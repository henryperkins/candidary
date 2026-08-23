# Candidary Design QA

## Visual truth

- Supplied host failure states: `1-Photo-1.jpg` and `2-Photo-2.jpg`.
- Approved responsive behavior: `docs/superpowers/specs/2026-07-22-mobile-first-host-views-design.md`.
- The supplied screenshots document the broken state, so the corrected labeled navigation and contained controls are intentional differences rather than pixel-matching defects.

## How this evidence is produced

```powershell
npm run typecheck        # tsc -b; covers src, worker, tests/unit, tests/ui — NOT tests/e2e
npx tsc -p tsconfig.e2e.json --pretty false
npm run lint             # eslint . --max-warnings=0; covers tests/e2e syntactically, not its types
npm test                 # unit/UI in jsdom, then Worker tests in workerd
npm run build            # tsc -b then vite build
npm run test:e2e         # Playwright: geometry, boundary, axe, and tracked-baseline evidence
```

`tests/e2e` belongs to neither TypeScript project, so `npm run typecheck` does not type-check the
Playwright specs. `tsconfig.e2e.json` is the committed, authoritative project for
`tests/e2e/**/*.ts`, `shared/**/*.ts`, and `playwright.config.ts`; run the exact command above
whenever browser code changes. Lint alone will not catch a Playwright type error.

Two Playwright projects remain, both Chromium/Desktop Chrome: `desktop` (1440 x 1000) and `mobile`
(390 x 844, `isMobile`, `hasTouch`). Boundary coverage does not multiply the suite across projects
— each responsive spec pins its own viewport with `page.setViewportSize()`. There is no Firefox,
WebKit/Safari, physical-device, or native camera-picker evidence.

### Event-theme targeted verification

The narrow feature gate is:

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-theme.test.ts tests/unit/event-theme-style.test.ts tests/unit/settings-autosave-queue.test.ts tests/unit/event-settings-draft.test.ts tests/unit/manager-event-merge.test.ts tests/unit/autosave-status-text.test.ts tests/ui/event-theme-creation.test.tsx tests/ui/event-appearance-editor.test.tsx tests/ui/event-settings-editor.test.tsx tests/ui/manager-settings-autosave.test.tsx tests/ui/event-theme-rendering.test.tsx tests/ui/guest-upload-flow.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0007.test.ts tests/worker/event-theme-api.test.ts tests/worker/manage-api.test.ts tests/worker/core-journey.test.ts
npx tsc -p tsconfig.e2e.json --pretty false
npx playwright test tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/visual-qa.spec.ts
```

The targeted Playwright command does not include `security.spec.ts`. Production-like CSP evidence
is part of the later full `npm run test:e2e` gate. A final source head must also run, on that same
immutable revision:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
git diff --check
```

### Cover storage targeted verification

The narrow feature gate for the phase-1 cover pipeline is:

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-cover.test.ts tests/unit/cover-presets.test.ts tests/unit/cover-contrast.test.ts tests/unit/cover-saliency.test.ts tests/unit/cover-backfill-launcher.test.ts tests/unit/verify-fresh-d1.test.ts tests/ui/cover-studio.test.tsx tests/ui/manager-cover-preparation.test.tsx tests/ui/responsive-event-cover.test.tsx tests/ui/event-appearance-editor.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0012.test.ts tests/worker/event-cover-storage.test.ts tests/worker/event-cover-images.test.ts tests/worker/event-cover-publication.test.ts tests/worker/event-cover-api.test.ts tests/worker/event-cover-delivery.test.ts tests/worker/cover-render-workflow.test.ts tests/worker/cover-backfill-workflow.test.ts tests/worker/cleanup.test.ts
npm run verify:cover-presets
npm run verify:bindings
```

The asset matrix is regenerated with `npm run build:cover-presets`, which needs headless Chromium.
A rebuild from unchanged sources reproduces all 720 files byte for byte; if it does not, the seeds
or the browser version moved and the manifest checksums will say so.

### Cover verification boundary

Focused unit and Worker tests protect cover normalization, publication, cleanup, backfill, and
deletion behavior. The ordinary pull-request path runs those suites in parallel with the rest of the
repository. Changes that affect the browser flow can additionally run the relevant Playwright files;
the nightly/manual workflow keeps the complete browser matrix out of routine deployment.

Cloudflare-specific Images, Workflow, codec, and remote-D1 behavior must be checked in the isolated
preview environment when those surfaces change. Preview resources never share production D1, R2,
Workflow, rate-limit, email, or secret bindings. Candidate manifests, staging evidence bundles, and
historical cover rehearsals are not release requirements.

Local Chromium fixtures and deterministic image bytes still do not prove Safari, native pickers,
physical devices, VoiceOver, or TalkBack. Those remain separate manual acceptance checks and do not
block an unrelated routine deployment.

## Tracked visual baselines

The two landing baselines were recaptured on Windows and inspected side by side at their natural
dimensions on 2026-08-02. `landing-first-fold-320-mobile-win32.png` is 320 x 568 with SHA-256
`ACF41E57B9AF8635105B5E864A1DB87D36420C51D5BF44872CDEEB874D2C702A`;
`landing-workflow-780-mobile-win32.png` is a 780 x 608 element capture from the 780 x 900 viewport
with SHA-256 `A9592B6C1DFF656B887618ECB7803C62C8C458D899D1C6475AA8AE772AB22A42`.
The complete mobile visual suite then passed without update mode. The `win32` platform suffix still
means a Linux run reports these baselines missing rather than comparing different font rasterization.

`tests/e2e/visual-qa.spec.ts` and `tests/e2e/event-theming-visual.spec.ts` assert committed images
under their matching `*-snapshots/` directories, compared exactly — `threshold: 0` **and**
`maxDiffPixels: 0` — with animations disabled, the caret hidden, and `scale: 'css'`. `output/`
remains disposable and is cited nowhere.

Both tolerances are required. `maxDiffPixels: 0` alone only counts pixels that already exceeded the
per-pixel `threshold`, which defaults to 0.2 in a YIQ colour space. That default absorbs a
whole-surface recolour of a few units per channel: the guest ground moving from `#f4ede4` to
`#f7f1e7` changed 393,839 pixels of one baseline and the comparison reported it as a pass. A palette
regression is exactly what a tracked baseline exists to catch, so the comparison is exact.

Exactness only pays if the capture is deterministic, so both suites call the shared
`settleRendering()` helper before every screenshot:

- **Parks the pointer outside the viewport.** A test that clicks its way into a state leaves the
  mouse on the control it clicked, and that control keeps its `:hover` paint. The `/create` submit
  button differs from its resting state by 13,077 px of chestnut-strong fill, and whether that paint
  landed before the capture varied from run to run.
- **Waits until the font set is quiet across two frames**, not merely for one `document.fonts.ready`.
  A face is only requested when a glyph needs it, so laying out with the faces loaded so far can
  request another and begin a cycle that `ready` already resolved past. A late arrival moves centred
  text even when it moves nothing else, because the label re-centres on a different sub-pixel origin.

Both were latent while the comparison was lossy. Neither affects what the page renders.

Regenerate and then prove reproducibility:

```powershell
npx playwright test tests/e2e/event-theming-visual.spec.ts --project=mobile --update-snapshots
npx playwright test tests/e2e/event-theming-visual.spec.ts --project=desktop --update-snapshots
npx playwright test tests/e2e/visual-qa.spec.ts --project=mobile --grep "create form" --update-snapshots
npx playwright test tests/e2e/visual-qa.spec.ts --project=mobile --grep "guest photo drop" --update-snapshots
npx playwright test tests/e2e/visual-qa.spec.ts tests/e2e/event-theming-visual.spec.ts --project=mobile
npx playwright test tests/e2e/event-theming-visual.spec.ts --project=desktop
git diff --exit-code -- tests/e2e/visual-qa.spec.ts-snapshots/guest-review-320-mobile-win32.png tests/e2e/visual-qa.spec.ts-snapshots/guest-secondary-long-content-320-mobile-win32.png tests/e2e/visual-qa.spec.ts-snapshots/fullscreen-long-caption-320-mobile-win32.png
```

| Baseline | Route and state | Viewport |
| --- | --- | ---: |
| `landing-first-fold-320.png` | `/` first fold: eyebrow, headline, supporting sentence, both actions | 320 x 568 |
| `landing-workflow-780.png` | `/` `.workflow` band, two columns | 780 x 900 |
| `create-validation-focus-390.png` | `/create` `.create-form` after a 422 with three field errors, focus on the first invalid field | 390 x 844 |
| `guest-long-welcome-320.png` | `/event/:slug` with a 500-character welcome, clamped with its disclosure | 320 x 568 |
| `guest-landscape-844x390.png` | `/event/:slug` in phone landscape | 844 x 390 |
| `guest-review-320.png` | `/event/:slug` review state: one accepted photo, one rejected file | 320 x 844 |
| `guest-secondary-long-content-320.png` | `/event/:slug` `.guest-secondary` with deliveries and gallery open on 80-character filenames | 320 x 844 |
| `fullscreen-long-caption-320.png` | `/event/:slug/fullscreen` first figure with an 80-character caption | 320 x 844 |
| `manager-guestbook-390.png` | `/manage/event/:id` Guestbook `.manager-main`: chrome, filters, a pending row, and its actions | 390 wide |
| `manager-nav-768.png` | `/manage/event/:id` compact 104 px rail | 768 x 900 |
| `manager-nav-count-390.png` | `/manage/event/:id` stacked rail with the count at the 10,000-photo cap | 390 x 844 |
| `manager-private-mosaic-320.png` | `/manage/event/:id` private Gallery mosaic | 320 x 844 |
| `manager-gallery-viewer-320.png` | `/manage/event/:id` immersive private Gallery viewer | 320 x 844 |
| `manager-shared-gallery-320.png` | `/manage/event/:id` Shared gallery filters and labeled publish/hide cards | 320 x 844 |
| `gallery-export-390.png` | `/manage/event/:id` private Gallery Download all control | 390 wide |
| `manager-rsvp-390.png` | `/manage/event/:id?section=rsvp` guest list: totals, filters, list, editor entry, import | 390 wide |
| `rsvp-lookup-390.png` | `/event/:slug` RSVP lookup first viewport | 390 x 844 |
| `rsvp-household-320.png` | `/event/:slug` household card: a named attend, a decline, an attending plus-one | 320 wide |
| `rsvp-receipt-390.png` | `/event/:slug` saved household receipt with `Change RSVP` | 390 wide |
| `rsvp-before-start-390.png` | `/event/:slug` before-start surface showing the saved response and no write action | 390 x 844 |

Two files in that directory are no longer baselines. `manager-export-first-390-mobile-win32.png`
pictured the Share-section export panel that existed before export moved into Gallery, and
`manager-actions-320-mobile-win32.png` pictured the Gallery card while it still carried Live Intake's
download and delete controls. No test captures either name any more, so `--update-snapshots` will
never rewrite them and no run can fail on them. They are kept as the last pictures of the surfaces
they replaced; delete either whenever that stops being worth a file. Their live successors are
`gallery-export-390.png` and `manager-shared-gallery-320.png`.

The event-theme suite adds exactly eight tracked images:

| Actual baseline | Route and state | Pixels |
| --- | --- | ---: |
| `guest-default-cover-390-mobile-win32.png` | Default cover, localized scrim, first fold | 390 x 844 |
| `guest-default-notes-390-mobile-win32.png` | Default Notes surface/divider crop | 390 x 1050 |
| `guest-garden-cover-390-mobile-win32.png` | Garden Party cover first fold | 390 x 844 |
| `guest-midnight-review-progress-320-mobile-win32.png` | Midnight Film review/getting-ready crop | 320 x 625 |
| `guest-coastal-entry-390-mobile-win32.png` | Coastal Light no-cover entry | 390 x 844 |
| `guest-coastal-receipt-390-mobile-win32.png` | Coastal Light terminal receipt | 390 x 844 |
| `manager-event-appearance-390-mobile-win32.png` | Complete Settings editor/preview and global chrome | 390 x 4212 |
| `fullscreen-midnight-1280x900-desktop-win32.png` | Six-photo Midnight Film full-screen composition | 1280 x 900 |

At the event-theming feature head, three existing Default files were deliberately updated:
`create-validation-focus-390-mobile-win32.png` for the approved selector, plus
`guest-long-welcome-320-mobile-win32.png` and
`guest-landscape-844x390-mobile-win32.png` for the corrected empty input boundary/placeholder.
`guest-default-notes-390-mobile-win32.png` is a new approved image, not a fourth existing update.
The final event-theming Task 8 evidence revision changed no PNG. A later independent-review
correction replaced the Manager color input's undefined border variable with
the global `--border` token and, at that feature head, regenerated only
`manager-event-appearance-390-mobile-win32.png`. The later Chestnut/Denim integration regenerated
the combined Default and global-chrome baselines listed here against the integrated token registry.

The following files are protected from event-theme layout or behavior churn. Their Chestnut/Denim
palette updates are intentional and pinned by hash:

| Protected baseline | SHA-256 |
| --- | --- |
| `guest-review-320-mobile-win32.png` | `EF8C537EC2177F47F2BE55463EF9B752F4A081F2879BF015CCD4690135C55F2C` |
| `guest-secondary-long-content-320-mobile-win32.png` | `445AAB2DB8C8FF3F05BFB013DC5EB4230816A8CCD11EA87E8E3A88824C1C3E17` |
| `fullscreen-long-caption-320-mobile-win32.png` | `FF034EF996F939E4641AD0A68CE2162B4EEA5A645EDFF8A9943B5D1EF0BD4AB2` |

The original mobile/tablet table's logical names carry Playwright's default
suffixes and are stored as `<name>-mobile-win32.png`; the desktop theme baseline
carries `-desktop-win32.png`. That is deliberate and must not be normalised away:

- **`-win32`** — these images were rasterised by Windows. A Linux CI run must report a *missing*
  baseline rather than silently diff Linux font rendering against Windows font rendering.
- **`-mobile`** — `visual-qa.spec.ts` is excluded from the `desktop` project (`testIgnore` in
  `playwright.config.ts`). Every state above is 844 px wide or narrower and belongs to a touch
  device; a second desktop-emulated copy would picture a viewport with a 15 px scrollbar that no
  phone has.
- `gallery-export-390.png` is captured at 390 px wide with a tall capture window so the whole control
  lays out at once. The sticky rail would otherwise be drawn over any part of it that had to be
  scrolled into view. Width is what the layout is made of; the height is only the window.
- Dates rendered through `Intl` (`/create` date placeholder, the guest hero date) follow the
  capturing machine's locale and time zone. That is a further reason the platform suffix stays.

## Event-theme browser matrix

The viewport-pinned behavior runs once in the desktop project and uses this exact preset rotation:

| State | 320 x 568 | 390 x 844 | 1280 x 900 |
| --- | --- | --- | --- |
| No-cover name/source entry | Candidary Default | Coastal Light | Garden Party |
| Cover name/source entry | Midnight Film | Candidary Default | Coastal Light |
| 500-character welcome, collapsed/expanded | Coastal Light | Candidary Default | Garden Party |
| Review with long filenames | Candidary Default | Coastal Light | Midnight Film |
| Active progress then retry/failure | Coastal Light | Candidary Default | Garden Party |
| Terminal receipt | Candidary Default | Coastal Light | Midnight Film |
| Gallery, deliveries, and Notes expanded | Coastal Light | Candidary Default | Garden Party |
| Full-screen long caption | Candidary Default | Coastal Light | Midnight Film |

Supplementary browser evidence covers:

- Garden Party remembered-name, validation focus, keyboard operation, and 44px targets at
  390 x 844.
- Coastal Light reserving, queued, uploading, finalizing, cancel, failure, retry, and receipt at
  390 x 844.
- Manager canonical PUT and normalized-response adoption at 390 x 1200.
- Each preset's no-cover all-visible-pixel contrast at natural 390 x 205, semantic expanded
  390 x 420, and production 620 x 265 geometry. The mask includes right/bottom straight-edge cells
  and excludes clipped rounded-corner cells.
- Each preset's cover-copy contrast over pure white, pure black, and photographic fixtures at
  390 x 844.
- Axe plus computed 4.5:1 text/action and 3:1 input-boundary/focus checks for all four presets and
  custom black, white, and `#767676` configurations at 390 x 844.
- Theme radio accessible names/native checked state and the full Manager Settings Axe scan at
  390 x 1400.
- The 640 x 450 200%-zoom proxy, reduced motion, long content, and document containment.

### Manager preview and persistence isolation

The Settings editor keeps its confirmed theme and draft theme separate. Valid preset choices,
preset-color restoration, and Reset autosave immediately; valid color edits autosave after 600 ms of
inactivity, on blur, or when Enter flushes them. The inert `.event-appearance-preview` still updates
from the newest valid local draft, while guests keep the last Worker-confirmed theme. Manager
navigation, workspace, forms, account access, and danger area remain on global Candidary tokens.
The autosave status vocabulary is `Saved`, `Saving…`, `Fix the highlighted field to save.`, and
`Couldn’t save.`; retryable failures also offer `Retry`. A failed autosave preserves raw input, the
last-valid draft and preview, Settings scroll position, and the newest draft — not the snapshot that
failed — is what Retry sends.

Migration and Worker evidence pins the non-null `0007_event_theme.sql` column, canonical Default
backfill, 512-character/valid-object checks, explicit guest-versus-manager views, credential-specific
Origin/CSRF behavior, update/reset, one-event isolation, zero-row/D1 refusal, authorized private
cover reads, and view-boundary fallback. Only configuration is stored; all 45 tokens are derived.

### Production-like CSP

Playwright's `webServer` runs `npm run build` and then Vite preview, never the development server.
`security.spec.ts` holds a real emitted font request open, waits through the shared font-settlement
helper, requires a non-empty set of same-origin `/assets/*.woff` or `/assets/*.woff2` requests,
verifies the shipped CSP and blob-backed private cover, and requires exactly zero browser console
errors after fonts settle. This evidence is Chromium-only and local; it is not a live production
CSP check.

### Evidence and release boundary

The automated evidence recorded here is local source, unit, and browser evidence.
It explicitly does not include Firefox, WebKit/Safari, physical iPhone or Android
devices, native file-picker behavior, a Cloudflare deployment, a remote D1
migration, or live production route, CSP, or data verification. A later
user-authorized source merge and push would establish source integration and
publication only, not deployment; the actual integration and pushed SHAs belong
in the final handoff and are not preclaimed here.

## Verified states

### Public — `tests/e2e/public-responsive.spec.ts`, `tests/e2e/accessibility.spec.ts`

| Surface | Widths / viewports | Result |
| --- | --- | --- |
| `/` first fold | 320 x 568, 360 x 640, 390 x 844 | Headline and `Create your event` both above the fold; document contained |
| `/` composition | 320, 360, 390, 430 | Copy precedes the decorative hero; one hero column and one workflow column |
| `/` workflow band | 761, 780, 860 | Two columns; every step's text column at or above 160 px |
| `/` breakpoints | 699 / 700, 899 / 900 | Workflow 1 to 2 at 700, hero 1 to 2 and workflow 2 to 3 at 900 |
| `/` and `/create` at 200% zoom | 640 x 450 | One-column hero and workflow; headline in the fold; a full 44 px primary target reachable |
| `/create` field errors | 320, 360, 390, 430, 768 | Errors rendered outside the field name, `aria-describedby` resolves, 12–14 px, first invalid field focused |
| `/create` private link | 320, 360, 390, 430, 768 | 44 px reveal target; the revealed 136-character link wraps and is focusable |
| Header exits | 320, 768 | Exactly three exits on `/` at 320 and four at 768, two on `/create`, each 44 x 44, at least 8 px apart |
| Cover photo control | 390 x 844 | Focus ring drawn on the visible control, never on the hidden input |

### Guest — `tests/e2e/guest-responsive.spec.ts`, `tests/e2e/accessibility.spec.ts`

| Surface | Widths / viewports | Result |
| --- | --- | --- |
| Photo drop, 500-character welcome | 320 x 568 | Welcome clamped with `Read full welcome`; both photo sources inside the fold; full text present for assistive technology |
| Photo drop, phone landscape | 844 x 390 | A full 44 px camera target reachable without scrolling, with and without the long welcome |
| Photo drop, shallow landscape boundary | 844 x 500, 844 x 520, 844 x 567 | The 500-character welcome stays clamped; a full 44 px target from both photo sources remains reachable; document contained |
| Photo drop at 200% zoom | 640 x 450 | Both sources reachable; the welcome still clamps rather than pushing them off screen |
| Review state | 320 x 844 | Status, filename and error text held to 12–14 px; the all-invalid state offers no send |
| Delivery receipt with caveat | 320 x 844 | Delivered count and caveat contained |
| Secondary sections | 320 x 844 | 80-character filenames wrap inside their column in both the gallery caption and the deliveries list |
| `View full screen` | 320, 761, 1101 | Link remains at least 44 x 44 and the document stays contained |
| Media grids | 761, 768 | Gallery grid at 12 tracks, full-screen grid at 3 |
| Full-screen gallery | 320 x 844 | Long caption contained; 44 x 44 close target |
| Guest footer | 320 x 844 | Brand wraps at least 12 px clear of the tagline |
| Photo sources and name error | 390 x 844 | 44 x 44 targets; an empty name focuses the field and announces through `role="alert"` |
| Reduced motion | any | App, selection-card and send spinners all resolve `animation-name: none` |

### RSVP and durable entry — `tests/e2e/rsvp-journey.spec.ts`, `tests/e2e/rsvp-responsive.spec.ts`, `tests/e2e/accessibility.spec.ts`, `tests/e2e/security.spec.ts`

| Surface | Widths / viewports | Result |
| --- | --- | --- |
| Printed entry, both phases | 390 x 844 | The real `/join#…` shell erases the fragment before any request, exchanges it in a same-origin POST body, and replaces the URL with `/event/:slug`. The same URL opens RSVP before the event and the photo drop on the day |
| Printed entry, refused or missing | 390 x 844 | One token-free `/recover/event-entry` page; the credential appears in no URL, no request line, no rendered page, and no console message |
| Lookup first viewport | 320 x 568 | Event identity, date, deadline, `Full name`, the privacy sentence, and the complete `Find my invitation` action all above the fold at 44 x 44; no listbox and no roster suggestion |
| Lookup, ambiguous | 390 x 844 | Focus moves to `Another full name`; nothing on the page names, counts, or hints at a candidate |
| Lookup, no match | 390 x 844 | The same generic sentence a paused event returns |
| Maximum household | 320, 390 | 20 named guests plus 10 plus-one slots; every attendance label 44 x 44; 80-character names wrap inside their legend; no page-level horizontal scroll |
| Household at 200% zoom | 640 x 512 | Attendance targets stay 44 x 44 and the flow stays contained |
| Incomplete household | 320 x 844 | The first invalid row takes focus, its error is its `aria-describedby`, and an attending plus-one's 80-character name stays contained |
| Version conflict | 390 x 844 | The winning roster replaces the draft and the `Review updated household` heading receives focus |
| Receipt and closed state | 320, 390 | Saved response contained with maximum-length names; the closed state offers no write action |
| All four presets, full lifecycle | 390 x 844 | Lookup, household, refusal copy, and receipt each clear 4.5:1 from resolved colours; selection carries a thicker border, not colour alone |
| Manager guest list | 320, 390, 768 | Six destinations at 44 x 44; totals, filters, CSV download, household rows, and the editor all contained; the CSV issue region is the only one with its own scrollbar and never scrolls sideways |
| SPA security headers | any | `/event/:slug`, `/manage/event/:id`, `/recover/event-entry`, and `/join` each carry the shipped CSP, `Referrer-Policy: no-referrer`, and `nosniff`. Entry-exchange and RSVP API headers are Worker behaviour and are asserted in `tests/worker`, never from a route stub |

### Manager — `tests/e2e/manager-responsive.spec.ts`, `tests/e2e/manager-scale.spec.ts`, `tests/e2e/visual-qa.spec.ts`

| Surface | Widths | Result |
| --- | --- | --- |
| Shell and media grid turnover | 320, 360, 390, 430 / 431, 470, 760 / 761, 768, 780, 860, 1024, 1100 / 1101, 1120, 1133, 1134, 1440 | 1, 2, 2 and 3 media columns; no shell tracks below 761, a 104 px rail through 1100, and 184 px + 330 px rails from 1101 |
| Destination labels | 320, 390, 761, 768, 780, 860, 1024, 1100, 1101, 1440 | Six labels rendered, each at or above 14 px, each target 44 x 44 |
| Label contrast | 320, 390, 761, 1024, 1440 | Every destination label at or above 4.5:1, measured from resolved colours |
| Rail packing | 761 through 1440 | Brand at or under 60 px; the six destinations occupy at most 380 px rather than stretching |
| Manager Brand target | 320, 761, 1101 | Clickable Brand remains at least 44 x 44 when each navigation layout begins |
| Lifecycle facts at capacity | 761 through 1440 | Each of the three facts stays on one line at 10,000 photos and 100 GiB |
| Intake count badge at the cap | 320, 360, 390, 430, 431, 470, 760, 761, 768, 780, 860, 1024, 1100, 1101, 1120, 1133, 1134, 1440 | `10000` contained by the badge's own box at every width, badge at most 48 px wide; count text is at least 12 px at the three layout starts |
| All six sections at 200% zoom | 640 x 450 | Every destination reachable at 44 x 44; no rails; two media columns; no escapes |
| All six sections | 390 x 844 | No element of the shell leaves the viewport in any section; on Share, one visible guest entry and no second capacity block. The mechanism is a CSS reveal, not DOM uniqueness: the utility rail's guest-entry and capacity copies stay in the document and are hidden below 761 |
| Card controls | 390, 431, 470, 1200 | Intake Filter and Clear, download, card controls, publication filters, bulk controls, note controls and export links all 44 x 44; card action rows fit; the two Gallery bulk controls stack below 761 and share one row from 761 |
| Long photo name | 320, 390, 768, 1440 | Wraps to 2–3 lines inside the card, full name retained in `title` |
| Long unbroken note | 320, 900 | Wraps rather than widening the page |
| Section change | 390 x 844 | Returns to the top of the new section, clear of the sticky rail |
| 120-photo intake | 320, 390, 768 | One 24-item page rendered initially, lazy and async previews, fewer than 24 initial preview requests, 44 x 44 `Load more photos`, five genuine 24-row pages append without duplicates, and an answered live first-page poll leaves the exhausted continuation control absent |
| Mobile export reachability | 390, 768 | One Gallery `Download all` control. Never two export panels on screen at once |

### Recoverable failures — `tests/e2e/error-recovery.spec.ts`

| Case | Widths | Result |
| --- | --- | --- |
| Failed guest and manager load | 320, 768 and the project viewport | Announced with the transport hint, 44 x 44 `Try again`, and the next attempt reaches the real surface |
| Session and lifecycle failures (7 codes, guest and manager) | project viewport | The link or the event's own end is named, no retry offered, and the transport line never appears |
| Refused bulk publish | 390 x 844 | Gallery section, `Unpublished` filter, cards and selection all survive; 44 x 44 dismiss |
| Refused delete | 390 x 844 | The photo and its card survive; notice dismissible |
| Refused export request | 390 x 844 | Gallery section and an enabled `Download all` survive |

### Automated accessibility engine — `tests/e2e/accessibility.spec.ts`

`@axe-core/playwright` 4.12.1 runs over the whole document — no `include`, no `exclude`, no
`runOnly`, no `withTags`, no `disableRules` — on `/`, the `/create` form, the `/create` success state
with the guest link revealed, the guest hero, the guest secondary content with all three disclosures
open, `/event/:slug/fullscreen`, each of the six manager sections, and the full-page and inline
manager credential-recovery states. Dedicated theme cases separately scan the complete guest
document for all four curated presets plus custom black, white, and `#767676` configurations, and
scan the full Manager Settings appearance editor. It supplements rather than replaces the keyboard,
target-size, geometry, contrast, zoom and reduced-motion assertions above.

### Exactly which rules run

Nothing is scoped away, but "nothing scoped away" is not the same as "every rule axe ships", and the
difference matters enough to write down. Measured against the installed axe-core 4.12.1:

- **105 rules ship.** **9 are disabled by default**, so a bare `.analyze()` is axe's *default* rule
  set, not its *full* one: `aria-roledescription`, `audio-caption`, `color-contrast-enhanced`,
  `duplicate-id`, `duplicate-id-active`, `identical-links-same-purpose`,
  `landmark-complementary-is-top-level`, `meta-refresh-no-exceptions`, and `target-size`.
- **`target-size` is switched back on** — `.options({ rules: { 'target-size': { enabled: true } } })`
  in `accessibility.spec.ts`. It is WCAG 2.2 SC 2.5.8, the closest thing axe ships to the subject of
  this plan, and leaving it off would have made the gate read stronger than it was. It reports
  **passes** on every surface that spec renders.

  **Read carefully what that does and does not prove.** SC 2.5.8's floor is **24 x 24 CSS px**, with
  spacing, inline, and essential exceptions. It is **not** the 44 x 44 floor this document uses as
  its standard everywhere else — see the target-size columns throughout the matrices above.
  `target-size` passing therefore clears a materially lower bar than those tables assert.
  **The 44 px floor is not machine-checked by axe and never has been:** it rests entirely on the
  `measureTarget` geometry assertions in six specs — `accessibility.spec.ts`,
  `public-responsive.spec.ts`, `guest-responsive.spec.ts`, `manager-responsive.spec.ts`,
  `manager-scale.spec.ts` and `error-recovery.spec.ts`. Those six are the complete list: no other spec
  imports `measureTarget` or asserts against 44. Do not read a green axe run as touch-target
  conformance, and do not thin those assertions out on the strength of it — axe would not notice a
  44 px control shrinking to 24. `error-recovery.spec.ts` remains the most exposed of the six because
  axe renders only its two manager credential-recovery surfaces — see the known gap below.
- **A further 7 of the 96 default-enabled rules are tagged `experimental`** and axe excludes them
  from a default run: `css-orientation-lock`, `focus-order-semantics`, `hidden-content`,
  `label-content-name-mismatch`, `p-as-heading`, `table-fake-caption`, `td-has-header`. They are left
  as axe ships them.
- So **90 rules are evaluated** per surface: 89 by default, plus `target-size`.

The eight rules that remain off are off deliberately. `color-contrast-enhanced` is AAA and this
product targets AA — the AA pairings are measured above and one of them clears by 0.0046, so
enabling AAA would report a long list of things nobody has agreed to fix. `duplicate-id` and
`duplicate-id-active` are deprecated in axe 4.x. `audio-caption` and `meta-refresh-no-exceptions`
have no applicable content: the product ships no audio and no meta refresh.
`landmark-complementary-is-top-level` and `aria-roledescription` are best-practice rules axe itself
holds back. `identical-links-same-purpose` is a needs-review rule that cannot pass or fail without a
human. None of them is off because it was failing.

The claim that `target-size` actually ran is itself asserted rather than trusted:
`expectNoAxeViolations` checks that `target-size` appears among the rules axe reports as evaluated
(`passes ∪ violations ∪ incomplete ∪ inapplicable`) before it checks the violation list. A rule that
never ran reports nothing, which on the wire is indistinguishable from a rule that ran and found
nothing — so without that check, deleting the option would leave a green suite and a false document.
Verified by removing the option: the guard fails first, on every surface.

Known gap: the engine renders the full-page and inline manager credential-recovery states, but it
does not render the guest error cards or an ordinary refused manager mutation. Those remaining
states are measured geometrically by `error-recovery.spec.ts`, which also checks the action notice's
resolved contrast directly; the original pairing was found and fixed by hand — see "Contrast
remediation".

Every surface enumerated for `accessibility.spec.ts` reports zero violations in both Playwright
projects. This is automated-browser evidence for those rendered states, not comprehensive
failed-state or physical-device conformance.

Fixed under this task:

- `landmark-unique` — the manager rail was an `aside`, giving the page two unnamed `complementary`
  landmarks. It is now the page's `banner`, which also keeps the brand inside a landmark.
- `page-has-heading-one` — `/event/:slug/fullscreen` had no level-one heading. It now carries a
  screen-reader-only one; visible copy is unchanged.
- `color-contrast` on the guest note byline — `.notes-feed small` was written for the dark
  notes band and rendered a guest's name at 1.72:1 when that component was reused on the light guest
  surface. It now inherits the ink the surrounding feed already uses.
- `color-contrast` on the guest ground — see "Contrast remediation" below.
- `color-contrast` on the landing privacy note — see "Contrast remediation" below.

## Automated browser evidence — date-driven guest phase

`docs/superpowers/specs/2026-08-01-date-driven-guest-phase-design.md` adds two guest surfaces and
one manager control. The converged browser run measured the local automated states named below.
Partial rows retain their exact outstanding claim; none of this evidence proves a physical device,
native assistive technology, production runtime, or manual rehearsal.

| Surface | Widths / viewports | Measured result and remaining boundary |
| --- | --- | --- |
| Before-start, responded household | 320 x 844, 390 x 844 | `guest-lifecycle.spec.ts` passed one `<h1>`, nested `<h2>`, Axe, and document containment at both viewports; `rsvp-responsive.spec.ts` contained the maximum-name receipt at both widths; `visual-qa.spec.ts` passed the exact 390 x 844 `rsvp-before-start-390.png` baseline. **Outstanding:** the 320 x 568 first-fold composition was not exercised. |
| Before-start lookup and unavailable access | 320 x 844, 390 x 844 | `rsvp-journey.spec.ts` passed the session-free saved-response lookup at the mobile project's 390 x 844 viewport; `guest-lifecycle.spec.ts` exercised unavailable access at both pinned viewports. **Outstanding:** exact unresponded/miss copy parity and an explicit no-household-request assertion were not measured by these browser cases. |
| Waiting, photo delivery paused | 320 x 844, 390 x 844 | `guest-lifecycle.spec.ts` passed the single paused heading/copy, absence of RSVP lookup or receipt, Axe, and document containment at both viewports. Local automation only; physical/manual evidence remains outstanding. |
| Automatic schedule transition | 320 x 844, 390 x 844 | `guest-lifecycle.spec.ts` passed untouched boundary crossing, quiet refresh failure, `pageshow` recovery, long-delay slicing, and server-delay behavior with browser clocks four days behind and six days ahead at both viewports. Local automation only; physical/manual evidence remains outstanding. |
| Manager photo intake control | 320 x 844, 390 x 844 | **Outstanding:** the selected browser suites did not exercise the manager status/action recheck across the event start. Unit/UI coverage is not promoted to browser or manual evidence. |

The responded before-start surface now has the inspected 390 x 844 tracked baseline named above.
No waiting, automatic-transition, or manager photo-intake PNG is claimed.

## Decisions recorded

- **Workflow text floor.** The 160 px minimum for workflow step text applies to the one- and
  two-column bands only. At 900 px the workflow is three columns and step text measures about
  128 px; that is accepted, and `public-responsive.spec.ts` asserts the floor across 761, 780 and
  860 rather than at 900.
- **Guest card frame guard.** The `(min-width: 700px) and (min-height: 760px)` guard is kept exactly
  as specified. The consequence is that 1366 x 768 and 1280 x 800 laptops render the guest page
  without its card frame. That is an accepted decision, not an oversight.
- **Decorative hero blob.** `.hero__image::before` clips roughly 1.8–3.1 px past the left edge of the
  viewport between 320 and 760 px. It is pre-existing, was reduced by this work, and is left in
  place. No containment assertion can catch it: left overflow cannot contribute to `scrollWidth` in
  a left-to-right document.
- **`figure { margin: 0 }`.** This reset also reflowed the landing hero and its `::before` blob. The
  landing baselines were captured knowing that; the difference from earlier captures is the intended
  effect of the reset, not a diff to investigate.
- **Intake count badge at the cap.** At 10,000 photos the widened badge overlaps the Intake icon on a
  phone. The count and the `Intake` label both stay fully legible, and the icon is secondary to the
  label by design, so the overlap is accepted.
- **Intake poll and the paging assertion.** `manager-scale.spec.ts` exposes all five 24-row pages in
  its 120-photo fixture, pages to exhaustion, then lets the real five-second intake interval issue a
  cursor-less first-page request through the normal route stub. The answered poll keeps all 120
  unique rows and does not restore `Load more photos`. `tests/ui/app.test.tsx` separately pins
  overlap, discontinuity, stale-query, and concurrent append ordering with controlled timers.
- **Nested projections replace the sentinel.** Manager event JSON owns exactly six cover keys and
  guest JSON the exact four-key safe subset. Both carry the current revision and qualified 2x profile
  list; neither carries the private master/object key, render-set ID, receipt ID, or Workflow ID.
  Impossible semantic/pointer/set graphs emit one identifier-free invariant reason and fail closed.
- **Replacement and failure use the revisioned contract.** Every picture candidate includes the
  event's current revision. A publication response/event refresh updates that revision immediately;
  a missing current WebP falls to current JPEG, a second failure becomes the gradient, and the event
  owner performs one cover-only refresh for that revision/profile. A newer revision resets recovery;
  an unchanged revision does not loop. There is no revisionless endpoint or legacy/master fallback.
- **Local Workflow evidence does not prove platform lifecycle behavior.**
  `EXPORT_WORKFLOW.create()` is awaited before a `202` and asserted by `export-api.test.ts:29`, so
  binding presence and instance creation are genuinely demonstrated under the workerd pool. Cover
  Workflow lifecycle calls — `get()`, `.status()`, `.resume()`, `.restart()`, `.terminate()`, and
  `createBatch()` recovery — are exercised against injected fakes; the operator-loop rehearsal does
  not execute its generated platform strings. Every §9.4 disposition depends on real platform
  behavior those local tests cannot establish. No local probe was run against real statuses, and none
  of this candidate's tests should be read as evidence that the platform behaves as the fake does.
  Closing that distance requires the separately authorized route-disabled Workflow-conformance and
  cutover staging matrices in `docs/deployment.md`.
- **Cover contrast is arithmetic, not screenshots.** All 720 preset, effect, theme, and profile
  contexts are composited by `coverTextContrast` over the brightest pixel each rendered profile
  actually contains, measured once at build time into the asset manifest. A separate monotonicity
  argument proves the fixed scrim protects an arbitrary uploaded photograph, since white copy is
  hardest to read over the brightest possible source. 720 Playwright screenshots would be slower,
  flakier, and would still say nothing about uploads; axe reads declared colours and cannot speak to
  text over an image at all.
- **The fidelity ledger records Phase 3 at local strength.** It now names all 29 inspected files,
  responsive/delivery recovery, the live Manager canvas, dynamic axe coverage, and the exact remote/
  device boundaries. It does not promote local route fakes or deterministic bytes into staging proof.

## Contrast remediation

The engine originally reported eleven serious `color-contrast` elements on the landing and guest
surfaces, plus one more the engine never reaches. All are now resolved. **During that contrast-
remediation task, no value in `design/design-system.md`'s token table changed.** Two of the three
fixes move an *undocumented*
literal onto a *documented* token or an existing one, and the third stops using a status token as
body copy — which is why this satisfies "preserve the Candidary palette" rather than departing from
it.

| Fix | Before | After | Elements cleared |
| --- | --- | --- | ---: |
| Guest ground: `.guest-shell--drop` and `.guest-secondary` | `#f4ede4`, not in the token table | Parchment `#f7f1e7`, the documented page ground the rest of the app already stands on | 10 |
| `.privacy-note`: colour declaration deleted, moss moved to the icon | moss `#68763d` body text at 4.40 | inherited ink at 14.88 with a moss check, matching `.trust-list` — an existing component with identical markup | 1 |
| `.manager-action-error` ground | `#fbe0dc`, danger at 4.48 | `#fff1ee`, the ground `.form-error` already uses, danger at 5.09 | 1 (engine-invisible) |

### The margin, recorded honestly

The guest-ground fix lands ten elements **simultaneously at 4.5046**, clearing the 4.5 threshold by
**0.0046**. It genuinely passes, and the same pairing already passed under this engine on `/` and
`/create` before this change, so it is the app's established standard rather than a new one. But the
headroom is essentially nil: **any future darkening of Parchment, or lightening of Muted ink,
re-breaks all ten at once.** Treat `--muted` on `--parchment` as a load-bearing pair.

The alternative with real headroom — nudging Muted ink from `#766c70` to `#726a6e`, which measures
4.67 on parchment and is visually indistinguishable — was **declined** because it edits the binding
token table.

One instance of the old error ground survives deliberately: `.status--rejected` still pairs danger
with `#fbe0dc` at 4.48. It is a different component, it was outside the scope of this remediation,
and no axe pass renders it. It is the next thing to look at if that pairing is revisited.

## Severity review

- P0: none.
- P1: none.
- P2: none open. The one serious `color-contrast` finding is resolved above.
- P3: none observed in the verified states.

## Album workspace end-to-end QA — 2026-08-23

### Source and implementation

- **Canonical handoff:** `Candidary Design System-handoff.zip`, internal file
  `candidary-design-system/project/templates/album-workspace/AlbumWorkspace.dc.html`.
- **Import boundary:** the requested Claude Design MCP connection was attempted, but its protected-
  resource metadata and advertised authorization-server issuer did not agree. The supplied ZIP was
  therefore used as the readable canonical fallback; this record does not claim that MCP import
  succeeded and the source file was not modified.
- **Implementation states:** `/manage/event/:eventId` → **Gallery** → **Library**, **Album**, inline
  album preview, and **Shared**; `/album#id.secret` → fragment exchange → `/album` for the public
  album. The browser fixture used twelve realistic photo records, ten existing picks, an ordered
  five-entry album, title, description, cover, and active sharing.
- **Browser runner:** the Browser plugin was unavailable, so the user-approved Playwright/Chromium
  fallback was used. This evidence is local Chromium automation, not Safari/WebKit, a physical
  iPhone or Android device, VoiceOver/TalkBack, or a native camera/photo-picker rehearsal.

### Native-viewport capture evidence

| Surface | Viewport | Captures |
| --- | --- | --- |
| Manager handoff sequence | 924×540 | `/tmp/candidary-album-qa/implementation/desktop-01-library.png` through `desktop-07-shared.png` |
| Manager responsive sequence | 390×844 | `/tmp/candidary-album-qa/implementation/mobile-01-library.png` through `mobile-05-shared.png` |
| Public album | 390×844 | `/tmp/candidary-album-qa/implementation/mobile-06-public.png` |
| Same-state desktop comparisons | 1848×540, two native 924×540 halves | `/tmp/candidary-album-qa/compare/desktop-01-library.png` through `desktop-07-shared.png` |
| Same-state mobile comparisons | 780×844, two native 390×844 halves | `/tmp/candidary-album-qa/compare/mobile-01-library.png`, `mobile-02-selection.png`, `mobile-03-editor.png`, and `mobile-05-shared.png` |

Each comparison input placed the source handoff on the left and the implementation on the right at
the same state and native viewport, then captured the pair as one image. Inspection covered layout,
spacing, type weight, borders, radii, crops, copy, interactive-target containment, and overflow.
The source component references `exitsOpen` but does not return it from its component logic, so its
inline preview exit cannot render; it also has no public route. Those production states were therefore
verified independently instead of inventing or editing source behavior.

### Findings and disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| P0 | None. | No remediation required. |
| P1 | None. | No remediation required. |
| P2 | Production retains the Manager lifecycle facts above Gallery, so Gallery begins lower than the isolated handoff shell. | Retained intentionally: deletion timing, stored bytes, and private-delivery state are existing host commitments and remain legible without clipping or blocking the workspace. |
| P2 | The source keeps the three-mode switch inline at phone width, while production stacks it below 761 CSS pixels. | Retained intentionally: stacking is the approved responsive contract, preserves full labels and 44 px targets, and introduces no horizontal overflow. |
| Evidence boundary | The handoff cannot render its intended inline-preview exit because `exitsOpen` is absent from the returned component state, and it defines no public route. | The source was preserved. Production preview and public album were captured and audited directly; neither limitation was treated as implementation parity. |
| P3 | At 390 px, production keeps the tray's Add and Remove actions beside one another before wrapping Clear selection; the source places Add on its own row. | Retained: all three controls remain readable, contained, and at least 44 px high, with the two reversible album actions grouped together. |
| P3 | Production adds the current pick count to the Album mode label. | Retained as useful state reinforcement; the accessible name and selected state remain clear. |

No open P0 or P1 visual defect remains. The P2 differences are deliberate product-contract choices,
not unresolved broken layout. Photo crops, paper/denim/moss palette, typography, borders, radii,
selection tray, album editor, sharing state, and public album remain visually coherent at the pinned
viewports.

### Accessibility and operability evidence

- Axe, including the `target-size` rule, reported zero violations in the 390×844 Library, selection,
  editor, inline preview, Shared, and public-album states.
- Direct geometry checks measured every visible Manager brand, navigation button, workspace button,
  text field, textarea, and select at no less than 44×44 CSS pixels at 390×844.
- The Album mode, reconciliation action, and preview action completed by keyboard; reduced-motion
  emulation removed the selection-tray animation and restored non-smooth document scrolling.
- The saved editor remained operable and horizontally contained at 640×450 and 320×450, used as
  200% and 400% reflow proxies. All audited 390×844 manager/public states also passed document-level
  horizontal-overflow checks.
- The public exchange removed the fragment credential before rendering the album. This visual pass
  complements, but does not replace, the separate request/cookie/original-media security coverage.

### Consolidated repository evidence

- `npm run lint`, `npm run typecheck`, `npm run typecheck:e2e`, `npm run verify:bindings`,
  `npm run ci:migrations`, `npm run verify:fresh-d1`, `npm run build`, and `git diff --check`
  completed successfully. The fresh-D1 check pinned all eighteen migrations plus the album tables,
  columns, cascades, checks, partial indexes, and cover index.
- Unit tests passed at 1,375/1,375 across 68 files. Worker tests passed at 1,311/1,311 across
  56 files.
- The first complete `npm run test:e2e` invocation ran all 514 project cases: 337 passed, 132 were
  intentionally skipped by project, and 45 reported failures. Forty were Playwright's deliberate
  missing-snapshot result because this checkout tracks Win32 baselines but no corresponding Linux
  baselines; the generated `*-linux.png` files were not accepted as new design evidence and were
  removed. The other five project cases exposed three stale assertions: a repeated album title made
  one keyboard locator ambiguous, Gallery's one external live region needed to be excluded from the
  inert-shell assertion, and renamed Gallery modes plus that live region made two legacy locators
  ambiguous. After narrow corrections, the album keyboard case passed, viewer containment passed in
  both desktop and mobile projects, and bulk-publish recovery passed in both projects. No product
  styling or approved visual contract changed in those corrections.
- Browser evidence remains local Chromium automation. A green targeted run is evidence for the album
  flow and its coupled Gallery regressions; it is not a claim that this Linux host possesses or
  compared the repository's Win32-only visual baselines.

### Independent final-review corrections

The complete branch review found eleven edge cases after the consolidated gate, and its corrected-diff
rereview found three more. All fourteen were confirmed and corrected in the existing final commit:
one-time atomic album reconciliation and frozen starting order, retryable ambiguous export dispatch,
same-document share exchange with stale-request protection, crawler exclusion, persistent public
status announcements, section autosave without blur, focus restoration after conditional controls
disappear, enabled-boundary reorder focus, section-input focus visibility, Shared-selection reset,
one derived Album save state, StrictMode-safe autosave disposal, a non-destructive legacy-favorite
capacity guard, and truthful reconciliation winner/loser handling.

- The complete Album workspace UI file passed 76/76 tests, including StrictMode replay and stale
  reconciliation coverage in addition to the first six Manager regressions.
- The affected album/export Worker files passed 77/77 tests, including three new concurrency and
  redrive regressions. After the rereview, the complete 28-test Album Worker file passed again with
  legacy-cap and winner/loser cases; the Worker TypeScript project also passed.
- The public album and crawler files passed 16/16 focused Vitest cases. Five focused
  production-preview Playwright cases passed, followed by a 1/1 strengthened no-reload fragment
  transition that kept a mounted-document marker intact.
- The final compact static check passed lint, app/Worker TypeScript, E2E TypeScript, and
  `git diff --check` in one run.
- The same independent reviewer inspected the three final corrections and returned no Important or
  Minor findings. Its only residual limitation is that real-unmount queue disposal is supported by
  lifecycle code inspection and the queue disposal unit test rather than a dedicated component-level
  unmount assertion.

These corrections add no new visual direction. The only visible styling change is the missing
keyboard focus outline on the existing section-name field, so the approved source comparisons and
native-viewport captures remain the applicable visual evidence. Per the request to commit and gate
less, the broad repository suites above were not repeated after this narrow correction pass; the
affected suites and static boundaries were rerun instead.

final result: passed

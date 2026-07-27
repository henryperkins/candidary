# Mobile Host Design QA

## Visual truth

- Supplied host failure states: `1-Photo-1.jpg` and `2-Photo-2.jpg`.
- Approved responsive behavior: `docs/superpowers/specs/2026-07-22-mobile-first-host-views-design.md`.
- The supplied screenshots document the broken state, so the corrected labeled navigation and contained controls are intentional differences rather than pixel-matching defects.

## How this evidence is produced

```powershell
npm run typecheck        # tsc -b; covers src, worker, tests/unit, tests/ui — NOT tests/e2e
npm run lint             # eslint . --max-warnings=0; covers tests/e2e syntactically, not its types
npm test                 # unit/UI in jsdom, then Worker tests in workerd
npm run build            # tsc -b then vite build
npm run test:e2e         # Playwright: geometry, boundary, axe, and tracked-baseline evidence
```

`tests/e2e` belongs to neither TypeScript project, so `npm run typecheck` does not type-check the
Playwright specs. It is kept type-clean by hand against a throwaway config with the same compiler
options and `include: ["tests/e2e/**/*.ts", "shared/**/*.ts", "playwright.config.ts"]`. Repeat that
check when the specs change; lint alone will not catch a type error there.

Two Playwright projects remain: `desktop` (1440 x 1000) and `mobile` (390 x 844, `isMobile`,
`hasTouch`). Boundary coverage does not multiply the suite across projects — each responsive spec
pins its own viewport with `page.setViewportSize()`.

## Tracked visual baselines

`tests/e2e/visual-qa.spec.ts` asserts committed images under
`tests/e2e/visual-qa.spec.ts-snapshots/`, compared exactly — `threshold: 0` **and**
`maxDiffPixels: 0` — with animations disabled and `scale: 'css'`. `output/` remains disposable and is
cited nowhere.

Both tolerances are required. `maxDiffPixels: 0` alone only counts pixels that already exceeded the
per-pixel `threshold`, which defaults to 0.2 in a YIQ colour space. That default absorbs a
whole-surface recolour of a few units per channel: the guest ground moving from `#f4ede4` to
`#f7f1e7` changed 393,839 pixels of one baseline and the comparison reported it as a pass. A palette
regression is exactly what a tracked baseline exists to catch, so the comparison is exact.

Exactness only pays if the capture is deterministic, so `settle()` in `visual-qa.spec.ts` does two
things before every screenshot, both of which were found by turning the tolerances off:

- **Parks the pointer outside the viewport.** A test that clicks its way into a state leaves the
  mouse on the control it clicked, and that control keeps its `:hover` paint. The `/create` submit
  button differs from its resting state by 13,077 px of aubergine-strong fill, and whether that paint
  landed before the capture varied from run to run.
- **Waits until the font set is quiet across two frames**, not merely for one `document.fonts.ready`.
  A face is only requested when a glyph needs it, so laying out with the faces loaded so far can
  request another and begin a cycle that `ready` already resolved past. A late arrival moves centred
  text even when it moves nothing else, because the label re-centres on a different sub-pixel origin.

Both were latent while the comparison was lossy. Neither affects what the page renders.

Regenerate and then prove reproducibility:

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts --update-snapshots
npx playwright test tests/e2e/visual-qa.spec.ts
```

| Baseline | Route and state | Viewport |
| --- | --- | ---: |
| `landing-first-fold-320.png` | `/` first fold: headline, supporting sentence, both actions | 320 x 568 |
| `landing-workflow-780.png` | `/` `.workflow` band, two columns | 780 x 900 |
| `create-validation-focus-390.png` | `/create` `.create-form` after a 422 with three field errors, focus on the first invalid field | 390 x 844 |
| `guest-long-welcome-320.png` | `/event/:slug` with a 500-character welcome, clamped with its disclosure | 320 x 568 |
| `guest-landscape-844x390.png` | `/event/:slug` in phone landscape | 844 x 390 |
| `guest-review-320.png` | `/event/:slug` review state: one accepted photo, one rejected file | 320 x 844 |
| `guest-secondary-long-content-320.png` | `/event/:slug` `.guest-secondary` with deliveries and gallery open on 80-character filenames | 320 x 844 |
| `fullscreen-long-caption-320.png` | `/event/:slug/fullscreen` first figure with an 80-character caption | 320 x 844 |
| `manager-nav-768.png` | `/manage/event/:id` compact 104 px rail | 768 x 900 |
| `manager-nav-count-390.png` | `/manage/event/:id` stacked rail with the count at the 10,000-photo cap | 390 x 844 |
| `manager-actions-320.png` | `/manage/event/:id` Gallery card with all four controls | 320 x 844 |
| `manager-export-first-390.png` | `/manage/event/:id` Share section including the mobile export panel | 390 wide |

Files on disk carry Playwright's default suffixes, so each name above is stored as
`<name>-mobile-win32.png`. That is deliberate and must not be normalised away:

- **`-win32`** — these images were rasterised by Windows. A Linux CI run must report a *missing*
  baseline rather than silently diff Linux font rendering against Windows font rendering.
- **`-mobile`** — `visual-qa.spec.ts` is excluded from the `desktop` project (`testIgnore` in
  `playwright.config.ts`). Every state above is 844 px wide or narrower and belongs to a touch
  device; a second desktop-emulated copy would picture a viewport with a 15 px scrollbar that no
  phone has.
- `manager-export-first-390.png` is captured at 390 px wide with a tall capture window so the whole
  Share section lays out at once. The sticky rail would otherwise be drawn over any part of it that
  had to be scrolled into view. Width is what the layout is made of; the height is only the window.
- Dates rendered through `Intl` (`/create` date placeholder, the guest hero date) follow the
  capturing machine's locale and time zone. That is a further reason the platform suffix stays.

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
| Header exits | 320, 768 | Exactly two exits on each of `/` and `/create`, each 44 x 44, at least 8 px apart |
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

### Manager — `tests/e2e/manager-responsive.spec.ts`, `tests/e2e/manager-scale.spec.ts`, `tests/e2e/visual-qa.spec.ts`

| Surface | Widths | Result |
| --- | --- | --- |
| Shell and media grid turnover | 320, 360, 390, 430 / 431, 470, 760 / 761, 768, 780, 860, 1024, 1100 / 1101, 1120, 1133, 1134, 1440 | 1, 2, 2 and 3 media columns; no shell tracks below 761, a 104 px rail through 1100, and 184 px + 330 px rails from 1101 |
| Destination labels | 320, 390, 761, 768, 780, 860, 1024, 1100, 1101, 1440 | Five labels rendered, each at or above 14 px, each target 44 x 44 |
| Label contrast | 320, 390, 761, 1024, 1440 | Every destination label at or above 4.5:1, measured from resolved colours |
| Rail packing | 761 through 1440 | Brand at or under 60 px; the five destinations occupy at most 340 px rather than stretching |
| Manager Brand target | 320, 761, 1101 | Clickable Brand remains at least 44 x 44 when each navigation layout begins |
| Lifecycle facts at capacity | 761 through 1440 | Each of the three facts stays on one line at 10,000 photos and 100 GiB |
| Intake count badge at the cap | 320, 360, 390, 430, 431, 470, 760, 761, 768, 780, 860, 1024, 1100, 1101, 1120, 1133, 1134, 1440 | `10000` contained by the badge's own box at every width, badge at most 48 px wide; count text is at least 12 px at the three layout starts |
| All five sections at 200% zoom | 640 x 450 | Every destination reachable at 44 x 44; no rails; two media columns; no escapes |
| All five sections | 390 x 844 | No element of the shell leaves the viewport in any section; on Share, one visible guest entry and no second capacity block — the rail's copies are in the document and hidden, as above |
| Card controls | 390, 431, 470, 1200 | Intake Filter and Clear, download, card controls, publication filters, bulk controls, note controls and export links all 44 x 44; card action rows fit |
| Long photo name | 320, 390, 768, 1440 | Wraps to 2–3 lines inside the card, full name retained in `title` |
| Long unbroken note | 320, 900 | Wraps rather than widening the page |
| Section change | 390 x 844 | Returns to the top of the new section, clear of the sticky rail |
| 120-photo intake | 320, 390, 768 | One 24-item page rendered initially, lazy and async previews, fewer than 24 initial preview requests, 44 x 44 `Load more photos`, five genuine 24-row pages append without duplicates, and an answered live first-page poll leaves the exhausted continuation control absent |
| Mobile export reachability | 390, 768 | Never two export panels on screen at once. The mechanism is a CSS reveal, not DOM uniqueness: on the phone's Intake the rail's copy is the document's only panel and it is hidden; on Share the Share copy is visible below 761 and the utility copy hidden, and the two swap at and above it |

### Recoverable failures — `tests/e2e/error-recovery.spec.ts`

| Case | Widths | Result |
| --- | --- | --- |
| Failed guest and manager load | 320, 768 and the project viewport | Announced with the transport hint, 44 x 44 `Try again`, and the next attempt reaches the real surface |
| Session and lifecycle failures (7 codes, guest and manager) | project viewport | The link or the event's own end is named, no retry offered, and the transport line never appears |
| Refused bulk publish | 390 x 844 | Gallery section, `unpublished` filter, cards and selection all survive; 44 x 44 dismiss |
| Refused delete | 390 x 844 | The photo and its card survive; notice dismissible |
| Refused export request | 390 x 844 | Share section and an enabled `Prepare download` survive |

### Automated accessibility engine — `tests/e2e/accessibility.spec.ts`

`@axe-core/playwright` 4.12.1 runs over the whole document — no `include`, no `exclude`, no
`runOnly`, no `withTags`, no `disableRules` — on `/`, the `/create` form, the `/create` success state
with the guest link revealed, the guest hero, the guest secondary content with all three disclosures
open, `/event/:slug/fullscreen`, and each of the five manager sections. It supplements rather than
replaces the keyboard, target-size, geometry, contrast, zoom and reduced-motion assertions above.

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
  44 px control shrinking to 24. `error-recovery.spec.ts` is the most exposed of the six, because it is
  the only one whose surfaces no axe pass renders at all — see the known gap below.
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

Known gap: no axe pass renders a failed state, so the engine never reads the guest or manager error
cards or the manager's inline action notice. Those states are measured geometrically by
`error-recovery.spec.ts`, which also checks the notice's resolved contrast directly; the original
pairing was found and fixed by hand — see "Contrast remediation".

Every surface enumerated for `accessibility.spec.ts` reports zero violations in both Playwright
projects. This is automated-browser evidence for those rendered states, not failed-state or
physical-device conformance.

Fixed under this task:

- `landmark-unique` — the manager rail was an `aside`, giving the page two unnamed `complementary`
  landmarks. It is now the page's `banner`, which also keeps the brand inside a landmark.
- `page-has-heading-one` — `/event/:slug/fullscreen` had no level-one heading. It now carries a
  screen-reader-only one; visible copy is unchanged.
- `color-contrast` on the guest note byline — `.notes-feed small` was written for the dark aubergine
  notes band and rendered a guest's name at 1.72:1 when that component was reused on the light guest
  surface. It now inherits the ink the surrounding feed already uses.
- `color-contrast` on the guest ground — see "Contrast remediation" below.
- `color-contrast` on the landing privacy note — see "Contrast remediation" below.

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

## Contrast remediation

The engine originally reported eleven serious `color-contrast` elements on the landing and guest
surfaces, plus one more the engine never reaches. All are now resolved. **No value in
`design/design-system.md`'s token table changed.** Two of the three fixes move an *undocumented*
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

final result: passed

---
target: Gallery UI, image thumbnails
total_score: 17
max_score: 40
na_heuristics:
p0_count: 3
p1_count: 2
timestamp: 2026-08-15T12-25-07Z
slug: src-features-gallery
---
Method: dual-agent (A: design review · B: detector + browser evidence), plus an 8-claim adversarial verification pass that corrected three of A's factual claims before synthesis.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | The mosaic cannot display the thing it exists to display (P0-1); the export card freezes with no poll; a search returns no result count anywhere. |
| 2 | Match System / Real World | 2 | Moment headings are exemplary and refuse to invent labels — but a "gallery" showing no photographs, naming photos `IMG_4821.HEIC`, and collapsing a whole reception into one 45-minute-gap moment does not match a host's world. |
| 3 | User Control and Freedom | 1 | `ORDER BY timeline_at ASC, id ASC`, forward-only cursor, 48/page, no sort, no reverse, no jump, no collapse-all. |
| 4 | Consistency and Standards | 2 | Two tile languages for the same photos one switch apart; the favorited tile is Chestnut while the Favorites *filter* is Denim; the shared gallery renders previews unconditionally while the private one gates them. |
| 5 | Error Prevention | 2 | "Show more photos" on an 800-photo moment is an unwarned all-at-once render; search validation lands as a bar at the page top, not beside the field. |
| 6 | Recognition Rather Than Recall | 2 | The tile's name is a camera filename, ellipsized to one `nowrap` line, in white over an arbitrary image; nothing marks a moment as already reviewed. |
| 7 | Flexibility and Efficiency | 1 | No bulk favorite, no arrow-key navigation in the grid, no jump-to-date; toggling Favorites discards every loaded page. |
| 8 | Aesthetic and Minimalist Design | 2 | An always-on scrim covers ~59% of a 1×1 tile at 320px to restate a name three other places already carry; the mosaic rhythm silently dies past position 8. |
| 9 | Error Recovery | 2 | Genuinely good scoped `replace`/`append` retry and `role="alert"` — but the mosaic's unavailable-preview state is an `aria-hidden` glyph with zero text, and the notice never scrolls into view. |
| 10 | Help and Documentation | 2 | One model sentence, and only in an empty state that a host with favorites never sees again. |
| **Total** | | **17/40** | **Poor — major overhaul required on the core surface** |

## Design Specificity Verdict

**LLM assessment.** Roughly 80% category-interchangeable. Strip the palette tokens and what remains is the pattern every photo product has shipped since 2014: `object-fit: cover` on a fixed row height, an invisible full-bleed open button, a circular favorite pinned top-right, an always-on bottom gradient carrying a filename, "Load more" as the only navigation of a 10,000-item collection, and a dark lightbox with chevrons at `top: 50%`. Nothing in that list required knowing what Candidary is.

Named, category-interchangeable choices:
- The tile (`styles.css:880–889`) — Google Photos / Pixieset / Pic-Time, verbatim.
- The viewer (`styles.css:891–924`) — dark backdrop, 52px chevrons at 50%, X top-right, meta footer.
- `.gallery-mosaic__item { border-radius: 8px }` — DESIGN.md reserves 2–5px for "overlapping square prints" and 8px is the **control** radius. Every photograph in the product's most photographic surface is shaped like a button.
- `.gallery-mosaic__item { background: var(--denim-soft) }` — the coldest token in a warm-paper palette, and semantically "selected/pending," used as the ground under every wedding photo.

Genuinely product-specific and worth defending: `formatMomentHeading` (`gallery-timeline.ts:79–94`), whose docblock explicitly refuses to guess "Ceremony" or "Dance floor"; and `positionLabel` (`GalleryViewer.tsx:20–29`), which says "Photo 12 of 48 **loaded**" because the header says 4,812. Both are *prose*, neither is *composition*. The authored mosaic in `SPAN_PATTERNS` applies only to positions 1–8 of a moment — it is a composition for a screenshot, not for 5,000 photos.

The specific betrayal: DESIGN.md says "**Do** let photographs carry celebration while surrounding controls remain calm." The mosaic does the inverse — one invisible button over 100% of every tile, a heart on the image, and a permanent dark band over more than half of it — while the calm went to the chrome around them.

**Deterministic scan.** `detect.mjs --json src/features/gallery` → `[]`, exit 0. Zero findings, confirmed against the seven `.tsx` files individually, against `ManagerPage.tsx`, and with `--no-config` to rule out suppression.

That clean result is structural, not a verdict: the gallery `.tsx` files carry no literal styling, so a directory-scoped scan cannot reach the gallery's actual design. The detector is not a no-op — `detect.mjs --json src` returns exit 2 with **151 findings**, *all* in `src/styles.css`. Eight land inside gallery selector ranges:

| Line | Rule | Selector | Value |
|---|---|---|---|
| 819 | radius | `.gallery-mode-switch button` | `4px` |
| 866 | font-size | `.gallery-search label` | `.8rem` |
| 877 | font-size | `.gallery-moment__heading h3` | `1.25rem` |
| 878 | font-size | `.gallery-moment__count` | `.8rem` |
| 888 | font-size | `.gallery-mosaic__meta strong` | `.82rem` |
| 889 | font-size | `.gallery-mosaic__meta small` | `.72rem` |
| 921 | font-size | `.gallery-viewer__meta strong` | `1.25rem` |
| 922 | color | `.gallery-viewer__meta span` | `#e8dfd5` |

None are strictly false — DESIGN.md's ramp has six steps and its radius scale excludes 4px. But `design-system-font-size` is 108 of the 151 findings file-wide, so treat it as a stylesheet-level ramp problem rather than a gallery defect. Line 819's `4px` is a documented deliberate pairing with `.filter-tabs`, low signal. **Line 922's `#e8dfd5` is the one genuine off-token color in any gallery selector** — and it agrees with the design review, which flagged the same literal independently.

**Visual overlays.** No reliable user-visible overlay is available; `detect.js` was not injected. The gallery is credential-gated, so URL-mode detection reaches the unauthenticated landing page, not the manager mosaic. The fallback signal used instead is stronger than an overlay would have been: the mosaic was rendered through the repo's own `tests/e2e/visual-qa.spec.ts` against stubbed routes, then measured live in the DOM with pixel-level contrast readback at 320/390/768/1280.

## Overall Impression

There is real authorship in this feature, and it is all in the sentences. `formatMomentHeading`'s refusal to invent "Ceremony," the viewer's "of 48 loaded," the favorites empty state's "It does not publish it" — three places where someone thought hard about what is *true* and said exactly that. That is the Quiet Event Ledger, executed.

The composition never got the same attention, and one line of it is broken outright. The private gallery gates every `<img>` on a flag that current-generation media never sets, so the surface renders a grid of grey broken-image glyphs. The only reason nobody has seen it is that the visual-regression fixtures hand-write that flag to `true` — the tests that take the screenshots are the tests that fake the condition.

**The single biggest opportunity:** this is the emotional center of the entire product — a host opening their wedding for the first time — and it is currently the surface where the photographs are least present. Make the photographs actually appear, get the interface off them, and open the timeline where the host's memory actually is.

## What's Working

**1. The two functions that know what product this is.** `formatMomentHeading` (`gallery-timeline.ts:79–94`) shares a meridiem only when it legitimately can ("4:12–5:30 PM"), names both dates across midnight, and its docblock rules out guessed labels. `positionLabel` (`GalleryViewer.tsx:20–29`) says "of 48 **loaded**" precisely because the header says 4,812. This is "Truth comes from the system" as code rather than as a quoted value, and it is the hardest thing here to copy.

**2. The favorites empty state.** "The heart on a photo adds it to Favorites for every host on this event. It does not publish it." It answers the exact fear a host carries into a product with both a private and a shared gallery, at the moment they would have it, in one sentence, with no tooltip and no help link. It also names the multi-host consequence, which nothing else on the surface does.

**3. Deliberate focus reasoning on the hard transitions.** `ManagerPrivateGallery.tsx:215–225` moves focus to the tile that inherited the removed row's index when unfavoriting inside the Favorites filter. `GalleryMoment.tsx:78–80` keeps focus on the collapse toggle, with a comment explaining that the alternative would make the host tab through every remaining tile to reach the button they just pressed. Someone reasoned about the keyboard *path*, not just sprinkled `tabIndex`. Which makes P0-2 all the more painful — it silently defeats this work.

## Priority Issues

### [P0] 1. The private gallery renders no photographs at all

**What:** `GalleryMoment.tsx:46` and `GalleryViewer.tsx:115` gate the `<img>` on `photo.previewAvailable`. That field is derived as `previewObjectKey !== null` (`worker/db/media.ts:225,240,269`) — it reports "is a legacy preview object recorded in the row," not "can this photo be previewed." Its only writer, `MediaRepository.setPreviewObjectKey` (`worker/db/media.ts:2040`), has **zero callers**, and is restricted to `object_bucket_generation = 'legacy'` anyway. Every other reference to the column *clears* it (`media.ts:861, 1046, 1148, 1438, 1898`). Meanwhile `getOrCreatePreview` (`worker/storage/previews.ts`) needs the key for nothing — it falls straight through to the original and transforms it, and its own comment states that new previews are deliberately ephemeral.

So for any photo delivered by the current code, `previewAvailable` is `false`, and every mosaic tile renders `<div className="gallery-mosaic__placeholder" aria-hidden="true"><ImageOff /></div>` — a grey glyph with no text. Opening one shows "Preview unavailable." `GET /api/media/:id/preview` would have returned a perfectly good WebP.

The repo's own tests state both halves of this: `tests/worker/host-private-gallery-api.test.ts:126` and `tests/worker/manage-api.test.ts:327,342,350,616` assert `previewAvailable: false` from the real Worker + D1 path for genuinely stored photos, while `tests/e2e/fixtures/routes.ts:343` and `manager-responsive.spec.ts:522` hand-write `previewAvailable: true`. The only tests that render a picture are the ones that fake the flag, which is exactly why the committed visual baselines look fine.

**Why it matters:** the host's private gallery is where the product delivers on its core promise. It currently delivers a grid of broken-image icons, and the placeholder is `aria-hidden` with zero text, so it does not even say what happened. The shared gallery — one mode switch away, `ManagerSharedGallery.tsx:149` — renders `mediaPreview(item.id)` unconditionally and displays the same photos correctly, which will read to a host as "my photos are gone from the private view."

**Fix:** stop gating on `previewAvailable` in the private mosaic and viewer, matching every other consumer (`EventPage.tsx:157,236`, `ManagerSharedGallery.tsx:149`, `Guestbook.tsx:335`). Handle a genuinely failed preview with the `<img> onError` path instead, and give that state real text — the reassurance is already true and already documented: delivered, included in the download, preview unavailable. Then fix the flag's meaning or delete it from the contract, because as named it is a trap.

**Suggested command:** `/impeccable harden`

### [P0] 2. Keyboard focus is invisible on every tile, and focused tiles scroll under the nav

**What:** `.gallery-mosaic__open` is `position: absolute; inset: 0` (`styles.css:883`) inside `.gallery-mosaic__item { overflow: hidden }` (`styles.css:880`), so its border box exactly equals the clipping box. The global ring is `outline: 2px solid var(--focus); outline-offset: 3px` (`styles.css:32`) — painted entirely outside the clip. Measured during real Tab traversal: `buttonRect {x:20,y:914,w:350,h:156}` identical to `itemRect`, `matchesFocusVisible true`, and no ring visible anywhere in the capture. The control case proves it: `.gallery-mosaic__favorite`, inset 8px, resolves the identical outline and *does* render a visible ring.

Compounding it: there is **zero** `scroll-margin` or `scroll-padding` in `src/styles.css`, while `.manager-nav` is `position: sticky; top: 0; z-index: 5`. Tabbing to the first tile scrolled it under the nav — tile half-hidden, favorite button fully covered.

And the viewer is not a real modal: `.gallery-viewer` is `rgb(43 29 23 / 96%)` (`styles.css:891`), so 4% of the page transmits. The committed baseline `manager-gallery-viewer-320-mobile-win32.png` visibly shows nav labels, "Search"/"Favorites", and tile captions bleeding through and colliding with the dialog's own text. No `inert` or `aria-hidden` is applied to background content — there is only a manual Tab trap (`GalleryViewer.tsx:66–80`).

**Why it matters:** a keyboard user tabbing the mosaic sees nothing across 96 tab stops per page. WCAG 2.4.7 and 2.4.11 fail outright, and PRODUCT.md targets WCAG 2.2 AA. It also silently defeats the careful focus restoration at `ManagerPrivateGallery.tsx:215–225`, which returns focus to exactly this element. `tests/e2e/accessibility.spec.ts` axe-scans the guest `.photo-grid` and fullscreen gallery but **never the manager private mosaic**, which is why this survived.

**Fix:** `.gallery-mosaic__open:focus-visible { outline-offset: -3px; }` — the identical trick this stylesheet already uses deliberately at line 782 — or promote the ring to the tile with `:has()`. Add `scroll-margin-top` matching the sticky nav height to `.gallery-mosaic__item` and the moment headings. Make the viewer's backdrop opaque and mark background content `inert` while it is open. Then add the manager mosaic to the axe spec so it cannot regress.

**Suggested command:** `/impeccable audit`

### [P0] 3. The wedding is delivered back-to-front, 48 photos at a time, with no way to jump

**What:** `worker/db/media.ts:438` is `ORDER BY timeline_at ASC, id ASC`. The cursor predicate is forward-only (`timeline_at > ?`), the wire cursor schema is `.strict()` with no direction field (`worker/http/gallery-cursor.ts:7–11`), and the route accepts only `query`, `favorites`, `limit`, `cursor` (`worker/routes/manage.ts:344–392`). `PRIVATE_GALLERY_PAGE_SIZE = 48`. The only navigation in the UI is the cursor button at `GalleryTimeline.tsx:41–48` — no sort, no reverse, no date jump, no back-to-top, no auto-load, and every loaded tile stays in the DOM.

**Why it matters:** a host opens this the morning after their wedding and the product shows them the oldest 48 photos — the empty venue, the parking lot, the test shot. The vows, the first dance, the sparkler exit are **104 presses** of "Load more photos" away at 5,000 photos, 208 at the supported 10,000 cap, with ~5,000 retained `<img>` elements and 10,000 buttons accumulating on a phone. Mobile Safari will run out of memory before they arrive. The photos the host most wants are the ones the product makes hardest to reach.

**Fix:** default the stream to newest-first with an explicit two-option order control; the keyset already supports the reverse, it needs a `DESC` branch and a mirrored comparator. Turn the moment headings into a jump index. Independently and immediately: add `content-visibility: auto` with `contain-intrinsic-size` matching `grid-auto-rows` to `.gallery-mosaic__item` so off-screen tiles stop costing layout.

**Suggested command:** `/impeccable shape`

### [P1] 4. The caption scrim is unreadable and eats the photograph

**What:** `.gallery-mosaic__meta` (`styles.css:887`) is always on: `padding: 26px 10px 8px`, `background: linear-gradient(transparent, rgb(43 29 23 / 72%))`, white text at `.82rem`/`.72rem`, no `text-shadow` fallback. Measured box is 68px tall with the `strong` line at +26px, so **the scrim alpha under it is only ≈0.37**. Pixel-measured over the project's own fixture photograph at 1280, **all 8 tiles fail the 4.5:1 floor on the `strong` line** (worst 3.62–4.09:1); the analytic worst case over a blown-out white region is **2.27:1**. Tile 1's caption sits directly on the bride's white dress. The loading state has the same defect: over `--denim-soft` the ratio is **2.75:1**.

Meanwhile the box is 68px on a `clamp(124px, 40vw, 180px)` row — **~59% of every 1×1 tile at 320px** — to restate a name the `img` `alt` and the button's `aria-label` already carry. Both type sizes (13.1px, 11.5px) also sit below the system's Label and Eyebrow floors, and the detector flags exactly those two lines.

**Why it matters:** for most photos that unreadable text is a camera filename. The host is judging their wedding through a ~136×53px window, and the thing occupying the rest is `IMG_4821.HEIC`.

**Fix:** remove the visible caption from 1×1 tiles entirely — the accessible name is already on the button, and the visual identity of a photo is the photo. Keep it only on the 2×2 hero tile, and where it stays, replace the gradient with a solid `rgb(43 29 23 / 78%)` band at 12px minimum type so contrast is a computed constant rather than a function of the photograph.

**Suggested command:** `/impeccable distill`

### [P1] 5. The export — the product's terminal act — freezes, and cannot be finished on a phone

**What:** `ManagerPage.tsx:487–506` contains the only two `setInterval`s in `src/`: intake every 5s (gated to `section === 'intake'`) and the guestbook summary every 15s (gated to `section === 'guestbook'`). **Neither touches `/api/manage/events/:id/exports`.** Export state has exactly one writer, `setExports` at line 369 inside `refresh()`. So after `prepareExport` does its single `await refresh()`, the card is frozen at "Preparing · 4,812 photos" and only advances when the host reloads the page — or incidentally, when some unrelated manager action reruns the full `refresh()` (a media filter change, a guest-name search, a bulk publish/hide, a retry). Switching manager sections does not refetch.

On success, `GalleryExportControl.tsx:84–86` prints up to 50 part links labeled only "Photo part 7 · 96 photos" — no byte size, no total, no downloaded marker, no visible countdown on the 24-hour expiry.

**Why it matters:** PRODUCT.md names retrieval as the end of the guest lifecycle. The host cannot distinguish "running" from "hung," and cannot plan a multi-gigabyte multi-part download from a phone. This is the last thing they will remember about the product.

**Fix:** poll the export while `queued`/`running`, on the same `document.visibilityState` guard intake already uses. Print each part's byte size and a running "3 of 12 collected" marker. When the total exceeds a phone-sensible threshold, say plainly that this is a desktop task — the product already knows the number.

**Suggested command:** `/impeccable harden`

## Persona Red Flags

**Alex (impatient power user, wants to star the keepers fast)**
- **No bulk favorite anywhere.** Favoriting 200 photos is 200 individual `PUT`s at one tap each. `MANAGER_BULK_SELECTION_MAX = 50` exists — but only for publish/hide in the *shared* mode, which cannot favorite.
- **No keyboard path in the grid.** Arrow keys are bound only inside `GalleryViewer` (`:56–65`). Moving from photo 1 to photo 2 in the mosaic is two Tab presses.
- **Favoriting in the viewer is a dead end.** Pressing Favorite moves focus nowhere; Alex must Shift+Tab back to Next. The obvious loop — look, star, next — costs three keystrokes per photo.
- **Search returns no count.** `ManagerGalleryWorkspace.tsx:64` keeps showing `event.storedMediaCount` while the timeline below shows a filtered subset. Alex cannot tell whether "Dana" matched 4 photos or 400.
- **Toggling Favorites throws away every loaded page.** `toggleFavorites` → `requestReplacement` resets `cursor` to null and replaces `rows`. Checking a favorite mid-review and toggling back costs 100 presses.

**Sam (screen reader / keyboard only)**
- **Focus is invisible on every tile** (P0-2), and focused tiles scroll under the sticky nav. This alone makes the surface unusable by keyboard.
- **Each tile announces the same string three times** — `img alt={title}`, the open button's `aria-label`, and the favorite's `aria-label` — plus a visible `<strong>`. At 48 tiles that is ~192 redundant utterances per page. With an 80-character filename that is an 85-character accessible name, repeated.
- **The broken-preview state tells Sam nothing at all.** `GalleryMoment.tsx:54` wraps an `aria-hidden` icon in an `aria-hidden` div with no text — and per P0-1 this is the state of *every* tile.
- **96 tab stops** between the top of a page and "Load more photos," with no skip link.
- **`aria-busy` is on the wrong scope** (`ManagerPrivateGallery.tsx:438`) — it wraps the search form, so Sam's input sits inside a busy region during every load.
- **The viewer trap can strand focus.** `GalleryViewer.tsx:67–69` queries tabbables without filtering `:disabled`. The wrap target is the Favorite button, so while a favorite request is in flight Shift+Tab from Close calls `preventDefault()` and then a no-op `focus()`.
- **The viewer is not `inert`-guarded**, and its 96% backdrop lets background text bleed into the dialog.

**Casey (distracted, one-handed, mobile)**
- **The favorite is in the worst corner.** `top: 8px; right: 8px` — the hardest one-handed thumb reach, and exactly where a right thumb brushes while scrolling. The rest of the tile is `.gallery-mosaic__open`, so a near-miss opens a full-screen modal.
- **The favorite button has no boundary against arbitrary photography.** `background: var(--paper)`, no border, no shadow. Over a white dress the circle is invisible (≈1.03:1); pressed, a Chestnut circle over a dark tuxedo is equally boundaryless. WCAG 1.4.11 fails in both directions.
- **Tapping the heart gives no felt confirmation** — no haptic, no animation; the success announcement is `sr-only`.
- **A failed favorite is silent.** `.manager-action-error` renders at the top of `.gallery-private` with no scroll-into-view and no focus move. Three hundred photos down, Casey sees the heart quietly revert and nothing else.
- **The viewer's prev/next sit on the photo** — 52×52 pinned at `top: 50%`, over the center of the image, unreachable one-handed at the left edge, and there is **no swipe gesture at all**. Horizontal swipe is the native expectation for a phone photo viewer.
- Touch targets themselves all pass: measured at 320/390/768/1280, nothing is under 44×44.

## Minor Observations

- **The flattest crop is at 760px:** the 2-column band still applies while `.manager-main` padding is still 20px, giving a wide tile of **720×180 = 4.00:1**. With `object-fit: cover` on a 4:3 source that keeps 33% of the frame.
- **The 1600px over-fetch is real, just not where the mosaic is.** `previews.ts` emits one derivative (`width:1600, height:1600, fit:'scale-down'`, WebP q82) and `mediaPreview()` returns a single parameterless URL. `EventPage.tsx:157,236`, the contributions list, `ManagerPage.tsx:731`, `ManagerSharedGallery.tsx:149`, and `Guestbook.tsx:335` all render it unconditionally with no `srcset`, no `sizes`, no `width`/`height` — under `Cache-Control: private, no-store` (`worker/routes/content.ts:186`), so it refetches on every render. A 76px guestbook thumb pulls the same bytes as the fullscreen viewer.
- **`ManagerGalleryMediaView` already carries `width` and `height`** and the mosaic uses neither — no intrinsic ratio for the browser, and no way to give portrait photos a taller span.
- **`--denim-soft` as the image placeholder** is both the coldest value in a warm-paper palette and semantically wrong — the token means "selected/pending," so every unloaded photo reads as *selected* in the system's own grammar. `#eee4d8` is already the placeholder one file over at `styles.css:249`.
- **The favorited tile is Chestnut** (`styles.css:885`) while the Favorites *filter* is Denim Soft + Denim border (`:870–874`). Per the Semantic Color Rule ("Denim selects"), the tile is the wrong one.
- **A moment has no ceiling.** `MOMENT_GAP_MINUTES = 45` with no upper bound means a continuous reception collapses into one moment whose "Show more photos" expands from 8 tiles to all of them at once — and `mosaicPlacement` returns a plain 1×1 past position 8, so the authored rhythm applies only to the first eight tiles.
- **One photo renders as a letterbox.** `mosaicPlacement(1, 2)` returns `{columnSpan: 2, rowSpan: 1}`, so a host's single photo is a ~272×128 center-crop. A portrait shot loses its subject.
- **`eager={index === 0}`** (`GalleryTimeline.tsx:35`) makes only the *first* moment's first four images eager, so after "Load more" the tiles the host just scrolled to are the ones that pop in.
- **`#e8dfd5`** (`styles.css:922`) is the one raw literal in any gallery selector — flagged by the detector and by the design review independently.
- **Empty-state inconsistency:** search has a `<Search>` icon, favorites and no-photos have none, so three states render at three different heights.
- **`.gallery-shared` reuses Live Intake's `.moderation-grid` DOM classes** and re-colors `:last-child` by name (`styles.css:841–857`). Adding a fourth action to Live Intake's card will silently restyle Gallery's.
- **Gallery mode is local `useState`** (`ManagerGalleryWorkspace.tsx:43`), so leaving Gallery and returning resets to Private and discards the shared-mode filter.

## Questions to Consider

1. **If moments are the one authored idea here, why can a moment hold 10,000 photos?** A continuous reception never gaps 45 minutes, so the whole evening collapses into one group. What if a moment had a hard ceiling — say 60 — so a six-hour reception produced six numbered moments with real time ranges, "Show more" was never an 800-item action, and the mosaic pattern applied to *every* moment instead of the first eight of one?
2. **The host opens this the morning after and the product shows them the emptiest photo of the night.** What if the timeline opened at the *end* and read backwards — or opened on the **densest** moment, which at a wedding is almost always the first dance?
3. **Favorites is the host's actual job, and it is currently a per-tile toggle behind a modal round trip.** What if the primary interaction were a two-up review mode — one large photo, keep/skip, arrow keys and swipe — so 500 photos is 500 keypresses in one place instead of 500 entries and exits from a lightbox?
4. **`stored` already means "privately delivered to the host," and export eligibility is orthogonal to previews.** So why does a photo without a preview show a silent grey glyph instead of the sentence that ends the fear — *"Delivered. Included in your download. Preview unavailable."*? What else on this surface is silent about a guarantee the system already makes?
5. **The scrim exists so a caption can sit on a photograph — but most photos have no caption, and the label is a camera filename.** What would the mosaic look like if the interface got off the photographs entirely: no scrim, no overlay button, no corner heart, the name living only in the viewer and the export manifest where it is actually used? Is the reason it can't that the *tile* has no other affordance — and is that the real problem?

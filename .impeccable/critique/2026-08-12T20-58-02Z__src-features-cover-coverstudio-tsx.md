---
target: Cover Studio + appearance canvas
total_score: 20
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-12T20-58-02Z
slug: src-features-cover-coverstudio-tsx
---
Method: dual-agent (A: design-review · B: detector-evidence)

# Event Cover Studio and Live Appearance Canvas — Design Critique

Target: `src/features/cover/CoverStudio.tsx` and the surrounding cover surface (`CoverSourcePicker`, `CoverStylePicker`, `CoverComposer`, `use-cover-studio-session`, `EventAppearanceEditor`, `EventAppearanceCanvas`, `ManagerCoverPreparationStatus`, and the `.cover-*` / `.event-appearance-*` rules in `src/styles.css`).

Mode: **Operate** — the host is completing a task. All ten heuristics apply.

Brief: `docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md`, marked implemented and deployed 2026-08-11. The six presets, five styles, four-step upload path, three-step preset path, and no-feature-flag decision are approved constraints and are not treated as defects. Findings against the brief are places the implementation fails the brief's own stated intent.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | A five-stage `onProgress` API exists at `cover-draft-client.ts:66` and **no caller in `src/` passes it**; a 19 MB cover upload shows one unquantified `role="status"` line with no percent and no cancel, while a guest's 20 MB upload gets real percent progress. |
| 2 | Match System / Real World | 3 | "Adjust focus" means sharpness to anyone who has held a camera; it changes framing. "Horizontal focus / Vertical focus" is engineering language for left–right / up–down. |
| 3 | User Control and Freedom | 3 | Genuinely strong: Escape, backdrop, Back, Cancel and hardware Back are one unified path with a `history.pushState` sentinel, inerted siblings, and focus restored to the opener. Undercut by "Reset to automatic" falling below the fold at 390×844 and `Remove cover` having no confirmation at all. |
| 4 | Consistency and Standards | 1 | The same "pick one of N tiles" control is built twice in one panel. `.event-theme-preset-selector__option input` (`styles.css:236`) resets to 20px with `accent-color: var(--chestnut)`; `.cover-source-picker` and `.cover-style-picker` have no reset, so their radios inherit the global `input` rule. |
| 5 | Error Prevention | 2 | In the discard `alertdialog`, "Keep editing" is `button--secondary` (quiet outline, first) and "Discard draft" is `button--primary` (filled Chestnut, second and lower). The loudest, most thumb-reachable control destroys the host's work. `Remove cover` goes straight to Done unconfirmed. |
| 6 | Recognition Rather Than Recall | 1 | On the preset path all five style thumbnails are permanently blank. `ensureEffectPreview` returns early when `draftRef.current` is null (`use-cover-studio-session.ts:257`), and a preset source never creates a draft — while 30 real preset/effect thumbnails already exist on disk. |
| 7 | Flexibility and Efficiency | 2 | Restyling an existing cover requires the full flow; there is no style-only entry from the cover card. Pointer drag — the gesture every phone user will try first — is inert until "Adjust focus" is pressed, while `cursor: grab` is applied (`styles.css:1151`). |
| 8 | Aesthetic and Minimalist Design | 2 | Six art-directed photographs are presented in `border-radius: 7px` with a 1px border — the same geometry as an input field — and the system's own photographic vocabulary (overlapping-print corners, restrained rotation, the Photographic Print shadow) goes unused on the one surface that exists to choose between photographs. |
| 9 | Error Recovery | 3 | Six distinct, honest async states each mapped to exactly one action. Undercut by `.cover-preparation--warning` using Danger text on Paper with a 35%-alpha border, where the system's failure treatment is Danger Soft `#fff1ee` with a Danger rule. |
| 10 | Help and Documentation | 1 | No instructional copy anywhere in the studio. Nothing says a composition was chosen automatically, that the photo can be dragged, or what happens after Done. The canvas has no caption identifying it as what guests see. The one explanatory sentence that does exist is **false**: "Cover changes apply immediately." (`EventAppearanceEditor.tsx:457`). |
| **Total** | | **20/40** | **Unfinished surface over unusually strong machinery** |

All ten heuristics apply on an Operate surface; none scored `n/a`.

The deficit is concentrated in shallow omissions — one missing radio reset, one early return, one empty pane, one stale sentence — sitting on top of a durable-operation and reconciler layer that would score well above this on its own.

## Design Specificity Verdict

**Voice authored, form borrowed.** Roughly 5/10.

**Design review (unanchored):** The sentences are unmistakably Candidary; the shapes are a generic wizard sheet. Authored: the live canvas carries the host's real event name, real date, and real welcome sentence, with two deliberately inert `aria-hidden` sample guest actions (`EventAppearanceCanvas.tsx:118`) — most products would render live buttons there and this one refuses. The async failure copy ("Your current cover is still live", "Still preparing. Your current cover is safe, and you can close this window.") could not be lifted from another product, because no generic editor has a non-destructive versioned publish to be honest about.

Interchangeable: the entire shell. Sticky header with Cancel plus "Step n of m", sticky preview, scrolling 2-up radio-tile grid, sticky right-aligned Back/Continue. Swap the tiles for shipping options and it is a checkout.

The sharpest missed opportunity is that `DESIGN.md` already owns the exact vocabulary this surface needs — overlapping square prints at 2–5px corners with restrained rotation, and the Photographic Print shadow — and reserves it "for photographic storytelling." Choosing the photograph at the emotional centre of a wedding is photographic storytelling, and the studio uses none of it. Six pieces of art direction render in input-field geometry. The upload affordance even loses the dashed border the system reserves for uploads (`.cover-field` on CreatePage is dashed at `styles.css:206`; `.cover-source-picker__upload` at `1137` is solid).

Second: `EVENT_COVER_PRESETS` (`shared/event-cover.ts:224`) carries only `{id, name}`, while `EVENT_THEME_PRESETS` carries a `description` its tiles render. The brief's own art direction — "Diffuse leaf shadow over tactile paper", "Amber organic grain without literal candles" — never reaches the host. In its place, **"Ready for every size" repeats six times.**

**Deterministic scan:** `detect.mjs --json` on the eight components returned **exit 0 and `[]`** — zero findings. **This is a coverage artifact, not a clean pass, and I confirmed that rather than reporting it as a pass.** The same engine on `src/styles.css` exits 2 with findings. The detector's `.tsx` path only sees Tailwind-style classes, kebab-case CSS, `.astro`/`.vue`/`.svelte` style blocks, and styled-components/emotion templates; its page-level analyzers exclude `.tsx` entirely. This project has none of those — all styling lives in one plain `src/styles.css`, and inline styles are camelCase React objects. Assessment B also proved it with a synthetic `.tsx` containing a purple gradient, `backdrop-filter`, 10px grey text and a 28px tap target: zero findings, while the same declarations in a `.css` file were detected. **The deterministic signal for this surface lives entirely in the stylesheet the scan is told not to target.**

Of 139 stylesheet findings repo-wide, 12 fall in cover-governing ranges: 11 `design-system-font-size` and one `side-tab`. The `side-tab` hit (`styles.css:287`) is a false positive twice over — it is Manager chrome, not a cover surface, and the warm one-pixel-border idiom is documented house style. The font-size hits are technically true but house-wide (103 instances repo-wide), so flagging them here would misattribute a convention; the extractable signal is that the cover surface alone uses seven distinct sub-1rem sizes plus 1.05/1.25/1.35/1.5rem.

**Visual overlays: none. No user-visible overlay exists and none is claimed.** The Manager route serves `content-security-policy: default-src 'self'; script-src 'self'` with no `'unsafe-inline'` and no nonce. `document.title` mutation succeeded, but both inline `<script>` append and cross-origin `<script src>` were blocked, measured in the live page. `live-server.mjs` was therefore never started, so there was nothing to stop. Injection is structurally impossible here without weakening the app's CSP — which is the correct trade.

Both assessments did reach the real surface by different routes: the design review through a static `vite preview` build with the repo's own `stubManagerRoutes` e2e fixtures (15 screenshots at 390×844, 320×568, 1000×900, spec deleted afterwards); the evidence pass through a real Worker with local D1 and R2 (`wrangler dev --assets dist/client` with ephemeral `--var` secrets; `.dev.vars` was not modified, mtime verified). Neither exercised the upload/compose path with a real photo through the Images binding, so composer geometry is from source rather than measurement.

## Overall Impression

This is a feature whose invisible half is excellent and whose visible half is unfinished. The durable operation controller, the reconciler, the six distinct honest failure states, the unified dismissal path, the keyboard and screen-reader work in the composer — that is senior work, reasoned about in inline comments, and better than most commercial async-publish flows.

Then the host opens it on a phone and sees "Upload / a / photo" wrapped over three lines beside a 196×48px hollow oval that fills in **browser-default blue**, and five identical blank squares where the styles should be.

The single biggest opportunity: this surface never says the one thing the architecture works hardest to guarantee. *Your current cover stays live until the new one is completely ready.* That sentence exists, and it is shown only after dispatch, or after 60 seconds of waiting, or on failure — never before the host commits, which is exactly when the fear exists. The brief's principle 2.6 is architecturally honoured and emotionally undelivered.

## What's Working

**The live canvas is the real thing, and its sample actions are inert by design.** `EventAppearanceCanvas` renders the host's actual name, date and welcome copy, and the "Add photos" / "View gallery" chips are `<span>`s inside an `aria-hidden` wrapper — no nested buttons, no tab stops, no implication that a guest workflow runs from Settings. Selecting a preset repaints it immediately through the real `presetCoverAssetPath` matrix, not a mock. It works because it converts an abstract choice into the host's own event in one frame, and because it resists the lazy version that would have created a fake affordance.

**The failure vocabulary is derived from what the server actually guarantees.** Retryable-failed, permanent-failed, conflict, access-lost-before-dispatch, access-lost-after-dispatch and slow are six *distinct* states, each stating the guarantee and each mapped to exactly one action. No spinner-forever, no optimistic lie, no dead end. This is what "truth comes from the system" looks like implemented.

**The composer's keyboard and assistive work is deliberate, not copied.** Arrow/PageUp/PageDown/Home/End on all three ranges, `aria-valuetext` in product language ("11 percent from left"), a 400ms settle timer so a range does not speak on every keystroke, an `interactedRef` guard so nothing announces on mount, and `touch-action: pan-y pinch-zoom` so browser pinch-zoom keeps working. Every one of these is commented with its reasoning.

## Priority Issues

### [P0] One missing radio reset breaks the feature's primary control at every width

**What.** `styles.css:195` applies `input, textarea { width: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 7px }` with no radio exclusion. Three selectors correct it elsewhere — `.event-theme-preset-selector__option input` (236), `.rsvp-attendance input` (551), `.guest-list-workspace input[type="radio"]` (817) — and **none covers the cover pickers.** Measured in the live authenticated page: upload radio **72.6×48px**, each of six preset radios **195.8×48px**, each of five style radios **108×48px**, all with computed `accentColor: auto`. Two consequences follow from the same cause: the radio becomes the largest and least informative element in every tile, and in the flex upload row `width: 100%` crushes "Upload a photo" to a **three-line wrap at 320, 390 and 720px**.

**Why it matters.** This is the entire selection surface of the feature, broken at every reference width. The checked state paints in the host's **OS accent colour** — so the selection indicator for eleven choices is unowned by the design system and varies by operating system, a flat violation of the Semantic Color Rule. The identical control 100px up the same panel is correctly 20px and Chestnut, so the host is taught one selection language and shown another.

**Fix.**
```css
.cover-source-picker input[type='radio'], .cover-style-picker input[type='radio'] {
  width: 20px; min-width: 20px; min-height: 20px;
  padding: 0; margin: 0; border: 0; background: none;
  accent-color: var(--denim);
}
.cover-source-picker__upload-choice { flex: 1; min-width: 0; }
.cover-source-picker__upload { border-style: dashed; }
```
Then move the radio inline with the tile name so the thumbnail is what the eye lands on first, and align the theme selector's selected ring to the same colour so "selected" means one thing in one panel.

**Suggested command:** `/impeccable polish`

### [P0] The canvas cannot compact, so narrow and zoomed viewports show no cover options

**What.** `.cover-studio__canvas` declares `min-height: 144px`, dropping to `96px` in `compact` and `short` modes (`styles.css:1109`, `1110`, `1124`) — but the inner `.event-appearance-canvas__guest` declares `min-height: 218px` (`1193`). The inner floor wins, so the canvas measures roughly 235px in every mode and the declared compaction never happens. With a two-row header (the `h2` takes `grid-column: 1 / -1`) plus footer, the 568px viewport is consumed. The design review verified zero presets visible at 320×568, and the committed `studio-zoom-200` baseline from the deploy date shows only the word "Cover". `readViewportMode` switches to `short` only at `height <= 420` and `compact` below 500, so the 421–499px visual-viewport band — exactly where a phone lands when the onscreen keyboard opens, and where 200% zoom lands on a laptop — is a functional dead zone.

**Why it matters.** `DESIGN.md`'s Narrow-First Rule requires the complete task to resolve at 320px, and the brief promises the canvas "may compact to 96 pixels" when the visible rectangle shortens. Neither holds. A host on a small phone or at 200% zoom cannot see a single one of the things they came to choose.

**Fix.** Scope the compaction to the guest frame rather than its wrapper: `.cover-studio__canvas .event-appearance-canvas__guest { min-height: 144px }`, with `96px` under `[data-viewport='compact']` and `[data-viewport='short']`. Collapse the header to one row (`grid-template-columns: auto 1fr auto`, title beside the counter) to recover roughly 32px, and raise the short-mode threshold from 420 to about 560 so the keyboard case is caught by layout rather than missed.

**Note on evidence:** the narrow-width findings rest on the design review's rendered screenshots and the committed baselines. The live-Worker pass measured desktop only (1243×1247), so the mobile numbers were not independently re-measured — the CSS mechanism above, however, I verified directly.

**Suggested command:** `/impeccable adapt`

### [P1] Five blank placeholders where thirty real thumbnails already exist on disk

**What.** `ensureEffectPreview` returns immediately when `draftRef.current` is null (`use-cover-studio-session.ts:257`), and the preset path never creates a draft, so all five `styleThumbnails` stay `{status:'idle'}` forever. `CoverStylePicker` renders `.cover-style-picker__placeholder` five times, and because `idle` matches neither the loading nor the error branch, it does so **silently** — no spinner, no "unavailable" text. Measured live: `data-thumbnail-state="idle"` ×5, `hasImg: false` ×5, still `idle` after changing effect. Meanwhile `public/assets/event-covers/v1/<preset>/<effect>/standard-default-1x.webp` exists for all 30 combinations, and `presetCoverAssetPath` is already imported into this component tree. The large canvas does swap correctly, so the effect is previewable at full size but not comparable in the chooser.

**Why it matters.** The brief's §6.3 states styles "are shown as real thumbnails." For the entire three-step preset path the host chooses among five subtle tonal treatments from two-word labels, comparing them *sequentially* against a scrimmed hero, on a phone. Sequential comparison of subtle tone is the single task a thumbnail strip exists to prevent. On a preset cover this does not read as subtle — it reads as broken.

**Fix.** Make `styleThumbnail` preset-aware in `EventAppearanceEditor`: when the source is a preset, return `{ status: 'ready', url: presetCoverAssetPath(1, presetId, effect, 'standard-default', '1x', 'webp') }`. Separately, give `idle` a visible state so a genuinely missing preview never renders as a silent blank square.

**Suggested command:** `/impeccable harden`

### [P1] The confirmation step is empty, and the safety guarantee arrives too late to reassure anyone

**What.** `step === 'done'` renders `<div className="cover-studio__done">` whose three children are all conditional — access failure, preparing, retryable-failed. In the normal case every successful host hits, the pane is **empty**: a heading, roughly 440px of nothing, and a filled "Done". Compounding it, the section description one screen away states **"Cover changes apply immediately."** (`EventAppearanceEditor.tsx:457`), which contradicts the asynchronous, non-destructive model in both the brief and `CLAUDE.md`. On success, "Your new cover is live." renders as `.cover-preparation` — `color: var(--muted)`, `.85rem`, in the same grey box as "Preparing cover 2 of 6" — while Moss Soft `#e8ecd8` and Completion Ink `#4e5b28` exist in this system for exactly this moment.

**Why it matters.** This is the peak-end moment of the feature and it carries zero state, zero receipt and zero reassurance. `PRODUCT.md` principle 4 puts exact receipts above optimistic copy; the State Before Ornament Rule requires every state to be legible as text. The host cannot see what they are about to publish, cannot see that guests are the audience, and is never told before committing that their current cover survives a failure. Then the cover of a wedding goes live and the interface whispers it in grey.

**Fix.** Fill the pane before dispatch with three lines: the choice ("Warm Linen · Film"), the audience ("Guests see this at the top of RSVP and photo delivery"), and the guarantee ("Your current cover stays live until the new one is completely ready — if anything fails, nothing changes"). Correct "apply immediately" to something true. On success, render the confirmation in Moss Soft with Completion Ink rather than the same grey used for "preparing".

**Suggested command:** `/impeccable clarify`

### [P1] Compose shows two disagreeing previews, and drag is inert exactly when it is discovered

**What.** The brief says three times that the studio shows "the same canvas, not a second preview." Compose shows two: the sticky scrimmed canvas at roughly 1.49:1, and `.cover-composer__surface` at `aspect-ratio: 620/265` ≈ 2.34:1, clean and unscrimmed, 20px below it. The one with correct framing is the one that scrolls away; the sticky one is the misleading one. And `onPointerDown` returns early while `focusMode !== 'manual'`, so on first arrival — the moment a phone user will try to drag the photo — dragging does nothing, with `cursor: grab` still declared and no feedback, while the brief lists drag as a first-class correction path. The three ranges show no numeric value at all (`aria-valuetext` only), and their escape hatch, "Reset to automatic", is below the fold at 390×844.

**Why it matters.** The host cannot tell which crop is the truth, so "Position the photo" positions it correctly for neither. Then the universal gesture for this exact task fails silently, pushing them onto sliders with no readable values.

**Fix.** Delete `.cover-composer__surface` and make the sticky canvas the drag surface, drawing the mandatory scrim at reduced opacity while composing so the host sees both real framing and real readability. Enable pointer drag in automatic mode and let the first drag promote `focusMode` to manual with the ranges revealed at their current values. Add a visible `<output>` beside each range, and pin "Reset to automatic" above the sliders or into the footer. Label the mode.

**Suggested command:** `/impeccable distill`

### [P2] The theme and colour controls sit roughly 600px above the canvas they change

**What.** DOM order in `EventAppearanceEditor` is theme selector, primary colour card, accent colour card, then the canvas. At 390px, checking "Midnight Film" leaves the canvas entirely offscreen; the host scrolls past two colour cards to see any effect. The canvas also has no visible caption identifying what it is.

**Why it matters.** This is precisely the failure the brief's §2.2 was written to prevent — "the host sees the result where they make the choice; there is no second preview farther down the page." The old separate preview was removed, but its replacement occupies the same position, so on the primary target device nothing changed. A host who does scroll to it finds an unlabelled brown rectangle between two colour fields.

**Fix.** Move the canvas above the theme selector, sticky within the section at narrow widths as it already is inside the studio, and give it one visible caption: "What guests see".

**Suggested command:** `/impeccable layout`

## Where the Two Assessments Disagreed

**Colour-alone state signalling.** The evidence pass found none; the design review flagged disabled controls as opacity-only. Both are right in their scope: *selection* state carries border colour plus a 2px ring plus the always-present text name plus the native checked indicator, so selection is well over-determined. *Disabled* state is `opacity: .48` (`styles.css:96`) and `.6` on the confirm buttons, with no reason text. **The design review's supporting claim is wrong, though, and I am not relaying it:** `DESIGN.md` does not forbid opacity-only disabled signalling, it *prescribes* it — "retain the control and label with reduced opacity; never communicate disabled state through color alone." Opacity is not colour. The legitimate residual issue is narrower and worth fixing: a greyed `Continue` never says *why* it is unavailable.

**Touch targets.** The evidence pass measured every cover control at or above the 44px floor — the one exception being the `sr-only` file input at 1×48px. The design review's complaint about right-aligned Back/Continue pills is a different rule: `DESIGN.md` calls for full-width primary controls at 320–390px, which is a narrow-width layout expectation rather than a touch-floor failure. Both stand, as separate findings.

**The detector's zero findings.** Not agreement between the two passes — an artifact. See the specificity verdict.

## Persona Red Flags

**Priya, 34, low vision, browses at 200% zoom and uses large text on her phone.** The committed `studio-zoom-200` baseline is her exact experience: header, canvas, footer, and the single word "Cover". Zero options. At 200% zoom the visual viewport lands near 450px — inside the 421–499px band where `compact` claims to shrink the canvas and cannot. If she reaches the sliders, the values exist **only** in `aria-valuetext`; there is no visible number, so she must infer the zoom she is setting from a 6px track. The only text distinguishing the five styles is `.cover-style-picker__note` at 12px, the smallest type in the studio, and on the preset path it is the *only* differentiator because the thumbnails are blank. Her focus ring lands on the 48px radio oval while the selection ring is drawn on the surrounding label — two indicators on two different boxes as she arrows through six presets.

**Marcus, 41, blind, TalkBack on Android — a journey `PRODUCT.md` requires be verified with TalkBack.** The canvas is a bare `<div>` with no role, no accessible name and no caption, so he hears loose text with nothing saying it is a preview of what guests see — and the sample actions are `aria-hidden`, so he receives no equivalent of the visual result at all. His six preset radios announce "Warm Linen Ready for every size", "Botanical Shadow Ready for every size" — half of every name is identical boilerplate, because the brief's art-direction descriptions were never carried into `EVENT_COVER_PRESETS`. The `idle` thumbnails announce nothing, so he gets no signal a preview is even missing. On "Save this cover" there is nothing to read. Two structural issues confirmed independently: the studio's `aria-label` stays "Cover Studio" while the visible `<h2>` changes per step (`aria-labelledby` is absent), and the hand-rolled focus trap queries only `button, input, [href], [tabindex]`, omitting `select`, `textarea` and `[role]`-based controls, and not filtering `[inert]` subtrees or hidden nodes — it currently yields 9 tab stops on step 1, one of them the invisible file input. Live regions are also all conditionally mounted, inserted already carrying text rather than existing empty and updating, which is the less reliably announced pattern; `AutosaveStatus` and `CoverComposer` do it the robust way in the same codebase.

**Dani, 29, at the venue 50 minutes before guests arrive, one hand, 12% battery, congested wifi.** She taps "Choose photo" — and cannot see her keyboard focus land, because the visible proxy is a `<label class="button">` (labels are not focusable) and nothing styles `input:focus-visible + label`; the codebase knows this technique and uses it for RSVP at `styles.css:544`. She picks a 14 MB shot and gets "Preparing your photo…" with no percent, no bytes and no cancel, indefinitely, while the five-stage progress vocabulary sits unused. If she gives up and hits Cancel, the filled Chestnut "Discard draft" sits at the bottom of the sheet under her thumb and the safe "Keep editing" is a quiet outline above it. She tries to drag the photo to centre her partner — nothing happens. She over-zooms and the way back is below the fold. She presses Done, gets an empty screen, the sheet vanishes, and a grey 13.6px sentence tells her it is live. The reconciler behind all this is excellent — if she backgrounds Safari it resumes correctly — and she will never know, because nothing tells her before she commits that she is safe.

## Minor Observations

- `styles.css:1092` comments "Cover Studio. Unwired in this release: nothing opens it." It has been wired since Phase 3 (`EventAppearanceEditor.tsx:564`, reached from `ManagerPage.tsx:927`) and was opened live during this review. A reader will trust the comment.
- `styles.css:1190`'s `prefers-reduced-motion` rule for `.cover-studio` is a verified no-op twice over: neither selector declares a transition, and line 363 already collapses all transitions globally. It is the fossil of intended motion — **the full-screen sheet appears with no transition at all**, which is off native expectation for a phone sheet.
- Dead CSS: `.cover-field--compact` (283) and `.event-appearance-editor__cover-actions` (281) match zero elements. The second matters, because its `.button { min-height: 44px }` is what would override `.cover-field .button { min-height: 40px }` (206) — the stylesheet's only sub-44px button rule. That correction is currently vestigial.
- Four duplicated visible labels on one surface: `<h3>Event appearance</h3>` beside `<legend>Event appearance</legend>`, "Primary color" heading beside "Primary color" field label, the same for Accent, and `<h2>Choose a cover</h2>` beside `<legend>Cover</legend>`. A systemic habit of adding the accessible name as visible text without removing the heading.
- `.cover-studio__header h2` is `1.35rem`, off the type scale (title is 1.6rem at −0.035em), while inheriting the global `−0.04em` from `h1,h2,h3`. At 21.6px that tracking is visibly too tight.
- `Remove cover` is a Chestnut `button--secondary`, identical in treatment to `Choose photo`. One adds, one destroys. The system reserves Danger outline for destructive intent.
- The scroll region has no fade or shadow at the footer boundary, so a clipped third preset row reads as the end of content.
- The Moss `Saved` autosave chip sits roughly 600px above a Cover card whose changes are *not* autosaved, inviting the reading that the cover is saved too.
- The preset thumbnails are unscrimmed while the canvas applies the mandatory contrast scrim, so the tiles advertise a difference the canvas flattens — under the scrim, Warm Linen, Pressed Paper and Candlelit Grain converge at 235px.
- `.cover-studio__error` carries `role="alert"` *and* `tabIndex={-1}` *and* programmatic focus; some screen readers will announce it twice.
- The style strip goes 5-across only at 561px, so at 390px it is 2×3 with square tiles — a roughly 600px strip inside a 330px window.
- Unrelated to design, but it will cost the next contributor an hour: `npm run dev` currently fails with a `@cloudflare/vite-plugin` internal error at `getWorkerEntryExportTypes`. `npm run build` plus `wrangler dev --assets dist/client` works.

## Questions to Consider

1. If the canvas is the truth, why does Compose need a second image at all? And if the composer surface is the truth, why is the canvas the thing that stays pinned while the accurate one scrolls away?
2. Why is a gallery of six art-directed photographs drawn in 7px input geometry, when this design system already owns the overlapping-print corners, the restrained rotation and the Photographic Print shadow — and reserves them for exactly this?
3. Should style come *before* source? Five treatments applied to the host's own photo is the emotional decision; six textures are the graceful fallback. The current order makes the fallback the front door.
4. The one sentence this product most wants a host to believe — *your current cover stays live until the new one is completely ready* — is only ever said after something has gone slowly or wrong. What happens to trust if it is said **before** Done instead?
5. What would this look like with no step counter at all: one sheet, canvas pinned, Choose / Compose / Style as sections you fall through, one terminal action? The step chrome costs roughly 150px of a 568px phone, and the path length is decided by a choice made inside step 1.
6. Six subtle textures viewed through a mandatory readability scrim converge. Should the tiles show the *scrimmed* truth — or should the scrim become part of the art direction rather than something applied over it?
7. Why does a guest's 20 MB upload get percent progress while the host's own 19 MB cover gets one unquantified line, when the five-stage vocabulary is already written and wired to nothing?

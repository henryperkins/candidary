# Candidary Core Design System

## Accepted concept references

- `.superpowers/brainstorm/1543-1784697424/content/camera-selection-flow-v3.html` — controlling guest photo-drop journey: add, review/send, terminal receipt.
- `design/concepts/public-create-desktop.png` — 1436 × 1103 public/create reference.
- `design/concepts/guest-desktop.png` and `design/concepts/guest-mobile.png` — visual-language references; their earlier gallery-first hierarchy is superseded by the controlling photo-drop journey.
- `design/concepts/manager-desktop.png` — visual-language reference; Live intake replaces moderation as the default manager workspace.

## Visual contract

Candidary is editorial and intimate rather than celebratory-software generic. True warm parchment is the page ground, chestnut anchors actions and typography, denim marks active/selected states, and moss communicates safe completion. Surfaces use thin warm-gray rules, restrained 8–12px radii, and almost-flat shadows.

### Tokens

| Role | Value |
| --- | --- |
| Parchment page | `#f7f1e7` |
| Paper surface | `#fffaf3` |
| Ink | `#2b1d17` |
| Muted ink | `#766c70` |
| Chestnut | `#4a2415` |
| Chestnut strong | `#31170c` |
| Denim | `#3f6d95` |
| Denim soft | `#dde7f0` |
| Moss | `#68763d` |
| Moss soft | `#e8ecd8` |
| Danger | `#b54033` |
| Border | `#d9cec2` |
| Focus | `#2c5c85` |

Spacing follows a 4px base with primary steps `8, 12, 16, 24, 32, 48, 64, 88`. Content max width is 1440px. The guest photo drop uses one open, calm primary canvas with a compact form surface only where selection needs structure. The guest RSVP uses the same canvas and the same card surface, so a household reaching the event before the day and a guest reaching it on the day are visibly the same product. The manager uses a 184px navigation rail carrying six destinations, an open Live intake workspace, and a 330px utility rail at wide widths; below 761px that rail becomes one horizontally scrollable row of the same six destinations, whose labels stay at the 14px control-text floor. That floor is unchanged and still binding: the row scrolls sideways rather than shrinking its type to fit.

## Event theme overlay

The global contract above remains binding for the landing page, create and account
surfaces, host event list, Manager navigation and workspace, browser/PWA chrome,
loading states, and pre-authentication error states. A resolved event may install
the registry below only on `.guest-shell--drop`, `.fullscreen`, and
`.event-appearance-preview`. The registry is fixed; request keys are never turned
into CSS properties, and CSS contains no preset conditionals such as
`[data-preset]`. Each declaration and use carries the Candidary Default fallback,
so a missing scope reproduces the compatibility appearance.

The event radii in this section are scoped exceptions to the global 8–12px shape
language. They do not change global, host, or PWA chrome.

### Fixed 45-property registry

| Resolved key | Allowed CSS property |
| --- | --- |
| `page` | `--event-page` |
| `surface` | `--event-surface` |
| `raisedSurface` | `--event-raised-surface` |
| `text` | `--event-text` |
| `pageText` | `--event-page-text` |
| `cardText` | `--event-card-text` |
| `mutedText` | `--event-muted-text` |
| `secondaryMutedText` | `--event-secondary-muted-text` |
| `quietText` | `--event-quiet-text` |
| `requiredText` | `--event-required-text` |
| `selectionSummaryText` | `--event-selection-summary-text` |
| `primary` | `--event-primary` |
| `primaryForeground` | `--event-primary-foreground` |
| `primaryHover` | `--event-primary-hover` |
| `primaryOnSurface` | `--event-primary-on-surface` |
| `primaryShadow` | `--event-primary-shadow` |
| `accent` | `--event-accent` |
| `accentForeground` | `--event-accent-foreground` |
| `accentSoft` | `--event-accent-soft` |
| `accentSoftForeground` | `--event-accent-soft-foreground` |
| `border` | `--event-border` |
| `sectionBorder` | `--event-section-border` |
| `rememberedNameBorder` | `--event-remembered-name-border` |
| `reviewDivider` | `--event-review-divider` |
| `inputBorder` | `--event-input-border` |
| `focus` | `--event-focus` |
| `mediaPlaceholderStart` | `--event-media-placeholder-start` |
| `mediaPlaceholderEnd` | `--event-media-placeholder-end` |
| `mediaPlaceholderForeground` | `--event-media-placeholder-foreground` |
| `heroStart` | `--event-hero-start` |
| `heroMid` | `--event-hero-mid` |
| `heroEnd` | `--event-hero-end` |
| `heroOverlayTop` | `--event-hero-overlay-top` |
| `heroOverlayBottom` | `--event-hero-overlay-bottom` |
| `coverOverlayTop` | `--event-cover-overlay-top` |
| `coverOverlayBottom` | `--event-cover-overlay-bottom` |
| `coverTextScrim` | `--event-cover-text-scrim` |
| `fullscreenBackdrop` | `--event-fullscreen-backdrop` |
| `fullscreenForeground` | `--event-fullscreen-foreground` |
| `inputShadow` | `--event-input-shadow` |
| `frameShadow` | `--event-frame-shadow` |
| `inputRadius` | `--event-input-radius` |
| `actionRadius` | `--event-action-radius` |
| `cardRadius` | `--event-card-radius` |
| `frameRadius` | `--event-frame-radius` |

`shared/event-theme.ts` owns the versioned values, and
`src/app/event-theme-style.ts` owns this exhaustive key-to-property adapter.
Version 1 has four stable presets in this order:

| Stable ID | Name | Page / surface | Text / muted | Primary / accent / focus | Input / action / card / frame radius | Exact no-cover gradient stops |
| --- | --- | --- | --- | --- | --- | --- |
| `candidary-default` | Candidary Default | `#f7f1e7` / `#fffaf3` | `#352924` / `#776e6a` | `#4a2415` / `#3f6d95` / `#2c5c85` | `11px` / `12px` / `10px` / `25px` | `#634134` → `#a06e5a` → `#d98b6a` |
| `garden-party` | Garden Party | `#f2f1e8` / `#fffcf5` | `#1f3028` / `#5b6b62` | `#245c46` / `#c36f42` / `#6f3e7c` | `14px` / `16px` / `16px` / `28px` | `#244d3e` → `#5f7a53` → `#c18a58` |
| `midnight-film` | Midnight Film | `#eef1f7` / `#fafbff` | `#192136` / `#5d667b` | `#263868` / `#b7693f` / `#7551a6` | `7px` / `8px` / `7px` / `14px` | `#1d294e` → `#4a3e68` → `#8b4e5a` |
| `coastal-light` | Coastal Light | `#edf7f5` / `#fffefa` | `#17343a` / `#526d72` | `#0c6370` / `#c85f50` / `#6c3c78` | `12px` / `14px` / `12px` / `20px` | `#0b5965` → `#4a8c91` → `#d27a62` |

Every no-cover hero uses
`linear-gradient(145deg, start 0%, mid 53%, end 100%)` plus its preset-owned
`180deg` overlay. Every preset continues to use only the bundled Manrope and DM
Sans faces and the fixed global spacing and workflow hierarchy.

### Configuration, persistence, and API boundary

The only persisted theme value is canonical `EventThemeConfigV1`:

```json
{"version":1,"presetId":"candidary-default","overrides":{}}
```

`version` is exactly `1`; `presetId` is one of the four IDs above; and the only
optional override keys are `primaryColor` and `accentColor`. Colors must be
exactly six hexadecimal digits after `#` and normalize to lowercase. Unknown
keys, shorthand or alpha hex, declarations, semicolons, `url()`, `var()`, HTML,
scripts, raw CSS, arbitrary properties, font names, URLs, assets, and external
resources are rejected rather than stripped.

Canonical serialization writes `version`, `presetId`, then `overrides`, with
`primaryColor` before `accentColor`; absent overrides and values equal to the
selected preset are omitted. Migration `0007_event_theme.sql` stores that JSON
only in the non-null, 512-character-limited `events.theme_config` column. The
resolver derives all 45 tokens at an event-view boundary; resolved tokens,
gradients, translucent colors, property names, fonts, and assets are never
stored.

`POST /api/events` accepts an optional strict `theme`; omission creates the
canonical Default. `GET /api/event/:slug` returns the guest allowlist plus the
resolved theme, while `GET /api/manage/events/:eventId` and the create,
cover-finalize, settings-update, and theme-update responses use the explicit
full event view. Host event lists omit themes and internal configuration.

`PUT /api/manage/events/:eventId/theme` accepts the configuration as its direct
body. It requires a matching manager link or owning account, the matching
write credential's Origin and CSRF pair, strict server normalization and
resolution, and a one-row update for the authorized event. Reset is the same PUT
with canonical Default; there is no DELETE theme or account-default route.
Malformed or unsupported stored data structurally falls back to Default, while
semantic stored failures fall back only when a view is resolved—not during
upload authentication.

### Non-overridable semantics and contrast

Primary overrides may change only `primary`, `primaryForeground`,
`primaryHover`, `primaryOnSurface`, and `primaryShadow`. Accent overrides may
change only `accent`, `accentForeground`, `accentSoft`, and
`accentSoftForeground`. Focus color remains preset-owned; focus geometry retains
its fixed indicator thickness and offset. Normal and control text must clear `4.5:1`.
Input boundaries, focus indicators, and actionable primary outlines must clear
`3:1` against every applicable page, surface, and raised surface.

An overridden `primary` and an overridden `accent` are both meaningful non-text
and must each clear `3:1` against every applicable page, surface, and raised
surface at the point the host chooses them. Primary fills the guest's own
actions, so a value clearing only `primaryForeground` yields a readable label on
a button that cannot be found; accent is drawn as a mark on those same grounds.
Both floors sit on the write and never on the read, so a color saved before a
floor existed keeps resolving for guests and is refused only when that host next
edits it. `fullscreenBackdrop` is outside both floors: the full-screen brand mark
is decorative chrome, and no one color clears `3:1` against both near-black and
the near-white event surfaces. `primaryHover` is derived to always differ from
`primary` while retaining the `4.5:1` label and `3:1` surface floors for every
write-eligible primary, so a chosen black or white action still answers the pointer.

Danger/failure red, delivered moss, state labels and glyphs, progress meaning,
retry behavior, spinner geometry and motion, disabled opacity, focus thickness
and offset, the full-screen caption's black gradient, typography, spacing,
control size, content order, and first-fold hierarchy are non-overridable.
Ordinary progress chrome may follow resolved primary without changing its
meaning; failure and delivery endpoints remain fixed.

The cover pipeline remains the only event image system, and it now has two halves
rather than one. A host's photo is ingested through an authenticated, bounded
Worker route instead of a presigned direct PUT, normalized into one private WebP
master, and materialized into a fixed set of layout renderings before it can
become the active cover. Beside it sits a finite library of built-in covers:
six art-directed choices, versioned and checksummed, shipped as immutable static
release assets under `/assets/event-covers/v{n}/`. Those are global artwork
containing no event data — they are not a second upload system, and no event-bound
route serves them.

Themes still use the successful private cover through `--event-cover`; no request
can provide a CSS URL. No-cover events use the preset gradient. Cover events use
preset-owned overlays and a localized `coverTextScrim`. `#fffaf3` is composited
under every cover transform as a fixed paper matte so a transparent PNG or WebP
cannot produce edges that differ between formats; it is server-owned and never
follows an event's colors. `surfaceTreatment` — currently `none` or
`film-grain-v1` — is resolved by the server from the published style and layered
at runtime. Neither is a forty-sixth `--event-*` property, and neither becomes a
`[data-*]` conditional.

The theme-overlay scope list above is unchanged: `EventAppearancePreview` remains
mounted, and the live appearance canvas that will replace it is not yet reachable.

The runtime layer order over a cover is fixed and is the same on the guest hero
and in Manager: image, surface treatment, contrast scrim, then content and
controls. None of the three overlays is ever baked into a rendered file, which is
why changing an event's theme re-paints instantly and renders nothing.

### Cover layout profiles

Six layout states, and a cover is rendered for exactly these. The registry owns
the state names, breakpoints, dimensions, and byte budgets; a request query
string, a user agent, or a phone model never selects among them — only a measured
container and hero state do.

| Profile | Layout state | 1x / 2x | WebP 1x / 2x | JPEG 1x / 2x |
| --- | --- | ---: | ---: | ---: |
| `short-lookup` | ≤360 wide and ≤600 high lookup hero | 360×168 / 720×336 | 60 / 120 KiB | 90 / 180 KiB |
| `compact-default` | ≤390 default hero | 390×205 / 780×410 | 70 / 140 KiB | 100 / 200 KiB |
| `standard-default` | 391–699 unframed default, capped at 620 | 620×218 / 1240×436 | 78 / 250 KiB | 120 / 360 KiB |
| `framed-default` | ≥700×760 viewport, 620 framed hero | 620×265 / 1240×530 | 140 / 300 KiB | 210 / 440 KiB |
| `compact-expanded` | ≤390 expanded-welcome hero | 390×420 / 780×840 | 130 / 280 KiB | 190 / 410 KiB |
| `wide-expanded` | 391–699 expanded welcome, capped at 620 | 620×420 / 1240×840 | 220 / 480 KiB | 330 / 700 KiB |

Every 1x profile is mandatory. A 2x profile is offered only when the chosen crop
can produce it without upscaling, so a smaller photo stays valid and simply looks
slightly softer on dense screens rather than being refused.

Legibility over a cover is a property of the layer arithmetic rather than of any
file: `tests/unit/cover-contrast.test.ts` composites all 720 preset, effect,
theme, and profile contexts and proves separately that the fixed scrim protects
an arbitrary uploaded photograph. Axe covers semantics and is not evidence for
text over an image.

### Typography

- Display: Manrope, 650–700; compact tracking `-0.045em`; responsive 40–72px.
- UI/body: DM Sans, 400–650; body 16–18px with 1.55 line height.
- Control text: 14–16px, 600; never browser-default.
- Captions/status: 12–14px with explicit line height and color.

### Components and states

- Buttons: filled chestnut primary, outlined chestnut secondary, quiet text tertiary, moss completion, danger hide/delete.
- Fields: 48px minimum height, parchment/paper fill, 1px border, 2px focus outline with 2px offset.
- Toggles: 44px hit area, moss on, warm gray off.
- Media: 8px radius, natural cover crop, denim selected/new treatment, and an explicit remove control before delivery.
- Status: textual state plus icon; never color alone. Upload states are selected, preparing, queued, sending, confirming, delivered, and needs attention. Publication states are unpublished, published, and hidden.
- Motion: 160–220ms for disclosure/selection; disable nonessential transforms under `prefers-reduced-motion`.

### RSVP states

RSVP is a themed guest surface and installs the same 45-property registry on
`.rsvp-flow`; the manager's guest list is global chrome and uses the global
tokens above. Every state below is narrow-first at 320px and carries 44px targets.

| Surface | State | Contract |
| --- | --- | --- |
| Guest lookup | first visit | Event name, date, deadline, one `Full name` field, the privacy sentence, and the complete `Find my invitation` action all inside the 320 × 568 first viewport. No roster suggestion, listbox, or autocomplete of invited names — `autoComplete="name"` is the browser's own memory, not ours. |
| Guest lookup | ambiguous | A second `Another full name` field receives focus. Nothing names, counts, or hints at a candidate household. |
| Guest lookup | refused | One generic sentence in the polite live region. It is identical for a miss, a paused event, an archived household, and an unresolved second name. |
| Guest household | editing | One `fieldset`/`legend` per person, native radios labelled `Attending` and `Not attending`, a conditional name field for an attending plus-one, live household counts, and one explicit `Submit RSVP`. Selection is carried by a thicker border as well as colour. |
| Guest household | incomplete | The first invalid row's radio takes focus and its inline error is its `aria-describedby`. |
| Guest household | conflict | The winning roster replaces the draft and a `tabIndex={-1}` review heading takes focus, so the respondent reads it from the top. |
| Guest receipt | saved | `You're all set`, the household's counts, one row per person with a textual attendance word and glyph, the closing date, and `Change RSVP` while the event is open. |
| Guest receipt | closed or paused | The same saved response with the reason stated and no write action. A deadline extension offers `Find my invitation again` instead. |
| Guest before-start | responded | The surface owns the page's single `<h1>`, the hero, when the event starts formatted from the event's own time zone, and the line saying photos open with it. The household's saved response is embedded beneath that, with its lookup and receipt headings at `<h2>` and no write action. The appreciation sentence is shown only for a household that actually answered. |
| Guest before-start | unrecognized or not responded | The read-only lookup searches only households with a saved response, so an invited name that never responded receives the identical uniform refusal a miss does; the window never becomes a roster-enumeration surface. A located household with no saved response is told so plainly and is neither thanked nor scolded. When access is unavailable the surface renders the event and its start with no RSVP affordance at all. |
| Guest waiting | photo delivery paused after start | The event hero still names the event and the paused sentences are the whole primary. No RSVP lookup, receipt, or disclosure mounts, because at and after the start RSVP has left the guest experience. |
| Manager RSVP | dashboard | Eight server-derived totals as labelled groups, a search field, a status filter, the CSV download, the household list, and stable `Load more households` paging. Totals are never recomputed in the browser from one page. |
| Manager RSVP | CSV issues | A labelled `CSV issues` region reporting row, field, and message as text. It is the only region on the page permitted its own scrollbar, and it never echoes the uploaded file. |
| Manager RSVP | household editor | The household's own heading is `tabIndex={-1}` so a refused write can return focus to it. Roster edit and response correction are separate forms with separate submits. |
| Manager RSVP | archive | A named confirmation group that states that lookup and signed-in guest devices stop while the export keeps the rows, and whose action stays disabled until the exact household name is typed. |
| Manager photo intake | scheduled / open-early / open / paused | The status and the one available action are chosen from the server-derived `photoIntakeState`, never from a comparison the browser makes against its own clock, and the page refetches across the start rather than switching itself. Before the start the only actions are opening photos early and returning to the schedule; a pre-start `paused` belongs to a legacy row or a disabled printed entry and is explained rather than offered an early reopen. |
| Manager Share | entry controls | `Sign out guest devices` and `Disable printed event QR` are separate actions with separate copy; each requires the exact event name. The disable copy states that every invitation and sign using the QR stops working and that it cannot be undone. After a disable there is no link, no QR, and no replacement action. |

### Guestbook states

Guestbook is a themed guest surface inside the existing event-theme scope. Its disclosure,
prompt, composer, private read-back, and shared feed use the resolved event semantic tokens; they do
not introduce Guestbook-specific colors, type, radii, or remote assets. The Manager destination,
filters, rows, errors, and moderation actions remain global Candidary chrome and never inherit event
tokens.

| Surface | State | Contract |
| --- | --- | --- |
| Guest, photos primary | available | `Guestbook` is the first secondary disclosure. It orders the 160-character host prompt and privacy explanation before the composer, then `Your private entries` and `Shared guestbook`. The note body is at most 500 characters; prompts, names, notes, captions, textareas, and entry metadata use `dir="auto"` and overflow wrapping. |
| Guest, sent-photo receipt | terminal | The receipt remains the delivery result and has exactly one follow-on action, `Leave a guestbook note`. It opens the existing disclosure, scrolls it into view, and focuses the composer heading with `preventScroll`; reduced motion uses an immediate, non-smooth scroll. |
| Guest contribution | sending and confirmed | Native controls preserve logical keyboard order. A confirmed item is inserted from the server response and a polite atomic live region announces the send; an ambiguous failure retains the body, signature choice, and idempotency key. Feed refresh never steals focus or scroll. |
| Manager | Guestbook from the day | The unresolved-count badge, visibility views, source filters, row-local actions/errors, and explicit refresh are lazy-loaded global chrome. A confirmed action focuses the updated or next meaningful row control with `preventScroll` and restores the scroll position captured immediately before applying that confirmed row update. |
| Export artifacts | printable and private | `guestbook.html` is a neutral, self-contained, semantic, high-contrast rendering of only the shared keepsake snapshot, with `article` and `dir="auto"` and no scripts, forms, analytics, remote fonts/styles/images, or network dependency. The complete non-deleted private archive is a separately named and labelled CSV; private rows never leak into the printable keepsake. |

Every visible Guestbook control is at least 44 by 44 CSS pixels and retains the established
`:focus-visible` indicator. Send and moderation results use polite atomic live regions, while reads,
polling, and background failures do not move focus or scroll. The layouts remain usable at 320 and
390 CSS pixels, 640 CSS pixels as the 1280-at-200%-zoom equivalent, and 320 CSS pixels as the
1280-at-400%-zoom equivalent, with no horizontal document overflow at the maximum prompt/body
lengths. Nonessential motion and smooth receipt-to-Guestbook scrolling are disabled under
`prefers-reduced-motion`.

### Icon inventory

Use Lucide outline icons at 1.75px: `Upload`, `Image`, `Expand`, `X`, `MessageCircle`, `Link`, `Copy`, `QrCode`, `Check`, `Ban`, `Trash2`, `Download`, `Settings`, `CalendarDays`, `ShieldCheck`, `ClipboardCheck`, `Search`, `Inbox`, `Eye`, `EyeOff`, `ChevronRight`, and `ChevronDown`. Icons remain secondary to text labels except familiar close controls. `ChevronDown` carries the open and closed state of the landing FAQ disclosures and is the one icon that rotates.

### Allowed above-the-fold copy

Public: `Candidary`, the eyebrow `Private event albums`, `Gather the moments you didn’t see.`, the approved supporting sentence, `Create your event`, `See how it works`, and the three capability labels (`No app, no account`, `Untouched originals`, `You choose what is shared`). The eyebrow is permitted because the headline states a feeling and nothing above it states the category; it is a `.section-label`, not a sentence, and it is the only line allowed to precede the headline.

The landing header carries three exits beside the brand: `How it works`, `Sign in`, and `Create an event` (shortened to `Create` below 761px, with the full name kept as the accessible name). `How it works` is wayfinding to an anchor that exists on the page, and it is the one exit that drops below 761px. `Sign in` holds its place at every width because a host returning on a phone reaches their events no other way.

The returning-host entry point is also allowed, worded exactly `Already have an account?` and `Sign in to your events`, followed by `New here?` and `Create one`. It is permitted because a host who already has an account otherwise reaches their events only from a manager card or a typed URL; it sits below the primary actions as one sentence, and it clears the fold at 320 x 568 but not at 360 x 640 or 390 x 844.

Guest: event name/date/welcome message, `Your name`, `Take a photo`, `Choose recent photos`, review/send state, and the terminal delivered receipt with its sole follow-on action `Leave a guestbook note`. Where a host’s welcome message runs past the hero clamp, the control that reveals the rest of it is also allowed, worded exactly `Read full welcome` and `Show less`. That single affordance is permitted because it belongs to the welcome message itself; no other disclosure control follows from it.

Guest RSVP: event name/date, the deadline sentence worded exactly `Please RSVP by <date>.`, `Find your household invitation`, `Full name`, the privacy sentence, and `Find my invitation`. On the household surface: the household label, `Your household RSVP`, each person's name, `Attending`, `Not attending`, the live counts, and `Submit RSVP`. On the receipt: `You're all set`, the counts, the roster, the closing date, and `Change RSVP`. Nothing here may name, count, or suggest anyone the household has not already been matched to.

Guest before-start: `The event hasn't started yet`, `{event name} begins {formatted date} at {formatted time}.`, and `Come back when the event begins to take or add photos.` Where a household is involved, also `We appreciate your RSVP. Your saved household response is below.` for one that answered, `Find your household to view a saved response.` for the lookup, and `There isn't a saved RSVP for this household.` for one located without a response. Dynamic date and time fragments follow the `en-US` display format used everywhere else and are always formatted with the event's own time zone, never the browser's. No other deadline, waiting, or gratitude sentence appears here. On the waiting surface the complete primary copy is `Photo delivery is paused` and `The host has paused photo delivery for now. Please try again later.`

Create receipt: the existing links plus `Set up guest list`. It is permitted because a new event starts with RSVP paused until the host has a validated roster — photo intake is permitted from creation and opens on the event's own schedule — so the guest list is the one thing the receipt would otherwise name no way to reach.

Manager: `Candidary`, event name/date, the event's start time and time zone, the server-derived photo intake state, capacity/lifecycle facts, the active section title, and the six destination labels `Intake`, `RSVP`, `Gallery`, `Guestbook`, `Share`, `Settings`. The RSVP destination's eight totals and the Gallery destination's three audience states — `Album` with `{n} photos`, `Album link` as `Live` or `Off`, and `Guest gallery` as `On, {n} published` or `Off, {n} published` — are labelled facts derived from the server, not marketing metrics; so are the counts the three Gallery mode segments carry, `Library` with the delivered total, `Album` with its photo count, and `Guest gallery` with its published count or `Off`. The audience states are permitted because Gallery is the only place two independent audiences — the people holding the Album link, and the event guests — become legible on arrival; without them each audience is discoverable only by opening its own mode and holding the other in memory, which the host-gallery review ranked as its first orientation finding.

Cover preparation is Manager copy below the Settings fold, so it sits outside
this list's above-the-fold reach — but it is recorded here because it is the one
place Candidary tells a host that something is happening to their event without
their having caused it just then. The complete permitted set is
`Preparing cover {n} of 6. Your current cover is still live.`,
`Still preparing. Your current cover is safe, and you can close this window.`,
and `Try again`. The progress fragment counts layouts in host terms and never
exposes the word `profile`; the count comes from durable progress and is never
guessed from elapsed time. Nothing here may add a percentage, an estimate, or a
spinner caption.

The corrected cover-field copy on both upload controls is
`Optional · JPEG, PNG, WebP, or HEIC · 19 MB max`. Its format list and ceiling
are read from the same server-owned constants the route enforces, so the two
cannot drift.

Cover Studio is live behind the Manager canvas's `Change cover` action. At 760 px
and below it is a bottom sheet; at 761 px and above it is a centered dialog. It is
one controlled, focus-trapped flow with the visible stages `Choose a cover`,
`Position the photo` (uploads only), `Choose a style`, and `Save this cover`.
Removal goes from Choose directly to Done; a preset skips Compose. Browser Back
moves within the flow before it asks to discard, and close/Back preserve an
already accepted publication. Compact visual-keyboard and 200%/400%-equivalent
layouts keep the current action and error reachable without moving Manager
chrome into the event theme.

The six preset names (`Warm Linen`, `Botanical Shadow`, `Pressed Paper`,
`Candlelit Grain`, `Coastal Haze`, `Midnight Wash`) and five style names
(`natural`, `warm`, `film`, `soft`, `monochrome`) are approved live product copy.
Uploads expose automatic focus, an explicit manual focus/zoom adjustment, Reset,
and real bounded effect previews. Presets and upload previews update the one live
`EventAppearanceCanvas`; there is no detached inert preview or second canvas.
The canvas layers event theme and cover intent only inside its guest simulation.
Its summary, `Change cover`, progress, retry, and all surrounding Manager controls
remain global Candidary semantics and colors.

The delivered hero measures its actual container before requesting an image and
chooses exactly one registered profile. Lookup at container width <=360 and
viewport height <=600 uses `short-lookup`; ordinary <=390 uses
`compact-default`, while 391 and above uses `standard-default`; expanded welcome
uses `compact-expanded` through 390 and `wide-expanded` from 391; the framed
default requires viewport width >=700 and height >=760. It advertises 2x only
when the server projection names that profile. Runtime layer order is image,
optional film grain, contrast scrim, then copy. A missing current image becomes
the existing event gradient, never a broken-image icon, legacy object, or master.

The three Gallery audience chips are the one carve-out from the rule that closes this section. They are the single labelled `Album` / `Album link` / `Guest gallery` group beneath the Gallery mode switch, they carry only the server-derived states named in the Manager entry above, and no other destination, mode, or surface may add a second set.

Apart from them and those entry points, no eyebrow, badge, pill, fake metric, pricing, account, or unrelated navigation copy may be added.

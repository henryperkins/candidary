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

Spacing follows a 4px base with primary steps `8, 12, 16, 24, 32, 48, 64, 88`. Content max width is 1440px. The guest photo drop uses one open, calm primary canvas with a compact form surface only where selection needs structure. The manager uses a 184px navigation rail, open Live intake workspace, and 330px utility rail at wide widths.

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

Danger/failure red, delivered moss, state labels and glyphs, progress meaning,
retry behavior, spinner geometry and motion, disabled opacity, focus thickness
and offset, the full-screen caption's black gradient, typography, spacing,
control size, content order, and first-fold hierarchy are non-overridable.
Ordinary progress chrome may follow resolved primary without changing its
meaning; failure and delivery endpoints remain fixed.

The existing private cover reservation, direct upload, inspection, storage, and
read pipeline remains the only event image system. Themes continue to use the
successful private cover through `--event-cover`; no request can provide a CSS
URL. No-cover events use the preset gradient. Cover events use preset-owned
overlays and a localized `coverTextScrim`. Manager preview reads the same private
object through `GET /api/manage/events/:eventId/cover`; it creates no second
upload, asset, or background-image system.

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

### Icon inventory

Use Lucide outline icons at 1.75px: `Upload`, `Image`, `Expand`, `X`, `MessageCircle`, `Link`, `Copy`, `QrCode`, `Check`, `Ban`, `Trash2`, `Download`, `Settings`, `CalendarDays`, `ShieldCheck`, and `ChevronRight`. Icons remain secondary to text labels except familiar close controls.

### Allowed above-the-fold copy

Public: `Candidary`, `Gather the moments you didn’t see.`, the approved supporting sentence, `Create your event`, `See how it works`, and the three workflow labels. The returning-host entry point is also allowed, worded exactly `Already have an account?` and `Sign in to your events`. It is permitted because a host who already has an account otherwise reaches their events only from a manager card or a typed URL; it sits below the primary actions, and it clears the fold at 320 x 568 but not at 360 x 640 or 390 x 844.

Guest: event name/date/welcome message, `Your name`, `Take a photo`, `Choose recent photos`, review/send state, and the terminal delivered receipt. Where a host’s welcome message runs past the hero clamp, the control that reveals the rest of it is also allowed, worded exactly `Read full welcome` and `Show less`. That single affordance is permitted because it belongs to the welcome message itself; no other disclosure control follows from it.

Manager: `Candidary`, event name/date, guest-upload state, capacity/lifecycle facts, and the active section title.

Apart from that entry point, no eyebrow, badge, pill, fake metric, pricing, account, or unrelated navigation copy may be added.

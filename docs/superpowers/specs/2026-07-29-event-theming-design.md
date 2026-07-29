# Candidary Per-Event Theming Design

**Date:** 2026-07-29

**Status:** Revised after code review; written specification awaiting approval

## 1. Decision

Candidary events receive a versioned, event-scoped visual theme. Hosts choose one
of four curated presets during event creation and may later refine that event with
optional primary and accent colors in Manager Settings.

The first release ships:

- **Candidary Default** (`candidary-default`) — the current guest appearance,
  with explicit cover-text and guest-form accessibility corrections;
- **Garden Party** (`garden-party`) — botanical evergreen, clay, and soft ivory;
- **Midnight Film** (`midnight-film`) — ink navy, copper, and cool paper; and
- **Coastal Light** (`coastal-light`) — deep teal, coral, and sea-glass neutrals.

Coastal Light is the preferred non-default direction and sets the quality bar for
the new presets. Candidary Default remains the compatibility anchor.

The event theme changes the guest-facing event experience only. Candidary's
landing page, account pages, event-creation shell, manager navigation, manager
workspace, and host event list remain globally branded. Manager Settings shows
the event theme only inside its appearance preview.

## 2. Goals

- Give each event a cohesive, recognizable appearance without slowing the guest
  photo-drop journey.
- Preserve the current guest composition, hierarchy, typography, palette, and
  behavior for existing events and for every event without explicit theme
  configuration, except for the documented contrast corrections.
- Keep event creation one step and keep theme choice below the essential fields.
- Let a host safely refine primary and accent colors without exposing raw CSS,
  arbitrary fonts, external assets, or page-builder controls.
- Apply one resolved semantic theme to every guest state rather than scattering
  preset checks through React components.
- Guarantee that text, controls, focus, cover overlays, danger, progress, and
  delivery semantics remain accessible for every accepted configuration.
- Keep theme ownership strictly per event.
- Preserve the existing cover-image upload, storage, and delivery pipeline.

## 3. Non-goals

- Account-wide or host-wide theme defaults.
- A sixth manager navigation destination.
- Arbitrary CSS, HTML, JavaScript, font URLs, image URLs, or external resources.
- Arbitrary brand kits, uploaded fonts, background-image systems, or page-builder
  layout controls.
- Host-overridable danger, failure, progress, focus, or successful-delivery
  semantics, including focus-ring geometry. Preset-owned focus colors remain
  allowed only after contrast verification.
- Changes to guest workflow steps, approved copy hierarchy, media behavior,
  privacy boundaries, or the terminal receipt.
- Changes to global Candidary branding.
- Deployment, production migration, or physical-device validation as part of
  implementation.

## 4. Product hierarchy

The approved private photo-drop hierarchy remains binding:

1. event identity and welcome;
2. one required guest name;
3. **Take a photo**;
4. **Choose recent photos**;
5. review and explicit Send;
6. progress, retry, or removal; and
7. a terminal delivered receipt.

Themes change paint and bounded corner treatment. They do not change spacing,
font metrics, control size, content order, first-fold copy, or interaction count.
Gallery, previous deliveries, and notes remain secondary.

## 5. Architecture

The feature has four boundaries:

1. A shared, pure theme module owns the versioned contract, presets, validation,
   canonical serialization, contrast calculations, and deterministic resolution.
2. D1 stores only the canonical configuration on the owning event.
3. Worker reads return both canonical configuration and server-resolved semantic
   tokens.
4. One client theme scope maps those tokens to a fixed CSS-variable allowlist for
   the guest shell, full-screen gallery, or manager preview.

Preset identifiers never appear in component branches or CSS selectors. React
components consume semantic tokens only.

## 6. Canonical shared contract

`shared/contracts.ts` defines the public types, while a new pure
`shared/event-theme.ts` module owns behavior.

```ts
export const EVENT_THEME_VERSION = 1 as const;

export type EventThemePresetId =
  | 'candidary-default'
  | 'garden-party'
  | 'midnight-film'
  | 'coastal-light';

export type HexColor = `#${string}`;
export type RgbaColor =
  `rgb(${number} ${number} ${number} / ${number}%)`;

export interface EventThemeOverridesV1 {
  primaryColor?: HexColor;
  accentColor?: HexColor;
}

export interface EventThemeConfigV1 {
  version: 1;
  presetId: EventThemePresetId;
  overrides: EventThemeOverridesV1;
}

export interface ResolvedEventTheme {
  config: EventThemeConfigV1;
  tokens: EventThemeTokens;
}

export interface EventView {
  id: string;
  slug: string;
  name: string;
  eventDate: string;
  welcomeMessage: string;
  coverObjectKey: string | null;
  uploadsEnabled: boolean;
  galleryVisible: boolean;
  moderationRequired: boolean;
  reservedMediaCount: number;
  storedMediaCount: number;
  reservedBytes: number;
  storedBytes: number;
  guestAccessExpiresAt: string;
  managementAccessExpiresAt: string;
  purgeAfter: string;
  createdAt: string;
  deletedAt: string | null;
  theme: ResolvedEventTheme;
}

export type GuestEventView = Pick<
  EventView,
  | 'id'
  | 'slug'
  | 'name'
  | 'eventDate'
  | 'welcomeMessage'
  | 'coverObjectKey'
  | 'uploadsEnabled'
  | 'galleryVisible'
  | 'moderationRequired'
  | 'theme'
>;
```

The canonical default is:

```json
{"version":1,"presetId":"candidary-default","overrides":{}}
```

Canonical serialization always writes keys in `version`, `presetId`,
`overrides` order. Override keys are written in `primaryColor`, `accentColor`
order and omitted when absent. Colors serialize as lowercase six-digit hex. An
override identical to the selected preset's base value is redundant and is
removed during normalization.

The version-1 preset definitions are compatibility contracts. Changing the
meaning of a saved version-1 preset requires a later theme schema version rather
than silently restyling existing events.

## 7. Strict parsing and normalization

Theme parsing is strict at every object level:

- `version` must be exactly `1`;
- `presetId` must be one of the four stable identifiers;
- `overrides` must be an object and is always present canonically;
- only `primaryColor` and `accentColor` are accepted inside `overrides`;
- colors must match `^#[0-9a-fA-F]{6}$`; and
- unknown fields are rejected rather than stripped.

This strictness is scoped to the theme contract. `theme` and
`theme.overrides` are strict inside `POST /api/events`; the existing top-level
create envelope retains its current Zod unknown-key behavior. Because the
`PUT` body is the configuration itself, its root and `overrides` are both
strict.

The format structurally rejects declarations, semicolons, `url()`, `var()`,
HTML, scripts, alpha channels, shorthand colors, font names, URLs, and external
resources.

Request parsing returns field paths such as `theme.presetId`,
`theme.overrides.primaryColor`, or `overrides.accentColor` for
`VALIDATION_FAILED` responses. The route error formatter joins the complete Zod
path with dots rather than truncating to `issue.path[0]`. For an
`unrecognized_keys` issue, it emits one entry per rejected key by appending that
key to the strict parent path: `evil` at the update root, `overrides.evil`,
`theme.evil`, or `theme.overrides.evil`. Existing top-level create-field keys
remain unchanged.

Stored handling has two fail-safe stages. The stored-config parser structurally
parses and normalizes the JSON; missing, malformed, or unsupported data becomes
the canonical Candidary Default without resolving presentation tokens. At an
event-view serialization boundary, the stored-theme resolver catches any
semantic resolution failure and returns the canonical default config and
tokens together. This keeps authentication-only requests out of contrast
resolution while preventing a structurally valid but semantically invalid
stored override from breaking event rendering.

New writes never use either fallback. Client input is strictly parsed,
normalized, and successfully resolved before persistence; invalid input is
rejected.

## 8. Semantic token model

The resolver returns fixed keys. It never returns client-supplied property names.

```ts
export interface EventThemeTokens {
  page: HexColor;
  surface: HexColor;
  raisedSurface: HexColor;
  text: HexColor;
  pageText: HexColor;
  cardText: HexColor;
  mutedText: HexColor;
  secondaryMutedText: HexColor;
  quietText: HexColor;
  requiredText: HexColor;
  selectionSummaryText: HexColor;
  primary: HexColor;
  primaryForeground: HexColor;
  primaryHover: HexColor;
  primaryOnSurface: HexColor;
  primaryShadow: RgbaColor;
  accent: HexColor;
  accentForeground: HexColor;
  accentSoft: HexColor;
  accentSoftForeground: HexColor;
  border: HexColor;
  sectionBorder: HexColor;
  rememberedNameBorder: HexColor;
  reviewDivider: HexColor;
  inputBorder: HexColor;
  focus: HexColor;
  mediaPlaceholderStart: HexColor;
  mediaPlaceholderEnd: HexColor;
  mediaPlaceholderForeground: HexColor;
  heroStart: HexColor;
  heroMid: HexColor;
  heroEnd: HexColor;
  heroOverlayTop: RgbaColor;
  heroOverlayBottom: RgbaColor;
  coverOverlayTop: RgbaColor;
  coverOverlayBottom: RgbaColor;
  coverTextScrim: RgbaColor;
  fullscreenBackdrop: HexColor;
  fullscreenForeground: HexColor;
  inputShadow: RgbaColor;
  frameShadow: RgbaColor;
  inputRadius: `${number}px`;
  actionRadius: `${number}px`;
  cardRadius: `${number}px`;
  frameRadius: `${number}px`;
}
```

Opaque resolved colors use normalized six-digit hex. Translucent overlay and
shadow values use the exact allowlisted `rgb(R G B / A%)` grammar and are owned
or derived by the resolver; request data can never populate them directly. Unit
tests validate every preset token before it can be returned.

The CSS constructs gradients from individual allowlisted color tokens.
Persisted configuration never contains gradients, translucent colors, or any
other CSS.

### Fixed global state semantics

The following semantics remain outside host control:

- danger and failed-state red;
- delivered-state moss/green;
- pending, progress, retry, and delivered labels and glyph choices;
- spinner shape and motion, progress-track geometry, and retry behavior;
- focus-ring thickness and offset;
- disabled opacity;
- full-screen caption's black readability gradient; and
- fixed neutral media-removal/readability overlays and their low-alpha shadows.

Progress meaning is fixed, but its ordinary chrome follows the event. Text
buttons, the New badge, active send treatment, selection spinner foreground, and
native progress fill use resolved `primary`, `primaryForeground`, or
`primaryOnSurface` as appropriate. Failure text and borders stay danger red;
delivered checks and receipt treatment stay moss/green. A host can recolor the
progress chrome but cannot recolor either semantic endpoint or remove its label,
icon, or motion-independent text.

The host cannot make a failure look successful, make delivery look failed, or
remove a focus indicator.

## 9. Preset visual definitions

All presets use the already bundled Manrope display face and DM Sans body/UI
face. Version 1 has no typography field.

| Preset | Page / surface | Text / muted | Primary | Accent | Focus | Input / action / card / frame radius |
| --- | --- | --- | --- | --- | --- | --- |
| Candidary Default | `#f7f1e7` / `#fffaf3` | `#35242f` / `#776a70` | `#42103b` | `#f3a578` | `#8b3f79` | `11px` / `12px` / `10px` / `25px` |
| Garden Party | `#f2f1e8` / `#fffcf5` | `#1f3028` / `#5b6b62` | `#245c46` | `#c36f42` | `#6f3e7c` | `14px` / `16px` / `16px` / `28px` |
| Midnight Film | `#eef1f7` / `#fafbff` | `#192136` / `#5d667b` | `#263868` | `#b7693f` | `#7551a6` | `7px` / `8px` / `7px` / `14px` |
| Coastal Light | `#edf7f5` / `#fffefa` | `#17343a` / `#526d72` | `#0c6370` | `#c85f50` | `#6c3c78` | `12px` / `14px` / `12px` / `20px` |

No-cover hero directions are:

- Candidary Default: `#63345c` → `#9f5a6b` → `#d98b6a`;
- Garden Party: `#244d3e` → `#5f7a53` → `#c18a58`;
- Midnight Film: `#1d294e` → `#4a3e68` → `#8b4e5a`; and
- Coastal Light: `#0b5965` → `#4a8c91` → `#d27a62`.

All four use the existing
`linear-gradient(145deg, start 0%, mid 53%, end 100%)` geometry plus a
`180deg` top-to-bottom overlay. Geometry is part of version 1 rather than an
implementation detail.

Every preset includes explicit supporting neutral, border, overlay, placeholder,
and full-screen values. Those values are tested as part of the version-1 preset
registry.

### Default compatibility and explicit corrections

Candidary Default reproduces current computed guest values rather than merely
reusing the nearest global token, except where the requested contrast floor
requires a documented correction:

- guest page `#f7f1e7`;
- guest surface `#fffaf3`;
- raised controls and cards `#ffffff`;
- primary guest text `#35242f`;
- secondary-page and input ink `#2b1728`;
- review/card text `#4a3e45`;
- drop-muted text `#776a70`;
- secondary-muted text `#766c70`;
- receipt/quiet text `#665860`;
- required marker `#8b3150`;
- selection summary `#6f6168`;
- primary `#42103b` and hover `#2c0c2a`;
- selection border `#e3d8dc`;
- section border `#d9cec2`;
- remembered-name border `#dfd4d8`;
- review divider `#eadfe3`;
- input border darkened from `#b8aab1` to `#92848c`;
- placeholder gradient `#e9ddd5` → `#cbb5bf`;
- placeholder icon `#806575`;
- hero gradient `#63345c` → `#9f5a6b` → `#d98b6a`;
- no-cover overlay `rgb(31 9 28 / 8%)` →
  `rgb(31 9 28 / 52%)`;
- cover overlay `rgb(31 9 28 / 5%)` →
  `rgb(31 9 28 / 62%)`;
- primary-action shadow `rgb(66 16 59 / 13%)`;
- input inset shadow `rgb(43 23 40 / 4%)`;
- desktop frame shadow `rgb(54 30 46 / 13%)`;
- input, action, card, and desktop frame radii of `11px`, `12px`, `10px`, and
  `25px`; and
- full-screen backdrop `#170a15`.

The input change is necessary because `#b8aab1` measures about `2.23:1` against
the white raised surface and less against the guest surfaces, below the
project's `3:1` meaningful-control-boundary floor. `#92848c` measures about
`3.56:1` against raised white, `3.43:1` against the surface, and `3.17:1`
against the darker page. It affects only screenshots containing the empty name
input; those exact baselines are called out for deliberate review.

### Complete version-1 registry

The following table is the complete version-1 resolved registry before
overrides. These constants, including supporting colors and geometry, are the
saved-preset compatibility contract.

| Token | Candidary Default | Garden Party | Midnight Film | Coastal Light |
| --- | --- | --- | --- | --- |
| `page` | `#f7f1e7` | `#f2f1e8` | `#eef1f7` | `#edf7f5` |
| `surface` | `#fffaf3` | `#fffcf5` | `#fafbff` | `#fffefa` |
| `raisedSurface` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` |
| `text` | `#35242f` | `#1f3028` | `#192136` | `#17343a` |
| `pageText` | `#2b1728` | `#17271f` | `#11182c` | `#0d2a30` |
| `cardText` | `#4a3e45` | `#2b3e34` | `#283047` | `#24464b` |
| `mutedText` | `#776a70` | `#5b6b62` | `#5d667b` | `#526d72` |
| `secondaryMutedText` | `#766c70` | `#53675d` | `#566177` | `#4b686d` |
| `quietText` | `#665860` | `#4d6258` | `#4f5a70` | `#456267` |
| `requiredText` | `#8b3150` | `#8a4036` | `#8b3f5b` | `#913c46` |
| `selectionSummaryText` | `#6f6168` | `#53675d` | `#566177` | `#4b686d` |
| `primary` | `#42103b` | `#245c46` | `#263868` | `#0c6370` |
| `primaryForeground` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` |
| `primaryHover` | `#2c0c2a` | `#194b38` | `#1d2b55` | `#08505a` |
| `primaryOnSurface` | `#42103b` | `#245c46` | `#263868` | `#0c6370` |
| `primaryShadow` | `rgb(66 16 59 / 13%)` | `rgb(36 92 70 / 13%)` | `rgb(38 56 104 / 13%)` | `rgb(12 99 112 / 13%)` |
| `accent` | `#f3a578` | `#c36f42` | `#b7693f` | `#c85f50` |
| `accentForeground` | `#42103b` | `#111111` | `#111111` | `#111111` |
| `accentSoft` | `#f9ddc4` | `#f8ebe0` | `#f2e9e8` | `#f8ebe6` |
| `accentSoftForeground` | `#42103b` | `#1f3028` | `#192136` | `#17343a` |
| `border` | `#e3d8dc` | `#d7d9ca` | `#d5d9e4` | `#cfe2df` |
| `sectionBorder` | `#d9cec2` | `#cbd1c2` | `#c6ccdb` | `#bdd7d4` |
| `rememberedNameBorder` | `#dfd4d8` | `#d3d8ce` | `#d4d9e5` | `#c9dfdc` |
| `reviewDivider` | `#eadfe3` | `#e1e2d7` | `#e1e4ed` | `#dcebe8` |
| `inputBorder` | `#92848c` | `#788b80` | `#7c879f` | `#748f92` |
| `focus` | `#8b3f79` | `#6f3e7c` | `#7551a6` | `#6c3c78` |
| `mediaPlaceholderStart` | `#e9ddd5` | `#dde1d2` | `#dce1eb` | `#dcecea` |
| `mediaPlaceholderEnd` | `#cbb5bf` | `#b9c6b5` | `#b8c0d1` | `#adcfcf` |
| `mediaPlaceholderForeground` | `#806575` | `#526d5c` | `#59657f` | `#48777b` |
| `heroStart` | `#63345c` | `#244d3e` | `#1d294e` | `#0b5965` |
| `heroMid` | `#9f5a6b` | `#5f7a53` | `#4a3e68` | `#4a8c91` |
| `heroEnd` | `#d98b6a` | `#c18a58` | `#8b4e5a` | `#d27a62` |
| `heroOverlayTop` | `rgb(31 9 28 / 8%)` | `rgb(14 34 27 / 10%)` | `rgb(9 16 37 / 8%)` | `rgb(5 31 35 / 14%)` |
| `heroOverlayBottom` | `rgb(31 9 28 / 52%)` | `rgb(14 34 27 / 54%)` | `rgb(9 16 37 / 52%)` | `rgb(5 31 35 / 54%)` |
| `coverOverlayTop` | `rgb(31 9 28 / 5%)` | `rgb(14 34 27 / 8%)` | `rgb(9 16 37 / 6%)` | `rgb(5 31 35 / 8%)` |
| `coverOverlayBottom` | `rgb(31 9 28 / 62%)` | `rgb(14 34 27 / 64%)` | `rgb(9 16 37 / 62%)` | `rgb(5 31 35 / 64%)` |
| `coverTextScrim` | `rgb(31 9 28 / 64%)` | `rgb(14 34 27 / 64%)` | `rgb(9 16 37 / 64%)` | `rgb(5 31 35 / 64%)` |
| `fullscreenBackdrop` | `#170a15` | `#10231b` | `#0b1020` | `#071d21` |
| `fullscreenForeground` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` |
| `inputShadow` | `rgb(43 23 40 / 4%)` | `rgb(23 39 31 / 4%)` | `rgb(17 24 44 / 4%)` | `rgb(13 42 48 / 4%)` |
| `frameShadow` | `rgb(54 30 46 / 13%)` | `rgb(31 48 40 / 13%)` | `rgb(25 33 54 / 13%)` | `rgb(23 52 58 / 13%)` |
| `inputRadius` | `11px` | `14px` | `7px` | `12px` |
| `actionRadius` | `12px` | `16px` | `8px` | `14px` |
| `cardRadius` | `10px` | `16px` | `7px` | `12px` |
| `frameRadius` | `25px` | `28px` | `14px` | `20px` |

The default's page, surface, text, action, hero-gradient, existing overlay,
media, full-screen, and radius values remain current. The following scoped
accessibility corrections are explicit:

- `inputBorder` becomes `#92848c` to clear `3:1` against every event surface;
- guest form placeholders use measured `mutedText` instead of the browser
  default or the inherited dark-band `#c6b7c3`;
- the open Notes feed uses `sectionBorder` instead of the inherited
  `rgb(255 255 255 / 18%)`; and
- `coverTextScrim` appears behind copy only when a cover image is present to
  guarantee contrast over arbitrary uploads.

None of the existing default screenshot fixtures contains a cover, so the scrim
does not alter them. The new default-cover baseline reviews it. The input-border
change intentionally updates only the existing name-entry baselines identified
in the visual-evidence section.

## 10. Contrast resolution

The resolver uses WCAG relative luminance and contrast calculations.

- Normal text and control text require at least `4.5:1`.
- Focus indicators and meaningful non-text control boundaries require at least
  `3:1` against the adjacent surface.
- Large text does not receive a lower threshold; the resolver uses `4.5:1`
  consistently.

The `3:1` boundary rule binds:

- `inputBorder` against `raisedSurface`, `surface`, and `page`, because the same
  token identifies name and Notes text-entry controls on each background;
- `focus` against those three surfaces; and
- actionable primary outlines through `primaryOnSurface`.

`border`, `sectionBorder`, `rememberedNameBorder`, and `reviewDivider` are
decorative grouping lines rather than the sole indicator of a control or state,
so they are not required to reach `3:1`. Selection, failure, and delivery cards
carry text/icon status in addition to their border. The aria-hidden media
placeholder icon is likewise decorative. Tests encode this distinction instead
of applying one threshold to every line in the palette.

An override changes only its matching semantic family:

- primary changes `primary`, `primaryForeground`, `primaryHover`, and
  `primaryOnSurface`, plus its derived `primaryShadow`;
- accent changes `accent`, `accentForeground`, `accentSoft`, and
  `accentSoftForeground`; and
- page, surface, text, borders, focus, hero, overlays, placeholders, full-screen
  treatment, and shape continue to come from the selected preset.

Preset registries author their normal hover, on-surface, and soft-accent tokens
explicitly. The derivation below applies only when the matching override is
present.

For custom primary only:

1. retain the normalized host color, compare `#ffffff` and `#111111`, choose the
   higher-contrast foreground, and reject the field if neither clears `4.5:1`;
2. derive hover by blending the fill 10% toward black when the chosen foreground
   is white, or 10% toward white when it is `#111111`, so hover contrast cannot
   decrease;
3. use the host color as `primaryOnSurface` only when it clears `4.5:1` against
   page, surface, and raised surface;
4. otherwise blend it toward the preset text color in 5% steps until the
   minimum of those three comparisons clears `4.5:1`;
5. fall back to the preset text token only if no earlier step clears the
   threshold; and
6. emit `primaryShadow` from the resolved primary RGB channels at 13% alpha.

For custom accent:

1. retain the normalized host color as `accent`;
2. keep the preset `accentForeground` when it still clears `4.5:1` against that
   fill, otherwise choose the higher-contrast of `#ffffff` and `#111111`, and
   reject the field if neither passes;
3. preserve continuity with the authored preset soft color by resolving each
   `accentSoft` channel as
   `presetSoft + 0.12 * (customAccent - presetAccent)`, rounded and clamped;
4. keep the preset `accentSoftForeground` when it clears `4.5:1` against the
   derived soft color, otherwise choose the highest-contrast passing candidate
   from preset text, `#111111`, and `#ffffff`; and
5. reject the override if the soft treatment still has no passing foreground.

The anchored soft-color formula means Candidary Default remains exactly
`#f9ddc4` at its authored `#f3a578` accent and changes continuously for nearby
overrides. A direct 12% accent-over-surface blend is deliberately not used; it
would jump the default to `#fef0e4`.

Accent is used as a filled control, a soft surface, or decoration with a derived
foreground. Raw `accent` is never used directly for on-surface text or an
outline, so version 1 has no `accentOnSurface` token. Accent is not the sole
indication of selection, failure, progress, or focus.

All blends operate channel-by-channel on encoded sRGB byte values. For source
channel `s`, target channel `t`, and target weight `w`, the result is
`Math.round(s * (1 - w) + t * w)`, clamped to `0..255`, then serialized as
lowercase two-digit hex. WCAG luminance calculations linearize the resulting
sRGB value using the standard formula.

Preset focus colors are not overridden. Each is pre-verified at `3:1` or better
against its page, surface, and raised surfaces.

Cover overlays are preset-owned and non-overridable. The existing full-frame
gradient remains. In addition, cover hero copy sits on a tightly bounded,
padded `coverTextScrim` using the preset's card radius. A 64% dark scrim keeps
white copy above `4.5:1` even when the underlying pixel is pure white; a black
pixel only increases contrast. Tests verify pure white, pure black, and
high-frequency cover fixtures across the actual rendered text bounds. This
localized cover-only scrim is the explicit accessibility exception documented
in the registry; the no-cover hero treatment itself remains pixel-identical.

No-cover gradients are fixed preset assets. Chromium verification uses the
documented 145°/53% geometry at 390 × 205, 390 × 420, and 620 × 265 and requires
every background pixel—not only the current padded copy region—to give white at
least `4.5:1`. Coastal Light's top overlay is therefore 14%, not the initially
explored 9%; its measured whole-hero minimum rises from about `4.30:1` to
`4.65:1`. Browser tests also render short and maximum-length event/welcome copy.
If any preset or future overlay cannot satisfy these contracts, it is invalid.

## 11. Persistence

Migration `0007_event_theme.sql` adds one column:

```sql
ALTER TABLE events
ADD COLUMN theme_config TEXT NOT NULL
DEFAULT '{"version":1,"presetId":"candidary-default","overrides":{}}'
CHECK (
  length(theme_config) <= 512
  AND json_valid(theme_config)
  AND json_type(theme_config) = 'object'
);
```

Existing events receive the exact default through the schema default. New event
creation explicitly binds the canonical serialized configuration so its
transaction commits the event, theme, links, session, and optional account
ownership together.

The `events` row is the smallest safe persistence boundary because theme data:

- is tiny;
- belongs to exactly one event;
- is always loaded with that event;
- is replaced atomically; and
- does not need independent lifecycle, querying, or ownership.

A one-to-one `event_themes` table is rejected. It would add joins, an extra
creation statement, UPSERT behavior, backfill work, and missing-row semantics
without improving event isolation or evolution.

Only canonical configuration is stored. Resolved tokens are derived and never
persisted.

## 12. Repository and Worker mapping

`EventRow` gains `theme_config`. `EventRecord` gains normalized internal
`themeConfig: EventThemeConfigV1`.

`mapEvent()` performs only the fail-safe structural stored-config parsing and
normalization described in section 7. It does not calculate contrast or
presentation tokens, because `mapEvent()` runs during authentication for upload
reservation, upload finalization, account checks, and other requests that never
return event paint.

A shared `resolvedThemeView(themeConfig)` helper returns only
`{ config, tokens }`. It uses the fail-safe stored-theme resolver, which returns
the canonical default config and tokens together if semantic resolution of
stored data fails.

A shared full `EventView` contract explicitly enumerates the event fields that
already cross create and manager JSON boundaries plus `theme`; it never contains
`themeConfig`. Its mapper enumerates those fields rather than spreading an
`EventRecord`. The existing guest route keeps its narrower explicit field
allowlist and appends `theme: resolvedThemeView(auth.event.themeConfig)`, so it
does not expose manager-only counters, byte totals, lifecycle dates, or deletion
state.

These two mappers cover:

- the create response;
- guest event read;
- manager event read;
- cover-finalize response;
- settings-update response; and
- theme-update response.

Host event-list mapping keeps selecting its current fields and omits both the
internal configuration and resolved theme. Neither raw JSON nor internal
`themeConfig` crosses an API boundary.

`CreateEventRecord` and `CreateEventInput` gain a canonical theme. The event
creation service serializes it before building the existing D1 batch.

`EventsRepository.updateTheme()` performs one bound update:

```sql
UPDATE events
SET theme_config = ?
WHERE id = ? AND deleted_at IS NULL
```

`updateTheme()` requires `(result.meta.changes ?? 0) === 1`; otherwise it throws
`Event theme was not updated.` This matches `updateSettings()` and `setCover()`
and protects repository callers plus deletion races. Only after a confirmed
update does it reread and return the freshly mapped event.

## 13. API contract

All JSON responses retain the existing `{ data, requestId }` envelope. A
successful cover read is binary and retains the private, no-store object
response headers instead; only its errors use the normal JSON error envelope.

### Create event

`POST /api/events`

```json
{
  "name": "Maya & Theo",
  "eventDate": "2026-09-19",
  "welcomeMessage": "We would love to see the day through your eyes.",
  "theme": {
    "version": 1,
    "presetId": "coastal-light",
    "overrides": {}
  }
}
```

`theme` is optional. Omission means the canonical default. The configuration and
its `overrides` reject unknown fields; unrelated unknown keys at the create
envelope's root retain the route's existing strip behavior.

The existing `201` response retains its links, CSRF token, account result, and
event. `event.theme` contains canonical config and server-resolved tokens.

### Guest event read

`GET /api/event/:slug`

The existing authenticated event view gains:

```json
{
  "theme": {
    "config": {
      "version": 1,
      "presetId": "coastal-light",
      "overrides": {}
    },
    "tokens": {
      "page": "#edf7f5",
      "surface": "#fffefa",
      "primary": "#0c6370",
      "primaryForeground": "#ffffff"
    }
  }
}
```

The abbreviated token object above illustrates the wire shape; the actual
`200` response includes every `EventThemeTokens` field.

### Manager event read

`GET /api/manage/events/:eventId`

The mapped `200` manager event includes the same `theme` object. Host event-list
responses continue selecting their existing fields and do not apply or expose a
theme to host chrome.

### Manager cover read

`GET /api/manage/events/:eventId/cover`

The appearance preview cannot assume the account-authenticated host also has an
event-link cookie. This read route calls `requireManager(context)`, loads
`auth.event.coverObjectKey` from the already-authorized event, and returns the
same private, no-store R2 object and response headers as the guest cover route.
It accepts either the owning-account or matching manager-link credential,
requires no CSRF because it is read-only, returns the existing stable missing
cover/object errors, and never accepts an object key from the client.

This is a second authorized read path to the same cover object, not a second
upload, storage, or background-image system.

### Replace event theme

`PUT /api/manage/events/:eventId/theme`

The request body is the configuration itself:

```json
{
  "version": 1,
  "presetId": "coastal-light",
  "overrides": {
    "primaryColor": "#125f6b",
    "accentColor": "#bd5f52"
  }
}
```

The route:

- calls `requireManager(context, { write: true })`;
- honors either an owning account or the event's manager-link session;
- validates the matching account or event CSRF pair selected by
  `requireManager`;
- compares authorization against the path event;
- rejects unknown and malicious values;
- normalizes and resolves on the server;
- writes only canonical serialized config; and
- returns `200 { data: { event }, requestId }`.

Reset uses this same endpoint with the canonical default. No `DELETE` theme route
or account-default route exists.

## 14. Creation experience

The create form remains one step.

Order:

1. Event name.
2. Event date.
3. Welcome message.
4. Lightweight **Event theme** preset selector.
5. Existing optional cover photo.
6. Existing Create action and privacy note.

The selector contains four radio choices. Each choice includes:

- the textual preset name;
- a short personality description;
- a small palette/hero treatment preview;
- a visible selected state; and
- a native accessible radio state.

Candidary Default is initially selected. Creation exposes no custom colors,
font controls, corner controls, or hero controls.

The selector must not add a second screen or disturb field-error focus order.
The create visual baseline changes intentionally because the approved selector
is now part of the form.

## 15. Manager Event appearance editor

Settings remains one of exactly five manager destinations. Inside Settings,
**Event appearance** is a separate form between general event settings and the
account/danger sections.

The editor contains:

- the four preset choices;
- a labelled primary-color well and six-digit hex text field;
- a labelled accent-color well and six-digit hex text field;
- **Use preset primary** and **Use preset accent** controls that remove an
  override;
- an inert representative preview;
- an unsaved-changes status;
- **Save appearance**; and
- **Reset to Candidary default**.

The representative preview shows:

- current event name and date;
- current welcome message;
- the correct cover or no-cover hero treatment, loading a saved cover through
  the manager-authorized cover-read route;
- a body/helper-text sample;
- a primary action;
- a secondary action;
- surface and border treatment; and
- the current corner treatment.

The preview does not render `GuestUploadFlow`. It has no local-storage access,
file inputs, upload transport, duplicate document headings, or live guest
actions.

### Draft and save behavior

- `savedTheme` is the last server-confirmed theme.
- `draftTheme` drives only the controls and preview.
- Preset or color changes update `draftTheme` locally. The browser may invoke
  the same pure resolver for this inert preview, but it submits configuration
  only; the Worker independently reparses and resolves every Save.
- Choosing a different preset clears both draft overrides so the named preset
  initially appears exactly as advertised. The host may then add new overrides.
- A syntactically invalid or contrast-invalid color keeps the previous valid
  preview and shows an inline field error.
- Save is disabled when there is no valid change or while a save is active.
- Reset replaces the local draft with canonical Candidary Default and clears
  overrides. It does not write.
- Successful Save replaces both saved and draft state with the server-normalized
  response.
- Failed Save preserves the draft and preview, reports the error, and allows the
  host to retry.
- Guest rendering continues using the previously saved theme until Save
  succeeds.

Manager chrome never inherits preview variables.

## 16. Guest theme scope

A helper maps each resolved token to one fixed custom-property name, for example:

- `--event-page`;
- `--event-surface`;
- `--event-raised-surface`;
- `--event-text`;
- `--event-page-text`;
- `--event-muted-text`;
- `--event-required-text`;
- `--event-primary`;
- `--event-primary-foreground`;
- `--event-accent`;
- `--event-border`;
- `--event-focus`;
- `--event-input-radius`;
- `--event-action-radius`;
- `--event-card-radius`;
- `--event-frame-radius`; and
- the allowlisted hero, cover-overlay, cover-text-scrim, and full-screen
  variables.

The key-to-property registry is statically exhaustive with
``satisfies Record<keyof EventThemeTokens, `--event-${string}`>``. The helper
never iterates arbitrary request keys into styles, and a unit test asserts that
its output contains every token key and no unregistered custom property.

The scope wraps:

- `.guest-shell--drop`;
- the independent `.fullscreen` route; and
- the manager preview wrapper.

There is one repository stylesheet, `src/styles.css`, shared by landing,
creation, guest, account, and manager UI. Implementation does not rewrite its
global declarations. It adds event-scoped aliases or overrides only below
`.guest-shell--drop`, `.fullscreen`, and the preview wrapper.

The scoped audit includes both the dedicated wedding-drop block and shared rules
the guest views consume:

- `.brand` and its mark, including full-screen chrome;
- `.text-link`, `.text-button`, `.button`, and `.button--primary`;
- `.section-label`;
- nested `input` and `textarea`, including explicit accessible placeholders;
- `.photo-grid`, `.empty-state`, `.contributions`, and guest footer;
- `.status--pending`, while success and failure status colors stay fixed;
- `.note-form` and `.notes-feed`; and
- the photo-drop, review, receipt, secondary, and full-screen selectors.

Within that scope, the six previously orphaned roles map explicitly:

- required marker → `requiredText`;
- remembered-name outline → decorative `rememberedNameBorder`;
- review rule → decorative `reviewDivider`;
- placeholder icon → `mediaPlaceholderForeground`;
- selection summary → `selectionSummaryText`; and
- inherited secondary/form ink → `pageText`.

Notes text entry uses `raisedSurface`, `pageText`, `inputBorder`, and
`mutedText` placeholder text. Its feed divider uses `sectionBorder`, replacing
the light-on-dark divider inherited from the unrelated global notes band.
Pending chips use `accentSoft` and `accentSoftForeground`, always alongside
their textual status; delivered and failed chips retain fixed semantic colors.
Default token values preserve the review screenshot's three literals exactly.

CSS contains no selectors such as `[data-preset="coastal-light"]`. Shared class
names outside an event scope continue resolving the fixed global Candidary
tokens, so creation and manager chrome cannot inherit an event.

CSS defines Candidary Default fallbacks so direct component tests and a missing
theme scope remain compatible, while normal event rendering always supplies the
server-resolved values.

## 17. Guest-state coverage

The same scope applies to:

- initial event and photo-source view;
- cover and no-cover hero variants;
- first-time name entry;
- remembered-name treatment;
- review and selected-photo cards;
- validation failures;
- reserving, queued, sending, confirming, retry, and cancellation states;
- delivered media inside review;
- terminal receipt;
- secondary shared gallery;
- previous deliveries;
- notes;
- event footer; and
- full-screen gallery chrome and backdrop.

Fixed failure, progress, success, and caption-overlay semantics remain legible
inside every preset.

The loading and authorization-error surfaces shown before event data is
available remain globally branded because no authenticated event theme is yet
available.

## 18. Cover behavior

The existing cover pipeline remains the only event image system:

1. manager-authorized cover reservation;
2. browser-direct upload;
3. Worker finalization and image inspection;
4. event `cover_object_key`; and
5. `/api/event/:slug/cover` rendering.

Themes do not add a background URL or image field. The current `--event-cover`
mechanism remains, combined with preset-owned overlay variables.

Manager appearance preview uses `GET /api/manage/events/:eventId/cover` so both
account and link managers can read the same object without acquiring guest
credentials. It does not create, copy, transform, or persist another image.

No-cover events use the preset's bundled gradient. Cover events use the existing
image with a non-overridable readability overlay. Both variants preserve event
identity and the first-fold actions.

Adding a missing manager cover-edit control is not part of this feature. The
current creation failure copy that refers to adding a cover from Settings is a
pre-existing product gap and must not be solved by introducing a second image
system.

## 19. Accessibility and responsive contract

Every supported preset and accepted override must preserve:

- WCAG contrast requirements for normal text, control text, and focus;
- readable hero copy over no-cover gradients and representative light/dark
  cover images;
- textual names and native selection states for theme choices;
- 44 × 44 CSS-pixel targets;
- full keyboard operation;
- predictable focus after validation;
- `prefers-reduced-motion`;
- 200% zoom behavior;
- 320px reflow;
- 390px mobile layout;
- desktop layout;
- long welcome and long filename containment; and
- the approved first-fold hierarchy.

Theme shape tokens cannot reduce a control's hit area. Typography and spacing
remain fixed across presets.

The existing global muted color on parchment has very little contrast margin,
so Candidary Default preserves it exactly while new presets use larger measured
headroom.

## 20. Error and recovery behavior

- Unknown presets, versions, theme fields, or malformed colors return
  `VALIDATION_FAILED` with a useful field path.
- Missing Origin, wrong Origin, missing CSRF, wrong scoped CSRF, missing manager
  authorization, and cross-event writes retain existing stable authorization
  errors.
- A database refusal leaves the prior saved theme intact.
- A failed manager Save retains the local draft and current Settings position.
- A malformed stored value falls back to Candidary Default rather than denying
  event access.
- A cover-load failure retains the preset's no-cover hero as the safe visual
  fallback; it does not fetch another image.
- A guest never sees an optimistic theme change before the server confirms it.

## 21. Test strategy

Implementation is test-first.

### Unit tests

A new `tests/unit/event-theme.test.ts` covers:

- canonical default;
- all preset identifiers and token registries;
- exhaustive token-to-CSS-property mapping;
- strict parsing at every object level;
- color normalization;
- unknown fields;
- unsupported versions and presets;
- malicious declarations, `url()`, `var()`, HTML, and external resources;
- deterministic serialization;
- deterministic resolution;
- missing and malformed stored values;
- structurally valid but semantically invalid stored values;
- exact canonical Candidary Default tokens, including the documented
  corrections and every formerly orphaned literal;
- WCAG contrast calculations;
- `inputBorder` and focus against page, surface, and raised surface;
- explicit decorative-border exemptions;
- derived foregrounds;
- rejection when neither allowlisted foreground clears `4.5:1`;
- on-surface contrast adjustment;
- anchored `accentSoft` continuity at and around each preset accent;
- primary and frame shadow derivation/registry values;
- all-pixel no-cover hero contrast for the documented gradient geometry;
- representative dark, light, and mid-tone custom colors; and
- stable round trips.

### Worker tests

Worker coverage includes:

- migration `0007` applied after a populated `0006` database;
- legacy-event default appearance;
- new-row database default;
- preservation of event sessions, media, and host ownership;
- default creation;
- creation with a valid preset and overrides;
- an unrelated create-root key retaining current strip behavior;
- rejection of unknown keys at create `theme` and
  `theme.overrides`;
- rejection of unknown keys at the update-root configuration and its
  `overrides`;
- exact rejected-key paths for update-root, update-overrides, create-theme, and
  create-theme-overrides cases;
- complete dotted field-error paths;
- guest and manager read contracts;
- manager cover read by an owning account;
- manager cover read by a matching manager link;
- manager cover denial for missing, unrelated-account, and cross-event
  credentials;
- link-manager theme update;
- account-manager theme update;
- correct CSRF selection when both credentials exist;
- missing, wrong, and foreign-origin CSRF;
- manager authorization;
- cross-event update isolation;
- persistence and reread;
- default reset payload;
- unknown fields;
- malicious values;
- repository canonical serialization and fallback mapping;
- an authentication-only route proceeding without token resolution;
- semantically invalid stored config falling back only at an event-view
  response boundary;
- zero-change/deletion-race update guard; and
- omission of internal `themeConfig` plus resolved output on every event
  serialization path.

### UI tests

UI coverage includes:

- Candidary Default initially selected during creation;
- accessible preset selection and submitted payload;
- theme selection below essential fields without changing form-error focus order;
- manager preview responding locally;
- no API call before Save;
- primary and accent override editing;
- override removal;
- Reset remaining local;
- successful Save adopting server normalization;
- failed Save preserving draft and preview;
- event rendering installing only allowlisted variables;
- exact mapping for required text, remembered-name border, review divider,
  placeholder foreground, selection summary, and page/form ink;
- scoped shared-class theming without changing host chrome;
- accessible name and Notes placeholders plus Notes divider;
- primary-colored progress chrome with fixed failure/delivery semantics; and
- theme-independent upload failure, retry, and receipt meaning.

### Playwright

Playwright runs against `npm run build` plus Vite preview under the repository's
production-like CSP.

The responsive state matrix is explicit:

| Guest fixture | 320 × 568 | 390 × 844 | 1280 × 900 |
| --- | --- | --- | --- |
| no-cover hero and name/source entry | required | required | required |
| cover hero and name/source entry | required | required | required |
| 500-character welcome, expanded and collapsed | required | required | required |
| review with long filenames | required | required | required |
| active progress and retry/failure | required | required | required |
| terminal receipt | required | required | required |
| gallery, deliveries, and notes expanded | required | required | required |
| full-screen gallery with long caption | required | required | required |

Fixtures rotate across all four presets, with Candidary Default and Coastal
Light each represented in every row at least once across the three viewports.
Garden Party and Midnight Film each cover both a primary-journey state and a
secondary/full-screen state. Separate parameterized accessibility tests exercise
all four presets on the same representative page.

The suite also includes:

- all four curated presets;
- representative custom dark, light, and mid-tone colors;
- keyboard operation;
- 44px targets;
- 200% zoom proxy;
- reduced motion;
- document-level horizontal containment; and
- Axe scans plus explicit computed text/control/focus contrast checks; and
- no-cover all-pixel hero contrast at the three documented geometries.

### Visual evidence

The following existing default guest baselines remain byte-for-byte unchanged:

- `guest-review-320-mobile-win32.png`;
- `guest-secondary-long-content-320-mobile-win32.png`; and
- `fullscreen-long-caption-320-mobile-win32.png`.

Two existing default baselines are deliberately regenerated and reviewed because
they contain the corrected empty name-input boundary and explicit placeholder:

- `guest-long-welcome-320-mobile-win32.png`; and
- `guest-landscape-844x390-mobile-win32.png`.

New reviewed baselines cover:

- Candidary Default with a cover and the localized accessibility scrim at
  390px;
- Candidary Default with the corrected Notes form and divider expanded at
  390px;
- Garden Party with a cover at 390px;
- Midnight Film review/progress at 320px;
- Coastal Light no-cover entry and receipt at 390px;
- a themed full-screen gallery at desktop; and
- the Manager Event appearance editor.

The create-form baseline changes intentionally to include the approved selector.
Existing manager navigation, Gallery, and Share baselines remain unchanged.

These tracked screenshots provide handoff evidence for all four presets. The
fidelity ledger names each accepted baseline and its tested state.

## 22. Documentation

`design/design-system.md` remains the global authority. It gains a section
stating:

- global Candidary tokens remain binding for public and host chrome;
- guest events may install only the documented semantic overlay;
- state semantics and accessibility floors are non-overridable; and
- external fonts, URLs, raw CSS, and additional image systems remain forbidden.

`design/fidelity-ledger.md` records:

- exact-default compatibility;
- each new preset baseline;
- Manager preview evidence;
- cover/no-cover evidence;
- accessibility and responsive results;
- custom-color extremes; and
- remaining physical-device validation.

## 23. Alternatives considered

### Curated presets only

Rejected as the final product direction. It is smallest and easiest to verify,
but does not let a host align an event with a known primary or accent color.

### Curated presets plus constrained overrides

Selected. It provides useful event identity while preserving a small,
strictly validated configuration and a bounded verification surface.

### Arbitrary brand kits or raw CSS

Rejected. It would introduce injection, accessibility, CSP, maintenance,
performance, and visual-regression risk; create external-resource questions;
and turn Settings into a page builder.

### One-to-one event-theme table

Rejected in favor of the versioned JSON column because the configuration has no
independent identity, query pattern, ownership, or lifecycle.

## 24. Implementation isolation

The feature is independent of the unmerged HSTS and iOS/PWA work.

The implementation branch is `codex/event-theming`, created in an isolated
worktree from refreshed `main` at
`051478a5e575e0849ac75bbef08a1850dbc2526a`.

The HSTS branch, its two local commits, the active iOS/PWA worktree, and
`CandidaryDesignSystem.zip` remain unrelated and untouched. Before implementation
or integration, the base and concurrent branches must be rechecked for drift and
overlap.

## 25. Acceptance criteria

- Existing and unconfigured events resolve to canonical Candidary Default.
- Four named, accessible presets are available, including the current Candidary
  composition with the documented contrast corrections.
- Creation includes a lightweight preset selector below essential fields with no
  extra step.
- Manager Settings contains Event appearance without adding a sixth destination.
- The editor previews hero, text, actions, surface, border, and shape treatment.
- Preview and Reset remain local until Save succeeds.
- Only primary and accent colors are host-overridable in version 1.
- The server strictly validates, normalizes, resolves, and persists canonical
  configuration.
- No raw CSS, arbitrary font, URL, or client-derived token is accepted.
- Theme changes remain isolated to one event.
- Every listed guest state and full-screen gallery receives the same scoped
  semantic theme.
- Global Candidary and manager chrome remain unchanged.
- Danger, failure, progress, focus, and successful-delivery semantics remain
  unmistakable and non-overridable.
- Cover events reuse the existing cover pipeline; no second background-image
  system exists.
- All curated presets and representative custom-color extremes meet the
  accessibility and responsive contract.
- New non-default baselines and the documented default corrections are
  reviewed; all other existing default guest baselines remain pixel-identical.
- Unit, Worker, UI, production-like Playwright, typecheck, lint, build, and
  `git diff --check` gates pass on the final implementation head.
- Handoff distinguishes local source verification from unperformed physical
  device, deployment, remote migration, push, PR, and production validation.

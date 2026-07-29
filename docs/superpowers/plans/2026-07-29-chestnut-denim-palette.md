# Chestnut/denim palette migration

**Decision (2026-07-29):** the aubergine/apricot palette is retired. The app adopts the
chestnut/denim palette specified by the `design_handoff_host_access` bundle (the CandidaryDesignSystem
project's `tokens/colors.css`), on the host's explicit direction — no purple anywhere in the product.
`design/design-system.md` is updated and remains the binding token source.

## Token swap

| Old token | Old value | New token | New value |
| --- | --- | --- | --- |
| `--ink` | `#2b1728` | `--ink` | `#2b1d17` |
| `--aubergine` | `#42103b` | `--chestnut` | `#4a2415` |
| `--aubergine-strong` | `#2c0c2a` | `--chestnut-strong` | `#31170c` |
| `--apricot` | `#f3a578` | `--denim` | `#3f6d95` |
| `--apricot-soft` | `#f9ddc4` | `--denim-soft` | `#dde7f0` |
| `--focus` | `#8b3f79` | `--focus` | `#2c5c85` |

Unchanged: `--paper #fffaf3`, `--muted #766c70` (the handoff pins it — it clears AA on parchment by
0.0046), `--moss #68763d`, `--moss-soft #e8ecd8`, `--danger #b54033`, `--border #d9cec2`, the
parchment ground `#f7f1e7`, and every radius, shadow geometry, spacing, and type value.

Role note: apricot's job ("marks active/selected states") transfers to denim wholesale — selected
media ring, meter fill, manager-rail active ground, pending pills, return-note marker, accent icons.
Denim is darker than apricot was, so every one of those accents gained non-text contrast (e.g. the
meter fill went from ~1.6:1 to ~4.1:1 against its track).

## Derived-literal rule

The guest photo-drop surfaces carried a plum-tinted neutral ramp (literals, not tokens). Each literal
was hue-rotated to the chestnut family (hue ≈ 17°) at **equal saturation and lightness**, so every
contrast ratio measured in `design/design-qa.md` and the fidelity ledger is preserved by construction.

| Old | New | | Old | New |
| --- | --- | --- | --- | --- |
| `#35242f` | `#352924` | | `#eadfe3` | `#eae2df` |
| `#8b3150` | `#8b4b31` | | `#e3d8dc` | `#e3dcd8` |
| `#b8aab1` | `#b8aeaa` | | `#cbb5bf` | `#cbbbb5` |
| `#dfd4d8` | `#dfd7d4` | | `#806575` | `#806d65` |
| `#776a70` | `#776e6a` | | `#4a3e45` | `#4a413e` |
| `#665860` | `#665c58` | | `#6f6168` | `#6f6561` |
| `#d5c8d2` | `#d9cec2` | | `#c6b7c3` | `#c7bcb8` |
| `#170a15` | `#170e0a` | | `#eee8eb` | `#eeeae8` |
| `#63345c` | `#634134` | | `#6e5d67` | `#6e625d` |
| `#9f5a6b` | `#a06e5a` | | `#32122f` (theme-color) | `#31170c` |

Tinted alpha colors (same alpha, warm base): `rgb(66 16 59 / *)` → `rgb(74 36 21 / *)`,
`rgb(31 9 28 / *)` → `rgb(31 15 9 / *)`, `rgb(43 23 40 / *)` → `rgb(43 29 23 / *)`,
`rgb(42 19 37 / *)` → `rgb(42 25 19 / *)`, `rgb(32 17 29 / *)` → `rgb(32 21 17 / *)`,
`rgb(30 13 27 / *)` → `rgb(30 18 13 / *)`, `rgb(54 30 46 / *)` → `rgb(54 37 30 / *)`,
`rgb(249 221 196 / 45%)` → `rgb(221 231 240 / 45%)`. The hero fallback gradient keeps its warm
`#d98b6a` end stop; only the two purple stops moved.

## Semantic exceptions (not a blind rename)

On the dark chestnut notes band, apricot was a *light* accent; denim is mid-dark and would measure
~2.5:1 there. Those four uses take `--denim-soft` instead (~10.8:1): `.notes-intro > svg`,
`.notes-intro .section-label`, `.notes-feed small`, and the `.note-form .button` ground (its label is
chestnut). `.manager-notice` moved from the apricot cream `#fff4e8` to the `--denim-soft` attention
ground, matching `.warning`. QR modules (`CreatePage`, `ManagerPage`) render chestnut on paper.

## Coordination: `codex/event-theming` (merges after this)

The theming branch replicates the old palette as data. Git will merge it cleanly and wrongly; apply
these on rebase/merge — nothing else in that branch touches color:

1. **Selector chrome** (`src/styles.css` additions): four `var(--aubergine)` references in
   `.event-theme-preset-selector` (legend color, `:has(input:checked)` border + box-shadow,
   `accent-color`) → `var(--chestnut)`. They are undefined after this migration, which fails silently.
2. **`shared/event-theme.ts` `candidary-default` preset** — remap with the tables above:
   `text #352924`, `pageText #2b1d17`, `cardText #4a413e`, `mutedText #776e6a`, `quietText #665c58`,
   `requiredText #8b4b31`, `selectionSummaryText #6f6561`, `primary #4a2415`, `primaryHover #31170c`,
   `primaryOnSurface #4a2415`, `primaryShadow rgb(74 36 21 / 13%)`, `accent #3f6d95`,
   `accentForeground #ffffff` (**polarity flip**: accent is now dark, so its foreground goes light —
   white on denim is 5.3:1), `accentSoft #dde7f0`, `accentSoftForeground #4a2415`,
   `border #e3dcd8`, `rememberedNameBorder #dfd7d4`, `reviewDivider #eae2df`,
   `inputBorder #928a84`, `focus #2c5c85`, `mediaPlaceholderEnd #cbbbb5`,
   `mediaPlaceholderForeground #806d65`, `heroStart #634134`, `heroMid #a06e5a`,
   overlays/scrim `rgb(31 9 28 / *)` → `rgb(31 15 9 / *)`, `fullscreenBackdrop #170e0a`,
   `inputShadow rgb(43 29 23 / 4%)`, `frameShadow rgb(54 37 30 / 13%)`. Unchanged: `page`,
   `surface`, `raisedSurface`, `secondaryMutedText`, `primaryForeground`, `sectionBorder`,
   `mediaPlaceholderStart`, `heroEnd`, `fullscreenForeground`, all radii. Description copy: "Warm
   berry and peach…" → e.g. "Warm chestnut and denim, matching the Candidary guest experience."
3. **`.event-appearance-preview` hex fallbacks** (same styles.css hunk): every fallback mirrors the
   `candidary-default` values — apply the same mapping.
4. The other presets (garden-party, midnight-film, coastal-light) are host-facing colorways and were
   left as designed; note their `focus` values are violet-family if the no-purple rule should extend
   to them.

## Verification

`npm run build`, `npm run test:unit`, `tests/e2e/visual-qa.spec.ts` baselines regenerated for the new
palette, and `tests/e2e/accessibility.spec.ts` (axe contrast) re-run — results recorded in the branch
history for `feat/chestnut-denim-palette`.

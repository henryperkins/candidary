---
name: Candidary
description: A quiet private-event ledger rendered in warm paper, precise type, and state-led color.
colors:
  parchment: '#f7f1e7'
  paper: '#fffaf3'
  field: '#fffdf8'
  ink: '#2b1d17'
  muted: '#766c70'
  chestnut: '#4a2415'
  chestnut-strong: '#31170c'
  denim: '#3f6d95'
  denim-soft: '#dde7f0'
  moss: '#68763d'
  moss-soft: '#e8ecd8'
  completion-ink: '#4e5b28'
  danger: '#b54033'
  danger-soft: '#fff1ee'
  border: '#d9cec2'
  focus: '#2c5c85'
  manager-ground: '#faf6ee'
  manager-rail: '#f2eadf'
  white: '#ffffff'
  candidary-default-hero-start: '#634134'
  candidary-default-hero-mid: '#a06e5a'
  candidary-default-hero-end: '#d98b6a'
  garden-party-page: '#f2f1e8'
  garden-party-primary: '#245c46'
  garden-party-accent: '#c36f42'
  midnight-film-page: '#eef1f7'
  midnight-film-primary: '#263868'
  midnight-film-accent: '#b7693f'
  coastal-light-page: '#edf7f5'
  coastal-light-primary: '#0c6370'
  coastal-light-accent: '#c85f50'
  danger-chip: '#fbe0dc'
typography:
  display:
    fontFamily: Manrope, sans-serif
    fontSize: clamp(2.75rem, 6.4vw, 5.6rem)
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: -0.04em
  headline:
    fontFamily: Manrope, sans-serif
    fontSize: clamp(2rem, 3.4vw, 3.5rem)
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: -0.04em
  title:
    fontFamily: Manrope, sans-serif
    fontSize: 1.6rem
    fontWeight: 700
    lineHeight: 1.04
    letterSpacing: -0.04em
  body:
    fontFamily: DM Sans, sans-serif
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: normal
  label:
    fontFamily: DM Sans, sans-serif
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: normal
  eyebrow:
    fontFamily: DM Sans, sans-serif
    fontSize: 0.76rem
    fontWeight: 600
    letterSpacing: 0.13em
  control:
    fontFamily: DM Sans, sans-serif
    fontSize: 1rem
    fontWeight: 600
  field:
    fontFamily: DM Sans, sans-serif
    fontSize: 1rem
  nav-label:
    fontFamily: DM Sans, sans-serif
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1
  status:
    fontFamily: DM Sans, sans-serif
    fontSize: 0.75rem
    fontWeight: 600
  credential:
    fontFamily: ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace
rounded:
  print: 2px
  compact: 5px
  field: 7px
  control: 8px
  panel: 10px
  card: 12px
  pill: 999px
  event-frame-default: 25px
  nav: 6px
spacing:
  base: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  3xl: 64px
  4xl: 88px
components:
  button-primary:
    backgroundColor: '{colors.chestnut}'
    textColor: '{colors.white}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: 12px 20px
    height: 48px
  button-primary-hover:
    backgroundColor: '{colors.chestnut-strong}'
    textColor: '{colors.white}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: 12px 20px
    height: 48px
  button-secondary:
    backgroundColor: transparent
    textColor: '{colors.chestnut}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: 12px 20px
    height: 48px
  button-approval:
    backgroundColor: '{colors.moss}'
    textColor: '{colors.white}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: 12px 20px
    height: 48px
  button-danger-outline:
    backgroundColor: transparent
    textColor: '{colors.danger}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: 12px 20px
    height: 48px
  input:
    backgroundColor: '{colors.field}'
    textColor: '{colors.ink}'
    typography: '{typography.field}'
    rounded: '{rounded.field}'
    padding: 12px 14px
    height: 48px
  paper-card:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.card}'
    padding: 40px
  status-success:
    backgroundColor: '{colors.moss-soft}'
    textColor: '{colors.completion-ink}'
    typography: '{typography.status}'
    rounded: '{rounded.pill}'
    padding: 6px 10px
  status-pending:
    backgroundColor: '{colors.denim-soft}'
    textColor: '{colors.chestnut}'
    typography: '{typography.status}'
    rounded: '{rounded.pill}'
    padding: 6px 10px
  manager-nav-active:
    backgroundColor: '{colors.denim-soft}'
    textColor: '{colors.chestnut}'
    typography: '{typography.nav-label}'
    rounded: '{rounded.nav}'
    padding: 10px
    height: 46px
  event-hero-default:
    backgroundColor: '{colors.candidary-default-hero-start}'
    textColor: '{colors.white}'
    padding: 26px 22px 24px
    height: 218px
  rsvp-person-card:
    backgroundColor: transparent
    rounded: '{rounded.panel}'
    padding: 15px 13px
  button-quiet:
    backgroundColor: transparent
    textColor: '{colors.chestnut}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: 12px 20px
    height: 48px
  button-danger:
    backgroundColor: '{colors.danger}'
    textColor: '{colors.paper}'
    typography: '{typography.control}'
    rounded: '{rounded.control}'
    padding: 12px 20px
    height: 48px
  status-rejected:
    backgroundColor: '{colors.danger-chip}'
    textColor: '{colors.danger}'
    typography: '{typography.status}'
    rounded: '{rounded.pill}'
    padding: 6px 10px
  landing-header:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    padding: 0 5vw
    height: 88px
  landing-header-mobile:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    padding: 0 20px
    height: 70px
  manager-nav-active-mobile:
    backgroundColor: '{colors.denim-soft}'
    textColor: '{colors.chestnut}'
    typography: '{typography.label}'
    rounded: '{rounded.nav}'
    padding: 10px 12px
    height: 48px
---

# Design System: Candidary

## Overview

**Creative North Star: "The Quiet Event Ledger"**

The Quiet Event Ledger treats each event as a private record being carefully kept. Warm paper, dark ink, and restrained accents make the product intimate enough for weddings and private gatherings, while its hierarchy remains operationally precise: every phase, credential, delivery, and recovery state should be understood without interpretation.

Photography carries the emotion; interface chrome carries the truth. Public surfaces may feel editorial and generous, Manager surfaces become structured and compact, and guest surfaces narrow to one calm task at a time. The system rejects generic wedding SaaS, gallery-first social feeds, cold enterprise dashboards, and glassy or translucent effects that weaken legibility.

**Key Characteristics:**

- Warm, opaque paper grounds with dark ink and thin rules.
- Chestnut for action, Denim for selection and active state, Moss for completion, and Danger red for refusal or loss.
- Manrope for compact editorial hierarchy; DM Sans for direct, readable operation.
- Mobile-first composition with visible labels and 44–48px controls.
- Flat-by-default surfaces with lift reserved for paper cards, event frames, and photographs.
- Globally branded chrome with a curated, scoped event-theme overlay.

Implementation reference: `src/styles.css`, the feature styles under `src/features/`, `shared/event-theme.ts`, and `src/app/event-theme-style.ts`. The incumbent identity remains defined in `design/design-system.md`; older concept images and snapshot fixtures supply visual context, while current source owns component and responsive measurements. Values below are extracted documentation, not a second runtime token registry.

## Colors

The global palette is warm, low-glare, and semantic. Parchment is the page ground; Paper lifts working surfaces by tone; Field gives inputs a quiet boundary; Ink and Muted carry the reading hierarchy.

### Primary

- **Chestnut**: the global action and brand color for primary controls, links, and the center stroke of the Candidary mark.
- **Chestnut Strong**: the deeper hover, browser-chrome, and installed-app anchor.

### Secondary

- **Denim**: selection, active state, informative emphasis, and the outer strokes of the brand mark.
- **Denim Soft**: selected navigation, pending states, quiet information bands, and circular feature markers.
- **Focus**: the fixed global keyboard-focus color. Event themes provide their own validated focus token without changing its geometry.

### Tertiary

- **Moss**: positive action and the strongest affirmative surface.
- **Moss Soft**: quiet completion, delivery, and approval backgrounds.
- **Completion Ink**: legible completion copy over Moss Soft.
- **Danger**: destructive actions, validation failures, refusal, and terminal error copy.
- **Danger Soft**: a contained failure or validation background.
- **Danger Chip**: the warmer rejected-status background; it remains distinct from a validation notice.

### Neutral

- **Parchment**: the opaque global page ground.
- **Paper**: the warm surface for cards, the sticky landing header, and working panels.
- **Field**: the near-white inset plane for inputs and compact controls.
- **Ink**: the primary reading color.
- **Muted**: secondary explanatory copy and quiet metadata.
- **Border**: warm one-pixel rules, input boundaries, dividers, and card edges.
- **Manager Ground**: the Manager shell's operational page ground.
- **Manager Rail**: the Manager shell's navigation layer.
- **White**: high-contrast foreground and the highest raised event surface.

### Curated Event Palettes

Candidary Default reuses the global Chestnut and Denim identity. Garden Party, Midnight Film, and Coastal Light each add a page, primary, and accent anchor in the token frontmatter; the complete 45-property semantic registry remains defined in `shared/event-theme.ts`. These palettes alter guest, RSVP, fullscreen, and preview presentation only. Danger, completion, typography, spacing, control size, and global host chrome stay fixed.

- **Candidary Default Hero Start**: the dark anchor of the default event gradient.
- **Candidary Default Hero Mid**: the warm center of the default event gradient.
- **Candidary Default Hero End**: the light edge of the default event gradient.
- **Garden Party Page**: Garden Party's guest-canvas ground.
- **Garden Party Primary**: Garden Party's primary event action.
- **Garden Party Accent**: Garden Party's supporting event accent.
- **Midnight Film Page**: Midnight Film's guest-canvas ground.
- **Midnight Film Primary**: Midnight Film's primary event action.
- **Midnight Film Accent**: Midnight Film's supporting event accent.
- **Coastal Light Page**: Coastal Light's guest-canvas ground.
- **Coastal Light Primary**: Coastal Light's primary event action.
- **Coastal Light Accent**: Coastal Light's supporting event accent.

**The Semantic Color Rule.** Chestnut acts, Denim selects or informs, Moss confirms completion, and Danger red names refusal or loss. Never exchange those meanings for decoration.

**The Global Chrome Rule.** Public, account, create, host, Manager, browser, loading, and pre-authentication surfaces stay on the global palette. Curated event themes are confined to authenticated guest, RSVP, fullscreen, and preview surfaces.

**The Constrained Theme Rule.** Event appearance comes from the four server-resolved presets and optional validated primary/accent overrides. Never generate raw CSS, new font choices, arbitrary URLs, or a parallel image system.

## Typography

**Display Font:** Manrope (with sans-serif fallback)

**Body Font:** DM Sans (with sans-serif fallback)

**Character:** Both families are bundled. Manrope gives headings a compact editorial authority without becoming ornamental; DM Sans keeps forms, states, and dense operational copy neutral and quickly legible. The pairing feels considered but never ceremonial.

### Hierarchy

- **Display** (Manrope, weight 700, fluid 44–90px, line-height 1.04, tracking -0.04em): page-level identity and public hero statements.
- **Headline** (Manrope, weight 700, fluid 32–56px, line-height 1.04, tracking -0.04em): section hierarchy and major Manager destinations.
- **Title**: Manrope for card and panel headings. The shared 1.6rem heading treatment inherits the global 1.04 line-height and -0.04em tracking. Album titles, guest phase headings, and Library headings use their own local sizes and line-heights.
- **Body** (DM Sans, weight 400, 16px, line-height 1.6): product explanation, guest instructions, and form content; use readable measures around 62–65 characters where prose is sustained.
- **Control**: DM Sans at 1rem and weight 600 for a standard global button. Buttons and inputs inherit the surrounding font, so smaller operational actions declare their local size explicitly.
- **Label**: DM Sans at 0.875rem for compact controls and phone navigation, with a 1.3 line-height where the component declares it. Desktop Manager destination labels use the separate navigation role and inherit a line-height of 1.
- **Status**: DM Sans at 0.75rem and weight 600 for ordinary status pills, with sentence-style capitalization and no eyebrow tracking.
- **Credential**: a system monospace stack for access-link values; it is a narrow functional exception to the two bundled product faces.
- **Eyebrow**: DM Sans at 0.76rem, weight 600, and 0.13em tracking for rare uppercase category labels. The source leaves its line-height inherited; it is separate from a status pill.

**The Two-Face Rule.** Headings, prose, and controls use bundled Manrope and DM Sans. Access-link values may use the existing system monospace stack. A private event may change semantic colors and radii, never typography.

**The Compact Heading Rule.** Headings use short measures, high weight, tight tracking, and no script or ornamental wedding type.

## Layout

The system is narrow-first. At 320–390px, public, guest, and Manager surfaces use one column, 20px page gutters, full-width primary controls, and content that wraps rather than scrolls sideways. Full-height work uses the small viewport unit so mobile browser chrome does not bury terminal actions.

Public shells cap at 1504px. Public headers use a 70px minimum height and 20px gutters through 760px, then an 88px minimum height and 5vw gutters. The landing hero stacks copy before imagery and becomes an editorial two-column composition at 900px. Reading surfaces hold approximately 62 characters; FAQ content caps at 760px. Guest RSVP and photo delivery use a centered 620px maximum frame so event identity and the current action stay visually inseparable.

Manager begins with a compact phone header containing the home link and current section. A disclosure opens all six labelled destinations in a bounded, scrollable panel, with the Guestbook review count also visible while closed. The event heading stays compact across mobile sections; Event details holds the date, upload status, and retention deadlines. At 761px navigation becomes a compact 104px labelled rail with a two-column utility region below the workspace. At 1101px it resolves into the defining 184px navigation rail and fluid workspace; the intake shell also defines a 330px utility rail, while other sections hide that utility content. Media grids expand only after each card can retain its name, state, and touch controls.

Spacing follows a 4px base and the staged 8, 12, 16, 24, 32, 48, 64, and 88px rhythm. Dense operational groups use rules and small gaps; public and terminal moments use larger vertical intervals. Safe-area padding belongs at mobile page endings and sticky action regions.

On phones, Library groups its title and count above a single row of Add photos, Trash, and Exports. That action row wraps when counts or enlarged text need more space. Compact spacing around the mode switch, search, and filters brings the Photo Wall into view while preserving 44–48px controls and the reserved arrival-notice row that prevents incoming photos from shifting the collection.

**The Narrow-First Rule.** Resolve the complete task at 320px before opening columns, rails, or decorative breathing room.

**The One Primary Canvas Rule.** RSVP, before-start, waiting, and photo delivery share one narrow guest frame; secondary gallery, notes, and prior deliveries never compete with the current task.

**The Labeled Navigation Rule.** Every Manager destination has a visible name in the open phone menu and persistent desktop rails. The closed phone menu names the current section; icon-only navigation is not part of this system.

## Elevation & Depth

Depth is a hybrid of tonal layering, one-pixel rules, and rare ambient shadows. Most surfaces are flat at rest. Paper cards receive a barely visible warm lift; the public photo stack and framed event experiences receive deeper, diffuse shadows because they behave like physical objects rather than interface chrome.

### Shadow Vocabulary

- **Paper Card** (`0 18px 50px rgb(74 36 21 / 5%)`): creation, account, legal, and recovery panels.
- **Photographic Print** (`0 22px 70px rgb(54 38 30 / 13%)`): overlapping guest photographs and large framed event surfaces.
- **Framed Guest Surface** (`0 22px 70px var(--event-frame-shadow)`): the complete guest frame on viewports at least 700px wide and 760px high.
- **Guest Task Card** (`0 10px 28px var(--event-primary-shadow)`): RSVP and other framed guest tasks inside a themed surface.
- **Selection Ring** (`0 0 0 2px var(--denim)`): active media and selected operational rows; this signals state, not physical lift.
- **Modal Dialog** (`0 20px 50px rgb(43 29 23 / 35%)`): a bounded confirmation surface above its opaque-content backdrop.
- **Cover Studio** (`0 30px 80px rgb(43 29 23 / 25%)`): the centered desktop cover editor.

**The Flat-by-Default Rule.** Use ground color, surface color, and one-pixel rules to establish structure. Add a shadow only when the element behaves like held paper, a framed event surface, or a physical photograph.

## Shapes

The base form language is gently rectangular: 7px inputs, 8px controls, 10px working panels, and 12px major cards. Manager destinations use a separate 6px corner. One-pixel warm borders define most edges. Dashed borders are reserved for upload/drop affordances and empty media zones; circles identify icons and terminal completion; pills hold only compact statuses and counts.

The signature public silhouette is a tall photographic arch with almost circular upper corners and a quiet rectangular foot. Overlapping square prints use smaller 2–5px corners and restrained rotation. The three-stroke brand mark echoes this physical stack. Event presets may vary input, action, card, and frame radii only inside their scoped guest presentation.

**The Arch and Print Rule.** Reserve the tall arch and overlapping square prints for photographic storytelling; ordinary product panels remain gently rectangular.

**The No Bubble Drift Rule.** Pills belong to compact statuses, counts, completion markers, and the implemented audience-fact chips. Do not turn navigation, prose, or ordinary cards into floating capsules.

## Components

Components are quietly tactile, clearly stateful, and task-first. They use native semantics, visible labels, text plus icon where meaning matters, and a 44px absolute touch floor.

### Buttons

- **Shape:** gently curved control corners with a 48px standard height; event primary actions may reach 52–58px.
- **Primary:** filled Chestnut with white text globally; a resolved event primary replaces Chestnut only inside event surfaces.
- **Secondary / Quiet:** Chestnut outline or text on a transparent ground; no low-contrast filled substitute.
- **Approval / Danger:** Moss fill for positive completion; Danger outline for entry to a destructive action and Danger fill for its final confirmation.
- **Hover / Focus:** standard enabled buttons lift by one pixel over 180ms; the primary action also deepens to Chestnut Strong. Global focus uses a two-pixel outline with a three-pixel offset. Preserve each component's existing focus geometry, including the three-pixel RSVP outline. Reduced-motion mode disables animation, collapses transition duration, and removes smooth scrolling.
- **Disabled:** retain the control and label, set native disabled semantics, and use the standard global opacity (0.48). RSVP, media, and other local components keep their existing disabled treatment.

### Cards / Containers

- **Corner Style:** 10–12px for ordinary panels; event cards use their preset-owned radius.
- **Background:** Paper over Parchment, with Field as the inset input plane.
- **Border:** one warm rule; selected cards strengthen the boundary with Denim.
- **Shadow Strategy:** flat unless the card represents held paper or a framed guest task.
- **Internal Padding:** 20–24px on phones and up to 40px for major desktop panels.

### Inputs / Fields

- **Style:** a 48px minimum field on the near-white Field surface, one warm border, 7px corners, and 12px by 14px padding.
- **Focus:** a two-pixel global Focus outline with a three-pixel offset. RSVP fields use their existing three-pixel outline and three-pixel offset. Event color selection never changes either geometry.
- **Phone entry:** typed guest name and RSVP fields explicitly restore a 1rem input font when their containing label is smaller.
- **Error:** inline Danger copy and a Danger boundary; preserve the user's value and focus the first invalid control.
- **Disabled:** keep labels and value legible, lower emphasis, and retain the same geometry.

### Statuses / Chips

- **Style:** compact pill only when the text is a state, count, or receipt marker.
- **Pending:** Denim Soft with Chestnut text.
- **Complete:** Moss Soft with Completion Ink and a textual state or check.
- **Failure:** validation and autosave failures use Danger Soft with Danger text; rejected status pills use Danger Chip. Color never stands alone.

### Navigation

Public headers stay opaque. The landing header travels with the page on Paper; other public headers inherit their page ground. On phones, Sign in and the short Create action stay visible while the How it works link leaves the header. The Manager phone header places home and a current-section disclosure in one compact row. Its expanded destination list floats below the header, keeps all six labels and the Guestbook review count, and scrolls inside the viewport when needed. At 761px it becomes the 104px labelled rail; at 1101px it becomes the 184px rail. Active state uses Denim Soft and Chestnut. The phone menu uses an inset focus outline, without the older bottom active-state underline.

### Event Hero and Guest Canvas

The event hero is the signature bridge between intimate imagery and operational state. It uses a verified private cover plus localized scrim, or the preset-owned three-stop gradient, with event name, date, and welcome copy kept readable. Beneath it, one centered guest canvas owns the current RSVP, waiting, or delivery task. Secondary content begins only after the primary decision.

### Dialogs and Disclosures

Confirmations use a Paper card with an internal scroll region, visible action labels, and a warm dimmed backdrop. The general dialog caps at 520px; Cover Studio becomes a centered 720px editor at desktop widths. Modal viewers sit above Manager navigation while the workspace is inert. Native details/summary disclosures retain their marker or an explicit chevron, keyboard focus, and a 44px minimum summary target.

### Event Theme Overlay

Four stable presets—Candidary Default, Garden Party, Midnight Film, and Coastal Light—resolve semantic page, surface, text, action, accent, focus, media, gradient, overlay, shadow, and radius roles. Components consume those roles without preset-specific branches. Hosts may override only validated primary and accent colors; global danger, delivery, typography, spacing, control size, hierarchy, and browser chrome remain fixed.

**The State Before Ornament Rule.** Every selected, pending, delivered, failed, and disabled state must remain legible through text, geometry, or an icon in addition to color.

**The Quiet Tactility Rule.** Controls may move by one pixel, deepen one semantic color, or reveal a focus outline; they do not glow, bounce, blur, or perform decorative motion.

## Do's and Don'ts

### Do:

- **Do** use the global Parchment, Paper, Ink, Chestnut, Denim, Moss, Danger, Border, and Focus roles before adding any new visual value.
- **Do** keep core controls at least 44px high, with 48px as the standard field and button height.
- **Do** let photographs carry celebration while surrounding controls remain calm, opaque, and specific.
- **Do** preserve visible labels, textual status, focus movement, reduced-motion behavior, and narrow-width containment.
- **Do** resolve event appearance through the existing preset registry and semantic token adapter.

### Don't:

- **Don't** introduce script fonts, confetti motifs, pastel wedding clichés, glass panels, or generic SaaS gradients.
- **Don't** make gallery, notes, badges, or decorative metrics compete with the current RSVP or delivery task.
- **Don't** hide Manager labels, use color as the only state signal, or shrink controls below the touch floor.
- **Don't** spread shadows across every surface; most hierarchy comes from spacing, paper tones, and rules.
- **Don't** permit raw event CSS, arbitrary fonts, external assets, unvalidated colors, or unknown theme fields.
- **Don't** reinterpret browser emulation as proof of a physical phone, camera picker, VoiceOver, or TalkBack.

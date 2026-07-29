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

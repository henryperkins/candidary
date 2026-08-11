# Event Appearance Live Canvas and Cover Studio Design

**Date:** 2026-08-03

**Status:** Revised design approved; written specification awaiting final review

## 1. Decision

Candidary will replace the separate Event Appearance preview with one live,
theme-scoped appearance canvas inside Manager Settings. The canvas updates where
the host is already working, while labels, inputs, save states, errors, and
other Manager controls keep the stable global Candidary treatment.

Cover selection becomes a focused Cover Studio with one short path. Uploads
include the only composition step; already-composed presets skip it:

**Choose → Compose (uploads only) → Style → Done**

A host may upload one private photo or choose one of exactly six built-in
abstract or textural covers. Uploaded photos receive an automatic composition
with a manual focus and zoom escape hatch. Both source types support five
curated styles. Publishing is non-destructive and versioned: the current cover
does not change until every required rendering of the new cover is ready.

This feature deepens the existing private guest journey. It does not create a
general page builder, brand kit, or photo-editing suite.

## 2. Product principles

1. The cover is the event's visual centerpiece. It must look intentional at
   every supported size rather than behaving like an arbitrary background file.
2. The host sees the result where they make the choice. There is no second
   preview farther down the page.
3. Preview containment and Manager styling are separate concerns. The event
   canvas may respond to the theme while its editing controls remain familiar,
   legible Manager chrome.
4. Automation leads and correction remains available. Candidary proposes the
   crop, contrast, and responsive renderings; the host can adjust focus and
   zoom without learning image-editing terminology.
5. Candidary offers only combinations it can make excellent. Presets, effects,
   crop profiles, colors, and object keys are server-owned allowlists, never raw
   host-authored CSS, URLs, or transformation parameters.
6. A failed experiment cannot damage the published event. Cancel before `Done`
   and any confirmed rejection before receipt acceptance preserve the current
   active cover. Once `Done` is dispatched, Candidary treats the outcome as
   ambiguous until it reconciles the durable operation ID; closing the UI never
   destroys state that an accepted or retryable publication may still need.

## 3. Goals

- Make the existing four event themes easier to understand by updating the
  Event Appearance component itself as the host chooses.
- Make selecting and refining a cover feel focused and visual rather than like
  completing a settings form.
- Ship exactly six built-in abstract or textural cover choices total across
  Candidary, not six choices per theme.
- Give uploaded photos an automatic subject-aware crop and a simple accessible
  manual correction path.
- Produce responsive, high-density cover renderings selected by actual layout
  needs rather than user-agent or phone-brand detection, with 2x candidates
  whenever the chosen source can produce them without upscaling.
- Keep uploaded originals, derivatives, and event-specific delivery private.
- Preserve the existing theme autosave, stale-read protection, event access,
  R2 ownership, cleanup, and manager-write security boundaries.
- Validate the complete experience on physical iPhone and Android devices with
  VoiceOver and TalkBack in addition to automated browser coverage.

## 4. Non-goals

- More than six built-in cover presets in this cycle.
- Theme-specific duplicate cover libraries.
- Stock wedding, party, venue, or people photography.
- Host-uploaded background URLs, arbitrary CSS, gradients, overlays, fonts,
  layout controls, or filter parameters.
- Freeform rotation, perspective correction, blemish removal, retouching,
  stickers, text-on-image, collages, generative editing, or filter intensity
  sliders.
- Account-wide cover or theme defaults.
- Changing Candidary's global Manager, account, landing, or PWA branding.
- Changing RSVP, guest photo contribution, gallery, or event timing behavior.
- Public delivery of host-uploaded originals.
- Deployment, production migration, or a claim of physical-device support as
  part of implementation alone. Those remain separate release activities.

## 5. Event Appearance live canvas

### 5.1 Scope

`EventAppearanceEditor` remains inside Manager Settings. Its visible event
surface becomes the preview. The current independent `Guest preview` block is
removed.

The live canvas contains:

- the real selected cover or no-cover hero;
- event name, date, and representative welcome copy;
- one representative primary and secondary guest action;
- the four existing event-theme choices;
- the constrained primary and accent controls;
- the cover summary and `Change cover` action; and
- a persistent Manager-owned preparation/outcome status when a cover operation
  is unresolved; and
- the existing saved, saving, blocked, failed, and retry states.

The representative guest actions are inert visual samples, not nested buttons
or links. They do not enter the tab order or imply that a guest workflow can be
run from Settings.

Theme-scoped presentation is installed only on the guest-like canvas layer.
The theme selector, upload/change action, color inputs, labels, status text,
validation, and retry controls sit in neutral Manager surfaces inside or over
that canvas. They do not inherit guest text colors, button colors, or radii.

Theme overlays and the cover text scrim remain semantic runtime CSS on the
guest-like canvas. They are never baked into an uploaded derivative or built-in
cover asset. A theme change therefore updates presentation immediately without
rerendering image files.

### 5.2 Theme choice

The current four stable theme IDs and contracts remain unchanged:

- `candidary-default`;
- `garden-party`;
- `midnight-film`; and
- `coastal-light`.

Each option remains a native radio choice with its name and description. Its
visual tile shows a small, real sample of surface, action, and accent treatment
rather than only three color dots. Selecting a theme updates the entire live
canvas immediately and then follows the existing serialized autosave queue.
Custom primary and accent values keep their current strict validation and
contrast floors.

Cover writes remain a separate ownership domain from theme autosave. A cover
publish response may merge only the cover-owned fields, and a theme response
may merge only `theme`, preserving the current stale-read and write-bracketing
rules.

## 6. Cover Studio interaction

`Change cover` opens a full-screen sheet on narrow viewports and a spacious
dialog on wider viewports. The Manager page remains behind it; opening the
studio does not navigate to a new Manager destination.

At viewport widths of 760 CSS pixels and below, the studio is a full-screen
sheet sized to `100dvh`; wider layouts use the same modal contract in a centered
dialog. The implementation uses either a native `<dialog>` or
`role="dialog" aria-modal="true"`, with a stable accessible name of `Cover
Studio`. The changing step heading is separately focusable and labelled. The
Manager page behind the modal is inert and scroll-locked.

At ordinary heights, the sheet has a sticky 56-pixel header with Close, an
accurate `Step n of m`, and the step title; a `min-height: 0` work area; and a
sticky footer with Back and Continue/Done controls padded by
`env(safe-area-inset-bottom)`. Only the step-control pane scrolls. The same live
canvas stays sticky above those controls, at least 144 CSS pixels high at
320 × 568. When the visual viewport falls below 500 CSS pixels because an
onscreen keyboard is open, the canvas may compact to 96 pixels and the active
control is scrolled above the footer. This is the same canvas, not a second
preview.

When the visual viewport is 420 CSS pixels high or shorter, including an
approximately 320 × 180 CSS-pixel viewport at 400% page zoom, the studio
switches to short-height mode. Header, 96-pixel-minimum canvas, controls, and
footer become in-flow children of one dialog-level vertical scroll region;
header, canvas, and footer are not sticky. Each action retains its 44-pixel
target, no second nested vertical scroller is introduced, and every heading,
range, error, and action can be reached by scrolling and keyboard navigation.

When `visualViewport` differs from the layout viewport, the sheet binds its top
and height to `visualViewport.offsetTop` and `visualViewport.height`; the footer
stays at the bottom of that visible rectangle rather than the obscured layout
viewport. A compacted 96/144-pixel canvas scales the already-selected profile's
crop and never requests a new composition merely because the editor chrome got
shorter.

Close, Cancel, backdrop dismissal, Escape, and browser Back all use the same
dirty-draft confirmation and focus-restoration behavior.

After Continue, focus moves to the new step heading. Back restores the control
that originated the later step. Upload uses four steps. A preset uses the
accurate three-step path Choose → Style → Done because its composition is
already fixed and responsive. Removal is the explicit exception: after
confirmation, it moves the canonical `none` intent directly to the focused,
labelled Done state instead of forcing the host through meaningless screens.

### 6.1 Choose

The studio opens with the currently published source selected. For an active
upload, entering Compose creates an authorized edit draft that references the
existing normalized master; it does not ask the host to upload the same photo
again. Current focus and style initialize the controls, while the master-owned
automatic point remains available to Reset. Canceling that draft cannot affect
the active cover or master.

The source picker presents:

1. `Upload a photo`; and
2. exactly six built-in presets in a two-column narrow layout or three-column
   wide layout.

The six version-1 preset IDs and host-facing names are:

| Stable ID | Name | Art direction |
| --- | --- | --- |
| `warm-linen` | Warm Linen | Quiet woven neutral with soft directional light |
| `botanical-shadow` | Botanical Shadow | Diffuse leaf shadow over tactile paper |
| `pressed-paper` | Pressed Paper | Pale fibrous paper with restrained depth |
| `candlelit-grain` | Candlelit Grain | Amber organic grain without literal candles |
| `coastal-haze` | Coastal Haze | Mineral blue-green atmosphere and soft haze |
| `midnight-wash` | Midnight Wash | Deep ink wash with subtle paper variation |

These are six global choices, not six assets per theme. Each is a real,
art-directed raster asset with no people, typography, logo, venue, or
event-specific prop. Theme-aware overlay and contrast recipes coordinate the
same artwork with any of the four themes. The artworks themselves are not
silently replaced when a host changes theme.

`Remove cover` remains a secondary action when a cover is active. It is not a
seventh preset. Confirmation creates a canonical `none` studio draft and
publishes it through the same revision guard, operation receipt, and `Done`
state as every other cover change. Until that transaction succeeds, the current
cover stays active. Success returns the event to its selected theme's existing
no-cover hero gradient.

### 6.2 Compose

Compose is upload-only. Preset tiles state `Ready for every size` in Choose and
continue directly to Style; they do not create an empty composition step.

For an upload, Candidary:

1. validates the declared and detected format, byte size, pixel dimensions,
   and orientation;
2. normalizes orientation and removes nonessential metadata, including GPS;
3. creates an automatic subject-aware crop for the cover profile; and
4. opens the real event canvas with that proposed composition.

The host may drag to reposition, choose `Adjust focus`, or reset to
Candidary's automatic composition. Inspection has already produced a resolved
automatic focal point. `Adjust focus` copies that point into three native range
controls without a visual jump. Their order is:

1. Horizontal focus, `0` through `100`, step `1`;
2. Vertical focus, `0` through `100`, step `1`; and
3. Zoom, `100%` through the draft's server-calculated safe maximum, step `5%`.

The accessible value text is respectively `n percent from left`, `n percent
from top`, and `n percent zoom`. Arrow keys change one step, Page Up/Down change
ten steps, and Home/End reach the valid bounds. Drag updates the horizontal and
vertical values but is never the only input; Zoom remains the native range so
two-finger browser gestures stay available for page zoom. `Reset to automatic`, immediately after
the ranges in focus order, returns to the responsive automatic composition.
Focus remains on the operated control, and a polite summary is announced only
when an interaction settles, not on every pointer or key movement.

Manual focus is persisted as normalized `x` and `y` coordinates from `0`
through `1`, plus a zoom value. The absolute version-1 zoom ceiling is `2.0`,
but each draft receives a lower safe maximum when source resolution would
otherwise require upscaling any required 1x output. Increasing manual zoom may
remove one or more optional 2x profiles but can never invalidate a 1x profile.
When the current crop lacks any 2x profile, Compose shows the non-blocking
high-density softness message from §10.1 beside the preview; adjusting focus or
zoom updates that message locally from shared geometry and server-reported
master dimensions without changing the 1x validity of the photo.

The crop is non-destructive. Candidary stores the normalized master and a
recipe, never one baked display crop as the only retained source.

### 6.3 Style

The style strip has exactly five choices:

- `natural` — faithful color with only output sharpening;
- `warm` — restrained warmth and softened contrast;
- `film` — controlled contrast, slightly reduced saturation, and fine approved
  grain;
- `soft` — lifted luminance with quieter contrast; and
- `monochrome` — neutral black and white with protected midtones.

The same five IDs apply to uploaded and preset sources. Only one may be active.
They are shown as real thumbnails and update the canvas immediately. There is
no intensity slider. Recipes are fixed implementation constants made from the
allowlisted image operations and approved Candidary assets. Hosts never submit
numeric transformation values.

The `film` image recipe applies only its fixed tonal treatment. Fine grain is
one versioned, tileable static asset named by the resolved
`film-grain-v1` surface treatment. Manager preview, picker thumbnails, and the
guest hero render the same non-animated, pointer-inert overlay in this order:
image, grain, contrast scrim, then content and controls. The overlay never
changes crop geometry or output byte budgets, and its fixed opacity participates
in contrast verification. Other effects resolve to the `none` surface
treatment. Hosts cannot select or configure a surface treatment independently.

The event theme and cover recipe remain independent:

- fixed Candidary guest typography remains unchanged;
- the theme owns guest surfaces, controls, shapes, and accent colors;
- the cover recipe owns source, composition, and style; and
- Candidary owns the cover overlay and text scrim required for readability.

Changing the theme later preserves source, focus, zoom, and style. An uploaded
photo is not recolored from the host's primary or accent choice. Built-in
artwork may receive its allowlisted preset-and-theme runtime overlay because it
was designed for that treatment; the underlying image file does not change.

### 6.4 Done and Cancel

All studio changes are draft-only until `Done`. `Done` remains disabled while
the source is invalid, an upload is incomplete, or its automatic composition
has not been stored. When invoked, the client creates one opaque operation ID,
persists it in event-scoped session storage for ambiguous-response recovery,
and submits the strict publication request.

`none` and preset publications have no event-owned render work. They use the
same durable receipt and revision transaction but may return an applied result
synchronously. An upload publication first performs a cheap revision check,
pins the ready draft and complete recipe in a durable receipt, allocates one
stable staging-set ID, and starts the receipt's `CoverRenderWorkflow`. The route
returns `202 Accepted` with a safe receipt view rather than holding the HTTP
request open while Images and R2 work runs.

The studio enters a labelled `Preparing cover` state and polls that receipt.
It shows product copy such as `Preparing cover 2 of 6` from durable progress;
the UI never exposes the implementation term `profile` or guesses completion
from elapsed time. After 60 seconds without a terminal result, the copy changes
to `Still preparing. Your current cover is safe, and you can close this
window.` Replaying the same operation ID and request digest returns the same
receipt and never starts a competing workflow.
Automatic Workflow retries and ambiguous network retries retain that operation
ID. After the server confirms a retryable terminal failure with no publication,
an explicit host `Try again` calls the operation-ID restart endpoint, which
rehydrates the pinned request server-side and restarts or resumes the same
Workflow instance under the same operation ID. The action therefore survives a
reload without the original client request body. A permanent failure requires a
corrected draft and new operation ID.

A successful final revision-guarded transaction automatically closes the
dialog, returns focus to `Change cover`, and updates the live canvas. Before
`Done` is dispatched, Cancel, Escape, Back, and Close may confirm and discard a
non-publishing draft. Once dispatch begins, Cancel becomes Close: every exit
only detaches studio polling and returns focus, regardless of whether the
client observed `202`, `503`, a network error, or no response. The draft may be
discarded again only after the server confirms either that no receipt was
accepted or that the accepted receipt is terminal, non-retryable, and has
released publication ownership by returning the draft to `ready`.

Manager owns reconciliation outside the dialog. While a receipt is queued,
rendering, finalizing, or retryable-failed, Event Appearance shows a persistent
neutral status beside the cover summary, such as `Preparing cover 2 of 6. Your
current cover is still live.` It resumes polling on Manager load, network
recovery, or authentication recovery even if the sheet stayed closed. Applied,
permanent-failed, and conflict outcomes update the canvas or show the focused
recovery action and are announced once without reopening the studio. A lost or
interrupted response remains ambiguous until Manager reads the latest event
and polls or replays the persisted operation ID. Clearing session storage
cannot cancel or hide accepted work because the Manager event view also exposes
the event's one safe unresolved preparation summary. The active cover remains
old until the job commits.

## 7. Create-flow boundary

Event creation remains one form. Its optional cover input uses the same format,
size, inspection, normalization, automatic focus, `natural` style, responsive
rendering, durable receipt, and asynchronous `CoverRenderWorkflow` publication
pipeline. It does not embed the full Cover Studio or the six-preset gallery.

Creation returns the created event even when its optional cover operation is
still preparing, carries the safe operation view into Manager, and resumes
polling there through the phase-appropriate transitional or final preparation
projection. If that post-create publication fails, the event remains created
without a cover and the receipt points the host to Event Appearance. The
failure cannot leave a partial cover active. A host who wants a preset, manual
crop, or effect uses Cover Studio after creation.

## 8. Shared cover contract

A new pure `shared/event-cover.ts` module owns identifiers, strict schemas,
canonical normalization, preset metadata, effect recipes, focus bounds,
profile identifiers, deterministic trim/crop geometry, and safe public
projection. The browser preview and rendering service consume the same geometry
fixtures; components and routes do not branch on ad hoc strings.

The semantic persisted shape deliberately excludes object keys, draft IDs, and
render-set IDs:

```ts
export type EventCoverPresetId =
  | 'warm-linen'
  | 'botanical-shadow'
  | 'pressed-paper'
  | 'candlelit-grain'
  | 'coastal-haze'
  | 'midnight-wash';

export type EventCoverEffectId =
  | 'natural'
  | 'warm'
  | 'film'
  | 'soft'
  | 'monochrome';

export type EventCoverFocusV1 =
  | { mode: 'auto' }
  | { mode: 'manual'; x: number; y: number; zoom: number };

export type StoredEventCoverConfigV1 =
  | { version: 1; source: { kind: 'none' } }
  | {
      version: 1;
      source: {
        kind: 'preset';
        presetId: EventCoverPresetId;
        assetVersion: 1;
      };
      effect: EventCoverEffectId;
    }
  | {
      version: 1;
      source: { kind: 'upload' };
      focus: EventCoverFocusV1;
      effect: EventCoverEffectId;
    };
```

Automatic upload composition stores the resolved normalized point and model
version on the master record beside immutable master bytes, while semantic
config records `mode: 'auto'`.
Each profile aspect-crops around that master-owned point. Keeping it with the
master means a later edit can always reset from manual back to the original
automatic composition. The point is returned only in authorized Cover Studio
draft metadata. Preset composition metadata stays in the immutable versioned
preset registry. `assetVersion` pins the exact preset/effect bytes so a later
release cannot change an active event without `Done` and a revision increment.
The existing `cover_object_key` column becomes the internal normalized-master
key for an upload and is null for `none` or `preset`. Object keys are never
accepted from recipe writes and are no longer returned in event views.

The post-cutover Manager and guest projections are deliberately different:

```ts
export type EventCoverSurfaceTreatmentId = 'none' | 'film-grain-v1';

export interface EventCoverPreparationView {
  operationId: string;
  status:
    | 'preparing'
    | 'applied'
    | 'retryable-failed'
    | 'permanent-failed'
    | 'conflict';
  completedSteps: number;
  requiredSteps: number;
  retryable: boolean;
  safeFailureCode: string | null;
  updatedAt: string;
}

export interface EventCoverView {
  config: StoredEventCoverConfigV1;
  revision: number;
  hasCover: boolean;
  available2xProfiles: readonly EventCoverProfileId[];
  surfaceTreatment: EventCoverSurfaceTreatmentId;
  preparation: EventCoverPreparationView | null;
}

export interface GuestEventCoverView {
  revision: number;
  hasCover: boolean;
  available2xProfiles: readonly EventCoverProfileId[];
  surfaceTreatment: EventCoverSurfaceTreatmentId;
}
```

`EventView` receives the Manager `EventCoverView`. `GuestEventView` receives
only `GuestEventCoverView`; it never receives source kind, preset ID, stored effect ID,
asset version, focus, zoom, automatic-composition metadata, or any storage or
manifest identifier. `available2xProfiles` is a sorted allowlisted delivery
capability, not client-authored geometry. It contains all six profiles for a
preset, only source-qualified profiles for an upload, and is empty for `none`.
`surfaceTreatment` is resolved by the server from the published effect and does
not let a guest invent presentation values. `preparation` is Manager-only and
contains the one unresolved receipt, otherwise the most recently updated
terminal receipt from the last 24 hours, selected by the server. The client may
dismiss an already-seen terminal notice locally, but clearing local state merely
shows that safe outcome again. The view contains no Workflow ID, object key,
recipe, checksum, or platform telemetry; failure codes are an allowlisted
product enum.

Phase 1 cannot use `EventCoverView` yet, so its legacy Manager projection adds
one top-level transitional field:

```ts
coverPreparation: EventCoverPreparationView | null;
```

It follows the same server selection and privacy rules as `cover.preparation`.
The legacy guest projection does not receive it. Existing Manager clients may
ignore the additive field; the phase-1 preparation-status component consumes
it. Phase 3 removes this top-level compatibility field when Manager switches to
`cover: EventCoverView`, preventing two owners for the same receipt.

The strict publish envelope is separate from the stored shape:

```ts
export type EventCoverPublishRequestV1 = {
  operationId: string;
  expectedRevision: number;
} & (
  | { source: { kind: 'none' } }
  | {
      source: { kind: 'preset'; presetId: EventCoverPresetId };
      effect: EventCoverEffectId;
    }
  | {
      source: { kind: 'upload'; draftId: string };
      focus:
        | { mode: 'auto' }
        | { mode: 'manual'; x: number; y: number; zoom: number };
      effect: EventCoverEffectId;
    }
);
```

`draftId` is an opaque, event-scoped identifier returned after an authorized
upload inspection. It is not an R2 key and cannot resolve across events.
`operationId` is a client-generated opaque UUID scoped to one publish intent;
the server stores a digest of the strict request and rejects reuse with
different bytes.

After the zero-legacy cutover, `EventView` exposes `cover: EventCoverView` and
`GuestEventView` exposes `cover: GuestEventCoverView` instead of
`coverObjectKey`. The compatibility release deliberately retains the current
`coverObjectKey` property until backfill is complete but projects only the
truthy sentinel or null defined in §9.5, never the repurposed database value;
the new projection does not need a transitional legacy flag. Cover images are
requested only through authorized, same-origin cover endpoints or the
authorized redirect to a global preset asset.

Parsing is strict at every object level. Unknown keys, arbitrary preset or
effect names, out-of-range focus or zoom values, object keys, URLs, CSS, and
arbitrary transform parameters are rejected rather than stripped.

Canonical invariants are:

- `none` is exactly `{version: 1, source: {kind: 'none'}}` and has null master
  and render-set pointers;
- `preset` has one selected effect, uses immutable preset-registry composition,
  pins `assetVersion`, and has null event-owned master and render-set pointers;
- `upload` has resolved automatic or validated manual focus, one selected
  effect, a normalized-master `cover_object_key`, and a same-event active render
  set whose manifest contains both formats for every 1x profile and only the
  source-qualified 2x pairs. There is no valid post-cutover published upload
  state with a null render-set pointer.

These invariants describe the phase-3 responsive contract. A legacy row with a
non-null `cover_object_key` and null render-set pointer is valid only during the
explicit phase-1/phase-2 compatibility window in §9.5; it is not representable
by `EventCoverView` because that view is not enabled until the window closes.

## 9. Persistence and migration

Migration `0012_event_cover_storage.sql` is additive; `0011` is already owned by
release certifications. It adds the following `events` columns using
SQLite-safe constant defaults so populated databases migrate successfully:

- `cover_config TEXT NOT NULL DEFAULT '{"version":1,"source":{"kind":"none"}}'`,
  bounded to 4 KiB and required to be a valid JSON object;
- `cover_revision INTEGER NOT NULL DEFAULT 0`, constrained to a non-negative
  integer; and
- `cover_render_set_id TEXT NULL`, the queryable server-only pointer for an
  active uploaded set.

The semantic JSON does not duplicate `cover_render_set_id`. The existing
`cover_object_key` becomes the normalized-master pointer for an upload and is
null for `none` or `preset`.

The same migration creates durable inventory rather than inferring draft or
cleanup state from R2 listings:

### 9.1 `event_cover_masters`

Each row has an opaque primary key, `event_id REFERENCES events(id) ON DELETE
RESTRICT`, unique event-prefixed `object_key`, `mime_type`, positive
byte/dimension fields, lowercase SHA-256, the normalization recipe rung,
nullable automatic-focus coordinates and composition-model version while a new
upload is only `inspected`, `created_at`, and nullable `cleanup_after`. The
focus/model fields become required before any draft using the master enters
`ready`. An upload master is deletable only when no event pointer, live draft,
render set, unexpired publication receipt, or backfill job refers to it.

### 9.2 `event_cover_drafts`

Each row has an opaque primary key, `event_id REFERENCES events(id) ON DELETE
RESTRICT`, source (`new_upload` or `existing_upload`), state (`reserved`,
`transferred`, `inspected`, `ready`, `publishing`, `published`, `failed`, or
`expired`), a client-generated draft-intent UUID, strict draft-create
request SHA-256, a non-negative `draft_revision`, nullable unique raw object
key, nullable declared filename/MIME/byte size, nullable verified raw byte size
and ETag once transferred, required master ID once
inspected, copied automatic focus/model metadata once ready, inspection recipe
JSON, failure code, created/updated timestamps, reservation expiry, and draft
expiry. `(event_id, draft_intent_id)` is unique.
A new-upload draft owns a temporary raw; inspection creates the bounded master
and advances to `inspected`; the guarded composition write advances it to
`ready`. An existing-upload draft references the active ready master, has no
raw, and may begin ready. Indexes cover `(event_id, state)` and the expiry scan.
The raw key is never accepted back from a client; ownership is always resolved
from the event-scoped draft ID. Expiring an edit draft can never make its still-
active master cleanup-eligible.

The client persists `draftIntentId` before the first draft-create request.
Same-intent, same-digest replay returns the original draft and transfer state
without allocating storage or consuming another rate event; reuse with a
different strict request returns `409`. A lost reservation response therefore
cannot consume a second live-draft slot. A guarded discard marks only a
non-publishing draft `expired`, increments `draft_revision`, and schedules its
owned raw/previews and unreferenced new master for cleanup. It requires the
current draft revision, is idempotent for an already-expired draft, returns
`409` for stale revision or `publishing`, and can never expire the event's active
master.

`MAX_LIVE_COVER_DRAFTS_PER_EVENT = 3`. Each draft is also bounded by
`MAX_LIVE_COVER_RAW_BYTES_PER_EVENT = 57_000_000` declared or verified bytes,
`MAX_COVER_PREVIEW_FILES_PER_DRAFT = 5`,
`MAX_COVER_PREVIEW_BYTES = 660_000` per file, and
`MAX_COVER_PREVIEW_BYTES_PER_DRAFT = 3_300_000`. The draft-create transaction
enforces both live-draft and aggregate raw-byte caps before returning the
authenticated ingress route; `409 COVER_DRAFT_LIMIT` or
`COVER_RAW_STORAGE_LIMIT` identifies the drafts the host may resume or discard.

The raw-byte aggregate is inventory-based and is not released by a state label.
It sums declared bytes for every `reserved`/in-flight new-upload draft without a
raw object plus `max(declared_byte_size, verified_raw_byte_size)` for every
non-null raw key in any state, including `failed` and `expired`. A discard can
stop future ingress but cannot subtract cleanup-pending bytes. Only verified R2
absence followed by a guarded transaction that clears the draft's raw pointer
and verified size releases that amount. If an interrupted/oversized object can
be HEAD-observed but not deleted, its actual size replaces the declaration and
continues to count. Reservation, ingress completion, discard, and cleanup all
use the same query/helper, so repeated upload/discard cycles cannot exceed the
bound.

`event_cover_draft_previews` inventories those files rather than inferring them
from R2 listings. Each row uses `draft_id ON DELETE RESTRICT`, one allowlisted
effect ID, recipe version, state (`rendering`, `ready`, or `failed`), nullable
unique event-prefixed object key/MIME/byte size/dimensions/winning rung/SHA-256
until ready, safe failure code, `retryable`, and timestamps;
`(draft_id, effect_id, recipe_version)` is unique. File-count and aggregate-byte
checks count ready files and occur transactionally before a new preview is
adopted. Same-tuple replay returns the stored ready or permanent-failed result;
only a retryable failure can re-enter `rendering` under the same tuple.

### 9.3 `event_cover_render_sets` and objects

A set row contains opaque ID, `event_id REFERENCES events(id) ON DELETE
RESTRICT`, master ID and nullable draft ID using `ON DELETE RESTRICT`, canonical
recipe JSON and SHA-256, state (`staging`, `ready`, `active`, `retired`, or
`abandoned`), the server-derived required-slot count, manifest SHA-256, nullable
published revision, created/ready/published timestamps, and nullable
`cleanup_after`. A partial unique index allows at most one active uploaded set
per event.

`staging` is owned by one receipt or backfill job and may contain zero through
its required slot count. `manifest_sha256` is null only while staging. `ready`
requires the exact complete manifest and remains unreachable from the event.
Only the final revision transaction may select `active`; its previous active
set becomes `retired`. `abandoned` means the set can never activate and carries
a reason/timestamp for cleanup. Every state change predicates on the expected
state and owning receipt/job rather than a lease token.

`event_cover_render_objects` contains one row per required profile-density and
format with the render-set ID using `ON DELETE RESTRICT`, allowlisted profile
ID, density, `webp` or `jpeg`, unique event-prefixed object key, content type,
byte size, dimensions, quality-ladder rung, and SHA-256. Both formats at 1x are
required for all six profiles. Both 2x formats are required only for profiles
whose selected source crop can produce them without upscaling, so an uploaded
manifest contains 12 through 24 objects. The compound `(render_set_id,
profile_id, density, format)` key prevents missing or duplicate slots. A set
becomes `ready` only after verifying its exact server-derived slot manifest, R2
existence, dimensions, MIME, checksums, and byte budgets.

Built-in covers do not create per-event render rows. Their complete 720-file
matrix and checksummed manifest live in the versioned Worker static-asset
bundle under `/assets/event-covers/v{assetVersion}/...`. These global artworks
contain no event data and are intentionally public release assets; the private
event selection remains available only through an authorized event view. Local
Vite and Wrangler development serve the same files from disk and require no R2
seed. An authenticated cover route validates the current event revision before
issuing a non-cacheable temporary redirect to the immutable asset. Versioned
targets use `Cache-Control: public, max-age=31536000, immutable`, contain no
event ID or slug, and remain shipped for as long as any supported config may
reference that asset version. The preset asset build adds a scoped
`public/_headers` rule for `/assets/event-covers/*`; it does not relax headers
for event-bound routes.

### 9.4 `event_cover_publish_receipts`

Each row is keyed by `(event_id, operation_id)` and uses `event_id`, nullable
draft ID, and nullable render-set ID foreign keys with `ON DELETE RESTRICT`. It
stores the strict request SHA-256, action (`publish` or `remove`), expected
revision, status (`queued`, `rendering`, `finalizing`, `applied`, `conflict`, or
`failed`), nullable unique deterministic Workflow instance ID, pinned
recipe and dependency versions, completed/required profile counts, nullable
applied revision and result cover JSON, terminal failure code, `retryable`, and
created/updated/expiry timestamps. It also records dispatch state (`pending`,
`creating`, `confirmed`, `resuming`, `restarting`, `failed`, or `blocked`), a monotonically
increasing dispatch generation, and the last dispatch-attempt timestamp so an
absent platform instance is never confused with an in-flight create/restart.

After duplicate-receipt resolution, the first upload transaction performs a
cheap `expectedRevision` check before any Images work, enforces resource and
mutation limits, freezes the ready draft
as `publishing`, pins its master/config/recipe, allocates one stable render-set
ID, and records one deterministic `CoverRenderWorkflow` instance ID. A partial
unique index permits only one `queued`, `rendering`, `finalizing`, or
retryable-`failed` receipt per event; expiry clears `retryable` before that row
stops blocking a competitor. Preset and removal receipts pin their immutable dependencies and can
become `applied` in that same guarded transaction because no event-owned
rendering is required.

The route idempotently creates the recorded Workflow after the receipt commit
and returns `202`. If dispatch fails, it records a retryable `failed` result;
same-digest publication replay, or the operation-ID restart endpoint using the
pinned receipt, moves that receipt back to `queued` and creates, resumes, or
restarts the stored instance ID without allocating a competitor. A duplicate with the
same request digest returns the stored progress or terminal result. Reuse with
different bytes returns `409`.
Receipt commit is durable publication acceptance even if the client observes no
response or the later dispatch returns `503`; its `publishing` draft is not
discardable. Ordinary discard resumes when the server confirms either that no
receipt was inserted or that an accepted receipt is terminal/non-retryable and
its guarded conflict/permanent-failure transition returned the draft to `ready`.
Every ordinary transition is conditional on the current nonterminal status,
request digest, and Workflow ID, so a late failed step cannot overwrite
`applied` or `conflict`. Restart/resume recovery is the only `failed → queued`
edge and also requires `retryable = true`, the same pinned receipt, the recorded
instance ID, and the exact status rules below. The transaction rechecks the
event revision and one-preparation cap; a newer publication turns the old
receipt into `conflict` rather than reviving stale work.

Platform status mapping is exhaustive:

- `queued`, `running`, `waiting`, and `waitingForPause` are active; keep or
  restore product status to preparing and poll without restart or termination;
- `paused` becomes retryable `failed` with a safe code; an authorized restart
  request uses `resume()` on the same instance, never `restart()`;
- `errored` or `terminated` may use `restart()` only for that retryable receipt
  inside its restart window after revision/cap/fence checks;
- `complete` first reconciles D1. Return an existing `applied`, `conflict`, or
  `failed` result; if D1 is unexpectedly nonterminal, record a safe retryable
  divergence failure, after which the same retained instance is eligible for
  guarded `restart()`;
- `unknown` never satisfies a mutation predicate; preserve product state and
  return retryable `503`/polling guidance; and
- a confirmed `get()` not-found may call `create()` with the same ID and pinned
  payload after atomically mapping any previously confirmed missing instance to
  safe retryable failure and claiming a new dispatch generation. This is
  recreation of the same fenced operation, not a new publication.

No other value is treated as non-running. Every branch is covered by a total
switch whose default preserves state and emits sanitized operations telemetry.
The status GET may apply this map only as a read-only product-view synthesis;
the Workflow handler, restart POST, or bounded cleanup is the authoritative
writer. The restart POST is allowed to persist a recoverable mapping from stale
nonterminal D1 and claim its recovery edge atomically, so polling never has to
mutate and recovery never waits for the daily sweep.

Workflows provide durable retries and step progress; Candidary does not build a
second lease, takeover, or generation-fencing engine. Every profile step is
nonetheless application-idempotent. R2 render writes use deterministic keys and
immutable conditional creates; an existing key is read and verified rather
than overwritten. D1 adopts only a valid object into the manifest. Replayed
steps can fill or verify missing slots but cannot replace active bytes or
increment the event revision.

`event_cover_workflow_fences` closes the D1-commit/platform-dispatch gap. It is
keyed by Workflow binding plus instance ID, intentionally does not foreign-key
the event row, and stores event ID, dispatch generation, state (`open` or
`deletion-blocked`), timestamps, and `expires_at`. Every create/restart claim
and its post-call result update the receipt/job and fence transactionally. The
dispatcher rechecks the fence immediately after `create()`, `resume()`, or `restart()`; if
deletion won, it terminates the instance and records no successful dispatch.
Workflow preflight also rejects a deletion-blocked fence before Images or R2
work.

Event purge first blocks every fence. A `creating`, `resuming`, or `restarting` fence makes
that purge pass stop. If such a claim remains stale for two minutes, the purge
coordinator resolves the deterministic instance ID: `unknown` status is retried,
not treated as absence; confirmed not-found is materialized with the same
pinned payload, whose deletion-blocked preflight performs no cover work; and
the resulting instance is terminated and verified terminal. Because `create()`
cannot reuse an ID retained by an existing instance, a late original create
cannot allocate a competitor. A late restart encounters the retained deletion
fence, exits before work, and is terminated by its caller's mandatory post-call
check. Fences are retained until 31 days after terminal verification, exceeding
the platform's maximum 30-day completed-instance retention, and then expire in
bounded cleanup.

Applied receipts survive for seven days so a response lost after commit cannot
cause a second publication. Hard limits are server-owned shared constants:

- `MAX_PREPARING_COVER_PUBLICATIONS_PER_EVENT = 1`;
- `MAX_NONACTIVE_COVER_RENDER_SETS_PER_EVENT = 32`;
- `MAX_RETAINED_COVER_RECEIPTS_PER_EVENT = 1_024`; and
- the draft and preview constants in §9.2.

The first-seen operation, not a replay, is rejected with `409` when a preparing
publication exists or storage caps are reached. Event-wide D1 windows define
`MAX_COVER_RESERVATIONS_PER_HOUR = 12`,
`MAX_COVER_INSPECTIONS_PER_HOUR = 12`,
`MAX_COVER_PREVIEWS_PER_HOUR = 30`, and
`MAX_COVER_PUBLICATIONS_PER_HOUR = 6`. Replays of an existing draft or operation
ID do not consume another slot. A rate rejection is `429` with `Retry-After`;
cap errors identify resumable or cleanup-blocking state without leaking object
keys.

Those limits are persisted in `event_cover_rate_events`, not process memory.
Each row has `event_id REFERENCES events(id) ON DELETE RESTRICT`, action
(`reservation`, `inspection`, `preview`, or `publication`), a server-validated
replay key, strict request SHA-256, UTC `window_start` equal to
`floor(serverUnixSeconds / 3600) * 3600`, `created_at`, and `expires_at`; the
unique key is `(event_id, action, replay_key)` and an index covers
`(event_id, action, window_start)`. Reservation uses `draftIntentId`,
inspection uses draft ID plus inspection recipe version, preview uses draft ID
plus effect and recipe version, and publication uses operation ID. After
authorization and strict parsing, one D1 transaction first resolves a matching
replay, rejects a replay-key/digest collision, counts the current fixed window,
and inserts the rate event only when capacity remains. Rate rows expire 26 hours
after their window starts, are removed in batches of 100, and are deleted before
their event during hard purge. This makes every count and non-counting replay
reconstructable after restart.

Every semantic publication includes the revision the Manager last read. The
final D1 transaction increments `cover_revision` exactly once only when that
expected revision still matches. A lost race returns a conflict with the latest
event view; it never deletes or overwrites the winning cover.

Object keys are deterministic beneath opaque IDs:

```text
events/{eventId}/cover/raw/{draftId}
events/{eventId}/cover/masters/{masterId}.webp
events/{eventId}/cover/previews/{draftId}/{effect}-{recipeVersion}.webp
events/{eventId}/cover/rendered/{renderSetId}/{profile}-{density}.{format}
```

Preset targets use the separately versioned static path described in §9.3.
Cleanup first proves that an R2 object is not the event pointer and is not
referenced by a live draft, render set, or receipt. It deletes the R2 object,
confirms success, and only then removes its D1 inventory row. Cover-table
foreign keys are `ON DELETE RESTRICT`; cleanup and event purge therefore use
the explicit child-before-parent order in §14 rather than relying on cascade or
trigger side effects.

### 9.5 Legacy-cover cutover

There is no valid responsive-reader state that serves a legacy original or a
normalized master. The current and new client contracts therefore never run as
one ambiguous shape. Cutover is three explicit release phases:

**Phase 1 — additive compatibility release**

1. Ship and, only with separate release authorization, apply additive migration
   `0012_event_cover_storage.sql`.
2. Keep the current `coverObjectKey` Manager/guest projection and current cover
   URL shape. Install a compatibility reader and writer behind that contract:
   a row with an active render set always serves the `wide-expanded` 1x JPEG
   derivative with `Content-Type: image/jpeg`, `Cache-Control: private,
   no-store`, and `X-Content-Type-Options: nosniff`; a legacy null-set row alone
   may retain the current original response temporarily. The compatibility
   projection returns the constant truthy sentinel `cover-present` when either
   source exists and null otherwise. Current clients use that field only for
   presence and request the authorized route, so neither audience receives the
   repurposed master pointer.
3. New or replacement uploads use the bounded normalization and
   `CoverRenderWorkflow` path even though the old client shape remains. The
   existing Manager/create upload controls gain the shared
   inspection/composition worker and center fallback without exposing the full
   Cover Studio. Phase 1 adds the Manager-only top-level `coverPreparation`
   projection and status component from §8, so accepted work remains
   discoverable and restartable after reload. The compatibility
   route sees the active set and therefore never streams the repurposed
   normalized-master `cover_object_key`.
4. Replace the current eager deletion of a prior `cover_object_key`. Before a
   legacy original pointer is replaced or removed, the same transaction adopts
   its exact server-only key into `event_cover_retired_legacy_objects` with its
   fingerprint, reason, and seven-day `cleanup_after`; only bounded cleanup may
   delete it from R2 and then remove its inventory row.
5. Keep the new Cover Studio and full `EventCoverView` unwired and the responsive
   routes unregistered; only the narrow transitional preparation field is added.
   Phase 1 introduces no new runtime feature-flag system.

`event_cover_retired_legacy_objects` is the only recovery/cleanup inventory for
displaced pre-`0012` originals. Each row has `event_id REFERENCES events(id) ON
DELETE RESTRICT`, a unique actual event-prefixed object key, lowercase key
fingerprint, retirement reason, `retired_at`, `cleanup_after`, and nullable
`deleted_at`. The key is server-only. Backfill, replacement, removal, and the
compatibility writer insert this row atomically before changing the legacy
pointer; they never eagerly delete the old object. After the recovery deadline,
cleanup verifies that the key is neither current nor otherwise referenced,
deletes and verifies R2 first, and then deletes the inventory row.

**Phase 2 — restartable backfill and proof**

Migration `0012` also creates two release-only ledgers.
`event_cover_backfill_runs` stores one inventory/execution run ID, mode, cursor,
inventory SHA-256, total/queued/applied/skipped/resolved/failed/
needs-replacement counts, status (`inventorying`, `executing`, `verified`, or
`failed`), and created/updated/verified/expiry timestamps.
`event_cover_backfill_jobs` has a unique `(run_id, event_id)` pair, references
the run and event with `ON DELETE RESTRICT`, and stores expected revision,
original legacy-key fingerprint, nullable master and render-set IDs, one unique
internal Workflow instance ID, dispatch state/generation compatible with the
fence in §9.4, status (`queued`, `normalizing`, `rendering`, `finalizing`,
`applied`, `skipped`, `resolved`, `needs_replacement`, or `failed`), safe failure
code, `retryable`, terminal/reference-release/expiry timestamps, and this pinned
source-independent dependency snapshot at job creation:

- normalization ladder and Images-parameter recipe versions;
- matte, metadata, composition, crop/profile-registry, tonal-effect, sharpening,
  and output-quality-ladder versions.

The row also has nullable derived density-manifest JSON/SHA-256. Those fields and
the staging render-set ID are null in `queued`, `normalizing`,
`needs_replacement`, or any pre-normalization failure. After successful
normalization reveals the winning master dimensions, one guarded transaction
derives and freezes the exact 12–24-slot manifest, allocates its staging set,
and moves `normalizing → rendering` before any profile transform. Manifest and
set are required and immutable in `rendering`, `finalizing`, and `applied`.

Cover dependency registries are append-only across this release family. Every
normalization, composition-model/browser-worker, crop/profile, effect, matte,
sharpening, preview, and output resolver or static asset remains deployable
while referenced by an active cover config, any master normalization/model
version, any non-deleted render set's canonical recipe, a live draft, an
unexpired publication receipt, or a backfill job, including every recovery/
restart window. Cleanup may declare a version removable only after a direct D1
reference query across all of those owners returns zero; version 1 is not
removed in this cycle. Neither backfill ledger is returned through a Manager or
guest contract.

The launcher uses exact application bounds:

- `MAX_COVER_BACKFILL_PAGE_SIZE = 100` rows;
- `MAX_COVER_BACKFILL_CREATE_BATCH = 25` instances;
- `MAX_COVER_BACKFILL_IN_FLIGHT = 25` instances; and
- `MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE = 25` creates or restarts.

A dry-run-first release script inventories only rows where
`cover_object_key IS NOT NULL AND cover_render_set_id IS NULL`. Only an
explicitly authorized execute mode creates a job and Workflow. Every new job
derives its instance ID from `hash('cover-backfill-v1', run_id, job_id,
event_id)`, unique within `CoverBackfillWorkflow`; a later inventory run creates
a new job and ID rather than attempting to reuse a retained instance. The
launcher creates at most one 25-instance batch per minute and stops whenever 25
jobs are nonterminal. The Workflow uses the pinned normalization service,
source-qualified manifest rules, and six replay-safe profile operations as
publication, but it does not consume Manager draft, receipt, or mutation-rate
capacity. Each instance:

1. rechecks that the event is not deleted and still has the same original key,
   revision, and null set;
2. inspects the private legacy object; an object that cannot enter Images,
   cannot satisfy the 1x minimum without upscaling, or cannot pass the master
   ladder becomes `needs_replacement` and remains on the compatibility reader
   rather than being silently degraded or deleted;
3. for a conforming source, creates and verifies a byte-bounded,
   metadata-stripped master and uses center focus when no historic focus exists;
4. while the original predicates still match, atomically adopts that master,
   derives and pins the exact source-qualified density manifest, allocates the
   staging set, and moves the job to `rendering`;
5. materializes the pinned manifest through the same idempotent profile steps,
   then verifies every required object;
6. transactionally writes canonical
   upload config with `natural` effect and automatic center focus, swaps the
   normalized-master/set pointers, first inventories the exact displaced legacy
   key in `event_cover_retired_legacy_objects`, and increments `cover_revision`
   only while the original key, revision, and null-set predicates still match;
   and
7. records `applied`, `skipped`, `needs_replacement`, or a retryable/terminal
   failure without changing a newer cover.

A same-job restart is the only `failed → queued` edge. It requires
`retryable = true`, the same pinned source-independent dependencies, the same
derived manifest when one exists, the original fingerprint, the 24-hour restart
window, and a dispatch fence that is still open. Backfill uses the same total
platform-status map as publication in §9.4, including resume for `paused`,
restart only for eligible `errored`/`terminated`, and no mutation for `unknown`.
Restart reuses the same job ID, Workflow ID, and immutable event payload. A new
run never restarts an older job.

The launcher records its cursor, inventory SHA-256, and counts durably, resumes
after interruption within the exact bounds, and never treats SQL migration
execution as image backfill. A row changed after inventory becomes `skipped`,
not failed; its created master/set is abandoned. A `needs_replacement` or failed
job whose guarded fingerprint is no longer current because the host replaced or
removed the cover, or because a later job applied, transitions to `resolved`.
Run counters are recomputed from jobs in the same transaction rather than
manually decremented.

Operators repeat the inventory and execute passes until all current rows are
applied or justifiably skipped. A `needs_replacement` or terminal-failed job
whose fingerprint is still current blocks phase 3. The final canonical
verification run takes a new complete inventory and may become `verified` only
when a direct D1 proof reports zero legacy rows, zero current-blocking jobs
across all retained runs, zero incomplete active manifests, and one same-event
active set for every uploaded cover. Historical jobs therefore cannot keep the
proof red after their exact source was safely replaced, but they cannot be
ignored while their source remains current.

Terminal `applied`, `skipped`, `resolved`, and non-current `failed` jobs set
`reference_release_at = terminal_at + 7 days` and `expires_at = terminal_at +
30 days`; verified or failed run summaries expire 30 days after their last job
becomes terminal. At reference release, cleanup nulls job master/render-set
foreign keys only after active event pointers or abandoned-set inventory own
the needed objects. It then deletes expired job rows before their run row in
batches of 100. Current `needs_replacement`, retryable jobs inside their restart
window, and their run never age out. Replaced legacy originals remain protected
by their dedicated inventory through the recovery window.

**Phase 3 — responsive contract and invariant release**

Only after the separately authorized production zero-legacy proof may a later
candidate add `0013_event_cover_invariants.sql`, enable the new projections and
responsive routes, and turn on Cover Studio. `0013` is absent from the phase-1
candidate; checking it into the repository earlier would cause fresh and test
databases to apply it immediately after `0012` through `readD1Migrations()`.
Applying both migrations in order is expected for a fresh database after phase
3 because it contains no legacy rows.

`0013` adds tested source/pointer and manifest triggers without making event
purge impossible. Referenced masters or sets cannot be deleted from a live
event, but a soft-deleted event may first clear its active pointers and then use
the explicit receipt → render-object → render-set/draft → master order in §14.
Migration and Workflow tests cover populated legacy and empty databases,
interrupted scans, child replay, a lost revision race, R2 failure, zero-row
proof, later fresh-D1 construction, and safe reruns. No release phase silently
discards an existing cover.

## 10. Upload and image-processing pipeline

### 10.1 Input contract

Manager, create, and Worker validation derive from cover-specific shared
constants rather than the broader guest-media limits. Version 1 accepts JPEG,
PNG, WebP, and HEIC still images. The input `accept` value, host copy, strict
request schema, detected-byte validation, and tests use the same
`COVER_UPLOAD_MIME_TYPES` list: `image/jpeg`, `image/png`, `image/webp`, and
`image/heic`. Generic HEIF and HEIC/HEIF sequence MIME types are rejected in v1;
they cannot be advertised unless a later design and deployed Images conformance
gate explicitly add them.

`MAX_COVER_UPLOAD_BYTES` is exactly `19_000_000` decimal bytes, below the Images
binding's 20 MB `.input()` ceiling. Reservation rejects a larger declared size;
inspection rechecks the actual R2 object size and detected type before passing
its bytes to Images. The existing binary `MAX_IMAGE_BYTES` guest-media constant
is not used for cover uploads.

Cover raw bytes do not use an unconstrained presigned R2 PUT. The authenticated,
CSRF-protected draft `PUT /raw` requires a browser-provided `Content-Length`
equal to the reserved `byteSize`, rejects missing/mismatched/over-limit lengths
before storage, and streams through a server-side byte counter that aborts as
soon as byte `19_000_001` arrives. The Worker writes only to the draft's
server-owned conditional raw key; it never buffers the whole photo and never
accepts a client key. A complete bounded write is HEAD-verified, records actual
size/ETag, increments the draft revision, and moves `reserved → transferred`.
An interrupted, mismatched, or oversized stream deletes any raw key before
returning/recording failure. If deletion fails, the draft remains failed with
its inventory intact for bounded cleanup. The same draft may replay a verified
transfer or retry after a confirmed absent partial; it cannot allocate another
raw slot. Reservation and transfer transactions both recheck the
57,000,000-byte event aggregate.

PNG and WebP transparency is allowed, but it cannot produce format-dependent
edges. Every preview and final WebP/JPEG transform applies the fixed,
server-owned `#fffaf3` paper matte before the selected effect. The host cannot
change that value, and it never follows event-theme colors.

After orientation, the usable source must be at least 620 pixels wide and 420
pixels high. That is enough to produce every 1x profile without upscaling. A
smaller source is rejected before it can replace the active cover. Each 2x
profile is optional and is advertised only when the selected focal crop and
safe zoom can produce that profile at 2x without upscaling. A source that lacks
one or more 2x profiles remains valid and receives the non-blocking message:
`This photo works in every layout. It may look slightly softer on some
high-density screens.` Inputs above the platform's documented area or
dimension ceiling are rejected with a corrective message rather than retried.

The raw upload is temporary. Successful inspection produces one canonical
still WebP master with EXIF orientation applied, `metadata: none`, animation
disabled, alpha retained when present, and no upscaling. The master must remain
at least 620 × 420 and must not exceed `MAX_COVER_MASTER_BYTES = 9_000_000`
decimal bytes. Normalization uses this exact, server-owned five-attempt ladder:

| Attempt | Maximum long edge | Maximum area | WebP quality |
| ---: | ---: | ---: | ---: |
| 1 | 4096 px | 16 MP | 88 |
| 2 | 4096 px | 16 MP | 84 |
| 3 | 3600 px | 12 MP | 84 |
| 4 | 3600 px | 12 MP | 80 |
| 5 | 3200 px | 10 MP | 80 |

The first result that satisfies codec, dimensions, and the byte ceiling wins.
A rung that would reduce the master below the 1x minimum is skipped. If none
qualifies, inspection fails with a request for a smaller or less panoramic
photo; the failure never waits until `Done`. The master inventory and R2 custom
metadata record its codec, byte size, dimensions, SHA-256, recipe version, and
winning rung. Candidary rereads and verifies the stored object before deleting
the raw. Failed inspection deletes the raw, marks the draft failed, and
publishes nothing. Neither raw nor master is a delivery source.

Inspection also returns one authorized, metadata-free, uncropped natural
preview capped at 660,000 bytes, plus the draft revision and server-pinned
composition-model version. Natural and effect previews use exactly four WebP
rungs, without upscaling: `1280 px / quality 82`, `1280 / 76`, `1120 / 76`, and
`960 / 72`, where the pixel value is the maximum long edge. The first valid
result within the byte ceiling wins; inventory records the rung, dimensions,
bytes, and checksum. A natural-preview exhaustion permanently fails inspection
with `COVER_PREVIEW_BUDGET_EXHAUSTED`, makes its new master/raw eligible for
cleanup, and leaves the active cover unchanged. An effect-preview exhaustion
records that terminal result for the exact draft/effect/recipe tuple, keeps the
ready draft and natural preview usable, and asks the host to choose another
style or photo; an identical request replays that result rather than retrying a
dense image forever. Transient platform errors remain retryable without adding
encoding rungs.

A versioned Candidary composition Web Worker runs saliency analysis on the
natural preview locally, off the main thread, and returns normalized focal
coordinates. A low-confidence result uses center focus and keeps the same
manual correction path.

The client persists that result through authenticated, CSRF-protected
`PATCH /api/manage/events/{eventId}/cover/drafts/{draftId}/composition` with a
strict `{expectedDraftRevision, modelVersion, x, y}` body. The server requires
the event-scoped `inspected` draft, the exact pinned model version and draft
revision, and finite coordinates from `0` through `1`; it accepts no dimensions,
object keys, confidence override, or transformation recipe. The transaction
stores the point once on the draft and master, increments `draft_revision`, and
moves the draft to `ready`. An identical replay returns the ready draft;
different or stale coordinates return `409`. `Done` remains disabled until the
ready response is durable. No third-party image-analysis service receives the
host's photo.

### 10.2 Bounded render profiles

One shared allowlisted registry owns six layout profiles that match the actual
guest hero states and defines 1x and 2x targets for each. Uploads always require
1x and source-qualify 2x; presets ship both. This avoids pre-cropping every image
to one shallow rectangle and then destructively cropping it again when a
welcome is expanded or the desktop frame appears.

| Profile | Exact layout state | 1x / 2x pixels | WebP 1x / 2x ceiling | JPEG 1x / 2x ceiling |
| --- | --- | ---: | ---: | ---: |
| `short-lookup` | ≤360 px wide and ≤600 px high lookup hero | 360×168 / 720×336 | 60 / 120 KiB | 90 / 180 KiB |
| `compact-default` | ≤390 px default hero | 390×205 / 780×410 | 70 / 140 KiB | 100 / 200 KiB |
| `standard-default` | 391–699 px unframed default hero, capped at 620 px | 620×218 / 1240×436 | 78 / 250 KiB | 120 / 360 KiB |
| `framed-default` | ≥700×760 viewport, 620 px framed hero | 620×265 / 1240×530 | 140 / 300 KiB | 210 / 440 KiB |
| `compact-expanded` | ≤390 px expanded-welcome hero | 390×420 / 780×840 | 130 / 280 KiB | 190 / 410 KiB |
| `wide-expanded` | 391–699 px expanded-welcome hero, capped at 620 px | 620×420 / 1240×840 | 220 / 480 KiB | 330 / 700 KiB |

The total priority-ordered mapping is:

1. lookup + container ≤360 + viewport height ≤600 → `short-lookup`;
2. expanded welcome + container ≤390 → `compact-expanded`;
3. any other expanded welcome → `wide-expanded`;
4. non-expanded + viewport ≥700 wide and ≥760 high → `framed-default`;
5. non-expanded + container ≤390 → `compact-default`; and
6. every other non-expanded state → `standard-default`.

The registry owns the state names, breakpoints, dimensions, budgets, quality
ladders, and density eligibility; request query strings and user agents cannot
invent them. Manager and Cover Studio constrain their live canvas to the same
620-pixel guest maximum and use the non-expanded branch unless explicitly
rehearsing an expanded welcome. `ResponsiveEventCover` measures its actual
container and hero state before installing sources, then exposes that profile's
mandatory 1x candidate and its 2x candidate only when
`available2xProfiles` includes the profile. Its WebP `<source>` and JPEG
fallback use density descriptors, so `sizes` is unnecessary. The user agent
selects among the advertised candidates using its effective-pixel-density
resource-selection algorithm; the design does not promise exact
`devicePixelRatio` matching or a particular candidate on every browser.
Resizing or changing hero state may select a different allowlisted profile;
brand or phone-model detection never does.

Each active uploaded cover is materialized as 12 through 24 objects: both
formats for all six 1x profiles, plus both formats for each source-qualified 2x
profile. Only the selected effect is rendered; the pipeline does not generate
all five full-size effect sets for an event. The version-1 output ladders are
stored per profile and are exactly WebP `82 → 78 → 74 → 70` and JPEG
`84 → 80 → 76 → 72`. For each required slot, runtime tries at most those four
qualities in order and accepts the first encoded output within that slot's byte
ceiling. Build-time visual fixtures approve every rung, including the lowest;
runtime never attempts to evaluate a visual fixture. Exhausting the ladder
fails publication and leaves the active cover unchanged.

Built-in covers are finite release assets rather than event-owned derivatives.
Each source begins from an art-directed master of at least 2400 × 1600. The
asset build produces and checksum-verifies the complete bounded matrix of six
presets, five tonal effects, six profiles, two densities, and two formats: 720
versioned static files representing only six host-facing cover choices. The
`film-grain-v1` tile ships beside that matrix and is layered at runtime rather
than baked into every output. Assets load on demand and are not all pre-cached
by the PWA. Theme overlays, grain, and the semantic text scrim are runtime CSS,
so the matrix is not multiplied by the four event themes and theme changes
never trigger image rendering.

Asset version 1 is immutable. Publishing a preset stores the server-resolved
`assetVersion: 1`, and delivery includes that version when resolving the static
manifest. A later visual or recipe refresh ships a new version and retains old
bytes; it cannot alter an active event until the host publishes again.

Automatic and manual composition both use their stored normalized coordinates,
allowing every aspect profile to protect the same subject. For zoom `z`, the
service computes a source window of `width / z` by `height / z` around the focal
point, clamps that window within the master, and records the exact trim
rectangle. It then applies the profile aspect crop around the effective focal
point with upscaling disabled, followed by the selected fixed effect and
restrained output sharpening. Cloudflare Images' face-only `zoom` parameter is
not used for arbitrary manual zoom.

Draft preview delivery is bounded independently of focus. The initial natural
preview is reused; selecting another style may create at most one authorized,
metadata-free, uncropped preview derivative for that effect. Thus one draft can
produce at most five full-frame preview files within the per-file and aggregate
limits in §9.2, encoded only through the four-rung preview ladder in §10.1 and
cached by draft, effect, and recipe version. The browser applies focal
positioning, zoom, the resolved surface treatment, and the measured canvas crop
locally to that file. Pointer/range movement performs no network transform;
superseded preview requests are canceled. `Done` replaces the local preview with
authoritative server outputs. Neither the browser nor a request supplies pixel
dimensions, trim rectangles, quality, or image-operation values.

### 10.3 Atomic publication

Preset and removal publications authorize, parse, canonicalize, hash, insert or
load their receipt, pin immutable dependencies, and perform the final
revision-guarded event update in one short D1 transaction. They return `200`
when applied or replayed and `409` on a revision conflict or operation-ID digest
collision.

An uploaded publication follows this asynchronous order:

1. Authorize the manager write, strictly parse and canonicalize it, hash the
   request, and atomically insert or load `(event_id, operation_id)`. Duplicate
   lookup happens before the current revision check so an already-applied replay
   remains recoverable.
2. Return the stored terminal result when the digest matches, reject reuse with
   different bytes, and otherwise enforce rate/storage caps and perform the
   cheap `expectedRevision` check. An already-stale first attempt becomes
   `conflict` without allocating a set, starting a Workflow, or calling Images.
3. In the same winning transaction, resolve and freeze the event-scoped ready
   draft, pin master/config/recipe versions, create its stable `staging` set,
   derive a bounded lowercase-hex Workflow ID from a hash of event ID and
   operation ID that is unique within `CoverRenderWorkflow` and the receipt
   table, and store the receipt as `queued` with dispatch state `pending`.
4. Claim the open dispatch fence, idempotently create or find that
   `CoverRenderWorkflow` instance, and perform the mandatory post-call deletion-
   fence check. Return
   `202 Accepted`, `Location` pointing to the receipt-status route, and
   `Retry-After: 2` only after instance creation succeeds or the same instance is
   confirmed. Dispatch failure changes the receipt to retryable `failed` and
   returns `503`; replay of the same operation may move it back to `queued` and
   create or restart that same instance.
5. A Workflow preflight rehydrates all server-owned state and rechecks the
   receipt digest/status, event deletion, revision, draft ownership, master,
   pinned recipe, source-qualified density manifest, and platform limits before
   Images work. A known-stale event atomically records `conflict`, abandons the
   empty set, and returns the draft to `ready`; a deleted event records safe
   failure. Both exit without transforming.
6. Transition `queued → rendering`, then run six named replay-safe steps in
   profile order: `short-lookup`, `compact-default`, `standard-default`,
   `framed-default`, `compact-expanded`, and `wide-expanded`. Each step creates
   or verifies that profile's mandatory 1x WebP/JPEG pair and optional 2x pair,
   uses the bounded quality ladders and conditional R2 creates, and records only
   small inventory/progress summaries in Workflow state; image bytes stay in
   R2.
7. Verify the exact 12–24-object manifest, including R2 existence, dimensions,
   MIME, checksum, quality rung, and byte ceiling. Only then transition the set
   `staging → ready` and the receipt `rendering → finalizing`.
8. In one authoritative D1 transaction, require the event's
   `cover_revision = expectedRevision`, the same nonterminal receipt/digest/
   Workflow ID, the frozen draft, and the ready set. Retire the previous upload
   set, activate the new set, update semantic config and master/set pointers,
   increment revision exactly once, mark the draft `published`, and mark the
   receipt `applied` with the resulting revision and safe event view.

If the final guard loses, the same transaction changes the receipt to
`conflict`, the staged or ready set to `abandoned`, and the still-valid draft
back to `ready`, without changing any active pointer. A controlled permanent
render or manifest failure marks the receipt `failed`, abandons the set, and
returns the draft to `ready`; a retryable failure preserves the staging set so
the same Workflow instance can restart idempotently. A late failure handler is
guarded from overwriting `applied` or `conflict`. Cleanup of the previous master
or set begins only after the new pointer is durable and its recovery window has
passed.

### 10.4 Why rendering completes before activation

The repository's lazy preview cache proves that transform-on-first-request is
possible, but it is not the cover publication contract. A lazy cover would tell
the host publication succeeded before the first guest proves that Images can
produce and R2 can retain the selected profile. A warmed hybrid would protect
only common profiles and would require both eager and lazy failure semantics.

The bounded 12–24-output set is therefore materialized before activation.
Workflows supply durable execution and retry, while D1 receipts, deterministic
objects, exact manifest verification, and the final revision transaction supply
application correctness. Guest and Manager delivery remain read-only: they
never invoke Images or repair storage. This preserves the product promise that
the previous cover remains complete until the replacement is complete.

## 11. Routes and delivery

The existing reservation/finalize routes evolve into a draft-and-publish
contract while retaining their current manager Origin, CSRF, owner/delegate,
and event-prefix checks.

The route responsibilities are:

- reserve an event-scoped upload draft and bounded authenticated raw-ingress
  route;
- replay that reservation by its client intent ID and explicitly discard an
  eligible draft by expected revision;
- inspect and normalize a transferred upload;
- create an edit draft from the event's active uploaded master without exposing
  its key;
- return authorized draft preview metadata;
- persist the browser composition result against an expected draft revision;
- generate at most one bounded preview per draft/effect;
- publish a strict `none`, preset, or upload recipe with `operationId` and
  `expectedRevision`;
- read or replay a durable publication receipt during normal progress or after
  an ambiguous response; and
- deliver one allowlisted render profile to an authorized guest or manager.

Draft creation uses one strict discriminated body:

```ts
export type EventCoverDraftCreateRequestV1 =
  | {
      draftIntentId: string;
      source: { kind: 'new-upload' };
      filename: string;
      mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
      byteSize: number;
    }
  | {
      draftIntentId: string;
      source: { kind: 'existing-upload' };
      expectedCoverRevision: number;
    };
```

The new-upload branch returns a reserved draft and its authenticated raw-ingress
route. The existing-upload branch requires the expected revision still to name
an active uploaded cover, resolves its master entirely on the server, and
returns a ready edit draft with current focus/style plus automatic-reset
metadata. It accepts no object key, URL, or source identifier. Both branches
use `(event_id, draftIntentId)` plus the strict request digest for lost-response
replay; a stale active revision or changed source returns `409` with the latest
Manager event view.

The HTTP surface is explicit and versioned through its strict bodies:

```text
POST  /api/manage/events/{eventId}/cover/drafts
PUT   /api/manage/events/{eventId}/cover/drafts/{draftId}/raw
DELETE /api/manage/events/{eventId}/cover/drafts/{draftId}
POST  /api/manage/events/{eventId}/cover/drafts/{draftId}/inspect
PATCH /api/manage/events/{eventId}/cover/drafts/{draftId}/composition
GET   /api/manage/events/{eventId}/cover/drafts/{draftId}
POST  /api/manage/events/{eventId}/cover/drafts/{draftId}/previews/{effect}
POST  /api/manage/events/{eventId}/cover/publications
GET   /api/manage/events/{eventId}/cover/publications/{operationId}
POST  /api/manage/events/{eventId}/cover/publications/{operationId}/restart
```

Every mutation keeps existing manager Origin, CSRF, authorization, and
event-prefix checks. Draft reservation strictly requires
the discriminated `draftIntentId` request union above. Draft `DELETE` carries no
client object key and requires `If-Match: "<current draft revision>"`; it is
allowed only for the non-publishing states in §9.2. Raw `PUT` requires the
reserved draft revision, exact Content-Type/Content-Length, and the streaming
limits in §10.1; it accepts no multipart envelope or client object key. The publication `POST` returns `202`, `Location`,
`Retry-After: 2`, and a safe operation view for a new or same-digest in-progress
upload. An applied replay returns `200` with `appliedRevision` and the latest
full Manager event view. A stale revision, digest collision, or competing
preparation returns `409` with a safe recovery view. The status `GET` is
manager-authorized, event-scoped, and side-effect-free; it exposes only product
status, `completedSteps` from `0` through `6`, `requiredSteps`, safe
failure/retry fields, applied revision, and the applied event view. Manager
event reads include the same safe summary for the event's one unresolved or
actionable operation, so recovery does not depend only on session storage.
When D1 is nonterminal, the GET also reads the recorded instance status and
applies §9.4's total map in memory. It may therefore synthesize an immediate safe
`retryable-failed` view for `paused`, `errored`, `terminated`, complete-divergent,
or confirmed not-found without mutating D1; `unknown` stays preparing with
retry guidance. Workflow IDs, raw platform status names, object keys, checksums,
recipes, and platform telemetry never leave the server.

The restart `POST` is Manager-authorized, Origin/CSRF protected, event-scoped,
and has a strict empty JSON body. It accepts either a D1 retryable-failed receipt
inside its restart window or a D1-nonterminal receipt whose freshly read
platform state maps to a recoverable failure in §9.4. In the latter case, one
guarded transaction first persists that mapped failure and then claims the same
receipt/dispatch generation for `queued`; there is no wait for daily cleanup.
The operation uses the receipt's pinned request, digest, draft, expected
revision, render set, dependencies, and Workflow ID; the client never
reconstructs or resubmits the cover recipe. It performs the same revision,
one-preparation, storage-cap, dispatch-fence, and exact platform-status checks
as same-request recovery, then resumes, restarts, or recreates only through the
reachable edges in §9.4. It returns the stored terminal view, `202` plus the
same status location when work is active/resumed/restarted, `409` for conflict
or an ineligible receipt, and `503` plus `Retry-After` for `unknown` platform
state. Replaying this mutation cannot allocate another receipt, draft, set, or
Workflow ID.

Cover Studio polls after 2, 4, 8, and then at most 10 seconds between responses,
honors a longer server `Retry-After`, pauses while the document is hidden, and
resumes on visibility, sheet reopen, network recovery, or recovered
authentication. Elapsed time alone never becomes failure. Once `Done` has been
dispatched, closing the sheet or losing a session detaches studio polling but
does not cancel or discard ambiguous work. The Manager-level reconciler keeps
or resumes polling from the safe event summary. A retryable terminal result may
restart the same operation/Workflow; a permanent failure requires a corrected
draft or new intent.

Guest and Manager delivery remain separate authenticated routes. The profile is
a path enum, not arbitrary width, height, quality, source, or effect input.
Every image URL contains the active revision. Once a client receives a newer
event view, its source URL and React key change immediately; a later request for
the prior revision fails. Already-decoded pixels on an open page that has not
refreshed cannot be recalled:

```text
/api/event/{slug}/cover/{revision}/{profile}/{density}.{format}
/api/manage/events/{eventId}/cover/{revision}/{profile}/{density}.{format}
```

After authorization, the Worker requires the path revision to equal the active
event revision and resolves the source from server state. A preset maps to its
versioned static manifest and returns a `private, no-store` temporary redirect
to its public immutable target. An upload maps to its same-event active render
set and returns `Cache-Control: private, no-store`. A missing, stale, retired,
cross-event, or non-allowlisted request never falls back to a prior set, master,
object key, or on-demand transform. Successful delivery includes
`X-Content-Type-Options: nosniff`. The normalized master is never a guest
response or a public URL. Replacement, removal, event deletion, or access
revocation therefore forces every subsequent event-bound request through
current authorization rather than permitting a browser-cached uploaded cover.

The guest hero changes from a fetched blob installed as a CSS background to a
decorative responsive `<picture>`/`<img>` beneath the surface treatment,
existing overlay, and copy. After the first container measurement, the
component installs one profile with a mandatory WebP/JPEG 1x pair and adds the
2x pair only when the safe guest projection advertises it. Controlled browser
tests assert the candidate fetched in that environment; the product does not
claim that every user agent makes the same density choice. Source URLs and the
React image key change with `cover.revision`, including when removal unmounts
the picture. The image has empty alternative text because event identity and
welcome copy already name the experience; picker tiles have explicit accessible
names.

`ResponsiveEventCover` owns an explicit `<img onError>` recovery state. It
immediately suppresses the failed picture so no broken-image icon appears and
reveals the theme's no-cover hero. When a selected WebP request fails, it may
remove the WebP source and try the verified JPEG fallback once. If the fallback
also fails, it emits one sanitized observable event and performs at most one
event-view refresh for that revision/profile. A newer revision resets recovery
and loads the new source; an unchanged or removed cover stays on the gradient
without another loop. Error state otherwise resets only when revision or
profile changes. Delivery never generates, repairs, or substitutes bytes during
that guest request.

## 12. Component and service boundaries

The implementation separates the feature into focused units:

- `shared/event-cover.ts` — identifiers, schemas, normalization, registries,
  public projection, and profile/effect constants;
- `EventAppearanceEditor` — theme autosave orchestration and cover-owned merge;
- `EventAppearanceCanvas` — the live guest-like canvas with neutral Manager
  control surfaces;
- `CoverStudio` — dialog/sheet state machine and draft ownership;
- `CoverSourcePicker` — upload plus six preset radios;
- `CoverComposer` — automatic/manual focus, zoom, reset, and crop preview;
- `CoverStylePicker` — five effect radios and live thumbnails;
- `ManagerCoverPreparationStatus` — sheet-independent reconciliation, progress,
  outcome announcement, and recovery action beside the cover summary;
- `ResponsiveEventCover` — the shared guest/Manager responsive image contract;
- a Cover Studio operation controller — `202` handling, receipt polling,
  session recovery, Workflow restart requests, and cover-owned event merging;
- an event-cover publication repository/service — durable receipts, caps,
  product-status transitions, and early/final revision guards;
- an event-cover mutation/fence repository — reservation replay, persisted rate
  events, dispatch claims, deletion fences, and platform-status reconciliation;
- an event-cover storage service — R2 keys, draft expiry, manifests, and cleanup;
- an event-cover rendering service — one idempotent profile operation, Images
  calls, approved recipes, output verification, and manifest finalization;
- `CoverRenderWorkflow` — orchestration of six bounded profile steps only;
- `CoverBackfillWorkflow` — release-only orchestration of legacy normalization
  and conversion using its own job ledger;
- a preset asset build — deterministic 720-file generation, grain asset,
  manifest checksums, and static-bundle verification; and
- an event purge coordinator — Workflow quiescence, R2 prefix removal, pointer
  clearing, then ordered relational deletion.

Route handlers authorize and translate HTTP. They do not construct object keys,
transformation recipes, or cleanup rules inline. React components consume the
safe cover view and never receive R2 keys. Workflows orchestrate small,
replay-safe service calls; they do not copy the existing export Workflow's
single giant-step shape. D1 receipts and inventory remain authoritative product
state rather than exposing Cloudflare instance status directly.
`wrangler.jsonc` declares dedicated `COVER_RENDER_WORKFLOW` and
`COVER_BACKFILL_WORKFLOW` bindings; neither overloads `EXPORT_WORKFLOW`.
Every Workflow side effect runs inside a deterministically named `step.do`, and
all cross-step state comes from step results or D1—not mutable top-level memory.

## 13. Accessibility and mobile interaction

- Source, theme, and style choices use native radio semantics with visible text
  and non-color selected indicators.
- Every control has at least a 44 × 44 CSS pixel target at 320 px and above.
- The native `<dialog>` or `role="dialog" aria-modal="true"` surface has the
  stable accessible name `Cover Studio`, traps focus, restores focus on close,
  and confirms before discarding eligible changed drafts.
- The full-screen sheet scroll-locks and inerts Manager, respects the bottom
  safe area, keeps the sticky canvas visible, and uses `visualViewport` changes
  only to keep the active control above the onscreen keyboard.
- Upload, inspection, preparation, success, and failure state changes are
  announced without repeatedly interrupting screen-reader users.
- The three native crop ranges expose their numeric bounds, step, and value
  text; drag is a convenience over horizontal/vertical focus while Zoom stays a
  native range. The polite crop
  summary fires after an interaction settles, never for every intermediate
  value.
- The crop surface does not claim two-pointer gestures. Browser pinch/page zoom
  remains native, and the viewport does not set `user-scalable=no` or a
  restrictive maximum scale. At short visual heights or 400% zoom, one
  dialog-level vertical scroller replaces sticky geometry so controls reflow
  rather than clipping.
- Focus is never hidden by the image, overlay, or theme.
- Errors are associated with the responsible control and focus the first
  actionable correction.
- Effect and preset thumbnails include names; images alone never communicate
  selection or state.
- Nonessential transitions and the placeholder dissolve respect
  `prefers-reduced-motion`.
- The live event canvas cannot apply event colors to Manager error, success,
  retry, or focus semantics.

## 14. Recovery and failure behavior

| Failure | Required behavior |
| --- | --- |
| Unsupported, mismatched, over-19,000,000-byte, or under-1x source | Refuse during reservation/inspection, explain the correction, retain the active cover |
| No normalization rung creates a ≤12,000,000-byte valid master | Fail inspection before saliency or `Done`, delete the raw, retain the active cover |
| Bounded raw ingress is interrupted | Verify/delete the partial key, then offer same-draft retry or a fresh reservation; do not create an active cover |
| Raw ingress length is missing, mismatched, or exceeds 19,000,000 bytes | Reject or abort before `transferred`, delete any partial object, retain inventory on deletion failure, and keep the active cover |
| Inspection or normalization fails | Delete the raw draft, retain the active cover, allow a new choice |
| Preview platform request fails transiently | Keep the studio open with the source and settings intact; replay the same bounded request |
| Preview four-rung ladder is exhausted | Persist `COVER_PREVIEW_BUDGET_EXHAUSTED`; fail natural inspection or keep a ready draft usable for an effect preview as specified in §10.1; do not repeat the same encoding ladder |
| Draft, storage, or mutation cap reached | Return actionable `409` or `429` plus `Retry-After` where applicable; never allocate more storage or render work |
| Workflow dispatch fails | Mark the receipt retryable `failed`, return `503`, retain the active cover, and let the same operation restart |
| Workflow step is retrying | Keep receipt `rendering`, preserve durable progress, and let polling continue |
| Output quality ladder or manifest verification is exhausted | Mark permanent `failed`, abandon the set, return the draft to `ready`, and retain the active cover |
| Early revision check loses | Record `conflict`; start no Workflow and perform no Images transformation |
| Final revision check loses | Record `conflict`, abandon the staged/ready set, return the draft to `ready`, and load the winning event |
| Manager session expires before `Done` dispatch | Stop before publication, preserve the draft for its expiry window, and direct the host to recover access |
| Session expires, sheet closes, or response is lost after `Done` dispatch | Detach UI polling but reconcile the same operation ID; do not discard until the server confirms no receipt, or a terminal non-retryable receipt has returned the draft to `ready` |
| Response or poll is lost after `Done` | Read the latest event and the same operation receipt; never submit a new operation ID |
| Event is deleted during preparation | Final guard cannot activate; mark safe failure, terminate/reconcile the Workflow, and preserve deletion order |
| Active WebP is unexpectedly missing | Hide the picture immediately and attempt the verified JPEG fallback once |
| Active JPEG/final derivative is unexpectedly missing | Keep the no-cover theme hero, refresh the event view once, and emit a sanitized host/operations error without leaking storage state |
| Cover removal fails | Keep the current cover active and offer retry |
| Studio is canceled before `Done` dispatch | Use the guarded draft discard; never touch the active set |

Reservations and unpublished drafts expire after 24 hours; abandoned staging
sets become eligible at the same deadline. A `publishing` draft does not expire
while its receipt is nonterminal or inside its retryable restart window. Applied operation receipts are
retained for seven days; conflict and permanent-failed receipts for 24 hours.
A retryable-failed receipt receives a 24-hour restart window; its draft remains
`publishing` and its staging set remains intact during that window. On expiry,
cleanup abandons the set and returns an otherwise-unexpired draft to `ready` or
expires it. A retired set or replaced master receives
`cleanup_after = max(retired_at + 7 days, every referencing receipt.expires_at)`.

`scheduledCleanup` gains a cover phase before event purge. Each daily pass
processes at most 100 rows in each expiry class and leaves any remainder for the
next scheduled or explicitly invoked bounded pass. It:

1. makes expired reservations/drafts unusable, deletes and verifies raw R2
   absence before clearing the counted raw pointer/size, and deletes preview R2
   objects before their inventory;
2. reconciles old receipts and backfill jobs against their recorded Workflow
   and dispatch-fence state instead of expiring them merely because wall time
   passed; platform `unknown` preserves product state and retries later,
   confirmed not-found may become retryable `failed`, and a terminal status is
   mapped through its guarded transition;
3. expires terminal publication receipts, releases terminal backfill-job
   master/set references at their deadline, then deletes expired jobs before
   expired run rows;
4. deletes expired rate-event rows and terminal Workflow fences only after their
   26-hour and 31-day deadlines respectively;
5. marks now-unreferenced staging sets `abandoned`, deletes eligible render
   objects before render-set rows, and deletes retired/abandoned sets after
   every receipt/draft/job reference clears;
6. deletes each eligible retired legacy R2 object and verifies absence before
   removing its dedicated inventory row; and
7. deletes unreferenced masters last.

Any R2 deletion failure leaves D1 inventory intact so the next pass can retry.
Global preset static assets are release files and never participate in event
cleanup.

Workflow reconciliation during event deletion is separately bounded and
restartable. `event_cover_purge_progress` has one
`event_id REFERENCES events(id) ON DELETE RESTRICT` row with phase
(`fences`, `r2`, or `relational`), nullable `(workflow_binding,
workflow_instance_id)` cursor, counts, and timestamps. Each purge invocation
uses `MAX_COVER_PURGE_FENCES_PER_PASS = 10` and
`MAX_COVER_PURGE_PLATFORM_MUTATIONS_PER_PASS = 5`; a status read consumes a
fence slot, while create/materialize, resume/restart, or terminate consumes a
platform-mutation slot. It persists the last fully reconciled cursor and yields
when either bound is reached. Reaching the end of one scan does not advance the
phase: a fresh D1 query must prove zero open/active/unknown/stale dispatch fences
for the event. Only then may the progress row move to `r2`.

Because that work may span invocations, the Manager delete request commits soft
deletion, credential revocation, and purge progress first. It returns `202` with
a safe `deletionScheduled` result while hard deletion remains, and same-event
replay resumes the recorded phase instead of creating another purge. The event
disappears from Manager and becomes unreachable to guests immediately; neither
the route nor UI claims physical deletion until the relational phase completes.

Event hard deletion extends the existing load-bearing purge order:

1. in one D1 transaction, soft-delete the event, revoke every host and guest
   credential, mark nonterminal publication/backfill work `EVENT_DELETED`, and
   change every recorded Workflow fence to `deletion-blocked`;
2. stop while any dispatch claim is actively `creating`, `resuming`, or
   `restarting`; after
   the two-minute stale threshold, reconcile it through the materialize/
   terminate protocol in §9.4 rather than treating absence as quiescence;
3. in cursor order and within the exact per-pass bounds, retry on platform
   `unknown`; for confirmed not-found, materialize the deletion-blocked
   deterministic ID; then terminate and verify instances terminal. Persist
   progress and return whenever work remains. The post-create/restart check and
   retained 31-day fence prevent a late dispatcher from doing cover work; R2
   deletion cannot start until the zero-unresolved-fence query succeeds;
4. delete and verify absence of the complete event R2 prefix;
5. in D1, set `cover_config` to canonical
   `{"version":1,"source":{"kind":"none"}}` and set `cover_object_key` and
   `cover_render_set_id` to null on the already soft-deleted event;
6. delete event-owned cover rows in this order: rate events → publication
   receipts and backfill jobs → render objects → render sets → draft previews
   → drafts → retired-legacy inventory → masters → purge-progress row. Recompute an affected
   backfill run's counts, and delete the run only if it has no remaining jobs and
   is otherwise expiry-eligible; retained Workflow fences intentionally have no
   event foreign key and age out separately;
7. continue the existing `media` then `guest_messages` deletion; and
8. delete the event last.

Invariant triggers explicitly allow the pointer-clearing step only for a
soft-deleted event. All other live-event reference deletion remains rejected.
Tests cover each cover lifecycle state, an R2 failure and retry, a Workflow that
finishes while deletion begins, termination failure, and final successful
purge.

## 15. Verification and acceptance

### 15.1 Shared and unit coverage

- Strict parsing, canonical serialization, every preset/effect/profile ID, and
  rejection of unknown fields and out-of-range focus or zoom.
- Exactly six built-in presets and five effects, enforced independently of the
  four theme presets.
- Exact JPEG/PNG/WebP/HEIC cover MIME list, decimal upload/master limits, five
  master-normalization rungs, four-rung preview/output quality arrays, resource
  caps, and mutation windows live in shared server-owned constants rather than
  duplicated client literals.
- Preset publication pins immutable `assetVersion`; introducing a newer
  manifest leaves existing event bytes and revision unchanged.
- Versioned resolver registry tests keep v1 composition, preview, crop/profile,
  effect, and output behavior addressable while any active config, live draft,
  master, non-deleted render set, receipt, or backfill job references it;
  removal is rejected until the direct reference query reaches zero.
- Manager and guest projections are distinct. Neither includes an object key or
  arbitrary URL; the guest receives only revision, cover presence,
  `available2xProfiles`, and resolved surface treatment.
- Theme/cover response ownership and existing autosave stale-response behavior.
- Source, effect, theme, automatic/manual focus, safe zoom maximum, and `none`
  removal combinations preserve canonical data.
- Conditional-density geometry always preserves all six 1x profiles and adds a
  2x profile only when its selected crop can be produced without upscaling.
- Saliency algorithm fixtures, low-confidence center fallback, model-version
  replay, and main-thread responsiveness run as browser/shared unit tests.
- The preset asset build checksum-verifies exactly 720 image files plus the
  versioned grain tile. An exhaustive deterministic compositor checks all
  `6 × 5 × 4 × 6 = 720` preset/effect/theme/profile contexts at every declared
  text and control region. A mathematical worst-case-luminance test proves the
  fixed scrim, including the lightest/darkest grain texels, protects arbitrary
  uploaded images. Axe is not used as evidence for image-background contrast.

### 15.2 Worker and storage coverage

- New/existing draft-create union, intent replay, expected active revision, and
  JPEG/PNG/WebP/HEIC guards, including HEIF/sequence rejection. Raw-ingress tests
  cover missing/mismatched/lying Content-Length, byte 19,000,000/19,000,001,
  stream interruption, partial deletion failure/retry, same-draft replay, and the
  57,000,000-byte event aggregate. Repeated fail/discard cycles remain charged
  until verified R2 absence clears raw inventory. Inspection covers declared/detected MIME
  mismatch, low 1x resolution, excessive area, and controlled fake-output
  master-byte failure.
- The composition endpoint's event/draft scope, CSRF, expected draft revision,
  pinned model version, coordinate bounds, one-time write/idempotent replay, and
  `inspected → ready` transaction. Saliency computation itself is not a Worker
  test.
- Exact Images parameters requested for normalization, automatic/manual crops,
  all five tonal recipes, both output formats, every profile and quality rung;
  rejection of arbitrary dimensions/transforms; and fake-output enforcement of
  master/preview/profile byte ceilings.
- Exact server-derived 12–24-object uploaded manifests, mandatory 1x pairs,
  conditional 2x pairs, bounded object keys, conditional-create adoption,
  manifest verification, and complete built-in static manifest validation.
- Receipt insertion/replay, digest collision, rate and storage caps, early
  conflict with zero Workflow dispatch, deterministic Workflow creation and
  restart, six idempotent profile steps, progress transitions, dispatch failure,
  final conflict, committed-response replay, preset dependency pinning across a
  deployment, live-draft resume and receipt restart across a deployment with
  their older pinned resolvers, and protection from a late failure overwriting
  terminal state.
- Draft-intent replay and guarded draft discard; persisted rate-event
  reconstruction/expiry; operation-ID-only restart after lost local state; the
  total queued/running/paused/errored/terminated/complete/waiting/
  waitingForPause/unknown/not-found map; dispatch-fence create/restart races;
  event deletion during the commit/dispatch gap; and late-dispatch post-call
  termination.
- Accepted conflict/permanent-failure receipts release a draft back to `ready`
  and permit guarded discard; retryable-failed receipts keep it `publishing`
  and non-discardable only through their restart window.
- Platform-terminal or paused with D1 still nonterminal is synthesized
  immediately by the side-effect-free status GET; the operation-only restart
  POST atomically persists the mapped failure and exercises resume, retained-ID
  restart, or same-ID recreation without waiting for scheduled cleanup.
- Missing WebP/JPEG delivery, strict current-revision authorization, no lazy
  Images work on delivery, one sanitized error, and no master/retired-set
  fallback.
- Bounded `scheduledCleanup`, exact deadlines, platform-state reconciliation,
  R2-before-D1 deletion, reference-safe master/set cleanup, 10-fence/5-mutation
  purge passes with persisted cursor and zero-unresolved proof, Workflow
  quiescence, all cover-row deletion states, R2 failure/retry, and the expanded
  event-prefix purge order.
- Guest and Manager authorization for every delivery profile, including wrong
  slug/event, stale revision, cross-event set, expired session, disabled entry,
  and deleted event.
- Migration `0012` on populated and empty fixtures; exact bounded backfill
  paging/batching/in-flight rate, source-independent dependency pinning at job
  creation, derived-manifest/set pinning only after normalization, interruption,
  same-job restart, new-run IDs, skip-on-change, needs-replacement resolution,
  retired-original inventory, reference release/ledger expiry, zero-legacy
  proof, and complete-manifest proof; plus a separate later-release
  fixture where `0013` follows `0012` and enforces live invariants without
  blocking ordered purge.
- For the phase-1 candidate, `scripts/verify-fresh-d1.ts` and its unit fixture
  assert `0012`, the exact `events` columns, terminal definitions, new tables,
  indexes, foreign keys, and the absence of `0013`/phase-3 triggers. The later
  phase-3 candidate deliberately updates that verifier to apply and assert
  `0013`; one candidate never claims both states.

The repository currently substitutes a deterministic fake Images transformer
in relevant Worker tests; Cloudflare's default local/Vitest binding is also
low-fidelity. These tests prove request recipes, orchestration, persistence,
controlled byte enforcement, and failure handling. They do not prove real
Cloudflare codec bytes, EXIF/GPS removal, encoder sizes, production checksums,
tonal output, or crop pixels; §15.5 owns those claims.

### 15.3 Component and real-browser coverage

- The separate preview is absent and the live canvas changes immediately for
  all four themes while Manager controls retain global styling.
- Cover Studio Choose, Compose, Style, Done, Cancel, remove, retry, session
  expiry, discard-confirmation, and existing-upload re-edit/reset flows without
  a redundant upload.
- Automatic saliency runs off the main thread, persists through the guarded
  composition route, and keeps `Done` disabled until the ready draft returns.
  Low-confidence and stale-draft cases retain the manual correction path.
- Upload `Done` covers `202`, `Location`, `Retry-After`, normal receipt polling,
  durable 0–6 profile progress, hidden-page pause/resume, lost response, sheet
  close/reopen, session recovery, retryable same-operation Workflow restart,
  permanent failure, and applied/conflict cover-owned event merging.
- Once `Done` dispatches, Cancel becomes Close even when the client sees `503`,
  a lost response, or no `202`. Closing leaves a persistent Manager status,
  reload resumes the server-selected operation without session storage, and
  applied/failed/conflict outcomes update or focus the live canvas recovery UI.
- The phase-1 top-level preparation projection and phase-3 nested projection
  drive the same Manager component. `Try again` after clearing all client state
  sends only operation ID to the restart endpoint and resumes from the pinned
  receipt without reconstructing the recipe.
- Keyboard crop adjustment, labelled controls, focus order/restoration, live
  announcements, reduced motion, and axe coverage.
- At 320 × 568, the live canvas, scrolling control pane, safe-area footer, dirty
  dismissal, browser Back, and visual-keyboard behavior remain operable without
  hidden focus or covered controls.
- Browser page zoom remains enabled. At 200% and at an approximately 320 × 180
  CSS-pixel viewport produced by 400% zoom, short-height mode presents one
  usable vertical scroll region; the in-flow canvas, crop ranges, headings, and
  footer remain reachable without clipping or blocking the active control.
- Responsive source selection and visual crops at 320 × 568, 390 × 844,
  620 px guest width, the short lookup, expanded welcome, framed desktop,
  portrait, and landscape states. Publish, republish, and removal update the
  image after the client receives the new event view without remounting the
  parent canvas because every source URL carries the new revision.
- Profile-selection boundary tests cover 360/361, 390/391, 699/700 CSS pixels,
  viewport heights 599/600/601 and 759/760, all hero states, and the compacted
  studio canvas without leaving any state unmapped.
- Drag and range movement issue zero transform requests; browser pinch remains
  page zoom. A draft creates
  no more than five effect preview files and cancels superseded effect requests.
- Representative preset/effect/theme/profile combinations verify real browser
  layer order, static-asset redirects, crop geometry, breakpoints, grain,
  clipping, controls, and scrim rendering. Representative dark, light,
  portrait, landscape, centered-subject, and edge-subject uploads receive
  bounded visual regression coverage across every profile. Exhaustive 720-case
  contrast evidence remains the deterministic compositor in §15.1, not 720
  Playwright screenshots; axe covers semantics rather than text-over-image
  contrast.
- Slow network and interrupted upload simulations never replace the active
  cover or show a broken guest hero.
- Sources with complete, partial, and absent 2x eligibility advertise the exact
  safe density set. In controlled browsers, network assertions record the
  selected advertised candidate without claiming universal DPR behavior.
- WebP failure tries JPEG at most once; final image failure immediately shows
  the no-cover hero, refreshes the event view at most once, resets on a newer
  revision/profile, and never loops or reveals a broken-image icon.
- A newly published cover is never delivered from the high-resolution master,
  and every fetched upload object remains within its exact profile, density,
  byte, and dimension budget.

### 15.4 Physical-device acceptance

Before claiming device support, validate on physical:

- a small and current iPhone in Safari, portrait and landscape;
- a current Android phone in Chrome, portrait and landscape;
- VoiceOver on iPhone; and
- TalkBack on Android.

The pass requires file selection from each platform's photo picker, HEIC from
iPhone, automatic crop, drag, native browser pinch/page zoom, the accessible crop alternative, style
selection, interruption and retry, Done, and the final RSVP/photo-drop hero.
Automated WebKit or Chromium screenshots do not substitute for this evidence.

### 15.5 Deployed Images and Workflow conformance

Local Worker/Vitest coverage proves schemas, recipes, orchestration, and failure
handling; it does not prove Cloudflare Images' production decoder or encoder.
Before production cutover, a separately authorized staging gate runs the real
Images binding against representative JPEG, opaque PNG, WebP, iPhone HEIC, and
explicitly rejected HEIF/sequence fixtures, including transparent PNG and WebP
cases, exact upload-limit boundary fixtures, dense photos that exercise every
master, preview, and output quality rung, and
sources with complete and partial 2x eligibility. It verifies orientation,
metadata/GPS removal, deterministic trim and focal crops, all five tonal
effects, WebP/JPEG output, MIME and dimensions, checksums, transparent-input
matte parity between WebP and JPEG, no upscaling, and every master, preview, and
profile byte ceiling. The visual gate approves the lowest allowed quality rung
before that rung can ship.

The same staging candidate proves `CoverRenderWorkflow` and
`CoverBackfillWorkflow` creation, automatic step retry, same-instance restart,
deterministic per-profile replay, conditional-object adoption, early and final
revision conflicts, status polling, platform/D1 status reconciliation,
termination, and event purge. Tests stay within documented CPU, subrequest,
step, creation-rate, and retention limits. That deployed evidence is required
before applying the responsive reader to production and is not implied by a
local passing suite.

## 16. Release boundary

Local implementation may add phase-1 migration `0012`, compatibility code,
unwired responsive/Cover Studio modules, both Workflow classes, the dry-run-first
backfill launcher, generated preset assets, and tests. The phase-1 candidate
must not contain `0013`. Local schema work updates
`scripts/verify-fresh-d1.ts` and its fixtures to assert the phase-1 schema and
the absence of `0013`. Only the later phase-3 candidate changes that verifier to
assert the phase-3 triggers. Final candidate verification uses:

```text
npm run verify:release -- --sha <immutable-head> --base-sha <approved-base>
```

That aggregate gate already includes `verify:fresh-d1`; passing it is local
candidate evidence, not deployment evidence.

None of the following is authorized by implementation or a local passing gate:

- applying `0012` or any later migration to remote D1;
- deploying either Workflow binding, the Worker, or static preset assets;
- creating, restarting, terminating, or triggering remote Workflow instances;
- mutating production R2 or launching the legacy backfill;
- enabling the strict responsive reader or new client projection;
- adding/applying `0013` before the separate production zero-legacy proof;
- claiming deployed Images/Workflow conformance; or
- claiming physical iPhone, Android, VoiceOver, or TalkBack support.

Those require separately authorized phase-1 deployment/migration, backfill,
staging conformance, zero-legacy proof, and phase-3 invariant/reader release
activities. `0013` is authored and checked in only for that later phase-3
candidate.

## 17. External platform references

The design relies on current Cloudflare Images, Workflows, Workers Static
Assets, and responsive-image behavior documented on 2026-08-03:

- the Images binding accepts private raw bytes from R2 and does not require a
  public source URL;
- normalized focal coordinates and explicit trim values are supported for the
  bounded crop recipe;
- HEIC input, metadata removal, still-image output, and the selected fixed
  color and transparency-matte operations are documented;
- transformed responses require explicit caching or materialization; and
- unique source/parameter combinations are billable transformations, which is
  why profiles and recipes are bounded allowlists;
- the Images binding accepts at most 20 MB at `.input()`, so both raw and master
  use lower exact decimal ceilings;
- Workflows provide durable replayable steps, retries, lifecycle status,
  restart, and termination, while D1 remains Candidary's product-state ledger;
- user-supplied Workflow IDs are scoped to a Workflow definition, retained
  completed instances cannot be recreated under the same ID, and paid-plan
  completed-instance retention is at most 30 days;
- versioned static assets are available from local disk in development and can
  be served as immutable deployed release files; and
- browser density selection follows the user agent's responsive-image resource
  selection algorithm rather than an exact phone-model or DPR equality rule.

References:

- <https://developers.cloudflare.com/images/optimization/binding/>
- <https://developers.cloudflare.com/images/optimization/features/>
- <https://developers.cloudflare.com/images/get-started/limits/>
- <https://developers.cloudflare.com/images/pricing/>
- <https://developers.cloudflare.com/workflows/>
- <https://developers.cloudflare.com/workflows/build/workers-api/>
- <https://developers.cloudflare.com/workflows/build/rules-of-workflows/>
- <https://developers.cloudflare.com/workflows/reference/limits/>
- <https://developers.cloudflare.com/workers/static-assets/>
- <https://developers.cloudflare.com/workers/local-development/>
- <https://developers.cloudflare.com/workers/cache/configuration/>
- <https://html.spec.whatwg.org/dev/images.html>
- <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>

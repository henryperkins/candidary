# Event Appearance Live Canvas and Cover Studio Design

**Date:** 2026-08-03

**Status:** Design approved; written specification awaiting review

## 1. Decision

Candidary will replace the separate Event Appearance preview with one live,
theme-scoped appearance canvas inside Manager Settings. The canvas updates where
the host is already working, while labels, inputs, save states, errors, and
other Manager controls keep the stable global Candidary treatment.

Cover selection becomes a focused Cover Studio with one short path:

**Choose → Compose → Style → Done**

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
6. A failed experiment cannot damage the published event. Cancel, session
   expiry, and any failure before the publication transaction preserve the
   current active cover. If publication succeeds but its response is lost,
   Candidary reconciles the durable operation receipt before calling the action
   failed or offering another write.

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
  needs rather than user-agent or phone-brand detection.
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

At viewport widths of 760 CSS pixels and below, the studio is an `aria-modal`
full-screen sheet sized to `100dvh`; the Manager page behind it is inert and
scroll-locked. The sheet has a sticky 56-pixel header with Close,
`Step n of 4`, and the step title; a `min-height: 0` work area; and a sticky footer with Back and
Continue/Done controls padded by `env(safe-area-inset-bottom)`. Only the
step-control pane scrolls. The same live canvas stays sticky above those
controls, at least 144 CSS pixels high at 320 × 568. When the visual viewport
falls below 500 CSS pixels because an onscreen keyboard is open, the canvas may
compact to 96 pixels but remains visible and the active control is scrolled
above the footer. This is the same canvas, not a second preview.

When `visualViewport` differs from the layout viewport, the sheet binds its top
and height to `visualViewport.offsetTop` and `visualViewport.height`; the footer
stays at the bottom of that visible rectangle rather than the obscured layout
viewport. A compacted 96/144-pixel canvas scales the already-selected profile's
crop and never requests a new composition merely because the editor chrome got
shorter.

Close, Cancel, backdrop dismissal, Escape, and browser Back all use the same
dirty-draft confirmation and focus-restoration behavior.

After Continue, focus moves to the new step heading. Back restores the control
that originated the later step. The four-step path applies to choosing a cover.
Removal is the explicit exception: after confirmation, it moves the canonical
`none` intent directly to the focused, labelled Done/preparing state instead of
forcing the host through meaningless Compose and Style screens.

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

Built-in covers still pass through Compose so the flow always has four steps.
Compose shows the precomposed live canvas, a `Ready for every size` explanation,
and no crop controls; Continue advances to Style and Back returns to Choose.

For an upload, Candidary:

1. validates the declared and detected format, byte size, pixel dimensions,
   and orientation;
2. normalizes orientation and removes nonessential metadata, including GPS;
3. creates an automatic subject-aware crop for the cover profile; and
4. opens the real event canvas with that proposed composition.

The host may drag to reposition, pinch, choose `Adjust focus`, or reset to
Candidary's automatic composition. Inspection has already produced a resolved
automatic focal point. `Adjust focus` copies that point into three native range
controls without a visual jump. Their order is:

1. Horizontal focus, `0` through `100`, step `1`;
2. Vertical focus, `0` through `100`, step `1`; and
3. Zoom, `100%` through the draft's server-calculated safe maximum, step `5%`.

The accessible value text is respectively `n percent from left`, `n percent
from top`, and `n percent zoom`. Arrow keys change one step, Page Up/Down change
ten steps, and Home/End reach the valid bounds. Drag and pinch update the same
values but are never the only input. `Reset to automatic`, immediately after
the ranges in focus order, returns to the responsive automatic composition.
Focus remains on the operated control, and a polite summary is announced only
when an interaction settles, not on every pointer or key movement.

Manual focus is persisted as normalized `x` and `y` coordinates from `0`
through `1`, plus a zoom value. The absolute version-1 zoom ceiling is `2.0`,
but each draft receives a lower safe maximum when source resolution would
otherwise require upscaling any required output.

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
allowlisted image operations and, where needed, approved Candidary overlay
assets. Hosts never submit numeric transformation values.

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
the source is invalid or an upload is incomplete. When invoked, the client
creates one opaque operation ID, enters a labelled `Preparing cover` state,
builds the required output set, and publishes only after that set is complete.
Every retry of that same intent reuses the operation ID.

On success, the dialog closes, focus returns to `Change cover`, and the live
canvas renders the server-published result. `Cancel`, Escape after confirmation
when there are draft edits, session expiry, or any error known to occur before
the guarded D1 transaction leaves the active cover unchanged. A lost or
interrupted response is ambiguous rather than a failure: the client first reads
the latest cover and submits the same operation ID to recover its durable
receipt. It closes on an already-applied receipt, presents a revision conflict
when another publication won, and offers `Try again` only when the server
confirms that no publication occurred. An authorization failure explains how
to recover access without looping a write that cannot succeed.

## 7. Create-flow boundary

Event creation remains one form. Its optional cover input uses the same format,
size, inspection, normalization, automatic focus, `natural` style, responsive
rendering, and transactional publish pipeline. It does not embed the full
Cover Studio or the six-preset gallery.

If that post-create cover publish fails, the event remains created without a
cover and the receipt points the host to Event Appearance. The failure cannot
leave a partial cover active. A host who wants a preset, manual crop, or effect
uses Cover Studio after creation.

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
version on the immutable master, while semantic config records `mode: 'auto'`.
Each profile aspect-crops around that master-owned point. Keeping it with the
master means a later edit can always reset from manual back to the original
automatic composition. The point is returned only in authorized Cover Studio
draft metadata. Preset composition metadata stays in the immutable versioned
preset registry. `assetVersion` pins the exact preset/effect bytes so a later
release cannot change an active event without `Done` and a revision increment.
The existing `cover_object_key` column becomes the internal normalized-master
key for an upload and is null for `none` or `preset`. Object keys are never
accepted from recipe writes and are no longer returned in event views.

The safe client model is:

```ts
export interface EventCoverView {
  config: StoredEventCoverConfigV1;
  revision: number;
  hasCover: boolean;
}
```

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

`EventView` and `GuestEventView` expose `cover: EventCoverView` instead of
`coverObjectKey`. The cover image itself is requested only through authorized,
same-origin cover endpoints.

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
  set. There is no valid published upload state with a null render-set pointer.

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

Each row has an opaque primary key, `event_id`, unique event-prefixed
`object_key`, `mime_type`, positive byte/dimension fields, lowercase SHA-256,
resolved automatic-focus coordinates, composition-model version, `created_at`,
and nullable `cleanup_after`. An upload master is deletable only when no event,
live draft, render set, or unexpired publication receipt refers to it.

### 9.2 `event_cover_drafts`

Each row has an opaque primary key, `event_id`, source (`new_upload` or
`existing_upload`), state (`reserved`, `transferred`, `ready`, `publishing`,
`published`, `failed`, or `expired`), nullable unique raw object key, nullable
declared filename/MIME/byte size, required master ID once ready, copied
automatic focus/model metadata, inspection recipe JSON, failure code,
created/updated timestamps, reservation expiry, and draft expiry. A new-upload
draft owns a temporary raw; an existing-upload draft references the active
master and has no raw. Indexes cover `(event_id, state)` and the expiry scan.
The raw key is never accepted back from a client; ownership is always resolved
from the event-scoped draft ID. Expiring an edit draft can never make its still-
active master cleanup-eligible.

### 9.3 `event_cover_render_sets` and objects

A set row contains opaque ID, event ID, master ID, nullable draft ID, canonical
recipe JSON and SHA-256, state (`staging`, `ready`, `active`, `retired`, or
`abandoned`), manifest SHA-256, nullable published revision, created/ready/
published timestamps, and nullable `cleanup_after`. A partial unique index
allows at most one active uploaded set per event.

`event_cover_render_objects` contains one row per required profile-density and
format with the render-set ID, allowlisted profile ID, density, `webp` or
`jpeg`, unique event-prefixed object key, content type, byte size, dimensions,
and SHA-256. The compound `(render_set_id, profile_id, density, format)` key
prevents missing or duplicate slots. A set becomes `ready` only after verifying
the exact manifest, R2 existence, dimensions, MIME, checksums, and byte budgets.

Built-in covers do not create per-event render rows. They resolve through the
versioned release-asset manifest for the selected preset and effect. Their
files live under a server-owned private R2 preset prefix and are returned only
through the same authorized cover endpoints, not as public asset URLs.

### 9.4 `event_cover_publish_receipts`

Each row is keyed by `(event_id, operation_id)` and stores the strict request
SHA-256, action (`publish`, `remove`, or `backfill`), expected revision, status
(`preparing`, `applied`, `conflict`, or `failed`), nullable draft/render-set
IDs, nullable preparation lease token/expiry, a non-negative
`preparation_lease_generation` starting at zero, nullable applied revision and
result cover JSON, plus created/updated and expiry timestamps. For a preset, the
first insert also pins the server-resolved asset version, immutable manifest
SHA-256, and recipe version; a resumed operation never re-resolves them against
a newer deployment. The first upload insert allocates the one stable render-set
ID and claims its lease. A duplicate with the same digest waits for, resumes
after expiry, or replays that same set; it never allocates a competitor. Every
status transition is conditional on the current status, digest, lease token,
and lease generation, so a late conflict or failed worker cannot overwrite
`applied`. Reuse with different bytes returns `409`. Applied receipts survive
for seven days so a response lost after commit cannot cause a second
publication.

The preparation lease lasts five minutes. Every initial claim, takeover, or
renewal atomically compares the current token/generation, increments the
generation, and installs a new token and expiry. Resumption after expiry
inventories and verifies deterministic existing objects before rendering
missing slots; it never assumes a partial set is valid. All set, receipt, and
final-publication mutations predicate on the exact current token-generation
pair.

Every R2 render write is an immutable conditional create. An existing key is
read and verified rather than overwritten. A worker that lost its lease may
finish an in-flight conditional create, but it cannot replace an object, mark a
set ready, activate a pointer, or mutate the receipt. The current fenced lease
owner either adopts a valid existing object into the manifest or fails and
abandons the set; stale work can never alter active bytes.

Every semantic publication includes the revision the Manager last read. The
final D1 transaction increments `cover_revision` exactly once only when that
expected revision still matches. A lost race returns a conflict with the latest
event view; it never deletes or overwrites the winning cover.

Object keys are deterministic beneath opaque IDs:

```text
events/{eventId}/cover/raw/{draftId}
events/{eventId}/cover/masters/{masterId}.webp
events/{eventId}/cover/rendered/{renderSetId}/{profile}-{density}.{format}
presets/event-covers/v{assetVersion}/{preset}/{effect}/{profile}-{density}.{format}
```

Cleanup first proves that an object is not the event pointer and is not
referenced by a live draft, render set, or receipt. It deletes the R2 object,
confirms success, and only then removes its D1 inventory row. The event deletion
workflow continues to remove the complete event prefix.

### 9.5 Legacy-cover cutover

There is no valid new-reader state that serves a legacy original or normalized
master. Release cutover therefore requires this ordered gate:

1. apply additive migration `0012` without changing guest reads;
2. install a compatibility reader and writer: new writes always create verified
   derivatives; reads use the active derivative when a set exists and retain
   the current legacy-original behavior only for an unbackfilled null-set row;
   this guarantees that changing `cover_object_key` to the normalized master in
   step 3 cannot make the old route stream that master;
3. for every `cover_object_key IS NOT NULL AND cover_render_set_id IS NULL`,
   inspect the legacy private object, create and verify a metadata-stripped
   normalized master and complete derivative set, then revision-guard the
   pointer update against the original key and null set;
4. repeat until there are zero legacy rows and verify every uploaded cover has
   one same-event active set with a complete manifest;
5. only then enable the new responsive reader, which has no original/master
   fallback; and
6. after the recovery window, delete replaced legacy originals and abandoned
   staging objects through reference-safe cleanup.

After the zero-legacy proof, `0013_event_cover_invariants.sql` adds tested
triggers that reject source/pointer mismatches and deletion of referenced
masters or sets. Migration tests cover a populated legacy database, an empty
database, interrupted backfill, a lost revision race, and rerunning the backfill
safely. No migration silently discards an existing cover.

## 10. Upload and image-processing pipeline

### 10.1 Input contract

Manager and create clients use the same constants and copy. Version 1 accepts
JPEG, PNG, WebP, and HEIC uploads up to 20 MB. The server verifies bytes,
declared MIME type, dimensions, and the event-scoped key after the direct R2
transfer. Animated input is reduced to a still cover.

PNG and WebP transparency is allowed, but it cannot produce format-dependent
edges. Every preview and final WebP/JPEG transform applies the fixed,
server-owned `#fffaf3` paper matte before the selected effect. The host cannot
change that value, and it never follows event-theme colors.

The image must have at least 1240 pixels on its shorter dimension and 1600
pixels on its longer dimension after orientation. This guarantees that every
required 2x crop can be produced without upscaling. Anything smaller is
rejected before it can replace the active cover. Inputs above the platform's
documented image-area or dimension ceiling are also rejected with a corrective
message rather than retried.

The raw upload is temporary. Successful inspection produces one canonical
still WebP master at quality `95`, with EXIF orientation applied,
`metadata: none`, animation disabled, a maximum 4096-pixel long edge, a maximum
16-megapixel area, no upscaling, and alpha retained when present. The master
inventory and R2 custom metadata record its codec, byte size, dimensions,
SHA-256, and recipe version. Candidary verifies the stored object and manifest
before deleting the raw. Failed inspection deletes the raw, marks the draft
failed, and publishes nothing. Neither raw nor master is a delivery source.

Inspection also returns one authorized, metadata-free, uncropped natural
preview capped at a 1280-pixel long edge. A versioned Candidary composition
worker runs saliency analysis on that preview locally, off the main thread, and
returns normalized focal coordinates. The server bounds and stores the result
with the model version on the event-scoped draft and master; it never accepts
dimensions, object keys, or transformation recipes from the client. A
low-confidence result uses center focus and keeps the same manual correction
path. `Done` remains disabled until this inspection result is durable. No
third-party image-analysis service receives the host's photo.

### 10.2 Bounded render profiles

One shared allowlisted registry owns six layout profiles that match the actual
guest hero states, each at 1x and 2x density. This avoids pre-cropping every
image to one shallow rectangle and then destructively cropping it again when a
welcome is expanded or the desktop frame appears.

| Profile | Exact layout state | 1x / 2x pixels | WebP 1x / 2x ceiling | JPEG 1x / 2x ceiling |
| --- | --- | ---: | ---: | ---: |
| `short-lookup` | ≤360 px wide and ≤600 px high lookup hero | 360×168 / 720×336 | 60 / 120 KiB | 90 / 180 KiB |
| `compact-default` | ≤390 px default hero | 390×205 / 780×410 | 70 / 140 KiB | 100 / 200 KiB |
| `standard-default` | 391–699 px unframed default hero, capped at 620 px | 620×218 / 1240×436 | 120 / 250 KiB | 180 / 360 KiB |
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

The registry owns the state names, breakpoints, dimensions, and budgets;
request query strings and user agents cannot invent them. Manager and Cover
Studio constrain their live canvas to the same 620-pixel guest maximum and use
the non-expanded branch unless explicitly rehearsing an expanded welcome.
`ResponsiveEventCover` measures its actual container and hero state before
installing sources, then exposes only that profile's 1x and 2x candidates. Its
WebP `<source>` and JPEG fallback use density descriptors, so
`sizes` is unnecessary and the browser downloads one format and the smallest
available density candidate within the selected profile. Resizing or changing
hero state may select a different allowlisted profile; brand or phone-model
detection never does.

Each active uploaded cover is materialized as 24 objects: six profiles, two
densities, and two formats. Only the selected effect is rendered; the pipeline
does not generate all five full-size effect sets for an event. Every file must
stay within its individual ceiling. If an output cannot meet its ceiling
without failing the approved visual-quality fixtures, publication fails and
the active cover remains unchanged.

Built-in covers are finite release assets rather than event-owned derivatives.
Each source begins from an art-directed master of at least 2400 × 1600. The
asset build produces the complete bounded matrix of six presets, five effects,
six profiles, two densities, and two formats: 720 versioned files representing
only six host-facing cover choices. Assets load on demand and are not all
pre-cached by the PWA. Theme overlays and the semantic text scrim are runtime
CSS, so the matrix is not multiplied by the four event themes and theme changes
never trigger image rendering.

Asset version 1 is immutable. Publishing a preset stores the server-resolved
`assetVersion: 1`, and delivery includes that version when resolving the private
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
produce at most five full-frame preview files, cached by draft, effect, and
recipe version. The browser applies focal positioning, zoom, and the measured
canvas crop locally to that file. Pointer/range movement performs no network
transform; superseded preview requests are canceled. `Done` replaces the local
preview with authoritative server outputs. Neither the browser nor a request
supplies pixel dimensions, trim rectangles, quality, or image-operation values.

### 10.3 Atomic publication

Publication follows this order:

1. authorize the manager write, strictly parse it, hash it, and atomically
   insert or load its `(event_id, operation_id)` receipt; the winning insert
   pins preset manifest/recipe dependencies or assigns the sole upload
   render-set ID, then claims a bounded fenced preparation lease;
2. return the stored result immediately when the same digest is already
   `applied`, reject the operation ID when its digest differs, and make a
   same-digest duplicate wait for or resume the same set after lease expiry;
3. resolve the upload draft or built-in preset from server-owned state;
4. for an upload, create or resume that receipt's stable staging set, write any
   missing objects with immutable conditional creates, and verify all 24; for a
   preset, verify the exact manifest and recipe already pinned on the receipt;
5. execute one D1 transaction whose guarded event update must match
   `expectedRevision`; it retires the previous uploaded set, activates the new
   uploaded set when applicable, updates `cover_config`, `cover_object_key`,
   `cover_render_set_id`, and `cover_revision`, marks the draft published, and
   marks the receipt applied with the resulting revision and safe cover view;
   every preparation and transaction transition must match the current lease
   token and generation;
6. return the full event view for ownership-aware client merging.

If the guarded event update matches no row, the transaction makes no active
pointer or lifecycle changes; the receipt becomes `conflict` and the staged set
becomes cleanup-eligible afterward. That transition is guarded by
`status = 'preparing'`, so a late worker can never overwrite an applied receipt.
If a response is lost after commit, replay returns the applied receipt instead
of incrementing revision again. Cleanup of the previous master or render set
happens only after the new pointer is durable and the recovery window has
passed.

## 11. Routes and delivery

The existing reservation/finalize routes evolve into a draft-and-publish
contract while retaining their current manager Origin, CSRF, owner/delegate,
and event-prefix checks.

The route responsibilities are:

- reserve an event-scoped upload draft and signed R2 transfer;
- inspect and normalize a transferred upload;
- create an edit draft from the event's active uploaded master without exposing
  its key;
- return authorized draft preview metadata;
- publish a strict `none`, preset, or upload recipe with `operationId` and
  `expectedRevision`;
- read or replay a durable publication receipt after an ambiguous response; and
- deliver one allowlisted render profile to an authorized guest or manager.

Guest and Manager delivery remain separate authenticated routes. The profile is
a path enum, not arbitrary width, height, quality, source, or effect input.
Every image URL contains the active revision so an already-mounted canvas cannot
keep the prior image after publish or removal:

```text
/api/event/{slug}/cover/{revision}/{profile}/{density}.{format}
/api/manage/events/{eventId}/cover/{revision}/{profile}/{density}.{format}
```

After authorization, the Worker requires the path revision to equal the active
event revision and resolves the source from server state. A preset maps to its
versioned release manifest; an upload maps to its same-event active render set.
A missing, stale, cross-event, or non-allowlisted request never falls back to a
master or object key. Successful delivery includes
`X-Content-Type-Options: nosniff` and the existing private `no-store` semantics.
The normalized master is never a guest response or a public URL.

The guest hero changes from a fetched blob installed as a CSS background to a
decorative responsive `<picture>`/`<img>` beneath the existing overlay and copy.
After the first container measurement, the component installs one profile with
a WebP 1x/2x `srcset` and a JPEG 1x/2x fallback. The browser selects
one format and density; it must not download both. Source URLs and the React
image key change with `cover.revision`, including when removal unmounts the
picture. The image has empty alternative text because event identity and
welcome copy already name the experience; picker tiles have explicit accessible
names.

If an active rendering is unexpectedly missing, the guest receives the
theme's no-cover hero rather than a broken image. The error is observable for
the host and operations, but it does not disclose object keys or storage state
to a guest.

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
- `ResponsiveEventCover` — the shared guest/Manager responsive image contract;
- an event-cover storage service — R2 keys, draft expiry, manifests, and cleanup;
  and
- an event-cover rendering service — Images binding calls, approved recipes,
  profile generation, and output verification.

Route handlers authorize and translate HTTP. They do not construct object keys,
transformation recipes, or cleanup rules inline. React components consume the
safe cover view and never receive R2 keys.

## 13. Accessibility and mobile interaction

- Source, theme, and style choices use native radio semantics with visible text
  and non-color selected indicators.
- Every control has at least a 44 × 44 CSS pixel target at 320 px and above.
- The sheet/dialog traps focus, names itself, restores focus on close, and
  confirms before discarding changed drafts.
- The full-screen sheet scroll-locks and inerts Manager, respects the bottom
  safe area, keeps the sticky canvas visible, and uses `visualViewport` changes
  only to keep the active control above the onscreen keyboard.
- Upload, inspection, preparation, success, and failure state changes are
  announced without repeatedly interrupting screen-reader users.
- The three native crop ranges expose their numeric bounds, step, and value
  text; drag and pinch are conveniences over the same state. The polite crop
  summary fires after an interaction settles, never for every intermediate
  value.
- Crop gestures are confined to the crop surface and never disable browser
  page zoom. The viewport does not set `user-scalable=no` or a restrictive
  maximum scale; sheet controls reflow rather than clipping at text and page
  zoom.
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
| Unsupported, mismatched, oversized, or undersized file | Refuse before publication, explain the correction, retain the active cover |
| Direct transfer interrupted | Offer retry or a fresh reservation; do not create an active cover |
| Inspection or normalization fails | Delete the raw draft, retain the active cover, allow a new choice |
| Preview rendering fails | Keep the studio open with the source and settings intact; offer retry |
| Full render set is incomplete | Do not update D1; preserve the active cover |
| Manager session expires | Stop retrying, preserve the draft for its expiry window, and direct the host to recover access |
| Two managers publish concurrently | Revision guard accepts one; the loser reloads the winning event and may reapply intentionally |
| Response is lost after `Done` | Reconcile the latest cover and replay the same operation ID; never create a second publication |
| Active derivative is unexpectedly missing | Render the no-cover theme hero for guests and surface an observable host/operations error |
| Cover removal fails | Keep the current cover active and offer retry |
| Studio is canceled | Delete or expire only draft objects; never touch the active set |

Reservations and unpublished drafts expire after 24 hours; abandoned staging
sets become eligible at the same deadline. Applied operation receipts are
retained for seven days. A retired set or replaced master receives
`cleanup_after = max(retired_at + 7 days, every referencing receipt.expires_at)`.
Conflict/failed receipts stop blocking abandoned-set cleanup at their expiry.
Event purge continues to own the final removal of every cover object under the
event prefix.

## 15. Verification and acceptance

### 15.1 Shared and unit coverage

- Strict parsing, canonical serialization, every preset/effect/profile ID, and
  rejection of unknown fields and out-of-range focus or zoom.
- Exactly six built-in presets and five effects, enforced independently of the
  four theme presets.
- Preset publication pins immutable `assetVersion`; introducing a newer
  manifest leaves existing event bytes and revision unchanged.
- Safe event projection never includes an object key or arbitrary URL.
- Theme/cover response ownership and existing autosave stale-response behavior.
- Source, effect, theme, automatic/manual focus, safe zoom maximum, and `none`
  removal combinations preserve canonical data.

### 15.2 Worker and storage coverage

- JPEG, PNG, WebP, and HEIC inspection fixtures, including MIME mismatch,
  EXIF rotation, GPS metadata, opaque and alpha-bearing inputs, low resolution,
  excessive image area, and interrupted transfers.
- Composition-worker saliency fixtures, bounded coordinate persistence,
  low-confidence center fallback, model-version replay, and main-thread
  responsiveness.
- Automatic and manual crop recipes, all five effect recipes, both output
  formats, and all allowlisted profiles.
- No upscaling, metadata removal, bounded object keys, manifest verification,
  and rejection of arbitrary dimensions or transforms.
- The canonical master codec/dimensions/checksum, exact 24-object uploaded
  manifest, all profile byte ceilings, and built-in release manifest.
- The staged-set/D1-pointer ordering, expected-revision conflict, same-operation
  concurrent lease/one-set behavior, replay after a committed lost response,
  preset dependency pinning across a deployment, operation-ID digest mismatch,
  stale-lease fencing and conditional-object writes, failed transformation,
  missing derivative fallback, delayed reference-safe cleanup, exact cleanup
  deadlines, draft/receipt expiry, and event-prefix purge.
- Guest and Manager authorization for every delivery profile, including wrong
  slug/event, stale revision, cross-event set, expired session, disabled entry,
  and deleted event.
- Migration `0012` on populated and empty fixtures, interrupted and repeated
  legacy backfill, zero-legacy-row cutover proof, and invariant enforcement.

### 15.3 Component and real-browser coverage

- The separate preview is absent and the live canvas changes immediately for
  all four themes while Manager controls retain global styling.
- Cover Studio Choose, Compose, Style, Done, Cancel, remove, retry, session
  expiry, discard-confirmation, and existing-upload re-edit/reset flows without
  a redundant upload.
- Keyboard crop adjustment, labelled controls, focus order/restoration, live
  announcements, reduced motion, and axe coverage.
- At 320 × 568, the live canvas, scrolling control pane, safe-area footer, dirty
  dismissal, browser Back, and visual-keyboard behavior remain operable without
  hidden focus or covered controls.
- Browser page zoom remains enabled. At 200% and 400% zoom, the sheet, sticky
  canvas, crop ranges, headings, and footer reflow without clipping or blocking
  the active control.
- Responsive source selection and visual crops at 320 × 568, 390 × 844,
  620 px guest width, the short lookup, expanded welcome, framed desktop,
  portrait, and landscape states. Publish, republish, and removal update the
  image immediately without remounting the parent canvas because every source
  URL carries the new revision.
- Profile-selection boundary tests cover 360/361, 390/391, 699/700 CSS pixels,
  viewport heights 599/600/601 and 759/760, all hero states, and the compacted
  studio canvas without leaving any state unmapped.
- Drag, pinch, and range movement issue zero transform requests; a draft creates
  no more than five effect preview files and cancels superseded effect requests.
- All `6 × 5 × 4 × 6 = 720` built-in cover/effect/theme/profile contexts clear
  text and meaningful-control contrast requirements. Representative dark,
  light, portrait, landscape, centered-subject, and edge-subject uploads receive
  visual regression coverage across all six profiles and both densities.
- Slow network and interrupted upload simulations never replace the active
  cover or show a broken guest hero.
- A newly published cover is never delivered from the high-resolution master
  and every fetched object remains within its exact profile, density, byte, and
  dimension budget. Tests assert that `<picture>` fetches only one format and
  one density candidate.

### 15.4 Physical-device acceptance

Before claiming device support, validate on physical:

- a small and current iPhone in Safari, portrait and landscape;
- a current Android phone in Chrome, portrait and landscape;
- VoiceOver on iPhone; and
- TalkBack on Android.

The pass requires file selection from each platform's photo picker, HEIC from
iPhone, automatic crop, drag/pinch, the accessible crop alternative, style
selection, interruption and retry, Done, and the final RSVP/photo-drop hero.
Automated WebKit or Chromium screenshots do not substitute for this evidence.

### 15.5 Deployed Images conformance

Local Worker/Vitest coverage proves schemas, recipes, orchestration, and failure
handling; it does not prove Cloudflare Images' production decoder or encoder.
Before production cutover, a separately authorized staging gate runs the real
Images binding against representative JPEG, opaque PNG, WebP, and iPhone HEIC
fixtures, including transparent PNG and WebP cases. It verifies orientation,
metadata/GPS removal, deterministic trim and
focal crops, all five effects, WebP/JPEG output, MIME and dimensions, checksums,
transparent-input matte parity between WebP and JPEG, and every byte ceiling.
That deployed evidence is required before applying the new reader to production
and is not implied by a local passing suite.

## 16. Release boundary

Implementation may add the migration, code, generated preset assets, and tests
locally. It does not authorize applying a remote D1 migration, mutating
production R2, deploying the Worker/assets, or claiming physical-device proof.
Those require their own explicit release authorization and evidence.

## 17. External platform references

The design relies on current Cloudflare Images behavior documented on
2026-08-03:

- the Images binding accepts private raw bytes from R2 and does not require a
  public source URL;
- normalized focal coordinates and explicit trim values are supported for the
  bounded crop recipe;
- HEIC input, metadata removal, still-image output, and the selected fixed
  color and transparency-matte operations are documented;
- transformed responses require explicit caching or materialization; and
- unique source/parameter combinations are billable transformations, which is
  why profiles and recipes are bounded allowlists.

References:

- <https://developers.cloudflare.com/images/optimization/binding/>
- <https://developers.cloudflare.com/images/optimization/features/>
- <https://developers.cloudflare.com/images/get-started/limits/>
- <https://developers.cloudflare.com/images/pricing/>

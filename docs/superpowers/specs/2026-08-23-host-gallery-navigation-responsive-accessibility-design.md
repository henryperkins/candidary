# Host Gallery Navigation, Responsive, and Accessibility Design

**Program:** [Host Gallery Roadmap](2026-08-23-host-gallery-roadmap-program-design.md)

**Slice:** 4 of 6

**Findings:** C-15, C-21, C-23, C-27, C-37, C-43, C-44, C-45, C-46, C-63, C-64

## Goal

Make every Manager and Gallery location addressable, preserve the host's task across navigation, keep large galleries continuous, and make the existing responsive and accessible behavior reliable at 320 px, 390 px, desktop, and keyboard/screen-reader boundaries.

## Existing systems retained

- The route remains `/manage/event/:eventId`; React Router owns navigation.
- The six existing Manager destinations and three Gallery modes remain.
- The current viewer remains the dialog reference implementation.
- Current CSS tokens, breakpoint strategy, Gallery cards, and controls remain.
- Existing Playwright geometry, accessibility, responsive, and visual suites are extended rather than replaced.

## Durable URL state

The canonical query keys are:

- `section=intake|rsvp|gallery|guestbook|share|settings`
- `mode=library|album|guest-gallery`, valid only when `section=gallery`

One `manager-location.ts` parser/serializer is shared by Manager navigation and recovery validation. Parameter names and decoded values are case-sensitive. The parser inspects every query pair rather than using first-value lookup, so duplicate known keys cannot be hidden. It returns `{ location, canonicalSearch, needsReplace }` and never mutates Router state itself.

| Input query | Parsed location | Canonical query |
| --- | --- | --- |
| empty | Intake | empty |
| `section=intake` | Intake alias | empty |
| `section=rsvp` | RSVP | `section=rsvp` |
| `section=guestbook` | Guestbook | `section=guestbook` |
| `section=share` | Share | `section=share` |
| `section=settings` | Settings | `section=settings` |
| `section=gallery` | Gallery Library | `section=gallery` |
| `section=gallery&mode=library` | Gallery Library alias | `section=gallery` |
| `section=gallery&mode=album` | Gallery Album | `section=gallery&mode=album` |
| `section=gallery&mode=guest-gallery` | Guest gallery | `section=gallery&mode=guest-gallery` |
| `section=gallery&mode=shared` | obsolete Guest-gallery alias | `section=gallery&mode=guest-gallery` |
| absent `section` plus any `mode` | Intake | empty |
| valid non-Gallery `section` plus any `mode` | named section | `section=<section>` |
| missing, blank, invalid, or duplicate `section` | Intake | empty |
| Gallery with missing, blank, invalid, or duplicate `mode` | Gallery Library | `section=gallery` |
| unknown keys, including duplicate unknown keys | ignored | removed |

A malformed or duplicate `section` wins over any otherwise-valid `mode` and falls back to Intake. An invalid or duplicate `mode` only falls back to Library when the parsed section is Gallery. On initial load and external, Back, or Forward navigation, Manager replaces a noncanonical search while preserving pathname, hash, and Router state. The Manager parser ignores the hash; recovery return URLs reject fragments at their existing security boundary. Host-initiated destination changes push history entries. No requested section or mode renders until the existing settlement boundary authorizes Router adoption, so Back traverses host work without bypassing Album preparation.

Recovery helpers use the same contract. `safeReturnTo` accepts only origin-relative `/host/events` or `/manage/event/<uuid>`, rejects credentials, another origin, protocol-relative input, fragments, unknown/duplicate keys, and any query on `/host/events`, then returns the shared serializer's canonical URL. `adoptTargetFor` compares the parsed Manager pathname/event ID rather than applying a path-only regular expression to the whole string. Thus query-bearing Manager returns survive sign-in/recovery without widening the open-redirect allowlist.

`ManagerPage` derives rendered section exclusively from the parsed URL instead of maintaining an independent destination source. `ManagerGalleryWorkspace` receives the canonical mode and requests mode changes rather than committing its own mode state. Click, Back, Forward, and programmatic transitions leaving Album all pass through the same settlement/blocker boundary before the new URL is adopted.

## Transient return intent

Internal controls may attach one-use Router state:

```ts
type ManagerSection = 'intake' | 'rsvp' | 'gallery' | 'guestbook' | 'share' | 'settings';
type GalleryMode = 'library' | 'album' | 'guest-gallery';
type PublicationFilter = 'all' | 'unpublished' | 'published' | 'hidden';

type GalleryAnchor =
  | {
      kind: 'media';
      mediaId: string;
      viewportOffset: number;
      fallbackScrollY: number;
      before: string[];
      after: string[];
    }
  | {
      kind: 'album-entry';
      entryId: string;
      viewportOffset: number;
      fallbackScrollY: number;
      before: string[];
      after: string[];
    };

type ManagerNavigationIntent =
  | { kind: 'focus-complete-export' }
  | { kind: 'focus-intake-heading' }
  | { kind: 'open-recently-deleted'; focusMediaId: string }
  | {
      kind: 'edit-guest-gallery-availability';
      returnTo: {
        section: 'gallery';
        mode: 'guest-gallery';
        publicationFilter: PublicationFilter;
      };
    };

type ManagerHistoryStateV1 = {
  version: 1;
  eventId: string;
  anchors?: Partial<Record<GalleryMode, GalleryAnchor>>;
  intent?: ManagerNavigationIntent;
};

type RouterHistoryState = Record<string, unknown> & {
  __candidaryManager?: ManagerHistoryStateV1;
};
```

Only a plain-object `__candidaryManager` with `version === 1` and an exact matching `eventId` is read. Every non-Candidary Router-state key is preserved. A valid anchors map survives intent consumption; invalid, incompatible, or cross-event intent is removed with `replace` and never executes. Compatibility is exact: `focus-complete-export` belongs to Gallery Library; `focus-intake-heading` and `open-recently-deleted` belong to Intake; `edit-guest-gallery-availability` is captured by Settings and its return intent belongs to Guest gallery. Consumption removes `intent` before focus work starts. If no anchors remain, the Candidary envelope is removed entirely. Before a push or blocker-mediated navigation, the current entry's anchor is written with `replace`; the target receives a cloned valid envelope plus any new intent. Reload may lose transient state and always falls back to the canonical durable URL.

Share-to-export and Guest-gallery-to-Settings use this state. The complete-export region gains a stable labelled heading/status wrapper with `tabIndex={-1}`. Share-to-export focuses that wrapper while its resource loads or fails, then moves to the complete-export action only when it exists and is enabled; zero-photo and active-job-disabled states retain focus on the wrapper instead of targeting an unfocusable native disabled button.

Slice 1's opaque Album marker pushes canonical Intake with `open-recently-deleted`. Intake consumes it once, selects its Recently deleted resource, and after the first bounded page settles focuses that media row's Restore control when present or the Recently deleted heading otherwise; the heading fallback announces that the retained photo may be under Load more. It never performs an unbounded page scan. Back returns to the Album entry. Reload intentionally loses the transient filter task and shows canonical Intake, while malformed/cross-event IDs are discarded and focus the Intake heading without disclosing whether a row exists.

For Guest-gallery-to-Settings, Settings captures the valid `edit-guest-gallery-availability` value for that mounted visit, focuses the existing availability control, and shows **Return to Guest gallery** without duplicating the toggle. That action serializes the stored `returnTo`, reattaches the same one-use intent to the new history entry, and navigates only after any Settings save settles. Guest gallery consumes it a second time, restores the exact publication filter, and focuses its existing Settings action. Reload or navigation to an unrelated destination discards this transient return path. Durable location remains in the query; transient task intent does not become a permanent public URL contract.

## Per-mode scroll and focus

Library and Guest gallery store media anchors; Album stores Album-entry anchors. The anchor is the first rendered item whose bottom is below the effective visible top (viewport top plus sticky-header obstruction). `viewportOffset` is the item's top minus that effective visible top, rounded to an integer CSS pixel. Capture at most 20 ordered IDs before and 20 after the anchor plus `fallbackScrollY`.

Before leaving a mode, Manager replaces the current history entry with that anchor. After the returning mode's initial resource settles and one animation frame lays it out, restoration chooses the exact ID, then alternates through `after[0]`, `before[0]`, `after[1]`, `before[1]`, and so on. It scrolls the chosen item back to the recorded viewport offset. When no recorded item survives, it clamps `fallbackScrollY` to document bounds. Restoration never fetches a page, changes a filter, or scans beyond rendered rows; a newer location/adoption generation cancels queued restoration.

Mode transitions that clear selection announce the reset. Closing the viewer, Cover Studio, a confirmation, or a failed navigation prompt restores the invoking control when it still exists; otherwise it follows the documented card/heading fallback.

## Viewer page continuity

`ManagerPrivateGallery` retains ownership of pagination. It passes the viewer a `loadNextPage` callback and whether a later page exists. Activating Next at the final loaded photo:

1. keeps the current photo visible;
2. requests the next page through the existing Gallery API/cursor path;
3. appends unique rows through the existing list state;
4. advances only after the new photo exists;
5. exposes Try again on failure without closing the viewer.

No separate viewer cache or pagination store is introduced.

The bridge is identity-based and returns an explicit result:

```ts
type ViewerContinuationOutcome =
  | { status: 'advanced'; nextPhotoId: string }
  | { status: 'exhausted' }
  | { status: 'failed' };

interface ViewerContinuationProps {
  photoId: string;
  onPhotoChange(photoId: string): void;
  hasMore: boolean;
  loadNextAfter(photoId: string): Promise<ViewerContinuationOutcome>;
}
```

At the last loaded photo, Next remains enabled and is named **Load next photo** while `hasMore` is true. Click or ArrowRight starts at most one continuation and retains the current photo and focus. The Gallery owner appends unique rows and returns `advanced` only when the immediate successor now exists, `exhausted` when no later page remains, and `failed` for a recoverable append failure. Failure retains the photo, exposes an in-dialog alert and **Try again**, and focuses that action. Exhaustion disables the normal **Next photo** control without an error. Closing does not remove successfully appended rows and keeps the existing invoker-focus contract.

## Responsive layout

At 390 by 844 px, the standard fixture has six delivered photos, a fresh audience summary, no active or terminal export, default Library mode, and no selection. Secondary Gallery explanation and export detail collapse behind existing disclosure patterns while the mode switch, audience summary, search/order, selection state, and first photo remain directly reachable. The first Library photo's bounding box starts before CSS pixel 844 and intersects the initial viewport without scrolling.

At 320 by 844 px, all six Manager navigation controls remain at least 44 by 44 CSS pixels, labels may wrap without reducing type size, and every pair of visible label bounding boxes has an empty intersection. Gallery modes retain full-width stacked 44 px controls when necessary.

All reviewed destinations retain:

- no page-level horizontal overflow;
- at least 44 by 44 px interactive targets;
- readable zoom/reflow at 200%;
- no content hidden behind sticky controls.

## Accessibility

The already-tested viewer pattern remains the modal standard. Cover Studio and destructive confirmations use its focusable-element ordering, Tab/Shift+Tab containment, `aria-modal`, Escape behavior where safe, inert-background handling, and return-focus path.

Album reorder preserves focus on the invoked directional control and announces item name plus new position. Undo remains reachable in the persistent recovery region. Visible action text is included in accessible names; icon-only controls retain literal complete labels.

Axe coverage in this slice uses named fixtures for Intake default, filtered, and Recently deleted; RSVP; Library default, selection, tray, and viewer; Album editor, Preview, create-link dialog, live-link state, and stop-link alertdialog; Guest gallery all/unpublished/published/hidden filters plus single and bulk write states; Guestbook; Share; Settings; the Album-leave prompt; the RSVP/settings pending-work prompt; move-to-Recently-deleted dialog; entry rotation and disable confirmations; and public Album nonempty and empty. Slice 5 adds its host-upload state to the same matrix when that state exists.

## Public Album URL/image regressions

The current post-review fixes remain authoritative:

- secret-fragment cleanup runs only when a token fragment exists and preserves pathname/query;
- cookie-only loads do not rewrite the URL;
- cover image failure state is keyed by media ID;
- a changed cover ID gets a fresh image state.

These receive focused regression tests, not another URL or image-state abstraction.

## Verification

- Router-table tests for `/manage/event/:eventId` and reload/Back across Intake, RSVP, Guestbook, Share, Settings, and Gallery in Library/Album/Guest-gallery modes; the legacy `?section=rsvp` case is explicit
- Parser/serializer and `safeReturnTo`/`adoptTargetFor` tests for canonical default omission, redundant defaults, all valid section/mode pairs, `mode` outside Gallery, obsolete Shared normalization, invalid/duplicate/unknown keys, queries on Host Events, fragments, mismatched event IDs, credentials, absolute URLs, and protocol-relative URLs
- Exact one-use return/focus intent tests, including complete-export loading/failure, zero-photo, active-job-disabled, enabled-action settlement, and opaque-marker → Recently deleted row/heading behavior under Back/reload/malformed/cross-event state
- Deep Library → Guest gallery → Library anchor restoration
- Viewer success/failure across a page boundary
- 320 px nav label intersection and 390 px first-photo geometry assertions
- Target-size, overflow, sticky-overlap, and 200% reflow checks
- Keyboard focus traces for every modal, reorder, Undo, and return intent
- Axe scans with named fixtures: Intake default/filtered/Recently deleted; RSVP; Library default/selection/tray/viewer; Album editor/Preview/share/stop-share; Guest gallery each filter plus bulk state; Guestbook; Share; Settings; every current confirmation; and public Album nonempty/empty. Slice 5 owns the host-upload fixture extension
- Public query/cookie/fragment and changed-cover regressions

## Non-goals

- New nested Manager routes
- Persisting search/scroll state across devices or browser sessions
- Replacing React Router
- A second viewer data store
- Visual redesign outside the reviewed density, collision, and state-orientation issues

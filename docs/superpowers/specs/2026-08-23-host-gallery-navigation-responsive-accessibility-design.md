# Host Gallery Navigation, Responsive, and Accessibility Design

**Program:** [Host Gallery Roadmap](2026-08-23-host-gallery-roadmap-program-design.md)

**Slice:** 4 of 6

**Findings:** C-15, C-21, C-23, C-27, C-37, C-43, C-44, C-45, C-46, C-63, C-64

## Goal

Make every Manager and Gallery location addressable, preserve the host's task across navigation, keep large galleries continuous, and make the existing responsive and accessible behavior reliable at 320 px, 390 px, desktop, and keyboard/screen-reader boundaries.

## Existing systems retained

- The route remains `/manage/event/:eventId`; React Router and `useSearchParams` own navigation.
- The six existing Manager destinations and three Gallery modes remain.
- The current viewer remains the dialog reference implementation.
- Current CSS tokens, breakpoint strategy, Gallery cards, and controls remain.
- Existing Playwright geometry, accessibility, responsive, and visual suites are extended rather than replaced.

## Durable URL state

The canonical query keys are:

- `section=intake|rsvp|gallery|guestbook|share|settings`
- `mode=library|album|guest-gallery`, valid only when `section=gallery`

One `manager-location.ts` parser/serializer is shared by Manager navigation and recovery validation. Canonical serialization is: Intake has no query; RSVP, Guestbook, Share, and Settings carry only `section`; Gallery Library is `?section=gallery`; Album and Guest gallery add `mode=album|guest-gallery`. The parser accepts redundant `section=intake` and `mode=library` as aliases, maps obsolete `mode=shared` to Guest gallery, removes `mode` outside Gallery and unknown keys, and normalizes with `replace`. Invalid/duplicate section falls back to Intake; invalid/duplicate Gallery mode falls back to Library. Existing `?section=rsvp` links remain valid. User state changes push history entries so Back traverses host work before leaving the application.

Recovery helpers use the same contract. `safeReturnTo` accepts only origin-relative `/host/events` or `/manage/event/<uuid>`, rejects credentials, another origin, protocol-relative input, fragments, unknown/duplicate keys, and any query on `/host/events`, then returns the shared serializer's canonical URL. `adoptTargetFor` compares the parsed Manager pathname/event ID rather than applying a path-only regular expression to the whole string. Thus query-bearing Manager returns survive sign-in/recovery without widening the open-redirect allowlist.

`ManagerPage` derives rendered section exclusively from the parsed URL instead of maintaining an independent destination source. `ManagerGalleryWorkspace` is controlled by that mode. Click, Back, Forward, and programmatic transitions leaving Album all pass through the same settlement/blocker boundary before the new URL is adopted.

## Transient return intent

Internal controls may attach one-use Router state:

```ts
type PublicationFilter = 'all' | 'unpublished' | 'published' | 'hidden';

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
```

Share-to-export and Guest-gallery-to-Settings use this state. The compatible destination captures a valid intent, removes only the intent field with `replace`, preserves the same entry's Gallery-anchor state, then performs focus/return work; malformed or destination-incompatible intent is ignored and removed on the same terms. The complete-export region gains a stable labelled heading/status wrapper with `tabIndex={-1}`. Share-to-export focuses that wrapper while its resource loads or fails, then moves to the complete-export action only when it exists and is enabled; zero-photo and active-job-disabled states retain focus on the wrapper instead of targeting an unfocusable native disabled button.

Slice 1's opaque Album marker pushes canonical Intake with `open-recently-deleted`. Intake consumes it once, selects its Recently deleted resource, and after the first bounded page settles focuses that media row's Restore control when present or the Recently deleted heading otherwise; the heading fallback announces that the retained photo may be under Load more. It never performs an unbounded page scan. Back returns to the Album entry. Reload intentionally loses the transient filter task and shows canonical Intake, while malformed/cross-event IDs are discarded and focus the Intake heading without disclosing whether a row exists.

For Guest-gallery-to-Settings, Settings captures the valid `edit-guest-gallery-availability` value for that mounted visit, focuses the existing availability control, and shows **Return to Guest gallery** without duplicating the toggle. That action serializes the stored `returnTo`, reattaches the same one-use intent to the new history entry, and navigates only after any Settings save settles. Guest gallery consumes it a second time, restores the exact publication filter, and focuses its existing Settings action. Reload or navigation to an unrelated destination discards this transient return path. Durable location remains in the query; transient task intent does not become a permanent public URL contract.

## Per-mode scroll and focus

Gallery stores an anchor per event and mode in the current history entry: the first visible media/entry ID plus its offset, with scrollY as a fallback. Before leaving a mode it records the anchor. After the returning mode has laid out, it restores the same item and offset; if the item disappeared, it restores the nearest surviving neighbor or bounded scroll value.

Mode transitions that clear selection announce the reset. Closing the viewer, Cover Studio, a confirmation, or a failed navigation prompt restores the invoking control when it still exists; otherwise it follows the documented card/heading fallback.

## Viewer page continuity

`ManagerPrivateGallery` retains ownership of pagination. It passes the viewer a `loadNextPage` callback and whether a later page exists. Activating Next at the final loaded photo:

1. keeps the current photo visible;
2. requests the next page through the existing Gallery API/cursor path;
3. appends unique rows through the existing list state;
4. advances only after the new photo exists;
5. exposes Try again on failure without closing the viewer.

No separate viewer cache or pagination store is introduced.

## Responsive layout

At 390 px, secondary Gallery explanation and export detail collapse behind existing disclosure patterns while the mode switch, audience summary, search/order, selection state, and first photo remain directly reachable. A Library photo must begin within the first 844 px viewport in the standard fixture.

At 320 px, Manager navigation permits label wrapping and increases its row height rather than shrinking targets or type. Adjacent label bounding boxes must not intersect. Gallery modes retain full-width stacked 44 px controls when necessary.

All reviewed destinations retain:

- no page-level horizontal overflow;
- at least 44 by 44 px interactive targets;
- readable zoom/reflow at 200%;
- no content hidden behind sticky controls.

## Accessibility

The already-tested viewer pattern remains the modal standard. Cover Studio and destructive confirmations use its focusable-element ordering, Tab/Shift+Tab containment, `aria-modal`, Escape behavior where safe, inert-background handling, and return-focus path.

Album reorder preserves focus on the invoked directional control and announces item name plus new position. Undo remains reachable in the persistent recovery region. Visible action text is included in accessible names; icon-only controls retain literal complete labels.

Axe coverage in this slice includes Intake, RSVP, Library, selection mode/tray, Album editor, Preview, sharing, Guest gallery filters and writes, Guestbook, Share, Settings, confirmation dialogs, Recently deleted, and the public Album. Slice 5 adds its host-upload state to the same matrix when that state exists.

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

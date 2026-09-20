# Consolidated host Library — approved design

**Status:** Approved in the task conversation on September 14, 2026.

**Scope:** Consolidate the host Intake and Library surfaces. Preserve the approved Photo Wall design and the existing Album and Guest gallery responsibilities.

## Problem and intended outcome

Intake and Library expose the same delivered originals with different controls. A host currently has to learn which screen contains an action, even though neither screen represents a separate stage of the photo lifecycle.

Library becomes the complete workspace for delivered originals. Gallery becomes the default photo entry point and opens Library. Remove the separate Intake navigation item and collection screen.

## Information architecture

| Surface | Host's job |
| --- | --- |
| Library | Browse all delivered originals; add photos, select, download, and manage files. |
| Album | Choose photos, arrange them, set the cover, and manage the Album link. |
| Guest gallery | Manage the previews published to event guests. |
| Trash | Recover photos removed from Library; a Library utility, not a fourth Gallery mode. |

Private delivery remains independent of album membership and guest publication. Preserve the existing distinctions among original downloads, exports, Album links, and Guest gallery visibility.

## Library composition

- Keep the compact event heading and Event details disclosure.
- Keep the Library heading and collection count, with **Add photos** as the primary action.
- Keep the three Gallery modes: **Library**, **Album**, **Guest gallery**.
- Keep search across contributor, caption, and filename; **All photos / In album**; and timeline ordering.
- Keep **Exports** and **Trash** as secondary utilities.
- Keep the two-column phone Photo Wall and the wider desktop grid.
- A photo opens the viewer. Each tile shows its contributor and a separate **Add to album / In album** action.
- Keep publication badges and publication controls in Guest gallery.
- At 320 × 568, photos must appear in the opening viewport. Avoid another introductory block above the collection.

The visual authority remains `DESIGN.md`, `design/design-system.md`, and the approved Photo Wall surface brief at `.impeccable/surfaces/src-features-gallery-managerprivategallery-tsx.md`. Use the existing warm paper, Manrope/DM Sans, chestnut action, denim selection, and moss success system. No new imagery or replacement visual direction is needed.

## New deliveries

The host explicitly chose **“Show an ‘N new photos’ control and keep the current grid steady.”**

- Check for new deliveries while Library is visible.
- Show a control with the number of confirmed deliveries matching the current Library view.
- Checking must leave the grid, viewer, selection, and scroll position steady.
- Activating the control incorporates new deliveries using the current search, filter, and ordering.
- Preserve selection and meaningful keyboard focus when incorporating arrivals.
- A failed check retains the confirmed collection and allows a quiet retry.
- Count actual deliveries. A change in total photo count, a deletion, a restoration, or loading another page is not itself a new delivery.
- Support empty collections through the existing 10,000-photo event limit using pagination.

## Viewer and file actions

The host explicitly chose **“In the photo viewer; keep Add to album as the visible tile action.”**

- Preserve previous/next navigation, contributor, caption, filename, and album membership control.
- Add **Download original** and a visually separated **Move to Trash** action in the viewer.
- Preserve the current deletion confirmation's consequences and recovery limits. Initially focus **Keep photo**.
- After confirmed deletion, advance to the next available photo. When none remains, close the viewer and restore meaningful Library focus.
- Preserve the existing Undo action and server-defined recovery deadline.
- Keep failed or ambiguous operations distinguishable from successful deletion or an empty collection.

## Trash and recovery

- Open Trash from Library, with **Back to Library**.
- Preserve the existing metadata list, pagination, exact server deadline, expired states, and Restore behavior.
- Preserve links and navigation intents that target a particular recoverable photo, including a photo on a later page.
- Returning to Library should recover the host's browsing context.

## Add photos

- Reuse the existing manager upload session and lifecycle.
- Give the manager upload dialog explicit manager styling: a clear header, a properly sized close button, visible source actions, and a modal-sized body.
- Apply manager tokens at the dialog's portal boundary; the dialog must not depend on guest event theme inheritance.
- Preserve progress, cancellation, partial delivery, cleanup, and recovery behavior.
- Update manager-only receipts and destinations to **Library**.
- Restore focus to **Add photos** on close.
- Reconcile confirmed delivered IDs with Library without discarding the browsing context.

## Compatibility and acceptance

- Existing Intake URLs must reach the equivalent Library destination.
- Preserve browser Back/Forward, manager return paths, dirty-editor navigation guards, and recovery intents.
- Preserve existing file limits, capacity accounting, access controls, and publication semantics.
- Interactive targets must be at least 44 × 44 CSS pixels; retain existing 48-pixel form controls.
- Verify desktop, 390 × 844, and 320 × 568 rendering; keyboard order and focus; overflow; reduced motion; and retained data after failures.
- Browser fixture evidence must be labelled as local evidence. It does not establish production delivery, native-device behavior, or screen-reader compatibility.

## Audit evidence

The preceding audit used current source at `3408317ca81e3bb12d5c40af502cc636749d8c0c` and Chromium with local intercepted API fixtures. Its report and screenshots are under `output/playwright/intake-audit-2026-09-14/` (ignored local artifacts).

The main observations were duplicated collection responsibilities, Intake photos below the opening phone viewport, and missing manager-specific upload styling. The existing Library Photo Wall supplies the approved foundation for consolidation.

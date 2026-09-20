---
version: 1
slug: "src-features-gallery-managerprivategallery-tsx"
primary_target: "src/features/gallery/ManagerPrivateGallery.tsx"
related_targets: ["src/features/gallery/GalleryTimeline.tsx","src/features/gallery/GalleryMoment.tsx","src/features/gallery/ManagerGalleryWorkspace.tsx"]
---

# Library Photo Wall

Mode: Operate. Hosts browse delivered photos from guests and manager uploads, and add individual photos to the Album immediately. Approved on 2026-09-13: "Photo Wall."

## Direction contract

THESIS: The photos and a direct Add to album action own Library; export and audience management are secondary.

OWN-WORLD: Inherit Candidary's warm paper, Manrope and DM Sans, Chestnut actions, Denim navigation and Moss confirmed state; restrained opaque controls and fine rules.

STORY: Identify a photo by its image and contributor, inspect it if needed, add it immediately, see confirmation, and continue browsing. Undo reverses the latest addition.

FIRST VIEWPORT: A compact Library heading and count, Add photos and secondary Trash/Exports utilities, three Gallery modes (Library, Album, Guest gallery), embedded search, All photos filter and Newest ordering, then a continuous two-column phone photo grid. Each image has a contributor line and a 44px labelled Add to album or In album control beneath it. Wider screens expand the grid within the existing Manager shell.

FORM: Photo Wall, candidate 5, surface seed fdcda64b. Approved comp: `.impeccable/mocks/decision/library-2026-09-12/photo-wall.png`.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implementation invariants

Album membership uses the existing server API. Confirmed In album state follows request success; pending and failures stay visible. Thumbnail activation opens the viewer; the separate album control mutates membership. Guest gallery visibility and link activation remain independent. Search continues matching contributor, caption and filename. The wall preserves chronological/source order and existing pagination/anchor behavior. Existing export and bulk functions remain reachable in secondary controls. Product photos remain runtime guest media; the comp's synthetic photos are illustrative content, not new shipping assets. Use existing representative test photos for rendered validation. A single latest-action Undo replaces duplicated illustrative Undo labels in the generated comp.

## Consolidated Library integration — 2026-09-15

Library is the manager default. Old Intake URLs and version-1 history aliases resolve to Library; Settings retains Photo intake policy. Trash is a metadata recovery subview under Library, with Back to Library and targeted retained-photo restoration. The Photo Wall stays mounted and suspends reads while Trash is open, retaining browsing and selection state.

A reserved arrival notice reports the confirmed matching count. Background checks do not insert photos. Deliberate acceptance stages a snapshot window through the prior loaded boundary, preserves query/filter/order/selected IDs and restores a rendered photo anchor. Manager upload finalizations signal arrivals with event-scoped ID deduplication; terminal/close reconciliation refreshes manager counts.

The viewer exposes authenticated Download original and Move to Trash. Confirmation keeps one modal, initial Keep photo focus, a visible heading/action area and independently scrollable consequence copy. Successful removal advances or returns to Library; the existing single Undo bar uses the body live host and stays keyboard reachable with the viewer. Manager upload chooser and receipt use manager paper/chestnut tokens and bounded portal cards, retaining the established upload/cancellation/recovery lifecycle.

Rendered acceptance uses local intercepted APIs and existing photographic fixtures at 1440×1000, 390×844 and 320×568. It does not establish production transport/download delivery, native camera/picker behavior or screen-reader announcements. Independent integration review is recorded separately in the task report.

---
version: 1
slug: "src-features-gallery-managerprivategallery-tsx"
primary_target: "src/features/gallery/ManagerPrivateGallery.tsx"
related_targets: ["src/features/gallery/GalleryTimeline.tsx","src/features/gallery/GalleryMoment.tsx","src/features/gallery/ManagerGalleryWorkspace.tsx"]
---

# Library Photo Wall

Mode: Operate. Hosts browse delivered guest photos and add individual photos to the Album immediately. Approved on 2026-09-13: "Photo Wall."

## Direction contract

THESIS: The photos and a direct Add to album action own Library; export and audience management are secondary.

OWN-WORLD: Inherit Candidary's warm paper, Manrope and DM Sans, Chestnut actions, Denim navigation and Moss confirmed state; restrained opaque controls and fine rules.

STORY: Identify a photo by its image and contributor, inspect it if needed, add it immediately, see confirmation, and continue browsing. Undo reverses the latest addition.

FIRST VIEWPORT: A compact Library heading and count, local mode navigation, embedded search, All photos filter and Newest ordering, then a continuous two-column phone photo grid. Each image has a contributor line and a 44px labelled Add to album or In album control beneath it. Wider screens expand the grid within the existing Manager shell.

FORM: Photo Wall, candidate 5, surface seed fdcda64b. Approved comp: `.impeccable/mocks/decision/library-2026-09-12/photo-wall.png`.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Implementation invariants

Album membership uses the existing server API. Confirmed In album state follows request success; pending and failures stay visible. Thumbnail activation opens the viewer; the separate album control mutates membership. Guest gallery visibility and link activation remain independent. Search continues matching contributor, caption and filename. The wall preserves chronological/source order and existing pagination/anchor behavior. Existing export and bulk functions remain reachable in secondary controls. Product photos remain runtime guest media; the comp's synthetic photos are illustrative content, not new shipping assets. Use existing representative test photos for rendered validation. A single latest-action Undo replaces duplicated illustrative Undo labels in the generated comp.

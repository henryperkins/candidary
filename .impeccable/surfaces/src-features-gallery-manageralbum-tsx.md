---
version: 1
slug: "src-features-gallery-manageralbum-tsx"
primary_target: "src/features/gallery/ManagerAlbum.tsx"
related_targets: ["src/features/gallery/AlbumDelivery.tsx", "src/features/gallery/album-organizer.css"]
---

# Album organizer

Mode: Operate. Hosts arrange the photos already in their album, sort or filter them, and export or download the originals. This is a focused refit of the existing surface within the established Candidary world.

## Direction contract

THESIS: The photo sequence is the workspace. Filtering, sorting, and delivery surround that sequence with the minimum necessary controls.

OWN-WORLD: Inherit Candidary's bundled typography, warm opaque surfaces, Chestnut actions, Denim selection, fine rules, and 44–48px controls.

STORY: Find a photograph, put it in place, see its order save, then download the album or choose a destination.

FIRST VIEWPORT: A compact Album heading and Export / Download Album actions; a short saved-status line; Filter and Sort; then a continuous two-column phone grid that expands on desktop. Album settings fold below the sequence. The signature interaction is a visible insertion boundary during dragging, with equivalent move buttons. State changes use restrained 180ms transitions and respect reduced motion.

FORM: Directly shaped from the user's precise scope and the existing Album implementation. No concept seed: this is a bounded extension, not an open visual-world round. Runtime guest photos are the artwork; no new shipping rasters.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Invariants

Filtering never changes export membership. Sort saves the photo order within existing sections. Dragging and move buttons use the existing autosave and conflict handling. Exports settle pending edits first and preserve existing busy/error/retry behavior. The user chose future connection controls: OneDrive, Google Photos, and iCloud must be disabled and explicitly marked Coming soon. Retained deleted-photo slots remain opaque. Existing settings and sharing remain reachable in a collapsed secondary disclosure.

## Focused verification

Run the album organizer UI tests, the focused Album export-control tests, and the album organizer browser scenario at desktop and phone widths. Capture settled screenshots in one batched inspection; one correction and confirmation pass at most. No repository-wide gates.

## Implementation note — 2026-09-13

The finished Album surface extends the existing Quiet Event Ledger. The compact event header now also applies to Album. A 1.6rem Manrope task heading and .875rem DM Sans controls sit above the saved state, visible Filter and Sort labels, and photo sequence. The organizer locally binds `--field: #fffdf8` to the existing documented Field color; this is scoped to Album and adds no global token rule. The grid keeps two columns through the phone range (up to 760px) and expands with 180px minimum photo widths on desktop. Photographs have square previews, position labels, visible drag handles, and equivalent move controls; Album settings remain below the sequence.

`AlbumDelivery` owns the Export and Download Album actions and the inline destination/download panels. OneDrive, Google Photos, and iCloud are disabled and marked Coming soon. The download panel reuses `AlbumExportControl` with `showPrepareAction={false}` so the primary preparation action appears once. Controls retain the existing 44px touch floor, 48px primary actions, Focus outline, and reduced-motion behavior. Runtime photographs use the existing media preview API; no shipping raster was added.

Documentation checked the implementation and the five supplied `album-surface-2026-09-13-` captures under `.impeccable/review/`: desktop/mobile organizer, desktop/mobile delivery, and 320px. The existing palette, typography, and shared rules remain authoritative; `DESIGN.md` and `.impeccable/design.json` were preserved. This handoff did not repeat tests or establish physical-device or assistive-technology evidence.

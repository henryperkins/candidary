# Candidary Host Private Gallery Design

**Date:** 2026-08-13

**Status:** Approved direction; revised after technical review; final-review findings incorporated 2026-08-14

**Repository baseline:** `b293ee42c35cc30c19b86cd1ff4737ad54857755`

**Current-main validation:** Rechecked against `d1d94a2a7c59b41e7a2f63ed6b89d3cb2371eac5`; every implementation file named by this specification is byte-identical between the two revisions.

## 1. Decision

Candidary's Manager Gallery becomes a host-only private memory library by default.

The host opens Gallery to a chronological stream of every stored, non-deleted photo. Candidary uses a trustworthy embedded capture time when available and otherwise uses the time the photo was received. Photos are divided into simple, unnamed time-based moments and displayed as responsive mosaics. A moment begins compact and expands inline. Opening a photo enters an immersive viewer that preserves the host's place in the timeline.

The private Gallery supports only four library actions:

1. search by contributor name, caption, or original filename;
2. mark or unmark a photo as a shared event favorite;
3. open and move through photos in the immersive viewer; and
4. prepare the existing complete all-original export through one **Download all** action.

The existing guest-facing shared gallery remains a separate secondary mode inside Gallery. It retains the current unpublished, published, and hidden publication workflow. Private favorites do not publish photos, and publication status does not affect the private timeline or complete export.

This specification replaces the current host Gallery presentation in `src/pages/ManagerPage.tsx`. It does not replace Live Intake, the guest upload journey, the guest-facing gallery route, media retention, or the existing complete-export guarantees.

## 2. Why this change

The current Manager Gallery is the same media grid used by Live Intake with publication filters, selection checkboxes, and publish or hide controls added. That makes the host think about moderation even when the real post-event job is to revisit the private collection and retrieve the originals.

Candidary's product hierarchy already says private delivery comes first and optional sharing comes second. The host Gallery should express that hierarchy directly:

- **Private Gallery** answers, "What did everyone send, and what happened across the day?"
- **Shared Gallery** answers, "Which previews may guests see?"
- **Live Intake** answers, "What is arriving now, and do I need to act on an original?"
- **Download all** answers, "How do I retrieve the complete collection?"

The redesign separates those jobs without creating an album editor or a digital-asset-management system.

## 3. Goals

- Make the full private collection pleasant to revisit after an event.
- Present photos in the most credible available chronology.
- Keep the first Gallery view visually rich without loading every preview at once.
- Let a host quickly find photos through one basic search field.
- Provide one lightweight keeper signal through event-shared favorites.
- Preserve the existing complete, source-bounded export rather than adding selective archives.
- Keep shared-gallery publication available without letting it dominate the private experience.
- Remain usable at the documented 10,000-photo event limit.
- Preserve Candidary's privacy, accessibility, responsive-layout, and server-authoritative-state commitments.
- Keep the implementation isolated from Live Intake and the guest upload flow.

## 4. Non-goals

This version does not include:

- manual moment names;
- moment merge, split, or boundary editing;
- dragging or manually reordering photos;
- a host-selected lead image;
- automatic visual similarity detection;
- face recognition, object recognition, or semantic image search;
- custom albums, collections, tags, notes, or keeper categories;
- photo comparison;
- per-manager or private favorites;
- selective ZIP exports;
- individual-original download controls inside Gallery;
- batch selection inside the private Gallery;
- editing guest captions or filenames;
- publishing from the private viewer;
- a redesign of the guest-facing shared gallery;
- a legacy-object metadata backfill;
- live five-second polling or automatic reordering while the host is browsing; or
- changes to event quotas, retention, accepted image formats, or export partitioning.

Deleting an original remains a Live Intake action. Gallery does not become a second deletion surface.

## 5. Product model

### 5.1 Private Gallery is the default

Selecting **Gallery** opens the private timeline. The host does not first encounter publication statuses, checkboxes, or moderation language.

The private timeline includes every media row that is:

- scoped to the authorized event;
- in the `stored` upload state;
- not deleted; and
- available to the manager regardless of publication status.

A favorite is an event-level property of the photo. Any authorized manager sees the same favorite state. Favoriting does not change chronology, mosaic prominence, publication, retention, or export membership.

### 5.2 Shared Gallery is a secondary mode

Gallery contains a two-option mode switch:

- **Private gallery**
- **Shared gallery**

The private mode is selected whenever Gallery is entered unless the same mounted Gallery workspace already has Shared gallery open.

Shared gallery preserves the existing publication concepts:

- unpublished;
- published; and
- hidden.

A fresh Shared gallery visit opens on **unpublished**, matching the current publishing workspace. If Shared gallery has already been used during the same mounted Manager visit, it preserves that confirmed status filter.

Shared gallery retains batch publish and batch hide. It does not inherit private favorites, timeline moments, the immersive private viewer, or Download all behavior. The guest-facing `/api/event/:slug/gallery` contract remains limited to stored, published, non-deleted media.

### 5.3 Live Intake remains operational

Live Intake remains the place for current arrivals, contributor filtering during the event, individual-original retrieval, and irreversible deletion. It may continue visibility-aware polling.

Private Gallery is deliberately calmer. It reads on entry, search or clear, Favorites-filter changes, chronological pagination, explicit retry, and re-entry. A favorite write patches the confirmed row in place and does not reload the timeline. Private Gallery does not reorder itself beneath the host when delayed uploads arrive. Re-entering or reloading Gallery produces the latest canonical timeline.

## 6. Private Gallery interface

### 6.1 Header

The Gallery header contains:

- the Private gallery / Shared gallery mode switch;
- the title **Private gallery**;
- a quiet total such as **842 photos**;
- one **Download all** action; and
- the existing export progress or ready state after that action is used.

In Shared mode the same header shows the title **Shared gallery**, replacing the current **Gallery publishing** heading, while the publication filter tabs and batch controls remain unchanged.

The quiet total uses the existing event-level stored-media count and always describes the complete private collection; it does not change into a filtered search count.

**Download all** starts the existing complete event export. Its photo membership is every stored, non-deleted original in the event. Under the post-0015 export contract, the same logical archive also contains the manifest and the printable and private Guestbook artifacts when those artifacts exist. Supporting copy names those contents; the broad button label is intentional.

Search text, favorite state, current moment expansion, and publication status never narrow the export. The existing export Workflow may still produce multiple numbered ZIP parts under its source-byte cap. The host starts that complete export from one action and sees one logical job. Gallery does not promise one physical ZIP file.

The duplicate manager export entry point currently placed in Share or the responsive utility treatment should be removed or replaced with a plain route back to Gallery. There should be one canonical **Download all** action backed by the existing export job.

**Download all** is the single prepare entry point, not a second export pipeline. After the job becomes ready, the existing export panel's ready-state download and retry controls remain available and belong to the same logical job; they are not additional entry points and are not duplicated.

### 6.2 Search and favorites

The private Gallery has one search form:

- label: **Find photos**
- placeholder: **Contributor, caption, or filename**
- submit action: **Search**
- clear action when a query is active

The submitted query is trimmed, must contain between 1 and 120 Unicode code points after trimming, and is matched as a literal substring across:

- `guest_name`;
- `caption`; and
- `original_filename`.

Search performs ASCII case folding only, matching SQLite/D1's built-in `lower()` behavior. Non-ASCII code points are compared exactly. For example, `JOSE` matches `Jose`, while uppercase `É` does not fold to lowercase `é`. The interface does not promise full Unicode case-insensitive matching.

The repository query uses `instr(lower(column), lower(?)) > 0`, with `COALESCE(caption, '')` for the nullable caption. Percent and underscore characters are therefore literal search characters rather than SQL wildcards. Search does not inspect pixels or infer who or what appears in a photo.

Beside search is one toggle labeled **Favorites**. When active, the result set contains only favorited photos. Search and Favorites may be combined.

Changing search or Favorites:

1. clears the current timeline cursor;
2. closes the immersive viewer;
3. discards moment expansion state;
4. requests the first page for the new result set; and
5. moves focus to the result summary or empty-state heading.

No date picker, contributor facet, chronology-confidence control, status filter, or saved search is added.

### 6.3 Timeline and moment grouping

The result set is ordered from earliest to latest by `timeline_at`, then by media ID for a deterministic tie break.

The browser groups the ordered result stream into unnamed moments. A new moment begins only when the gap from the previous result is greater than 45 minutes. A local midnight does not split an otherwise continuous moment, so an event that runs past midnight remains chronologically coherent.

Moment grouping is derived, not stored. It is recomputed over the active result set. A search or Favorites-only view may therefore contain fewer, simpler moments than the complete timeline. There are no moment IDs, names, edit controls, or persistence rules.

A moment heading uses factual event-local time language only:

- same-date example: **Saturday, August 15 · 5:42–6:18 PM**
- cross-date example: **Saturday, August 15, 11:48 PM–Sunday, August 16, 12:24 AM**
- one-photo example: **Saturday, August 15 · 7:06 PM**

Each heading also shows the number of currently loaded photos in the moment. It must not guess labels such as "Ceremony," "Cocktail hour," or "Dance floor."

Pagination may append additional photos to the last rendered moment. When that happens, its end time and loaded count update without changing the order of existing photos.

### 6.4 Responsive mosaic

Each moment initially presents up to eight photos in a responsive mosaic. The first eight positions use one fixed pattern; photos revealed beyond position eight use ordinary one-column-by-one-row cells and never restart the span pattern.

The breakpoints and tracks are fixed:

- **Below 761 CSS pixels:** two equal columns, 8-pixel gaps, and `grid-auto-rows: clamp(124px, 40vw, 180px)`. Positions 1 and 6 span both columns for one row. Every other position is one column by one row.
- **761 through 1100 CSS pixels:** three equal columns, 10-pixel gaps, and 132-pixel automatic rows. Position 1 spans two columns by two rows. Position 7 spans two columns by one row. Every other position is one column by one row.
- **1101 CSS pixels and wider:** four equal columns, 12-pixel gaps, and 148-pixel automatic rows. Position 1 spans two columns by two rows. Position 2 spans two columns by one row. Every other position is one column by one row.

The mosaic follows these additional rules:

- DOM order remains chronological.
- Grid placement follows the position rules above with `grid-auto-flow: row`; dense packing and CSS `order` are prohibited.
- The pattern does not inspect dimensions, faces, aesthetics, favorite state, or publication status.
- Reloading the same ordered media produces the same tracks and spans.
- Previews use `object-fit: cover` and centered object positioning; the immersive viewer shows the complete preview without mosaic cropping.
- Favorites display a clear pressed-state control and text-accessible name but do not receive a larger tile.
- The existing 44-by-44-pixel target floor remains binding.

If a moment contains more than eight currently loaded photos, it shows **Show more photos**. Activating it reveals the rest of the currently loaded photos inline. **Show fewer photos** collapses the moment and restores focus to the moment heading or expansion control.

The page retains one chronological **Load more photos** control at the end of the loaded result set. New pages are appended to the existing timeline. This avoids a separate route or API for every derived moment.

### 6.5 Photo interaction and immersive viewer

Selecting a mosaic photo opens a modal-style immersive viewer over the Gallery.

The viewer contains:

- the complete browser-compatible preview;
- contributor name;
- guest caption when present, otherwise original filename;
- factual timing copy: **Taken…** when a trusted capture time exists, otherwise **Received…**;
- a Favorite toggle;
- previous and next controls within the active loaded result set; and
- a close control.

The viewer does not include download, publish, hide, delete, compare, edit, or move actions.

Keyboard and focus behavior:

- Enter or Space opens a focused photo.
- Left and Right Arrow move to the previous or next loaded photo.
- Escape closes the viewer.
- Focus is trapped while the viewer is open.
- Closing returns focus to the exact originating photo.
- Reaching a loaded boundary may prefetch the next chronological page, but navigation never skips to an unloaded photo without a visible loading state.
- Browser Back closes the viewer before leaving the Manager when practical within the existing routing model.

Touch behavior:

- horizontal swipe may move to the adjacent loaded photo;
- tapping outside the media does not close the viewer accidentally;
- all explicit controls remain at least 44 by 44 CSS pixels; and
- the viewer respects safe-area insets.

### 6.6 Favorite behavior

The Favorite control is available on each mosaic photo and in the viewer. It is represented as a toggle, not a one-way action.

Favoriting is:

- event-scoped;
- visible to every authorized manager;
- idempotent;
- independent of publication status; and
- excluded from export selection semantics.

The UI may update optimistically, but a refused or failed request must restore the last confirmed state and show the existing dismissible manager notice. A successful PUT patches the corresponding loaded row in place; it does not refetch Gallery. In the Favorites-only view, unfavoriting removes that row from the visible result set and recomputes the affected derived moments locally. It does not automatically refill the page. A second manager's later confirmed write may replace the first state on the next Gallery read; no conflict dialog, polling, or per-user merge model is introduced.

In the Favorites-only view, unfavoriting the photo currently open in the immersive viewer also closes the viewer, because that row leaves the result stream. Focus moves to the nearest remaining loaded photo tile in chronological order, or to the **No favorites yet.** empty-state heading when no photos remain.

## 7. Chronology

### 7.1 Effective timeline time

Every stored media row has one non-null `timeline_at`.

For newly finalized media:

1. use a trusted embedded capture time when one is available;
2. otherwise use `stored_at`; and
3. use `created_at` only as a defensive fallback for migrated rows that lack `stored_at`.

The API also exposes whether the effective value came from capture metadata or receipt time so the viewer can say **Taken** or **Received** accurately.

### 7.2 Trusted capture-time rule

Capture metadata extraction is best-effort and cannot make an otherwise valid delivery fail.

This version supports exactly one embedded capture-time source: a JPEG EXIF APP1 TIFF payload containing `DateTimeOriginal` (`0x9003`). `OffsetTimeOriginal` (`0x9011`) is honored when present. The accepted text shapes are:

- capture time: `YYYY:MM:DD HH:MM:SS`
- offset: `+HH:MM` or `-HH:MM`

Subsecond tags are ignored. `DateTime`, `DateTimeDigitized`, XMP timestamps, filesystem dates, and client `File.lastModified` are not substitutes.

PNG, WebP, HEIC, HEIF, HEIC sequence, and HEIF sequence use received time in this version even if their containers carry metadata. Parsing WebP EXIF chunks or the HEIC/HEIF Exif item graph is a separately sized extension, not an implicit requirement of this specification.

The JPEG parser scans bounded APP1 segments before Start of Scan, inspecting no more than the first 1 MiB of the already-loaded original. All TIFF offsets and lengths are bounds-checked. Malformed or unsupported EXIF is ignored after the existing image-type and dimension checks have succeeded.

A parsed candidate is accepted only when:

- it represents a complete real calendar date and time;
- an embedded offset is syntactically valid and honored;
- a timestamp without an offset can be placed in the event's configured IANA time zone;
- `event_start_at` is a valid non-sentinel instant;
- the resulting instant is no more than 24 hours before `event_start_at`; and
- the resulting instant is no later than five minutes after `stored_at`.

An offset-free local time in a DST spring-forward gap is rejected. In a fall-back overlap, it resolves to the earlier occurrence, matching the repository's existing event-schedule rule. The conversion is seconds-preserving rather than truncating the EXIF value to the minute. When `event_start_at` equals the documented `1970-01-01T00:00:00.000Z` sentinel or cannot be parsed, capture time is not trusted and the photo uses received time.

A candidate outside those bounds, a malformed timestamp, an unsupported container, or a parser failure results in `captured_at = NULL` and `timeline_at = stored_at`. This favors a believable received-time position over an incorrect device clock.

In product terms, capture metadata is therefore replaced by received time whenever the photo predates the event start by more than 24 hours or the device clock ran more than five minutes ahead of the server, and every PNG, WebP, HEIC, or HEIF photo reads **Received** in this version. These are expected fallbacks for this release, not regressions.

Each path chooses one server `storedAt` instant immediately before the D1 transition. The capture-time trust window is evaluated against that instant, and the repository writes the same value to `stored_at`; the check and the stored receipt time cannot drift apart.

Both existing reserved-to-stored paths apply the same helper before their D1 transition:

- `finalizeStoredMedia` computes it from the full `sourceBytes` and the chosen `storedAt` before `MediaRepository.finalize`; and
- `receiveMediaUpload` computes it from its in-memory `bytes` and the existing `committedAt`/`storedAt` instant before `commitReservationIngress`.

The helper returns only normalized `capturedAt`, `timelineAt`, and `timelineSource` values. Repository finalization methods require those values and write them in the same transaction that changes `upload_state` to `stored`. No Gallery renderer reads original bytes.

Only the normalized capture instant is retained. Raw EXIF, GPS coordinates, camera model, serial identifiers, thumbnails, and other embedded metadata are neither stored in D1 nor exposed through the API. Existing preview behavior continues to strip source metadata.

### 7.3 Existing media

The migration does not reread deployed originals.

Existing stored rows receive:

- `captured_at = NULL`;
- `timeline_at = COALESCE(stored_at, created_at)`; and
- `favorited_at = NULL`.

The §8 backfill also stamps reserved rows with their `created_at` as a transient value, which finalization overwrites before any row becomes Gallery-visible. Stored rows therefore appear immediately in the new Gallery using received chronology. A future bounded metadata backfill would require a separate approved design and operational plan.

## 8. Data model

Migration `0016_host_private_gallery.sql` runs after `0015_curated_private_guestbook.sql` on both fresh and upgraded databases. Both migrations alter `media`; their numeric order is part of the release contract and must be covered by fresh-D1 and upgrade-path verification.

The migration uses SQLite-compatible constant-default addition rather than claiming an in-place nullability tightening:

```sql
ALTER TABLE media ADD COLUMN captured_at TEXT;
ALTER TABLE media ADD COLUMN timeline_at TEXT NOT NULL
  DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE media ADD COLUMN favorited_at TEXT;

UPDATE media
SET timeline_at = COALESCE(stored_at, created_at)
WHERE timeline_at = '1970-01-01T00:00:00.000Z';

CREATE INDEX media_private_gallery_timeline
ON media(event_id, timeline_at, id)
WHERE upload_state = 'stored' AND deleted_at IS NULL;

CREATE INDEX media_private_gallery_favorites
ON media(event_id, timeline_at, id)
WHERE upload_state = 'stored'
  AND deleted_at IS NULL
  AND favorited_at IS NOT NULL;
```

The constant default makes `timeline_at` genuinely non-null without rebuilding `media` and keeps a mixed-version deployment compatible with an older Worker that does not name the new column. The sentinel is not a valid stored-photo timeline value after rollout.

The backfill `UPDATE` rewrites every row that received the default, including reserved rows. Those reserved rows' creation-time values are transient and are overwritten by finalization before the row can appear in Gallery.

The application enforces that semantic invariant:

- `MediaRepository.finalize` and `commitReservationIngress` require a canonical non-sentinel `timelineAt` argument whenever they transition a row to `stored`;
- the transition writes `captured_at` and `timeline_at` atomically with `stored_at` and the stored state;
- a post-deploy repair updates any mixed-version stored sentinel row to `COALESCE(stored_at, created_at)`; and
- the Private Gallery release gate requires zero stored, non-deleted sentinel rows before the new UI is enabled.

No trigger is added in `0016`, because a trigger refusing the sentinel would break an older Worker during the migration-to-deploy window. A later database-hardening migration would need its own mixed-version proof and is outside this design.

`timeline_at` contains a canonical UTC ISO-8601 instant for every Gallery-visible row. `favorited_at` is null when the photo is not a favorite and contains the confirmed server write time when it is.

The partial indexes support unfiltered chronological and Favorites-only reads without scanning unrelated events. Search is intentionally different: it is a bounded event-local scan of at most the documented 10,000 media rows, followed by chronological ordering. Full-text, trigram, and Unicode-normalized search indexes are out of scope.

The manager media view gains:

```ts
interface ManagerGalleryMediaView {
  id: string;
  originalFilename: string;
  guestName: string;
  caption: string | null;
  publicationStatus: 'unpublished' | 'published' | 'hidden';
  previewAvailable: boolean;
  width: number | null;
  height: number | null;
  receivedAt: string;
  timelineAt: string;
  timelineSource: 'capture' | 'received';
  isFavorite: boolean;
}
```

Private Gallery does not need original object keys, raw metadata, uploader-session identifiers, or retention internals.

## 9. API and repository boundaries

### 9.1 Timeline read

Add:

```http
GET /api/manage/events/:eventId/gallery
```

Supported query parameters:

- `query`: optional trimmed literal search string of 1 through 120 Unicode code points;
- `favorites`: omitted or `1`; any other value, including `0`, receives the standard validation envelope rather than being treated as false;
- `cursor`: optional opaque chronological cursor; and
- `limit`: an integer from 1 through 48, defaulting to 48. The production client requests 48.

The route:

1. authorizes the current manager for the path event;
2. validates and normalizes parameters;
3. performs an event-scoped, stored-only, non-deleted query;
4. for search, applies bound `instr(lower(...), lower(?)) > 0` predicates to contributor, caption, and filename, with ASCII-only folding and literal `%` and `_` behavior;
5. applies `favorited_at IS NOT NULL` when requested;
6. orders by `timeline_at ASC, id ASC`;
7. fetches one extra row to determine continuation; and
8. returns media plus an opaque next cursor.

Unfiltered and Favorites-only reads must use the partial chronological indexes. A search may scan the authorized event's own media rows, up to the 10,000-photo cap, but must never scan another event. Query-plan and timed 10,000-row evidence are required for plain, Favorites-only, search, and combined search-plus-Favorites forms.

The cursor carries the last `timeline_at` and media ID and is versioned separately from the current Live Intake cursor. Private Gallery does not reuse the descending `stored_at` cursor contract.

A query or Favorites change always starts without a cursor. Invalid or empty cursor values receive the existing validation envelope rather than silently restarting.

### 9.2 Favorite write

Add:

```http
PUT /api/manage/events/:eventId/media/:mediaId/favorite
Content-Type: application/json

{ "favorite": true }
```

The route:

- requires manager write authorization, matching Origin, and the existing CSRF contract;
- accepts exactly one boolean;
- verifies the media belongs to the path event and is stored and non-deleted;
- sets `favorited_at` to the server time or null;
- is idempotent when the requested state already matches; and
- returns the updated Gallery media view.

A deleted, missing, or cross-event media ID receives the existing resource refusal semantics. Favorite state never grants access to a photo.

### 9.3 Complete export

No selective-export endpoint is added.

**Download all** invokes the existing event export creation, status, retry, and download APIs. Export photo membership remains every stored, non-deleted original at the job's snapshot time. The existing manifest, partitioned photo ZIPs, printable Guestbook, and private Guestbook artifacts remain one logical export job. Search, favorites, and publication state never narrow that job.

### 9.4 Shared Gallery

Shared mode continues to use the existing manager media read and publication mutation routes. A fresh entry uses the current **unpublished** filter. The current publication status filters and batch maximum remain unchanged.

Implementation should extract the current Gallery publishing markup from `ManagerPage.tsx` into a focused component rather than mixing it into the private timeline. No backend publication migration is required.

## 10. Component boundaries

The Manager should not gain another large inline branch in `ManagerPage.tsx`.

Recommended boundaries:

- `ManagerGalleryWorkspace`
  - owns Private / Shared mode;
  - coordinates the one export action and common heading.

- `ManagerPrivateGallery`
  - owns query state, Favorites state, chronological pagination, notices, and viewer state.

- `GalleryTimeline`
  - groups ordered rows through a pure function and renders moment sections.

- `GalleryMoment`
  - renders the compact or expanded deterministic mosaic.

- `GalleryViewer`
  - owns modal focus, keyboard navigation, adjacent-page prefetch, and favorite action.

- `ManagerSharedGallery`
  - contains the existing publication filters, selection, publish, and hide behavior.

- `gallery-timeline.ts`
  - pure chronology and 45-minute grouping rules with event-time-zone inputs.

- `MediaRepository.listGalleryTimeline`
  - owns the bounded D1 query and chronological cursor.

`inspectJpegCaptureTime` is a focused, best-effort helper beside the existing image-header inspection. `resolveMediaTimeline` applies the event-time-zone and plausibility rules. Both `finalizeStoredMedia` and `receiveMediaUpload` call that shared path before their respective repository transition. Gallery rendering must not inspect original bytes.

Each unit should expose a small typed interface and remain independently testable.

## 11. Loading, pagination, and state preservation

The Gallery loads only after the Gallery destination is opened. Its request does not join the Manager's initial event, Live Intake, RSVP, Guestbook, or Share reads.

The first successful page replaces the current result set. A continuation page appends only when:

- its cursor still matches the current result stream;
- query and Favorites state have not changed; and
- the request has not been superseded or aborted.

Duplicate media IDs are discarded defensively.

A successful favorite PUT updates the loaded row in place. It is not a timeline load trigger. In Favorites-only mode, an unfavorited row is removed locally; the next explicit pagination action continues from the stream's existing cursor.

When the host switches between Private and Shared mode during one mounted Gallery visit:

- each mode preserves its confirmed rows, current filters, and scroll position;
- an open private viewer closes;
- pending writes finish through the existing manager write guard; and
- stale read responses cannot overwrite the newly active mode.

Leaving Gallery and returning during the same Manager mount may preserve private query and Favorites state. A full page reload starts at the unfiltered private timeline.

## 12. Empty, loading, and error states

### No private photos

Heading: **No photos have been delivered yet.**

Copy directs the host to Live Intake without suggesting publication or setup work.

### No search matches

Heading: **No photos match this search.**

The active query remains visible and a **Clear search** action is available.

### No favorites

Heading: **No favorites yet.**

Copy explains that the heart on any photo adds it to this shared event list. It does not introduce albums or keeper language.

### Missing preview

A delivered original with no available preview remains in chronology. The tile shows a stable placeholder, filename or caption, contributor, and Favorite action. Opening it produces the same placeholder and metadata. Preview failure never removes the original from Download all.

### Timeline read failure

If no Gallery data has rendered, show the standard retry state.

If a later pagination or search request fails, retain the last confirmed timeline and show a dismissible manager notice with a retry for that exact request. Do not blank the Gallery or move the host to another section.

### Favorite failure

Restore the last confirmed favorite state, retain the open moment or viewer, and show a manager notice. A favorite failure does not refresh the entire event or media list.

### Export failure

Use the existing export failure, retry, expiry, and recovery states. Gallery does not reinterpret them as timeline failures.

## 13. Privacy, authorization, and logging

- Every Gallery read and favorite write requires manager authorization for the path event.
- Search predicates are bound parameters and cannot broaden the authorized event scope.
- Opaque cursors contain no credential and cannot move a request into another event.
- Guest sessions cannot access the private Gallery endpoint or favorite route.
- Private Gallery previews continue through the authorized preview route.
- Originals remain private and are exposed only through existing manager-authorized original or export delivery.
- Raw embedded metadata is not logged.
- Normalized capture time may appear in manager responses but not in guest-facing gallery responses unless a separately approved guest design adds it.
- Search text and guest captions must not be copied into infrastructure logs beyond the application's existing bounded request logging policy.
- Favorite writes should log event ID, media ID, requested state, result, and request ID without logging credentials or original object keys.

## 14. Accessibility and responsive behavior

The redesign must continue to target WCAG 2.2 AA and the repository's physical-device acceptance requirements.

Required behavior:

- Gallery mode controls expose selected state programmatically.
- Search has a persistent visible label.
- Favorites is a toggle with `aria-pressed`.
- Every photo has one primary open-viewer action; favorite remains a separate named control.
- Mosaic DOM order matches chronology and screen-reader order.
- Moment expansion uses `aria-expanded` and identifies the controlled region.
- Result counts and completed favorite changes are announced politely without repeated live-region noise.
- The immersive viewer has an accessible name, trapped focus, explicit close control, and reliable focus restoration.
- Keyboard navigation does not depend on hover.
- Status, favorite, and publication meaning never rely on color alone.
- Touch targets remain at least 44 by 44 CSS pixels.
- At 320 CSS pixels wide, the Gallery has no document-level horizontal scrolling.
- At 200% zoom, search, mode switch, moment controls, and viewer controls remain operable.
- Reduced motion removes animated mosaic expansion and viewer transitions.
- Image alternatives continue to prefer the guest caption and otherwise use a safe filename-derived label; decorative mosaic treatment is not announced separately.

## 15. Performance and scale

The design must remain bounded at 10,000 photos.

- Do not return all media metadata in the initial response.
- Default timeline pages contain 48 rows; the server maximum is also 48.
- Use keyset pagination over `timeline_at` and ID; do not use offset pagination.
- Fetch preview-sized assets only. Mosaic and viewer never fetch an original.
- Apply `loading="lazy"` and `decoding="async"` outside the first visible mosaic.
- Preload at most the adjacent viewer previews.
- Abort or supersede stale search and pagination requests.
- Do not poll Private Gallery.
- Group moments incrementally in the browser without retaining duplicate representations of the same media rows.
- Verify the plain and Favorites-only query plans use their event-scoped partial indexes.
- Treat text search as an explicit event-local scan bounded by `MAX_EVENT_MEDIA = 10_000`; FTS, trigram indexes, and full Unicode folding are out of scope.
- Record query-plan and duration evidence for plain, Favorites-only, search, and combined search-plus-Favorites requests against a 10,000-row event plus unrelated-event rows.
- Measure narrow-phone memory, scroll responsiveness, and layout stability with mixed portrait, landscape, missing-dimension, and missing-preview rows.

The implementation must preserve Live Intake's independent newest-first polling and cursor behavior.

## 16. Migration and rollout

### Phase 1: compatible migration and writes

- Confirm production D1 is at 0015 before numbering and applying 0016. The repository already contains 0015 and canonical-live configuration, but production schema state must be read from the release migration evidence rather than assumed.
- Add `0016_host_private_gallery.sql` after deployed migration `0015_curated_private_guestbook.sql` using the exact constant-default, backfill, and partial-index shape in §8.
- Verify fresh migration order and an upgrade from a populated 0015 database.
- Extend both `finalizeStoredMedia` and `receiveMediaUpload` to compute and atomically write timeline values on every reserved-to-stored transition.
- Keep the current Manager UI unchanged.

### Phase 2: repair and API readiness

- Deploy the timeline-writing Worker.
- Run a bounded repair for any stored row left at the timeline sentinel during the mixed-version window.
- Require the readiness query to report zero stored, non-deleted sentinel rows.
- Add and verify Gallery read and favorite routes, including all four query forms and 10,000-row evidence.

### Phase 3: private Gallery UI

- Extract the existing publication workspace as Shared Gallery, with unpublished as its fresh-entry filter.
- Add the Private / Shared mode switch with Private as default.
- Add private search, Favorites, gap-based moments, the fixed mosaic patterns, viewer, and the single complete-export action.
- Remove publication status and delete controls from the private mode.
- Remove or redirect duplicate complete-export entry points.

### Phase 4: evidence and release

- Run full unit, Worker, UI, accessibility, responsive, and end-to-end suites.
- Exercise 10,000-photo timeline, search, favorites, and export fixtures.
- Complete physical iPhone Safari and Android Chrome acceptance.
- Enable the new UI only after existing media appear through received-time fallback, the sentinel-readiness gate passes, and complete export membership remains unchanged.

No background capture-time backfill and no post-0016 nullability table rebuild are part of rollout.

## 17. Verification strategy

### Unit tests

Cover:

- JPEG EXIF `DateTimeOriginal` and `OffsetTimeOriginal` parsing, TIFF endianness, bounds checks, and the 1-MiB scan ceiling;
- explicit received-time fallback for PNG, WebP, HEIC, HEIF, sequence types, malformed EXIF, and sentinel event starts;
- offset-free DST-gap rejection and earlier-occurrence fall-back resolution;
- no failure of delivery when capture metadata parsing fails;
- 45-minute-only moment boundaries, including a moment that crosses local midnight;
- deterministic grouping across page boundaries;
- exact two-, three-, and four-column mosaic tracks, row sizing, span positions, and uniform post-eight cells;
- ASCII-only search folding, exact non-ASCII behavior, literal `%` and `_`, and the 120-code-point limit;
- favorite state reducers and rollback;
- viewer previous, next, close, and focus-return state; and
- viewer close and focus placement when the open photo is unfavorited in a Favorites-only view.

### Worker and repository tests

Cover:

- manager-only Gallery authorization;
- cross-event refusal;
- stored-only and non-deleted filtering;
- ascending `timeline_at`, ID ordering;
- opaque chronological cursor validation;
- search over contributor, caption, and filename;
- combined search plus Favorites;
- idempotent favorite and unfavorite writes;
- favorite refusal for deleted or foreign media;
- migration 0016 ordering after 0015, constant-default addition, populated-row backfill, mixed-version sentinel repair, and readiness refusal;
- both `finalizeStoredMedia` and `receiveMediaUpload` writing non-sentinel timeline values atomically;
- query-plan and duration evidence at 10,000 rows for plain, Favorites-only, search, and combined requests, with unrelated-event rows present;
- guest-facing gallery remaining published-only; and
- complete export membership remaining independent of search, favorite, and publication state.

### UI and browser tests

Cover:

- Gallery opens in Private mode;
- switching to Shared preserves the existing publication workflow;
- no publication or deletion controls appear in Private mode;
- initial compact mosaic and inline expansion;
- append across a moment boundary and within the same moment;
- search, clear, Favorites, and combined empty states;
- favorite from mosaic and viewer;
- unfavorite the photo open in the Favorites-only viewer, including viewer close and focus placement;
- failed favorite rollback;
- viewer keyboard, swipe where supported, focus trap, Escape, and focus restoration;
- missing preview behavior;
- one Download all action invoking the existing export and naming its photo, manifest, and Guestbook contents;
- export job progress and ready parts;
- narrow widths, wide rails, 200% zoom, reduced motion, and no horizontal overflow; and
- stale request suppression when search or mode changes.

### Physical-device acceptance

On current iPhone Safari and Android Chrome:

1. open an event with a mixed-orientation private collection;
2. enter Gallery and see Private mode first;
3. search by contributor;
4. clear search and favorite a photo;
5. open the Favorites-only result;
6. expand a moment inline;
7. open the viewer, swipe or use controls, favorite, and close to the originating tile;
8. switch to Shared gallery and publish or hide a photo;
9. return to Private gallery without losing confirmed state; and
10. start Download all, verify its contents are described accurately, and observe the existing export state.

Desktop emulation supplements but does not replace these checks.

## 18. Acceptance criteria

The design is complete when all of the following are true:

- Gallery opens to the host's complete private collection rather than a publication queue.
- Every stored, non-deleted original appears regardless of publication status.
- New JPEG media uses trusted `DateTimeOriginal` when it passes the specified rules; every unsupported or untrusted case — PNG, WebP, HEIC, HEIF, capture more than 24 hours before event start, or a device clock more than five minutes ahead of the server — uses received time.
- Both reserved-to-stored code paths write `timeline_at` atomically.
- Migration `0016_host_private_gallery.sql` follows 0015, uses a constant sentinel default plus backfill, and reaches zero Gallery-visible sentinel rows before UI release.
- Existing media works immediately through received-time fallback without object backfill.
- Photos are ordered earliest to latest and split into a new moment only when the preceding gap exceeds 45 minutes; a continuous moment may cross midnight.
- Each moment begins as the exact deterministic responsive mosaic specified in §6.4, shows no more than eight compact photos, and expands inline.
- The private Gallery contains no selection checkboxes, publish, hide, delete, compare, edit, or individual-download actions.
- Search matches contributor, caption, and original filename as a literal substring with ASCII-only case folding, exact non-ASCII comparison, and no `%` or `_` wildcard behavior.
- Plain, Favorites-only, search, and combined queries are event-scoped and pass 10,000-row query-plan and timing evidence.
- Favorites are event-shared, reversible, updated in place, and independent of publication and export.
- The immersive viewer preserves chronology and returns focus to the originating photo.
- Unfavoriting the photo open in the Favorites-only viewer closes the viewer and moves focus to the nearest remaining loaded photo, or to the **No favorites yet.** empty state when none remain.
- Gallery exposes one Download all action that starts the existing complete export, whose supporting copy names original photos, manifest, and Guestbook artifacts; the job's ready-state download and retry controls remain part of that same job.
- Search and Favorites never narrow export membership.
- Shared Gallery opens fresh on unpublished and retains the current unpublished, published, and hidden publication workflow as a separate mode.
- Guest access to private media does not change.
- Timeline reads use 48-row keyset pages and remain bounded at the 10,000-photo limit.
- Required automated, accessibility, responsive, scale, and physical-device evidence passes.

## 19. Explicit scope guard

Implementation review should reject additions that turn this work into an album editor, automated image-analysis feature, or selective-export system.

The product improvement is deliberately simple:

> Give the host a calm chronological place to relive every private delivery, mark favorites, find a known photo, open it fully, and download the complete collection.

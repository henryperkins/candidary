# Candidary Host Private Gallery Design

**Date:** 2026-08-13

**Status:** Approved direction; written specification awaiting review

**Repository baseline:** `b293ee42c35cc30c19b86cd1ff4737ad54857755`

## 1. Decision

Candidary's Manager Gallery becomes a host-only private memory library by default.

The host opens Gallery to a chronological stream of every stored, non-deleted photo. Candidary uses a trustworthy embedded capture time when available and otherwise uses the time the photo was received. Photos are divided into simple, unnamed time-based moments and displayed as responsive mosaics. A moment begins compact and expands inline. Opening a photo enters an immersive viewer that preserves the host's place in the timeline.

The private Gallery supports only four library actions:

1. search by contributor name, caption, or original filename;
2. mark or unmark a photo as a shared event favorite;
3. open and move through photos in the immersive viewer; and
4. prepare the existing complete all-original export through one **Download all originals** action.

The existing guest-facing shared gallery remains a separate secondary mode inside Gallery. It retains the current unpublished, published, and hidden publication workflow. Private favorites do not publish photos, and publication status does not affect the private timeline or complete export.

This specification replaces the current host Gallery presentation in `src/pages/ManagerPage.tsx`. It does not replace Live Intake, the guest upload journey, the guest-facing gallery route, media retention, or the existing complete-export guarantees.

## 2. Why this change

The current Manager Gallery is the same media grid used by Live Intake with publication filters, selection checkboxes, and publish or hide controls added. That makes the host think about moderation even when the real post-event job is to revisit the private collection and retrieve the originals.

Candidary's product hierarchy already says private delivery comes first and optional sharing comes second. The host Gallery should express that hierarchy directly:

- **Private Gallery** answers, "What did everyone send, and what happened across the day?"
- **Shared Gallery** answers, "Which previews may guests see?"
- **Live Intake** answers, "What is arriving now, and do I need to act on an original?"
- **Download all originals** answers, "How do I retrieve the complete collection?"

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

It retains batch publish and batch hide. It does not inherit private favorites, timeline moments, the immersive private viewer, or Download all behavior. The guest-facing `/api/event/:slug/gallery` contract remains limited to stored, published, non-deleted media.

### 5.3 Live Intake remains operational

Live Intake remains the place for current arrivals, contributor filtering during the event, individual-original retrieval, and irreversible deletion. It may continue visibility-aware polling.

Private Gallery is deliberately calmer. It loads on entry and on explicit search, clear, favorite, pagination, or retry actions. It does not reorder itself beneath the host when delayed uploads arrive. Re-entering or reloading Gallery produces the latest canonical timeline.

## 6. Private Gallery interface

### 6.1 Header

The Gallery header contains:

- the Private gallery / Shared gallery mode switch;
- the title **Private gallery**;
- a quiet total such as **842 photos**;
- one **Download all originals** action; and
- the existing export progress or ready state after that action is used.

The export action always means every stored, non-deleted original in the event. Search text, favorite state, current moment expansion, and publication status never narrow it.

The existing export Workflow may still produce multiple numbered ZIP parts under its source-byte cap. The host starts that complete export from one action and sees one logical job. Gallery does not promise one physical ZIP file.

The duplicate manager export entry point currently placed in Share or the responsive utility treatment should be removed or replaced with a plain route back to Gallery. There should be one canonical **Download all originals** action, backed by the existing export job.

### 6.2 Search and favorites

The private Gallery has one search form:

- label: **Find photos**
- placeholder: **Contributor, caption, or filename**
- submit action: **Search**
- clear action when a query is active

Search is case-insensitive substring matching across:

- `guest_name`;
- `caption`; and
- `original_filename`.

Search does not inspect pixels or infer who or what appears in a photo.

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

The browser groups the ordered result stream into unnamed moments. A new moment begins when either:

- the event-local calendar date changes; or
- the gap from the previous result exceeds 45 minutes.

Moment grouping is derived, not stored. It is recomputed over the active result set. A search or Favorites-only view may therefore contain fewer, simpler moments than the complete timeline. There are no moment IDs, names, edit controls, or persistence rules.

A moment heading uses factual time language only:

- same-day example: **5:42–6:18 PM**
- multi-day example: **Saturday, August 15 · 11:48 PM–12:24 AM**
- one-photo example: **7:06 PM**

Each heading also shows the number of currently loaded photos in the moment. It must not guess labels such as "Ceremony," "Cocktail hour," or "Dance floor."

Pagination may append additional photos to the last rendered moment. When that happens, its end time and loaded count update without changing the order of existing photos.

### 6.4 Responsive mosaic

Each moment initially presents up to eight photos in a responsive mosaic.

The mosaic follows these rules:

- DOM order remains chronological.
- Visual placement never uses CSS `order` or any other technique that changes reading and keyboard order.
- A deterministic positional pattern controls which cells span rows or columns.
- The pattern does not inspect faces, aesthetics, favorite state, or publication status.
- Reloading the same ordered media produces the same layout.
- Portrait and landscape previews use their known dimensions to choose safe cropping within the fixed pattern, but dimensions do not reorder photos.
- Previews use `object-fit: cover`; the immersive viewer shows the complete preview without mosaic cropping.
- Favorites display a clear pressed-state control and text-accessible name but do not receive a larger tile.

At narrow phone widths the mosaic becomes a two-column contact-style layout with a limited number of spans. At wide widths it may use three or four columns. The existing 44-by-44-pixel target floor remains binding.

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

The UI may update optimistically, but a refused or failed request must restore the last confirmed state and show the existing dismissible manager notice. A second manager's later confirmed write may replace the first state; no conflict dialog or per-user merge model is introduced.

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

A candidate capture time is accepted only when:

- it is parsed from a supported embedded photo timestamp;
- it represents a complete date and time;
- an embedded offset is honored when present;
- a timestamp without an offset can be interpreted in the event's configured time zone;
- the resulting instant is no more than 24 hours before the event start; and
- the resulting instant is no later than five minutes after `stored_at`.

A candidate outside those bounds, a malformed timestamp, an unsupported metadata container, or a parser failure results in `captured_at = NULL` and `timeline_at = stored_at`.

This rule is intentionally conservative. It favors a believable received-time position over an obviously incorrect device clock.

Only the normalized capture instant is retained. Raw EXIF, GPS coordinates, camera model, serial identifiers, thumbnails, and other embedded metadata are neither stored in D1 nor exposed through the API. Existing preview behavior continues to strip source metadata.

### 7.3 Existing media

The migration does not reread deployed originals.

Existing stored rows receive:

- `captured_at = NULL`;
- `timeline_at = COALESCE(stored_at, created_at)`; and
- `favorited_at = NULL`.

They therefore appear immediately in the new Gallery using received chronology. A future bounded metadata backfill would require a separate approved design and operational plan.

## 8. Data model

A migration adds these fields to `media`:

```sql
captured_at TEXT NULL,
timeline_at TEXT NOT NULL,
favorited_at TEXT NULL
```

`timeline_at` must contain a canonical UTC ISO-8601 instant. `favorited_at` is null when the photo is not a favorite and contains the confirmed write time when it is.

The migration backfills `timeline_at` before enforcing its non-null contract. It adds indexes supporting:

- event-scoped chronological reads over stored, non-deleted media; and
- event-scoped Favorites-only chronological reads.

The exact index form should be validated against D1 query plans. The design requirement is that the Gallery query must not scan unrelated events or sort all 10,000 rows in application memory.

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

- `query`: optional trimmed search string;
- `favorites`: omitted or `1`;
- `cursor`: optional opaque chronological cursor; and
- `limit`: bounded by a Gallery-specific server maximum, with a default of 48.

The route:

1. authorizes the current manager for the path event;
2. validates and normalizes parameters;
3. performs an event-scoped, stored-only, non-deleted query;
4. applies case-insensitive bound search predicates when requested;
5. applies `favorited_at IS NOT NULL` when requested;
6. orders by `timeline_at ASC, id ASC`;
7. fetches one extra row to determine continuation; and
8. returns media plus an opaque next cursor.

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

**Download all originals** invokes the existing event export creation, status, retry, and download APIs. Export membership remains every stored, non-deleted original at the job's snapshot time. The manifest and partitioned ZIP behavior remain authoritative.

### 9.4 Shared Gallery

Shared mode continues to use the existing manager media read and publication mutation routes. The current publication status filters and batch maximum remain unchanged.

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

Capture-time extraction belongs at the media-finalization boundary, behind a focused metadata-normalization helper. Gallery rendering must not inspect original bytes.

Each unit should expose a small typed interface and remain independently testable.

## 11. Loading, pagination, and state preservation

The Gallery loads only after the Gallery destination is opened. Its request does not join the Manager's initial event, Live Intake, RSVP, Guestbook, or Share reads.

The first successful page replaces the current result set. A continuation page appends only when:

- its cursor still matches the current result stream;
- query and Favorites state have not changed; and
- the request has not been superseded or aborted.

Duplicate media IDs are discarded defensively.

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
- Default timeline pages contain 48 rows and may never exceed the server maximum.
- Use keyset pagination over `timeline_at` and ID; do not use offset pagination.
- Fetch preview-sized assets only. Mosaic and viewer never fetch an original.
- Apply `loading="lazy"` and `decoding="async"` outside the first visible mosaic.
- Preload at most the adjacent viewer previews.
- Abort or supersede stale search and pagination requests.
- Do not poll Private Gallery.
- Group moments incrementally in the browser without retaining duplicate representations of the same media rows.
- Verify the timeline and Favorites query plans against an event at the 10,000-photo cap.
- Measure narrow-phone memory, scroll responsiveness, and layout stability with mixed portrait, landscape, missing-dimension, and missing-preview rows.

The implementation must preserve Live Intake's independent newest-first polling and cursor behavior.

## 16. Migration and rollout

### Phase 1: compatible schema and API

- Add and backfill `captured_at`, `timeline_at`, and `favorited_at`.
- Add timeline indexes.
- Extend finalization to set trusted capture time best-effort.
- Add Gallery read and favorite routes.
- Keep the current Manager UI unchanged until API verification passes.

### Phase 2: private Gallery UI

- Extract the existing publication workspace as Shared Gallery.
- Add the Private / Shared mode switch with Private as default.
- Add private search, Favorites, timeline grouping, mosaics, viewer, and the single complete-export action.
- Remove publication status and delete controls from the private mode.
- Remove or redirect duplicate complete-export entry points.

### Phase 3: evidence and release

- Run migration verification against fresh and upgraded databases.
- Run full unit, Worker, UI, accessibility, responsive, and end-to-end suites.
- Exercise 10,000-photo timeline and export fixtures.
- Complete physical iPhone Safari and Android Chrome acceptance.
- Deploy only after existing media appear through received-time fallback and complete export membership remains unchanged.

No background capture-time backfill is part of rollout.

## 17. Verification strategy

### Unit tests

Cover:

- capture-time parsing, timezone interpretation, and plausibility bounds;
- fallback to received time;
- no failure of delivery when metadata parsing fails;
- 45-minute and event-local-date moment boundaries;
- deterministic grouping across page boundaries;
- deterministic mosaic placement without reordering;
- search normalization;
- favorite state reducers and rollback; and
- viewer previous, next, close, and focus-return state.

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
- migration backfill for legacy rows;
- query-plan evidence at 10,000 rows;
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
- failed favorite rollback;
- viewer keyboard, swipe where supported, focus trap, Escape, and focus restoration;
- missing preview behavior;
- one Download all originals action invoking the existing export;
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
10. start Download all originals and observe the existing export state.

Desktop emulation supplements but does not replace these checks.

## 18. Acceptance criteria

The design is complete when all of the following are true:

- Gallery opens to the host's complete private collection rather than a publication queue.
- Every stored, non-deleted original appears regardless of publication status.
- New media uses a trusted capture time when available and received time otherwise.
- Existing media works immediately through received-time fallback without object backfill.
- Photos are ordered earliest to latest and grouped by event-local date or a gap greater than 45 minutes.
- Each moment begins as a deterministic responsive mosaic of no more than eight photos and expands inline.
- The private Gallery contains no selection checkboxes, publish, hide, delete, compare, edit, or individual-download actions.
- Search matches contributor, caption, and original filename only.
- Favorites are event-shared, reversible, and independent of publication and export.
- The immersive viewer preserves chronology and returns focus to the originating photo.
- Gallery exposes one Download all originals action backed by the existing complete export.
- Search and Favorites never narrow export membership.
- Shared Gallery retains the current unpublished, published, and hidden publication workflow as a separate mode.
- Guest access to private media does not change.
- Timeline reads remain paginated and bounded at the 10,000-photo limit.
- Required automated, accessibility, responsive, scale, and physical-device evidence passes.

## 19. Explicit scope guard

Implementation review should reject additions that turn this work into an album editor, automated image-analysis feature, or selective-export system.

The product improvement is deliberately simple:

> Give the host a calm chronological place to relive every private delivery, mark favorites, find a known photo, open it fully, and download the complete collection.

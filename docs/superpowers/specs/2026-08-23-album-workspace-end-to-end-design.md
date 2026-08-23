# Candidary Album Workspace End-to-End Design

**Date:** 2026-08-23

**Status:** Approved for implementation by the user's explicit scope decision, “The full end to end.”

**Design source:** `Candidary Design System-handoff.zip`, canonical member `candidary-design-system/project/templates/album-workspace/AlbumWorkspace.dc.html`, plus `candidary-design-system/project/design_handoff_album_workspace/README.md`

**Revises:** `docs/superpowers/specs/2026-08-13-host-private-gallery-design.md` only where §2 says so. Its chronology, private-library authorization, search, pagination, mosaic, viewer, complete-export, retention, and scale contracts otherwise remain binding.

## 1. Decision

Candidary gives every event one host-curated album assembled from the private Gallery. Gallery has three modes:

| Mode | Purpose | Visibility |
| --- | --- | --- |
| **Library** | Every stored, non-deleted private delivery; search, browse, view, and pick photos. | Hosts only. |
| **Album** | Name, describe, cover, arrange, section, preview, share, and export one curated artifact. | Hosts until an explicit album share is enabled. |
| **Shared** | Publish or hide previews in the existing shared gallery. | Existing event guests, under the existing shared-gallery rules. |

Four axes remain independent:

1. **Library delivery** means a stored, non-deleted original belongs to the event's private collection.
2. **Album membership** is `media.favorited_at IS NOT NULL`, still event-wide and shared by every authorized host.
3. **Shared-gallery publication** is the existing `publication_status` workflow.
4. **Album-share visibility** is a separate revocable bearer link for the ordered album.

Changing one axis never changes another. In particular, picking a photo never publishes it, enabling an album link never publishes it to the shared gallery, and stopping album sharing never removes a pick, an original, or a shared-gallery publication.

The transport and existing component props keep the term `favorite`/`isFavorite`; all host-facing product copy calls the state an **album pick**. This avoids a breaking transport rename while presenting one coherent concept.

## 2. Relationship to the approved private Gallery design

The 2026-08-13 specification remains authoritative except for these deliberate revisions:

- Its two Gallery modes become **Library · Album · Shared**. Library is the previously specified Private gallery and remains the default.
- Its “four library actions” boundary expands only to album picking and bounded batch selection for album membership. Library still has no publication, deletion, caption editing, individual-original download, or arbitrary asset-management controls.
- The non-goals that rejected dragging/manual photo order, a host-selected lead image, one custom album, batch selection, and selective ZIP export are superseded only for this single event album.
- “No custom albums” now means no album list, nested album, per-manager album, additional collection, tag system, or per-album permission model. There is exactly one album per event.
- “No selective ZIP export” now permits one album-scoped original export. **Download all** remains the complete event export and is unchanged in membership, Guestbook artifacts, partitioning, and lifecycle.
- “Guest access to private media does not change” now has one narrow exception: a holder of an active album link may read the album's allowlisted projection and preview-sized representations of its current picked photos. The link never authorizes originals or the private Library API.
- The explicit scope guard against an album editor is superseded by this approved, bounded editor. Automatic labeling, image analysis, face/object recognition, multiple albums, nested sections, per-album collaborators, and arbitrary file management remain out of scope.

Everything else in the earlier spec remains binding, including 48-row keyset Gallery pages, the 45-minute/60-photo moment rule, deterministic `SPAN_PATTERNS`, the 10,000-photo event bound, source chronology, private search behavior, viewer focus behavior, preview-only Library rendering, and existing shared-gallery publication semantics.

## 3. Product contract

### 3.1 Shared shell and mode copy

The Gallery heading remains **Gallery**. The three-button switch has `role="group"`, `aria-label="Gallery mode"`, `aria-pressed`, and a stable active style. Library is selected on a fresh Manager Gallery visit.

The notes under the switch are exact:

- **Library:** “Everything delivered privately, newest first. Picking a photo adds it to the album for every host on this event — it does not publish it.”
- **Album:** “One album per event. Its order and sections are yours; the delivered originals stay exactly where they are.”
- **Shared:** “What guests can see right now. Publishing and hiding change the shared gallery only.”

One persistent polite live region in the Gallery workspace announces selection changes, moves, saves, share state, export state, viewer movement, and undo outcomes. It outlives each mode branch.

### 3.2 Library picking

Library preserves the existing private Gallery search, chronology order, pagination, moment derivation, authored responsive mosaic patterns, viewer, and complete **Download all** export.

The complete-export copy is:

> Every private photo, the photo manifest, and the printable and private guestbook files. Search and album picks do not change this.

Every photo's pick control is a 44-by-44-pixel pressed-state button:

- unpicked glyph: Lucide `Plus`;
- picked glyph: Lucide `Check`;
- `aria-label`: `Add {title} to the album` or `Remove {title} from the album`;
- hidden state text: `Not in the album` or `In the album`;
- picked tiles not in selection mode show the **In album** badge.

The same Plus/Check language appears in the Library viewer. The filter toggle is **Album picks ({n})** with a steady `Check` glyph and `aria-pressed`.

Selection mode is explicit:

- toggle: **Select photos** / **Done selecting**;
- all-results action: **Select all {n} results**;
- each moment action: **Select this moment** / **Clear this moment**, based on whether every photo in that whole moment is selected;
- the tile primary action changes from opening to selection and says `Select {title}, from {name}` or `Deselect {title}, from {name}`;
- changing query, Album-picks filter, chronology order, or Gallery mode clears selection;
- the selected inset and check badge do not replace the accessible pressed state.

The default selection tray is the handoff's **Docked card**. It renders only while at least one photo is selected, uses `role="region"` and `aria-label="Album"`, and contains:

- `{n} photo selected` / `{n} photos selected`;
- “Adding does not publish anything, and removing keeps the delivered original.”;
- **Add {n} to album**;
- **Remove {n} from album**; and
- **Clear selection**.

Bulk pick writes report only media actually changed. Undo reverses only those IDs, so already-picked or already-unpicked photos retain their confirmed membership.

### 3.3 First-open reconciliation

`event_albums.saved_at IS NULL` is the single reconciliation signal. If a never-saved album has existing picks, Album shows the reconciliation body instead of the editor, autosave status, preview, sharing, or download exits.

Exact copy:

- label: **Before albums, there were favorites**;
- heading: **{n} photo was favorited before this album existed.** / **{n} photos were favorited before this album existed.**;
- body: “Album picks are the same hearts you already used, so this album can start from them — in the order the photos arrived, with the first as the cover. Nothing is published either way, and you can add or remove photos afterwards.”;
- primary: **Start the album from it** / **Start the album from them**;
- secondary: **Start empty**;
- footnote: “Starting empty clears the hearts on those photos. It never deletes a photo.”; and
- status: **Not started yet**.

Starting from picks stores the existing timeline order. Starting empty clears those existing favorite bits, stores an empty album, and raises a nine-second undo with **The album starts empty. The hearts were cleared.** Restoring uses the ordinary bulk-pick endpoint.

### 3.4 Album metadata and cover

Every album stores:

- `title`: trimmed, 1 through 120 Unicode code points; default **Album**;
- `description`: 0 through 1,000 Unicode code points; default empty;
- `coverMediaId`: nullable explicit picked-photo ID; and
- one ordered list of photo and section entries.

Title, description, explicit cover, and entries are one draft. A `PUT` replaces them atomically under the existing integer revision compare-and-set. The client uses a 600-millisecond debounce, permits at most one save in flight, coalesces pending edits to the newest complete draft, and composes every next write against the revision returned by the preceding write. Share, export, preview entry, and mode exit flush the newest valid draft first. A title made blank is locally invalid and is not sent; the editor displays **Give this album a title.**

The cover resolves in this order:

1. the explicit `coverMediaId`, only while that media is stored, non-deleted, and still picked;
2. otherwise the first live photo entry; or
3. no cover when the album has no live photo entries.

A stale explicit ID never grants access and never produces a broken cover. The manager response distinguishes `coverMediaId` (the valid explicit choice or `null`) from `effectiveCoverMediaId` (the resolved cover or `null`). Removing or unpicking the explicit cover returns to first-photo fallback. **Use the first photo instead** clears the explicit value.

The metadata panel uses real `mediaPreview(id)` images and exact supporting copy: **Guests see this only if you share the album. It is optional.** The fallback cover line starts **Cover · first photo, until you star another ·**; an explicit cover starts **Cover ·**.

### 3.5 Ordered review editor

Photo and section entries share one ordered sequence. Photo entries are positions, never a second membership claim; reads reconcile the sequence against the live picked set, omit no-longer-live entries, and append new unpositioned picks in `timeline_at ASC, id ASC` order.

The order header is **The order guests will see** with **Add a section** and **Reset to timeline order**.

The review list is a responsive card grid:

- photo card minimum track width: 196 pixels;
- real preview at aspect ratio 1.25, with a per-card **Preview unavailable** fallback;
- position pill counts photos only; sections do not consume a photo number;
- an effective-cover badge says **Cover**;
- visible title and **From {name}**;
- always-visible 44-by-44-pixel icon buttons for earlier, later, cover, and remove;
- section rows span all columns and expose an inline **Section name** input plus earlier, later, and remove controls.

Buttons are the primary reorder mechanism. A successful move announces **Moved to position {n} of {total}.** Native drag is a secondary equivalent using `draggable`, `dragstart`, `dragover` with `preventDefault`, and `drop`. Dropping moves the dragged entry to the target index and uses the same autosave and announcement path.

Section headings are trimmed, non-empty, and at most 80 Unicode code points. The existing bounds remain 500 total entries and 40 sections.

**Reset to timeline order** sorts current live photo entries by `timelineAt`, removes every section, preserves title and description, preserves an explicit cover only if it remains picked, and raises the nine-second message **Album order reset to the timeline. Sections were removed.**

The empty state is exact:

- **The album is empty.**
- “Pick photos in Library. A pick adds the photo to this album for every host on this event. It does not publish it.”
- **Go to Library**.

### 3.6 Undo

Destructive album actions offer one nine-second undo. A newer destructive action replaces the older offer. The timeout pauses while pointer or keyboard focus is inside the toast. Undo restores the affected entries, membership, and explicit cover as one user-visible action and then persists the restored canonical draft.

Exact messages include:

- one photo: **1 photo removed from the album. The original is still delivered.**;
- selection: **{n} photos removed from the album. The originals are still delivered.**;
- section: **Section removed.**;
- reset: **Album order reset to the timeline. Sections were removed.**; and
- start empty: **The album starts empty. The hearts were cleared.**

### 3.7 Inline preview

**Preview album** replaces the editor body; it does not open a modal and does not append a second album below the editor. The button becomes **Back to editing**.

The preview begins with **What a guest opening the link sees**, the current title, and description. Photos before the first section form an untitled lead block. Each section opens a titled block. Photo tracks have a minimum width of 150 pixels, 8-pixel gaps, 1.25 aspect ratio, and per-photo failed-preview fallbacks. Preview consumes real `mediaPreview(id)` URLs and the same resolved cover/title/description state that the public link will read after a successful flush.

### 3.8 Share, copy, and stop sharing

Album sharing is opt-in and separate from shared-gallery publication.

- **Share album** first flushes the latest valid draft, then creates or recovers one active share credential and shows its stable link.
- The link has the form `{canonicalOrigin}/album#{id}.{secret}`. The secret is a URL fragment, so it never reaches request URLs, referrers, or access logs.
- **Copy album link** copies the full fragment link and changes to **Copied** for 2.2 seconds.
- The shared card says: “Anyone holding this link can see the album. It does not change what the shared gallery shows.”
- **Stop sharing album** deletes the current share credential and all sessions derived from it. The old link and existing album cookies fail immediately. A later share creates a different credential.
- An active link remains usable until stopped or the event reaches its purge boundary. It does not acquire a shorter guest-access expiry.

Public exchange and reads are deliberately narrow:

1. `/album` reads the fragment in the browser and `POST`s `{ token }` to `/api/album-share/exchange` from an allowed application origin.
2. The Worker verifies the credential with `ALBUM_SHARE_HMAC_KEY`, decrypts host-recoverable credentials only with `ALBUM_SHARE_ENCRYPTION_KEY`, creates a random album session whose secret is digested with `SESSION_HMAC_KEY`, and sets `candidary_album` as `HttpOnly; Secure; SameSite=Strict; Path=/api/album-share`. The session expires at the earlier of seven days or the event purge boundary; the link itself remains valid until stopped or purged and may mint a new session.
3. The browser removes the fragment with `history.replaceState` before rendering or requesting previews.
4. `GET /api/album-share` and `GET /api/album-share/media/:mediaId/preview` resolve the session on every request and join it to the still-active share credential and non-purged event.

The share secret is stored only as a keyed digest and AES-GCM ciphertext so an authorized host can redisplay the stable link. Sessions store only a keyed digest. Neither raw token, fragment, digest, ciphertext, cookie, private object key, nor caption appears in application logs.

The public response is an allowlist containing only:

- album `title`, `description`, and resolved `coverMediaId`;
- ordered section `{ kind, id, heading }` entries; and
- ordered photo `{ kind, photo: { id, caption, previewAvailable } }` entries.

It excludes original filenames, contributor/guest names, uploader or manager identity, event internals, timestamps, publication state, favorite timestamps, dimensions, object keys, revisions, retention fields, and Guestbook data. A public image route serves only a browser-compatible preview for a current live photo entry; it never serves an original. A guessed, unpicked, deleted, foreign-event, or removed media ID receives the same unavailable response.

### 3.9 Album-only original export

**Download album photos** starts the existing export Workflow with `kind: 'album'`. The Library's **Download all** starts `kind: 'complete'` and retains its existing behavior exactly.

An album job snapshots, in one D1 transaction:

- the album's frozen raw entries JSON, which preserves every stored photo position and section boundary for order resolution without reading the live album on a retry;
- immutable source object key and canonical bucket generation;
- original filename, MIME type, source byte size, and existing export metadata;
- every current live picked photo with a unique `album_tail_position` assigned by `timeline_at ASC, id ASC`; and
- the request/snapshot time.

The Workflow resolves order by taking live-in-the-snapshot photo IDs from the frozen raw entries first, in stored order, then appending snapshot media absent from the raw entries by `album_tail_position`. Sections affect where stored photos sit but produce no media rows or ZIP entries. This is the same reconciliation rule as the manager read, frozen at request time.

An album export is refused if the resolved snapshot is empty, a selected source is not canonical, the event is deleted/purged, the size exceeds the existing event ceiling, or another complete/album export is queued or running for the event. The existing partial unique index continues to enforce at most one active export per event across both kinds.

The Workflow reads only the immutable `export_media_entries` snapshot, preserves album order through source-byte partitioning, writes the existing photo manifest and numbered ZIP parts, and never snapshots or emits printable/private Guestbook artifacts for an album job. It retains the existing canonical-source checks, retry ownership, tombstones, cleanup, range downloads, and 2-GiB source-byte part ceiling. Retrying a failed/expired album job reuses its original immutable snapshot.

Ready album links expire 24 hours after completion. The manager line before preparation is:

> {n} photos · {size}. This is the album only — Download all in Library stays the complete archive of every delivered original.

While queued or running it is:

> Preparing {n} photos · {size}. Download links last 24 hours.

The exports API exposes `kind: 'complete' | 'album'`. Manager Gallery filters by kind: Library never renders the latest album job as its complete export, and Album never renders a complete job as the album download.

### 3.10 Shared-mode hardening

Shared begins with this exact lede:

> Publication is a separate axis from the album. A photo is delivered privately whether or not it is published, and an album pick never publishes anything.

The existing Unpublished, Published, and Hidden workflow remains. These defects are fixed:

- switching filter clears selection;
- Publish and Hide are disabled both with no selection and while a bulk write is in flight;
- bulk labels become **Publishing…** and **Hiding…** while saving;
- each checkbox is named `Select {title}`;
- the moderation card does not apply an inline border that defeats `.selected`;
- preview images keep the existing 1.25 ratio without definite width/height attributes; and
- each failed image independently becomes **Preview unavailable** without blanking other cards.

## 4. Data and API contracts

### 4.1 One additive migration

`migrations/0018_album_end_to_end.sql` is the only migration for this scope. It follows 0017 and contains album metadata, album-share, and album-export schema so parallel work cannot collide on migration numbers.

It adds to `event_albums`:

```sql
title TEXT NOT NULL DEFAULT 'Album'
  CHECK (length(trim(title)) BETWEEN 1 AND 120),
description TEXT NOT NULL DEFAULT ''
  CHECK (length(description) <= 1000),
cover_media_id TEXT
```

`cover_media_id` deliberately has no media foreign key; unpick/delete must degrade to first-photo fallback without turning album cleanup into a required transaction.

It creates:

```sql
CREATE TABLE event_album_shares (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  secret_digest TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  shared_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE event_album_share_sessions (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES event_album_shares(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  secret_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX event_album_share_sessions_lookup
ON event_album_share_sessions(id, share_id, event_id);
```

It adds to export storage:

```sql
ALTER TABLE export_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'complete'
  CHECK (kind IN ('complete', 'album'));
ALTER TABLE export_jobs ADD COLUMN album_entries_json TEXT
  CHECK (
    (kind = 'complete' AND album_entries_json IS NULL)
    OR (
      kind = 'album'
      AND album_entries_json IS NOT NULL
      AND json_valid(album_entries_json)
      AND json_type(album_entries_json) = 'array'
    )
  );
ALTER TABLE export_media_entries ADD COLUMN album_tail_position INTEGER
  CHECK (album_tail_position IS NULL OR album_tail_position >= 1);

CREATE UNIQUE INDEX export_album_media_position
ON export_media_entries(export_job_id, album_tail_position)
WHERE album_tail_position IS NOT NULL;
```

Pre-0018 jobs receive `kind='complete'`, null album fields, and retain their existing compatibility behavior.

### 4.2 Shared TypeScript contracts

```ts
export type ExportKind = 'complete' | 'album';

export interface AlbumMetadataInput {
  title: string;
  description: string;
  coverMediaId: string | null;
}

export interface AlbumMetadataView extends AlbumMetadataInput {
  effectiveCoverMediaId: string | null;
}

export interface AlbumSaveRequest {
  revision: number;
  entries: AlbumEntryInput[];
  /** Optional only for compatibility with clients deployed before migration 0018. */
  metadata?: AlbumMetadataInput;
}

export interface AlbumShareView {
  active: true;
  url: string;
  sharedAt: string;
}

export type AlbumShareStatus = AlbumShareView | null;

export interface AlbumView {
  revision: number;
  saved: boolean;
  title: string;
  description: string;
  coverMediaId: string | null;
  effectiveCoverMediaId: string | null;
  entries: AlbumEntryView[];
  photoCount: number;
  sectionCount: number;
  totalBytes: number;
}

export type PublicAlbumEntryView =
  | { kind: 'section'; id: string; heading: string }
  | { kind: 'photo'; photo: { id: string; caption: string | null; previewAvailable: boolean } };

export interface PublicAlbumView {
  title: string;
  description: string;
  coverMediaId: string | null;
  entries: PublicAlbumEntryView[];
  photoCount: number;
}
```

The existing `AlbumEntryInput`, `AlbumEntryView`, `ManagerGalleryMediaView`, and favorite transport fields remain.

### 4.3 Manager API

All routes require manager authority for the path event. Writes require the existing Origin and CSRF guarantees.

```http
GET /api/manage/events/:eventId/album
```

Returns `{ album: AlbumView }`. Share status and its recoverable manager link are read only from the separate `/album/share` resource.

```http
PUT /api/manage/events/:eventId/album
Content-Type: application/json

{
  "revision": 7,
  "entries": [{ "kind": "photo", "mediaId": "..." }],
  "metadata": {
    "title": "The evening",
    "description": "The photographs we kept together.",
    "coverMediaId": "..."
  }
}
```

The response is `{ album: AlbumView }`. A stale revision receives the existing 409 album-conflict envelope. Validation receives 422. The route stores title, description, cover request, entries, `saved_at`, next revision, and `updated_at` in one guarded update.

Existing manager routes remain:

- `POST /api/manage/events/:eventId/album/picks` with `{ mediaIds, picked }`;
- `POST /api/manage/events/:eventId/album/start` with `{ start: 'from-picks' | 'empty' }`.

Sharing uses one manager resource:

```http
GET /api/manage/events/:eventId/album/share
POST /api/manage/events/:eventId/album/share
DELETE /api/manage/events/:eventId/album/share
```

GET returns `{ share: AlbumShareStatus }`. POST returns `{ share: AlbumShareView }`, creating a credential only when none is active. POST refuses an unsaved or zero-photo album with 409. DELETE returns `{ share: null }` after deleting the active share and cascading its sessions. Repeating POST while active returns the same URL and `sharedAt`.

Export creation uses the existing route. An omitted body or `{}` remains the complete export contract; the only new selector is the strict optional `kind`:

```http
POST /api/manage/events/:eventId/exports
Content-Type: application/json

{ "kind": "album" }
```

Returns 202 `{ export: ExportView }` with `kind: 'album'`. Existing export list, status, retry, artifact, range, and download routes serve both kinds. Existing `POST /api/manage/events/:eventId/exports` creates only `kind: 'complete'`.

### 4.4 Public album API

```http
POST /api/album-share/exchange
Content-Type: application/json

{ "token": "id.secret" }
```

Requires an allowed application Origin, sets the narrow HttpOnly cookie, and returns `{ album: PublicAlbumView }`. Invalid, stopped, deleted, or purged credentials use one non-enumerating album-unavailable envelope.

```http
GET /api/album-share
GET /api/album-share/media/:mediaId/preview
```

Both require the narrow album cookie and revalidate active share plus event lifecycle. Every response is `Cache-Control: private, no-store`; image responses add `X-Content-Type-Options: nosniff` and same-origin resource policy. No public album endpoint accepts a write or returns an original.

## 5. Accessibility and responsive contract

The implementation targets WCAG 2.2 AA and retains all earlier Gallery requirements.

- Every pointer action has a keyboard-operable control; drag is never the only reorder path.
- Touch targets are at least 44 by 44 CSS pixels; primary controls are at least 48 pixels high.
- Pick, selection, filter, cover, and mode state is programmatic and does not rely on color or glyph alone.
- Selected tile labels say **Deselect** when selected; selected whole moments say **Clear this moment**.
- Reorder, share, copy, export, save, selection, viewer, and undo outcomes are politely announced without competing live regions.
- Inline preview does not trap focus. Returning to editing restores focus to **Back to editing** / **Preview album**.
- Failed previews retain a named, stable photo position in manager, public preview, and Shared mode.
- Undo is reachable, does not vanish while focused, and uses `role="status"`, not an assertive alert.
- At 320 CSS pixels there is no document-level horizontal scroll.
- At 200% and 400% browser zoom, the mode switch, metadata fields, entry controls, share card, and download controls remain operable.
- Below 761 CSS pixels the three-mode switch stacks; at and above 761 it may become inline.
- The metadata panel wraps from cover beside fields to a single column without shrinking controls.
- The review grid uses `repeat(auto-fill, minmax(min(100%, 196px), 1fr))`; the public/inline preview uses 150-pixel tracks with the same narrow-width clamp.
- The docked tray remains inside the viewport at narrow widths using `width: min(92vw, 470px)`.
- Nonessential transitions are 160–220 milliseconds and are removed under `prefers-reduced-motion: reduce`.

## 6. Performance, lifecycle, and operational contract

- Library still loads 48-row keyset pages and never loads all 10,000 photos merely to render the timeline.
- Album is bounded at 500 entries, so its one revisioned JSON document and picked-photo resolution remain bounded.
- Preview screens fetch preview URLs only. Original objects are read only by the authorized export Workflow.
- Public album reads return only current live entries, and image authorization is rechecked per request.
- Share credentials and sessions cascade with event deletion. Lifecycle checks stop access at `purge_after` even before cleanup removes rows.
- Expired album-share sessions may be deleted by bounded expiry cleanup; no revoked-session audit row is retained. Stopping share deletes the parent credential and cascades every session immediately.
- Event purge and export-expiry cleanup discover both complete and album artifacts through existing export jobs, parts, and permanent write tombstones.
- Album export retains the source-byte partition limit `MAX_EXPORT_PART_SOURCE_BYTES = 2 * 1024 * 1024 * 1024` and ready-link lifetime 86,400,000 milliseconds.
- No new dependency, UI library, CSS-in-JS system, token file, R2 bucket, or Workflow binding is introduced. Use React 19, TypeScript, Hono, D1, the existing Export Workflow, `lucide-react`, DM Sans, Manrope, and `src/styles.css`.
- Add exactly two required secret bindings: `ALBUM_SHARE_HMAC_KEY` and `ALBUM_SHARE_ENCRYPTION_KEY`. Add them to `wrangler.jsonc`, generated binding checks, `.dev.vars.example`, and Worker test bindings. Album sessions continue to use the existing `SESSION_HMAC_KEY`.
- The supplied ZIP and unrelated untracked `src/features/print/` work remain untouched.

## 7. Acceptance criteria

The full end-to-end experience is accepted when all of the following are true:

- Gallery opens in Library and offers Library, Album, and Shared with the exact notes in §3.1.
- A pick is the existing event-wide favorite bit and never changes publication, delivery, complete-export membership, or album sharing.
- Library supports exact per-photo, whole-moment, and all-result selection labels; its tray appears only with a selection and reverses only actually changed IDs.
- Pre-album favorites receive the one-time reconciliation choice and its exact persistence/undo semantics.
- Title, description, cover, sections, and order survive reload and co-host revision conflicts without last-write races.
- A valid explicit cover and first-photo fallback resolve identically in manager preview and public view.
- The review-card grid supports keyboard moves and equivalent drag/drop, photo-only position numbers, sections in the same order, section rename/remove, cover choice, photo remove, and exact announcements.
- Reset sorts live photos by timeline, removes sections, preserves metadata, and restores through the nine-second undo.
- Preview replaces editing inline and uses real previews with per-photo failure states.
- Sharing creates a stable fragment URL, exchange clears the fragment, the narrow cookie can read only the allowlisted album and picked previews, and stop sharing invalidates both link and live sessions immediately.
- Public JSON contains no filenames, guest names, uploader/private fields, revision, timestamps, object keys, or publication/favorite data; public routes cannot return originals.
- Album download freezes the exact current ordered picked originals, preserves order across parts, omits Guestbook artifacts, retries the same snapshot, and expires downloads after 24 hours.
- Complete export remains every delivered original plus its existing manifest and Guestbook artifacts; the two manager UIs filter jobs by `kind`.
- At most one complete or album export is queued/running for an event.
- Shared mode clears selection on filter change, represents busy state, disables unavailable bulk actions, and handles failed previews per tile.
- Automated unit, Worker, UI, TypeScript, lint, build, accessibility, responsive, security, and album end-to-end suites pass.
- Rendered 924-by-540 Library, selection tray, reconciliation, Album editor, Album preview, share/download exits, and Shared states are compared with the ZIP's `01-state.png` through `07-state.png`; no P0 or P1 fidelity issue remains.
- Root `design-qa.md` records source, implementation, comparison method, P0/P1/P2 findings, remediation, and the exact line `final result: passed`.

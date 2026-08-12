# Candidary Curated Private Guestbook Design

- **Status:** Approved design; awaiting written-spec review
- **Date:** 2026-08-12
- **Scope:** Guest notes, photo captions, host curation, and guestbook exports

## 1. Decision

Candidary will turn the existing guest-note feature into an event-private,
host-curated guestbook without creating a second canonical content system.
Standalone notes remain in `guest_messages`, photo captions remain on `media`,
and a shared `GuestbookItem` projection combines them for guest reading, host
management, and export snapshots.

The guestbook remains secondary to Candidary's core private-photo journey. It
is available during the server-resolved `photos-primary` phase beneath photo
delivery and never blocks selecting, sending, or retrieving photos. A successful
delivery receipt adds a quiet **Leave a guestbook note** action that opens and
focuses the same guestbook composer; contributing a photo is not required to
write a note.

Guestbook privacy is event-private shared:

- approved notes are visible to guests with current event access;
- published captions are visible to those guests only while the shared gallery
  is enabled;
- unshared entries remain visible only to their author's current guest session
  and to authorized hosts; and
- deleted notes remain host-recoverable until event purge but appear in no
  guest read or export created after deletion.

Hosts curate one unified surface and receive two clearly separated guestbook
artifacts from the existing export system:

1. `guestbook.html`, a printable keepsake whose entries match what guests could
   see at the export snapshot; and
2. `guestbook-private.csv`, a plainly labelled private archive containing every
   non-deleted entry and its visibility state at that snapshot.

This design deepens the existing Invite -> RSVP -> arrive -> contribute ->
retrieve lifecycle. It does not turn Candidary into a public social feed,
event-planning suite, or permanent guest community.

## 2. Current problem

The current feature has useful foundations but does not yet feel or behave like
a guestbook:

- the guest surface calls it **Guest notes** and uses fixed prompt copy;
- a remembered uploader name is applied silently rather than shown as an
  intentional signature choice;
- the terminal photo-delivery receipt displaces the note entry point;
- guest feed items do not expose explicit ownership, making private state hard
  to explain safely;
- a published caption can enter the text feed even while the gallery is
  disabled;
- the Manager eagerly loads an unbounded notes list, badges every note, refreshes
  the whole page after mutations, and offers every action in every state;
- notes and captions are managed in separate mental models even though guests
  read them together; and
- the existing export contains private photo originals and media metadata but
  no curated guestbook keepsake or complete private entry archive.

The result is an optional message box rather than a coherent, private book that
guests can contribute to and hosts can preserve.

## 3. Goals

- Make leaving and reading guestbook entries feel like one calm, intentional
  extension of photo delivery.
- Let guests understand exactly how their name will appear and whether an entry
  is shared or visible only to them and the hosts.
- Preserve strict cross-session privacy without introducing guest accounts or
  claiming verified identity.
- Give hosts one bounded, lazy-loaded curation surface for standalone notes and
  photo captions.
- Make the host's **Shared** view an accurate preview of the current guest-visible
  book.
- Reuse note moderation and photo publication as the canonical state machines.
- Provide a printable guest-visible keepsake and a separately labelled private
  archive from one immutable export snapshot.
- Keep note creation, management, export generation, and cleanup bounded and
  retry-safe on the existing Worker, D1, R2, and Export Workflow architecture.
- Preserve Candidary's event themes, global Manager chrome, mobile-first targets,
  reduced-motion support, and separate physical-device acceptance gate.

## 4. Non-goals

- Replies, reactions, likes, mentions, profiles, follows, or guest directories.
- Public guestbook URLs, unauthenticated sharing, or search-engine discovery.
- Social or moderation notifications to guests.
- A guestbook enable/disable toggle separate from the existing guest phase and
  access lifecycle.
- A second canonical guestbook table that duplicates notes and captions.
- Independent keepsake-selection state beyond note moderation and photo
  publication.
- Bulk guestbook moderation in the first release.
- Guestbook search or arbitrary sorting.
- A separate Guestbook Workflow, queue, or realtime service.
- PDF generation, print fulfilment, image-heavy book layout, or embedded photo
  binaries in the printable HTML.
- Permanent guest access after the existing guest-access window.
- Changes to photo-original privacy, photo retention, RSVP identity, or event
  entry credentials.
- Deployment, remote migration, production backfill, or physical-device proof
  as part of design or implementation planning.

## 5. Chosen architecture

### 5.1 Layered projection

The feature uses one read model over existing source records:

- `MessagesRepository` remains the owner of standalone note creation,
  idempotency, moderation, deletion, and restoration.
- `MediaRepository` remains the owner of caption content, photo publication,
  and photo deletion.
- a focused `GuestbookRepository` owns only unified reads, summary counts,
  bounded pagination, and export-snapshot projection.
- guestbook renderers consume immutable export rows; they never re-read live
  note or caption state while generating or retrying artifacts.

No mutation writes a denormalized guestbook record. A note action updates
`guest_messages`; a caption action uses the existing media publication mutation.
The projection can therefore change internally without creating reconciliation
work between two canonical stores.

### 5.2 Alternatives not selected

**New canonical guestbook table.** Copying every note and caption into a new
table would simplify some reads but introduce dual writes, backfill rules,
publication drift, and a second deletion lifecycle. Those costs do not improve
the guest or host outcome.

**Standalone notes only.** Rebranding the note box while excluding captions
would be smaller, but guests already experience notes and captions as one feed.
It would leave hosts with two curation models and would not deliver the selected
keepsake.

**Always-live shared wall.** Immediate public-style display, reactions, and
realtime updates would conflict with Candidary's private event boundary and make
moderation, identity, and abuse substantially more complex.

### 5.3 Shared item contract

`GuestbookItem` is a discriminated union. Its source-specific state is never
collapsed into one ambiguous generic status.

```ts
type GuestbookVisibility = 'shared' | 'author_only' | 'host_only';

type GuestbookItemBase =
  | {
      id: string;
      source: 'guest_note';
      guestName: string | null;
      body: string;
      createdAt: string;
      state: 'pending' | 'approved' | 'rejected' | 'deleted';
      visibility: GuestbookVisibility;
    }
  | {
      id: string;
      source: 'photo_caption';
      mediaId: string;
      guestName: string | null;
      body: string;
      createdAt: string;
      state: 'unpublished' | 'published' | 'hidden';
      visibility: Exclude<GuestbookVisibility, 'host_only'>;
      previewAvailable: boolean;
    };

type GuestGuestbookItem = GuestbookItemBase & { isOwn: boolean };
type ManagerGuestbookItem = GuestbookItemBase;
```

`id` is the canonical note ID or media ID. Consumers use `(source, id)` as the
stable item key. The guest serializer must add required `isOwn`; the manager
serializer must omit that property and never include a guest-session ID.
`previewAvailable` is descriptive only. The existing authenticated preview
route still decides whether image bytes may be served.

### 5.4 State and visibility mapping

| Source state | Guest visibility | Manager view | Printable HTML | Private CSV |
| --- | --- | --- | --- | --- |
| Note `pending` | Author's current session only | Needs review | Excluded | Included |
| Note `approved` | All current event guests | Shared | Included | Included |
| Note `rejected` | Author's current session only | Hidden | Excluded | Included |
| Note soft-deleted | None | Deleted | Excluded | Excluded |
| Caption `unpublished` | Uploader's current session only | Needs review | Excluded | Included |
| Caption `published`, gallery on | All current event guests | Shared | Included | Included |
| Caption `published`, gallery off | Uploader's current session only | Hidden | Excluded | Included |
| Caption `hidden` | Uploader's current session only | Hidden | Excluded | Included |
| Caption on deleted/failed/reserved media | None | Excluded | Excluded | Excluded |

All mappings are evaluated from server-owned source state. Browser state,
remembered names, and route identifiers never grant visibility.

## 6. Event setting and prompt

Every event has `guestbookPrompt`, a trimmed 1-160 character string. Existing
events receive this default:

> Share a wish, memory, or moment from the day.

Settings adds one **Guestbook prompt** textarea in the ordinary event-settings
domain. It follows the approved Settings autosave contract: complete-payload
validation, the existing serialized/coalescing queue, server-confirmed status,
and no whole-manager refresh. **Reset prompt** is an explicit action that puts
the default into the draft and autosaves it without a second Save action.

The existing `moderationRequired` switch remains authoritative and is labelled
**Review guestbook notes before sharing**:

- when on, a new note starts `pending`;
- when off, a new note starts `approved` and is immediately guest-visible; and
- changing the setting affects only future notes. It does not retroactively
  approve or hide existing notes.

There is no separate guestbook toggle. The guestbook is available only in the
`photos-primary` phase and only while the existing guest session is valid.

`guestbookPrompt` is added to manager and allowlisted guest event contracts. It
must not be overloaded into `welcomeMessage`; the two fields have different
placement, length, and purpose.

## 7. Guest experience

### 7.1 Placement and disclosure

The event page renames **Guest notes** to **Guestbook**. During
`photos-primary`, it is the first secondary disclosure beneath the primary photo
delivery experience. The disclosure may be opened without first contributing a
photo.

After successful photo delivery, the terminal receipt stays intact and adds a
quiet **Leave a guestbook note** action. Activating it opens the existing
Guestbook disclosure, scrolls it into view without animation when reduced motion
is requested, and focuses the composer heading rather than unexpectedly placing
the cursor in a text field.

Guestbook content appears in this order:

1. host prompt and privacy explanation;
2. note composer;
3. **Your private entries**, when the current session has unshared content; and
4. **Shared guestbook**.

The composer remains usable if loading the feed fails. A feed error appears in
the reading area with Retry; it does not disable or clear the note draft.

### 7.2 Attribution

When a remembered uploader name exists, the composer shows:

**Signed as Taylor** · **Change** · **Leave unsigned**

With no active signature, it shows:

**Unsigned** · **Add your name**

The signature is a display name, not a verified identity. The privacy copy must
not imply otherwise.

- **Leave unsigned** sends `guestName: null` for that note without erasing the
  remembered photo-uploader name.
- **Change** updates the remembered name through the existing uploader-name
  mechanism and uses the changed value for the note.
- **Add your name** creates or updates that same remembered value.
- A later note may be signed or unsigned independently.

The text area accepts a trimmed 1-500 character body. `guestName` is `null` or a
trimmed 1-80 character display name; an empty or whitespace-only submitted name
canonicalizes to `null`. `idempotencyKey` is a required opaque string whose
trimmed canonical value is 1-128 characters and is compared byte-for-byte after
that normalization. The client and Worker enforce the same bounds.

### 7.3 Submission receipt and draft safety

A successful send inserts a server-confirmed card labelled **Your entry** at
the top of **Your private entries** or **Shared guestbook**, according to its
returned state, and announces:

> Safely sent to Maya & Theo.

The names come from the current event name; the quoted text is the example for
an event named **Maya & Theo**.

If moderation is required, the card also says that only this guest session and
the hosts can see it until it is shared. “Only you” always means the current
guest session; clearing its storage, using another device, session rotation, or
session expiry may remove that private read-back. Candidary does not claim a
guest account or durable identity.

The client keeps one idempotency key for an unchanged draft across network
failure and ambiguous retry. Editing the body or signature after a failed send
creates a new key before the next send. A failure preserves the body and
signature choice and places Retry beside the composer. A successful exact
replay returns the original item and does not duplicate it in the UI.

### 7.4 Reading the book

The guest read returns:

- every approved, non-deleted note;
- every caption on stored, non-deleted media that is published while the
  gallery is enabled; and
- every non-deleted note or stored caption owned by the current guest session,
  regardless of whether it is shared.

Unshared owned entries live in **Your private entries**. When a host shares one,
the next read moves it into **Shared guestbook** and retains a **Your entry**
marker. Other guests never receive the unshared row.

The shared book is newest-first. The first bounded page loads when the disclosure
opens; **Show earlier** appends the next older page without replacing or
reordering rows already on screen. One **Show earlier** control follows both
guestbook sections and advances the unified cursor; each returned row is placed
in the private or shared section from its server visibility. There is no guest
background polling. Reopening, submitting, or explicitly retrying refreshes the
feed by replacing all accumulated rows with a fresh first page and resetting
`nextCursor`. The returned submission item is deduplicated by `(source, id)`;
refresh never moves focus or scroll.

A caption preview is requested only when the corresponding item is authorized.
Turning the gallery off removes published captions from the shared book as well
as the visual gallery; the text feed and thumbnail rules cannot diverge.

## 8. Host experience

### 8.1 Navigation and loading

Manager navigation renames **Notes** to **Guestbook**. Its badge shows only the
unresolved `needsReviewCount`: pending notes plus unpublished captions on stored,
non-deleted media. Approved, hidden, published, deleted, and gallery-suppressed
entries do not inflate the badge.

Initial Manager loading fetches the small guestbook summary only. No guestbook
rows load until the host opens that destination. On first entry:

- open **Needs review** when `needsReviewCount > 0`; otherwise
- open **Shared**.

The four views are visibility-oriented buckets:

- **Needs review:** pending notes and unpublished captions;
- **Shared:** exactly the notes and captions currently visible to another event
  guest;
- **Hidden:** rejected notes, hidden captions, and published captions suppressed
  because the gallery is off; and
- **Deleted:** soft-deleted standalone notes only.

When the gallery is disabled, Shared explains that captions are not visible to
guests and links to the existing Settings control. A published caption in
Hidden retains the state label **Published · gallery off**; the system does not
silently rewrite it to `hidden`.

### 8.2 Rows and filters

Each row shows:

- source type;
- display name or **Unsigned**;
- timestamp formatted in the event's time zone;
- body text;
- exact source state and current visibility;
- a photo preview for captions when available; and
- only actions valid from that state.

Rows wrap long names and bodies and never expose source object keys, session IDs,
or original-photo URLs.

Each view may filter by **All entries**, **Notes**, or **Photo captions**. Pages
default to 25 rows and may request at most 50. **Show earlier** appends by an
opaque keyset cursor. Changing view or source filter clears rows and cursors
before loading the new first page.

### 8.3 Action matrix

| Current row | Primary action | Secondary actions | Canonical mutation |
| --- | --- | --- | --- |
| Pending note | **Share** | **Keep private**, **Delete** | Note -> `approved`, `rejected`, or soft-deleted |
| Approved note | - | **Keep private**, **Delete** | Note -> `rejected` or soft-deleted |
| Rejected note | **Share** | **Delete** | Note -> `approved` or soft-deleted |
| Deleted note | **Restore** | - | Clear `deleted_at`, set `rejected`, and clear `approved_at` |
| Unpublished caption | **Publish photo & caption** | **Hide photo & caption** | Media -> `published` or `hidden` |
| Published caption | - | **Hide photo & caption** | Media -> `hidden` |
| Hidden caption | **Publish photo & caption** | - | Media -> `published` |

Guestbook never deletes media. Photo deletion remains in the existing photo
intake/gallery workflow. Caption actions call the existing media publication
mutation so the photo and caption cannot acquire contradictory publication
states.

### 8.4 Mutation behavior

An action disables only its row. The host sees a row-local busy label, then a
server-confirmed state change or a row-local error with Retry. The client maps
the confirmed source state returned by the mutation into the affected view and
updates its local badge/counts; the next summary poll reconciles concurrent
changes. The Manager does not issue a whole-page refresh.

Successful actions preserve focus at a meaningful control in the updated row
or at the next row when the item leaves the current view. They preserve the
page's scroll position. Sharing, hiding, and restoring are not announced before
the Worker confirms them.

Delete is recoverable through an immediate **Undo** action and the persistent
Deleted view. Undo uses the same restore mutation and always returns the note to
Hidden, never directly to Shared, even if it was approved before deletion.

Bulk selection and bulk moderation are deferred.

### 8.5 Refresh behavior

While Guestbook is visible, the Manager refreshes its summary on window focus
and every 15 seconds. It does not poll while the document is hidden or another
Manager destination is active.

Summary polling never claims that unchanged counts prove unchanged rows. A
persistent **Refresh entries** action reloads the active view when the host wants
current rows. A successful refresh replaces all accumulated rows with the fresh
first page and resets `nextCursor`; a failure retains the old rows and cursor.
Focus remains on the Refresh action and scroll does not move. Background polling
never auto-prepends rows. Row mutations merge immediately and do not wait for
the poll.

## 9. API contracts

All responses retain Candidary's `{ data, requestId }` envelope. Guest routes
require the current event guest session and exact slug match. Manager routes use
`requireManager`; reads accept either valid Manager credential and writes retain
the authorizing credential's CSRF scope.

### 9.1 Guest routes

The existing route family remains to avoid an unnecessary public-contract
rename:

```text
POST /api/event/:slug/messages
GET  /api/event/:slug/messages?cursor=<opaque>
```

`POST` accepts:

```ts
interface CreateGuestbookNoteRequest {
  body: string;
  guestName: string | null;
  idempotencyKey: string;
}
```

It returns `{ item: GuestbookItem, replayed: boolean }`. The response item is
always owned by the current session. A new row is `pending` or `approved` from
the event's current `moderationRequired` value.

`GET` returns `{ items, nextCursor }` with the existing bounded 50-item guest
page. Every returned item includes `isOwn`. Invalid cursors are rejected with
422 rather than treated as the first page.

### 9.2 Manager reads

```text
GET /api/manage/events/:eventId/guestbook/summary
GET /api/manage/events/:eventId/guestbook
    ?view=needs-review|shared|hidden|deleted
    &source=all|guest_note|photo_caption
    &limit=25
    &cursor=<opaque>
```

The summary returns:

```ts
interface GuestbookSummary {
  needsReviewCount: number;
  sharedCount: number;
  hiddenCount: number;
  deletedCount: number;
  galleryVisible: boolean;
}
```

The list response returns `{ items, nextCursor, summary }`. `limit` defaults to
25 and is rejected above 50. Unsupported enum values, malformed cursors, and a
cursor issued for a different event/view/source return 422.

The versioned cursor binds the event ID, view, source filter, and the last
row's `(created_at, source_rank, id)` key. Results sort newest-first by that key.
The encoded value is opaque to clients and is never accepted as authorization.

### 9.3 Manager mutations

Standalone note actions extend the existing endpoint:

```text
PATCH /api/manage/events/:eventId/messages/:messageId
```

The request includes one action (`approve`, `reject`, `delete`, or `restore`)
and the exact `expectedState`. The route confirms the note belongs to the path
event and performs one state-guarded update. Success retains the existing
`{ message }` response shape with the complete canonical note record. A stale or
cross-state action returns `409 MESSAGE_STATE_CONFLICT` and the client reloads
that row or active page.

Caption rows continue to use:

```text
PATCH /api/manage/events/:eventId/media/:mediaId
```

with `publish` or `hide` and the current `expectedStatus`. Success retains the
existing `{ media }` response shape with the complete canonical media record.
Caption conflicts retain `MEDIA_STATE_CONFLICT`. Guestbook does not add a
second caption mutation endpoint.

After either successful mutation, the client projects the returned canonical
record into its active row and immediately refetches only the small summary.
This is the response/data flow meant by the local badge and count update in
Section 8.4; neither route needs a guestbook-specific response envelope or a
whole-page refresh.

## 10. D1 schema and repository behavior

The next numbered migration adds the following bounded extensions.

### 10.1 Event prompt

`events.guestbook_prompt` is non-null with the approved default and a database
check of 1-160 characters. The event repository maps it into `EventView`,
`GuestEventView`, event creation, Settings reads/writes, and export metadata.

### 10.2 Note submission window

`guest_message_rate_limits` stores one current fixed window per globally unique
`guest_session_id`:

- `window_started_at`;
- `count`, constrained from 1 through 5; and
- a primary-key foreign key to `event_sessions(id)` with `ON DELETE CASCADE`.

The referenced event session already binds the row to exactly one event, so the
rate table does not duplicate an independently mutable `event_id`.

It stores no IP address, name, note body, or idempotency key. A supporting
`guest_messages(event_id, guest_session_id, created_at)` index makes ownership
and defensive audits bounded. Manager/feed indexes cover event, source state,
deletion state, descending creation time, and ID; media reuses its existing
stored/publication pagination indexes.

### 10.3 Export job metadata

Legacy-compatible nullable columns on `export_jobs` store:

- `guestbook_html_object_key`, `guestbook_html_bytes`, and
  `guestbook_html_sha256`;
- `guestbook_csv_object_key`, `guestbook_csv_bytes`, and
  `guestbook_csv_sha256`;
- `guestbook_entry_count` and `guestbook_shared_count`; and
- `guestbook_event_name`, `guestbook_event_date`,
  `guestbook_event_timezone`, `guestbook_prompt`, and
  `guestbook_gallery_visible`.

Pre-migration jobs keep these columns null and remain valid photo-only exports.

### 10.4 Immutable export entries

`export_guestbook_entries` belongs to one export job with `ON DELETE CASCADE`.
Each row stores only what artifact generation needs:

- source and source ID;
- nullable guest name;
- body;
- creation time;
- exact source state;
- derived `guest_visibility` (`shared` or `author_only`);
- `included_in_keepsake`;
- nullable media ID and original filename; and
- a deterministic `(created_at, source_rank, source_id)` sort key.

The table contains no session ID, credential, RSVP data, object key, or original
photo bytes. An index on `(export_job_id, created_at, source_rank, source_id)`
supports bounded oldest-first rendering.

### 10.5 Snapshot transaction

Export creation uses one atomic D1 batch:

1. `INSERT ... SELECT` the queued job, snapshot metadata, and source counts only
   when the same D1 snapshot has at least one exportable photo or non-deleted
   guestbook entry;
2. insert every eligible note/caption through one parameter-bounded
   `INSERT ... SELECT` guarded by the first statement's `changes()` result; and
3. inspect the first statement: an active-job uniqueness conflict remains
   `EXPORT_ALREADY_ACTIVE`; when no row is inserted, re-read the active-job
   predicate and return `EXPORT_ALREADY_ACTIVE` if a concurrent job won,
   otherwise return `EXPORT_EMPTY`.

The projection includes every eligible non-deleted standalone note and every
non-empty caption on stored, non-deleted media. It derives shared visibility
using the event's gallery value captured in the same transaction. The new-note
cap prevents post-migration events from growing beyond 1,000 retained notes,
but snapshot and export code must not truncate legacy events that already
contain more; the private archive remains complete.

Once inserted, snapshot rows are immutable. Retrying an expired or failed job
uses the same rows and metadata. A host who changes moderation, publication,
gallery visibility, prompt, or deletion state after `snapshotAt` must create a
new export to capture those changes; the Manager labels every artifact with its
snapshot time.

## 11. Submission protection and capacity

New standalone notes use three independent protections.

### 11.1 Edge shedding

A dedicated `GUEST_MESSAGE_RATE_LIMIT` binding allows 120 submission requests
per minute per event and trusted client IP. It runs after guest-session/event
authorization but before parsing the request body. It does not reuse the host
authentication or RSVP lookup limiter.

An edge rejection returns `429 RATE_LIMITED` and `Retry-After`. It is a coarse
abuse shield, not the durable note quota.

### 11.2 Durable session window

A guest session may create at most five new notes in one server-defined
15-minute fixed window. Exact idempotent replays do not increment the window.

Creation uses one guarded D1 batch following the repository's existing
`changes()` pattern:

1. reserve one window count only when no row already exists for this
   `(event, session, idempotencyKey)`, the window has capacity, and the event is
   below its retained-note cap;
2. insert the note only when the reservation changed one row; and
3. inspect the stored idempotent row and current counters to distinguish replay,
   payload conflict, session limit, and event limit.

The unique `(event_id, guest_session_id, idempotency_key)` index remains the
final duplicate guard. A same-key/same-payload replay returns the original row.
The same key with a changed body or signature returns
`409 MESSAGE_SUBMISSION_CONFLICT`.

The durable window failure returns `429 RATE_LIMITED` with `Retry-After` based
on the server window. The guest draft remains intact.

### 11.3 Event retained-note cap

An event may retain at most 1,000 standalone notes. The count includes
soft-deleted notes so deleting cannot reopen abuse capacity. Captions remain
bounded by the existing stored-photo cap and are not counted as standalone
notes.

The guard is part of the same SQL reservation as creation, not a read-then-write
check. A full event returns `409 MESSAGE_EVENT_LIMIT` with calm copy that says
the guestbook is not accepting more notes. Purge, not soft deletion, releases
retained-note capacity.

The migration never deletes or truncates legacy notes. An event already at or
above 1,000 remains readable and manageable but rejects new standalone notes.

## 12. Export artifacts

### 12.1 Separate downloads

A ready manager export created after this migration exposes three separately
labelled groups when photos exist, or the final two groups for a notes-only
event:

1. the existing photo manifest and ZIP parts, unchanged;
2. **Printable guestbook** -> `guestbook.html`; and
3. **Private entry archive - contains entries guests cannot see** ->
   `guestbook-private.csv`.

The HTML and CSV are not bundled into one ZIP. Their separation and labels are
a privacy control: a host can share or print the curated book without casually
including pending or hidden entries.

The export download response adds nullable signed descriptors for both new
objects. It signs them only after current manager authorization, uses the
existing 15-minute signed-URL lifetime, and returns the same expiry timestamp
shown to the host. There are no guest routes, public bucket URLs, permanent
links, email attachments, or automatic sharing.

### 12.2 Printable HTML

`guestbook.html` contains exactly the snapshot rows whose
`included_in_keepsake` value is true:

- notes approved at `snapshotAt`; and
- captions published at `snapshotAt` while the gallery was enabled at
  `snapshotAt`.

It is content-equivalent to the shared book any current event guest could see
at that instant; author-only cards are not part of the keepsake. It is not a
pixel-for-pixel copy of the interactive event page. It uses a neutral,
self-contained Candidary print treatment and contains:

- event name and date;
- the snapshotted guestbook prompt;
- a visible **Prepared from the guestbook on ...** timestamp in the event time
  zone;
- entries ordered oldest-first for reading and printing;
- **Unsigned** for null names;
- event-zoned entry timestamps; and
- a **Photo caption** label plus the corresponding photo archive part/path when
  applicable.

The document has no JavaScript, forms, analytics, remote fonts, remote styles,
remote images, cookies, or network requests. Contributed strings are HTML-
escaped, rendered as text, and wrapped in semantic `article` elements with
`dir="auto"`. Inline CSS provides readable screen and print layouts. MVP does
not embed previews or original image bytes.

An export with no shared rows still produces a valid printable document that
says no entries were shared at the snapshot. This is valid when the private CSV
contains pending or hidden content.

### 12.3 Private CSV

`guestbook-private.csv` contains every entry that was non-deleted at
`snapshotAt`:

- pending, approved, and rejected standalone notes; and
- non-empty captions on stored, non-deleted media in unpublished, published,
  or hidden state.

Its columns, in order, are:

```text
entry_type,entry_id,guest_name,body,created_at,source_status,guest_visibility,media_id,photo_archive_part,photo_archive_path
```

`source_status` preserves the exact canonical note or caption state.
`guest_visibility` is `shared` or `author_only` according to the snapshot
matrix. A published caption is `author_only` when the gallery was disabled.

Caption rows map to the filename/path assigned by the existing photo export
partitioner. Standalone notes leave the three photo columns empty. Every field
passes through the shared `csvCell()` formula-injection defence and CSV escaping.
The file contains no guest-session IDs, IP addresses, idempotency keys,
credentials, RSVP records, deleted notes, or deleted/failed/reserved media.

### 12.4 Workflow and retry behavior

The existing `ExportWorkflow` remains the only export orchestrator. It adds
deterministic steps that:

1. read the immutable guestbook rows and existing media snapshot in bounded
   pages, then compute the existing deterministic photo partition/path plan;
2. generate the existing photo manifest/parts when photos exist;
3. generate the HTML and private CSV under the current attempt prefix using the
   already-fixed photo archive mapping;
4. retain only object references, counts, and digests in Workflow step results;
   and
5. atomically mark the job Ready with the complete object inventory.

The job becomes Ready only when every applicable artifact succeeds. A failure
deletes all objects created under that attempt, records a bounded `EXPORT_*`
error, and exposes the existing Retry action. Retry increments `attempt`, uses
a new R2 prefix, and renders from the same immutable snapshot.

`markReady` is widened to permit zero photo parts when at least one guestbook
snapshot row exists. Notes-only, photos-only, mixed, and private-only guestbook
events are valid. `EXPORT_EMPTY` applies only when there are no stored,
non-deleted photos and no non-deleted guestbook rows at snapshot time.

Every new-format job writes both guestbook files, including an empty curated
HTML/CSV pair for a photos-only snapshot. Pre-migration jobs remain photo-only
and downloadable. A missing nullable guestbook artifact never invalidates a
legacy manifest.

### 12.5 Expiry and purge

Both guestbook objects inherit the export's existing 24-hour Ready-artifact
expiry. The daily cleanup inventory deletes the HTML, private CSV, manifest,
and every ZIP part before moving the job to Expired. Snapshot rows stay in D1
so an authorized host may explicitly retry the same historical snapshot.

Event purge deletes R2 objects first, then dependent export rows and
`export_guestbook_entries`, then notes/media and the event in the repository's
required order. No cleanup path infers object keys from prefixes when a durable
inventory row exists.

Retention-warning, privacy, and operational copy must explicitly name guestbook
notes and captions and distinguish the guest-visible keepsake from the private
archive. Those documentation and notification changes are part of
implementation, but production policy or legal approval remains a separate
release gate.

## 13. Error handling and resilience

### 13.1 Guest failures

- Feed load failure retains any already rendered entries and leaves the
  composer enabled.
- Submission network/server failure preserves body, signature choice, and the
  unchanged idempotency key.
- A payload conflict preserves the draft but issues a new key only after the
  guest edits or explicitly chooses to send the changed version.
- Rate-limit responses show the retry time from `Retry-After` without a
  countdown that depends on the device clock.
- Event-limit responses disable only new note submission; the existing book
  remains readable.
- Session expiry follows the existing re-entry flow and does not expose the
  unsent draft to another event.

### 13.2 Manager failures

- Summary or page failure preserves the last confirmed data and offers a
  section-local Retry.
- A row mutation failure affects only that row.
- `MESSAGE_STATE_CONFLICT` or `MEDIA_STATE_CONFLICT` replaces the stale row from
  a focused refetch or refreshes the active first page; it does not replay the
  stale action automatically.
- A disappearing/deleted media row is removed from the projection without
  offering a guestbook media-delete action.
- Polling failures do not dismiss the panel, clear pagination, or repeat alerts
  every 15 seconds.

### 13.3 Export failures

- Snapshot creation is atomic; a failed snapshot leaves no queued job or
  partial snapshot rows.
- Artifact generation is all-or-nothing at the Ready boundary.
- Retry never reads current moderation/publication state.
- Missing source photo bytes retain the existing export failure behavior; the
  system does not publish a partial Ready job while silently omitting a photo.
- Cleanup failure leaves durable inventory/state for the next bounded cleanup
  attempt.

## 14. Privacy, authorization, and observability

- Possession of a route ID, note ID, media ID, export ID, or cursor grants
  nothing. Every request reauthorizes the event and credential scope.
- Guest ownership compares canonical event-session IDs on the Worker. Clients
  cannot submit or query an ownership ID.
- Host-account membership and management-link authorization retain their
  existing precedence and CSRF rules.
- Guest responses never include another session's private row, even when the
  other row shares a name or idempotency key.
- Manager and export responses may include display names and contributed text
  but never session IDs, credential digests, IP addresses, or object keys.
- Application logs record request ID, event ID, operation/result code, source
  type, and bounded counts. They do not record note/caption bodies, guest names,
  raw IP addresses, signed URLs, or artifact contents.
- Metrics distinguish guest feed reads, note creations/replays/rate limits,
  moderation conflicts, guestbook snapshot counts, artifact generation
  failures, and cleanup outcomes without high-cardinality contributed text.

## 15. Accessibility and visual behavior

Guest surfaces inherit the resolved event theme through the existing semantic
tokens. Manager navigation, filters, rows, errors, and actions remain in global
Candidary chrome. The feature introduces no arbitrary colors, radii, fonts,
inline host-authored styling, or remote assets.

Requirements:

- native buttons, textareas, links, and disclosure semantics where applicable;
- at least 44 by 44 CSS-pixel interactive targets;
- visible `:focus-visible` treatment and logical keyboard order;
- labels and state text that remain understandable without color or icons;
- polite, atomic live-region announcements for sends and row mutations;
- no focus stealing on feed refresh, polling, or background errors;
- no auto-prepending rows that changes scroll position;
- `dir="auto"` and overflow wrapping for names, prompts, notes, and captions;
- event-time-zone formatting supplied from server-authoritative values;
- reduced-motion behavior for disclosure/scroll transitions;
- usable layouts at 320 CSS pixels, 390 CSS pixels, 200% zoom, and 400% zoom;
- no horizontal document overflow with 500-character notes or 160-character
  prompts; and
- semantic, keyboard-readable, high-contrast HTML when the printable artifact
  is opened on screen before printing.

Automated accessibility and responsive evidence does not establish physical
VoiceOver/TalkBack acceptance. Physical iPhone, Android, VoiceOver, TalkBack,
QR, and degraded-network rehearsal remain separately recorded release gates.

## 16. Testing and acceptance

### 16.1 Migration and repository tests

- Existing-event default prompt and fresh-event prompt creation.
- Database prompt, source-state, rate-count, and export-row constraints.
- Ordered migration discovery through the next numbered migration.
- Guest/manager keyset ordering across equal timestamps and both sources.
- Cursor binding to event, view, source filter, and version.
- Summary/view mapping with gallery on and off.
- Export snapshot transaction rollback and immutable retry rows.
- Legacy export rows with null guestbook fields.

### 16.2 Worker/API tests

- Two guest sessions prove approved sharing and strict pending/rejected/hidden
  isolation.
- `isOwn` is correct and no session IDs leave the Worker.
- Gallery-off removes published captions from other guests while retaining the
  uploader's author-only read-back.
- Moderation-off notes start approved; toggling the setting is not retroactive.
- Same-key/same-payload replay, changed-payload conflict, concurrent replay,
  fixed-window boundary, edge limiter, and 1,000-note cap.
- Soft deletion, Undo/restore-to-rejected, cross-event mutation refusal, and
  stale expected-state conflicts.
- Manager summary, four views, source filters, page-size bounds, and cursors.
- Caption actions call media publication and never delete media.

### 16.3 Export and cleanup tests

- Approved/published curated HTML and complete non-deleted private CSV.
- Gallery-on/off visibility captured at snapshot time.
- State changes and deletions after snapshot do not change that job or retry.
- HTML escaping, `dir="auto"`, no scripts/remote requests, oldest-first order,
  event-zoned dates, and empty-shared-book copy.
- CSV quoting, line breaks, Unicode, formula hardening, exact columns, and
  source-state/visibility values.
- Caption-to-photo archive part/path mapping.
- Notes-only, photos-only, mixed, private-only, and truly empty events.
- Failed-attempt object cleanup, retry attempt prefixes, Ready atomicity,
  signed-download authorization, expiry, legacy jobs, and event purge.
- Common browser opening/printing of HTML and common spreadsheet opening of CSV
  without changing the stored bytes or privacy labels.

### 16.4 Client/unit tests

- Receipt action opens Guestbook without replacing photo-delivery success.
- Signed, changed-name, and unsigned submission behavior.
- Draft/idempotency preservation and reset after successful or edited sends.
- Composer isolation from feed failure.
- Private-to-shared movement with **Your entry** retained.
- Manager summary-only initial load and lazy first page.
- Pending-only badge, default view, source filters, Show earlier, summary
  polling, and explicit Refresh entries behavior.
- Row-local busy/success/error/conflict states, stable focus/scroll, Undo, and
  exact action matrix.

### 16.5 Browser and release gates

Browser coverage uses production-like static output with stubbed APIs for:

- 320x844 and 390x844 guest/Manager layouts;
- representative desktop layouts;
- keyboard-only contribution and moderation;
- long names, max prompt/body, Unicode, RTL content, and gallery-off states;
- 200% and 400% zoom without clipping or horizontal overflow;
- reduced motion and visible focus;
- automated accessibility scans; and
- printable HTML screen and print rendering.

Before implementation is called complete, run the repository's focused tests
plus typecheck, E2E typecheck, lint, full unit/Worker tests, build, browser suite,
binding verification, migration verification, and diff checks appropriate to
the final change. Immutable release-candidate verification, remote migration,
deployment, runtime certification, and physical-device acceptance remain
separate evidence gates and require separate authority.

## 17. Implementation boundaries

The implementation plan should decompose this approved design into independently
verifiable slices while preserving one product contract:

1. contracts, migration, prompt persistence, and projection repositories;
2. privacy-correct guest reads, bounded/idempotent creation, and guest UI;
3. manager summary/pagination, state actions, and lazy host UI; and
4. immutable snapshot, HTML/CSV rendering, Workflow/download integration,
   cleanup, copy, and end-to-end verification.

Each slice must begin with failing focused tests, keep unrelated worktree changes
untouched, and avoid broad staging. No slice may claim deployment, remote D1
migration, production data migration, or physical-device proof merely because
local implementation gates pass.

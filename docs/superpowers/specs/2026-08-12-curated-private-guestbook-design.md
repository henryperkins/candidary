# Candidary Curated Private Guestbook Design

- **Status:** Revised after written-spec review; awaiting approval
- **Date:** 2026-08-12
- **Scope:** Guest notes, photo captions, host curation, and guestbook exports

## 1. Decision

Candidary will turn the existing guest-note feature into an event-private,
host-curated guestbook without creating a second canonical content system.
Standalone notes remain in `guest_messages`, photo captions remain on `media`,
and a shared `GuestbookItem` projection combines them for guest reading, host
management, and export snapshots.

The guestbook remains secondary to Candidary's core private-photo journey. New
note creation is available during the server-resolved `photos-primary` phase
beneath photo delivery and never blocks selecting, sending, or retrieving
photos. Reading an already-contributed book remains available to a valid guest
session in every phase, including while photo intake is paused. A successful
delivery receipt adds a quiet **Leave a guestbook note** action that opens and
focuses the same guestbook composer; contributing a photo is not required to
write a note.

Guestbook privacy is event-private shared:

- approved notes are visible to guests with current event access;
- published captions are visible to those guests only while the shared gallery
  is enabled;
- unshared entries remain visible only to their author's current guest session
  and to authorized hosts; and
- soft-deleted notes remain host-recoverable until event purge unless a host
  explicitly and permanently deletes them; they appear in no guest read or
  export created after deletion.

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
  archive from one immutable guestbook snapshot while retaining the existing
  photo-export snapshot behavior and its explicitly documented failure modes.
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
  note or caption state while generating or retrying the HTML or private CSV;
  and
- the photo manifest and ZIP renderer retains its existing
  `MediaRepository.exportSnapshot()` behavior, including its retry limitations,
  rather than being described as a persisted media snapshot.

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

`shared/contracts.ts` owns the `GuestbookItem`, `GuestGuestbookItem`, and
`ManagerGuestbookItem` wire types. `GuestbookItem` is a discriminated union;
its source-specific state is never collapsed into one ambiguous generic
status. Soft-deleted notes use `host_only`: they are host-recoverable, present
in no guest read, and present in no export row created after deletion.
`host_only` is a Manager wire value only and never appears in a guest response.

```ts
type GuestbookSharedVisibility = 'shared' | 'author_only';

type GuestbookNoteItem = {
  id: string;
  source: 'guest_note';
  guestName: string | null;
  body: string;
  createdAt: string;
  state: 'pending' | 'approved' | 'rejected';
  visibility: GuestbookSharedVisibility;
};

type DeletedGuestbookNoteItem = Omit<
  GuestbookNoteItem,
  'state' | 'visibility'
> & {
  state: 'deleted';
  visibility: 'host_only';
};

type GuestbookCaptionItem = {
  id: string;
  source: 'photo_caption';
  mediaId: string;
  guestName: string | null;
  body: string;
  createdAt: string;
  state: 'unpublished' | 'published' | 'hidden';
  visibility: GuestbookSharedVisibility;
  previewAvailable: boolean;
};

type GuestbookVisibleItem = GuestbookNoteItem | GuestbookCaptionItem;
type GuestbookItem = GuestbookVisibleItem | DeletedGuestbookNoteItem;
type GuestbookCompatibilityAliases = {
  /** @deprecated */ kind: 'message' | 'caption';
  /** @deprecated */ moderationStatus: 'pending' | 'approved' | 'rejected';
  /** @deprecated */ mediaId: string | null;
};
type GuestGuestbookItem = GuestbookVisibleItem &
  { isOwn: boolean } & GuestbookCompatibilityAliases;
type ManagerGuestbookItem = GuestbookItem;

type LegacyGuestbookItem = {
  id: string;
  kind: 'message' | 'caption';
  guestName: string | null;
  body: string;
  createdAt: string;
  moderationStatus: 'pending' | 'approved' | 'rejected';
  mediaId: string | null;
};
```

`id` is the canonical note ID or media ID. Consumers use `(source, id)` as the
stable item key. The guest serializer must add required `isOwn`; the manager
serializer must omit that property and never include a guest-session ID.
`previewAvailable` is descriptive only. The existing authenticated preview
route still decides whether image bytes may be served.

`shared/constants.ts` also exports the fixed source ordering:

```ts
export const GUESTBOOK_SOURCE_RANK = {
  guest_note: 0,
  photo_caption: 1,
} as const;
```

Every UNION arm selects the matching small integer as `source_rank`. Newest-
first guest and Manager reads use
`(created_at DESC, source_rank ASC, id DESC)`; oldest-first export rendering
uses its exact inverse, `(created_at ASC, source_rank DESC, id ASC)`. Cursor
payloads use `{ createdAt, sourceRank, id }`. A stored export row names that
same canonical value `source_id`; it maps directly to `GuestbookItem.id`.
`source_rank` has a database `CHECK (source_rank IN (0, 1))`.

### 5.4 State and visibility mapping

| Source state | Guest visibility | Manager view | Printable HTML | Private CSV |
| --- | --- | --- | --- | --- |
| Note `pending` | Author's current session only | Needs review | Excluded | Included |
| Note `approved` | All current event guests | Shared | Included | Included |
| Note `rejected` | Author's current session only | Hidden | Excluded | Included |
| Note soft-deleted | None (Manager wire visibility: `host_only`) | Deleted | Excluded | Excluded |
| Caption `unpublished` | Uploader's current session only | Needs review | Excluded | Included |
| Caption `published`, gallery on | All current event guests | Shared | Included | Included |
| Caption `published`, gallery off | Uploader's current session only | Hidden | Excluded | Included |
| Caption `hidden` | Uploader's current session only | Hidden | Excluded | Included |
| Caption on deleted/failed/reserved media | None | Excluded | Excluded | Excluded |

All mappings are evaluated from server-owned source state. Browser state,
remembered names, and route identifiers never grant visibility.
Caption items exist only when a trimmed, non-empty caption belongs to stored,
non-deleted media; null, empty, or whitespace-only captions produce no
guestbook item, count, or export row.

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

There is no separate guestbook toggle. The Worker refuses new note creation
outside `photos-primary` with `409 EVENT_PHASE_CONFLICT` and calm copy. Reading
an already-contributed book, including the current session's private entries,
remains available to any valid guest session in every phase; pausing photo
intake never withdraws entries the guest could already read. Outside
`photos-primary`, the Event page exposes the existing book read-only and does
not render an enabled composer.

`guestbookPrompt` is added to manager and allowlisted guest event contracts. It
must not be overloaded into `welcomeMessage`; the two fields have different
placement, length, and purpose.

## 7. Guest experience

### 7.1 Placement and disclosure

The event page renames **Guest notes** to **Guestbook**. During
`photos-primary`, it is the first secondary disclosure beneath the primary photo
delivery experience. The disclosure may be opened without first contributing a
photo.

In every other server-resolved phase, the same lazy Guestbook disclosure stays
beneath that phase's primary surface in read-only form. It retains the prompt,
privacy explanation, private entries, shared entries, and independent
pagination, but omits the composer and receipt action. A phase transition or
photo-intake pause changes contribution availability without unmounting an open
book or clearing its confirmed rows.

After successful photo delivery, the terminal receipt stays intact and adds a
quiet **Leave a guestbook note** action. When `terminal` is true, the ordinary
`guest-secondary` block is replaced by a guestbook-only region that stays
mounted; the gallery, previous deliveries, and RSVP remain hidden. Activating
the receipt action opens that Guestbook region, scrolls it into view without
animation when reduced motion is requested, and focuses the composer heading
rather than unexpectedly placing the cursor in a text field. The receipt's
existing success content is otherwise unchanged.

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
- **Change** updates the remembered name and uses the changed value for the
  note.
- **Add your name** creates or updates that same remembered value.
- A later note may be signed or unsigned independently.

`EventPage` owns the one reactive remembered-signature value and passes it with
change callbacks to `GuestUploadFlow`, `GuestRsvpFlow`, and the guestbook
composer. A change in any of those surfaces is immediately reflected in the
others. Persistence remains device-global and unscoped by event, matching
today's uploader behavior, including a value saved by RSVP lookup. **Leave
unsigned** changes only the current note's signature choice; it does not clear
the shared remembered value. Before any note or photo is sent, the active value
is surfaced as **Signed as ...** with **Change** and **Leave unsigned**; it is
never applied silently.

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
- every non-empty caption on stored, non-deleted media that is published while
  the gallery is enabled; and
- every non-deleted note or non-empty caption on stored, non-deleted media owned
  by the current guest session, regardless of whether it is shared.

Unshared owned entries live in **Your private entries**. When a host shares one,
the next read moves it into **Shared guestbook** and retains a **Your entry**
marker. Other guests never receive the unshared row.

The shared book is newest-first. Its first bounded page loads when the
disclosure opens; **Show earlier shared entries** appends the next older shared
page without replacing or reordering rows already on screen. `nextCursor`
paginates this shared section only.

The first page also returns the current session's owned, non-deleted unshared
entries out of band, regardless of their age or whether 50 or more newer shared
entries exist. That private stream has its own bound and
`ownUnsharedNextCursor`; **Show earlier private entries** appears only when that
cursor is non-null. The two cursors never advance each other.

There is no guest background polling. Reopening, submitting, or explicitly
retrying refreshes both streams by replacing accumulated rows with fresh first
pages and resetting both cursors. The returned submission item is deduplicated
by `(source, id)`; refresh never moves focus or scroll.

A caption preview is requested only when the corresponding item is authorized.
Turning the gallery off removes published captions from the shared book as well
as the visual gallery; the text feed and thumbnail rules cannot diverge.

## 8. Host experience

### 8.1 Navigation and loading

Manager navigation renames **Notes** to **Guestbook**, and the destination
heading becomes **Guestbook from the day**. Its badge shows only the
unresolved `needsReviewCount`: pending notes plus a non-empty unpublished
caption on stored, non-deleted media. Approved, hidden, published, deleted,
captionless, and gallery-suppressed entries do not inflate the badge.

Initial Manager loading fetches the small guestbook summary only. No guestbook
rows load until the host opens that destination. On first entry:

- open **Needs review** when `needsReviewCount > 0`; otherwise
- open **Shared**.

The four views are visibility-oriented buckets:

- **Needs review:** pending notes and non-empty unpublished captions on stored,
  non-deleted media;
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
| Deleted note | **Restore** | **Permanently delete** | Restore to `rejected`, or hard-delete the note |
| Unpublished caption | **Publish photo & caption** | **Hide photo & caption** | Media -> `published` or `hidden` |
| Published caption | - | **Hide photo & caption** | Media -> `hidden` |
| Hidden caption | **Publish photo & caption** | - | Media -> `published` |

Guestbook never deletes media. Photo deletion remains in the existing photo
intake/gallery workflow. Caption actions call the existing media publication
mutation so the photo and caption cannot acquire contradictory publication
states.

**Permanently delete** is a single-row, state-guarded action available only in
Deleted. It is labelled irreversible, requires confirmation that names the
capacity consequence, and hard-deletes the soft-deleted note so it releases one
retained-note slot. It has no bulk form. A purged note can no longer satisfy an
idempotent success replay: the minimal purge receipt makes the same key and
payload return `410 MESSAGE_PURGED`, while changed content under that key
remains `409 MESSAGE_SUBMISSION_CONFLICT`. Neither path recreates or charges a
new note.

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
GET  /api/event/:slug/messages?contract=2&cursor=<shared-opaque>&ownCursor=<private-opaque>
```

`POST` accepts:

```ts
interface CreateGuestbookNoteRequest {
  body: string;
  guestName: string | null;
  idempotencyKey: string;
}
```

It returns `{ item: GuestGuestbookItem, message: LegacyGuestbookItem,
replayed: boolean }` during the compatibility window; `message` is removed only
under the gate below. The response item is always owned by the current session.
A new row is `pending` or `approved` from the event's current
`moderationRequired` value. The route rejects creation outside
`photos-primary` with `409 EVENT_PHASE_CONFLICT`; the read route has no phase
refusal.

`GET` returns:

```ts
interface GuestbookPage {
  items: GuestGuestbookItem[];
  nextCursor: string | null;
  ownUnshared: GuestGuestbookItem[];
  ownUnsharedCount: number;
  ownUnsharedNextCursor: string | null;
}
```

`items` is the bounded 50-item shared stream. `ownUnshared` is a separately
bounded page of the current session's non-deleted author-only rows; it is never
reduced by shared-feed volume. A request without either cursor returns the first
page of both streams. Subsequent requests supply exactly one cursor and advance
only that stream; the other array is empty and its returned cursor is null, so
the client does not replace the other stream's retained state. Supplying both
cursors, a cursor for the wrong stream/session/event, or a malformed cursor
returns 422. Every returned item includes `isOwn`.

This is a breaking payload replacement on retained URLs, so the Worker and
client ship in the same release. During the compatibility window, every GET
item carries the typed deprecated aliases from Section 5.3, and POST also
returns `message: LegacyGuestbookItem` as a complete safe legacy projection of
the created note. `kind` maps
`guest_note -> message` and `photo_caption -> caption`. The legacy
`moderationStatus` alias is derived from effective guest visibility: `approved`
only for a shared row, `pending` for a pending note or unpublished caption, and
`rejected` for every other author-only row. A published caption suppressed by
gallery-off therefore cannot tell an old page it is shared.

For the same release, cursor decoding accepts the current legacy
`{ createdAt, id }` payload and marks that pagination chain version 1. Every
continuation in that chain keeps the legacy ordering and emits another version-1
cursor; a chain never switches ordering mid-pagination. New first-page requests
emit version-2 `{ createdAt, sourceRank, id }` cursors. The current client already
sends `idempotencyKey`, so making it required does not break a shipped caller. A
new client that receives an item without a recognized `state` renders the feed
error with Retry rather than guessing a privacy label.

The new split-stream response is selected by `contract=2`. A request without
that discriminator receives the legacy unified `items` projection, including
the current session's private rows when they fall in that legacy page, plus
version-1 cursors and aliases. The new client always requests `contract=2`.
Compatibility remains until telemetry and the ordinary maximum guest-session
lifetime prove that no supported client can still issue the legacy contract;
removal is a separately reviewed change, not an automatic next release.

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

The request includes one action (`approve`, `reject`, `delete`, `restore`, or
`purge`) and the exact `expectedState`. `purge` is accepted only from `deleted`.
For the compatibility window, the route also accepts deprecated
`expectedStatus` for non-deleted states; if both fields are present and
contradict each other it returns 422. The route confirms the note belongs to the
path event and performs one state-guarded update.

Approve, reject, delete, and restore return
`{ item: ManagerGuestbookItem }`. Purge returns
`{ purged: { source: 'guest_note', id: string } }` after the row contents are
removed and its non-content idempotency tombstone is committed. No response
contains a raw `MessageRecord`. A stale or cross-state action returns
`409 MESSAGE_STATE_CONFLICT`, and the client reloads that row or active page.

Caption rows continue to use:

```text
PATCH /api/manage/events/:eventId/media/:mediaId
```

with `publish` or `hide` and the current `expectedStatus`. Success returns an
allowlisted `{ media: ManagerMediaView, item: ManagerGuestbookItem | null }`.
`item` is null only when the resulting media no longer qualifies for the
guestbook projection. No response contains a raw `MediaRecord`. Caption
conflicts retain `MEDIA_STATE_CONFLICT`. Guestbook does not add a second caption
mutation endpoint.

`shared/contracts.ts` defines `ManagerMediaView` with only the existing Intake
fields: `id`, `originalFilename`, `guestName`, `caption`, `publicationStatus`,
`uploadState`, `previewAvailable`, `width`, `height`, and `createdAt`.
`previewAvailable` replaces `previewObjectKey`; neither it nor any nested alias
contains an object key, session ID, or idempotency key. The already-shipped
Manager note and media list routes are narrowed in the same release to explicit
safe serializers while preserving the fields their current clients use.

After a successful non-purge mutation, the client merges the returned safe item
into its active row and immediately refetches only the small summary. Purge
removes the row locally and does the same summary refetch. This is the
response/data flow meant by the local badge and count update in Section 8.4;
neither route requires a whole-page refresh.

Add `MESSAGE_STATE_CONFLICT`, `MESSAGE_EVENT_LIMIT`, `MESSAGE_PURGED`, and
`EVENT_PHASE_CONFLICT` to `ApiErrorCode` in `shared/errors.ts`, classify all four
in the exhaustive `shared/load-failure.ts` map, and document them under
`## Support signals` in `docs/operations.md`. Note moderation/deletion conflicts
change from the shipped `MEDIA_STATE_CONFLICT` to `MESSAGE_STATE_CONFLICT` in
the same release as the client; caption conflicts remain unchanged.

## 10. D1 schema and repository behavior

`migrations/0015_curated_private_guestbook.sql` adds the following bounded
extensions after the current 14-migration Cover Studio cutover contract is
closed or explicitly revised and reauthorized.

`shared/constants.ts` owns the new numeric limits and exports:

```ts
export const MAX_EVENT_GUEST_NOTES = 1_000;
export const MAX_GUEST_NOTES_PER_SESSION_WINDOW = 5;
export const MAX_GUEST_NOTES_PER_IP_WINDOW = 120;
export const GUEST_NOTE_WINDOW_MS = 900_000;
export const MAX_GUESTBOOK_PROMPT_LENGTH = 160;
export const MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE = 25;
export const MANAGER_GUESTBOOK_MAX_PAGE_SIZE = 50;
```

Guest shared and private pages reuse the existing
`GUEST_MESSAGE_PAGE_SIZE = 50`. Runtime Worker and React code import these
values. Migration SQL cannot import TypeScript, so its literal checks mirror
the constants and focused tests assert parity.

### 10.1 Event prompt

`events.guestbook_prompt` is `TEXT NOT NULL` with the approved literal default
and a database check of 1 through `MAX_GUESTBOOK_PROMPT_LENGTH` characters. The
event repository maps it into `EventView`, `GuestEventView`, event creation,
Settings reads/writes, and export metadata.

### 10.2 Note submission windows and purge tombstones

`guest_message_rate_events` is bounded scratch with one row per accepted note:

- event ID;
- HMAC-digested session scope;
- HMAC-digested trusted-client-IP scope;
- fixed `window_started_at`; and
- creation time.

The Worker derives both digests with domain-separated inputs under a new,
independent `GUEST_MESSAGE_HMAC_KEY`; no raw IP, name, note body, credential, or
idempotency key is stored. Compound
indexes on `(event_id, session_scope_digest, window_started_at)` and
`(event_id, ip_scope_digest, window_started_at)` make both guarded counts
bounded. Daily cleanup removes rows older than one full window; note purge does
not remove a still-live rate event.

`guest_message_purge_receipts` preserves only event ID, guest-session ID,
idempotency key, a canonical request HMAC, and purge time until event purge.
It contains no body or display name. Its composite primary key prevents a late
or ambiguous replay from recreating permanently removed content: the same
key/digest returns `410 MESSAGE_PURGED`, while the same key with a different
digest remains `409 MESSAGE_SUBMISSION_CONFLICT`.

The request HMAC uses the domain prefix `guest-message-payload:v1` and a stable
JSON tuple of the already-normalized `[guestName, body]`. The new key is a
persisted-data key because receipts survive until event purge; rotation requires
a coordinated re-HMAC migration or invalidation decision, never an ordinary
credential-rotation procedure.

A supporting `guest_messages(event_id, guest_session_id, created_at)` index
makes ownership and defensive audits bounded. Manager/feed indexes cover event,
source state, deletion state, descending creation time, source rank, and ID;
media reuses its existing stored/publication pagination indexes.

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
For every job created by this feature, `guestbook_entry_count` and the snapshot
metadata are non-null even when the count is zero; that is the format marker
which distinguishes a new-format job from a legacy row. The existing
`manifest_object_key` column is already nullable and remains so.

### 10.4 Immutable export entries

`export_guestbook_entries` belongs to one export job with `ON DELETE CASCADE`.
Each row stores only what artifact generation needs:

- source and source ID;
- source rank, constrained to `0` or `1` from
  `GUESTBOOK_SOURCE_RANK`;
- nullable guest name;
- body;
- creation time;
- exact source state;
- derived `guest_visibility` (`shared` or `author_only`);
- `included_in_keepsake`;
- nullable media ID and original filename; and
- a deterministic `(created_at, source_rank, source_id)` sort key, where
  `source_id` is the wire item's `id`.

The table contains no session ID, credential, RSVP data, object key, or original
photo bytes. An index on
`(export_job_id, created_at ASC, source_rank DESC, source_id ASC)` supports the
specified bounded oldest-first rendering order.

### 10.5 Immutable guestbook snapshot transaction

Export creation uses one atomic D1 batch:

1. `INSERT ... SELECT` the queued job, snapshot metadata, source counts, and
   total photo bytes only when the same D1 snapshot has at least one exportable
   photo or non-deleted guestbook entry and photo bytes do not exceed
   `MAX_EVENT_BYTES`;
2. insert every eligible note/caption through one parameter-bounded
   `INSERT ... SELECT` guarded by the first statement's `changes()` result; and
3. inspect the first statement and re-read only the discriminating predicates:
   an active or concurrently won job returns `EXPORT_ALREADY_ACTIVE`, an
   oversize snapshot returns `409 EXPORT_LIMIT_EXCEEDED`, and a snapshot with no
   stored photo and no non-deleted guestbook row returns `EXPORT_EMPTY`.

The projection includes every eligible non-deleted standalone note and every
non-empty caption on stored, non-deleted media. It derives shared visibility
using the event's gallery value captured in the same transaction. The new-note
cap prevents post-migration events from growing beyond 1,000 retained notes,
but snapshot and export code must not truncate legacy events that already
contain more; the private archive remains complete.

Once inserted, guestbook snapshot rows are immutable. Retrying an expired or
failed job uses the same guestbook rows and metadata. A host who changes note
moderation, caption publication, gallery visibility, prompt, or deletion state
after `snapshotAt` must create a new export to capture those changes in the HTML
or private CSV; the Manager labels every artifact with its snapshot time.

This migration does not persist a photo plan. Photo membership and manifest
metadata retain the existing behavior: every attempt re-runs
`MediaRepository.exportSnapshot(eventId, snapshotAt)`. A count mismatch remains
`EXPORT_SNAPSHOT_CHANGED` and fails that attempt; a count-equal membership
change is handled by the frozen-caption mapping rule in Section 12.3. The spec
does not describe the photo half as immutable.

## 11. Submission protection and capacity

New standalone notes use three layered protections. The edge limiter sheds
bursts. The D1 fixed window independently bounds the current session and a
trusted-client-IP digest, so re-entry can reset the session budget but cannot
reset the IP budget. The retained-note ceiling bounds lifetime event storage
and has an explicit host recovery path.

### 11.1 Edge shedding

A dedicated `GUEST_MESSAGE_RATE_LIMIT` binding allows 120 submission requests
per minute per event and trusted client IP. It runs after guest-session/event
authorization but before parsing the request body. It does not reuse the host
authentication or RSVP lookup limiter.

An edge rejection returns `429 RATE_LIMITED` and `Retry-After`. It is a coarse
abuse shield, not the durable note quota.

Declare the binding in `wrangler.jsonc` with production `namespace_id` `1003`
and `simple: { limit: 120, period: 60 }`. Add the independent persisted-data
secret `GUEST_MESSAGE_HMAC_KEY` to `wrangler.jsonc` `secrets.required` and
`.dev.vars.example`, then run `npm run cf-typegen` so
`worker-configuration.d.ts` and `Cloudflare.Env` include both. After the Cover
Studio cutover closes, advance the active production/staging topology contract
and its current fixtures to a versioned three-rate-limit/new-secret baseline,
with a separately authorized nonproduction namespace ID. Do not rewrite
historical Phase-2/Phase-3 ledgers or immutable evidence fixtures to pretend
either binding existed in those candidates. Update the rate-binding, required-
secret, persisted-key, and staging-topology sections of `docs/deployment.md` and
the rate-limit/key inventory in `docs/security.md`.

That post-cutover topology work explicitly covers the exact-match expectations
in `scripts/migrate-release.ts`, `scripts/staging-release-candidate.ts`, and
`scripts/staging-release.ts`, plus their active cases in
`tests/unit/migrate-release.test.ts`, `release-candidate.test.ts`,
`staging-release-candidate.test.ts`, and `staging-release.test.ts`. Historical
two-limiter/old-secret-set scenarios remain named historical cases rather than
being mutated in place.

### 11.2 Durable session and IP windows

A guest session may create at most
`MAX_GUEST_NOTES_PER_SESSION_WINDOW` new notes, and one event/trusted-client-IP
scope may create at most `MAX_GUEST_NOTES_PER_IP_WINDOW`, in the same
server-defined `GUEST_NOTE_WINDOW_MS` fixed window. Exact idempotent replays do
not increment either count. The session dimension shapes one valid session; the
IP dimension is the re-entry-resistant abuse boundary and is deliberately high
enough not to make an ordinary venue NAT behave like one guest.

Creation uses one guarded D1 batch following the repository's existing
`changes()` pattern:

1. insert the note with `INSERT ... SELECT ... ON CONFLICT DO NOTHING` only when
   no purge tombstone exists for `(event, session, idempotencyKey)`, the event's
   SQL phase predicate still resolves to `photos-primary`, both fixed-window
   counts have capacity, and the event is below its retained-note cap;
2. insert one scratch rate event with both scope digests only when the note
   insert changed one row; a statement error rolls back the D1 batch; and
3. inspect the stored note, purge receipt, event phase, and current counters to
   distinguish exact replay, changed-payload conflict, purged replay, phase
   conflict, session/IP limit, and event limit.

That discrimination order is normative: an existing same-payload note returns
its successful replay even if the event phase later closed; an existing changed
payload returns `MESSAGE_SUBMISSION_CONFLICT`; and a matching purge receipt
returns `MESSAGE_PURGED` before phase or quota failures are considered. Only a
genuinely new key is evaluated as a new creation.

The phase predicate is inside the same authoritative write batch as capacity,
not merely checked before it. It mirrors `resolveGuestEventPhase()` using one
bound server timestamp, so a host pause that wins before this transaction
prevents the insert. Focused parity tests pin the SQL and service phase result.

The unique `(event_id, guest_session_id, idempotency_key)` index remains the
final duplicate guard. A same-key/same-payload replay returns the original row.
The same key with a changed body or signature returns
`409 MESSAGE_SUBMISSION_CONFLICT`.

Either durable-window failure returns `429 RATE_LIMITED` with `Retry-After`
based on the server window. Logs may record bounded `session` or `ip` scope but
never either digest. The guest draft remains intact.

### 11.3 Event retained-note cap

An event may retain at most `MAX_EVENT_GUEST_NOTES` standalone notes. The count
includes soft-deleted notes so ordinary Delete cannot reopen abuse capacity.
Captions remain bounded by the existing stored-photo cap and are not counted as
standalone notes.

The guard is part of the same SQL reservation as creation, not a read-then-write
check. A full event returns `409 MESSAGE_EVENT_LIMIT` with calm copy that says
the guestbook is not accepting more notes.

From Deleted, an authorized host may use **Permanently delete** to reclaim one
slot. One state-guarded D1 batch first inserts the minimal purge receipt when
the legacy row has an idempotency key, then hard-deletes the soft-deleted source
row. If either statement fails, neither change commits. The action is bounded,
irreversible, requires explicit confirmation, and has no bulk form. Existing
immutable guestbook export rows are unaffected. Event purge removes the receipts;
ordinary soft deletion and expiry cleanup do not.

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
remote images, cookies, or network requests. Every interpolated value -- event
name, prompt, timestamps, guest names, bodies, media IDs, and archive part and
path -- passes through the same context-appropriate HTML escaper. Escaping is a
property of the generator, not of a subset of inputs. Entries render as text in
semantic `article` elements with `dir="auto"`. Inline CSS provides readable
screen and print layouts. MVP does not embed previews or original image bytes.
R2 metadata sets `Content-Type: text/html; charset=utf-8` and
`Content-Disposition: attachment; filename="guestbook.html"`.

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
partitioner. A frozen caption always retains its snapshotted `media_id`. If that
ID is absent from an attempt's recomputed photo plan, only
`photo_archive_part` and `photo_archive_path` are empty. Standalone notes leave
all three photo columns empty. Every field passes through the shared `csvCell()`
formula-injection defence and CSV escaping.
The file contains no guest-session IDs, IP addresses, idempotency keys,
credentials, RSVP records, deleted notes, or deleted/failed/reserved media.

### 12.4 Workflow and retry behavior

The existing `ExportWorkflow` remains the only export orchestrator. It adds
deterministic steps that:

1. read the immutable guestbook rows in bounded pages, rerun the existing live
   media snapshot query, and compute the deterministic photo partition/path
   plan for this attempt;
2. generate the existing photo manifest/parts when photos exist;
3. generate the HTML and private CSV under the current attempt prefix using the
   already-fixed photo archive mapping;
4. retain only object references, counts, and digests in Workflow step results;
   and
5. atomically mark the job Ready with the complete object inventory.

The job becomes Ready only when every applicable artifact group is complete. A
new-format job must have both guestbook object keys, byte counts, and digests.
Its photo group is either complete -- a non-null manifest plus the exact
recorded ZIP parts when `media_count > 0` -- or absent only when
`media_count = 0` -- a null manifest and zero parts. A failure
deletes all objects created under that attempt, records a bounded `EXPORT_*`
error, and exposes the existing Retry action.

`markReady` accepts `manifestObjectKey: string | null` and zero photo parts when
the job is new-format. `ExportDownloadView.manifest` becomes nullable, its
`parts` array may be empty, and the Manager panel conditionally renders the
photo group while always rendering both guestbook downloads for a new-format
Ready job. The download readiness predicate requires `state = 'ready'`, an
unexpired job, and complete inventory groups; it rejects partial guestbook or
photo groups instead of treating any one signable object as sufficient.

Notes-only, photos-only, mixed, and private-only guestbook events are valid.
`EXPORT_EMPTY` applies only when there are no stored, non-deleted photos and no
non-deleted guestbook rows at snapshot time.

Every new-format job writes both guestbook files, including an empty curated
HTML/CSV pair for a photos-only snapshot. Pre-migration jobs remain photo-only
and downloadable. A missing nullable guestbook artifact never invalidates a
legacy manifest.

Retry first rejects any job that is neither Failed nor Expired without deleting
anything. It then deletes the prior manifest, every recorded ZIP part,
`guestbook.html`, and `guestbook-private.csv` from their stored inventory keys.
Only after that succeeds does one guarded update increment `attempt`, reset
`object_key`, `manifest_object_key`, and `part_count`, and null all six
guestbook object-key/byte/digest fields. Snapshot rows, counts, prompt, event
metadata, gallery state, and `snapshotAt` remain unchanged.

Retry renders the guestbook artifacts from those same immutable rows but reruns
`MediaRepository.exportSnapshot()`. A post-snapshot photo deletion that changes
the recorded count remains `EXPORT_SNAPSHOT_CHANGED` on every retry. If live
membership changes while the count happens to remain equal, the attempt uses
the recomputed plan and the missing-caption mapping rule in Section 12.3. The
manifest's photo caption and publication metadata therefore retain the existing
live re-query semantics and are not claimed to be immutable.

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
- `EVENT_PHASE_CONFLICT` disables the composer for the current phase but keeps
  the already-contributed book readable. A photo-intake pause never clears
  entries or drafts.
- `MESSAGE_PURGED` explains that an earlier send was permanently removed and
  cannot be restored; it never recreates the note from a stale retry.
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
- A failed permanent-delete batch leaves the Deleted row and its capacity count
  intact; the UI offers a row-local Retry and never claims the content is gone.
- Polling failures do not dismiss the panel, clear pagination, or repeat alerts
  every 15 seconds.

### 13.3 Export failures

- Snapshot creation is atomic; a failed snapshot leaves no queued job or
  partial snapshot rows.
- Artifact generation is all-or-nothing at the Ready boundary.
- Retry never rereads current guestbook moderation/publication state. Photo
  membership and media-manifest metadata retain the existing live re-query
  behavior described in Section 12.4.
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
- Manager and export responses, including deprecated or nested compatibility
  aliases, may include display names and contributed text but never session
  IDs, idempotency keys, credential/rate-scope digests, IP addresses, object
  keys, or signed upload URLs.
- Rate-event rows are bounded scratch. Purge receipts retain only the minimum
  non-content idempotency tuple until event purge and are never exposed through
  an HTTP response.
- Application logs record request ID, event ID, operation/result code, source
  type, and bounded counts. They do not record note/caption bodies, guest names,
  raw IP addresses, signed URLs, or artifact contents.
- Metrics distinguish bounded guest-feed contract version (`1` or `2`), note
  creations/replays/rate limits, moderation conflicts, guestbook snapshot
  counts, artifact generation failures, and cleanup outcomes without
  high-cardinality contributed text.

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
- Database prompt, source-state, source-rank, rate-event, purge-receipt, and
  export-row constraints, including TypeScript-constant/SQL-literal parity and
  versioned request-HMAC canonicalization.
- Bump `EXPECTED_MIGRATION_COUNT` to 15 in
  `scripts/verify-fresh-d1.ts`, append `guestbook_prompt` to
  `EXPECTED_COLUMN_NAMES.events`, and add its exact `TEXT`, `NOT NULL`, default,
  and primary-key metadata to `EXPECTED_TERMINAL_COLUMNS.events`; focused
  migration tests separately pin the prompt `CHECK`.
- Update the direct `verify-fresh-d1` fixtures' ordered column and 15-migration
  post-cutover cases while retaining historical 14-migration Cover Studio
  evidence as historical truth. This includes
  `tests/unit/verify-fresh-d1.test.ts` and a new post-cutover case in
  `tests/unit/deploy-release.test.ts`; staging evidence tests gain separate
  post-cutover 15-migration cases rather than appending `0015` to
  the immutable Phase-3 ledger in
  `tests/unit/staging-release-evidence.test.ts`.
- Guest/manager keyset ordering across equal timestamps and both sources.
- Cursor binding to event, session where applicable, stream, view, source
  filter, and version; a version-1 chain never switches ordering.
- Summary/view mapping with gallery on and off.
- Export snapshot transaction rollback and immutable retry rows.
- Legacy export rows with null guestbook fields.

### 16.2 Worker/API tests

- Two guest sessions prove approved sharing and strict pending/rejected/hidden
  isolation.
- `isOwn` is correct, and list/mutation/compatibility responses contain no
  session IDs, idempotency keys, object keys, preview object keys, or upload
  URLs.
- Gallery-off removes published captions from other guests while retaining the
  uploader's author-only read-back.
- The private stream survives 50 or more newer shared rows, paginates through
  more than one private page, moves a newly shared row into the shared stream,
  and never crosses sessions.
- Moderation-off notes start approved; toggling the setting is not retroactive.
- Same-key/same-payload replay, changed-payload conflict, concurrent replay,
  session/IP fixed-window boundaries, re-entry retaining the IP budget, edge
  limiter, phase-race refusal, and the 1,000-note cap.
- Creation is refused outside `photos-primary` while reads continue in every
  phase and through a photo-intake pause.
- Soft deletion, Undo/restore-to-rejected, cross-event mutation refusal, and
  stale expected-state conflicts; permanent deletion commits its tombstone and
  capacity release atomically, and later same-key replay returns
  `MESSAGE_PURGED` without recreating content.
- Manager summary, four views, source filters, page-size bounds, and cursors.
- Caption actions call media publication and never delete media.
- Legacy clients retain correct shared/private labels, gallery-off privacy,
  caption thumbnails, POST success, and legacy cursor continuation; unknown new
  states fail closed to a retryable feed error.
- Exact `MESSAGE_STATE_CONFLICT`, `MESSAGE_EVENT_LIMIT`, `MESSAGE_PURGED`, and
  `EVENT_PHASE_CONFLICT` codes and load-failure classifications.

### 16.3 Export and cleanup tests

- Approved/published curated HTML and complete non-deleted private CSV.
- Gallery-on/off visibility captured at snapshot time.
- Note/caption state changes and deletions after snapshot do not change frozen
  guestbook rows. When the existing live-photo snapshot check still permits
  regeneration, retry produces the same guestbook artifacts from those rows;
  when photo drift fails the attempt, the rows remain frozen but no new Ready
  artifact is claimed.
- Photo count drift retains `EXPORT_SNAPSHOT_CHANGED`; count-equal membership
  drift recomputes the photo plan and leaves only the absent caption's archive
  part/path empty while retaining its snapshotted media ID.
- HTML escaping, `dir="auto"`, no scripts/remote requests, oldest-first order,
  event-zoned dates, hostile event name/prompt, attachment metadata, and
  empty-shared-book copy.
- CSV quoting, line breaks, Unicode, formula hardening, exact columns, and
  source-state/visibility values.
- Caption-to-photo archive part/path mapping.
- Notes-only, photos-only, mixed, private-only, oversized, and truly empty
  events; notes-only Ready/download accepts a null manifest and no parts.
- Complete-group Ready validation rejects partial photo or guestbook inventory.
- Failed-attempt object cleanup, retry state refusal before deletion, complete
  prior-inventory deletion, all six guestbook-column resets, repeated failure,
  attempt prefixes, signed-download authorization, expiry, legacy jobs, and
  event purge.
- Common browser opening/printing of HTML and common spreadsheet opening of CSV
  without changing the stored bytes or privacy labels.

### 16.4 Client/unit tests

- Terminal state retains the complete photo-delivery receipt and only the
  Guestbook disclosure; RSVP, gallery, and previous deliveries remain hidden.
  The receipt action opens Guestbook, follows reduced-motion behavior, focuses
  its heading, and remains usable when feed loading fails.
- Signed, changed-name, and unsigned submission behavior, including two-way
  uploader/composer synchronization and propagation of a name saved by RSVP.
- Draft/idempotency preservation and reset after successful or edited sends.
- Composer isolation from feed failure.
- Private-to-shared movement with **Your entry** retained.
- Independent shared/private pagination and first-page private presence derived
  from `ownUnsharedCount`, not from shared-page membership.
- Manager summary-only initial load and lazy first page.
- Pending-only badge, default view, source filters, Show earlier, summary
  polling, and explicit Refresh entries behavior.
- Row-local busy/success/error/conflict states, stable focus/scroll, Undo, and
  exact action matrix, including irreversible permanent-delete confirmation and
  failure recovery.
- Null, empty, and whitespace-only captions never create rows or inflate counts.

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

The Manager-label and terminal-receipt contract requires updating the
`DESTINATIONS` tuples in `manager-responsive.spec.ts`,
`rsvp-responsive.spec.ts`, and `visual-qa.spec.ts`; direct
`destination(page, 'Notes')` calls; the accessibility destination/heading
fixture; the core-journey terminal zero-button assertion; and affected guest
responsive and event-theming terminal cases. Re-capture only intentionally
changed baselines, including `manager-nav-768.png`,
`manager-nav-count-390.png`, `guest-coastal-receipt-390.png`,
`guest-default-notes-390.png`, and any platform-specific counterparts the
focused browser diff proves are affected.

Before implementation is called complete, run the repository's focused tests
plus typecheck, E2E typecheck, lint, full unit/Worker tests, build, browser suite,
binding verification, migration verification, and diff checks appropriate to
the final change. Binding verification includes regenerated `cf-typegen`
output, a fake `GUEST_MESSAGE_RATE_LIMIT` Worker binding, and the versioned
`GUEST_MESSAGE_HMAC_KEY` binding plus post-Phase3 three-limiter/new-secret
production/staging topology contract; migration
verification includes the post-cutover 15-migration baseline without rewriting
historical evidence. Immutable release-candidate verification, remote migration,
deployment, runtime certification, and physical-device acceptance remain
separate evidence gates and require separate authority.

## 17. Implementation boundaries

Once this revision is approved, the implementation plan should decompose it
into independently verifiable slices while preserving one product contract:

1. contracts, migration, prompt persistence, and projection repositories;
2. privacy-correct guest reads, bounded/idempotent creation, and guest UI;
3. manager summary/pagination, state actions, and lazy host UI; and
4. immutable guestbook snapshot, HTML/CSV rendering, existing-live-photo
   Workflow/download integration, cleanup, copy, and end-to-end verification.

The first slice cannot land `0015` or the third rate-limit binding while the
active Cover Studio contract still pins 14 migrations and two rate-limit
namespaces. Close that cutover first, or explicitly revise and reauthorize the
whole candidate/staging/production topology. Preserve historical Phase-2 and
Phase-3 ledgers and add a post-cutover baseline; do not relabel Guestbook as
part of the prior candidate.

The visual slice includes explicit amendments to binding design records:

- in `design/design-system.md`, replace the Manager destination label **Notes**
  with **Guestbook**, approve the exact heading **Guestbook from the day**, and
  allow exactly one terminal-receipt affordance, **Leave a guestbook note**;
- in `design/fidelity-ledger.md`, amend **Terminal receipt**, **Secondary
  features**, **Photo journey unchanged**, and **Six manager destinations** so
  the receipt keeps exactly that one follow-on action, only Guestbook remains
  mounted below it, and RSVP/gallery/previous deliveries still disappear; and
- update the test literals and intentional visual baselines named in Section
  16.5 in the same slice.

Operational copy work includes the `ApiErrorCode`/support-signal additions,
`docs/deployment.md` binding and post-cutover topology baseline, and
`docs/security.md` rate-limit/key inventory. It also treats
`GUEST_MESSAGE_HMAC_KEY` as an independent persisted-data secret in
`.dev.vars.example`, binding verification, and the release secret-name
allow-lists. The implemented architecture/secret inventory in `CLAUDE.md` is
updated in the same bounded documentation pass without overwriting unrelated
worktree edits. These are product-contract changes, not evidence that any
deployment or policy approval occurred.

Each slice must begin with failing focused tests, keep unrelated worktree changes
untouched, and avoid broad staging. No slice may claim deployment, remote D1
migration, production data migration, or physical-device proof merely because
local implementation gates pass.

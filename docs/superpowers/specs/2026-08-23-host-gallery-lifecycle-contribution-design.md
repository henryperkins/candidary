# Host Gallery Lifecycle and Contribution Design

**Program:** [Host Gallery Roadmap](2026-08-23-host-gallery-roadmap-program-design.md)

**Slice:** 5 of 6

**Findings:** C-08, C-09, C-10, C-12, C-16, C-17, C-49, C-50, C-52, C-53, C-55, C-56, C-57, C-58, C-59, C-61

## Goal

Make first run, host contribution, account confirmation, access rotation, pause/resume, and event retirement form one predictable lifecycle without creating duplicate upload, settings, or recovery systems.

## Existing systems retained

- `GuestUploadFlow`, its transport interface, queue, validation, and canonical Worker upload pipeline remain the upload implementation.
- `ManagerPhotoIntakePanel` and the existing photo-intake state machine remain the pause/resume control.
- Existing host registration, verification, event ownership, and management-link services remain authoritative.
- Existing typed event-name confirmation remains the broad destructive-action pattern.
- Host Events remains the account dashboard; it receives bounded controls rather than a new organizer product.

## Pause means guest-upload-only

Rename controls and status to **Pause guest uploads** / **Resume guest uploads**. The server's `uploadsEnabled` and photo-intake state gate only guest reserve/content/finalize operations and the guest upload composer. Manager-authorized host uploads remain available while guest delivery is paused; they still obey event lifecycle, storage, media-count, file-validation, and management-access limits.

Event guests retain authenticated read access to:

- the event shell and existing delivery receipt;
- My deliveries;
- Guestbook content allowed by its own moderation state;
- the Guest gallery when its independent availability setting is on;
- fullscreen Gallery through the same projection.

Primary phase and read-surface availability are separate server projections. `GuestEventView.phase` continues to choose the primary RSVP/before-start/photo/waiting surface, while `guestReadSurfaces: { available: boolean; reason: 'before-photo-open' | null }` decides whether Guestbook contribution, My deliveries, Guest gallery, and fullscreen Gallery may be opened. For scheduled events the read surfaces become available only when the scheduled photo-open boundary is reached, independently of pause; pause affects only the composer and cannot expose them early. Legacy events keep RSVP first, then retain the read surfaces in `waiting` or `photos-primary` while uploads are paused. The main guest page and the direct Guestbook, Guest gallery, My Deliveries (`GET /event/:slug/contributions`), and fullscreen routes consume this same projection. A direct pre-boundary request to any of those read routes returns the shared `EVENT_PHASE_CONFLICT` response and message. When fullscreen is unavailable it keeps its shell and Close control, makes no gallery request, and renders the same `before-photo-open` reason; **No shared photos yet** is reserved for available-and-empty. Fullscreen does not duplicate Guestbook or My deliveries.

Paused copy names only new uploads and never implies the event or other guest surfaces are offline. The lifecycle matrix covers scheduled pre-start, early-open, and post-start rows, each paused and unpaused, plus the legacy RSVP-first/waiting/photos rows.

## Host uploads through the existing pipeline

Add these manager-authenticated routes parallel to the guest paths:

- `POST /api/manage/events/:eventId/uploads/batch`
- `PUT /api/manage/events/:eventId/uploads/:mediaId/content`
- `POST /api/manage/events/:eventId/uploads/:mediaId/finalize`
- `DELETE /api/manage/events/:eventId/uploads/:mediaId`

Every phase calls `requireManager({ write: true })` before reading a body. Extract the browser's existing same-origin credential-header helper so the raw XHR content request sends both event and host CSRF pairs exactly as `api()` does; the accepted Manager credential chooses which pair the Worker verifies. Origin and CSRF checks complete before buffering bytes.

Migration `0021_manager_upload_and_album_era.sql` adds nullable `event_sessions.manager_upload_account_id REFERENCES host_accounts(id)`, `events.album_pick_generation INTEGER NOT NULL DEFAULT 0`, `events.manager_link_revision INTEGER NOT NULL DEFAULT 0`, and the Album provenance column. Before enforcing uniqueness it deterministically retains the newest live Manager token for each event by `(created_at DESC, id DESC)`, revokes every older live Manager token and its sessions, and then adds a partial unique index enforcing one live Manager token per event. It also adds a unique index on each live `(event_id, manager_upload_account_id)` and triggers requiring role `manager` plus `can_claim_owner = 0` whenever that actor column is non-null. Populated-0020 and migration-first fixtures prove both normalization and that a still-serving 0020 Worker cannot insert a second live Manager token after the schema upgrade.

A server-only account actor has random secret/CSRF digests whose source secrets are discarded, the event's current live Manager-token foreign key, and the event management expiry. `SessionRecord` carries the nullable actor field, and browser session resolution explicitly rejects an actor row before secret comparison. It is identity storage only and can never mint a cookie.

`ManagerUploadActorService` returns a role-aware upload actor:

- a management-link Manager uses that authenticated event-session ID;
- an account owner or cohost uses `ensureForReservation()` to reuse/create the one live server-only row for `(eventId, accountId)` with one atomic statement that proves the exact host-session ID and auth version, active account, current owner/cohost membership, event lifecycle, and unique current live Manager token; a separate prior `requireManager` result is not sufficient proof for actor creation;
- content/finalize/cancel use lookup-only actor resolution, so probing another upload never creates an actor;
- management-link rotation is one D1 batch that revokes the prior token and all bearer-derived sessions, inserts the replacement, rebinds live account actors to it, and terminally cancels every revoked link actor's reserved/failed rows with exact counter deltas; account uploads survive while link-owned reservations never transfer to a replacement link;
- event expiry/deletion, account disablement, membership removal, or actor revocation prevents every later phase. The membership-deletion transaction revokes that account's live actor; remove-then-readd therefore refuses the old actor and reservation, and a fresh membership receives a fresh identity.

`UploadService` accepts a server-created discriminant; the client cannot choose it:

```ts
// Defined in a neutral shared Worker module before actor and upload services consume it.
type UploadAuthority =
  | { kind: 'guest'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-link'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-account'; actorSessionId: string; hostSessionId: string; accountId: string };
```

Guest actors still require effective `photosOpen`. Manager actors deliberately ignore the guest schedule and guest pause, but still require a live event management window, Worker ingress, reservation/media/storage caps, type/size/signature/dimension validation, and all existing promotion fences. The service supplies the fixed public attribution separately from authority, so no account field can become display copy.

The authority policy is carried through reservation, idempotent refresh, post-buffer ingress claim, and final commit SQL—not reduced to a route-time Boolean. Each phase atomically rechecks the current guest/link session or host session, access token, account, membership, event lifecycle, media event, and exact `uploader_session_id`. Manager-account liveness additionally proves the actor session itself: same event/account, Manager role, non-revoked and non-expired, and associated with the event's current live Manager token. Revocation between route authorization, body buffering, R2 writing, and commit therefore fails closed under the existing tombstone cleanup. On a failed claim or commit, actor liveness is classified first: if liveness and the intake predicate fail together at the management boundary, the result is `forbidden`/authorization-terminal, never a retryable `conflict`. Only a still-live authority whose row or intake state moved is a conflict. Every guest and direct repository/service call site adopts the authority signature in the same change, including `worker/routes/uploads.ts` and direct tests.

Guest endpoints can never act on a Manager reservation; a Manager cannot act on a guest, other-account, old-link, or cross-event reservation. All such probes use the same existing `RESOURCE_FORBIDDEN` response. The new Manager DELETE is actor-scoped and self-cancel only. Its one-shot CAS returns a cancel-specific outcome—`canceled`, `already-canceled`, `forbidden`, or `conflict`; a lost CAS may use one classification-only read, but never retries a delete against the winner. The legacy host cleanup endpoint `POST /manage/events/:eventId/media/:mediaId/cancel-reservation` remains available only for guest-owned `reserved`/`failed` rows and uses the same one-shot safety rule. Neither route can delete a Manager-owned row or a finalize winner. Once stored, original removal belongs to Intake's recoverable confirmation path.

Export one upload-file Zod schema and reuse it for guest and Manager reservation bodies. The nested file object and both outer request objects are strict, so unknown outer, file, actor/account, upload URL, and object-key fields are rejected. The Manager batch body is exactly `{ files: [{ filename, mimeType, byteSize, idempotencyKey, caption? }] }`; it accepts no guest name, account/actor/event ID, upload URL, or object key, and the server always stores `guest_name = 'Host'`. Manager upload responses use the strict `UploadMediaView` allowlist and batch envelopes from Slice 1; no route returns session IDs, object keys, bucket state, access-token IDs, reservation internals, or account identity. Reservation URLs point only to the Manager paths above. All four Manager upload routes mount `privateJson` before their handlers, and success and error coverage asserts `Cache-Control: private, no-store` plus `Vary: Cookie`.

Make `GuestUploadFlow` a controlled renderer with one explicit `UploadFlowSession` input rather than copying its queue. `useGuestUploadSession` owns the existing guest items/controller/queue, while `useManagerUploadSession` owns the Manager items/controller/queue plus generation and cleanup; `GuestUploadFlow` itself no longer stores queue items, constructs an `AbortController`, creates a transport, or calls `runUploadQueue`. Browser transport construction is discriminated: `{ kind: 'guest', slug, guestName }` builds the unchanged guest paths and bodies, while `{ kind: 'manager', eventId }` builds the four Manager paths, omits `guestName`, sends both credential-header pairs on raw XHR, and alone exposes cancel. The Manager variant supplies fixed, noneditable `Host` identity; omits the guest hero, name editor, and Guestbook receipt action; and changes only Manager-facing heading/receipt copy. It reuses the same controlled source controls, validation, two-transfer concurrency, idempotency, progress, cancellation, retry, and finalize behavior.

Active Intake always exposes one **Add photos** toolbar action; the true-empty secondary action invokes that same control path. The toolbar action remains focusable with `aria-disabled` and an adjacent reason when capacity or lifecycle prevents opening, so receipt focus never targets a disabled native control. Availability is rechecked when files are adopted and again on **Send**; both initial and review source controls disable with the named reason, and a late availability loss sends no request. There is no client cap polling.

Extract only a small modal primitive with `labelledBy`, `initialFocusRef`, `onRequestClose`, a close/Escape policy, dialog ref/children, the Manager live-host inert exception, body-scroll lock, containment, and parent-owned return focus. The dialog applies that primitive with stable label **Add photos** and does not introduce a framework. The manager variant suppresses or demotes `GuestUploadFlow`'s page `h1` headings so initial, review, progress, and receipt states do not create duplicate or shifting dialog labels. Before sending, Close may discard the browser-only selection. The Manager receipt says the photos were added and provides **Done**, which closes to Intake and restores the toolbar action rather than telling the host to close the page.

Make the queue's smallest missing extension explicit. A delivered `ReservationResult` carries its `mediaId`, and `RunUploadQueueOptions` gains `onFinalized({ itemId, mediaId })`, called once for each newly confirmed finalized or idempotently already-delivered item. Expose a narrow `invalidateLibrary()` bridge. Under one captured event generation, each newly finalized media ID invalidates only the event projection, active Intake, Library, and affected Guestbook; only repeated media IDs are deduplicated, so every distinct partial success invalidates. The existing `onDelivered(count)` remains the all-selected-items-delivered receipt signal; it is not the only refresh hook. The narrow upload response does not pretend to contain enough fields to adopt a Manager card, and neither callback calls shell-wide refresh or touches trash/Guest-gallery filters.

One Manager upload-session lifecycle owner owns phase, generation, the shared `AbortController`, the current queue promise, latest queue snapshot, cleanup candidates, and aggregate cleanup result. `ManagerPage` receives only exit-gate and escalation signals; it never owns or starts a second queue. A typed `CleanupItem` records the queue item, idempotency key, optional reservation, and disposition `unattempted | known-absent | ambiguous | reserved | delivered | canceled`. A queue chunk is marked `ambiguous` for every item before its reservation request is dispatched; only a response can refine those items to known-absent, reserved, delivered, or canceled. Items in a later, undispatched chunk remain `unattempted`. Completed earlier chunks remain recorded if a later reservation chunk fails. Cleanup replays every `ambiguous` item, cancels only `reserved`, and ignores `unattempted`, `known-absent`, `delivered`, and `canceled`.

`UploadTransport` gains `cancelReservation(item, reservation)` for the Manager transport, backed by the Manager DELETE route; the Guest variant is unchanged. While transfer or cleanup is active, ordinary Close/Escape is unavailable. The upload owner supplies ownership to `ManagerPage`'s existing sole Router blocker and `beforeunload` listener; while uploads own the block, Album leave preparation and auto-proceed are suppressed. The dialog registers neither. Explicit **Cancel uploads** synchronously retires the generation, aborts the shared controller, awaits the queue promise, then cleans only the dispositions above. A typed terminal upload failure performs the same synchronous retirement; workers check abort and generation after every await and before upload, finalize, delivered/progress state, or `onFinalized`, so no sibling request or late settlement survives it.

Cleanup returns one aggregate result: `{ kind: 'settled', deliveredIds }`, `{ kind: 'retry', unresolvedCount, deliveredIds }`, or `{ kind: 'terminal', reason, unresolvedCount, deliveredIds }`. Terminal wins and prevents new cleanup work. A retry keeps the dialog open with **Retry cleanup** and the exact count. The dialog cannot intentionally unmount until every attempted reservation is delivered/canceled or a terminal handoff has occurred; browser-only unattempted selections may be discarded immediately, and reservation expiry remains the unavoidable tab/process backstop.

Terminal authorization/lifecycle loss is the explicit exception to that close gate. A local typed table classifies route-reachable session/account/authorization codes and same-authority `RESOURCE_FORBIDDEN` as authorization terminal, and `EVENT_NOT_FOUND`, `EVENT_DELETED`, and `EVENT_EXPIRED` as lifecycle terminal; it does not alter the global `RESOURCE_FORBIDDEN` load classification. Ordinary API errors are the flat `{ code, message, requestId, ... }` body; nested `{ error: ... }` appears only inside successful batch per-item rejections. A shared flat-error fixture drives both Worker route and dialog integration coverage.

Terminal loss hands unresolved reserved/failed IDs to the existing server reservation-expiry/tombstone cleanup; the dialog may then unmount without claiming they were canceled. If a still-valid account credential remains, it shows **Temporary uploads will expire automatically**, refreshes under that account, and closes to Intake. Otherwise it yields to the existing Manager recovery surface. Rotation's D1 cancellation usually settles old-link rows immediately, while this rule covers another actor's rotation, expiry, or a response the client cannot authorize. Stored items already signaled through `onFinalized` remain delivered.

The actual `EventView` contract adds `hostUploadAvailability: { enabled: boolean; reason: 'event-unavailable' | 'media-cap' | 'storage-cap' | null }`, using `MAX_EVENT_MEDIA` and `MAX_EVENT_BYTES`. Update the exact `EVENT_VIEW_KEYS`, the central typed E2E fixture, and every direct typed `EventView` fixture; `GuestEventView` remains unchanged and its exact-key test proves the key is absent. The component passes the explicit object rather than guest `uploadsEnabled`; it remains enabled for scheduled/pre-start/paused guest intake and renders the named server reason when disabled. Count/byte decisions include Slice 1's active, reserved, and recoverable usage. The Worker rechecks the same limits authoritatively at reservation, idempotent refresh, and commit.

Host uploads render `From Host`. Account email/name and management credential details never enter media projections.

## First run and Intake empty state

True empty Intake says **No photos yet**, not **No matching photos**. It shows the existing printable QR and the private-delivery promise:

> Guests' photos arrive privately here.

Primary action opens the existing Share/print surface. Host upload is the secondary action. A filtered empty result retains **No matching photos** with Clear filters.

Album title defaults to the event name through the current Album draft initialization. Clearing the title shows the event name as a placeholder but does not save an invalid empty value.

Equal upload time endpoints render one time, not a duplicated range. Intake schedule, Manager header/retention, upload flow, and Host Events adopt the canonical calendar-date/instant formatter introduced in Slice 1; component-local locale calls are removed from those surfaces. Equal start/end formatting is centralized in `formatEventTimeRange`.

## Current-era versus historical picks

Do not infer provenance from lazy `event_albums.created_at` or clock ordering. Migration 0021 adds nullable `media.album_pick_version` constrained to `1` when present and `events.album_pick_generation INTEGER NOT NULL DEFAULT 0`. Existing favorites on unsaved Albums remain null and are conservatively historical; favorites belonging to already-saved Albums are backfilled to `1`. Both the authority and Album halves stay in this one uncommitted migration until the single final Slice commit/deployment; a pre-commit review defect is corrected in 0021 and the affected reviews repeat, rather than inventing 0022.

The migration must be safe under the repository's migration-first deployment order while the currently deployed 0020 Worker is still serving. Compatibility normalization triggers atomically stamp version `1` after a legacy `favorited_at: null -> instant` write and clear the version after `instant -> null`; a guard rejects any direct version-only write whose final pair would disagree. Database triggers increment the owning event's pick generation once for every actual Album-eligibility change: pick/unpick, trash/restore of a picked row, active picked permanent guest deletion, and another stored/deleted transition that changes whether a picked row can appear. Cleanup of an already-trashed picked row does not double-increment because it was already ineligible. The new Worker writes the favorite/version pair together but never increments the generation itself. The triggers therefore cover old and new writes exactly once without a fourth finalization migration. Restoring a trashed historical row does not change either provenance field and keeps its null marker, while the generation still changes because visibility changed.

On the first unsaved Album read, “pick” and every reconciliation count include both active and retained-trash picked rows (including expired cleanup-pending rows), even though only active photos render:

- any unversioned pick keeps the one-time reconciliation prompt; its copy says “existing picks from before this update,” not the false “before Albums” story;
- if every pick is version `1` and there are at most 500, the client shows a bounded initializing state and automatically calls the existing CSRF-protected `POST /api/manage/events/:eventId/album/start` with `from-picks`; the guarded D1 transaction freezes current picks in timeline order and marks the Album saved;
- no picks renders the ordinary empty Album without a reconciliation prompt;
- more than 500 picks always projects `over-capacity`, including an all-version-1 cohort with `historicalPickCount: 0`; it never auto-starts from picks;
- mixed historical/current picks within the cap use the prompt, whose choice applies to the complete current picked set.

`AlbumView` exposes the event-owned generation and counts, not raw version fields:

```ts
interface AlbumView {
  pickGeneration: number;
  reconciliation: AlbumReconciliation;
  // existing Album fields
}

type AlbumReconciliation =
  | { kind: 'initialize' }
  | { kind: 'historical'; historicalPickCount: number }
  | { kind: 'over-capacity'; pickCount: number; historicalPickCount: number }
  | null;
```

Null means saved or zero picks. Extend the existing `/album/start` request with `expectedReconciliation: 'initialize' | 'historical' | 'over-capacity'`, `expectedPickGeneration`, and `expectedRevision`. New clients always send all three. The first mutation is one row: an Album expectation/revision compare-and-set that rechecks generation, category/count/cap, provenance, saved state, and the complete retained picked cohort. For `from-picks`, that single guarded update is the only mutation. For `empty`, clearing active and retained picks is the immediately following and final mutation, gated with `AND changes() = 1`; no later mutation depends on it. All diagnostics after these mutations are read-only. A same-count substitution therefore conflicts just as a category or revision change does, with favorites, entries, saved state, and revision unchanged. The legacy `{ start }` body remains accepted for one compatibility release with the existing manual-start semantics so an old browser tab remains compatible across the single final deployment; it never activates the new automatic path. Above 500 picks, Start empty remains available while Start from picks is truthfully unavailable.

Album capacity counts internal entries, not only currently visible photos. Saved section entries and retained trashed-photo entries keep their existing slots; unsaved reconciliation and new-pick guards count active plus retained-trash picked rows. This work is regression-first because the principal guards already exist: inventory current coverage, add only missing cap-edge, repeated trash/replace/restore, export-hold, reset, cover, and cleanup rows, and change production only when a focused RED proves a gap. Start from picks materializes both active and retained-trash picked IDs in timeline order so a still-timely later Restore returns to the same slot; an expired cleanup-pending slot remains until cleanup. Start empty is the one explicit exception: it clears every active/retained-trash pick and starts with no entries. Public/Preview projections omit retained entries, but a timely Restore remains unconditional because Slice 1 reserved both event and Album capacity.

Slice 1's narrow recoverable-or-expired-cleanup-pending entry/cover markers remain the Album editor contract. This slice counts those markers toward `ALBUM_MAX_ENTRIES` and applies the same revision guard to its new Start/reset paths. Visible photos and sections may still reorder around a retained slot, so trash → reorder/save → timely Restore stays deterministic and expiry under an export hold remains saveable. Reset uses timeline order for active and retained-trash picks; only Start empty deliberately clears them all.

The existing Start empty path remains unconditional above 500 picks. C-49's post-review repair receives a regression rather than another implementation.

## Registration and event dashboard

Registration copy states that the account is created only after code confirmation. Accepted start and a successfully delivered resend return `{ data: { registrationPending: true, resumeExpiresAt }, requestId }`; the browser stores `SHA-256(normalize(email))` and that 15-minute expiry in `localStorage` under a versioned pending-registration key. `HostAccountPanel` hands an accepted start to its persistence owner as `{ email, resumeExpiresAt }`, allowing that owner to compute the initial digest, and reports a delivered resend as `{ resumeExpiresAt }`. The persistence module exposes a digest-preserving expiry refresh, so after reload a delivered resend can replace the stored expiry without recovering or storing raw email. A failed resend leaves the prior serialized marker byte-for-byte unchanged. The browser never stores the raw email, password, code, browser secret, or challenge ID. The existing HttpOnly registration cookie remains the only resume credential.

Add `GET /api/host/register/pending`, which accepts no email and returns only `{ data: { pending: boolean, expiresAt: string | null }, requestId }` for the browser's own registration cookie with private/no-store headers. On sign-in submit, a nonexpired local digest match checks that endpoint and, when true, routes to `/host/register?pending=1` before any password request. A false/expired status clears the marker and proceeds with ordinary sign-in. Completion, Start over, explicit restart, and expiry clear it. Another browser and a different email retain the existing anti-enumeration responses.

Successful confirmation establishes the existing host session. When registration was bound to an event and carries a still-valid canonical `returnTo`, completion adopts that event and resumes the exact safe Manager destination; standalone/pending registration with no valid event return routes to Host Events. If binding cannot complete, the result explains that the account exists but the event was not saved and offers **Continue to Host Events** rather than looping through confirmation. The positive event allowlist in `GET /api/host/session` adds `eventTimezone` beside each event's existing `eventDate` and management-expiry instant. Host Events uses the date-only formatter for `eventDate` and the explicit event zone for the expiry; it never falls back to UTC or the browser zone. That page adds:

- a primary Create event link;
- case-insensitive local search across loaded event names;
- deterministic event-date sorting with newest/oldest choice;
- the current event cards and ownership model unchanged.

Archive is not introduced; the review explicitly places it after these bounded discoverability controls.

## Management-link rotation

Rotation is deliberately account-gated rather than building a recovery-only credential protocol. The allowlisted Manager event projection adds `managerLinkRotationAvailability: { enabled: boolean; reason: 'account-required' | null }`, derived from the same accepted authorization source as `requireManager` and invalidated with the event/account resource. It is enabled only when authorization resolved through an active host account with owner/cohost membership for that event. Link-only access renders a focusable disabled action with the inline explanation **Sign in to an account that owns or cohosts this event to rotate its link** and the existing sign-in/save-to-account path before submission; a direct probe receives existing `403 ROLE_FORBIDDEN`.

Rotation extends `LinkService` rather than adding a recovery channel. The account-authorized Manager projection exposes `managerLinkRevision`, never token IDs, and a strict rotation request carries `expectedManagerLinkRevision`. One D1 batch first compare-and-sets and increments that revision, then revokes the exact predecessor token only when the CAS won, inserts the replacement only when that revoke won, revokes bearer-derived sessions, rebinds live account upload actors, terminally cancels revoked link actors' reserved/failed uploads with exact counter deltas, and inventories their aliases. Every optional dependent is guarded by the unique replacement token ID, never by a timestamp or a preceding optional `changes()` result. A delayed request A arriving after successful request B cannot rotate B's link.

Typed deletion claims run after commit through the existing tombstone cleanup; a failed R2 delete stays janitor-owned and cannot roll credentials back. The signed-in account session remains the Manager authority throughout; rotation neither navigates through the credential URL nor mints a second event session/cookie. The successful private/no-store response contains only the new management link and new revision. A clearly rejected transaction leaves the old token/sessions/actors/reservations usable.

After confirmation and before sending, `ManagerPage` retires the current resource generation and pauses export polling and other Manager mutations while retaining the last trusted view behind the dialog. A concurrent old-link `TOKEN_REVOKED` response belongs to that retired generation and cannot replace the rotation result. On a normal success, reads remain paused until the result closes and then all resources restart under the still-current account credential. On a clear HTTP failure before commit, resources resume and the UI says the current link was not changed. On a network/transport outcome where commit cannot be known, account authorization still resumes safely; the UI does not claim either link state and says **Couldn't confirm whether the link changed. Rotate again to create a link you can save.** It refreshes the account-authorized projection and rerotates using the observed `managerLinkRevision`, so an unknown replacement is invalidated without link-only or ownerless recovery.

The confirmation names immediate invalidation and the need to save the replacement. Initial focus is **Keep current link**; Escape, backdrop, and that button send no request and restore the Rotate trigger. **Rotate link** is an explicit nondefault action. Success replaces the confirmation with a result that marks the prior link invalid, renders the replacement through `CopyableLinkCard` in Slice 2's sensitive mode, and initially focuses **Copy management link**. A successful Clipboard copy enables/focuses **Continue managing**; if Clipboard fallback reveals/selects the value, **I've saved this link — continue** is the explicit acknowledgement. Until that acknowledgement, Escape/backdrop are disabled, the existing Router blocker rejects Back and every programmatic location transition, and `beforeunload` warns on reload/tab close. Only Copy/ack releases both gates. Closing resumes resources and restores focus to the Rotate trigger. The broader ownerless recovery product remains out of scope.

## Safety ladder

Existing action patterns are normalized by consequence:

- **Reversible:** Pick, Publish/Hide, remove with real Undo—immediate plus precise feedback.
- **Consequential:** Stop Album link, rotate Manager link, recoverable original trash—focused confirmation with audience and recovery copy.
- **Broad/catastrophic:** disable printed entry, sign out all guest devices, delete event—typed event-name confirmation after client validation.

Pause/resume remains an explicit reversible state change and uses those exact verbs. Validation happens before every request.

## Remaining deterministic polish

- Guestbook always opens on Needs review; count changes do not change the default tab.
- True-empty Intake is decided in `ManagerPage.renderMediaGrid`: it is true only when no contributor or publication filter is active; a filtered empty result retains Clear filters. Library remains unchanged.
- `gallery-timeline.ts` collapses identical formatted start/end strings for a multi-photo same-minute group; this scoped C-56 formatter stays independent from C-61.
- Cover upload uses one per-attempt controller owned by `use-cover-studio-session` across transfer and inspection. Cancel retires the generation, aborts, awaits settlement, replays an ambiguous reservation if necessary, rereads the authoritative draft, then runs existing discard reconciliation; late progress and inspection are ignored, and publication-controller ownership is unchanged.
- Registration confirmation has one deterministic outcome: resume a valid bound-event return, otherwise continue to Host Events.
- Existing one-state Album badge and Minus removal icon receive regressions.
- C-61 audits only its four named surfaces. A targeted AST check distinguishes date-valued `toLocaleString` calls from numeric count formatting; numeric uses are explicitly whitelisted rather than hidden behind a broad zero-match assertion.

## Verification

- Scheduled pre-start/early-open/post-start × paused/unpaused plus legacy RSVP-first/waiting/photos matrix, asserting primary phase separately from read surfaces, direct Gallery/Guestbook enforcement, fullscreen unavailable-shell/no-request behavior, and available projection parity
- Manager upload route/CSRF/private-header/strict-schema matrix for account owner, account cohost, current link, both cookies with account precedence, missing/invalid CSRF, cross-event, guest reservation, other-account actor, rotated old link, expired link/event, disabled account, removed membership, unknown outer key, and nested unknown key
- Account-actor migration/uniqueness/removal tests; exact actor liveness; remove-then-readd fresh identity; deterministic duplicate-token normalization and old-0020 insert refusal; account reservation survives Manager-link rotation, link reservation does not transfer, and no server-only actor secret, actor cookie, or raw media row reaches an upload response
- Shared-pipeline tests for scheduled/paused guest refusal versus Manager allowance, active+recoverable caps, signature/dimension failure, idempotent reserve, bounded body ingress, queue retry/finalize, reserved/failed cancel, stored-cancel refusal, and generic `Host` attribution
- Manager-variant component tests proving the same queue/concurrency behavior without guest hero, editable identity, or Guestbook CTA
- Sole upload-session owner, stable modal primitive/heading, availability recheck on adoption/Send, fill-the-last-slot return focus, distinct partial `onFinalized` invalidation, preserved earlier chunks, disposition-driven aggregate cleanup, synchronous terminal retirement/no-late-sibling behavior, sole Router blocker/Album suppression, terminal handoff without false cancellation, server-expiry backstop, and active stored-count/export-freshness tests
- Bounded browser coverage for held transfer with blocked Back/programmatic navigation, cleanup retry at 320 px with focused action, and terminal-expiry handoff
- True-empty versus filtered-empty Intake and QR action tests
- Album-era migration tests using identical timestamps for current-only, historical, mixed, restored-historical race, same-count substitution, concurrent pick/save/two-cohost initialization, empty, and 501-pick reconciliation; generation increments once under old/new writes
- Album-capacity/retention tests for active + retained-trash picks + sections, repeated trash/replacement/restore, unconditional timely Restore at cap, Start-from-picks versus Start-empty, trash/reorder/save/restore, expiry-under-hold reorder/save, trash-cover/replace-cover, reset, and cleanup marker removal
- Pending-registration tests for initial/resend `resumeExpiresAt`, panel-owned standalone/CreatePage callbacks, failed-resend non-refresh, local digest/expiry, own-cookie status, matching/nonmatching email, stale cookie, Start over/completion clearing, cross-tab reload, confirmation redirect, safe bound-event `returnTo`, failed bind fallback, no password/code/raw-email storage, unchanged server anti-enumeration, and exact Host Events timezone allowlist/formatting
- Event dashboard create/search/sort tests
- Rotation-availability/revision exact-key/invalidation tests for account owner/cohost, both-cookie account precedence, link-only null/disabled/sign-in path, delayed stale request after a winner, and direct `ROLE_FORBIDDEN`; revision-CAS/exact-predecessor/replacement-ID atomic rollback tests; confirmation focus/cancel/no-request, ambiguous refresh then observed-revision rerotation, sensitive result, Copy/acknowledgement gate, Router Back/programmatic navigation/reload blocking, resume/refetch, and focus-return tests
- Safety-rung request-before-confirmation tests for recoverable original trash, Stop Album link, rotate Manager link, disable printed entry, sign out guest devices, delete event, and Album reset's pre-action/Undo contract
- Canonical event-zone fixtures across Manager header, Intake schedule, retention, Host Events, DST boundaries, and equal-time formatting, plus deterministic Guestbook-default regressions

## Non-goals

- A second upload pipeline or Manager-only queue
- Exposing account identity on photos
- Broader ownerless recovery
- Event archive, analytics, roles, or activity feeds
- Changing printed-entry authorization or adding link-only Manager rotation/recovery

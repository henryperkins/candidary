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

The main guest page and fullscreen route use the same availability rules. Paused copy names only new uploads and never implies the event or other guest surfaces are offline.

## Host uploads through the existing pipeline

Add these manager-authenticated routes parallel to the guest paths:

- `POST /api/manage/events/:eventId/uploads/batch`
- `PUT /api/manage/events/:eventId/uploads/:mediaId/content`
- `POST /api/manage/events/:eventId/uploads/:mediaId/finalize`
- `DELETE /api/manage/events/:eventId/uploads/:mediaId`

Every phase calls `requireManager({ write: true })` before reading a body. Extract the browser's existing same-origin credential-header helper so the raw XHR content request sends both event and host CSRF pairs exactly as `api()` does; the accepted Manager credential chooses which pair the Worker verifies. Origin and CSRF checks complete before buffering bytes.

Migration `0021_manager_upload_and_album_era.sql` adds nullable `event_sessions.manager_upload_account_id REFERENCES host_accounts(id)`, a unique index on each live `(event_id, manager_upload_account_id)`, and triggers requiring role `manager` plus `can_claim_owner = 0` whenever that column is non-null. A server-only account actor has random secret/CSRF digests whose source secrets are discarded, the event's current Manager-token foreign key, and the event management expiry. `SessionRecord` carries the nullable actor field, and browser session resolution explicitly rejects an actor row before secret comparison. It is identity storage only and can never mint a cookie.

`ManagerUploadActorService` returns a role-aware upload actor:

- a management-link Manager uses that authenticated event-session ID;
- an account owner or cohost uses `ensureForReservation()` to reuse/create the one live server-only row for `(eventId, accountId)` after membership and lifecycle have already been checked;
- content/finalize/cancel use lookup-only actor resolution, so probing another upload never creates an actor;
- management-link rotation is one D1 batch that revokes the prior token and all bearer-derived sessions, inserts the replacement, rebinds live account actors to it, and terminally cancels every revoked link actor's reserved/failed rows with exact counter deltas; account uploads survive while link-owned reservations never transfer to a replacement link;
- event expiry/deletion, account disablement, membership removal, or actor revocation prevents every later phase. Removal revokes the live actor, so re-adding an account creates a new identity and cannot resume its former reservations.

`UploadService` accepts a server-created discriminant; the client cannot choose it:

```ts
type UploadAuthority =
  | { kind: 'guest'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-link'; actorSessionId: string; eventSessionId: string }
  | { kind: 'manager-account'; actorSessionId: string; hostSessionId: string; accountId: string };
```

Guest actors still require effective `photosOpen`. Manager actors deliberately ignore the guest schedule and guest pause, but still require a live event management window, Worker ingress, reservation/media/storage caps, type/size/signature/dimension validation, and all existing promotion fences. The service supplies the fixed public attribution separately from authority, so no account field can become display copy.

The authority policy is carried through reservation, idempotent refresh, post-buffer ingress claim, and final commit SQL—not reduced to a route-time Boolean. Each phase atomically rechecks the current guest/link session or host session, access token, account, membership, event lifecycle, media event, and exact `uploader_session_id`. Revocation between route authorization, body buffering, R2 writing, and commit therefore fails closed under the existing tombstone cleanup. Guest endpoints can never act on a Manager reservation; a Manager cannot act on a guest, other-account, old-link, or cross-event reservation. All such probes use the same existing `RESOURCE_FORBIDDEN` response. Manager cancel accepts only reserved/failed media—once stored, original removal belongs to Intake's recoverable confirmation path.

The Manager batch body is strict `{ files: [{ filename, mimeType, byteSize, idempotencyKey, caption? }] }`; it accepts no guest name, account/actor/event ID, upload URL, or object key, and the server always stores `guest_name = 'Host'`. Manager upload responses use the strict `UploadMediaView` allowlist and batch envelopes from Slice 1; no route returns session IDs, object keys, bucket state, access-token IDs, reservation internals, or account identity. Reservation URLs point only to the Manager paths above.

Extend `GuestUploadFlow` with a `manager` variant/slots rather than copying its queue. That variant supplies fixed, noneditable `Host` identity; omits the guest hero, name editor, and Guestbook receipt action; and changes only Manager-facing heading/receipt copy. It reuses the same source controls, validation, two-transfer concurrency, idempotency, progress, cancellation, retry, and finalize behavior.

Active Intake always exposes one **Add photos** toolbar action; the true-empty secondary action invokes that same control path. The toolbar action remains focusable with `aria-disabled` and an adjacent reason when capacity or lifecycle prevents opening, so receipt focus never targets a disabled native control. The dialog extracts and applies the already-tested `GalleryViewer` modal contract rather than inventing a Manager dialog framework: stable label **Add photos**, initial focus on that `h2`, focus containment/inert background, and return focus. The manager variant suppresses or demotes `GuestUploadFlow`'s page `h1` headings so initial, review, progress, and receipt states do not create duplicate or shifting dialog labels. Before sending, Close may discard the browser-only selection. The Manager receipt says the photos were added and provides **Done**, which closes to Intake and restores the toolbar action rather than telling the host to close the page.

Make the queue's smallest missing extension explicit. A delivered `ReservationResult` carries its `mediaId`, and `RunUploadQueueOptions` gains `onFinalized({ itemId, mediaId })`, called once for each newly confirmed finalized or idempotently already-delivered item. The Manager component deduplicates that signal by `mediaId` and invalidates only the event projection, active Intake, Library, and affected Guestbook projection after each partial success. The existing `onDelivered(count)` remains the all-selected-items-delivered receipt signal; it is not the only refresh hook. The narrow upload response does not pretend to contain enough fields to adopt a Manager card, and neither callback calls shell-wide refresh or touches trash/Guest-gallery filters. Both are event-generation guarded, so a late result from a retired Manager event cannot update the next one.

`UploadTransport` gains `cancelReservation(item, reservation)` for the Manager transport, backed by the Manager DELETE route; the Guest variant is unchanged. While transfer or cleanup is active, ordinary Close/Escape is unavailable, the existing Router blocker prevents Back/programmatic unmount, and `beforeunload` warns on document exit. Explicit **Cancel uploads** aborts new/XHR work and awaits the queue promise. For every attempted item without a confirmed delivered result, the controller uses its known reservation or replays the same idempotent reserve to resolve an ambiguous commit: `alreadyDelivered` fires the deduplicated `onFinalized`; a still-reserved/failed item is sent to Manager DELETE; confirmed deletion is terminal and never deletes a stored original. If DELETE loses a finalize/state race, the controller replays reserve/read **after** the conflict: `alreadyDelivered` reclassifies it as delivered and fires `onFinalized`, a canonical deleted/canceled result settles it, and a still-reserved/failed result retries DELETE. A network/unresolved or retryable cleanup result keeps the dialog open with **Retry cleanup** and its outstanding item count. The dialog cannot intentionally unmount or close until every attempted reservation is delivered or canceled, while browser-only unattempted selections may still be discarded immediately; the existing server reservation-expiry cleanup remains the backstop for an unavoidable tab/process termination.

Terminal authorization/lifecycle loss is the explicit exception to that close gate. `TOKEN_REVOKED`, account/membership loss, or event/access expiry aborts and retires the upload generation, ignores all late settlements, and hands unresolved reserved/failed IDs to the existing server reservation-expiry/tombstone cleanup; the dialog may then unmount without claiming they were canceled. If a still-valid account credential remains, it shows **Temporary uploads will expire automatically**, refreshes under that account, and closes to Intake. Otherwise it yields to the existing Manager recovery surface. Rotation's D1 cancellation usually settles old-link rows immediately, while this rule covers another actor's rotation, expiry, or a response the client cannot authorize. Stored items already signaled through `onFinalized` remain delivered.

The Manager event projection adds `hostUploadAvailability: { enabled: boolean; reason: 'event-unavailable' | 'media-cap' | 'storage-cap' | null }`. The component passes that explicit object rather than guest `uploadsEnabled`; it remains enabled for scheduled/pre-start/paused guest intake and renders the named server reason when disabled. Count/byte decisions include Slice 1's active, reserved, and recoverable usage. The Worker rechecks the same limits authoritatively at reservation, idempotent refresh, and commit.

Host uploads render `From Host`. Account email/name and management credential details never enter media projections.

## First run and Intake empty state

True empty Intake says **No photos yet**, not **No matching photos**. It shows the existing printable QR and the private-delivery promise:

> Guests' photos arrive privately here.

Primary action opens the existing Share/print surface. Host upload is the secondary action. A filtered empty result retains **No matching photos** with Clear filters.

Album title defaults to the event name through the current Album draft initialization. Clearing the title shows the event name as a placeholder but does not save an invalid empty value.

Equal upload time endpoints render one time, not a duplicated range. Intake schedule, Manager header/retention, upload flow, and Host Events adopt the canonical calendar-date/instant formatter introduced in Slice 1; component-local locale calls are removed from those surfaces. Equal start/end formatting is centralized in `formatEventTimeRange`.

## Current-era versus historical picks

Do not infer provenance from lazy `event_albums.created_at` or clock ordering. Migration 0021 adds nullable `media.album_pick_version` constrained to `1` when present and `events.album_pick_generation INTEGER NOT NULL DEFAULT 0`. Existing favorites on unsaved Albums remain null and are conservatively historical; favorites belonging to already-saved Albums are backfilled to `1`.

The migration must be safe under the repository's migration-first deployment order while the 0018 Worker is still serving. Compatibility normalization triggers atomically stamp version `1` after a legacy `favorited_at: null -> instant` write and clear the version after `instant -> null`; a guard rejects any direct version-only write whose final pair would disagree. Database triggers increment the owning event's pick generation once for every actual Album-eligibility change: pick/unpick, trash/restore of a picked row, active picked permanent guest deletion, and another stored/deleted transition that changes whether a picked row can appear. Cleanup of an already-trashed picked row does not double-increment because it was already ineligible. The new Worker writes the favorite/version pair together but never increments the generation itself. The triggers therefore cover old and new writes exactly once without a fourth finalization migration. Restoring a trashed historical row does not change either provenance field and keeps its null marker, while the generation still changes because visibility changed.

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

Null means saved or zero picks. Extend the existing `/album/start` request with `expectedReconciliation: 'initialize' | 'historical' | 'over-capacity'` and `expectedPickGeneration`. New clients always send both. The guarded D1 transaction matches the generation plus expected category/count/cap, then rechecks provenance, saved state, and the complete retained picked cohort atomically; a same-count substitution therefore conflicts just as a category change does. The legacy `{ start }` body remains accepted for one compatibility release with the existing manual-start semantics; it never activates the new automatic path. A restored historical pick, concurrent pick substitution, or concurrent first save returns the canonical conflict/reload path instead of silently changing the new-client cohort. Above 500 picks, Start empty remains available while Start from picks is truthfully unavailable.

Album capacity counts internal entries, not only currently visible photos. Saved section entries and retained trashed-photo entries keep their existing slots; unsaved reconciliation and new-pick guards count active plus retained-trash picked rows. Start from picks materializes both active and retained-trash picked IDs in timeline order so a still-timely later Restore returns to the same slot; an expired cleanup-pending slot remains until cleanup. Start empty is the one explicit exception: it clears every active/retained-trash pick and starts with no entries. Public/Preview projections omit retained entries, but a timely Restore remains unconditional because Slice 1 reserved both event and Album capacity.

Slice 1's narrow recoverable-or-expired-cleanup-pending entry/cover markers remain the Album editor contract. This slice counts those markers toward `ALBUM_MAX_ENTRIES` and applies the same revision guard to its new Start/reset paths. Visible photos and sections may still reorder around a retained slot, so trash → reorder/save → timely Restore stays deterministic and expiry under an export hold remains saveable. Reset uses timeline order for active and retained-trash picks; only Start empty deliberately clears them all.

The existing Start empty path remains unconditional above 500 picks. C-49's post-review repair receives a regression rather than another implementation.

## Registration and event dashboard

Registration copy states that the account is created only after code confirmation. Accepted start returns `{ data: { registrationPending: true, resumeExpiresAt }, requestId }`; the browser stores `SHA-256(normalize(email))` and that 15-minute expiry in `localStorage` under a versioned pending-registration key. It never stores the raw email, password, code, browser secret, or challenge ID. The existing HttpOnly registration cookie remains the only resume credential.

Add `GET /api/host/register/pending`, which accepts no email and returns only `{ data: { pending: boolean, expiresAt: string | null }, requestId }` for the browser's own registration cookie with private/no-store headers. On sign-in submit, a nonexpired local digest match checks that endpoint and, when true, routes to `/host/register?pending=1` before any password request. A false/expired status clears the marker and proceeds with ordinary sign-in. Completion, Start over, explicit restart, and expiry clear it. Another browser and a different email retain the existing anti-enumeration responses.

Successful confirmation establishes the existing host session. When registration was bound to an event and carries a still-valid canonical `returnTo`, completion adopts that event and resumes the exact safe Manager destination; standalone/pending registration with no valid event return routes to Host Events. If binding cannot complete, the result explains that the account exists but the event was not saved and offers **Continue to Host Events** rather than looping through confirmation. The positive event allowlist in `GET /api/host/session` adds `eventTimezone` beside each event's existing `eventDate` and management-expiry instant. Host Events uses the date-only formatter for `eventDate` and the explicit event zone for the expiry; it never falls back to UTC or the browser zone. That page adds:

- a primary Create event link;
- case-insensitive local search across loaded event names;
- deterministic event-date sorting with newest/oldest choice;
- the current event cards and ownership model unchanged.

Archive is not introduced; the review explicitly places it after these bounded discoverability controls.

## Management-link rotation

Rotation is deliberately account-gated rather than building a recovery-only credential protocol. The allowlisted Manager event projection adds `managerLinkRotationAvailability: { enabled: boolean; reason: 'account-required' | null }`, derived from the same accepted authorization source as `requireManager` and invalidated with the event/account resource. It is enabled only when authorization resolved through an active host account with owner/cohost membership for that event. Link-only access renders a focusable disabled action with the inline explanation **Sign in to an account that owns or cohosts this event to rotate its link** and the existing sign-in/save-to-account path before submission; a direct probe receives existing `403 ROLE_FORBIDDEN`.

Rotation extends `LinkService` rather than adding a recovery channel. One D1 batch creates the replacement Manager token, revokes the prior token and all bearer-derived sessions, rebinds the live account upload actors described above, terminally cancels every revoked link actor's reserved/failed uploads with exact counter deltas, inventories their aliases, and commits only as a unit. Its typed deletion claims run after commit through the existing tombstone cleanup; a failed R2 delete stays janitor-owned and cannot roll credentials back. The signed-in account session remains the Manager authority throughout; rotation neither navigates through the credential URL nor mints a second event session/cookie. The successful private/no-store response contains only the new management link. A clearly rejected transaction leaves the old token/sessions/actors/reservations usable.

After confirmation and before sending, `ManagerPage` retires the current resource generation and pauses export polling and other Manager mutations while retaining the last trusted view behind the dialog. A concurrent old-link `TOKEN_REVOKED` response belongs to that retired generation and cannot replace the rotation result. On a normal success, reads remain paused until the result closes and then all resources restart under the still-current account credential. On a clear HTTP failure before commit, resources resume and the UI says the current link was not changed. On a network/transport outcome where commit cannot be known, account authorization still resumes safely; the UI does not claim either link state and says **Couldn't confirm whether the link changed. Rotate again to create a link you can save.** A subsequent account-authorized rotation invalidates any unknown replacement.

The confirmation names immediate invalidation and the need to save the replacement. Initial focus is **Keep current link**; Escape, backdrop, and that button send no request and restore the Rotate trigger. **Rotate link** is an explicit nondefault action. Success replaces the confirmation with a result that marks the prior link invalid, renders the replacement through `CopyableLinkCard` in Slice 2's sensitive mode, and initially focuses **Copy management link**. A successful Clipboard copy enables/focuses **Continue managing**; if Clipboard fallback reveals/selects the value, **I've saved this link — continue** is the explicit acknowledgement. Until that acknowledgement, Escape/backdrop are disabled, the existing Router blocker rejects Back and every programmatic location transition, and `beforeunload` warns on reload/tab close. Only Copy/ack releases both gates. Closing resumes resources and restores focus to the Rotate trigger. The broader ownerless recovery product remains out of scope.

## Safety ladder

Existing action patterns are normalized by consequence:

- **Reversible:** Pick, Publish/Hide, remove with real Undo—immediate plus precise feedback.
- **Consequential:** Stop Album link, rotate Manager link, recoverable original trash—focused confirmation with audience and recovery copy.
- **Broad/catastrophic:** disable printed entry, sign out all guest devices, delete event—typed event-name confirmation after client validation.

Pause/resume remains an explicit reversible state change and uses those exact verbs. Validation happens before every request.

## Remaining deterministic polish

- Guestbook always opens on Needs review; count changes do not change the default tab.
- Cover upload extends the existing operation controller with determinate byte progress and Cancel.
- Registration confirmation has one deterministic outcome: resume a valid bound-event return, otherwise continue to Host Events.
- Existing one-state Album badge and Minus removal icon receive regressions.

## Verification

- Guest-surface matrix while uploads are open/paused, including fullscreen parity
- Manager upload route/CSRF matrix for account owner, account cohost, current link, both cookies with account precedence, missing/invalid CSRF, cross-event, guest reservation, other-account actor, rotated old link, expired link/event, disabled account, and removed membership
- Account-actor migration/uniqueness tests; account reservation survives Manager-link rotation, link reservation does not transfer, and no server-only actor secret, actor cookie, or raw media row reaches an upload response
- Shared-pipeline tests for scheduled/paused guest refusal versus Manager allowance, active+recoverable caps, signature/dimension failure, idempotent reserve, bounded body ingress, queue retry/finalize, reserved/failed cancel, stored-cancel refusal, and generic `Host` attribution
- Manager-variant component tests proving the same queue/concurrency behavior without guest hero, editable identity, or Guestbook CTA
- Always-available/nonempty Intake trigger, stable dialog heading, focus/close/Done, fill-the-last-slot return focus, per-media partial `onFinalized` invalidation/deduplication, all-delivered receipt, cancel abort/await/idempotent replay, ambiguous delivered reservation, finalize-between-replay-and-DELETE conflict reclassification, cleanup retry, Back/programmatic/reload exit gates, old-link rotation/event-expiry terminal handoff without false cancellation, server-expiry backstop, event-generation retirement, and active stored-count/export-freshness tests
- Host-upload axe, keyboard/focus, 320/390 px target/overflow, and receipt-state extension to Slice 4's matrix
- True-empty versus filtered-empty Intake and QR action tests
- Album-era migration tests using identical timestamps for current-only, historical, mixed, restored-historical race, same-count substitution, concurrent pick/save/two-cohost initialization, empty, and 501-pick reconciliation; generation increments once under old/new writes
- Album-capacity/retention tests for active + retained-trash picks + sections, repeated trash/replacement/restore, unconditional timely Restore at cap, Start-from-picks versus Start-empty, trash/reorder/save/restore, expiry-under-hold reorder/save, trash-cover/replace-cover, reset, and cleanup marker removal
- Pending-registration tests for local digest/expiry, own-cookie status, matching/nonmatching email, stale cookie, Start over/completion clearing, cross-tab reload, confirmation redirect, safe bound-event `returnTo`, failed bind fallback, no password/code/raw-email storage, unchanged server anti-enumeration, and exact Host Events timezone allowlist/formatting
- Event dashboard create/search/sort tests
- Rotation-availability exact-key/invalidation tests for account owner/cohost, both-cookie account precedence, link-only disabled/sign-in path, and direct `ROLE_FORBIDDEN`; atomic token/account-actor rollback tests; confirmation focus/cancel/no-request, retired old-link poll, clear failure, ambiguous response followed by safe re-rotation, sensitive result, Copy/acknowledgement gate, Router Back/programmatic navigation/reload blocking, resume/refetch, and focus-return tests
- Safety-rung request-before-confirmation tests for recoverable original trash, Stop Album link, rotate Manager link, disable printed entry, sign out guest devices, delete event, and Album reset's pre-action/Undo contract
- Canonical event-zone fixtures across Manager header, Intake schedule, retention, Host Events, DST boundaries, and equal-time formatting, plus deterministic Guestbook-default regressions

## Non-goals

- A second upload pipeline or Manager-only queue
- Exposing account identity on photos
- Broader ownerless recovery
- Event archive, analytics, roles, or activity feeds
- Changing printed-entry authorization or adding link-only Manager rotation/recovery

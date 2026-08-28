# Host Gallery Privacy, Recovery, and Manager Isolation Design

**Program:** [Host Gallery Roadmap](2026-08-23-host-gallery-roadmap-program-design.md)

**Slice:** 1 of 6

**Findings:** C-03, C-04, C-06, C-11, C-22, C-35, export/delete retention race

## Goal

Remove unnecessary guest data exposure, make Album captions obey the publication rule, make host deletion safely recoverable, protect accepted exports and distributed Album credentials at their irreversible boundaries, and establish the destination/resource ownership needed to add recovery without coupling unrelated Manager panels.

## Existing systems retained

- `MediaRepository` remains the source of stored media state.
- The canonical Worker upload and R2 object inventory remain unchanged.
- `AlbumShareService` continues to authenticate the fragment-to-cookie flow.
- `PublicAlbum` remains the recipient renderer.
- The current Gallery Undo hook/bar remain the implementation. This slice introduces the Manager-scoped provider contract specified in Slice 3 for trash; existing Album/Library consumers migrate to it in Slice 3 rather than creating another Undo system.
- Guest self-deletion remains permanent and continues through its existing authenticated upload route.

## Manager resource and query ownership prerequisite

Before adding Recently deleted, split the current `ManagerPage` all-or-nothing `refresh()` into resource-scoped controllers using its existing request-generation and error components; do not add a data-fetching library. Each owns `{ eventId, queryKey, generation, value, status, failure }`. A new event retires every generation and clears event-scoped values; a new query retires only that resource's page/cursor; Retry preserves the last trusted value while loading.

Event identity/lifecycle is the only shell-critical initial read. Event, Intake media, exports, printed entry, and Guestbook summary may start concurrently; the Gallery summary introduced in Slice 2 joins the same controller model. A retryable noncritical failure remains in its panel and cannot clear adopted siblings. A credential, role, account, or event-lifecycle failure from any current Manager resource generation escalates to the existing Manager recovery surface rather than masquerading as an isolated outage. A response from an explicitly retired generation—such as a pre-rotation read during Slice 5's account-authorized Manager-link rotation—is ignored and cannot replace that operation's result. Every result is adopted only for its exact current event/query generation.

Media query state is split at the same boundary:

- Intake owns a discriminated active-versus-trash query, its rows, selection, and cursor. Active owns contributor/search/ordinary status; Recently deleted calls only the trash endpoint;
- Library owns its private-gallery search/order, rows, and cursor inside `ManagerGalleryWorkspace`;
- Guest gallery owns publication status, rows, and cursor inside its mode;
- Album continues to own its picked projection.

Changing an Intake filter therefore cannot change a Gallery request. Event changes retire all generations and clear all event-scoped resources. Slice 6 extends these established resource owners for large-page reconciliation; it does not move ownership after this slice. This prerequisite resolves C-22 and C-35 before recovery UI depends on either seam.

Mutation handlers adopt their returned projection and invalidate only affected resources; none calls shell-wide refresh. Export writes refresh exports. Publication writes update Guest gallery/affected active Intake rows and relevant summaries. Pick writes update Library, Album, and—once introduced—Gallery summary. Trash/restore invalidates the event projection (because stored count/bytes changed), active Intake, trash Intake, Library, Album, affected Guestbook projection, and the later Gallery summary. Availability writes refresh event/settings and that summary.

## Guest response allowlists

Add explicit contracts in `shared/contracts.ts`:

```ts
interface GuestGalleryMediaView {
  id: string;
  guestName: string;
  caption: string | null;
  previewAvailable: boolean;
}

interface GuestContributionMediaView {
  id: string;
  originalFilename: string;
  caption: string | null;
  uploadState: 'reserved' | 'stored' | 'failed';
  previewAvailable: boolean;
  createdAt: string;
}

interface GuestContributionDeletionView {
  id: string;
  deleted: true;
}

interface UploadMediaView {
  id: string;
  mimeType: SupportedImageType;
  uploadState: 'reserved' | 'stored' | 'failed' | 'deleted';
}

type UploadBatchItemView =
  | {
      idempotencyKey: string;
      status: 'accepted';
      alreadyDelivered: boolean;
      media: UploadMediaView;
      uploadUrl?: string;
      uploadUrlExpiresAt?: string;
    }
  | {
      idempotencyKey: string;
      status: 'rejected';
      error: { code: ApiErrorCode; message: string };
    };
```

`GET /api/event/:slug/gallery` maps published media to `GuestGalleryMediaView`. It never returns uploader session IDs, object keys/bucket generation, MIME/byte/storage metadata, idempotency keys, reservation fields, moderation internals, or Album membership. The guest Gallery uses `Shared photo` when no caption exists rather than exposing the original filename.

`GET /api/event/:slug/contributions` uses `GuestContributionMediaView`; a guest may see their own original filename and transfer state, but not internal storage fields. Reserve/batch uses `{ items: UploadBatchItemView[] }`; content/finalize use `{ media: UploadMediaView }`. `uploadUrl` and its expiry exist only for a reserved accepted item and remain relative same-origin paths. Guest self-delete returns `GuestContributionDeletionView` rather than serializing the permanently deleted repository row. Manager reservation cancel uses `{ media: UploadMediaView }`. Tests compare exact key sets rather than checking only a few absent fields.

## Canonical event date/time foundation

Slice 1 creates `src/app/event-date-time.ts` over the existing primitives in `shared/event-time.ts`, because recovery, export snapshots, and later lifecycle surfaces all need one answer. `formatEventDate(YYYY-MM-DD)` validates/formats a calendar value without interpreting it in the browser's zone. `formatEventDateTime(iso, eventTimezone)`, `formatEventTimeRange`, and `formatRetentionDate` require a valid ISO instant and explicit IANA event zone, then use fixed `en-US` options; an equal rendered range emits one endpoint. Each formatter returns `string | null`; invalid input returns null, and the caller renders literal **Date unavailable** or **Time unavailable** without a `<time>` element rather than falling back to the machine zone. Valid semantic values render with the source value in `<time dateTime>`. Trash uses server `restoreUntil`, export Prepared uses immutable `snapshotAt` (not diagnostic `createdAt`), and retention uses `purgeAfter`.

## One public Album projection

Extract the event-ID projection currently embedded in `AlbumShareService` into one service consumed by:

- authenticated Album-share reads at `GET /api/album-share`; and
- `GET /api/manage/events/:eventId/album/preview`, guarded by `requireManager`.

The service returns the existing `PublicAlbumView`. It resolves only stored, untrashed, picked photos; omits empty sections; keeps a valid zero-photo response; and selects captions as:

```sql
CASE WHEN media.publication_status = 'published' THEN media.caption ELSE NULL END
```

Publication controls caption eligibility for the Album link only. It does not make a photo eligible or ineligible for the Album. `hidden` and `unpublished` photos remain visible when picked, but their guest-written captions do not cross the Album-link boundary.

The Manager Preview HTTP response is `200 { data: { album: PublicAlbumView }, requestId }`; the client unwraps it to `{ album }`. It works before sharing, after revocation, and with zero photos. It never calls or returns `AlbumShareService.status()`, exchanges a fragment, reads/sets the Album-share cookie, or returns a link URL, token, or ciphertext. Preview JSON sets `Cache-Control: private, no-store` and `Vary: Cookie`. A missing, cross-event, or noneligible Manager image uses the existing non-enumerating `403 RESOURCE_FORBIDDEN` contract; eligible metadata whose bytes are absent returns existing `404 UPLOAD_OBJECT_MISSING`. Ordinary Manager authentication/lifecycle errors retain their existing codes.

`PublicAlbum` gains one required `imageSource(mediaId)` prop instead of hard-coding a credential domain. The live page passes `/api/album-share/media/:mediaId/preview`; Manager Preview passes `/api/manage/events/:eventId/album/media/:mediaId/preview`. The Manager image route re-runs `requireManager`, requires the media to be stored, untrashed, and in the projected Album, returns the existing bounded preview bytes, and never mints or exposes an Album-share credential. Cover and body photos use the same injected resolver. Image success includes `Content-Type`, `Content-Length`, `Cache-Control: private, no-store`, `Vary: Cookie`, `X-Content-Type-Options: nosniff`, and `Cross-Origin-Resource-Policy: same-origin`; JSON/image errors carry the same cache headers and standard error envelope. No Manager Preview response sends `Set-Cookie`. The public image route retains its separate Album-share authorization and `ALBUM_SHARE_UNAVAILABLE` behavior.

## Recoverable host deletion

Create migration `0019_media_recovery.sql` with nullable `media.trashed_at` and `media.restore_until`, non-negative `events.recoverable_media_count` and `events.recoverable_bytes` defaulting to zero, an expiry index, and database triggers enforcing:

- both values are null or both are non-null;
- only a stored row that is not in the permanent `upload_state = 'deleted'` state may carry the trash pair;
- a trashed row also has `deleted_at = trashed_at`, while an active stored row has all three values null;
- a present `restore_until` is strictly later than `trashed_at`;
- `restore_until` cannot be later than either the event's `management_access_expires_at` or `purge_after` when written;
- active stored plus reserved plus recoverable counts/bytes remain within the existing event caps on every counter write, including one issued by the migration-era 0018 Worker.

The migration also adds the exact source-hold index and tombstone-suppression triggers described below. It audits and replaces 0015's two affected UPDATE guards, `media_object_write_tombstone_guard_update` and `media_stored_legacy_guard_update`, preserving their replay/grandfathering rules plus one exact recovery exception: an old row whose valid trash pair matches `deleted_at` may clear all three markers while remaining stored when its current object pointer/required aliases are unsuppressed and the repository performs the counter transfer in the same D1 batch. Suppressed retired noncurrent aliases—such as a promoted row's legacy key—do not block that recovery, and a still-legacy grandfathered stored row remains restorable. Every ordinary deleted-row revival and any recovery with a suppressed current pointer still aborts. Existing migrations and object-inventory tables are not rebuilt.

The row keeps `upload_state = 'stored'`, `publication_status`, `favorited_at`, object inventory, and Album position while trashed. The matching `deleted_at` value is a compatibility exclusion marker, not permanent deletion: an old 0018 Worker already filters it from ordinary reads and refuses its existing delete path before touching R2. All new ordinary media, Gallery, public/Preview Album, Guestbook, preview, original, export-creation, active count, search, and publication queries still add `trashed_at IS NULL` explicitly as defense in depth. The Manager Album editor is the sole narrow exception: it resolves a persisted trashed entry/cover only to an opaque retained-slot marker containing media ID, `restoreUntil`, and `state: 'recoverable' | 'expired-cleanup-pending'`, with no image URL, caption, guest, or filename.

That marker renders as **Recently deleted photo** and uses Slice 4's one-use `open-recently-deleted` intent to route to Intake's Recently deleted filter; before Slice 4, the same control opens Intake and its Recently deleted filter through the Manager-owned navigation callback rather than storing state inside Album. After the deadline it additionally reads **Recovery expired · cleanup pending** and offers no Restore, but it remains a valid retained slot while an export hold delays cleanup. The marker participates in the existing revisioned Album document. Saves must round-trip it; the server rejects creating/changing/dropping a row that still has the trash-owner pair and rejects a submitted marker only when the row is missing, foreign, or already terminal—not merely expired. Visible photos and sections may reorder around the opaque slot. Choosing another cover intentionally replaces a retained cover reference; otherwise a still-timely Restore rehydrates the same photo/cover position. Permanent cleanup removes the exact current marker/cover under an expected-marker predicate and increments the Album revision in the same D1 batch, so a stale editor save cannot reinsert terminal state. Public/Preview projections omit the marker. This protocol ships in Slice 1 with trash, not later, so every slice remains independently deployable.

A saved Album may also have picked photos that are not yet in its persisted `entries` JSON; the existing resolver appends that live tail in timeline order. Before trashing any picked row in a saved Album, the same D1 batch materializes the complete currently resolved document—persisted entries/sections followed by every unplaced active or retained-trash pick—under the current revision and increments the revision, then applies trash so the target resolves as an opaque marker in that exact slot. If another autosave wins first, materialization uses its document; if it loses after, its stale revision conflicts and reloads. An unsaved Album is not prematurely created: its retained pick remains in the reconciliation cohort and a later Start-from-picks materializes the full timeline. This covers a middle item among several unmaterialized tail picks without a second ordering model.

Album capacity likewise cannot appear to be freed by trash. Saved documents already count opaque photo slots plus sections toward `ALBUM_MAX_ENTRIES`; unsaved/new-pick guards count active and retained-trash favorites, including expired cleanup-pending rows. New picks and section inserts use that internal count, while visible/public photo counts exclude trash. A timely Restore never performs a capacity check because its event and Album slots were retained. Start empty remains the explicit operation that clears active and retained-trash picks/markers; ordinary edits cannot silently do so.

`MediaRepository.trashStored()` performs one guarded D1 batch whose transition matches only `upload_state = 'stored'`, `deleted_at IS NULL`, `trashed_at IS NULL`, an unpurged event, and live management authority:

1. when the row is picked in a saved Album, materialize the complete resolved Album/tail under its current revision as specified above;
2. set `trashed_at = deleted_at = now` and `restore_until = min(now + 30 days, event.management_access_expires_at, event.purge_after)`;
3. decrement active stored media/byte counters and increment recoverable media/byte counters by the same amounts exactly once;
4. return the recoverable Manager projection.

It does not free upload capacity, start object tombstone suppression, or delete R2 bytes. Reservation, idempotent reservation refresh, final commit, and `hostUploadAvailability` all calculate usage as reserved + active stored + recoverable, so restoring a photo can never fail merely because later uploads consumed apparently freed space.

The allowlisted Manager event projection adds `recoverableMediaCount` and `recoverableBytes`; existing `storedMediaCount`/`storedBytes` continue to mean active delivered originals so export-freshness comparisons remain correct. The capacity meter displays active + recoverable usage and labels the recoverable portion, while upload availability uses reserved + active + recoverable. No guest projection receives either recovery field.

`MediaRepository.restoreTrashed()` uses a compare-and-set requiring `trashed_at IS NOT NULL`, `deleted_at = trashed_at`, `restore_until > now`, `events.deleted_at IS NULL`, `events.management_access_expires_at > now`, and `events.purge_after > now`; it clears all three markers, moves the exact count/bytes from recoverable back to active stored, and otherwise leaves total capacity unchanged in the same D1 batch. Because publication and pick state were retained, normal projections restore automatically. `MediaRepository.permanentlyDeleteTrashed()` matches only an expired trashed row with no exact active export hold, changes it to the existing permanent-deleted state, clears the trash pair while retaining a terminal `deleted_at`, and decrements recoverable count/bytes exactly once. A lost restore/cleanup race affects zero rows and reloads the canonical state. R2 deletion requires the separate suppression claim below.

Ordinary guest self-delete still becomes logically permanent immediately. Its guarded transition accepts either an active stored row or a trashed stored row owned by that guest. For an active row it decrements active stored count/bytes; for a trashed row it clears the trash pair, retains/updates terminal `deleted_at`, and decrements recoverable count/bytes. Either terminal path removes any exact persisted Album entry/cover reference with a revision advance in the same batch. It then inventories/suppresses object aliases through the same source-hold fence. Trash-first therefore permits the guest's permanent deletion without double-decrementing either bucket, while guest-delete-first makes the host trash compare-and-set lose with zero delta. If the exact source is held by an active export, the delete batch inventories an unsuppressed tombstone and returns success without an R2 claim for that key; public/guest projections exclude the row at once, while the tombstone janitor deletes the retained bytes only after the hold releases. Guest deletion is not made recoverable and is not rejected merely because an export is active.

While the trash pair remains, 0019 guards every exact source/final/preview alias as a recoverable owner: inserting or starting suppression for its tombstone aborts. This applies to the old promotion/tombstone janitor as well as new code. Restore clears the compatibility marker; only the guarded permanent transition clears the trash pair and permits suppression. Together with `deleted_at = trashed_at`, this keeps an accidentally rolled-back 0018 Worker from re-exposing or physically deleting recoverable media, although the program's post-write release policy remains forward-fix-only because attempt-v2 exports cannot be owned by that Worker.

Manager routes become explicit:

- `POST /api/manage/events/:eventId/media/:mediaId/trash` accepts a strict empty body and returns `200 { data: { media: ManagerTrashedMediaView }, requestId }`;
- `POST /api/manage/events/:eventId/media/:mediaId/restore` accepts a strict empty body and returns `200 { data: { media: ManagerMediaView }, requestId }`;
- `GET /api/manage/events/:eventId/media/trash?cursor&limit` returns `200 { data: { media: ManagerTrashedMediaView[], nextCursor }, requestId }`, ordered by `(trashedAt DESC, id DESC)` with default 24 and maximum 50.

`ManagerTrashedMediaView` contains exactly `id`, `originalFilename`, `guestName`, `caption`, `trashedAt`, and `restoreUntil`; it contains no preview/storage/object/session field. Missing/foreign targets use `403 RESOURCE_FORBIDDEN`. Wrong/repeated state, expired restore, or a lost cleanup race uses `409 MEDIA_STATE_CONFLICT` with zero counter delta. Malformed body/pagination uses `422 VALIDATION_FAILED`.

The current generic media PATCH no longer accepts host `delete`; publish/hide remain there. Guest self-delete still calls the existing permanent repository operation, with physical cleanup coordinated by the source-hold contract.

The ordinary-query exclusion is an auditable checklist, not a blanket search-and-replace. Focused repository tests cover Manager Intake, Library/private Gallery, Album picks and public projection, Guest gallery, Guestbook caption unions, preview/original handlers, export creation, favorite/publication writes, counts, search, and pagination. Trash listing, restore, terminal cleanup, purge, and the opaque Manager Album retained-slot resolver are the only named paths allowed to read trashed rows. Each new or changed query has an exact `trashed_at` fixture proving whether it must include or exclude the row.

## Intake interaction

The Intake trash button opens a focused confirmation before any request. It names the photo and states that future reads remove it from Library, Album, Guest gallery, and a live Album link; already loaded or downloaded copies cannot be recalled. It says recovery lasts up to 30 days but never beyond Manager access or event purge, that the retained photo continues to count against event capacity until permanent cleanup, and that an accepted or already-prepared export may retain its frozen copy. The exact deadline does not exist until the server accepts the transition. Initial focus is **Keep photo**. Escape, backdrop cancellation, and **Keep photo** close without a request and restore focus to the invoking trash control. The destructive **Move to Recently deleted** button is `type="button"`, is never the dialog's default submit, and sends exactly one request only after explicit activation.

On success, the trash interaction first resolves and focuses the next card, previous card, or Intake heading in that order. That connected element becomes the provider's return origin. The remaining behavior is input-aware:

- remove the card from Intake;
- for keyboard activation, present/focus Undo and return to the captured Intake fallback when the offer closes; for pointer activation, leave focus on that fallback rather than moving it to Undo;
- announce the named photo and server-returned `restoreUntil` deadline;
- register an offer of up to 30 seconds through the existing Undo action contract against the restore endpoint, with the server-returned `restoreUntil` as a nonpausable absolute cap.

Recently deleted is an Intake-owned filter, not a new Manager destination. It uses the Intake resource introduced above and states that retained photos still use event capacity. Before `restoreUntil` it lists the deadline and offers Restore. At or after that instant an export hold may delay cleanup, so the row reads **Recovery expired · cleanup pending** and exposes no Restore action. Original download remains unavailable until restoration. A successful Restore removes its row, focuses the next row, previous row, or Recently deleted heading in that order, and announces the named photo's return to Intake.

## Permanent cleanup and export source holds

`export_media_entries` plus an owning job in `queued` or `running` state is the D1 source hold. Migration 0019 adds index `export_media_entries_source_hold(media_id, object_bucket_generation, object_key, export_job_id)` over the existing snapshot columns and triggers that forbid inserting a non-null or changing a null `media_object_write_tombstones.suppression_started_at` while that exact bucket/key snapshot has an active owning job. Export creation inserts the job and its frozen media entries in the existing D1 snapshot batch, selecting only stored, untrashed rows whose exact source tombstone is not suppressed.

The batch's final statement uses the repository's existing constraint-sentinel pattern: it keeps the owning job's non-null `media_count` only when the frozen count matches and both set-difference checks prove exact identity equality with the eligible source query; otherwise it assigns `NULL` and the `NOT NULL` constraint aborts the complete D1 batch. The set-equality sentinel is mathematically valid for a frozen zero-photo legacy/retry snapshot when both sets are empty; the new-create service separately enforces Slice 3's at-least-one-photo product rule. A preceding application pre-read or a post-commit row-count check is not the atomicity proof.

Migration 0019 also closes the pre-0015 upgraded-database seam without guessing around an executing Workflow. Its first constraint sentinel aborts the entire migration with no changes when any export job is `running`; deployment waits for those existing Workflows to become terminal and reruns the migration. The migration transaction prevents a queued job from being claimed between that gate and trigger installation.

Within that transaction it validates **every** queued job. A pre-0015 complete job with `guestbook_entry_count IS NULL` becomes `failed` with `EXPORT_SOURCE_REMOVED`: the pinned legacy Workflow reads a live media query rather than `export_media_entries`, so backfilling rows cannot make its future source set safe. An entry-backed job remains queued only when its frozen entry count/byte sum exactly match stored `media_count`/`total_bytes` and every frozen exact bucket/key has an unsuppressed tombstone/active hold; otherwise it also becomes failed. It deliberately does not require the current media row still to point at that key: accepted snapshots are immutable, and a later trash, guest delete, or promotion must not strand their held source. Ready/failed/expired entryless legacy jobs are not retroactively called frozen and cannot use Retry; the host can keep an existing ready artifact or prepare the current collection.

Before committing, 0019 installs compatibility guards that reject a new queued entryless job and reject an export-entry insert whose exact tombstone is already suppressed. A queued-to-running transition verifies frozen count/bytes and each exact unsuppressed source hold, but does not consult the mutable live pointer. A terminal-to-queued Retry is stricter: in addition to that frozen proof, every current row must still be active or recoverable stored (`trashed_at IS NULL AND deleted_at IS NULL`, or `trashed_at IS NOT NULL AND deleted_at = trashed_at`) and point at the frozen exact key. Initial entry-backed queued creation remains compatible with the 0018 Worker's existing single D1 batch, which inserts the job before its entries: an invalid entry aborts that batch, and the running-transition guard is the final ownership boundary before any source read. The new Worker additionally uses the explicit creation sentinel above. Thus an old Worker serving during migration-first deployment may receive a constraint failure, but it cannot run or retry a job over unheld or removed bytes.

Every source-object retirement path—including direct deletion, canonical/legacy alias retirement, promotion cleanup, and tombstone classification—must pass through that suppression fence. A guarded D1 batch inventories every candidate tombstone and returns a typed `MediaObjectDeletionClaim` containing only the exact keys whose suppression transition won. `deleteMediaObjectAliases` accepts that claim rather than an arbitrary `MediaRecord` and deletes only its enumerated keys. Held tombstones remain unsuppressed and due for the existing janitor. This removes direct R2 deletion as a bypass and makes the source hold effective for every physical path.

Scheduled cleanup pages expired trash rows. For each row it attempts the guarded terminal transition. A source hold produces no state change and leaves the expired row visible as cleanup pending; Restore still refuses because the deadline passed. Once the exact job reaches `ready`, `failed`, or `expired`, the hold is released and a later pass may logically delete it and decrement recoverable capacity. Restore and cleanup use inverse compare-and-set predicates, so only one transition wins. The deletion/suppression batch then inventories aliases and returns only immediately safe R2 claims; the tombstone janitor owns eventual held-key deletion.

Retry of a failed or expired export is one D1 transaction: verify every frozen `(media_id, object_bucket_generation, object_key)` has a current active-or-recoverable stored row pointing at that exact unsuppressed source, increment the attempt, reset the existing terminal fields, and change the job to `queued`. Slice 3 extends this same transaction to reset its newly added progress/execution fields; Slice 1 does not name columns that 0019 has not created. A trashed row remains retryable while its exact bytes remain; new export creation still excludes it. Its final constraint-sentinel keeps non-null `attempt` only when every frozen entry has one exact current source match and the match count equals `media_count`; assigning `NULL` on mismatch aborts the batch. That queued state change atomically reacquires holds. A missing, permanently deleted, pointer-changed, or suppressed source leaves the job terminal and returns safe `EXPORT_SOURCE_REMOVED`; no R2 `HEAD` loop is added. The Workflow remains responsible for fail-closed physical reads under the hold. An active export accepted before trashing or guest deletion retains its exact bytes until it becomes terminal, even if that exceeds the ordinary recovery deadline.

Because 0019 itself stores/returns `EXPORT_SOURCE_REMOVED`, Slice 1 adds it to `ApiErrorCode`, the current safe export-failure projection/client classification, the existing export status copy, and `docs/operations.md`. It maps to the action of preparing the current collection and is never passed through from an arbitrary stored string. Slice 3 incorporates the already-public literal into its fuller progress/error allowlist rather than introducing it later.

Event purge ends restore eligibility at the approved purge time, but it does not race an in-flight R2 read/write. The purge fence may fail a still-queued attempt atomically. If an exact job is running, the existing purge workflow remains in its wait/retry phase and cannot enter R2 deletion; event deletion makes new claims/retries impossible, and the current owner reaches a fenced terminal state after its in-flight operation settles. Holds are never released merely by age.

After all queued/running jobs and exact holds are terminal, but before any event-prefix R2 deletion, purge performs a guarded D1 terminalization of every remaining recoverable row: change it to permanent deleted state, clear its trash pair, remove exact retained Album entry/cover markers under the current Album revision, advance that revision and Slice 5's pick generation where applicable, and decrement/zero recoverable count/bytes with an exact aggregate sentinel. Only a fresh post-transition check proving zero trash owners, zero recoverable counters, and zero active source holds permits the existing prefix-deletion phase. A lost cleanup/purge race retries from canonical state; it never bypasses the recoverable-owner suppression guard.

Ready export artifacts remain immutable and downloadable until their existing 24-hour expiry. Deleting a source cannot retract a ZIP already prepared; confirmation copy states that boundary.

## Album-link revocation

Stop sharing uses the existing share delete endpoint only after a focused confirmation states:

- future reads through the current URL and sessions stop working immediately, while an already-open page may retain photos it already loaded and loaded/downloaded copies cannot be recalled;
- the action cannot restore that credential;
- delivered originals, Album arrangement, and Guest-gallery publication remain unchanged.

Initial focus is **Keep sharing**; Escape/cancel sends no request and restores the invoking control. **Stop Album link** is an explicit nondefault button and double activation remains idempotent.

Success clears the credential from the UI, announces revocation, leaves Album in place, and focuses the replacement **Share Album link** action or, when unavailable, the sharing-section heading. A later share creates a new credential as it does today.

## Verification

- Worker exact-key/status/cache-header tests for Gallery, contributions, reservation/content/finalize/delete, Manager Preview, Manager preview images, and live Album projections; random/foreign/nonmember Manager image IDs have identical 403 bodies
- Caption matrix: `published`, `unpublished`, and `hidden`, each with Guest gallery on/off; Album membership stays constant in all six cases
- Fresh-D1 and upgraded-0018 migration tests for trash/deleted-marker invariants, management/purge-clamped restore deadline, near-deadline trash, recoverable counters/cap guards, recoverable-owner suppression guards, guarded restore for both a promoted canonical current key with suppressed legacy alias and a grandfathered still-legacy stored row, ordinary revival refusal, source-hold index/suppression trigger, all-or-nothing refusal while a job is running, queued/new entryless failure, entry-backed pre-suppressed failure, queued mismatch failure, and terminal entryless retry refusal
- Named-query inventory tests for every include/exclude path listed above
- Trash transition matrix: first/repeated trash, restore-before-expiry, restore-at/after-expiry, host trash versus guest permanent delete in both issue orders, restore versus guest delete/cleanup in both issue orders, event purge, active/recoverable counter transfers, and count/byte cap-minus-one/full trash-upload-restore cases
- Album-retention tests for trash → reorder/save → Restore, multiple unmaterialized tail picks → trash middle → reorder/save → Restore, expiry-under-export-hold → reorder/save with cleanup-pending marker, trashed cover retained/replaced, stale-save rejection after cleanup, active + retained trash picks + sections at `ALBUM_MAX_ENTRIES`, Start empty, and public/Preview omission
- Deterministic Worker/R2 barriers for queued → trash → claim, queued → guest delete → claim, queued/running promotion, suppression during a held read, expiry while running, terminal completion then next cleanup pass, failed/expired retry before cleanup, cleanup-before-retry, running delete, alias retirement, purge waiting on a run, and purge with retained trashed entry/cover before prefix deletion
- Post-0019/old-Worker rollback tests proving trashed rows stay absent from ordinary/byte reads and old deletion/promotion/tombstone cleanup cannot suppress their aliases
- UI tests proving no request precedes confirmation, **Keep photo** initial focus, Escape/cancel return focus, one destructive request, deterministic success focus/announcement, Undo, active versus expired-cleanup-pending rows, and next/previous/heading focus after Recently deleted restoration
- Deferred resource tests proving retryable panel failures preserve siblings/last value, noncritical auth/lifecycle failures escalate, stale event/filter completions are ignored, mutations invalidate only named owners, and Intake/Guest-gallery URLs never contain the other's filters/cursors
- Formatter tests under different process zones, DST boundaries, date-only stability, equal ranges, invalid input, semantic `<time>`, and exact `snapshotAt`/`restoreUntil`/`purgeAfter` sources
- Album-share confirmation, Cancel-first creation, immediate revocation, loaded-copy boundary, and replacement-action/heading success-focus regressions

## Non-goals

- Guest deletion recovery
- Frozen Album releases
- Removing a hidden photo from Album membership
- Cross-audience withdrawal orchestration
- Retaining an expired export's retry promise after its source was truthfully purged

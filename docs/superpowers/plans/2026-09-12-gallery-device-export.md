# Gallery device and selected archive export implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. The repository requires one fresh implementer and one independent reviewer per task. Do not stage or commit intermediate changes.

**Goal:** Let a host select photos across Library/Album pages, freeze the exact originals, and either share actual image files with the device or download a photo-only ZIP archive.

**Architecture:** Extend the authoritative export tables with a selection protocol. A dedicated repository owns selection snapshots and device progress; existing archive assembly consumes the frozen selection. A shared chooser replaces the action area in the existing export cards and receives selections from each Gallery surface.

**Tech Stack:** React, TypeScript, Hono, Cloudflare D1/R2/Workflows, Vitest Workers, Testing Library, Playwright.

**Spec:** [Gallery photo selection and export destinations](../specs/2026-09-12-photo-export-design.md).

## Global Constraints

- Originals remain private and manager-authorized. Guest/Album-link readers do not gain access to originals through this feature.
- `export_jobs` and `export_media_entries` remain the authoritative ownership model for accepted source snapshots. Exact bucket generation and object key matter, not just media ID.
- Queued/running jobs retain the database source hold and the current one-active-export-per-event constraint.
- Existing 50-item client and server limits remain on Album/publication editing operations. Export receives a separate request contract.
- Select all includes unloaded pages and preserves deselections as exclusions; show the exact frozen count before transfer.
- Each selectable tile is one named, keyboard-focusable toggle with pressed state; Enter and Space toggle it. Keep 44px minimum targets and restore focus when selection/export closes.
- The complete card still offers the full archive, including its separate Guestbook artifacts. Every device/cloud photo selection and selected archive is photo-only.
- The initial device batch policy is at most 20 photos and 40 MiB of original bytes, with at most two concurrent downloads.
- Do not label a native handoff as a confirmed Photos save. No format is silently converted or discarded.
- Google Photos and OneDrive are explicitly after September 18, 2026. This plan implements device sharing and selected ZIPs; direct provider delivery, OAuth configuration, and real transfer acceptance are a separate subsequent phase of the approved design.
- New selection admission stays closed by default until migration/Worker compatibility and destination acceptance are recorded. Physical iPhone Safari/Home Screen checks remain release gates; browser mocks do not satisfy them.
- Run only each task's named focused RED/GREEN checks. Do not repeat fresh successful checks as implementer, reviewer, and controller. No repository-wide gate, staging, commit, push, or deployment is authorized.

## File responsibilities and interfaces

| File | Responsibility |
| --- | --- |
| `shared/photo-exports.ts` | Request/source types, validation limits, public status/entry types, batching constants |
| `shared/contracts.ts`, `worker/db/types.ts`, `src/app/types.ts` | Distinguish complete/Album archive views from all export kinds and selection records |
| `migrations/0023_photo_export_selection.sql` | Forward schema, rebuilt constraints/guards, disabled admission, device delivery/read leases |
| `worker/db/photo-exports.ts` | Frozen selection admission, idempotency, confirmation, device progress, cancellation/deadlines, archive fallback |
| `worker/routes/photo-exports.ts` | Private manager API, bounded body handling, authenticated original reads |
| `worker/db/exports.ts`, `worker/workflows/export.ts`, `worker/routes/exports.ts` | Existing ZIP assembly, ownership and archive status/download support for selected photos |
| `worker/workflows/cleanup.ts`, `worker/app.ts` | Expired selection cleanup and route registration |
| `src/features/gallery/photo-export-selection.ts` | Explicit ID/all-results/exclusion state independent of editing limits |
| `src/features/gallery/photo-export-device.ts` | Bounded original File preparation, capability checks and release of references |
| `src/features/gallery/PhotoExportChooser.tsx` | Frozen confirmation, prepare/share, status and fallback UI |
| Existing Library, Album, export controls | Whole-tile selection and chooser placement using existing cards |
| `docs/releases/2026-09-12-photo-export-selection.md` | Migration caller inventory, disabled release state and external acceptance |

## Task 1: Forward schema and selection contracts

**Files:** Create `migrations/0023_photo_export_selection.sql`, `shared/photo-exports.ts`, `tests/worker/photo-export-schema.test.ts`, `tests/unit/photo-export-contract.test.ts`, and `docs/releases/2026-09-12-photo-export-selection.md`. Modify `shared/contracts.ts`, `worker/db/types.ts`, `src/app/types.ts`, and `worker/db/exports.ts` only where mapping/narrowed legacy listing requires the new fields. Make type-only replacements in `src/pages/ManagerPage.tsx:prepareExport` and `src/features/gallery/ManagerGalleryWorkspace.tsx:exports.onPrepare` to keep their existing create parameters limited to `LegacyArchiveExportKind`. Update `scripts/verify-fresh-d1.ts` and `tests/unit/verify-fresh-d1.test.ts` for this new terminal schema; the release verifier currently pins 22 migrations and exact table/trigger SQL.

**Interfaces produced:**

```ts
export type PhotoExportDestination = 'archive' | 'device' | 'google-photos' | 'onedrive';
export type PhotoExportSource =
  | { mode: 'ids'; scope: 'library' | 'album'; mediaIds: string[] }
  | { mode: 'all'; scope: 'library'; filter: { query?: string; favorites?: true; order: 'newest' | 'oldest' }; excludedMediaIds: string[] }
  | { mode: 'all'; scope: 'album'; excludedMediaIds: string[] };
export interface CreatePhotoExportRequest {
  version: 1;
  idempotencyKey: string;
  source: PhotoExportSource;
  destination: PhotoExportDestination;
}
export const PHOTO_EXPORT_MAX_IDS = 10_000;
export const PHOTO_EXPORT_BODY_MAX_BYTES = 1024 * 1024;
export const DEVICE_EXPORT_MAX_FILES = 20;
export const DEVICE_EXPORT_MAX_BYTES = 40 * 1024 * 1024;
export const DEVICE_EXPORT_CONCURRENCY = 2;
// Export the strict Zod schema as createPhotoExportSchema and a stable
// canonicalPhotoExportRequest(request): string, excluding idempotencyKey.
```

The canonical descriptor sorts ID/exclusion sets without changing Gallery/Album ordering; normalizes the already-supported Library query semantics; rejects extra fields, duplicate IDs, invalid UUIDs, empty explicit sets, more than 10,000 IDs and query strings over 120 code points. No destination becomes enabled merely because it is representable in this type.

Public `PhotoExportView` fields: `id`, `kind: 'selection'`, `destination`, `source`, `state`, `snapshotAt`, `createdAt`, `confirmedAt`, `completedAt`, `mediaCount`, `totalBytes`, `handedOffCount`, `unavailableCount`, `holdExpiresAt`, `absoluteExpiresAt`, `cancelRequested`, `errorCode`, `attempt`. No source keys, upload locations, credentials or principal IDs. `PhotoExportEntryView` has `mediaId`, `position`, `filename`, `mimeType`, `byteSize`, `state: 'pending' | 'prepared' | 'acknowledged' | 'failed' | 'unresolved'`. The entry URL is built from event/job/media IDs in the client, never projected from storage. `PhotoExportCapabilities` contains `enabled`, `destinations: Array<'archive' | 'device'>` and `activeJob: null | { id; kind; state; destination; mediaCount; totalBytes; ownedByCurrentPrincipal: boolean }` with those fields typed from the shared job unions/count types. Active legacy and selection jobs appear here; another principal receives only these operation facts, not its source descriptor.

- [x] Add contract and migration regressions, then run the named checks and record RED. Representative assertions:

```ts
expect(createPhotoExportSchema.safeParse({ version: 1, idempotencyKey: crypto.randomUUID(),
  destination: 'device', source: { mode: 'ids', scope: 'library', mediaIds: [id, id] } }).success).toBe(false);
expect((await db.prepare('SELECT enabled FROM photo_export_admission WHERE singleton = 1').first())?.enabled).toBe(0);
// Upgrade fixture: snapshot all export tables at migration 0022, apply 0023,
// then deep-compare complete/Album job, media, part and Guestbook rows.
```

- [x] Rebuild `export_jobs` to extend kind/state/protocol CHECKs, preserving every existing column, row, index and child inventory. D1 foreign keys remain enabled: copy child inventories to temporary tables before any parent-table replacement that could cascade; restore them with original foreign keys and indexes in the same migration. Restore all referencing triggers. Prove `PRAGMA foreign_key_check` is empty. Do not use `writable_schema`, historical migration edits, or assume `defer_foreign_keys` suppresses cascades. [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [x] Add `destination` defaulting to `archive`; `source_json`, `request_digest`, `idempotency_key`, `initiating_principal`, `confirmed_at`, `hold_expires_at`, `absolute_expires_at`, and `cancel_requested_at`. Store `source_json` as `JSON.stringify({ version: 1, source: request.source })`, with the public source projected from that envelope. Selection uses `selection-v1`; legacy complete/Album keeps its current protocol. All frozen identity fields are immutable. Selection has positive media count, no Album note JSON or Guestbook fields, and only photo inventory. Add `delivered`, `handed-off`, `cancelled` terminal states with destination-sensitive guards; cloud states remain unreachable through admission in this phase.
- [x] Add `photo_export_admission` singleton initialized `enabled = 0`, plus installed-worker identity and timestamp required before enabling. Require the existing export protocol admission to be open as well. Revoke new admission when closed; existing jobs retain safe completion/cancellation paths. Do not alter the installed release configuration.
- [x] Add `photo_export_deliveries` keyed by `(export_job_id, media_id)` with an FK to the frozen entry, `state` (pending/uploading/prepared/acknowledged/failed/unresolved), `attempt`, `prepared_at`, `acknowledged_at`, `failed_at`, `read_lease_token` and `read_lease_expires_at`. The cloud adapter fields are not needed in this phase. Lease and cancellation state must support a retired job remaining active only while existing reads drain.
- [x] Recreate these affected guards explicitly: `export_source_hold_tombstone_insert`, `export_source_hold_tombstone_suppress`, `export_media_entry_suppressed_source_insert`, `export_jobs_entryless_queued_insert`, `export_jobs_running_source_fence`, `export_jobs_retry_source_fence`, `export_jobs_progress_insert`, `export_jobs_progress_update`, `export_jobs_execution_insert`, `export_jobs_execution_update`, `export_jobs_protocol_admission_insert`, `export_jobs_protocol_admission_update`. Restore the three `export_protocol_admission_*` protection triggers when necessary during replacement. Preserve existing attempt-v2 behavior and the exact bucket/key hold join.
- [x] The selection protocol guards require positive intact inventory on queued-to-running and retry; destination-specific terminal progress; monotonically owned transitions; no downgrade to legacy/attempt-v2; no modifying frozen count, bytes, source or principal. Selection archive permits `ready`, device permits `handed-off`; neither can claim cloud delivery. Same-state cancellation retirement cannot reset progress or source identity.
- [x] Keep `ExportKind` inclusive of selection but introduce/use a narrow legacy archive-kind type for the existing create parameter and complete/Album latest-card views. `ExportRecord` can represent every kind/state. `ExportsRepository.listLatestForManager` must exclude selection jobs while active-conflict lookup continues to see them. Avoid widening the old create route.
- [x] Update the existing fresh-D1 verifier to exactly 23 migrations, the changed export table columns/CHECKs/indexes and trigger digests, plus the new admission/delivery constraints. Capture fixture SQL/rows from the actual migrated local D1 in the focused schema lane, rather than copying verifier constants into its own tests. Preserve checks for unrelated tables and triggers; never bypass the verifier or drop assertions just to admit the new migration. Use existing `migrationsUpTo('0023')` (exclusive), `migrationOnly('0023')`, `applyD1Migrations` and `reset` helpers for upgrade fixtures. Then run GREEN, record the affected schema/caller inventory and a disabled release checklist. Include the old Worker fixture from `tests/worker/fixtures/export-worker-0019.ts` where applicable and prove old complete/Album inserts remain valid while selection admission is closed.

**Focused checks:**

```powershell
npx vitest run --config vitest.config.ts tests/unit/photo-export-contract.test.ts tests/unit/verify-fresh-d1.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/photo-export-schema.test.ts
```

## Task 2: Atomic snapshot and device job ownership

**Files:** Create `worker/db/photo-exports.ts` and `tests/worker/photo-export-snapshot.test.ts`. Modify `shared/photo-exports.ts` only to complete the public types above; update release notes with source/admission evidence. SQL corrections belong to the original Task 1 implementer if a Critical/Important schema defect is found.

**Interfaces produced:** `PhotoExportsRepository(db)` with the following public methods; input timestamps are ISO strings and default to current time only at the route boundary:

```ts
capabilities(eventId: string, principal: string): Promise<PhotoExportCapabilities>;
create(input: { eventId: string; principal: string; request: CreatePhotoExportRequest; now: string }): Promise<PhotoExportView>;
get(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView>;
listEntries(eventId: string, jobId: string, principal: string, after: number, limit: number, now: string): Promise<{ entries: PhotoExportEntryView[]; nextPosition: number | null }>;
confirm(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView>;
cancel(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView>;
retryArchive(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView>;
recordHandoff(eventId: string, jobId: string, principal: string, mediaIds: string[], now: string): Promise<PhotoExportView>;
expireActive(now: string, limit: number): Promise<number>;
```

Also export `PhotoExportReadLease` containing job/event/media identity, attempt/owner token, original bucket/key/filename/type/size and lease deadline, with repository `claimRead(eventId: string, jobId: string, mediaId: string, principal: string, now: string): Promise<PhotoExportReadLease>`, `assertReadActive(lease: PhotoExportReadLease, now: string): Promise<boolean>`, and `releaseRead(lease: PhotoExportReadLease, outcome: 'prepared' | 'failed', now: string): Promise<void>` methods. Lease values stay server-side. `prepareArchiveFallback(eventId, jobId, principal, idempotencyKey, now)` creates a queued archive job from exactly the old frozen entries, after retiring/draining the device owner, and returns its view. No re-evaluation of an all-results filter.

- [x] Write the controlled snapshot and ownership tests and observe RED. Use the existing worker test helpers for canonical originals, tombstones, manager event access, Album entries and D1 state. A SQL binding recorder should fail a prepared statement using more than 100 bindings; the 10,000-ID request uses one JSON array binding.

```ts
const job = await repository.create({ eventId, principal, now, request: allLibrary });
await addAnotherEligiblePhoto();
expect((await repository.listEntries(eventId, job.id, principal, 0, 100, now)).entries.map(e => e.mediaId))
  .toEqual(originalIdsInGalleryOrder);
const same = await repository.create({ eventId, principal, now, request: allLibrary });
expect(same.id).toBe(job.id);
await expect(repository.create({ eventId, principal, now, request: { ...allLibrary, destination: 'archive' } }))
  .rejects.toMatchObject({ status: 409 });
```

- [x] Build validated descriptor predicates using existing Gallery literal-search/favorites semantics (`worker/routes/manage.ts`, `worker/db/media.ts`) and Album current photo ordering (`worker/db/album.ts`). Bind ID and exclusion JSON once with `json_each`. For all-results sources, use `INSERT ... SELECT`; never fetch every client page to decide membership. Store a stable per-entry position using the actual Gallery or Album order.
- [x] In one D1 batch, validate admission/event access window, insert the job with SQL-derived count/bytes, insert the exact source inventory, add pending delivery rows for device jobs and enforce a set/count/byte sentinel. Model the sentinel on `creationSentinel` in `worker/db/exports.ts`. Explicit selections must match every requested eligible ID within the requested scope; generic source-changed response on any omission, cross-event ID, suppression or invalid source. Reject zero photos and more than 10,000. Do not expose other events' inventory in diagnostics.
- [x] Use `(event_id, initiating_principal, idempotency_key)` uniqueness and the canonical digest. Exact replay returns the same snapshot; altered request returns 409. Account principal is `account:<accountId>`; a link principal is `link:<sessionId>` from existing manager authorization. No principal can consume another principal's device job or grant.
- [x] Bound unconfirmed holds to 30 minutes, device confirmed idle to 30 minutes and absolute lifetime to 24 hours, all clamped to event management expiry and purge. Cloud destinations are refused as unavailable. Selection archive confirmed execution has a 24-hour bound per attempt in this phase; freeze its absolute deadline at the initial management/purge ceiling, then bound each attempt hold beneath it. Only an explicit retry can establish a new bounded attempt after reacquiring the exact inventory; it clears prior confirmation/retirement and resets to the fresh 30-minute unconfirmed hold. Device absolute lifetime is not renewed by progress or retry. Artifact expiry remains separate.
- [x] Confirmation is idempotent. Device confirmation claims its selection-v1 owner. Archive confirmation marks it dispatchable; only the archive Workflow claims execution. Each read/ack checks active owner, destination, confirmation, current event authority and deadlines. A successful native handoff ACK updates each entry exactly once and counts only its original bytes; it is a reported handoff, not proof of a save. Do not clear failed/remaining entries silently. `retryArchive` accepts only failed/expired archive selections, reacquires exactly the old eligible/unsuppressed inventory atomically, retires the old attempt, and clears confirmation so delivery cannot restart without a fresh host action.
- [x] A read lease is at most two minutes and at most two reads per device job. Cancellation first sets a retirement marker so no new reads/acks can start. Keep the source hold while an unexpired acquired read is draining; finalize cancelled/expired after leases release or expire. Expired callbacks cannot restart the job or publish prepared progress. Refresh the inactivity deadline only on authenticated useful progress, bounded by absolute/event deadlines.
- [x] Archive fallback is an explicit action. Atomically retire the old job and clone its exact held inventory to a new archive job, with idempotency and one-active-job enforcement; if a read is draining return recoverable busy instead. Do not create a gap in the hold or silently retry an unavailable source. Preserve earlier handoff counts on the original receipt.
- [x] Run GREEN for admission/suppression in both serialization orders, snapshot versus later filter/Album changes, 10,000 IDs, duplicate/cross-event IDs, one active operation, deadline clamp, cancel/read race, duplicate ACK, old callbacks and failed hold reacquisition. Tests should prove observable invariants, not each SQL line.

**Focused check:**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/photo-export-snapshot.test.ts
```

## Task 3: Private routes, selected archives and cleanup

**Files:** Create `worker/routes/photo-exports.ts`, `tests/worker/photo-export-api.test.ts`, `tests/worker/photo-export-archive.test.ts`. Modify `worker/app.ts`, `worker/db/exports.ts`, `worker/routes/exports.ts`, `worker/workflows/export.ts`, `worker/workflows/cleanup.ts`, `src/app/types.ts`, and `shared/photo-exports.ts` for the active-conflict response type, plus the release note. Preserve unrelated exports/cleanup behavior.

**Routes produced:** Under `/api/manage/events/:eventId/photo-exports`: `GET /capabilities`, `POST /`, `GET /:jobId`, `GET /:jobId/entries?after=<position>`, `POST /:jobId/confirm`, `POST /:jobId/cancel`, `POST /:jobId/retry` for failed/expired selection archives, `POST /:jobId/handoff` with `{ mediaIds }`, `POST /:jobId/archive` with `{ idempotencyKey }`, and `GET /:jobId/entries/:mediaId/file`. All JSON uses the private manager envelope. Existing archive download route handles ready selection archives and rejects device/cloud jobs. Active-operation conflicts use HTTP 409 with `data: { kind: 'active-export-conflict', activeJob }` containing only the minimal non-null capability projection; read it with the existing `apiEnvelope` client. Keep RSVP `ApiErrorDetails` unchanged. If the active operation has already settled, retain the controlled ordinary error.

- [x] Add API/assembly regressions and observe RED. Authorize with actual existing manager test cookies; prove guest and Album-link access cannot read originals, bad origin/CSRF is rejected before body reads, private/cache headers remain and oversized bodies return a controlled validation error.
- [x] Authenticate `requireManager` before buffering each write body. Use the existing bounded reader pattern or a local streaming reader that stops above 1 MiB even without Content-Length. The handoff limit is 20 distinct IDs, not 10,000; reject malformed, duplicate and out-of-job IDs. Return active-operation identity/count/destination on conflict without another principal's source descriptor or credentials.
- [x] GET file acquires a repository read lease, resolves the exact canonical/legacy bucket from that lease, and returns original bytes with matching content type and a safe original filename. It must be same-origin/private/no-store; no R2 URL is returned. Check declared/actual length and existing supported original MIME types; do not convert. Lease-aware streaming checks retirement before another source pull and releases the lease on completion, cancellation or failure; bound the stream to the original file ceiling and the lease deadline. A late completion cannot mark a retired job prepared. An interrupted client must not retain the hold indefinitely.
- [x] Confirmed archive dispatch reuses the deterministic existing Workflow instance convention and observes ambiguous creation before declaring failure. Selection archives use the selection-v1 owner and per-entry order. Update `claimRunning`, active checks, progress, `markReady`, owned failure and expiry to handle that protocol without weakening attempt-v2. Reject accidental device jobs at the archive processor entrance. Check hold/event deadlines before each part/source chunk just as ownership is checked.
- [x] Photo-only manifest/ZIP preserves original metadata and selection order. Treat selection separately from the complete legacy-format fallback: no Guestbook lookup, HTML, CSV or association may appear. Existing complete/Album artifacts and retry guards retain their behavior. Selection retry uses `retryArchive`, reuses exact frozen inventory with a new owner after source reacquisition, and returns to unconfirmed queued state for a fresh count/bytes confirmation; the old `/exports` create/retry route cannot bypass selection confirmation or deadlines.
- [x] Call bounded `expireActive` from existing scheduled export cleanup before physical deletion work. Expired/cancelled owners cannot make more source reads, write progress or retain an active slot after draining. Preserve original deletion through `claimMediaObjectDeletion`; do not add direct source `R2.delete` calls.
- [x] Run GREEN for private file bytes, cancel/deadline fences, selected ZIP names/order and absent Guestbook, legacy complete/Album outputs, retry, cleanup and undispatched/ambiguous Workflow handling. Include existing ownership lanes below once after integration because they cover code amended by this task.

**Focused checks:**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/photo-export-api.test.ts tests/worker/photo-export-archive.test.ts tests/worker/export-workflow-ownership.test.ts tests/worker/export-cleanup-ownership.test.ts
```

## Task 4: Whole-tile selection and shared device chooser

**Files:** Create `src/features/gallery/photo-export-selection.ts`, `src/features/gallery/photo-export-device.ts`, `src/features/gallery/PhotoExportChooser.tsx`, `tests/unit/photo-export-selection.test.ts`, `tests/unit/photo-export-device.test.ts`, `tests/ui/photo-export-chooser.test.tsx`. Modify `ManagerPrivateGallery.tsx`, `ManagerAlbum.tsx`, `ManagerGalleryWorkspace.tsx`, `GalleryExportControl.tsx`, `AlbumExportControl.tsx`, `SelectionTray.tsx`, and their relevant stylesheet under the existing gallery CSS. Add targeted assertions in `tests/ui/host-private-gallery.test.tsx` and `tests/ui/album-workspace.test.tsx` using titles prefixed `photo export`.

**Interfaces consumed:** Task 1 source/view constants and Task 3 routes. `PhotoExportChooser` receives `eventId`, `source`, `onClose`, `onJobChanged` and optional `onPrepareFullArchive`; the latter preserves the existing complete/Album archive action and receipt. The workspace owns one chooser target at a time, including a focus origin. Cards accept an optional replacement action area so old direct callers still work.

- [x] Add selection/batching/UI regressions and observe RED. Core selection tests:

```ts
const all = selectAll({ scope: 'library', filter: { order: 'oldest', query: 'dance' } });
const next = togglePhoto(all, '11111111-1111-4111-8111-111111111111');
expect(toPhotoExportSource(next)).toEqual({ mode: 'all', scope: 'library',
  filter: { order: 'oldest', query: 'dance' }, excludedMediaIds: ['11111111-1111-4111-8111-111111111111'] });
expect(isPhotoSelected(next, '22222222-2222-4222-8222-222222222222')).toBe(true);
```

- [x] Introduce explicit IDs versus descriptor/exclusions selection, with a 10,000-photo export ceiling. Keep existing editing reducer/cap authoritative for editing writes: selections over 50 or descriptor selections disable Pick/Remove editing actions with a concise explanation. Do not slice to 50 silently. Shared publication checkboxes remain unchanged. A filter/scope change clears the old selection, so the label never describes a different source.
- [x] Library uses its existing whole-tile pressed button. Album adds a covering pressed button in Select mode; suppress viewer/reorder/edit controls for that photo while selecting, avoid nested buttons, and leave sections/notes unselectable. Add Select, Select all, clear and Save / Share photos controls using existing tokens/44px targets. All-results count is stated as all matching photos until the server returns an exact frozen count; never present the loaded-page length as the total.
- [x] Keep the current Library and Album export cards. Replace each card's prepare/download action area with the shared chooser entry while retaining its existing progress/receipt and complete/Album archive access. The selected toolbar opens the chooser attached to that existing card, not a third card. Restore connected origin focus when closed; use Select control/card action as fallback after rerender.
- [x] Read capabilities and enable the new entry points only when server admission is available. If a current-principal selection job is active, offer Resume or Cancel at the existing card so reloading cannot strand the host behind the active-job slot. An operation owned by another principal displays its type/state and explains that it must finish or expire. Show device and ZIP choices; direct Google/OneDrive controls are absent until their later implementation and acceptance. Avoid changing marketing copy to promise unverified platforms. A capability fetch failure leaves the existing complete/Album archive available with an actionable error if selection export is attempted.
- [x] Preparing a destination freezes the source first, then displays snapshot time, exact count and bytes for explicit confirmation. Do not call a native share in the same async preparation handler. Device confirmation prepares the next batch and renders a fresh `Share N photos` button.
- [x] `prepareDeviceBatch(entries, readFile, signal, limits?)` returns Files plus prepared/failed IDs, never URLs or Guestbook data. Select at most 20/40 MiB, fetch at most two concurrently, check actual byte sizes/type, retain unavailable entries, and expose a smaller-batch retry. No all-selection fetch/prefetch. Abort stale preparation on job/scope change/unmount and release old File references when advancing.
- [x] The share button synchronously calls `navigator.share({ files })` from the click gesture after `navigator.canShare({ files })`. AbortError retains files and selection without sending an ACK. Successful resolution sends handoff ACK once; network uncertainty while ACKing is retried idempotently without launching the share sheet again. Other rejection keeps the batch and offers a smaller retry or explicit ZIP fallback. Do not count an unsupported/skipped file as handed off.
- [x] Display prepared, handed off, remaining and unavailable counts separately; keep event/job expiry and interruption errors recoverable. Native copy says `Handed to your device` and explains `Save Images` when offered, then add to a new/existing personal album in Photos. iCloud sync is conditional on the user's Photos settings; never show an in-browser Apple album picker or save/sync success claim.
- [x] ZIP fallback calls the exact-snapshot archive action, then explicit confirmation, and uses existing private artifact links. Keep acknowledged prior device handoffs visible and explain that the ZIP includes the complete frozen selection. Avoid duplicate automatic reshares after a remount.
- [x] Run GREEN once for these named checks. Do not run entire Gallery suites for unrelated UI; use the title prefix on existing files.

**Focused checks:**

```powershell
npx vitest run --config vitest.config.ts tests/unit/photo-export-selection.test.ts tests/unit/photo-export-device.test.ts tests/ui/photo-export-chooser.test.tsx
npx vitest run --config vitest.config.ts tests/ui/host-private-gallery.test.tsx tests/ui/album-workspace.test.tsx --testNamePattern "photo export"
```

## Task 5: Rendered export evidence and release record

**Files:** Create `tests/e2e/photo-export.spec.ts`. Modify only the approved export release record and plan checkboxes for results. Fixes to earlier code return to its original implementer with scoped re-review.

- [x] Add focused browser tests with fictional routes returning more matching source entries than loaded thumbnails. For both Library and Album, click a tile's center away from its corner mark, then toggle with keyboard and assert one selection change/no viewer. Use 320x568, 390x844 and 1440x1000 viewports. Assert no horizontal overflow, 44px action targets, reachable actions and focus restoration.
- [x] Stub native file sharing at the browser boundary only and inspect actual File names/types/bytes passed from private route fixtures. Verify Prepare and Share are separate user gestures, a cancelled share keeps the current batch, multiple batches keep Select all, failed files remain counted and full archive/selected photo-only choices remain distinct.
- [x] Verify the chooser is inside the existing card, no duplicate export region is introduced, and a disabled capability leaves legacy complete/Album archives usable. No production CSP changes or discovery-only CSP bypasses.
- [x] Run the focused command. The existing Playwright web-server build is a required prerequisite, not authorization for unrelated test gates. Type/build failures affecting this feature must be fixed; report unrelated baseline failures without claiming a green browser lane.

```powershell
npx playwright test tests/e2e/photo-export.spec.ts --project=desktop --project=mobile
```

- [x] Inspect screenshots from the named cases, run `git diff --check`, and record commit baseline/worktree/status plus exact commands/results. No repeat union runs after unchanged successful checks.
- [x] Finish with one independent whole-change review using existing evidence. Approved with no Critical or Important findings.
- [x] Release record must retain unchecked physical-iPhone tests: Safari and Home Screen mixed JPEG/PNG/WebP/HEIC/HEIF, Save Images, cancellation/return, real new/existing Photos album route, and batch memory behavior. No physical device is available in this Windows task. Selection admission and device claims remain disabled for production until those checks and the migration/Worker procedure are accepted. Direct provider OAuth/configuration/quota/transfer work stays in the subsequent cloud phase of the approved design.

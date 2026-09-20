# Consolidated Host Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Library the host's complete workspace for delivered originals, with deliberate live-arrival updates, viewer file actions, and integrated Trash and uploads.

**Architecture:** Retain the Photo Wall and existing manager-owned mutation, upload, Undo, and resource ownership mechanisms. Add a server-assigned delivery sequence for reliable arrival counts and a paginated Library delivery snapshot; replace Library remount invalidation with scoped reconciliation. Consolidate navigation after those behaviors work.

**Tech Stack:** Existing React, TypeScript, Vite, Hono, Cloudflare Workers/D1, Vitest, Testing Library, and Playwright dependencies. No dependency or platform upgrades.

**Spec:** [Approved design](../specs/2026-09-14-consolidated-library-design.md).

## Global Constraints

- Gallery becomes the default photo entry point and opens Library.
- Keep the three Gallery modes: **Library**, **Album**, **Guest gallery**.
- Trash is a Library utility, not a fourth Gallery mode.
- Show an **N new photos** control and keep the current grid steady.
- Keep **Add to album / In album** as the visible tile action; put individual file actions in the viewer.
- Keep publication badges and publication controls in Guest gallery.
- Preserve the approved Photo Wall and existing manager visual tokens.
- Interactive targets must be at least 44 × 44 CSS pixels; retain existing 48-pixel form controls.
- At 320 × 568, photos must appear in the opening viewport.
- Preserve pagination through the existing 10,000-photo limit, 20 MiB per-image limit, and 100 GiB event storage limit. Do not change upload or recovery policies.
- Preserve manager ownership checks, event-generation fences, dirty-editor leave guards, exact server recovery deadlines, and Undo semantics.
- Apply the Impeccable craft floor immediately before UI edits during execution; planning does not change surface contracts or `DESIGN.md`.

## Execution and evidence boundaries

This document plans implementation; it does not authorize publication. Execute against the approved design and the repository's `AGENTS.md`.

- Capture the current branch, HEAD, and dirty paths before execution. Planning baseline: `3408317ca81e3bb12d5c40af502cc636749d8c0c`.
- Preserve the pre-existing tracked critique edit and all untracked work. Use an explicit file allowlist; no broad staging, cleaning, or resetting.
- If using subagents, use one fresh implementer and one fresh independent reviewer per task. Do not duplicate the same successful focused run as controller evidence.
- Advance when review has no Critical or Important findings. Record Minor notes without another fix/review cycle.
- Run only the named focused commands below. No repository-wide test, lint, build, or release gates unless the user requests them.
- Do not stage or commit between tasks. If execution includes authorization to commit, make one scoped commit after the four tasks and their checks pass. Push, PR, merge, deployment, and cleanup remain separate actions.
- Record command, result, relevant invariant, and open findings. Do not expand this into an exhaustive evidence matrix.

## File responsibilities

| Files | Responsibility |
| --- | --- |
| `migrations/0025_library_delivery_sequence.sql` (new) | Assign a persistent delivery sequence exactly once, including a populated-database backfill. |
| `shared/library-arrivals.ts` (new) | Shared response and query/cursor contracts for opted-in Library reads. |
| `worker/http/gallery-cursor.ts`, `worker/db/media.ts`, `worker/routes/manage.ts` | Validate scoped snapshot cursors; list and count delivered media using the existing Library predicates. |
| `src/features/gallery/library-arrivals.ts` (new) | Timeline-key comparison and cancellable, bounded reconciliation of the loaded Library window. |
| `src/features/gallery/use-library-arrivals.ts` (new) | Visibility-aware polling and retained arrival-summary state. |
| `src/features/gallery/ManagerPrivateGallery.tsx`, `ManagerGalleryWorkspace.tsx` | Adopt arrivals deliberately; preserve browsing state; pass file operations and navigation. |
| `src/features/gallery/library-file-actions.ts` (new) | Typed boundary between manager-owned file mutations and the viewer. |
| `src/features/gallery/GalleryViewer.tsx`, `ManagerLibraryTrash.tsx` (new) | Viewer file-action confirmation and the existing recovery-list presentation. |
| `src/pages/ManagerPage.tsx` | Retain mutation/Undo ownership, integrate Trash, remove the obsolete active Intake collection and polling. |
| `src/app/manager-location.ts`, `manager-history-state.ts` | Default destination, legacy URL aliases, Trash view, and compatible recovery intents. |
| `src/features/uploads/ManagerUploadDialog.tsx`, `GuestUploadFlow.tsx`, `manager-upload-dialog.css` (new) | Manager upload presentation, manager-only copy, and delivery reconciliation. |
| `src/features/gallery/library-photo-wall.css`, `src/styles.css` | Small Library/viewer/layout changes and removal of exclusively obsolete Intake rules. |
| Task-specific tests listed below | Focused behavior checks; existing fixture adaptations stay with the behavior that changes. |
| `playwright.library.config.ts`, `vite.library.config.ts` (new) | Source-only frontend server for the named browser acceptance tests, without a repository-wide build. |

Do not broadly restructure `ManagerPage.tsx`, replace the upload engine, or alter Album organization. Extract the Trash presentation because it is moving to a different surface; keep event writes and cross-resource invalidation in their existing manager owner.

## Technical contracts

### Delivery identity and API compatibility

An event's `storedMediaCount` decreases on trash and increases on restore. It cannot identify arrivals. `stored_at` alone also cannot distinguish concurrent deliveries with equal timestamps or a delayed finalization. Assign `events.last_delivery_sequence` monotonically and stamp `media.delivery_sequence` on its first stored transition.

The delivery snapshot freezes admission of later deliveries, not all mutable metadata. Confirmed local album, trash, and restore operations still reconcile through their existing owners.

Keep the existing `/api/manage/events/:eventId/gallery` behavior for callers without `live=1`, including v1/v2 cursor compatibility. Opted-in requests use:

```ts
// shared/library-arrivals.ts
import type { ManagerGalleryMediaView } from './contracts';
import type { GalleryTimelineOrder } from './constants';

export interface LibraryQuery {
  query: string; // Trimmed; empty means all. Existing 120-code-point limit.
  favorites: boolean;
  order: GalleryTimelineOrder;
}
export interface LibraryPage {
  media: ManagerGalleryMediaView[];
  nextCursor: string | null;
  snapshotSequence: number;
}
export interface LibraryArrivalSummary {
  afterSequence: number;
  snapshotSequence: number;
  count: number;
}
export interface LibraryCursorV3 extends LibraryQuery {
  v: 3;
  eventId: string;
  snapshotSequence: number;
  timelineAt: string;
  id: string;
}
```

- First read: `/gallery?live=1&order=newest`, with the existing optional `query` and `favorites=1`. Capture the current event sequence **before** listing and exclude media above it.
- Continuation: same query and `live=1&cursor=...`; the v3 cursor carries the event, filter, ordering, accepted sequence, and timeline key. Reject scope mismatches.
- Accepted refresh: same query and `live=1&snapshot=<observed sequence>`, followed by v3 continuations.
- Poll: `/gallery/arrivals?after=<accepted sequence>` plus the same query/filter/order. Capture sequence B, then count active stored rows whose sequence is in `(after, B]`. Return B even when count is zero.
- Sequences are nonnegative safe integers. Reject malformed values, a future sequence, incompatible cursor parameters, and invalid `live` values with the existing 422 validation response. Authentication and private response headers are unchanged.
- Listing still returns at most `PRIVATE_GALLERY_PAGE_SIZE` (48) rows. Arrival polling returns a count, not photo pages or IDs.
- Search is the existing literal, case-insensitive contributor/caption/filename search; reuse its SQL predicates for both listing and counting.

### Library mutation and file-action boundaries

```ts
// src/features/gallery/library-file-actions.ts
import type {
  ManagerGalleryMediaView, ManagerTrashedMediaView,
} from '../../../shared/contracts';

export interface LibraryChange {
  version: number;
  eventId: string;
  kind: 'delivered' | 'trashed' | 'restored' | 'metadata';
  mediaIds: readonly string[];
}
export type TrashOutcome =
  | { status: 'trashed'; media: ManagerTrashedMediaView }
  | { status: 'retired' };
export interface LibraryFileActions {
  canTrash: boolean;
  trash(
    photo: ManagerGalleryMediaView,
    activation: 'keyboard' | 'pointer',
  ): Promise<TrashOutcome>;
}
```

`ManagerPage` produces these operations/signals; Workspace forwards them; Library reconciles them. `retired` means the event owner changed or the operation was not started. It must never be presented as success. Existing API failures remain failures and use the existing manager error/escalation path.

## Task 1: Authoritative arrivals and paginated delivery snapshots

**Files**

- Create: `migrations/0025_library_delivery_sequence.sql`, `shared/library-arrivals.ts`, `tests/worker/migration-0025.test.ts`.
- Modify: `worker/http/gallery-cursor.ts`, `worker/db/media.ts`, `worker/routes/manage.ts`.
- Test/extend: `tests/worker/host-private-gallery-api.test.ts`, `tests/worker/host-private-gallery-scale.test.ts`.

**Interfaces**

- Consume: existing `MediaRepository.listGalleryTimeline`, `managerForEvent`, gallery search/order/limit validators, `managerGalleryMediaView`, and v1/v2 cursor functions.
- Produce: the shared interfaces and API grammar above; add `encodeLibraryCursor(cursor: LibraryCursorV3): string` and `decodeLibraryCursor(value: string, eventId: string, query: LibraryQuery): LibraryCursorV3` without widening the legacy decoder.
- Extend `listGalleryTimeline` options with optional `snapshotSequence: number`; add `currentDeliverySequence(eventId: string): Promise<number>` and `countLibraryArrivals(eventId: string, query: LibraryQuery, after: number, through: number): Promise<number>`.

- [x] **Write migration and API RED cases.** In the existing API test file, reuse its `eventAccess`, `seedStored`, and `gallery` helpers. Add this same-timestamp case before implementing the API:

```ts
it('counts a later delivery despite identical stored timestamps', async () => {
  const access = await eventAccess();
  await seedStored(access, 1);
  const first = await (await gallery(access, '?live=1')).json<any>();
  expect(first.data.snapshotSequence).toEqual(expect.any(Number));
  const laterId = await seedStored(access, 2, {
    timelineAt: '2026-09-18T10:00:00.000Z', // Older capture, later delivery.
  });
  const response = await createApp().request(
    `/api/manage/events/${access.event.id}/gallery/arrivals?after=${first.data.snapshotSequence}`,
    { headers: { cookie: access.manager.cookie } }, testEnv,
  );
  expect(response.status).toBe(200);
  expect((await response.json<any>()).data.count).toBe(1);
  const frozen = await (await gallery(access,
    `?live=1&snapshot=${first.data.snapshotSequence}`)).json<any>();
  expect(frozen.data.media.map((row: { id: string }) => row.id)).not.toContain(laterId);
});
```

Add cases for one deletion plus one delivery with unchanged total count; restoration of a pre-baseline photo; finalization retry; a pending reservation finalized after the baseline; matching/nonmatching search and In album; no arrivals; new arrivals during continuation; event/query/order cursor mismatch; guest/foreign-manager denial; malformed/future sequences; and legacy cursor behavior. Assert the count and snapshot contents, not only response status.

For migration backfill, use `migrationsUpTo('0025')`, `migrationOnly('0025')`, `reset`, and `applyD1Migrations` from the existing worker test patterns. Initially create 0025 with only its descriptive SQL comment so migration discovery succeeds and the new-column assertions supply the RED failure. Seed active, trashed, permanently deleted, and reserved rows before applying 0025. Assert unique assigned sequences for prior delivered rows, null for reservations, the next delivery greater than the backfill maximum, unchanged recovery markers, and unchanged capacity counters.

- [x] **Run the focused RED command.** Expect missing snapshot/arrival behavior and migration assertions to fail; do not accept fixture/setup errors as RED evidence.

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0025.test.ts tests/worker/host-private-gallery-api.test.ts tests/worker/host-private-gallery-scale.test.ts
```

- [x] **Implement the additive migration.** Backfill before installing triggers. Use an event-partitioned row number ordered by `COALESCE(stored_at, created_at), id` for rows with a stored timestamp or stored state; this includes recoverable old deliveries. Set each event counter to its maximum assigned sequence. Add a unique partial index on `(event_id, delivery_sequence)` where the sequence is non-null.

```sql
ALTER TABLE events ADD COLUMN last_delivery_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (last_delivery_sequence >= 0);
ALTER TABLE media ADD COLUMN delivery_sequence INTEGER
  CHECK (delivery_sequence IS NULL OR delivery_sequence > 0);

WITH delivered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY event_id ORDER BY COALESCE(stored_at, created_at), id
  ) AS sequence
  FROM media WHERE stored_at IS NOT NULL OR upload_state = 'stored'
)
UPDATE media SET delivery_sequence = (
  SELECT sequence FROM delivered WHERE delivered.id = media.id
) WHERE id IN (SELECT id FROM delivered);

UPDATE events SET last_delivery_sequence = COALESCE((
  SELECT MAX(delivery_sequence) FROM media WHERE media.event_id = events.id
), 0);

CREATE UNIQUE INDEX media_event_delivery_sequence
ON media(event_id, delivery_sequence) WHERE delivery_sequence IS NOT NULL;

CREATE TRIGGER media_delivery_sequence_insert
AFTER INSERT ON media
WHEN NEW.upload_state = 'stored' AND NEW.delivery_sequence IS NULL
BEGIN
  UPDATE events SET last_delivery_sequence = last_delivery_sequence + 1
  WHERE id = NEW.event_id;
  UPDATE media SET delivery_sequence = (
    SELECT last_delivery_sequence FROM events WHERE id = NEW.event_id
  ) WHERE id = NEW.id;
END;

CREATE TRIGGER media_delivery_sequence_stored
AFTER UPDATE OF upload_state ON media
WHEN NEW.upload_state = 'stored' AND NEW.delivery_sequence IS NULL
BEGIN
  UPDATE events SET last_delivery_sequence = last_delivery_sequence + 1
  WHERE id = NEW.event_id;
  UPDATE media SET delivery_sequence = (
    SELECT last_delivery_sequence FROM events WHERE id = NEW.event_id
  ) WHERE id = NEW.id;
END;
```

Use these triggers for all existing finalization paths; do not add counter updates to each upload handler. Restore changes recovery markers and retains the existing sequence. Neither trash nor permanent cleanup decrements the event sequence. No public write accepts a sequence. Read the marker after committed writes; do not expect an `UPDATE ... RETURNING` row to include changes made by an AFTER trigger.

- [x] **Implement validated read contracts.** Keep legacy requests unchanged. For opted-in reads append `delivery_sequence <= ?` to the existing active-media predicates; for counts append `delivery_sequence > ? AND delivery_sequence <= ?`. The first captured marker is reused throughout that read's pages. Parse v3 cursors with a strict schema and compare their normalized query, event, favorites, and order with the request before using their key. Preserve the existing sentinel-state rejection and private API response policy.

```ts
const through = requestedSnapshot ?? await mediaRepository.currentDeliverySequence(eventId);
const page = await mediaRepository.listGalleryTimeline(eventId, {
  query: normalized.query || undefined,
  favorites: normalized.favorites,
  order: normalized.order,
  limit: limit.data,
  cursor: decodedCursor,
  snapshotSequence: through,
});
// The opted-in response includes through as snapshotSequence. Legacy callers
// continue to receive their existing shape and v1/v2 continuation contract.
```

- [x] **Run the focused GREEN command above and the upload/recovery integration checks once.** The latter protect counter/finalization behavior touched by the triggers:

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/manager-upload-api.test.ts tests/worker/manager-upload-actor.test.ts tests/worker/media-recovery-api.test.ts
```

In the scale test, seed the existing 10,000-photo fixture, verify a 48-row first page and stable continuations, and verify arrivals return an exact scalar count without returning the collection. No remote migration or deployment occurs in this task.

## Task 2: Stable Library updates and scoped reconciliation

**Files**

- Create: `src/features/gallery/library-arrivals.ts`, `src/features/gallery/use-library-arrivals.ts`, `src/features/gallery/library-file-actions.ts`, `tests/unit/library-arrivals.test.ts`, `tests/ui/library-arrivals.test.tsx`.
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx`, `ManagerGalleryWorkspace.tsx`, `library-photo-wall.css`, `src/pages/ManagerPage.tsx` (invalidation boundary only).
- Test/extend: `tests/ui/host-private-gallery.test.tsx`, `tests/ui/gallery-hardening.test.tsx`.

**Interfaces**

- Consume: `LibraryPage`, `LibraryArrivalSummary`, `LibraryQuery`, existing timeline row reducer, Gallery anchors, generation/abort ownership, and photo-export selection state.
- Produce: `LibraryChange` and `LibraryFileActions` types above; forward optional `libraryChange?: LibraryChange` and `fileActions?: LibraryFileActions` through Workspace to Library for subsequent integration.
- Add `suspended?: boolean` to Library. Trash suspends its visible work while keeping its browsing state mounted; leaving Gallery modes retains the existing mode-leave policy.
- Forward Workspace's existing resource-escalation callback to Library and the poll hook as `onEscalate?: (failure: LoadFailure) => void`, using `LoadFailure` and `describeLoadFailure` from `src/components/States.tsx`.

```ts
// src/features/gallery/library-arrivals.ts
export interface LibraryTimelineKey { timelineAt: string; id: string }
export type FetchLibraryPage = (request: {
  snapshotSequence: number; cursor?: string; signal: AbortSignal;
}) => Promise<LibraryPage>;
export function compareLibraryKeys(
  a: LibraryTimelineKey, b: LibraryTimelineKey, order: GalleryTimelineOrder,
): number;
export function readLibraryWindow(request: {
  fetchPage: FetchLibraryPage;
  snapshotSequence: number;
  boundary: LibraryTimelineKey | null;
  order: GalleryTimelineOrder;
  signal: AbortSignal;
}): Promise<LibraryPage>;

// src/features/gallery/use-library-arrivals.ts
export function useLibraryArrivals(options: LibraryQuery & {
  eventId: string;
  snapshotSequence: number | null;
  active: boolean;
  paused: boolean;
  onEscalate?(failure: LoadFailure): void;
}): {
  count: number;
  latestSnapshotSequence: number | null;
  checkNow(): Promise<void>;
};
```

- [x] **Write unit/UI RED cases for deliberate acceptance.** The pure window-reader test uses the existing `ManagerGalleryMediaView` fixture shape and a `vi.fn<FetchLibraryPage>()` returning two snapshot pages. Verify it stops once the last returned timeline key reaches/passes the old loaded boundary; an empty starting collection requests only one page. Include both orders and equal timestamps with different IDs.

```ts
it('orders equal-timestamp keys deterministically in both directions', () => {
  const a = { timelineAt: '2026-09-19T10:00:00.000Z', id: 'a' };
  const b = { ...a, id: 'b' };
  expect(compareLibraryKeys(a, b, 'earliest')).toBeLessThan(0);
  expect(compareLibraryKeys(a, b, 'newest')).toBeGreaterThan(0);
});
```

In UI tests, use deferred fetches and fake timers: load two pages and select a photo; settle a poll returning three matches; assert row order, viewer photo, selection, and cursor have not changed. Activate **3 new photos**, settle the staged replacement pages, and assert the accepted sequence, retained selection, current filter/order, deduplicated rows, and meaningful focus. Cover poll failure, failed second refresh page, hidden document, suspended Trash, event/query changes during a request, StrictMode, and a later poll arriving during acceptance.

- [x] **Run focused RED.** Expect missing module/arrival-control behavior, then implement:

```powershell
npx vitest run --config vitest.config.ts tests/unit/library-arrivals.test.ts tests/ui/library-arrivals.test.tsx tests/ui/host-private-gallery.test.tsx tests/ui/gallery-hardening.test.tsx
```

- [x] **Implement polling without replacing rows.** Start after the first confirmed `live=1` page supplies its sequence. Check immediately on visible activation, then every five seconds, with one in-flight request. Pause when the document is hidden, Library is inactive/suspended, a manager access/rotation gate blocks reads, or arrival acceptance is running. Abort and fence settlements on owner/query changes. Resume with an immediate check.

```ts
const enabled = active && !paused && snapshotSequence !== null
  && document.visibilityState === 'visible';
// The effect owns an AbortController, event/query generation, and one timer.
// A successful poll changes only count/latestSnapshotSequence.
// A transient failure retains those values and the existing rows.
```

Render a 44-pixel-or-larger **1 new photo / N new photos** button near the collection controls only for a positive confirmed count. Reserve its compact control-row space while polling so its appearance does not push the grid down. Announce changes politely without repeating an unchanged count every five seconds. Keep background failures quiet and retry on the next check; explicit acceptance failures show **Could not load new photos. Try again.** alongside the control.

Classify failures through the existing manager load-failure policy. Authentication, revoked access, or unavailable-event failures must reach the manager escalation callback and retire polling for that owner; they are not transient errors to retry silently forever. Add a focused UI assertion for that escalation alongside the transient-failure case. Suspend periodic checks while the manager upload dialog is covering Library, then use its terminal/close signal to check immediately.

- [x] **Implement atomic acceptance of the loaded window.** Capture the old last-loaded timeline key, current anchor/focus, selection, and the observed sequence B. Fetch into a temporary array at B until reaching/passing that old key, or reaching the end. For an empty collection fetch just the first page. Every request remains a normal page of at most 48; temporary data must not mount images. Deduplicate IDs, reject a repeated continuation cursor, check cancellation between pages, and cap the accumulated set at the event limit.

```ts
const direction = order === 'earliest' ? 1 : -1;
const raw = a.timelineAt === b.timelineAt
  ? (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)
  : a.timelineAt < b.timelineAt ? -1 : 1;
return direction * raw; // compareLibraryKeys: same ordering as SQL keys.
```

`readLibraryWindow` can stop when `boundary === null`, `nextCursor === null`, or `compareLibraryKeys(lastReturnedRow, boundary, order) >= 0`. Return the final page's cursor with the accumulated rows. Adopt rows, cursor, and sequence together only if the event, query, and mutation generations still match. On any failure leave the original rows, sequence, and continuation usable; do not partially adopt the temporary pages. New deliveries above B remain for the next notice.

Retain the loaded viewer ID if it remains available, explicit selected IDs outside the current page, and all-matching selection's existing query/exclusion semantics. Capture and restore the existing Gallery anchor after adoption with non-animated scrolling. If the clicked arrival control disappears, focus the retained anchor's photo trigger or the Library heading; do not leave focus on the document body. A large burst may require several pages to preserve an already-loaded anchor: keep the existing collection interactive, make the operation cancellable by navigation, and do not run this work on a poll.

Read selection, viewer ID, and the current scroll/focus anchor again immediately before adoption so interaction during the request is preserved. Do not restore an older selection or scroll position captured at activation. If the host appends a page or requests viewer continuation while acceptance is staging, retire that staged acceptance and let the existing continuation finish; retain the arrival notice for another activation. Test this race with a deferred refresh page.

- [x] **Replace Library remount invalidation.** Key Library by event only, removing `galleryMutationEpoch` and `libraryEpoch` from its React key. Keep those ownership signals where Album/Guest gallery need them. Convert Library invalidation into scoped reconciliation at its accepted sequence, preserving its loaded window and selection. Retire pending refreshes when a confirmed local mutation supersedes them so an older response cannot resurrect a trashed row or overwrite an album change.

```ts
switch (change.kind) {
  case 'delivered':
    void arrivals.checkNow(); // Availability notice; no automatic insertion.
    break;
  case 'trashed':
    // Commit removal and viewer successor together in the Library owner.
    break;
  case 'restored':
  case 'metadata':
    // Reconcile the loaded window at the accepted delivery sequence.
    break;
}
```

Preserve the manager's invalidation of event counts/capacity, audience summary, Guest gallery, Album, and Guestbook. Do not replace owner-wide reconciliation with a child-only refresh. Retain current photo-export source retirement rules and the existing distinction between explicit selected IDs and all matching photos; a delivery snapshot must not silently change export scope.

- [x] **Run the Task 2 GREEN command once.** Adapt touched Gallery fixtures to return `snapshotSequence` only for opted-in requests. The browser-level scroll proof is reserved for Task 4; jsdom is not evidence of rendered scroll preservation.

## Task 3: Viewer file actions and Library recovery

**Files**

- Create: `src/features/gallery/ManagerLibraryTrash.tsx`.
- Modify: `src/features/gallery/GalleryViewer.tsx`, `ManagerPrivateGallery.tsx`, `ManagerGalleryWorkspace.tsx`, `library-photo-wall.css`, `src/pages/ManagerPage.tsx`.
- Test/extend: `tests/ui/gallery-viewer.test.tsx`, `tests/ui/manager-recovery.test.tsx`, `tests/ui/manager-undo.test.tsx`.

**Interfaces**

- Consume: `LibraryFileActions`, `TrashOutcome`, `LibraryChange`, existing `ManagerTrashedMediaView`, manager `eventWrite`, `ManagerUndoProvider`, `TRASH_UNDO_WINDOW_MS`, `mediaOriginal`, and `ViewerContinuationOutcome`.
- Produce: optional `fileActions?: LibraryFileActions` on `GalleryViewer`; `ManagerLibraryTrash` presentation props below. Manager remains the owner of pending mutations and resource errors.

```ts
export interface ManagerLibraryTrashProps {
  rows: readonly ManagerTrashedMediaView[];
  now: number;
  timeZone: string;
  pendingIds: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  onRestore(row: ManagerTrashedMediaView, origin: HTMLButtonElement): void;
  onLoadMore(): void;
  onBackToLibrary(): void;
}
```

- [x] **Write RED viewer/recovery assertions.** Extend `ViewerHarness` to accept optional `fileActions` and forward it. Reuse existing modal/focus fixtures. Add this initial-focus check:

```ts
const user = userEvent.setup();
render(<ViewerHarness
  photos={[firstDance, cakeCutting]}
  initialPhotoId={firstDance.id}
  loadNextAfter={async () => ({ status: 'exhausted' })}
  fileActions={{ canTrash: true, trash: vi.fn() }}
/>);
expect(screen.getByRole('link', { name: /download original/i }))
  .toHaveAttribute('href', `/api/media/${firstDance.id}/original`);
await user.click(screen.getByRole('button', { name: /move to trash/i }));
expect(screen.getByRole('button', { name: 'Keep photo' })).toHaveFocus();
expect(screen.getAllByRole('dialog')).toHaveLength(1);
```

Add cancellation/Escape returning to the photo action; pending-write exclusion; success advancing next then previous when at the end; last loaded photo with continuation; failed continuation after successful deletion; deleting the only photo; request failure/retired owner preserving correct state; Undo after viewer close; and a restore response arriving after an event change. In the recovery suite, assert expired rows lack Restore, server deadlines are unchanged, later-page targeted focus still works, and Back to Library retains the original search and anchor.

- [x] **Run focused RED.**

```powershell
npx vitest run --config vitest.config.ts tests/ui/gallery-viewer.test.tsx tests/ui/manager-recovery.test.tsx tests/ui/manager-undo.test.tsx
```

- [x] **Move confirmation into the viewer's existing modal boundary.** Use a viewer phase of `'photo' | 'confirm-trash' | 'trashing' | 'next-photo-failed'`. Render the confirmation content inside the same `ModalSurface`, set the modal's label/description to the active phase, and focus Keep photo on entering confirmation. Escape/backdrop from confirmation returns to the photo; disable dismissal while the write is pending. Avoid nesting independent inert/scroll-lock owners.

```tsx
<a href={mediaOriginal(photo.id)} download className="button button--secondary">
  Download original
</a>
<button type="button" className="button button--danger-outline"
  disabled={!fileActions?.canTrash}
  onClick={() => setPhase('confirm-trash')}>
  Move to Trash
</button>
```

Keep the filename available even when a caption supplies the viewer title. Preserve the current confirmation's facts: removal from Library/Album/Guest gallery/live Album link, inability to recall open/downloaded copies, recovery for up to 30 days bounded by access/deletion, retained capacity use, and prepared exports retaining their own copies. Use **Trash** consistently as the visible destination; do not predict an exact deadline before the server returns one.

- [x] **Adapt the manager-owned mutation to `LibraryFileActions.trash`.** Accept the minimal photo identity instead of requiring the old Intake `MediaView`. Preserve eventWrite, the pending lock, retiring the previous Undo offer before yielding, the captured event owner, and the existing restore inverse with its absolute server deadline. Return `TrashOutcome`; let Library own viewer advancement and focus. Remove the manager's Intake-grid fallback for this action.

```ts
const outcome = await fileActions.trash(photo, activation);
if (outcome.status === 'retired') return;
// In the Library owner, use the pre-write neighbor IDs and current generation.
// Remove the confirmed ID and select the next surviving ID in one transition.
```

At the loaded boundary, use the existing shared continuation owner to get the next photo. If exhausted, use the preceding surviving photo; if no photo remains, close and focus the nearest tile or Library heading. If the next-page read fails after the trash write succeeded, show **Photo moved to Trash. Could not load the next photo.** with Retry and Back to Library. Do not call that state an empty collection or restore the deleted preview as though the write failed. Keep Undo available through the existing manager live host.

- [x] **Extract the Trash list without changing recovery semantics.** Move `renderTrashList` presentation into `ManagerLibraryTrash`, retaining metadata-only rows, exact formatted deadlines, expired labels, pagination, and stable `data-*` row identities. Leave list load/error ownership, targeted later-page loading, `restoreFromTrashRow`, and event-scoped reconciliation in ManagerPage. Route confirmed restore signals through the Library boundary from Task 2. Complete route placement in Task 4.

- [x] **Run the Task 3 GREEN command once.** Keep the existing Undo and recovery checks; do not replace them with purely presentational assertions. Task 1 already supplies server recovery evidence for the delivery trigger.

## Task 4: Consolidated navigation, manager uploads, and rendered acceptance

**Files**

- Modify: `src/app/manager-location.ts`, `src/app/manager-history-state.ts`, `src/pages/ManagerPage.tsx`, `src/features/gallery/ManagerGalleryWorkspace.tsx`, `ManagerPrivateGallery.tsx`, `library-photo-wall.css`, `src/features/uploads/ManagerUploadDialog.tsx`, `GuestUploadFlow.tsx`, `src/styles.css`.
- Create: `src/features/uploads/manager-upload-dialog.css`, `tests/e2e/library-consolidation.spec.ts`, `playwright.library.config.ts`, `vite.library.config.ts`.
- Test/extend: `tests/unit/manager-location.test.ts`, `tests/unit/manager-history-state.test.ts`, `tests/ui/manager-upload-dialog.test.tsx`, `tests/ui/manager-photo-intake.test.tsx`, `tests/e2e/manager-navigation-intents.spec.ts`, `tests/e2e/fixtures/routes.ts`.
- Document after implementation: append the consolidated behavior to the existing Library surface brief and a concise result record in this plan. Preserve the Album brief.

**Interfaces**

- Consume: Task 2's suspended Library and delivery signals; Task 3's file actions and Trash presentation; existing manager URL/history helpers and `ManagerUploadDialog` callbacks.
- Produce: default Library navigation and a Library Trash subview using the grammar below. Existing `GalleryMode` remains unchanged.

```ts
export type ManagerSection = 'gallery' | 'rsvp' | 'guestbook' | 'share' | 'settings';
export type ManagerLocation =
  | { section: Exclude<ManagerSection, 'gallery'> }
  | { section: 'gallery'; mode: 'library'; view?: 'trash' }
  | { section: 'gallery'; mode: 'album' | 'guest-gallery' };
```

| Incoming destination | Canonical destination |
| --- | --- |
| `/manage/event/:id` | Same URL; Gallery → Library |
| `?section=intake` | Base URL; Gallery → Library |
| `?section=gallery`, `?section=gallery&mode=library` | Base URL; Gallery → Library |
| `?section=gallery&view=trash` | Same URL; Library → Trash |
| `?section=gallery&mode=album` | Same URL; Album |
| `?section=gallery&mode=shared` | `?section=gallery&mode=guest-gallery` |
| RSVP, Guestbook, Share, Settings | Existing section destination |

Only recognize `view=trash` on Library. Strip irrelevant/invalid view values during canonicalization; detect duplicate `view` keys just like `section` and `mode`. Continue rejecting unknown/duplicate keys, foreign origins, fragments, credentials, and invalid manager paths in `canonicalManagerReturnPath`. Do not invent legacy Trash query aliases: current Trash state is local/history-intent based.

- [x] **Write RED location/history and upload cases.** Add the exact default and alias assertions:

```ts
expect(parseManagerLocation('').location)
  .toEqual({ section: 'gallery', mode: 'library' });
expect(parseManagerLocation('?section=intake').canonicalSearch).toBe('');
expect(parseManagerLocation('?section=gallery&view=trash').location)
  .toEqual({ section: 'gallery', mode: 'library', view: 'trash' });
```

Preserve the existing strict return-path cases and foreign-history fields. Add legacy `focus-intake-heading` normalization to `focus-library-heading`, and accept legacy `open-recently-deleted` intents at the normalized Library destination before moving to Trash and focusing the target. Keep the history envelope at version 1: this is a supported intent alias and Library subview, not a new anchor format. Do not discard old target intents during URL canonicalization.

An intent to focus complete export must first return from Trash to the Library photo view, then open/focus the existing export control. Retain its one-time consumption and Back/Forward behavior.

In manager upload tests preserve lifecycle coverage and assert the manager-only receipt/return copy says Library, finalized IDs generate delivery signals rather than a remount, and closing restores Add photos focus. Keep Settings photo-intake lifecycle controls working; removing a navigation surface does not remove the underlying guest intake policy.

- [x] **Run focused RED.**

```powershell
npx vitest run --config vitest.config.ts tests/unit/manager-location.test.ts tests/unit/manager-history-state.test.ts tests/ui/manager-upload-dialog.test.tsx tests/ui/manager-photo-intake.test.tsx
```

- [x] **Integrate navigation and remove the obsolete collection.** Replace the primary Intake nav item with the existing Gallery entry and make Gallery/Library the default. Add Trash next to the secondary Library utilities, not the mode buttons. Keep Library mounted while Trash is visible, pass `suspended`, and preserve its anchor/search/filter/order/selection. Back to Library restores the saved anchor and the Trash trigger when appropriate. A targeted recovery intent can load more Trash pages before settling focus.

Remove the active Intake markup, active media search/state, five-second head-merging poll, and its obsolete card/publication-badge rules once all owners are transferred. Retain Trash resource ownership and mutations. Remove `adoptPublicationRows` or equivalent active-Intake projections only after their obsolete consumers are gone; preserve Guest gallery's own publication state. Keep event/capacity refresh, export and Guestbook polling, manager-link rotation, upload exit gating, and Album/RSVP leave guards.

Update Library empty copy to **Photos added by you or your guests appear here.** Keep search-empty and load-error states distinct. Check touched manager routes and upload copy for **Live intake / Intake** destinations; retain **Photo intake** in Settings and domain/API names where they describe the existing policy.

- [x] **Style and connect the manager upload dialog.** Import the new CSS from `ManagerUploadDialog`. Scope it at `.manager-upload-dialog`, which is inside the portal and does not inherit `.manager-shell`. Add `photo-drop--manager` to both manager roots in `GuestUploadFlow`: the chooser/review branch and the separate receipt branch. This keeps manager layout overrides effective through completion without affecting guest uploads.

```css
.manager-upload-dialog {
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100svh - 32px);
  overflow: auto;
  background: var(--paper);
  color: var(--ink);
}
.manager-upload-dialog__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  align-items: start;
  gap: 12px;
}
.manager-upload-dialog__close {
  min-width: 44px;
  min-height: 44px;
}
.manager-upload-dialog .photo-drop--manager { min-height: 0; }
.manager-upload-dialog .source-button {
  min-height: 48px;
  background: var(--paper);
  color: var(--chestnut);
  border: 1px solid var(--chestnut);
}
.manager-upload-dialog :focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}
```

Map every guest-only CSS variable used by the manager variant's source chooser, selection, progress, failure, and receipt states to the equivalent existing manager token at this boundary, or override that declaration directly with a manager token. Preserve guest styling. Keep the current upload session/progress/cancellation/partial-delivery/cleanup mechanics intact. Change manager copy to **Library**, including **Return to Library**. Track finalized media IDs by event and deduplicate them; on terminal reconciliation/close refresh event counts and check arrivals, leaving the grid steady until its control is activated.

- [x] **Add one focused rendered acceptance suite.** Use existing `stubManagerRoutes`, `makeMedia`, and image fixtures. Extend the fixture response for `live=1` and arrival polling; do not fetch production photos. The suite must cover:

  - Base/default and old Intake URL opening Library; exactly three Gallery modes; Trash as a utility; Back/Forward and targeted recovery intents.
  - Desktop 1440 × 1000, phone 390 × 844, and narrow phone 320 × 568: two-column phone grid, opening-viewport photo, no horizontal overflow, and at least 44-pixel action targets.
  - A confirmed arrival notice appearing without moving the grid, scroll anchor, selection, or an open viewer. Clicking it preserves search, In album/all, chosen ordering, selected IDs, and a real rendered anchor, including a burst spanning more than one page.
  - Viewer Download original's authenticated endpoint, confirmation inside one modal, initial Keep photo focus, Escape/backdrop behavior, deletion advancement/empty/error cases, and Undo after closing the viewer.
  - Trash exact/expired deadlines, Restore, load-more target focus, and returning to the same Library context.
  - Manager upload chooser, progress/partial receipt/recovery at 320 pixels: visible source buttons, explicit manager colors, no full-page-height inner layout, reachable 44-pixel close, focus trap and restoration to Add photos.
  - Failed background poll, failed accepted refresh, long captions/filenames, no-preview photos, empty Library, and a 10,000-photo paginated fixture whose initial load and poll do not request the whole collection.
  - Keyboard order and visible focus; reduced-motion emulation with non-animated anchor restoration. Record any screen-reader or native-device areas that were not tested.

Use a dedicated source-only frontend server. Minimal config bodies:

```ts
// vite.library.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
```

```ts
// playwright.library.config.ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['library-consolidation.spec.ts', 'manager-navigation-intents.spec.ts'],
  outputDir: './output/playwright/library-consolidation/results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite --config vite.library.config.ts --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
```

Set each viewport explicitly in the new suite. Capture desktop/mobile/narrow Library plus narrow viewer-confirmation, Trash, upload chooser, and receipt screenshots under `output/playwright/library-consolidation/`. Browser cases must test actual rendered bounds and focus, not assume component state implies them.

- [x] **Run Task 4 GREEN and the named browser suite.** Adapt existing navigation fixtures/assertions affected by the intentional default change. Only run this focused browser command:

```powershell
npx playwright test --config playwright.library.config.ts
```

Inspect the screenshots as one desktop/mobile batch. Fix any revealed Critical/Important defects together; at most one scoped confirmation pass. Minor polish notes do not restart the cycle. Do not regenerate unrelated visual goldens or claim that these intercepted API tests demonstrate production delivery/download success.

- [x] **Finish documentation and report.** Update the existing Library surface brief to reflect the implemented navigation, deliberate arrival notice, viewer actions, and Trash. Record focused command results, browser artifacts, remaining findings, and final `git status --short`. Do not run the union again if each task already has current successful evidence and later changes have not invalidated it.

## Self-review and coverage

| Approved requirement | Planned implementation/evidence |
| --- | --- |
| One delivered-originals workspace; three distinct Gallery jobs | Task 4 navigation and copy; Task 3 file actions |
| Accurate N new photos; steady browsing before activation | Task 1 receipt sequence/snapshot; Task 2 poll/atomic adoption; Task 4 browser anchor proof |
| Viewer downloads, Trash confirmation, next photo, Undo | Task 3 focused viewer/recovery checks; Task 4 keyboard/rendered proof |
| Trash deadlines, expired states, targeted recovery | Tasks 3–4; existing server recovery checks in Task 1 |
| Manager upload styling and preserved lifecycle | Task 4 manager-only CSS/copy and existing lifecycle tests |
| Legacy Intake URL/history/return-path compatibility | Task 4 parser, intent alias, and navigation tests |
| Photo Wall, first viewport, 44-pixel targets, reduced motion | Task 4 screenshots and rendered assertions |
| 10,000-photo pagination, retained errors, ownership/privacy | Tasks 1–2 focused scale/fencing cases; Task 4 browser fixtures |

Planning self-review: all approved sections map to a task; new interfaces are defined above; API changes are opt-in; legacy cursor and history compatibility are explicit. Implementation checks listed here have not been run as part of writing this plan.

## Source notes for the delivery design

D1 uses SQLite's query engine. The planned trigger approach follows the repository's existing migration patterns and must be verified in its Worker test runtime. [Cloudflare D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

SQLite restores the outer `changes()` value after trigger execution; this matters because existing finalization/recovery batches condition counter updates on `changes()`. The focused integration checks above verify the actual runtime behavior. [SQLite changes semantics](https://www.sqlite.org/c3ref/changes.html).

`RETURNING` does not reflect subsequent AFTER-trigger changes, so the sequence is read through the committed Library query rather than inferred from an upload mutation's returned row. [SQLite RETURNING limitations](https://www.sqlite.org/lang_returning.html#limitations_and_caveats).




## Task 4 implementation result — 2026-09-15

Implemented the final Library default/navigation and Trash subview, retained legacy URL/history compatibility and manager-owned guards/resources, removed the obsolete Intake surface, and integrated manager upload styling/signals and the single portal Undo. The approved Photo Wall and Album organization remain.

The 101 named Task 4 tests have passing file outcomes across the recorded scoped correction runs; the required recovery adaptation passes 37/37. All 15 named source-only browser cases have successful outcomes across scoped runs. Final arrival/Trash anchor drift is 0.09375px through three accepted pages. The final deep-navigation case was rerun after the geometry correction and passes. No broad gates, build, staging, commit or publication were performed.

The batched desktop/mobile/narrow images exposed one Important confirmation issue; its one scoped correction keeps the title and initial Keep photo focus visible. Required screenshots and exact commands/results/limits are recorded in `.superpowers/sdd/2026-09-14-consolidated-library/task-4-report.md`. Production transport/download delivery, native-device and screen-reader behavior remain outside local fixture proof. Independent Task 4/integration review approved the implementation with no Critical or Important findings; all four tasks are complete. The Minor viewer-identity assertion improvement and environment warning are recorded in the review without an additional fix cycle. All changes remain unstaged and uncommitted on codex/consolidated-library; the parent checkout status matches the preserved baseline.

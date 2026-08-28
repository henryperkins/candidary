# Host Gallery Completion and Liveness Design

**Program:** [Host Gallery Roadmap](2026-08-23-host-gallery-roadmap-program-design.md)

**Slice:** 3 of 6

**Findings:** C-05, C-07, C-13, C-14, C-19, C-25, C-26, C-32, C-33, C-36, C-41, C-42, C-47, C-54

## Goal

Ensure a host can prepare the current collection, trust every saved/progress state, leave failed Album work safely, and use recovery actions for their full advertised lifetime.

## Existing systems retained

- `ExportsRepository`, `ExportWorkflow`, and the immutable snapshot tables remain the export engine.
- `GalleryExportControl`, `AlbumExportControl`, and `export-control-status.tsx` remain the UI controls.
- `createAutosaveQueue` remains the one save queue for Settings, Appearance, and Album.
- `useBlocker`, `UnsavedSettingsPrompt`, and the current destination-keyed preparation result remain the navigation boundary.
- `undo.tsx` remains the one Undo implementation.
- Cover preparation continues through the existing operation controller and preparation state.

## Current export snapshots

Both export controls always distinguish the frozen job from live state:

> Prepared Aug 23, 3:14 PM · 12 photos · Ready

Terminal cards retain their existing artifact/retry action and, whenever neither kind is active, keep a separate action to prepare current state:

- `Prepare current collection`
- `Prepare current Album`

Retry continues to reuse the immutable snapshot. It is labelled `Retry this prepared export`; it never stands in for preparing current state. Creating a current export uses the existing collection endpoint and is unavailable while either kind is queued/running or when that export kind has zero eligible photos as specified below. Equal live/frozen counts never suppress the current-source action because count equality cannot prove identical membership, order, metadata, or captions; counts supply context only.

The Manager chooses the latest job per kind by server ordering. It does not infer snapshot freshness from array position. Prepared/started/completed instants use Slice 1's canonical event-zone formatter, with `snapshotAt` as the prepared-source timestamp. A trusted live Album count comes from the Gallery audience summary; complete count comes from the adopted event. Each control compares that count with `job.mediaCount` and names the delta without claiming equality when either live read is stale.

Complete export is disabled at zero delivered photos—even when Guestbook-only content exists—and explains that there are no originals to prepare. The Worker enforces the same rule for new current-snapshot creation. Album export remains disabled at zero Album photos. Historical/frozen zero-photo complete jobs may still exist from the prior contract and remain viewable/retryable when their non-photo snapshot is valid.

## Export progress and errors

Create migration `0020_export_progress.sql` adding nullable, non-negative fields:

- `processed_media_count`
- `processed_bytes`
- `progress_updated_at`

A database invariant requires all three fields to be null or all three non-null, with `processed_media_count <= media_count` and `processed_bytes <= total_bytes`.

The same migration adds a small execution fence for migration-first rollout:

- `execution_protocol`, non-null `legacy|attempt-v2` with default `legacy` so the old Worker remains compatible after migration;
- `execution_transition`, non-negative with default zero;
- nullable `execution_started_at`, used as the public Running instant for attempt-v2 rows.

It also creates the singleton `export_protocol_admission` in the exact `legacy-open` state. D1 admits
an active INSERT or terminal-to-active Retry only when the row and execution protocol match:
`legacy-open` admits `legacy`, `closed` admits neither, and `open` admits `attempt-v2`. Both one-way
transitions require zero queued/running legacy rows. The atomic `legacy-open`-to-`closed` statement
serializes against old writes, so a racing old INSERT/Retry either blocks the close or loses after it.
The later closed-to-open transition preserves the canonical close time and records the exact lowercase
UUID Worker version ID and canonical admission time. Triggers forbid insert/replace, delete, returning
to `legacy-open`, reclose, or retarget. Once the candidate Worker owns HTTP, closed admission returns
safe 503 before job mutation, Workflow dispatch, or artifact deletion.

After D1 admission opens, new job creation explicitly writes `attempt-v2`; existing rows and any request already executing in the old Worker remain `legacy`. For attempt-v2 rows, database triggers require every `state` or `attempt` transition to increment `execution_transition` exactly once, forbid an increment without such a transition, and require the old `started_at` column to remain null. Legacy-protocol rows may still use that old column. New claim/terminal/retry/purge statements perform the v2 increment and match the exact protocol/attempt. A new running claim writes the real ISO instant to `execution_started_at`; the Manager projection uses it for attempt-v2 and existing `started_at` for legacy rows.

This deliberately makes Workflow callbacks pinned to the pre-deploy code harmless. Their queued claim tries to write legacy `started_at` without the transition fence and aborts; against an already-running attempt-v2 row their old mapper sees legacy `started_at = null` and cannot consider itself owner; their unfenced Ready/Failed/Retry state writes are rejected by the trigger before their export callback reaches R2. A terminal legacy job may upgrade to attempt-v2 on Retry only when its frozen source passes Slice 1's exact validation. A job lacking both valid frozen photo entries and a complete valid Guestbook snapshot returns `EXPORT_SOURCE_REMOVED`; zero photo entries alone do not invalidate a historical complete Guestbook export.

The old scheduled export cleanup is a different control flow: it deletes Ready artifacts before attempting `markExpired()`, so a D1 trigger cannot make the full old Worker safe for an attempt-v2 Ready row. The isolated preview cuts over first: freeze uploads, apply 0020, upload and inspect an exact inert preview version, record the three current Workflow version IDs, drain legacy work, close, prove the full preview config has no route/Cron/queue/event/address side effects, then use pinned `wrangler deploy` from that same clean exact-SHA artifact. Only after one new sole 100% active Worker has the exact SHA tag and all three latest Workflow version IDs have changed may safe 503 be verified and the row open with that new active UUID. Failure leaves preview admission non-open and hosted export conformance unavailable until a reviewed forward fix succeeds.

For production, the release owner first proves the sole active 100% Worker tag is the exact frozen source `df2b66510ccee6893ca91ab752337df8e52c6207`; any mismatch stops the release until the actual deployed source is frozen and reviewed. The owner blocks production deploys and unrelated `main` merges, switches the connected Build to the existing helper's upload-only mode, applies 0020 in `legacy-open`, and captures the reviewed merged version as an inert full-SHA-tagged artifact. From that same clean artifact, the existing helper projects a Cron-only config and a full cutover config whose only delta from the validated production config is `triggers.crons: []`. The Cron-only config detaches daily lifecycle while retaining hourly maintenance; the owner records the detach, all three current Workflow version IDs, and drains through trigger propagation plus maximum invocation time. After every legacy queued/running job becomes terminal, one D1 statement atomically closes admission. Old active writes then lose. The helper then uses pinned `wrangler deploy` with the full no-Cron cutover config, advancing Worker code and all three Workflow implementations together. Only after one new sole 100% active Worker has the exact release-SHA tag, its ID differs from the inert preflight upload, and all three latest Workflow version IDs differ from their captured baselines does one D1 update open admission with that new lowercase UUID and canonical timestamps. Both Crons are then restored with the Cron-only config. The freezes remain until a later daily `cleanup_completed` record names the exact cron and active Worker version; hourly evidence is insufficient. Frozen-old-cleanup tests prove why this gate is required; they do not pretend the deletion can be rolled back. Canonical commands live only in `docs/deployment.md`.

Closing is the one-way export-availability point: `legacy-open` cannot be restored, so any failure after
close must move forward to compatible HTTP/Workflow ownership. The cutover deployment remains the distinct
trash/data rollback point because trash can be accepted immediately even while export admission is
closed. From that deployment onward, the 0018 artifact cannot restore trash and cannot safely own scheduled
expiry, claim, terminalize, or release an attempt-v2 job's derived source hold. If admission is still
closed, a reviewed forward fix continues the original one-time open sequence; if it is already open,
compatible forward Worker/Workflow fixes preserve it and never reclose or rerun admission. Controlled
tests cover a recoverable trash row and attempt-v2 queued/running Workflow ownership, document the
forbidden old Ready-cleanup path, then prove current-worker restoration or terminal hold release/event
purge progress.

The current Worker reverses the unsafe Ready-cleanup ordering for both protocols: one D1 batch wins the exact Ready-to-Expired transition and atomically captures the winner's top-level keys plus every part row before R2 deletion begins. An R2 failure leaves that Expired inventory durable for a bounded retry sweep; only successful idempotent deletion clears it under the exact expired protocol/attempt/post-transition/expiry guard. A concurrent export Retry advances state, attempt, transition, and deterministic prefix in its existing atomic batch. Therefore a stale expiry clear loses, and expiry or Retry cleanup can delete only the captured prior-attempt keys—not a replacement attempt or its part rows.

Progress advances only after `multipartPut` has completed one whole photo archive part in R2; there is no invented per-entry durable append boundary inside the ZIP stream. `processed_media_count` is the cumulative number of source photos in completed parts and `processed_bytes` is their cumulative uncompressed source-byte total, not ZIP bytes or upload transfer bytes.

Each attempt-v2 Workflow dispatch payload is `{ jobId, attempt }`; an old deterministic instance cannot claim a newly queued attempt. `claimRunning`, `assertOwnedRunActive`, `recordProgress`, `markReady`, and owned `markFailed` all match `{ id, executionProtocol, attempt, executionStartedAt, state }`. Assertion distinguishes active, event-deleted, and lost ownership: only event-deleted for the still-exact owner terminalizes with `EXPORT_EVENT_DELETED`, while a stale owner changes nothing. Initial/retry dispatch-failure transitions also match the exact pristine queued attempt and advance the transition fence. Ready/Failed changes state—and therefore releases the derived source holds—in the same fenced D1 batch as final inventory/error. Stale calls affect zero rows and cannot release another attempt's hold.

`recordProgress()` writes absolute cumulative values with monotonic guards, so callback replay is idempotent. Claiming a queued attempt initializes both counters to zero. If the same Workflow callback resumes and clears its deterministic attempt prefix, it also resets progress to zero under the same run claim before rebuilding; this explicit reset is the only in-attempt decrease. Retrying a terminal job increments `attempt` and atomically resets progress fields to null with the other queued fields; no prior-attempt number is displayed on the new attempt. Ready requires the final counters to equal `media_count` and `total_bytes`; a valid historical/frozen zero-photo complete export finishes with `0 / 0` and a completion timestamp even though new creation now refuses that source. Failed retains the last fully completed-part milestone for that terminal attempt.

The Manager export projection adds `createdAt`, `startedAt`, `completedAt`, `errorCode`, and the progress fields. `shared/contracts.ts` defines the only public error-code allowlist: `EXPORT_SOURCE_MISSING`, `EXPORT_SOURCE_REMOVED`, `EXPORT_EVENT_DELETED`, `EXPORT_GUESTBOOK_SNAPSHOT_INVALID`, `EXPORT_SNAPSHOT_CHANGED`, `EXPORT_WORKFLOW_DISPATCH_FAILED`, and `EXPORT_FAILED`. Unknown/internal stored values—including `EXPORT_PART_LIMIT_EXCEEDED`—project as `EXPORT_FAILED`. UI mapping in the existing export-status module supplies one action-oriented message per allowed code.

Slice 1 already added `EXPORT_SOURCE_REMOVED` to `ApiErrorCode`, the safe client/server classification, status copy, and `docs/operations.md`; this slice retains that mapping in the expanded allowlist. Retry success retains the existing 202 response. If frozen source validation fails, retry returns `409 EXPORT_SOURCE_REMOVED` without incrementing attempt, changing terminal state, deleting prior artifacts, or dispatching a Workflow, and directs the host to prepare the current collection.

Queued and running are distinct. Running shows elapsed time and `processed / total` when progress exists. Polling continues whenever an active job exists, regardless of current Manager section, and a compact existing-status treatment keeps the active kind visible outside Gallery. The only pause is an explicit authorization-sensitive operation such as Slice 5's Manager-link rotation; its retired requests are ignored and polling resumes with the retained account credential. The other export control states which kind is active and why it must wait.

## Autosave lifecycle

Settings and Appearance adopt the generation ownership already used by Album:

- every mounted editor generation owns one queue instance;
- cleanup disposes only that generation;
- StrictMode replay creates a fresh usable queue rather than retaining a disposed ref;
- late completions from a retired generation cannot report `Saved`;
- `Saved` is emitted only after the server response is adopted.

Focused StrictMode tests render each editor, change a field after replay, and prove one confirmed write plus a truthful final state.

## Album leave and discard

The existing preparation API returns a discriminated outcome instead of a Boolean:

```ts
type AlbumLeavePreparation =
  | { status: 'ready' }
  | { status: 'waiting' }
  | { status: 'invalid'; field: string }
  | { status: 'failed'; message: string };
```

Every result remains keyed to the requested Router location key and a monotonically increasing preparation generation. Only the exact current destination may proceed.

While saving, the current prompt explains why Leave is unavailable. After `invalid` or `failed`, it offers:

- Retry;
- Stay;
- Discard unsent Album changes and leave.

Discard calls the existing queue's `discardPending()`, retires the local draft generation, and proceeds to the exact pending destination. Copy states that a request already sent may still finish. Discard never rolls back a confirmed server write.

Offline failures use one normalized message and one Retry. The active queue listens for one `online` transition and retries the newest valid draft; competing raw `Failed to fetch` banners are removed.

## Persistent Undo

The baseline has no provider: `undo.tsx` exports `useUndo()` and `UndoBar`, and Gallery consumers instantiate separate hooks. Slice 1 extended the existing Manager-owned trash hook for 30-second recovery; this slice converts the one implementation into a Manager provider, moves every Album/Library offer into it, and completes the persistence/accessibility contract:

```ts
export const UNDO_WINDOW_MS = 9_000;
export const TRASH_UNDO_WINDOW_MS = 30_000;
type ManagerUndoDuration = 9_000 | 30_000;

interface ManagerUndoOffer {
  eventId: string;
  message: string;
  durationMs: ManagerUndoDuration;
  absoluteDeadline?: string;
  input: 'keyboard' | 'pointer';
  run(): Promise<void>;
}

interface ManagerUndoController {
  state: 'idle' | 'offered' | 'running' | 'failed';
  canPresent: boolean;
  present(offer: ManagerUndoOffer, presentation: {
    fallback: HTMLElement | null;
  }): boolean;
  dismiss(): void;
  run(): void;
}
```

`ManagerUndoProvider` mounts once in the event-scoped `ManagerPage`, outside conditional sections and Gallery modes, and renders the only `ManagerUndoBar` immediately after the Manager's existing visible notice/live-recovery region. `useManagerUndo()` is the only registration path for Album remove, selection remove, reset, and recoverable trash.

An offer is a mount-independent inverse command. It may use API clients and Manager-owned resource invalidators, but never an originating child's state setter, DOM/draft ref, operation journal, or autosave queue. The established focus fallback is passed separately as provider-owned presentation metadata and never enters the offer's `run()`. Album actions capture the inverse payload and revision needed after Album unmounts. They normally register only after the exact forward Album save confirms. If a direct membership removal confirms but its associated order save fails or loses its response, canonical reconciliation finishes before leave preparation: exact full-forward state receives the full inverse, exact pre-state receives no offer, and the exact unchanged pre-save revision plus expected unpicked projection receives a repick-only inverse because stored order still owns the original position. Anything else fails closed. Success invalidates/refetches the affected Album, Library, Intake, Guestbook, and summary resources as applicable.

A second idle/failed offer atomically replaces the first; a running Undo owns the slot, sets `canPresent = false`, and disables actions that would register another offer. `present` rejects an event-ID mismatch. Event change increments the provider generation, clears offer/error/timer/holds, and ignores old request settlements. A stale completion cannot dismiss or announce for a replacement offer.

Timer accounting uses a monotonic duration deadline. The first focus/pointer hold pauses the exact remaining duration; nested holds resume only after the final release. Running Undo pauses duration expiry. Failure returns to Offered with the pre-run remainder, never a fresh window. Recoverable trash additionally supplies its server `restoreUntil` as `absoluteDeadline`: the provider expires at the earlier of the pausable duration or that nonpausable wall-clock cap, never renders/calls Undo after the cap, and says **Undo for up to 30 seconds, before <deadline>** rather than promising a pause can extend recovery. Other nine-second offers omit the cap and retain fully pausable behavior. A request that legitimately loses a restore/cleanup/deadline race uses the existing failed-reversal state and canonical reload. The provider retains the separately supplied focus fallback and returns only to a still-connected element, otherwise the current section heading; no callback-shaped focus closure crosses an unmount. A keyboard-originated mutation focuses Undo immediately, or after delayed canonical confirmation only when focus is still on its fallback or `<body>`; if the host moved into another control while saving, presentation announces without stealing focus. Pointer-originated work leaves focus stable when its control survives; a mutation that removes that control, such as trash, establishes its documented next/previous/heading fallback before presenting the offer, and the provider does not move pointer focus away from it. The bar:

- remains mounted across Gallery modes and Manager sections;
- keeps the remaining portion of the advertised window;
- appears in the persistent live/recovery region;
- receives focus when invoked by keyboard;
- pauses expiry while focus or pointer interaction is inside it;
- announces success or a failed reversal.

Equivalent Album removals use the same registration path. Reset to timeline order states before activation that it removes every section and names the Undo window.

Each disappearing-control mutation establishes its fallback before registering the offer: an Album photo removal uses next photo control, previous photo control, then Album heading; section removal, Reset, or Start-empty reconciliation uses the nearest surviving Album control then Album heading; Library removal under a picked-only filter uses next card, previous card, then Library heading. The mutation owner focuses that fallback first. Keyboard activation then moves to Undo and the provider records the fallback as its return origin; pointer activation stays on the fallback. These rules also apply when the inverse later remounts the originating mode.

## Cover preparation readiness

Cover-style previews continue through the existing preparation model. Tiles expose Loading, Retry, and the last usable preview. Initial prefetch is bounded to visible choices. A failed style does not replace the event's working cover or create a second request controller.

## Verification

- Fresh-snapshot UI and Worker tests for Ready, Failed, and Expired jobs
- Latest-per-kind ordering and cross-kind lock tests
- Progress tests at no completed part, one completed part, resumed-run reset, retry-attempt reset, stale `{attempt, executionStartedAt}` write, ready equality, failed partial progress, historical zero-photo completion/retry, and new zero-photo creation refusal
- Migration-first cross-version tests in which old claim/assert/Ready/Failed/Retry/expiry SQL runs before and after an attempt-v2 claim; pinned old Workflow callbacks lose before R2 without releasing the new source hold, the frozen old scheduled Ready cleanup demonstrates its forbidden delete-before-D1 ordering, the documented Cron drain/version-ID gate prevents mixed cleanup ownership, and queued/running/ready current-worker repair fixtures release holds and unblock purge
- Exact safe-error allowlist/projection and recovery-copy tests for every allowed code plus an unknown stored value
- Active export status outside Gallery
- StrictMode Settings and Appearance autosave regressions
- Blocked-to-blocked destination changes, invalid/failed discard, and already-sent caveat tests
- Online retry with exactly one request and one notice
- Undo one-slot replacement, running lock, event change, nine-second pause/resume, trash's up-to-30-second absolute `restoreUntil` cap during focus/pointer holds and near-deadline request races, keyboard focus, pointer stability, failure, mode/section unmount, and each Album/section/reset/Start-empty/filtered-Library next-previous-heading fallback test
- Reset pre-action consequence and cover-tile retry tests

## Non-goals

- Full export history
- Mutable export snapshots
- Optimistic `Saved` states
- Canceling an HTTP request already accepted by the Worker
- A second autosave, navigation, progress, or Undo framework

# Host Gallery Manager Upload Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use test-driven development, preserve all existing Slice 1–4 work, and do not commit unless the user asks.

**Goal:** Let a host add photos from Intake through the *same* upload queue guests use, and make the dialog honest about what it has already committed to the server before it is allowed to close.

**Architecture:** `GuestUploadFlow` gains a `manager` variant through props and slots; it is not copied. The queue gains exactly four extensions — a `mediaId` on the `delivered` `ReservationResult`, a terminal `canceled` result, an `onFinalized` per-item signal, and a typed `failure` beside the existing `error` string — because per-item invalidation, a distinguishable destroyed reservation, and an authorization failure the dialog can actually see are the smallest missing things, not a second receipt system. The fourth exists because the dialog's close gate has a terminal exception it currently has no way to observe: the raw XHR content request discards the server's error code, so a revoked credential and a dropped connection reach the queue as the same sentence. A pure `manager-upload-cleanup.ts` controller owns the ambiguous-commit resolution so its race behavior is unit-testable without a DOM. The dialog reuses the tested `GalleryViewer` modal contract rather than inventing a Manager dialog framework.

**Tech Stack:** React 19, React Router, TypeScript, Vitest with Testing Library, Playwright, and Hono on Cloudflare Workers for the projection field only.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- **Depends on** `2026-08-27-host-gallery-manager-upload-authority.md`. The four Manager routes, `UploadAuthority`, the authority-selected intake predicate, the authority-liveness recheck and its tagged `RESOURCE_FORBIDDEN` refusal, the Manager-only `UPLOAD_RESERVATION_CANCELED` code, and migration `0021` must already be green. Do not begin until they are. The cleanup controller's terminal branch is unimplementable without that code: a canceled reservation and a live conflict are otherwise the same 409.
- No new migration, no schema change, and no new Worker route belong to this checkpoint. The only Worker change is the additive `hostUploadAvailability` key on the Manager event projection.
- **Projection-reason ruling.** The slice specification writes the availability reason as `'event-unavailable' | 'media-cap' | 'storage-cap' | null`, but `event-unavailable` cannot occur on the wire and a Worker test cannot reach it. `worker/auth/manager.ts` resolves the credential before any projection is built and throws `EVENT_EXPIRED` 410 for a passed management window, `EVENT_DELETED` 410 for a soft-deleted event, and `EVENT_NOT_FOUND` 404 for a missing one; the Manager event route calls that resolution first. There is no interleaving in which a 200 body carries it. Asserting it in `tests/worker/manage-api.test.ts` would mean either weakening the authorization order or writing a test that passes against a value nothing produces.

  The reason is not dead in the product, though — it is dead in the *response*. `ManagerPage` derives its recovery surface at render from whether an event has loaded: with no event the failure takes the page, but **an event that has already loaded keeps its Manager on screen and turns the failure into an inline notice**, leaving every panel, filter, and unsaved draft in place. That is exactly the stale-client state the specification's "capacity **or lifecycle** prevents opening" sentence describes: a host whose event expired while their tab was open, still looking at an **Add photos** trigger whose last-read availability says `enabled: true`.

  So the union keeps all four members and the producers split. The Worker emits `'media-cap' | 'storage-cap' | null` only. `event-unavailable` is produced on the client by one named selector that combines the last-read projection with the current escalated lifecycle failure, and it is unit-tested. Record this ruling in the checkpoint report.
- Do not copy `GuestUploadFlow`, `runUploadQueue`, `createBrowserTransport`, or the validation set. Extend them. A second Manager queue is an explicit non-goal.
- A mocked `CleanupOutcome` proves the dialog renders a branch; it never proves the branch is reachable. Every terminal-path claim this checkpoint makes must have at least one test that starts from a server response.
- The guest variant's rendered output must not change. Every existing `tests/ui/guest-upload-flow.test.tsx` and `tests/unit/upload-queue.test.ts` assertion stays green without edits, except where a new optional field is additive.
- `onDelivered(count)` remains the all-selected-items-delivered receipt signal. `onFinalized` is not a replacement for it, and neither callback may call a shell-wide refresh or touch trash/Guest-gallery filters.
- Both callbacks are event-generation guarded. A late result from a retired Manager event may never update the next one.
- The dialog may not intentionally unmount or close while any *attempted* reservation is unresolved. Browser-only unattempted selections may be discarded immediately.
- Terminal authorization or lifecycle loss is the one exception to the close gate, and the dialog must not then claim the unresolved reservations were canceled.
- **Terminal-observability ruling.** That exception is unimplementable at `153d05f`, and no amount of dialog logic fixes it, because the failure never reaches the dialog in a form it can classify. `browser-upload-transport.ts` handles the content PUT with a raw `XMLHttpRequest` whose `load` listener rejects every non-2xx status with a bare `new Error('The transfer was interrupted. Try this photo again.')`, discarding the status and the `ApiErrorCode` in the body; `runUploadQueue` then stores `errorMessage(error)` and keeps only that string on the item. A `RESOURCE_FORBIDDEN` 403 from a revoked credential, a `TOKEN_REVOKED`, and a dropped connection are byte-identical by the time anything can decide whether to keep the close gate — so a dialog built on the interfaces as drafted would advertise a terminal handoff it can only ever reach by mocking the cleanup controller's return value. The typed code must be preserved end to end: parsed in the transport, carried by the queue, and surfaced to the dialog. Mocking a `terminal` outcome is not evidence that a terminal outcome can occur.
- A confirmed Manager DELETE is terminal. The cleanup controller may never delete a stored original; that path belongs to Intake's Slice 1 recoverable trash.
- The Manager variant renders the fixed public attribution `From Host`. No account email, display name, or management credential detail may reach the dialog or a media card.
- Preserve the existing Manager section labels, Gallery labels, resource controllers, autosave behavior, Router blocker generation, and Slice 4 canonical location ownership.
- Every behavior change follows RED → GREEN → REFACTOR.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-manager-upload-dialog/`, then take an independent spec and code review. Fix every P1/P2 before advancing.

## Checkpoint boundary

This checkpoint owns the Manager upload dialog, the four queue extensions, the Manager transport's typed content-response failures and its `cancelReservation`, the cleanup controller, the Intake **Add photos** toolbar action, `hostUploadAvailability`, and the client selector that resolves it. It does **not** own the true-empty Intake copy and QR action, canonical time formatting, Album reconciliation, registration, rotation UI, or the safety ladder. Those belong to later checkpoints.

---

### Task 1: `hostUploadAvailability` on the Manager projection

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `tests/worker/manage-api.test.ts`
- Modify: `src/features/settings/event-merge.ts`
- Modify: `tests/unit/manager-event-merge.test.ts`
- Create: `src/features/uploads/host-upload-availability.ts`
- Create: `tests/unit/host-upload-availability.test.ts`

**Interfaces:**
- Produces, on the Manager event view only:

```ts
export interface ManagerHostUploadAvailability {
  enabled: boolean;
  reason: 'event-unavailable' | 'media-cap' | 'storage-cap' | null;
}
```

`enabled` is true for scheduled, pre-start, and **paused** guest intake. The guest event view is unchanged and gains nothing.

Per the projection-reason ruling, the Worker narrows what it may emit, and the type does the enforcing:

```ts
/** What a 200 Manager event response can carry. `event-unavailable` is never among them. */
export type ProjectedHostUploadReason =
  Exclude<ManagerHostUploadAvailability['reason'], 'event-unavailable'>;

/** The projected shape `worker/http/event-view.ts` returns. */
export interface ProjectedHostUploadAvailability {
  enabled: boolean;
  reason: ProjectedHostUploadReason;
}
```

`ManagerEventView`'s `hostUploadAvailability` is typed as `ProjectedHostUploadAvailability`, so a Worker edit that emits the fourth member fails the build rather than a test. The wide union survives as the *rendered* type the client resolves to.

The client owns that fourth member:

```ts
// src/features/uploads/host-upload-availability.ts
export function resolveHostUploadAvailability(
  projected: ProjectedHostUploadAvailability,
  failure: LoadFailure | null,
): ManagerHostUploadAvailability;
// failure?.kind === 'ended-event'  →  { enabled: false, reason: 'event-unavailable' }
// anything else                    →  the projection, unchanged
```

It keys on `LoadFailure.kind`, not on a code list of its own: `shared/load-failure.ts` already classifies `EVENT_EXPIRED`, `EVENT_DELETED`, `EVENT_NOT_FOUND`, and `EVENT_ENTRY_UNAVAILABLE` as `'ended-event'` through one decision table, and that table is the repository's single answer to "is this event over." A second enumeration here would be a place for the two to disagree. `'retry'`, `'sign-in'`, and `'latest-link'` failures leave availability untouched, because none of them means the event ended.

Everything that renders availability — the toolbar trigger, the dialog, the true-empty secondary action in the final checkpoint — reads the selector's result, never the raw projection. One reader of the raw value is one surface that stays enabled after the event has expired.

- [ ] **Step 1: Write the failing projection tests**

In `tests/worker/manage-api.test.ts`, assert the exact object for: an ordinary open event; a paused event (`enabled: true`, `reason: null`); a pre-start event (`enabled: true`); an event at `MAX_MEDIA_PER_EVENT` counting **active plus reserved plus recoverable** rows (`reason: 'media-cap'`); and an event at the byte ceiling counting the same three (`reason: 'storage-cap'`). Assert the guest event view does not contain the key.

Then assert the ruling rather than the dead value: an **expired** event returns the canonical `EVENT_EXPIRED` 410 with no body at all, and a soft-deleted one `EVENT_DELETED` 410 — so a later reader can see that the missing projection case is a deliberate authorization order, not an oversight. Typing `ManagerEventView.hostUploadAvailability` as `ProjectedHostUploadAvailability` is what stops a future edit from emitting `event-unavailable` from the Worker; no runtime test can prove a value's absence, so the compiler carries that half.

- [ ] **Step 1b: Write the failing selector tests**

In `tests/unit/host-upload-availability.test.ts`:
- a healthy projection with no failure passes through unchanged, for each of `null`, `media-cap`, and `storage-cap`;
- an escalated `EVENT_EXPIRED` over an `enabled: true` projection yields `{ enabled: false, reason: 'event-unavailable' }` — the stale-tab case;
- `EVENT_DELETED` and `EVENT_NOT_FOUND` do the same, driven through `classifyApiErrorCode` rather than by naming them in the selector;
- an `'ended-event'` failure wins over `media-cap`, so the reason a host reads is the one that actually blocks them;
- a `'retry'` failure — a network failure, a 500 — does **not** disable the trigger, because the last-read availability is still the best answer and a transient blip must not tell a host their event is over;
- a `'sign-in'` failure likewise does not, since it is a credential answer rather than an event one;
- the selector is pure and reads no module-level state.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t 'hostUploadAvailability'
```

Expected: FAIL — the key does not exist.

- [ ] **Step 3: Implement the projection**

Derive it in `worker/http/event-view.ts` from the same counters the reservation guard uses, including Slice 1's `recoverable_media_count` and `recoverable_bytes`. Precedence when both apply: `media-cap`, then `storage-cap`. Lifecycle has no precedence rung here because it never reaches this function.

- [ ] **Step 4: Merge-safe adoption**

Extend `event-merge.ts` so an adopted event view carries the new key without clobbering an in-flight settings draft, and add the merge regression.

- [ ] **Step 5: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts
npx vitest run --config vitest.config.ts tests/unit/manager-event-merge.test.ts tests/unit/host-upload-availability.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add shared/contracts.ts worker/http/event-view.ts src/features/uploads/host-upload-availability.ts src/features/settings/event-merge.ts tests/worker/manage-api.test.ts tests/unit/manager-event-merge.test.ts tests/unit/host-upload-availability.test.ts
git commit -m "feat: project host upload availability"
```

---

### Task 2: The four queue extensions

**Files:**
- Modify: `src/features/uploads/upload-queue.ts`
- Modify: `tests/unit/upload-queue.test.ts`

**Interfaces:**
- Produces:

```ts
export type ReservationResult =
  | { id: string; status: 'accepted'; reservation: UploadReservation }
  | { id: string; status: 'delivered'; mediaId: string }
  | { id: string; status: 'canceled' }
  | { id: string; status: 'rejected'; error: string; failure?: UploadFailure };

/** The typed cause behind a failed item, when the server named one. */
export interface UploadFailure {
  code: ApiErrorCode;
  status: number;
  stage: 'reserve' | 'upload' | 'finalize';
}

export interface UploadQueueItem {
  // …existing fields, including the unchanged human-facing `error` string
  /** Present only when the failure carried a server code. Absent for transport failures. */
  failure?: UploadFailure;
}

export interface RunUploadQueueOptions {
  concurrency?: number;
  onChange?: (items: UploadQueueItem[]) => void;
  signal?: AbortSignal;
  /** Fires once per item that becomes durably delivered, whether by finalize or by an idempotent already-delivered reserve. */
  onFinalized?: (result: { itemId: string; mediaId: string }) => void;
}
```

`failure` is additive and orthogonal to `error`: the rendered sentence does not change, and every existing assertion on `item.error` stands. It is `undefined` for a genuine transport failure — a dropped connection has no code — which is precisely the distinction the dialog needs and cannot make today. `stage` is recorded because the same code means different things at different phases: a `RESOURCE_FORBIDDEN` at reserve leaves nothing to clean up, while one at upload leaves a reservation the controller must resolve.

`UploadReservation` already carries `mediaId`, so a `delivered` reservation result gains the one field it was missing.

`canceled` is the third terminal answer a replayed reserve can give, and the reason the cleanup controller can resolve its central race at all. Without it a reservation the server already destroyed comes back as a `rejected` string — indistinguishable from a transient failure, so the controller would retry a cancel forever against a row that no longer exists. `createBrowserTransport`'s Manager variant produces it from the `UPLOAD_RESERVATION_CANCELED` 409 introduced in the previous checkpoint; the guest transport never produces it, and the guest server never emits the code, so no guest assertion changes.

In `runUploadQueue`, `canceled` is terminal and quiet: the item leaves the queue without becoming `delivered`, `onFinalized` does **not** fire for it, `onDelivered`'s count excludes it, and nothing is retried. It is not an error state and must not render as a failed item.

- [ ] **Step 1: Write the failing queue tests**

Against the existing fake `UploadTransport`:
- a straightforward finalize fires `onFinalized` exactly once with the reservation's `mediaId`;
- a reserve that returns `status: 'delivered'` fires `onFinalized` once with the returned `mediaId` and performs no transfer;
- a finalize-stage retry that succeeds fires `onFinalized` once in total, not twice;
- an item that fails terminally never fires it;
- a reserve that returns `status: 'canceled'` performs no transfer, fires no `onFinalized`, is excluded from `onDelivered`'s count, is not retried, and does not render as a failure;
- a rejected reserve carrying a `failure` puts that exact object on the item alongside the unchanged `error` sentence;
- a transport-stage rejection carrying a `ClientApiError` records `failure` with that code, the response status, and `stage: 'upload'`; a finalize-stage one records `stage: 'finalize'`;
- a plain transport failure with no code leaves `failure` undefined while `error` reads exactly as it does today;
- a retry that later succeeds clears `failure` along with `error`;
- `onDelivered` semantics and every existing state-machine assertion are unchanged;
- omitting `onFinalized` changes nothing.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts
```

Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement**

Fire `onFinalized` at the single point where an item transitions into `delivered`, so both paths are covered by one call site and a retry cannot double-fire.

Derive `failure` at the one `catch` that already computes `errorMessage(error)`, from a `ClientApiError` instance and the stage variable that is already in scope there. Do not add a second failure path or change what `errorMessage` returns.

- [ ] **Step 4: Verify GREEN and check the guest path is untouched**

```bash
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts tests/ui/guest-upload-flow.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/features/uploads/upload-queue.ts tests/unit/upload-queue.test.ts
git commit -m "feat: signal each finalized upload and keep its failure code"
```

---

### Task 3: Manager transport and the cleanup controller

**Files:**
- Modify: `src/features/uploads/browser-upload-transport.ts`
- Create: `src/features/uploads/manager-upload-cleanup.ts`
- Create: `tests/unit/manager-upload-cleanup.test.ts`
- Modify: `tests/unit/browser-upload-transport.test.ts`
- Modify: `src/app/api.ts`

**Interfaces:**
- `UploadTransport` gains an optional `cancelReservation(item, reservation, signal?): Promise<void>`. The guest transport does not implement it.
- `src/app/api.ts` exports the existing same-origin credential-header helper so the raw XHR content request sends both the event and host CSRF pairs exactly as `api()` does. Extract it; do not re-derive the headers in the transport.
- **The XHR content request stops discarding the server's answer.** Per the terminal-observability ruling, its `load` listener parses a non-2xx body as the ordinary `{ error: { code, message } }` wire shape and rejects with a `ClientApiError` carrying that code and `request.status`, falling back to today's exact `Error` and sentence only when the body is absent or unparseable. `error` and `abort` listeners are unchanged — a dropped connection genuinely has no code. This is the one behavior in this task that the guest path shares, and it is a strict improvement there for the same reason: it is what lets the guest queue tell a revoked session from a flaky network. The guest-visible failure *sentence* is unchanged, so no `tests/ui/guest-upload-flow.test.tsx` assertion moves.
- Produces:

```ts
export type CleanupOutcome =
  | { kind: 'settled' }
  | { kind: 'delivered'; mediaId: string }
  | { kind: 'retry'; outstanding: number }
  | { kind: 'terminal'; reason: 'authorization' | 'lifecycle' };

export interface CleanupDeps {
  reserve(item: CleanupItem): Promise<ReservationResult>;
  cancel(item: CleanupItem, reservation: UploadReservation): Promise<void>;
}

export function createManagerUploadCleanup(deps: CleanupDeps): {
  run(items: readonly CleanupItem[], signal?: AbortSignal): Promise<CleanupOutcome[]>;
};
```

- [ ] **Step 1: Write the failing cleanup race table**

In `tests/unit/manager-upload-cleanup.test.ts`, drive the deps with deferred promises and cover each branch from the spec:
- an item with a known reservation and no confirmed delivery is sent to cancel, and a confirmed cancel settles it;
- an item with **no** known reservation replays the same idempotent reserve; an `alreadyDelivered` result yields `{ kind: 'delivered' }` and must be deduplicated by `mediaId` upstream;
- a reserve replay returning a fresh reservation is then canceled;
- **the finalize race:** cancel rejects with the state conflict, the controller replays reserve **after** that conflict, and an `alreadyDelivered` reclassifies to `delivered`;
- **the lost-DELETE-response race:** the cancel request itself fails without an answer — the server committed the deletion and the response never arrived — and the replayed reserve returns `status: 'canceled'`. The item settles as `{ kind: 'settled' }` with **no** second cancel and no reservation recreated. This is the branch the typed `canceled` result exists for; a controller that reads it as a generic rejection retries cancel against a destroyed row and never converges, so assert both the outcome and the exact cancel call count;
- the same race where the replay returns a still-reserved or failed result retries cancel;
- a network failure yields `{ kind: 'retry', outstanding: n }` with the exact count;
- `TOKEN_REVOKED`, account/membership loss, and event/access expiry each yield `{ kind: 'terminal' }` and stop further work — driven from a typed `UploadFailure`/`ClientApiError`, since the controller classifies on `code`, never on message text;
- `RESOURCE_FORBIDDEN` from the previous checkpoint's authority-liveness refusal is terminal with `reason: 'authorization'`, and `EVENT_EXPIRED`/`EVENT_DELETED` with `reason: 'lifecycle'`;
- an untyped transport failure with the same human sentence is **not** terminal and yields `{ kind: 'retry' }` — assert the pair together, because a controller that matches on the message cannot tell them apart and this is the row that catches it;
- an aborted signal stops issuing new requests;
- the controller never issues a cancel for an item whose media is stored.

- [ ] **Step 1b: Write the failing transport code-preservation tests**

In `tests/unit/browser-upload-transport.test.ts`, against a stubbed `XMLHttpRequest`:
- a 403 whose body is `{ error: { code: 'RESOURCE_FORBIDDEN', message: … } }` rejects with a `ClientApiError` carrying that code and status `403`;
- a 409 `UPLOAD_FINALIZE_CONFLICT` likewise;
- a non-2xx with an empty or non-JSON body rejects with today's exact `Error` and sentence;
- a network `error` event and an `abort` event are unchanged;
- a 2xx still resolves.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/unit/manager-upload-cleanup.test.ts tests/unit/browser-upload-transport.test.ts
```

Expected: FAIL — the module does not exist, and the transport still collapses every non-2xx into one string.

- [ ] **Step 3: Implement the controller and the transport method**

The controller is pure with respect to the DOM and takes its two operations as deps, and it classifies terminal outcomes from `code` alone. `createBrowserTransport` parses the content response per this task's interfaces and gains a Manager variant that targets the Manager routes and implements `cancelReservation` against the Manager `DELETE`.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/unit/manager-upload-cleanup.test.ts tests/unit/browser-upload-transport.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/features/uploads/browser-upload-transport.ts src/features/uploads/manager-upload-cleanup.ts src/app/api.ts tests/unit/manager-upload-cleanup.test.ts tests/unit/browser-upload-transport.test.ts
git commit -m "feat: resolve ambiguous manager upload commits"
```

---

### Task 4: The `manager` variant of the upload flow

**Files:**
- Modify: `src/features/uploads/GuestUploadFlow.tsx`
- Modify: `src/pages/EventPage.tsx` *(the one guest call site, which now passes availability explicitly)*
- Create: `src/features/uploads/ManagerUploadDialog.tsx`
- Create: `tests/ui/manager-upload-dialog.test.tsx`
- Modify: `tests/ui/guest-upload-flow.test.tsx`

**Interfaces:**
- `GuestUploadFlowProps` gains `variant?: 'guest' | 'manager'`, plus optional slots for the heading level and the receipt action. The `manager` variant:
  - supplies fixed, noneditable `Host` identity and omits the name editor;
  - omits the guest hero and the Guestbook receipt action;
  - suppresses or demotes the page `h1` headings so the dialog label never duplicates or shifts;
  - changes only Manager-facing heading and receipt copy;
  - keeps the same source controls, validation set, two-transfer concurrency, idempotency, progress, cancellation, retry, and finalize behavior.

- **Availability is a separate input from `event.uploadsEnabled`.** At `153d05f` the flow reads `event.uploadsEnabled` at four places — the `sendSelected` early return, both source buttons' `disabled`, and the helper line that otherwise reads *"The host has paused photo delivery for now."* That flag is the **guest** pause, and it is exactly what this slice makes not apply to a host. Reusing the component without separating them produces the precise failure the toolbar work is meant to prevent: a paused host opens **Add photos** onto a dialog whose Camera and Library buttons are disabled and whose helper text tells the host their own uploads are paused.

  The flow therefore takes availability explicitly and never derives it from the event:

```ts
interface GuestUploadFlowProps {
  // …existing props
  variant?: 'guest' | 'manager';
  /**
   * Whether this actor may add photos right now. The guest surface passes
   * `event.uploadsEnabled`; the Manager dialog passes
   * `hostUploadAvailability.enabled`. Nothing inside the flow reads
   * `event.uploadsEnabled` any more.
   */
  uploadsAvailable: boolean;
  /** Rendered in place of the guest helper line when `uploadsAvailable` is false. */
  unavailableMessage: string;
}
```

  `EventPage` passes `uploadsAvailable={event.uploadsEnabled}` and today's guest string, so the guest render is unchanged character for character. The dialog passes the `resolveHostUploadAvailability` result — never the raw projection — so a stale tab whose event has expired disables the same way a capped one does. Do not add a `variant === 'manager'` special case at any of the four sites; the whole point is that one condition now serves both.

- The name gate at the same early return is also guest-only. The `manager` variant has no name editor, so its send path must not consult `saveName()` — it supplies the fixed `Host` attribution and proceeds. A manager variant that inherits the guest name check cannot send at all.
- `ManagerUploadDialog` owns the modal shell and applies the tested `GalleryViewer` contract: stable accessible label **Add photos**, initial focus on that `h2`, focus containment, inert background, and return focus to the invoker.

- [ ] **Step 1: Write the failing dialog suite**

Cover:
- the dialog exposes exactly one accessible name **Add photos** across initial, review, progress, and receipt states, and never renders a second `h1`;
- no guest hero, no name field, no Guestbook call to action;
- attribution reads `From Host` and no account email or display name appears anywhere in the tree;
- selection, validation refusal copy, retry, and progress behave identically to the guest variant for the same fake transport script — assert by running the same table against both variants;
- **with the event's guest uploads paused** — `event.uploadsEnabled: false` and `hostUploadAvailability: { enabled: true, reason: null }` — the Camera and Library controls are enabled, a file can actually be selected, **Send** reaches the transport, and the flow completes to its receipt. Assert the whole journey, not the dialog's presence: a component that opens with dead controls passes every presence-only assertion;
- no paused-guest copy — the string beginning *"The host has paused photo delivery"* — appears anywhere in the Manager tree in that state;
- when resolved availability is false, the source controls are disabled and the adjacent copy is the **named reason**, never the guest pause sentence — assert it for `media-cap`, for `storage-cap`, and for the client-derived `event-unavailable`;
- the guest variant with `event.uploadsEnabled: false` still renders exactly today's disabled controls and today's guest sentence, character for character;
- before sending, **Close** discards the browser-only selection and returns focus to the invoker;
- during transfer, Close and Escape are unavailable, and the Router blocker rejects Back and a programmatic location change;
- `beforeunload` is armed during transfer and cleanup and disarmed otherwise;
- **Cancel uploads** aborts new and in-flight XHR work and awaits the queue promise before running cleanup;
- a `retry` cleanup outcome keeps the dialog open, offers **Retry cleanup**, and names the outstanding count;
- a `terminal` outcome with a still-valid account credential shows **Temporary uploads will expire automatically**, refreshes under that account, and closes to Intake;
- a `terminal` outcome with no usable credential yields to the existing Manager recovery surface and does not claim anything was canceled;
- **the terminal branch is reached from a real refusal, not from a mocked outcome.** One case in this suite wires the actual `createBrowserTransport` Manager variant — not the fake — to a stubbed `XMLHttpRequest` and `fetch` that replay the exact 403 body the previous checkpoint's Worker test proves a revoked credential produces: `{ error: { code: 'RESOURCE_FORBIDDEN', message: … } }`. Assert that the transport, the queue's typed `failure`, the cleanup controller's classification, and the dialog's terminal handoff all fire from that one response, and that the dialog does not claim the unresolved reservations were canceled. Copy the body from the Worker test's fixture rather than retyping it, so the two cannot drift. Every other case in this suite may keep the fake transport;
- the same wiring with a plain network failure instead keeps the dialog open on **Retry cleanup** and does not take the terminal branch;
- the receipt says the photos were added and **Done** closes to Intake and restores the toolbar action.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-upload-dialog.test.tsx
```

Expected: FAIL — the component does not exist.

- [ ] **Step 3: Implement the variant and the dialog**

Extract the `GalleryViewer` modal behavior into whatever shared shape both can consume; do not fork it and do not add a new dialog framework.

- [ ] **Step 4: Verify GREEN and prove the guest variant is unchanged**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-upload-dialog.test.tsx tests/ui/guest-upload-flow.test.tsx
```

Expected: PASS with no edits to existing guest assertions.

- [ ] **Step 5: Commit**

```bash
git add src/features/uploads/GuestUploadFlow.tsx src/pages/EventPage.tsx src/features/uploads/ManagerUploadDialog.tsx tests/ui/manager-upload-dialog.test.tsx tests/ui/guest-upload-flow.test.tsx
git commit -m "feat: add photos from the manager"
```

---

### Task 5: The Intake trigger and per-item invalidation

**Files:**
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/manager-recovery.test.tsx`

**Interfaces:**
- Active Intake always exposes one **Add photos** toolbar action. It stays focusable with `aria-disabled` and an adjacent reason when `resolveHostUploadAvailability` returns `enabled: false`, so receipt focus never targets a disabled native control. `ManagerPage` passes it the same escalated lifecycle failure it already derives its inline notice from — one fact, two renderings.
- The Manager deduplicates `onFinalized` by `mediaId` and invalidates only: the event projection, the active Intake query, Library, and the affected Guestbook projection.

- [ ] **Step 1: Write the failing integration tests**

- the toolbar action is present whenever Intake is active, including when the event is paused — and, in the paused case, activating it opens a dialog the host can complete a real upload through, asserted end to end rather than by the trigger's presence;
- when availability is false, the action is focusable, `aria-disabled`, and adjacent to the named reason, and activating it opens nothing;
- **the stale-tab case:** an event that loaded successfully and whose next read fails with `EVENT_EXPIRED` keeps the Manager on screen with its inline notice, and the trigger becomes `aria-disabled` with the `event-unavailable` reason rather than staying enabled onto a dialog that could only 410;
- a retryable outage instead leaves the trigger enabled, so a transient blip never reads as an ended event;
- a partial success invalidates exactly the four named resources once per new `mediaId`, and a repeated signal for the same `mediaId` invalidates nothing further;
- neither callback triggers a shell-wide refresh or changes the trash or Guest-gallery filters;
- a result arriving after the Manager event generation was retired updates nothing;
- filling the last slot returns focus to the toolbar action;
- the active stored count and export freshness update after a partial success.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'Add photos'
```

Expected: FAIL.

- [ ] **Step 3: Implement the trigger and invalidation**

Reuse the existing Slice 1 resource controllers and their `capture`/`isCaptureCurrent` generation guards; do not add a new invalidation mechanism.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx tests/ui/manager-upload-dialog.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/pages/ManagerPage.tsx tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx
git commit -m "feat: open host uploads from intake"
```

---

### Task 6: Browser evidence

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/album-workspace.visual.spec.ts`

**Interfaces:**
- Extends Slice 4's named Axe inventory. The inventory assertion that locks it in exact order must be updated in the same commit, or it will fail.

- [ ] **Step 1: Write the failing browser cases**

Add named readiness gates and Axe scans for the Manager upload dialog in its initial, review, progress, and receipt states, plus the disabled-trigger state. Add 390 px and 320 px assertions for at-least-44 px targets, no page-level horizontal overflow, and a keyboard trace from the toolbar action into the dialog and back to the invoker on Done.

- [ ] **Step 2: Run and verify RED**

```bash
npx playwright test tests/e2e/accessibility.spec.ts --project=desktop -g "Add photos"
```

Expected: FAIL until the fixtures and inventory are updated together.

- [ ] **Step 3: Implement and verify GREEN**

```bash
npm run build
npx playwright test tests/e2e/accessibility.spec.ts tests/e2e/manager-responsive.spec.ts --project=desktop --project=mobile
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/accessibility.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/album-workspace.visual.spec.ts
git commit -m "test: verify the host upload dialog in a browser"
```

---

### Task 7: Evidence and checkpoint gates

**Files:**
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`

- [ ] **Step 1: Record the findings this checkpoint closes**

**Write** C-12's row — it does not exist yet. The previous checkpoint deliberately recorded its server work as progress prose rather than as a row, because a finding's row is written once, by the checkpoint that closes it, and a partial row would overstate what is proved. C-12 closes here, so this is where its row is created: name the Manager routes and server authority from the previous checkpoint **and** the dialog, the four queue extensions, the cleanup controller's exact race branches, the always-present trigger, and every owning test file across both checkpoints.

State both of this checkpoint's rulings in that row. The **terminal-observability** half is what makes the terminal handoff a proved behavior rather than a rendered branch: name the transport's typed content-response failure, the queue's `failure` field, and the one dialog case driven from a real 403 body. The **projection-reason** half explains why no Worker test asserts `event-unavailable`: the wire carries two reasons, the fourth member is client-derived by `resolveHostUploadAvailability`, and the expired event is proved by the canonical 410. Without both sentences a later reader sees a spec union the Worker does not emit and reads it as an unfinished projection.

Do **not** write or edit a C-08 row here. C-08 is about pause's scope on the guest surfaces, which this checkpoint does not touch; the pause-scope checkpoint closes it and writes its single row, naming this checkpoint's Intake trigger among the evidence. Do not claim guest-surface parity, first-run copy, Album, registration, or rotation behavior here; those belong to later checkpoints.

- [ ] **Step 2: Run the complete checkpoint gates**

```bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts tests/unit/manager-upload-cleanup.test.ts tests/unit/browser-upload-transport.test.ts tests/unit/host-upload-availability.test.ts tests/ui/manager-upload-dialog.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/app.test.tsx
npm test
npm run build
npm run test:e2e
git diff --check
```

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 3: Commit the record**

```bash
git add docs/superpowers/host-gallery-verification-matrix.md
git commit -m "docs: record host upload dialog evidence"
```

Do not push. The next Slice 5 checkpoint is Album era reconciliation.

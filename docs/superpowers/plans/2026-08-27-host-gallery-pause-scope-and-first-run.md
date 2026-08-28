# Host Gallery Pause Scope and First Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use strict focused RED, minimal implementation, focused GREEN, then a fresh implementer handoff and independent review for every task. Do not commit this task or checkpoint: all five Slice 5 plans receive exactly one final commit only after every task and final Slice review gate passes.

**Goal:** Make Pause mean one thing on every guest surface, finish the safety ladder by naming its last rung after what it actually pauses, make an empty Intake say what is actually true, and close the deterministic-polish findings that make the Manager read like two products.

**Architecture:** The server already gates guest uploads and nothing else after the first Slice 5 checkpoint; this checkpoint makes the guest *surfaces* agree, including the fullscreen route, whose Gallery availability currently resolves by a different rule than the main page's. Renaming the pause controls is what finally lets the safety ladder's last rung be asserted, which is why C-16 closes here rather than in the checkpoint that built the other nine. Everything else here is subtraction: one canonical event-zone formatter replaces four component-local locale calls, one deterministic Guestbook default replaces a count-dependent one, and the Cover upload's byte progress lands in the session hook that already owns the raw transfer rather than in a second controller.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, React 19, Vitest with `vitest-pool-workers` and Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- Preserve unrelated and untracked files plus all authored/custom content. Keep Slice 6 findings C-34, C-38, and C-62 out of scope.
- Every task is independently testable and receives a fresh implementer handoff plus an independent task review. Record focused RED/GREEN evidence; resolve every P1/P2 before advancing.
- Do not run repository-wide verification, full builds, full lint/typecheck, full E2E, `npm test`, or `ci:migrations`. Use only named test files/spec filters, changed-file lint where applicable, the matrix parser, and `git diff --check`.
- Do not make task-level or checkpoint commits. The release owner creates exactly one final Slice 5 commit only after all five plans, focused gates, and final independent Slice review are complete.
- **Depends on** `2026-08-27-host-gallery-account-lifecycle-and-rotation.md` for the safety ladder's nine asserted rungs and its typed and focused confirmation components. This checkpoint adds the tenth rung and closes C-16; it does not rebuild the ladder or restate the other nine contracts.
- **Depends on** `2026-08-27-host-gallery-manager-upload-authority.md` for the server-side pause split, and on `2026-08-27-host-gallery-manager-upload-dialog.md` for two things: the Intake **Add photos** trigger that the true-empty secondary action reuses, and the same-origin credential-header helper that checkpoint extracts from `src/app/api.ts`, which Task 7's XHR raw upload reuses rather than re-deriving.
- No migration, no new Worker route, and no new client route belong to this checkpoint.
- **Formatter scope ruling.** C-61 names exactly four surfaces: Intake schedule, Manager header/retention, the upload flow, and Host Events. Convert those and no others. C-56 separately changes only the same-minute range logic in `src/features/gallery/gallery-timeline.ts`; it is not part of the C-61 audit. `src/components/EventAppearanceCanvas.tsx` and `src/components/GuestEventHero.tsx` remain out of scope. Record this ruling in the checkpoint report.
- Equal upload-time endpoints already collapse inside `formatEventTimeRange`. Route the affected callers through it rather than adding a second equality check at a call site.
- Paused copy names only new uploads. It may never imply the event or any other guest surface is offline.
- The main guest page and the fullscreen route must use the **same** availability rules and the same projection. Do not add a fullscreen-specific rule.
- **Fullscreen-scope ruling.** "Same projection" is about the Gallery, not about the page. The specification lists what an event guest retains while paused — the event shell and receipt, My deliveries, Guestbook, the Guest gallery when its own setting is on, and "fullscreen Gallery **through the same projection**" — and then says the two routes "use the same availability rules." It does not say the fullscreen route renders the main page's panels, and it never has: `/event/:slug/fullscreen` deliberately renders a screen-reader `h1`, a compact bar with the close control, and the gallery grid, and nothing else. That is the whole point of the route. Requiring Guestbook and My deliveries there would not close C-08; it would replace a deliberate design with a duplicated page, and the test asserting it would be asserting the wrong thing. Parity is asserted where it exists: **which photos the Gallery shows, and whether it is available at all**, must be identical on both routes for every cell of the matrix. The main route additionally keeps its secondary panels. Record this ruling in the checkpoint report.
- Guest gallery availability remains an independent setting. Pause must not switch it, and Settings remains its sole owner.
- Every behavior change follows RED → minimal GREEN → scoped refactor.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-pause-scope-and-first-run/`; the task review checkpoint records the fresh implementer and independent reviewer outcome without committing.

## Checkpoint boundary

This is the final Slice 5 checkpoint. It owns C-08 (guest surfaces), C-16, C-50, C-53, C-55, C-56, C-57, C-58, and C-61, and it closes the Slice 5 matrix section. It does **not** own anything in Slice 6.

C-16 arrives here by the account checkpoint's ladder-ownership ruling. That checkpoint builds the safety ladder and asserts nine of its ten rungs; the tenth — **Pause / Resume guest uploads** — could not be asserted there because its control still read *Pause photo delivery* / *Reopen photo delivery* and the rename is Task 2 of this checkpoint. This checkpoint therefore asserts that last rung against the renamed control and writes C-16's single matrix row naming both halves.

---

### Task 1: Pause is guest uploads, on every guest surface

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `worker/routes/event.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `worker/routes/gallery.ts`
- Modify: `worker/routes/messages.ts`
- Modify: `shared/rsvp.ts`
- Modify: `src/pages/EventPage.tsx`
- Modify: `tests/worker/photo-intake-api.test.ts`
- Modify: `tests/worker/core-journey.test.ts`
- Modify: `tests/worker/messages-api.test.ts`
- Modify: `tests/worker/event-theme-api.test.ts`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/guest-before-start.test.tsx`
- Modify: `tests/ui/guest-rsvp-flow.test.tsx`
- Modify: `tests/ui/guestbook.test.tsx`
- Modify: `tests/ui/event-theme-rendering.test.tsx`
- Modify: `tests/e2e/core-journey.spec.ts`
- Modify: `tests/e2e/guest-lifecycle.spec.ts`
- Modify: `tests/e2e/fixtures/routes.ts`
- Modify: `tests/e2e/event-cover-studio.spec.ts`

**Interfaces:**
- `GuestEventView.phase` remains the primary RSVP/before-start/photo/waiting projection. Add a separate server-owned projection:

```ts
export type GuestReadSurfaces =
  | { available: true; reason: null }
  | { available: false; reason: 'before-photo-open' };

export interface GuestPhaseView {
  // existing phase/rsvp fields
  guestReadSurfaces: GuestReadSurfaces;
}
```

`resolveGuestEventPhase` computes both facts from one `now`. Scheduled events set `guestReadSurfaces.available` only once `resolveScheduledOpen(input) <= now`, regardless of `uploadsEnabled`; pause can withhold the composer but cannot expose read surfaces early. Legacy events preserve RSVP-first: `rsvp-primary` is unavailable, then `waiting`/`photos-primary` are available even when paused.

Update the exact `GUEST_EVENT_VIEW_KEYS`, central typed E2E fixture, and every direct typed `GuestEventView` fixture listed in this task. The Manager-only `EventView` remains unchanged by this task.

- `worker/routes/gallery.ts` applies `guestReadSurfaces` to both the Guest gallery handler and direct My Deliveries `GET /event/:slug/contributions`; Guestbook GET/POST in `worker/routes/messages.ts`, the main page, and fullscreen consume the same fact. A direct pre-boundary probe of Gallery, Guestbook, or My Deliveries returns `EVENT_PHASE_CONFLICT` with the exact shared message **Shared photos and Guestbook become available when photo sharing opens.** Guest gallery's independent setting still applies after the read-surface gate; My Deliveries has no separate visibility setting.

- [ ] **Step 1: Write the failing guest-surface matrix**

Build the server/client lifecycle table over scheduled `{ pre-start, early-open, post-start } × { paused, unpaused }`, plus legacy `{ rsvp-primary, waiting, photos-primary }` rows. In every row assert both the primary `phase` and separate `guestReadSurfaces` object. Then cross available rows with `{ guestGalleryOn, guestbookState }` for rendering.

*On the main guest page,* assert scheduled pre-boundary rows expose none of the read surfaces even if unpaused; after the boundary, paused and unpaused rows expose Guestbook, My deliveries, and independently enabled Guest gallery while only the paused composer is absent. Legacy RSVP-first hides them, then waiting/photos retains them. Assert the composer and read surfaces separately.

*On direct read routes,* call `GET /event/:slug/contributions` as well as Gallery and Guestbook in scheduled pre-boundary paused/unpaused rows and legacy RSVP-first. Assert the same `EVENT_PHASE_CONFLICT` code and exact shared message and no contribution data. After the boundary, and in legacy waiting/photos, My Deliveries returns the existing allowlisted contribution response even while uploads are paused. This direct Worker row is mandatory; a UI-hidden panel is not server enforcement.

Name the Worker matrix describe/test group `guest read surfaces`, including the direct contributions rows, so Step 2 executes every newly written server assertion before implementation.

*On `/event/:slug/fullscreen`,* when read surfaces are unavailable, keep the fullscreen shell, hidden `h1`, and Close control, make **no** gallery request, and render the same shared `before-photo-open` reason. When available, request the gallery only if its independent setting permits it; available-and-empty alone renders **No shared photos yet**. Available results match the main page item-for-item and in order. Do not render Guestbook or My deliveries in fullscreen.

Assert the paused copy string names new uploads and contains no phrasing that the event, gallery, or Guestbook is closed or offline.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/photo-intake-api.test.ts tests/worker/core-journey.test.ts tests/worker/messages-api.test.ts tests/worker/event-theme-api.test.ts -t 'guest read surfaces'
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'fullscreen'
```

Expected: FAIL — pause currently removes the secondary panels on the main page, and fullscreen resolves its gallery availability by a different rule than the main page does.

- [ ] **Step 3: Implement**

Implement `guestReadSurfaces` beside, not inside, the primary phase decision. Keep `photosOpen` and guest upload guards unchanged. Apply the same helper in the Gallery, My Deliveries `/event/:slug/contributions`, and Guestbook routes so direct calls cannot bypass the server projection. All three use the one shared conflict factory/code/message. `EventPage` renders secondary surfaces from `guestReadSurfaces`, renders the composer from primary upload state, and lets fullscreen keep its shell and reason without fetching unavailable Gallery data.

**Do not add panels to the fullscreen route.** If a change to it grows past the availability check and the gallery list, the fullscreen-scope ruling has been misread.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/photo-intake-api.test.ts tests/worker/core-journey.test.ts tests/worker/messages-api.test.ts tests/worker/event-theme-api.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/guest-before-start.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/guestbook.test.tsx tests/ui/event-theme-rendering.test.tsx
```

- [ ] **Step 5: Task review checkpoint**

Record the lifecycle matrix, route enforcement, exact-key fixtures, main/fullscreen parity, no-request, and legacy evidence. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 2: Pause and Resume, by name — and the ladder's last rung

**Files:**
- Modify: `src/components/ManagerPhotoIntakePanel.tsx`
- Modify: `tests/ui/manager-photo-intake.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**
- Controls and status read **Pause guest uploads** and **Resume guest uploads**. The status line says what is paused and what is not. Pause and Resume remain an explicit reversible state change on the safety ladder's first rung.
- At `153d05f` the four states in `ManagerPhotoIntakePanel` read *Open photo delivery now*, *Pause until the event starts*, *Pause photo delivery*, and *Reopen photo delivery*. All four labels and their status lines are in scope; renaming only the paired pause/resume labels would leave one panel saying two different things about one setting.

- [ ] **Step 1: Write the failing copy tests**

Assert the exact accessible names in both states, that the word **Reopen** no longer appears, that the status names guest uploads rather than "photo delivery" in the ambiguous sense, and that the control is reachable and at least 44 px at 390 px and 320 px.

- [ ] **Step 2: Write the failing ladder row**

This is the tenth rung the account lifecycle checkpoint deferred, and it is asserted here against the renamed control, using **that checkpoint's reversible contract verbatim** rather than a second one invented for pause. Add to `tests/ui/app.test.tsx`, beside the existing nine-rung table:

- activating **Pause guest uploads** issues **exactly one** request immediately, renders no confirmation and puts no dialog in the tree, and its feedback names guest uploads specifically;
- activating **Resume guest uploads** does the same;
- neither control ever renders a typed event-name field or a focused confirmation — a Pause that grew a confirmation fails this row, because immediacy is the rung's definition;
- with the rung asserted, the ladder table names all ten actions and no row is marked deferred.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-photo-intake.test.tsx -t 'Resume guest uploads'
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'safety ladder'
```

- [ ] **Step 4: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-photo-intake.test.tsx tests/ui/app.test.tsx
```

- [ ] **Step 5: Task review checkpoint**

Record exact copy, reversible rung, request timing, and responsive control evidence. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 3: True empty versus no results

**Files:**
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- True-empty Intake renders the heading **No photos yet**, the existing printable QR, and the promise:

  > Guests' photos arrive privately here.

  Its primary action opens the existing Share and print surface. Host upload is the **secondary** action and invokes the same control path as the toolbar's **Add photos**.
- A filtered empty result keeps **No matching photos** and its **Clear filters** action.
- C-50 is fixed only in `ManagerPage.renderMediaGrid`. True empty means `media.length === 0`, `status === 'all'`, and no `guestFilter`; any contributor or publication filter produces filtered empty. `ManagerPrivateGallery`/Library behavior is unchanged.

- [ ] **Step 1: Write the failing empty-state tests**

- zero media and no filter → **No photos yet**, the QR, the promise, a primary Share action, and a secondary host-upload action;
- zero results with a contributor filter or publication filter → **No matching photos** with **Clear filters** that clears the active filter and reloads Intake;
- the secondary action opens the same dialog the toolbar opens, and returns focus to whichever control invoked it;
- **Recently deleted** with nothing in it keeps its own existing empty state and is unaffected.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'Intake true empty'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'Intake (true empty|filtered empty)'
```

- [ ] **Step 4: Task review checkpoint**

Record `ManagerPage.renderMediaGrid` true/filtered empty and shared Add-photos path evidence, plus confirmation that Library files are unchanged. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 4: C-56 same-minute Gallery moment heading

**Files:**
- Modify: `src/features/gallery/gallery-timeline.ts`
- Modify: `tests/unit/gallery-timeline.test.ts`

**Interfaces:**
- `formatMomentHeading(moment, timeZone)` remains the scoped Gallery moment formatter. For a multi-photo same-day group, if formatted `startTime === endTime`, it renders that time once; a genuinely different formatted pair still uses `timeRange`. This task does not import or alter the C-61 formatter.

- [ ] **Step 1: Write the focused failing regression**

Create a two-photo group whose instants differ by seconds but format to the same minute in the event zone. Assert one time string, not `X–X`. Keep the existing one-photo, different-minute, different-meridiem, and cross-midnight expectations unchanged.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run --config vitest.config.ts tests/unit/gallery-timeline.test.ts -t 'collapses a multi-photo same-minute range'
```

Expected: FAIL because `timeRange(startTime, endTime)` currently duplicates equal formatted strings for multi-photo groups.

- [ ] **Step 3: Implement minimal equality collapse and verify GREEN**

In the same-day multi-photo branch, choose `startTime` when the formatted endpoints are identical; otherwise call the existing `timeRange`.

```bash
npx vitest run --config vitest.config.ts tests/unit/gallery-timeline.test.ts
```

- [ ] **Step 4: Task review checkpoint**

Record RED/GREEN and obtain fresh-implementer plus independent review that C-56 stayed isolated from C-61. Resolve P1/P2; do not stage or commit.

---

### Task 5: One event-zone formatter on the four C-61 surfaces

**Files:**
- Modify: `src/app/event-date-time.ts`
- Modify: `src/components/ManagerPhotoIntakePanel.tsx`
- Modify: `src/features/uploads/GuestUploadFlow.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/pages/HostEventsPage.tsx`
- Modify: `tests/unit/event-date-time.test.ts`
- Create: `tests/unit/slice5-date-formatting-ast.test.ts`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/host-events.test.tsx` *(created by the account lifecycle checkpoint)*

**Interfaces:**
- The four named surfaces call `formatEventDate`, `formatEventDateTime`, `formatEventTimeRange`, and `formatRetentionDate` from `src/app/event-date-time.ts`. No `Intl.DateTimeFormat`, `toLocaleDateString`, `toLocaleTimeString`, or `toLocaleString` date call remains in them.
- Equal start and end endpoints render one time, because `formatEventTimeRange` already collapses them.
- The targeted AST test parses only the four owning surface files: `ManagerPhotoIntakePanel.tsx` (Intake schedule), `ManagerPage.tsx` (Manager header/retention), `GuestUploadFlow.tsx` (upload flow), and `HostEventsPage.tsx` (Host Events). It rejects date-valued local formatter calls there and explicitly whitelists the existing numeric count `toLocaleString` receivers (`MAX_EVENT_MEDIA`, stored/held/recoverable/export counts). No fifth file is modified or parsed by C-61. This is not a broad zero-match text assertion.

- [ ] **Step 1: Write the failing zone and equality tests**

- an Intake schedule whose start and end are the same minute renders one time, not `X – X`;
- two endpoints seconds apart that format identically also render once;
- a genuinely different pair still renders the range;
- an event in `America/Chicago` viewed from a `UTC` test environment renders the **event's** day, not the viewer's — cover a DST forward boundary and a DST back boundary;
- the Host Events management expiry renders in the event zone, and a fixture proves the previous hard-coded `UTC` result is now wrong;
- an unreadable instant renders the existing `TIME_UNAVAILABLE` / `DATE_UNAVAILABLE` constants rather than throwing.

**Instant validation is part of this task, not an assumption of it.** `validInstant` in `src/app/event-date-time.ts` accepts whatever `Date.parse` accepts, and `Date.parse` is more permissive than the module's own documented rules. Probed directly at plan time, it accepts:

| Input | `Date.parse` | Why it is wrong here |
| --- | --- | --- |
| `2026-09-19` | UTC midnight | The module's first rule is that a calendar date is never interpreted as an instant. This is the exact bug `formatEventDate` exists to avoid, reintroduced through the instant path. |
| `2026-09-19T05:00:00` | the **runtime's** local zone | The second rule is that an instant always requires an explicit zone with no fallback to the machine zone. This silently takes one. |
| `2026-02-30T05:00:00Z` | rolls over to 2 March | A date that does not exist renders as a plausible different day rather than as unavailable. |

Expanding the formatter to four more surfaces while it still accepts these makes the promise that unreadable instants fail closed false on more screens than it is false on today. Add these cases before the conversion:

- each of the three inputs above returns `null`, and its surface renders `DATE_UNAVAILABLE` / `TIME_UNAVAILABLE`;
- an offset-bearing instant is accepted and rendered in the event zone — `Z`, `+00:00`, and a non-zero offset such as `-05:00` all work, and all three describing the same moment render identically;
- a calendar-valid leap day (`2028-02-29T…Z`) is accepted and a non-leap `2027-02-29T…Z` is not;
- every existing caller of the four formatters still renders exactly what it renders today, so the tightening is proved to reject only input that was already being rendered wrongly.

Tighten `validInstant` to require an explicit offset and a calendar-valid date rather than widening the callers' handling of a bad value.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/unit/event-date-time.test.ts tests/ui/app.test.tsx -t 'event zone'
```

- [ ] **Step 3: Implement, then prove the four-surface conversion with the AST audit**

```bash
npx vitest run --config vitest.config.ts tests/unit/slice5-date-formatting-ast.test.ts
```

Expected: PASS with every date-valued local call absent and every surviving numeric call matching the explicit receiver whitelist. `gallery-timeline.ts` is excluded because Task 4 owns C-56 independently.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/unit/event-date-time.test.ts tests/unit/slice5-date-formatting-ast.test.ts tests/ui/app.test.tsx tests/ui/host-events.test.tsx
```

- [ ] **Step 5: Task review checkpoint**

Record the four-surface formatter, AST whitelist, invalid-instant, DST, and equal-range evidence. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 6: A deterministic Guestbook default and the Album title

**Files:**
- Modify: `src/features/guestbook/manager-guestbook-state.ts`
- Modify: `worker/db/album.ts`
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `tests/ui/manager-guestbook.test.tsx`
- Modify: `tests/worker/album-api.test.ts`
- Modify: `tests/ui/album-workspace.test.tsx`

**Interfaces:**
- `manager-guestbook-state.ts` returns `'needs-review'` unconditionally as the default view. The summary no longer influences it.
- The Album title defaults to the **event name** through the current draft initialization. Clearing the title shows the event name as a placeholder and does not save an invalid empty value.

- [ ] **Step 1: Write the failing default tests**

- the default view is `needs-review` with zero pending items, with one, and with many;
- a summary refresh that changes counts does **not** change the current view;
- an explicitly chosen view survives a count change;
- a new Album's title equals the event name;
- clearing the title renders the event name as a placeholder, leaves the field invalid-empty unsaved, and the autosave queue sends no empty title;
- an existing Album whose title the host already customized is untouched.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-guestbook.test.tsx -t 'default view'
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts -t 'title'
```

Expected: both FAIL — `manager-guestbook-state.ts:29` branches on `needsReviewCount`, and `worker/db/album.ts:67` writes the literal `'Album'`.

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-guestbook.test.tsx tests/ui/album-workspace.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts
```

- [ ] **Step 4: Task review checkpoint**

Record deterministic Guestbook and authored-title-preservation evidence. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 7: Cover upload progress and cancel

**Files:**
- Modify: `src/features/cover/cover-draft-client.ts`
- Modify: `src/features/cover/use-cover-studio-session.ts`
- Modify: `src/features/cover/CoverStudio.tsx`
- Modify: `tests/ui/cover-studio-session.test.tsx`
- Modify: `tests/ui/cover-studio.test.tsx`

**Ownership ruling.** `cover-operation-controller.ts` is **not** the owner of this work and must not be modified for it. It owns one accepted *publication receipt* — dispatch, `preparing`, `applied`, conflict, and retry — a lifecycle that begins after `POST .../cover/publications` returns `202` and has nothing to do with sending source bytes. The raw upload belongs to `use-cover-studio-session.ts`: `runDraft` there calls `transferCoverDraft` (the raw PUT) and then `inspectCoverDraft`, holds the per-attempt `generationRef` that already retires stale results, owns the preview `AbortController` map, and owns the discard reconciliation a cancel has to leave consistent. Wiring byte progress into the publication controller would put the state in a component that never sees the transfer and would need a second abort owner beside the one that already exists — the exact duplication the spec's "extend the existing controller" sentence is trying to prevent. The spec's intent is *one owner per lifecycle*; for source bytes that owner is the session hook.

**Interfaces:**
- The reservation, raw transfer, and inspection accept the same per-attempt signal; the raw `PUT .../drafts/:id/raw` reports determinate byte progress:

```ts
export async function createCoverDraft(
  options: CreateCoverDraftOptions & { signal?: AbortSignal },
): Promise<CoverDraftReservation>;

export async function transferCoverDraft(options: {
  eventId: string;
  draft: CoverDraftView;
  file: File;
  signal: AbortSignal;
  onProgress(sentBytes: number, totalBytes: number): void;
}): Promise<CoverDraftView>;

export async function inspectCoverDraft(
  eventId: string,
  draft: CoverDraftView,
  signal?: AbortSignal,
): Promise<CoverDraftView>;
```

`CoverDraftSessionState` — today `{ status: 'idle' | 'loading' | 'ready' | 'error' }` — gains one transfer-bearing member so `CoverStudio` renders progress from the state it already consumes as `composeState`:

```ts
export type CoverDraftSessionState =
  | { status: 'idle'; error: null }
  | { status: 'loading'; error: null }
  | { status: 'transferring'; error: null; sentBytes: number; totalBytes: number }
  | { status: 'ready'; error: null }
  | { status: 'error'; error: unknown };
```

  `transferring` is a substate of the existing `loading` phase, not a new phase beside it: every consumer that treats `loading` as "work in progress" must treat `transferring` the same way. Do not add a second controller, a second abort owner, or a second polling scheduler; reuse `runDraft`'s existing generation guard so a late progress event from a retired attempt updates nothing.
- `use-cover-studio-session` owns exactly one `AbortController` per draft attempt, created before reservation and retained across raw transfer and inspection. The publication controller is unchanged and never receives this controller.
- Cancel order is exact: retire the attempt generation; abort its controller; await the attempt promise settlement; replay only an ambiguous reservation with the same intent key; reread the authoritative draft; then enter the existing serialized discard reconciliation. Late transfer progress and late inspection results check both abort and generation and update nothing.

- [ ] **Step 1: Write the failing progress and cancel tests**

- a 19 MB upload reports monotonically increasing determinate progress and reaches its total;
- the progress value is announced politely and does not spam the live region on every event;
- Cancel during transfer aborts the request, returns to the picker, and issues no follow-up polling;
- Cancel after the bytes land but before inspection completes resolves without claiming a failure the server did not report;
- Cancel after the reservation commit but before its response is observed replays the same intent key exactly once, rereads the returned authoritative draft, then discards it; a known reservation is not replayed;
- late transfer progress and inspection completion after cancel do not change session state, preview, focus, or publication state;
- a network failure mid-transfer offers the existing retry path rather than a new one;
- Cancel restores focus to the control that started the upload.

Put the reservation/transfer/inspection cancellation rows in `tests/ui/cover-studio-session.test.tsx` under the exact describe name `cover draft cancel ordering`; keep visual progress/announcement rows in `tests/ui/cover-studio.test.tsx` under `cover upload progress`.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx -t 'cover upload progress'
npx vitest run --config vitest.config.ts tests/ui/cover-studio-session.test.tsx -t 'cover draft cancel ordering'
```

Expected: both commands FAIL for the intended missing behavior before `cover-draft-client.ts` or `use-cover-studio-session.ts` changes. The first lacks determinate progress; the second lacks the one-controller cancel ordering and ambiguous-reservation recovery.

- [ ] **Step 3: Implement and verify GREEN**

Create the attempt controller in `runDraft` before reservation, pass its signal to all three calls through the exact interfaces above, and keep the attempt promise in the hook until settlement. Use `XMLHttpRequest`'s `upload.onprogress` for the raw PUT and the same credential-header helper the Manager upload transport extracted. Implement Cancel in the exact retire → abort → await → ambiguous replay → authoritative reread → existing discard order; do not change `cover-operation-controller.ts` or publication ownership.

```bash
npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx
```

- [ ] **Step 4: Task review checkpoint**

Record one-attempt-controller, exact cancel ordering, ambiguous reservation, late-result, progress, and unchanged publication-owner evidence. Obtain fresh-implementer and independent review; resolve P1/P2. Do not stage or commit.

---

### Task 8: Slice 5 evidence and closing gates

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/guest-responsive.spec.ts`
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Extend the named Axe inventory**

Add gated Axe states for true-empty Intake, paused guest main page, paused guest fullscreen, and the Cover upload progress state. Update the exact-order inventory assertion in the same commit.

- [ ] **Step 2: Record the remaining Slice 5 findings**

**Write** C-08's row — it does not exist yet, by the row-completeness ruling the first checkpoint recorded: no earlier checkpoint wrote a partial C-08 row, and its server half was recorded as progress prose instead. C-08 closes here, so its single row must name all three halves and their tests: the server pause split and its authority-selected intake predicate from the first checkpoint, the always-available Intake trigger from the dialog checkpoint, and this checkpoint's guest-surface and fullscreen-Gallery parity. State the fullscreen-scope ruling in that row — that the route's parity obligation is Gallery availability and projection, not panel duplication — so a later reader does not read its absent Guestbook and My deliveries panels as an unfinished half of C-08.

**Write** C-16's row for the same reason. The account lifecycle checkpoint built the ladder and asserted nine rungs, recording that as progress prose rather than a row, because its tenth rung named copy that did not exist yet. C-16 closes here, so its single row names both halves: that checkpoint's nine-rung table and its per-rung request-timing contracts, and this checkpoint's renamed Pause / Resume controls with the tenth rung asserted against them — naming the owning test files from both.

Then add C-50, C-53, C-55, C-56, C-57, C-58, and C-61. C-50 names `ManagerPage.renderMediaGrid` and proves Library unchanged. C-56 names the independent two-photo same-minute `gallery-timeline` regression. C-61 names only its four surfaces, the targeted AST audit with numeric `toLocaleString` whitelist, and `validInstant`'s explicit-offset/calendar-valid rules; surviving out-of-scope or numeric formatter calls are not unfinished work.

- [ ] **Step 3: Confirm the Slice 5 section is complete**

All sixteen Slice 5 findings — C-08, C-09, C-10, C-12, C-16, C-17, C-49, C-50, C-52, C-53, C-55, C-56, C-57, C-58, C-59, C-61 — must now have **exactly one matrix row each** in the Slice 5 section, carrying one of the four permitted dispositions and a named owning test file.

A bare `rg` count cannot check that. It counts every `C-xx` in the file — including the ones in the Slice 5 section's progress prose, in other slices' sections, and in "does not own C-xx" boundary sentences — so a finding mentioned three times in prose and never given a row still reports a healthy count of three. Parse the rows instead:

```bash
node --input-type=module -e '
const fs = await import("node:fs/promises");
const doc = await fs.readFile("docs/superpowers/host-gallery-verification-matrix.md", "utf8");
const section = doc.split(/^## /m).find((s) => s.startsWith("Slice 5"));
if (!section) throw new Error("no Slice 5 section");
const DISPOSITIONS = ["verified-existing", "implemented", "deferred-approved", "out-of-scope-approved"];
const rows = new Map();
for (const line of section.split("\n")) {
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  if (cells.length < 4) continue;
  const finding = cells[0].match(/\bC-(\d\d)\b/);
  if (!finding) continue;
  const id = "C-" + finding[1];
  const disposition = DISPOSITIONS.find((d) => cells[1].includes(d));
  const tests = [...cells[3].matchAll(/tests\/\S+?\.(?:test|spec)\.[tj]sx?/g)].map((m) => m[0]);
  if (!rows.has(id)) rows.set(id, []);
  rows.get(id).push({ disposition, tests });
}
const EXPECTED = ["08","09","10","12","16","17","49","50","52","53","55","56","57","58","59","61"].map((n) => "C-" + n);
const problems = [];
for (const id of EXPECTED) {
  const found = rows.get(id) ?? [];
  if (found.length === 0) problems.push(`${id}: no matrix row`);
  else if (found.length > 1) problems.push(`${id}: ${found.length} rows, expected exactly 1`);
  else {
    const [row] = found;
    if (!row.disposition) problems.push(`${id}: disposition is not one of the four permitted values`);
    if (row.tests.length === 0) problems.push(`${id}: names no owning test file`);
  }
}
for (const id of rows.keys()) if (!EXPECTED.includes(id)) problems.push(`${id}: unexpected row in the Slice 5 section`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`Slice 5: all ${EXPECTED.length} findings have exactly one complete row.`);
'
```

Expected: exit zero and the summary line. Every failure it reports is a real gap — a missing row, a duplicate, an invented disposition, or a row with no owning test — and must be fixed rather than argued past. The named test files it finds must also exist on disk and contain a test that fails without this slice's change; the script proves the row's shape, not the test's content.

Validated against the Slice 1 section at plan time: it reads all six of that section's finding rows with their dispositions and test files, and correctly ignores the section's prose and its two-column named-expansion tables. If Slice 5 adds a four-column sub-table that mentions a finding, that sub-table's rows will be counted too — put named expansions in narrower tables, as Slice 1 does, rather than loosening the gate.

- [ ] **Step 4: Update the repository guidance**

In `CLAUDE.md`, correct the pause description to guest-uploads-only, note the fullscreen route shares the main page's projection, and record the one canonical event-zone formatter for host surfaces.

- [ ] **Step 5: Run the complete Slice 5 gates**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0021.test.ts tests/worker/manager-upload-actor.test.ts tests/worker/manager-upload-api.test.ts tests/worker/upload-api.test.ts tests/worker/photo-intake-api.test.ts tests/worker/manage-api.test.ts tests/worker/auth-api.test.ts tests/worker/repositories.test.ts tests/worker/event-theme-api.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/album-api.test.ts tests/worker/album-share-api.test.ts tests/worker/media-recovery-api.test.ts tests/worker/export-api.test.ts tests/worker/host-auth.test.ts tests/worker/host-auth-boundary.test.ts tests/worker/core-journey.test.ts tests/worker/messages-api.test.ts
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts tests/unit/upload-queue.test.ts tests/unit/upload-flow-ownership.test.ts tests/unit/manager-upload-cleanup.test.ts tests/unit/browser-upload-transport.test.ts tests/unit/host-upload-availability.test.ts tests/unit/manager-event-merge.test.ts tests/unit/pending-registration.test.ts tests/unit/recovery.test.ts tests/unit/gallery-timeline.test.ts tests/unit/event-date-time.test.ts tests/unit/slice5-date-formatting-ast.test.ts
npx vitest run --config vitest.config.ts tests/ui/manager-upload-dialog.test.tsx tests/ui/modal-surface.test.tsx tests/ui/gallery-viewer.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx tests/ui/album-workspace.test.tsx tests/ui/host-auth.test.tsx tests/ui/host-events.test.tsx tests/ui/copyable-link-card.test.tsx tests/ui/manager-photo-intake.test.tsx tests/ui/manager-guestbook.test.tsx tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx
npx vitest run --config vitest.config.ts tests/unit/event-settings-draft.test.ts tests/ui/event-settings-editor.test.tsx tests/ui/host-private-gallery.test.tsx tests/ui/manager-rsvp-panel.test.tsx tests/ui/event-appearance-editor.test.tsx
npx playwright test tests/e2e/event-cover-studio.spec.ts --project=desktop
npx playwright test tests/e2e/accessibility.spec.ts tests/e2e/manager-responsive.spec.ts --project=desktop -g "(Manager upload|paused guest|true-empty Intake|Cover upload|Rotate management link|Host Events|pending registration)"
npx playwright test tests/e2e/manager-responsive.spec.ts tests/e2e/guest-responsive.spec.ts --project=mobile -g "(Manager upload cleanup retry at 320|paused guest|true-empty Intake|Cover upload)"
npx playwright test tests/e2e/manager-navigation-intents.spec.ts tests/e2e/core-journey.spec.ts --project=desktop -g "(rotation save gate|guest read surfaces)"
git diff --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | xargs -r npx eslint --
git diff --check -- migrations/0021_manager_upload_and_album_era.sql shared src worker tests docs/superpowers/host-gallery-verification-matrix.md docs/operations.md docs/deployment.md docs/security.md CLAUDE.md
```

Expected: every focused command exits zero, followed by the Step 3 matrix parser. Do not substitute a full test, build, lint, typecheck, E2E, or migration run.

- [ ] **Step 6: Final Slice review and single-commit handoff**

Run the scoped `git diff --check`, confirm every task's fresh-implementer and independent review record is present, and obtain one final independent Slice review. Resolve every P1/P2. Keep the diff uncommitted during review; only the release owner may then stage the reviewed Slice 5 change set and create the Slice's single final commit. Do not push. Slice 6 remains separate.

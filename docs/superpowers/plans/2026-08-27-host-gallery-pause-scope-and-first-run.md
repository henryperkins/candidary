# Host Gallery Pause Scope and First Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use test-driven development, preserve all existing Slice 1–4 work, and do not commit unless the user asks.

**Goal:** Make Pause mean one thing on every guest surface, finish the safety ladder by naming its last rung after what it actually pauses, make an empty Intake say what is actually true, and close the deterministic-polish findings that make the Manager read like two products.

**Architecture:** The server already gates guest uploads and nothing else after the first Slice 5 checkpoint; this checkpoint makes the guest *surfaces* agree, including the fullscreen route, whose Gallery availability currently resolves by a different rule than the main page's. Renaming the pause controls is what finally lets the safety ladder's last rung be asserted, which is why C-16 closes here rather than in the checkpoint that built the other nine. Everything else here is subtraction: one canonical event-zone formatter replaces four component-local locale calls, one deterministic Guestbook default replaces a count-dependent one, and the Cover upload's byte progress lands in the session hook that already owns the raw transfer rather than in a second controller.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, React 19, Vitest with `vitest-pool-workers` and Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- **Depends on** `2026-08-27-host-gallery-account-lifecycle-and-rotation.md` for the safety ladder's nine asserted rungs and its typed and focused confirmation components. This checkpoint adds the tenth rung and closes C-16; it does not rebuild the ladder or restate the other nine contracts.
- **Depends on** `2026-08-27-host-gallery-manager-upload-authority.md` for the server-side pause split, and on `2026-08-27-host-gallery-manager-upload-dialog.md` for two things: the Intake **Add photos** trigger that the true-empty secondary action reuses, and the same-origin credential-header helper that checkpoint extracts from `src/app/api.ts`, which Task 6's XHR raw upload reuses rather than re-deriving.
- No migration, no new Worker route, and no new client route belong to this checkpoint.
- **Formatter scope ruling.** C-61 and the slice spec name exactly four surfaces: Intake schedule, Manager header and retention, the upload flow, and Host Events. Convert those and no others. `src/features/gallery/gallery-timeline.ts` keeps its own tested moment formatter, and `src/components/EventAppearanceCanvas.tsx` and `src/components/GuestEventHero.tsx` render artwork and guest hero copy that Slice 5 does not own. Record this ruling in the checkpoint report; do not opportunistically convert them.
- `src/components/HostAuthNav.tsx` currently formats an expiry with a hard-coded `timeZone: 'UTC'`. That is a defect this checkpoint fixes, not a convention to preserve.
- Equal upload-time endpoints already collapse inside `formatEventTimeRange`. Route the affected callers through it rather than adding a second equality check at a call site.
- Paused copy names only new uploads. It may never imply the event or any other guest surface is offline.
- The main guest page and the fullscreen route must use the **same** availability rules and the same projection. Do not add a fullscreen-specific rule.
- **Fullscreen-scope ruling.** "Same projection" is about the Gallery, not about the page. The specification lists what an event guest retains while paused — the event shell and receipt, My deliveries, Guestbook, the Guest gallery when its own setting is on, and "fullscreen Gallery **through the same projection**" — and then says the two routes "use the same availability rules." It does not say the fullscreen route renders the main page's panels, and it never has: `/event/:slug/fullscreen` deliberately renders a screen-reader `h1`, a compact bar with the close control, and the gallery grid, and nothing else. That is the whole point of the route. Requiring Guestbook and My deliveries there would not close C-08; it would replace a deliberate design with a duplicated page, and the test asserting it would be asserting the wrong thing. Parity is asserted where it exists: **which photos the Gallery shows, and whether it is available at all**, must be identical on both routes for every cell of the matrix. The main route additionally keeps its secondary panels. Record this ruling in the checkpoint report.
- Guest gallery availability remains an independent setting. Pause must not switch it, and Settings remains its sole owner.
- Every behavior change follows RED → GREEN → REFACTOR.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-pause-scope-and-first-run/`, then take an independent spec and code review. Fix every P1/P2 before advancing.

## Checkpoint boundary

This is the final Slice 5 checkpoint. It owns C-08 (guest surfaces), C-16, C-50, C-53, C-55, C-56, C-57, C-58, and C-61, and it closes the Slice 5 matrix section. It does **not** own anything in Slice 6.

C-16 arrives here by the account checkpoint's ladder-ownership ruling. That checkpoint builds the safety ladder and asserts nine of its ten rungs; the tenth — **Pause / Resume guest uploads** — could not be asserted there because its control still read *Pause photo delivery* / *Reopen photo delivery* and the rename is Task 2 of this checkpoint. This checkpoint therefore asserts that last rung against the renamed control and writes C-16's single matrix row naming both halves.

---

### Task 1: Pause is guest uploads, on every guest surface

**Files:**
- Modify: `worker/routes/event.ts`
- Modify: `shared/rsvp.ts` *(only if `resolveGuestEventPhase` conflates the two)*
- Modify: `src/pages/EventPage.tsx`
- Modify: `tests/worker/photo-intake-api.test.ts`
- Modify: `tests/worker/core-journey.test.ts`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/core-journey.spec.ts`

**Interfaces:**
- No contract change. While guest uploads are paused, an authenticated event guest retains read access to the event shell and its existing delivery receipt, My deliveries, Guestbook content allowed by its own moderation state, the Guest gallery when its independent setting is on, and the fullscreen Gallery through the same projection.
- The guest upload composer, and only the composer, is withheld.

- [ ] **Step 1: Write the failing guest-surface matrix**

Build one table driven over `{ paused, guestGalleryOn, guestbookState }` and, for each cell, assert both routes against the scope the fullscreen-scope ruling fixes.

*On the main guest page,* assert the full retained set: with `paused: true, guestGalleryOn: true` the Guest gallery, Guestbook, and My deliveries are all present, and **only** the composer is absent. Assert the absence of the composer specifically rather than the absence of an upload heading, so a panel that merely lost its title still fails.

*On `/event/:slug/fullscreen`,* assert **Gallery projection parity** — the contract the specification actually states. For every cell: the route is reachable exactly when the Guest gallery is available on the main page and refuses exactly when it is not; the photo set it renders is identical to the main page's Guest gallery for that cell, item for item and in the same order; and pausing changes neither, because pause is not a gallery setting. Also assert what the route legitimately does not have: it renders no upload composer, and its close control still returns to the main page. Do **not** assert Guestbook or My deliveries there — they have never been on that route, and the ruling above explains why requiring them would be asserting a different product.

Assert the paused copy string names new uploads and contains no phrasing that the event, gallery, or Guestbook is closed or offline.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/photo-intake-api.test.ts -t 'paused guest surfaces'
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'fullscreen'
```

Expected: FAIL — pause currently removes the secondary panels on the main page, and fullscreen resolves its gallery availability by a different rule than the main page does.

- [ ] **Step 3: Implement**

Make one projection serve both routes. If `resolveGuestEventPhase` conflates "photos open" with "surfaces available," separate the two there and keep `photosOpen` meaning exactly what `UploadService` already relies on. The fullscreen branch in `EventPage` reads gallery availability and the gallery list from that same projection instead of deciding for itself; its rendered structure is otherwise untouched.

**Do not add panels to the fullscreen route.** If a change to it grows past the availability check and the gallery list, the fullscreen-scope ruling has been misread.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/photo-intake-api.test.ts tests/worker/core-journey.test.ts
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add worker/routes/event.ts shared/rsvp.ts src/pages/EventPage.tsx tests/worker/photo-intake-api.test.ts tests/worker/core-journey.test.ts tests/ui/app.test.tsx tests/e2e/core-journey.spec.ts
git commit -m "fix: pause only guest uploads"
```

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

- [ ] **Step 5: Commit**

```bash
git add src/components/ManagerPhotoIntakePanel.tsx tests/ui/manager-photo-intake.test.tsx tests/ui/app.test.tsx tests/e2e/accessibility.spec.ts
git commit -m "fix: name the pause control after its scope"
```

---

### Task 3: True empty versus no results

**Files:**
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `tests/ui/host-private-gallery.test.tsx`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- True-empty Intake renders the heading **No photos yet**, the existing printable QR, and the promise:

  > Guests' photos arrive privately here.

  Its primary action opens the existing Share and print surface. Host upload is the **secondary** action and invokes the same control path as the toolbar's **Add photos**.
- A filtered empty result keeps **No matching photos** and its **Clear filters** action.

- [ ] **Step 1: Write the failing empty-state tests**

- zero media and no filter → **No photos yet**, the QR, the promise, a primary Share action, and a secondary host-upload action;
- zero results with a contributor filter, a publication filter, or a search term → **No matching photos** with **Clear filters**;
- the secondary action opens the same dialog the toolbar opens, and returns focus to whichever control invoked it;
- **Recently deleted** with nothing in it keeps its own existing empty state and is unaffected.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/host-private-gallery.test.tsx -t 'No photos yet'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/host-private-gallery.test.tsx tests/ui/app.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/features/gallery/ManagerPrivateGallery.tsx src/pages/ManagerPage.tsx tests/ui/host-private-gallery.test.tsx tests/ui/app.test.tsx
git commit -m "fix: split true-empty intake from no results"
```

---

### Task 4: One event-zone formatter

**Files:**
- Modify: `src/app/event-date-time.ts`
- Modify: `src/components/ManagerPhotoIntakePanel.tsx`
- Modify: `src/components/HostAuthNav.tsx`
- Modify: `src/features/uploads/GuestUploadFlow.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/pages/HostEventsPage.tsx`
- Modify: `tests/unit/event-date-time.test.ts`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/host-events.test.tsx` *(created by the account lifecycle checkpoint)*

**Interfaces:**
- The four named surfaces call `formatEventDate`, `formatEventDateTime`, `formatEventTimeRange`, and `formatRetentionDate` from `src/app/event-date-time.ts`. No `Intl.DateTimeFormat`, `toLocaleDateString`, `toLocaleTimeString`, or `toLocaleString` date call remains in them.
- Equal start and end endpoints render one time, because `formatEventTimeRange` already collapses them.

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

- [ ] **Step 3: Implement, then prove the conversion is complete**

```bash
rg -n "toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat" src/components/ManagerPhotoIntakePanel.tsx src/components/HostAuthNav.tsx src/features/uploads/GuestUploadFlow.tsx src/pages/ManagerPage.tsx src/pages/HostEventsPage.tsx
```

Expected: no matches. The formatter-scope ruling above explains why `gallery-timeline.ts`, `EventAppearanceCanvas.tsx`, and `GuestEventHero.tsx` still match elsewhere.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/unit/event-date-time.test.ts tests/ui/app.test.tsx tests/ui/host-events.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/app/event-date-time.ts src/components/ManagerPhotoIntakePanel.tsx src/components/HostAuthNav.tsx src/features/uploads/GuestUploadFlow.tsx src/pages/ManagerPage.tsx src/pages/HostEventsPage.tsx tests/unit/event-date-time.test.ts tests/ui/app.test.tsx tests/ui/host-events.test.tsx
git commit -m "fix: read every host date in the event's own zone"
```

---

### Task 5: A deterministic Guestbook default and the Album title

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

- [ ] **Step 4: Commit**

```bash
git add src/features/guestbook/manager-guestbook-state.ts worker/db/album.ts src/features/gallery/ManagerAlbum.tsx tests/ui/manager-guestbook.test.tsx tests/worker/album-api.test.ts tests/ui/album-workspace.test.tsx
git commit -m "fix: settle the guestbook default and the album title"
```

---

### Task 6: Cover upload progress and cancel

**Files:**
- Modify: `src/features/cover/cover-draft-client.ts`
- Modify: `src/features/cover/use-cover-studio-session.ts`
- Modify: `src/features/cover/CoverStudio.tsx`
- Modify: `tests/ui/cover-studio-session.test.tsx`
- Modify: `tests/ui/cover-studio.test.tsx`

**Ownership ruling.** `cover-operation-controller.ts` is **not** the owner of this work and must not be modified for it. It owns one accepted *publication receipt* — dispatch, `preparing`, `applied`, conflict, and retry — a lifecycle that begins after `POST .../cover/publications` returns `202` and has nothing to do with sending source bytes. The raw upload belongs to `use-cover-studio-session.ts`: `runDraft` there calls `transferCoverDraft` (the raw PUT) and then `inspectCoverDraft`, holds the per-attempt `generationRef` that already retires stale results, owns the preview `AbortController` map, and owns the discard reconciliation a cancel has to leave consistent. Wiring byte progress into the publication controller would put the state in a component that never sees the transfer and would need a second abort owner beside the one that already exists — the exact duplication the spec's "extend the existing controller" sentence is trying to prevent. The spec's intent is *one owner per lifecycle*; for source bytes that owner is the session hook.

**Interfaces:**
- The raw `PUT .../drafts/:id/raw` reports determinate byte progress and is cancellable. `transferCoverDraft` gains an optional progress callback and an `AbortSignal`; `CoverDraftSessionState` — today `{ status: 'idle' | 'loading' | 'ready' | 'error' }` — gains one transfer-bearing member so `CoverStudio` renders progress from the state it already consumes as `composeState`:

```ts
export type CoverDraftSessionState =
  | { status: 'idle'; error: null }
  | { status: 'loading'; error: null }
  | { status: 'transferring'; error: null; sentBytes: number; totalBytes: number }
  | { status: 'ready'; error: null }
  | { status: 'error'; error: unknown };
```

  `transferring` is a substate of the existing `loading` phase, not a new phase beside it: every consumer that treats `loading` as "work in progress" must treat `transferring` the same way. Do not add a second controller, a second abort owner, or a second polling scheduler; reuse `runDraft`'s existing generation guard so a late progress event from a retired attempt updates nothing.
- Cancel aborts the in-flight request through the session's existing abort ownership, restores the picker, and leaves no partially written draft the host cannot escape — it must route through the hook's `discard` path, which already serializes against `discardingRef`, rather than dropping the draft on the floor.

- [ ] **Step 1: Write the failing progress and cancel tests**

- a 19 MB upload reports monotonically increasing determinate progress and reaches its total;
- the progress value is announced politely and does not spam the live region on every event;
- Cancel during transfer aborts the request, returns to the picker, and issues no follow-up polling;
- Cancel after the bytes land but before inspection completes resolves without claiming a failure the server did not report;
- a network failure mid-transfer offers the existing retry path rather than a new one;
- Cancel restores focus to the control that started the upload.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx -t 'progress'
```

- [ ] **Step 3: Implement and verify GREEN**

Use `XMLHttpRequest`'s `upload.onprogress` for the raw PUT, reusing the same credential-header helper the Manager upload transport extracted, so the two byte-carrying requests do not derive headers differently.

```bash
npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/features/cover/cover-draft-client.ts src/features/cover/use-cover-studio-session.ts src/features/cover/CoverStudio.tsx tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx
git commit -m "feat: show cover upload progress and let it be cancelled"
```

---

### Task 7: Slice 5 evidence and closing gates

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

Then add C-50, C-53, C-55, C-56, C-57, C-58, and C-61. State the formatter-scope ruling in the C-61 row so a later reader does not read the surviving `Intl` call sites as an unfinished conversion, and state in the same row that `validInstant` now requires an explicit offset and a calendar-valid date, so the fail-closed promise is recorded as proved rather than assumed.

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
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run verify:bindings
npm test
npm run build
CI_BASE_SHA="$(git merge-base origin/main HEAD)" CI_HEAD_SHA="$(git rev-parse HEAD)" npm run ci:migrations
npm run test:e2e
git diff --check
```

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 6: Commit the record**

```bash
git add tests/e2e/accessibility.spec.ts tests/e2e/guest-responsive.spec.ts docs/superpowers/host-gallery-verification-matrix.md CLAUDE.md
git commit -m "docs: close the slice 5 verification record"
```

Do not push. Slice 6, scale and resilience, is the last slice in the program.

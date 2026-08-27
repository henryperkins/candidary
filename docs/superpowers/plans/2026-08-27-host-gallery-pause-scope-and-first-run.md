# Host Gallery Pause Scope and First Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use test-driven development, preserve all existing Slice 1–4 work, and do not commit unless the user asks.

**Goal:** Make Pause mean one thing on every guest surface, make an empty Intake say what is actually true, and close the six deterministic-polish findings that make the Manager read like two products.

**Architecture:** The server already gates guest uploads and nothing else after the first Slice 5 checkpoint; this checkpoint makes the guest *surfaces* agree, including the fullscreen route, which currently follows a different rule. Everything else here is subtraction: one canonical event-zone formatter replaces four component-local locale calls, one deterministic Guestbook default replaces a count-dependent one, and the Cover upload's existing operation controller gains byte progress rather than a second controller.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, React 19, Vitest with `vitest-pool-workers` and Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- **Depends on** `2026-08-27-host-gallery-manager-upload-authority.md` for the server-side pause split and `2026-08-27-host-gallery-manager-upload-dialog.md` for the Intake **Add photos** trigger that the true-empty secondary action reuses.
- No migration, no new Worker route, and no new client route belong to this checkpoint.
- **Formatter scope ruling.** C-61 and the slice spec name exactly four surfaces: Intake schedule, Manager header and retention, the upload flow, and Host Events. Convert those and no others. `src/features/gallery/gallery-timeline.ts` keeps its own tested moment formatter, and `src/components/EventAppearanceCanvas.tsx` and `src/components/GuestEventHero.tsx` render artwork and guest hero copy that Slice 5 does not own. Record this ruling in the checkpoint report; do not opportunistically convert them.
- `src/components/HostAuthNav.tsx` currently formats an expiry with a hard-coded `timeZone: 'UTC'`. That is a defect this checkpoint fixes, not a convention to preserve.
- Equal upload-time endpoints already collapse inside `formatEventTimeRange`. Route the affected callers through it rather than adding a second equality check at a call site.
- Paused copy names only new uploads. It may never imply the event or any other guest surface is offline.
- The main guest page and the fullscreen route must use the **same** availability rules and the same projection. Do not add a fullscreen-specific rule.
- Guest gallery availability remains an independent setting. Pause must not switch it, and Settings remains its sole owner.
- Every behavior change follows RED → GREEN → REFACTOR.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-pause-scope-and-first-run/`, then take an independent spec and code review. Fix every P1/P2 before advancing.

## Checkpoint boundary

This is the final Slice 5 checkpoint. It owns C-08 (guest surfaces), C-50, C-53, C-55, C-56, C-57, C-58, and C-61, and it closes the Slice 5 matrix section. It does **not** own anything in Slice 6.

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

Build one table driven over `{ paused, guestGalleryOn, guestbookState }` and, for each cell, assert what the main guest page renders **and** what `/event/:slug/fullscreen` renders. The two must agree for every cell. Assert specifically that with `paused: true, guestGalleryOn: true` the Guest gallery, Guestbook, and My deliveries are all present on both routes, and only the composer is absent.

Assert the paused copy string names new uploads and contains no phrasing that the event, gallery, or Guestbook is closed or offline.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/photo-intake-api.test.ts -t 'paused guest surfaces'
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'fullscreen'
```

Expected: FAIL — pause currently removes the secondary panels on the main page, and fullscreen follows a different rule.

- [ ] **Step 3: Implement**

Make one projection serve both routes. If `resolveGuestEventPhase` conflates "photos open" with "surfaces available," separate the two there and keep `photosOpen` meaning exactly what `UploadService` already relies on.

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

### Task 2: Pause and Resume, by name

**Files:**
- Modify: `src/components/ManagerPhotoIntakePanel.tsx`
- Modify: `tests/ui/manager-photo-intake.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/e2e/accessibility.spec.ts`

**Interfaces:**
- Controls and status read **Pause guest uploads** and **Resume guest uploads**. The status line says what is paused and what is not. Pause and Resume remain an explicit reversible state change on the safety ladder's first rung.

- [ ] **Step 1: Write the failing copy tests**

Assert the exact accessible names in both states, that the word **Reopen** no longer appears, that the status names guest uploads rather than "photo delivery" in the ambiguous sense, and that the control is reachable and at least 44 px at 390 px and 320 px.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-photo-intake.test.tsx -t 'Resume guest uploads'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/manager-photo-intake.test.tsx tests/ui/app.test.tsx
```

- [ ] **Step 4: Commit**

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
git add src/components/ManagerPhotoIntakePanel.tsx src/components/HostAuthNav.tsx src/features/uploads/GuestUploadFlow.tsx src/pages/ManagerPage.tsx src/pages/HostEventsPage.tsx tests/unit/event-date-time.test.ts tests/ui/app.test.tsx tests/ui/host-events.test.tsx
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
- Modify: `src/features/cover/cover-operation-controller.ts`
- Modify: `src/features/cover/CoverStudio.tsx`
- Modify: `tests/ui/cover-studio-session.test.tsx`
- Create: `tests/unit/cover-operation-controller.test.ts`
- Modify: `tests/ui/cover-studio.test.tsx`

**Interfaces:**
- The raw `PUT .../drafts/:id/raw` reports determinate byte progress and is cancellable. Extend the **existing** operation controller's state with an upload phase carrying `{ sentBytes, totalBytes }`; do not add a second controller, a second abort owner, or a second polling scheduler.
- Cancel aborts the in-flight request, restores the picker, and leaves no partially written draft the host cannot escape.

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
npx vitest run --config vitest.config.ts tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx tests/unit/cover-operation-controller.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/features/cover/cover-draft-client.ts src/features/cover/cover-operation-controller.ts src/features/cover/CoverStudio.tsx tests/unit/cover-operation-controller.test.ts tests/ui/cover-studio.test.tsx tests/ui/cover-studio-session.test.tsx
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

Complete C-08 and add C-50, C-53, C-55, C-56, C-57, C-58, and C-61. State the formatter-scope ruling in the C-61 row so a later reader does not read the surviving `Intl` call sites as an unfinished conversion.

- [ ] **Step 3: Confirm the Slice 5 section is complete**

All sixteen Slice 5 findings — C-08, C-09, C-10, C-12, C-16, C-17, C-49, C-50, C-52, C-53, C-55, C-56, C-57, C-58, C-59, C-61 — must now appear exactly once across the five checkpoints, each with a disposition and a named owning test.

```bash
rg -o 'C-(08|09|10|12|16|17|49|50|52|53|55|56|57|58|59|61)' docs/superpowers/host-gallery-verification-matrix.md | sort | uniq -c
```

Expected: each of the sixteen appears at least once; no finding is missing. Investigate any finding whose only appearance is inside prose rather than a matrix row.

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

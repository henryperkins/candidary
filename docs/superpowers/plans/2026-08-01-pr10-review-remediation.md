# PR #10 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every blocking finding from the review of PR #10 without weakening the approved autosave, RSVP, durable-entry, or recovery contracts.

**Architecture:** Keep the existing two serialized autosave domains and API surface. Repair queue equivalence at the semantic-key boundary, associate settings responses with the exact field generations sent, make legacy-entry adoption conditional at SQL execution time, and merge event fields according to their actual writers. Preserve manager recovery notices until recovery or explicit dismissal, and treat an untouched legacy null deadline as a confirmed baseline rather than a local edit.

**Tech Stack:** React 19, TypeScript 6, Vitest, Testing Library, Hono, Cloudflare Workers, D1/SQLite.

## Global Constraints

- Write and run a failing regression before each production change.
- Keep `PATCH /settings`, `POST /entry/disable`, and all response contracts unchanged.
- Add no D1 migration and no client-visible settings revision.
- Never report `Saved` before a Worker-confirmed write.
- A disabled printed entry must remain irreversible for migrated and pre-0008 events.
- Preserve `CandidaryDesignSystem.zip` and the untracked plan in the main checkout.
- Commit each independently testable remediation; do not push without explicit approval.

---

### Task 1: Same-key autosave failure and metadata ownership

**Files:**
- Modify: `tests/unit/settings-autosave-queue.test.ts`
- Modify: `src/features/settings/autosave-queue.ts`

**Interfaces:**
- Consumes: `AutosaveDraft.key` as persistence identity and `AutosaveDraft.intent` as visible intent.
- Produces: same-key scheduled and pending drafts retain the newest snapshot metadata; a same-key in-flight failure remains current when the latest draft is valid.

- [ ] **Step 1: Add failing queue regressions**

Add cases proving that:

```ts
queue.submit(draft('v1', 'raw'), true);
queue.submit(draft('v1', 'normalized'), true);
gates[0]!.reject(new Error('offline'));
await vi.waitFor(() => expect(queue.state().status).toBe('failed'));
```

and that same-key scheduled and pending submissions send the latest `intent` while preserving the original debounce deadline.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.config.ts tests/unit/settings-autosave-queue.test.ts`

Expected: the in-flight case reports `saved`, and scheduled/pending metadata cases expose the older intent.

- [ ] **Step 3: Implement the minimal queue correction**

Replace scheduled and pending entries when a same-key draft arrives, without extending the debounce. Classify a response as superseded by semantic key or invalidity, not by a valid same-key intent-object change.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run --config vitest.config.ts tests/unit/settings-autosave-queue.test.ts`

Commit: `fix: preserve same-key autosave failures`

---

### Task 2: Request-generation-aware settings rebasing

**Files:**
- Modify: `tests/ui/event-settings-editor.test.tsx`
- Modify: `src/components/EventSettingsEditor.tsx`

**Interfaces:**
- Consumes: the existing per-field `generations` map at the moment a complete settings snapshot enters the queue.
- Produces: each queued save carries `{ payload, generations }`; a successful response may normalize only fields whose generation has not advanced since that request.

- [ ] **Step 1: Add the failing ABA regression**

Start a boolean write, explicitly return the control to its old baseline while the request is held, release the older response, and assert that a second request carries the explicit reversion and the control ends at that latest value.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-settings-editor.test.tsx -t "baseline reversion"`

Expected: the older response overwrites the explicit reversion or prevents its follow-up request.

- [ ] **Step 3: Carry generation metadata with the queue snapshot**

Introduce an editor-local save envelope:

```ts
interface EventSettingsSave {
  payload: EventSettingsPayload;
  generations: Record<EventSettingsField, number>;
}
```

Send only `payload` to the Worker. Record the successful request's generations before forwarding its event to the manager, then rebase each incoming field only when its current generation equals the generation confirmed by that response. Continue using value equality for unrelated external event updates.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-settings-editor.test.tsx`

Commit: `fix: preserve explicit settings reversions`

---

### Task 3: Atomic legacy adoption and durable disable tombstone

**Files:**
- Modify: `tests/worker/legacy-entry-api.test.ts`
- Modify: `worker/db/event-entries.ts`
- Modify: `worker/services/event-entry.ts`

**Interfaces:**
- Produces: `EventEntriesRepository.createLegacyAdoptionStatement(...)`, whose `INSERT ... SELECT` succeeds only while the source guest token is still active; and a disable batch statement that materializes a disabled legacy row before revoking tokens.

- [ ] **Step 1: Add the failing delayed-adoption regression**

Prepare the legacy adoption statement while the guest token is active, disable the no-entry legacy event, execute the delayed statement, then assert:

```ts
expect((await entries.getForEvent(eventId))?.disabledAt).toEqual(expect.any(String));
expect((await scanPrinted(printed)).headers.get('location'))
  .toBe('/recover/event-entry?kind=unavailable');
```

Also assert that a settings request cannot reopen uploads after this interleaving.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/legacy-entry-api.test.ts -t "delayed adoption"`

Expected: the current disable cannot return a durable disabled row for a no-entry event, or the delayed unconditional insert creates an active credential.

- [ ] **Step 3: Implement conditional adoption and legacy tombstoning**

Use `INSERT ... SELECT` against the exact guest-token id with `revoked_at IS NULL` for adoption. At the start of the disable batch, `INSERT OR IGNORE` a disabled credential from the newest recoverable legacy guest token so the following disable and revocations leave a durable tombstone. A delayed adopter must either match zero active tokens or lose to the unique event row and then read the disabled credential.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run --config vitest.worker.config.ts tests/worker/legacy-entry-api.test.ts tests/worker/event-entry-api.test.ts tests/worker/repositories.test.ts`

Commit: `fix: make legacy entry disable irreversible`

---

### Task 4: Multi-writer event response merging

**Files:**
- Modify: `tests/unit/manager-event-merge.test.ts`
- Modify: `tests/ui/manager-settings-autosave.test.tsx`
- Modify: `src/features/settings/event-merge.ts`
- Modify: `src/pages/ManagerPage.tsx`

**Interfaces:**
- Produces: `mergeSettingsResponse(current, response, { entryDisabled })`.
- Contract: `rsvpRosterVersion` is monotonic; confirmed entry disable forces `uploadsEnabled` and `rsvpEnabled` false; all exclusively settings-owned fields still adopt the settings response.

- [ ] **Step 1: Add failing unit and manager regressions**

Unit cases must prove `Math.max(current.rsvpRosterVersion, response.rsvpRosterVersion)` and that a delayed response cannot set either intake flag true when `entryDisabled` is true. The manager case holds a settings response, completes printed-entry disable and refresh, then releases the stale response and asserts that the header and settings controls remain paused.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.config.ts tests/unit/manager-event-merge.test.ts tests/ui/manager-settings-autosave.test.tsx -t "disabled|roster version"`

Expected: the response regresses the roster version or visually reopens intake.

- [ ] **Step 3: Implement writer-aware merging**

Remove the co-owned fields from the generic owned-field array. Merge the roster version monotonically, gate intake booleans on a synchronous `entryDisabledRef`, and set that ref plus the event's two intake flags as soon as disable confirms, before the full refresh completes.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run --config vitest.config.ts tests/unit/manager-event-merge.test.ts tests/ui/manager-settings-autosave.test.tsx`

Commit: `fix: order settings against entry and roster writes`

---

### Task 5: Persistent autosave recovery guidance

**Files:**
- Modify: `tests/ui/manager-settings-autosave.test.tsx`
- Modify: `src/pages/ManagerPage.tsx`

**Interfaces:**
- Produces: manager load notices may identify their originating autosave domain.
- Contract: opening Settings preserves an autosave credential/lifecycle recovery notice; a successful recovery or explicit dismissal clears it.

- [ ] **Step 1: Add the failing recovery regression**

Return `SESSION_EXPIRED` from a hidden settings autosave, assert the manager notice exposes recovery, click `Open settings`, and assert that the same notice and recovery actions remain visible.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.config.ts tests/ui/manager-settings-autosave.test.tsx -t "recovery"`

Expected: `openSection('settings')` clears the manager notice.

- [ ] **Step 3: Preserve only autosave-origin recovery notices**

Tag escalated notices with the domain. Section navigation may continue clearing unrelated action notices, but must retain a tagged autosave notice. Clear a tagged notice when that domain returns to `saved`; keep the existing explicit dismiss button.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run --config vitest.config.ts tests/ui/manager-settings-autosave.test.tsx`

Commit: `fix: retain autosave access recovery guidance`

---

### Task 6: Clean legacy null deadline baseline

**Files:**
- Modify: `tests/ui/event-settings-editor.test.tsx`
- Modify: `src/components/EventSettingsEditor.tsx`

**Interfaces:**
- Contract: client validation blocks changed drafts, but validation of an unchanged server-confirmed legacy baseline does not create local dirty state or a navigation guard.

- [ ] **Step 1: Add the failing legacy baseline regression**

Render an event whose confirmed `rsvpDeadlineDate` is `null`, let effects settle, and assert an empty deadline, `settings:saved`, no field error, and zero settings writes.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-settings-editor.test.tsx -t "legacy null deadline"`

Expected: the blocked-key effect changes the domain to `invalid` without a host edit.

- [ ] **Step 3: Separate confirmed baseline validity from local draft validity**

Run client validation only when the visible draft differs from the confirmed baseline or a live server error exists. Once the host edits any setting, validate the complete atomic payload exactly as before, so the missing deadline blocks that attempted change and identifies the deadline field.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npx vitest run --config vitest.config.ts tests/ui/event-settings-editor.test.tsx tests/ui/manager-settings-autosave.test.tsx`

Commit: `fix: keep legacy settings baselines confirmed`

---

### Task 7: Final verification and review

**Files:**
- Review every file changed by Tasks 1–6.

- [ ] **Step 1: Run focused mutation checks**

Temporarily reason through or revert each key guard locally to confirm its regression would fail: semantic same-key failure, generation comparison, token-active SQL predicate, disabled-entry merge gate, tagged recovery preservation, and pristine-baseline validation suppression.

- [ ] **Step 2: Run all repository gates**

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:pwa-build
npx tsc -p tsconfig.e2e.json --pretty false
npm run cf-typegen
npx playwright test
git diff --check origin/main...HEAD
```

- [ ] **Step 3: Inspect scope and history**

Run `git status --short`, `git diff --stat origin/main...HEAD`, and `git log --oneline origin/main..HEAD`. Confirm the main checkout still contains only its pre-existing untracked ZIP and plan. Do not push.

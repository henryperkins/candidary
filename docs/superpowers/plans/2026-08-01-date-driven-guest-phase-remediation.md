# Date-Driven Guest Phase Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every confirmed gap between the approved date-driven guest phase design and commit `58218c0`, including the operational legacy-data release gate.

**Architecture:** Keep the existing server-authoritative lifecycle model. Add the missing server-only RSVP configuration input at the guest-view boundary; reconcile schedule-derived manager state through a guarded fresh read; make unchanged lifecycle refreshes preserve the currently armed boundary and anti-spin state; and provide a deterministic, dry-run-first Node 24 release tool that reuses the production IANA conversion code.

**Tech Stack:** TypeScript 6, React 19, Hono/Cloudflare Worker, Vitest, Playwright, Node.js 24 native TypeScript stripping, Wrangler D1.

**Status (2026-08-01):** Implemented. Every task below completed RED-first, and the
post-implementation review findings were remediated before the final verification pass.

## Global Constraints

- `rsvpConfigured` is server-only and equals `event.rsvpRosterVersion > 0` with a valid deadline; it must never be serialized to guests.
- At or after `eventStartAt`, RSVP access is always `unavailable`; before the start, an unconfigured RSVP is also `unavailable`.
- Settings, photo-intake, RSVP, theme, and cover mutations remain independently mergeable; a delayed response must not revive stale state from another domain.
- Lifecycle transitions remain server-authoritative. Browser wall-clock time never decides a phase.
- The 30-second floor applies only after a failed or semantically unchanged recheck and never delays the initial server-provided boundary timer.
- No remote D1 mutation or deployment is part of implementation verification.
- Preserve `CandidaryDesignSystem.zip`, `candidaryhomepageredesign.patch`, and `docs/superpowers/plans/2026-08-01-settings-autosave.md` unchanged.

---

### Task 1: Server-only RSVP configuration

**Files:**
- Modify: `shared/rsvp.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `tests/unit/rsvp.test.ts`
- Modify or create focused coverage in: `tests/worker/core-journey.test.ts` or the nearest guest-event-view worker test

**Interfaces:**
- Produces: `GuestLifecycleInput = EventLifecycleInput & { rsvpConfigured: boolean }`
- Consumes: `EventRecord.rsvpRosterVersion` and `EventRecord.rsvpDeadlineAt`

- [x] **Step 1: Write failing unit and worker tests**

  Add a valid-deadline, pre-start event with `rsvpRosterVersion: 0` and assert that its guest view has `phase: 'before-start'`, `rsvpState: 'paused'`, and `rsvpAccess: 'unavailable'`. Keep a configured paused event at `rsvpRosterVersion > 0` read-only.

- [x] **Step 2: Verify RED**

  Run `npm run test:unit -- tests/unit/rsvp.test.ts` and the selected worker test. The new unconfigured assertion must fail by receiving `read-only`.

- [x] **Step 3: Implement the server-only input**

  Require `rsvpConfigured` only for `resolveGuestEventPhase`, derive it in `guestEventView` as a positive roster version plus a parseable deadline, and include it in the access precedence before open/read-only handling. Do not add the property to `GuestEventView`.

- [x] **Step 4: Verify GREEN**

  Re-run the focused unit and worker files. Confirm the configured paused case remains `read-only` and the unconfigured case is `unavailable`.

### Task 2: Schedule-derived manager photo state

**Files:**
- Modify: `src/components/EventSettingsEditor.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Preserve the ownership contract in: `src/features/settings/event-merge.ts`
- Modify: `tests/ui/event-settings-editor.test.tsx`
- Modify or create focused manager integration coverage in: `tests/ui/manager-settings-autosave.test.tsx` or `tests/ui/app.test.tsx`

**Interfaces:**
- Change: `onSettingsSaved(event: EventView, metadata: { scheduleChanged: boolean }): void`
- Consume: existing `onEventRead`/`eventRead` guard
- Consume: `mergePhotoIntakeResponse(current, refreshed.event, { entryDisabled })`

- [x] **Step 1: Write failing callback and manager tests**

  Prove that a saved date/time/timezone tuple reports `scheduleChanged: true`, an unrelated name/message save reports `false`, and a schedule save triggers one guarded fresh event read whose photo-intake fields replace the stale panel state without regressing settings fields.

- [x] **Step 2: Verify RED**

  Run the focused UI files and confirm the callback metadata or follow-up read expectation fails because the current callback carries only the event.

- [x] **Step 3: Implement guarded reconciliation**

  Compute schedule change against the editor's confirmed server schedule for the exact queued snapshot. Merge the settings response through `mergeSettingsResponse`, and only for a schedule change start a quiet `eventRead`; merge only the returned photo-intake-owned fields. Keep read failures non-destructive and let the current surface remain usable.

- [x] **Step 4: Verify GREEN and concurrency behavior**

  Re-run the focused UI tests, including a delayed settings response overlapping a photo-intake mutation. The latest explicit photo action must win, while the fresh read updates state derived from the new schedule.

### Task 3: Semantic lifecycle anti-spin

**Files:**
- Modify: `src/pages/EventPage.tsx`
- Modify: `src/pages/ManagerPage.tsx`
- Modify if needed: `src/features/guest/useLifecycleRecheck.ts`
- Create or modify focused hook/page tests under: `tests/ui`
- Modify: `tests/e2e/guest-lifecycle.spec.ts` if browser-level coverage is the smallest reliable contract

**Interfaces:**
- Guest semantic identity: `phase`, `rsvpState`, `rsvpAccess`, and the absolute
  start/deadline display tuple
- Manager semantic identity: `photoIntakeState` and the complete five-field schedule tuple
- Preserve: `LifecycleRecheckOutcome = 'changed' | 'unchanged'`

- [x] **Step 1: Write failing repeated-wake tests**

  Return the same semantic guest or manager state with decreasing relative delays, dispatch two `pageshow`/online wake events inside 30 seconds, and assert only the first refresh occurs. Separately prove the initial boundary delay fires without a 30-second floor.

- [x] **Step 2: Verify RED**

  Run the focused lifecycle test and confirm repeated wake events currently issue multiple requests.

- [x] **Step 3: Preserve state on semantic no-op**

  Classify equality without comparing relative delay. When the semantic view is unchanged, return `unchanged` without installing the response's drifting delay into React state; let the existing hook instance retain its floor and armed boundary. Install the response only when the semantic state changed.

- [x] **Step 4: Verify GREEN**

  Re-run the focused lifecycle tests and existing guest lifecycle E2E coverage. Confirm changed access or phase still renders immediately.

- [x] **Step 5: Close review-found boundary races**

  Preserve the original boundary during an overlapping wake, cancel every timer on cleanup,
  and key the hook by semantic boundary identity as well as relative delay so a changed
  schedule with the same numeric delay still re-arms. A manager lifecycle read adopts the
  full five-field schedule tuple atomically, allowing the settings editor to rebase without
  reverting a second manager's schedule.

### Task 4: Executable IANA-aware legacy release gate

**Files:**
- Create: `scripts/event-start-backfill.ts`
- Create: `tests/unit/event-start-backfill.test.ts`
- Modify: `package.json`
- Modify: `docs/deployment.md`

**Interfaces:**
- Reuse: `instantForLocalDateTime(eventDate, '00:00', eventTimezone)` from `shared/event-time.ts`
- Produce deterministic versioned JSON plans containing inventoried IDs and expected instants
- Produce deterministic SQL containing one guarded `UPDATE events SET event_start_at = ... WHERE id = ... AND deleted_at IS NULL` per eligible row
- Verify post-migration inventory against the plan and exit nonzero for missing, approximate, sentinel, or mismatched rows

- [x] **Step 1: Write failing pure and CLI-level tests**

  Cover at least `America/Chicago` and a non-US IANA zone, a same-day or later deadline that blocks plan generation, SQL quote escaping, the UTC-midnight approximation mismatch, the epoch sentinel mismatch, a missing inventoried ID, and a successful exact verification.

- [x] **Step 2: Verify RED**

  Run `npm run test:unit -- tests/unit/event-start-backfill.test.ts`; it must fail because the release tool does not exist.

- [x] **Step 3: Implement dry-run-first plan and verify modes**

  Parse Wrangler `d1 execute --json` output as well as a plain row array. Plan mode validates every non-deleted row and refuses to emit SQL when `rsvp_deadline_at >= expected event_start_at`. Verify mode checks every planned ID and prints actionable mismatches. The tool never calls Wrangler or mutates D1 itself.

- [x] **Step 4: Document exact release commands**

  Add package scripts using `node --experimental-strip-types`, and update `docs/deployment.md` with pre-migration inventory, plan/SQL generation, migration apply, SQL apply, post-migration inventory verification, and final deploy-gap sentinel repetition. State explicitly that deployment remains blocked on any nonzero tool exit.

- [x] **Step 5: Verify GREEN**

  Run the focused unit test and both CLI modes against checked-in test fixtures or temporary files created by the test. Confirm no remote command runs during tests.

- [x] **Step 6: Close review-found release races**

  Guard generated updates with the inventoried source tuple, reject unplanned non-sentinel
  rows, and serialize the final verification/deploy window with a temporary source-field-only
  SQLite trigger. Machine-verify the exact trigger before deployment, revalidate the original
  plan after deployment while the freeze remains installed, then remove it and prove absence.
  A failed deploy keeps the freeze installed; explicit abort invalidates all prior evidence.

### Task 5: Integrated review and release-quality verification

**Files:**
- Inspect every file changed by Tasks 1-4
- Do not modify unrelated user files

- [x] **Step 1: Run focused regression suites**

  Run all new or modified unit, UI, worker, and E2E tests and resolve failures at their root cause.

- [x] **Step 2: Run repository gates on the final working tree**

  Run `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:worker`, `npm run build`, `npm run verify:pwa-build`, `npm run test:e2e`, and `git diff --check`.

- [x] **Step 3: Review the complete diff against the design**

  Verify all four findings have a direct regression test, the guest contract does not expose `rsvpConfigured`, manager concurrency ownership still holds, initial boundary timing remains exact, and the migration tool defaults to producing artifacts rather than executing writes.

- [x] **Step 4: Preserve repository state**

  Confirm the pre-existing untracked files are unchanged and report any verification limitation, especially that remote D1 and deployment were deliberately not touched.

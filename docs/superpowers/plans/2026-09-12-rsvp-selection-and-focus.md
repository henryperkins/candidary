# RSVP Selection and Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. If using subagents, the repository's one fresh implementer and one fresh independent reviewer per task rule controls review depth.

**Goal:** Keep the latest host household selection authoritative and move focus only for explicit RSVP navigation.

**Architecture:** Add selection ownership to the existing manager controller and pass normal-open focus through the existing editor. Carry explicit guest focus intent in the existing screen union; automatic restore/lifecycle transitions remain passive. Preserve APIs, layout, draft-reset keys, and validation behavior.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, Playwright.

**Spec:** [RSVP household selection and focus repair](../specs/2026-09-12-rsvp-selection-and-focus-design.md).

## Global Constraints

- This repair is independent of photo export.
- Preserve the editor key `${detail.id}:${detail.version}:${detail.updatedAt}`.
- Only the current owner may apply a detail response, detail error, conflict-refresh result, focus request, or busy reset.
- Automatic session restoration or lifecycle refresh must not request heading focus.
- Use existing design tokens, 44px minimum touch targets, keyboard behavior, and reduced-motion preferences.
- Run only the named focused checks below. An implementer/reviewer/controller must not repeat the same successful evidence without a new change or unresolved concern.
- With subagents, use one fresh implementer and one fresh independent reviewer per task. Fix only failing focused checks or Critical/Important findings; record Minor notes and advance.
- Do not stage intermediate changes. This plan does not authorize committing, pushing, or deploying; any subsequently authorized commit must use an explicit file allowlist.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `src/components/ManagerRsvpPanel.tsx` | Detail request ownership, mutation presentation ownership, loading/close behavior, focus origin |
| `src/features/rsvp/ManagerRsvpDashboard.tsx` | Pass the actual row button as focus origin; stable row identity |
| `src/features/rsvp/ManagerRsvpHouseholdEditor.tsx` | Focus/reveal the selected heading while retaining draft-reset keys |
| `src/features/rsvp/GuestRsvpFlow.tsx` | Explicit transition focus flags and passive restoration |
| `src/features/rsvp/RsvpHouseholdForm.tsx` | Normal-entry focus, existing validation and conflict focus |
| `src/features/rsvp/RsvpReceipt.tsx` | Optional explicit receipt-heading focus |
| `tests/ui/manager-rsvp-panel.test.tsx`, `tests/ui/guest-rsvp-flow.test.tsx` | Deterministic request-order and focus regressions |
| `tests/e2e/rsvp-responsive.spec.ts`, `tests/e2e/rsvp-journey.spec.ts` | Actual viewport/focus proof with fictional fixture routes |

## Task 1: Host detail ownership and focus

**Files:** Modify the three manager files and `tests/ui/manager-rsvp-panel.test.tsx` listed above.

**Interfaces:**

- Extend the dashboard callback to `onOpenHousehold(householdId: string, origin: HTMLButtonElement): void`; pass `event.currentTarget` from the row. Other controller callers may omit the origin.
- Keep the editor's `autoFocusHeading: boolean` prop and its existing identity/version key. Rename the controller's `conflictRefreshed` state to `focusHeading` because current opens now request it too.
- Keep the public `ManagerRsvpPanel` props and all API payloads unchanged.

- [x] **Add a controlled response-order regression.** Import `act` from Testing Library and add this deferred helper beside the existing `success`, `failure`, and `route` helpers:

```tsx
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => { resolve = complete; });
  return { promise, resolve };
}

it('keeps the latest household selection when an earlier response finishes last', async () => {
  const first = deferredResponse();
  const second = deferredResponse();
  const other = { ...household, id: '55555555-5555-4555-8555-555555555555', label: 'The Rivera household' };
  const rows = listPage();
  rows.households.push({ ...rows.households[0]!, id: other.id, label: other.label });
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = route(input);
    if (url.pathname.endsWith('/summary')) return success(summary);
    if (url.pathname.endsWith('/households')) return success(rows);
    if (url.pathname.endsWith(`/${household.id}`)) return first.promise;
    if (url.pathname.endsWith(`/${other.id}`)) return second.promise;
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<ManagerRsvpPanel event={event} onEventChanged={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /The Morgan household/ }));
  await user.click(screen.getByRole('button', { name: /The Rivera household/ }));
  await act(async () => { second.resolve(await success(other)); });
  expect(await screen.findByRole('heading', { name: other.label })).toHaveFocus();
  await act(async () => { first.resolve(await success(household)); });
  expect(screen.getByRole('heading', { name: other.label })).toHaveFocus();
  expect(screen.queryByRole('heading', { name: household.label })).not.toBeInTheDocument();
});
```

Extend that fixture with these focused cases; settle deferred responses inside `act`, so assertions cannot pass before the stale callback runs:

| Case | Trigger | Required assertion |
| --- | --- | --- |
| Stale error and busy cleanup | Request A, request B, fail A while B is pending | A's error is absent; loading B and Close household remain; no editable A fields |
| Close during read | Request B, close before resolving B | B never opens after completion; focus returns to its row |
| Retired event | Request A, rerender with another event, finish A | No A detail, notice, or focus request reaches the new event |
| Mutation after reselection/close | Start A's save, select B or close, complete A's save | The committed roster version/event refresh is observed; A never reopens; B's pending state survives |
| Conflict after reselection | Start A's save, return a conflict, hold A's refresh, select B, finish the refresh | No stale conflict heading, message, or busy reset |
| Repeated normal open | Open A, open B, close B, reopen B | Every explicit open focuses its own heading |
| Missing origin | Open a household, filter it out or refresh its row, then close | Focus reaches the current matching row or Guest list and RSVPs heading |

Concrete assertions for the loading/close cases:

```tsx
expect(screen.queryByLabelText('Household label')).not.toBeInTheDocument();
expect(screen.getByRole('status')).toHaveTextContent('Loading household');
await user.click(screen.getByRole('button', { name: 'Close household' }));
await act(async () => { second.resolve(await success(other)); });
expect(screen.queryByRole('heading', { name: other.label })).not.toBeInTheDocument();
expect(screen.getByRole('button', { name: /The Rivera household/ })).toHaveFocus();
```

- [x] **Run RED.**

The current DOM setup only loads jest-dom; add a test-local layout stub before this run so later `scrollIntoView` calls do not turn the GREEN check into a jsdom error. Import `beforeAll`/`afterAll` and restore the prototype afterward:

```tsx
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterAll(() => {
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
```

```text
npx vitest run --config vitest.config.ts tests/ui/manager-rsvp-panel.test.tsx
```

Expected: the new request-order/focus cases fail on the current implementation. Record the actual assertion failure; fixture errors are not acceptable RED evidence.

- [x] **Implement owner checks in the controller.** Keep the generation outside render state. Use event ownership and an effect cleanup to retire old callbacks:

```tsx
interface DetailOwner { generation: number; eventId: string; householdId: string }
const detailGeneration = useRef(0);
const activeDetailOwner = useRef<DetailOwner | null>(null);
const mountedEvent = useRef<string | null>(eventId);

function ownsDetail(owner: DetailOwner) {
  return mountedEvent.current === owner.eventId
    && activeDetailOwner.current === owner
    && detailGeneration.current === owner.generation;
}

useEffect(() => {
  mountedEvent.current = eventId;
  activeDetailOwner.current = null;
  setDetail(null);
  setBusy(false);
  setFocusHeading(false);
  return () => {
    mountedEvent.current = null;
    activeDetailOwner.current = null;
    detailGeneration.current += 1;
  };
}, [eventId]);
```

Add selected-ID state and origin refs; clear them, notices, and announcements when the event changes. At explicit open, create and store an owner, clear detail, reset focus/error state, then request the new household. For each result path:

```tsx
const owner: DetailOwner = {
  generation: ++detailGeneration.current,
  eventId,
  householdId,
};
activeDetailOwner.current = owner;
setSelectedHouseholdId(householdId);
setDetail(null);
setFocusHeading(false);
setNotice('');
setBusy(true);
try {
  const next = await api<RsvpHouseholdDetail>(`${basePath}/households/${householdId}`);
  if (!ownsDetail(owner)) return;
  setDetail(next);
  setFocusHeading(true);
} catch (caught) {
  if (ownsDetail(owner)) setNotice(failureMessage(caught, 'That household could not be opened.'));
} finally {
  if (ownsDetail(owner)) setBusy(false);
}
```

Change `runHouseholdWrite` to capture the active detail owner before starting. Reject a write if its household is no longer the selected detail. Use `useRef(new Set<DetailOwner>())` for pending writes: a second submit under the same owner returns immediately; a retired owner's write does not silently disable the new household. Remove the captured owner from that set in `finally`, but change visible busy state only if `ownsDetail(owner)` still holds. Refactor the write callback to return `ManagerMutation` instead of changing detail inside an unguarded closure. Continue to use `onEventWrite` around each PUT/POST. On success, if the event remains mounted, adopt `Math.max(current, result.rosterVersion)`, call `onEventChanged`, and refresh current-event totals. Only `ownsDetail(owner)` may replace detail or show its notice/announcement. Guard the response of `refreshAfterConflict` and every error/finally path with the same owner. Return the server's observed roster version even when detail ownership has moved; do not report a committed write as cancelled. Retain the server's existing version-conflict handling when independent writes overlap.

Close must increment `detailGeneration`, clear the active owner, selected ID, detail, focus flag, and busy state before restoring focus. While a read has no detail yet, render a polite `Loading household…` status and Close household button; do not render the old editable form.

- [x] **Wire focus and origin.** Set a stable ID on each dashboard row button, retain its `currentTarget`, and use the still-connected origin or current matching row when closing. Fall back to a `tabIndex={-1}` ref on Guest list and RSVPs. Set `focusHeading` false at the beginning of ordinary writes and true after current open/conflict results. Retain the editor key. The heading effect is:

```tsx
useEffect(() => {
  if (!autoFocusHeading) return;
  headingRef.current?.focus({ preventScroll: true });
  headingRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}, [autoFocusHeading, detail.id]);
```

Use a scoped `scrollIntoView` test stub if the DOM runner lacks layout methods; assert focus there and actual position in Task 3. A current conflict may remount the existing keyed editor; ordinary committed writes must pass `autoFocusHeading={false}` to that remount.

- [x] **Run GREEN with the same command.** Preserve the existing conflict-refresh, correction, archive confirmation, and staging tests. Record the command/result and any remaining findings. Do not stage or commit.

## Task 2: Explicit guest-stage focus

**Files:** Modify `GuestRsvpFlow.tsx`, `RsvpHouseholdForm.tsx`, `RsvpReceipt.tsx`, and `tests/ui/guest-rsvp-flow.test.tsx`.

**Interfaces:** Add optional `focusHeading?: boolean` to the form and receipt props, defaulting to false. Add that optional property to the editing, receipt, read-only, and before-start variants of `Screen`. Other stages do not carry it.

- [x] **Add explicit-transition assertions to the existing lookup, successful submit/retry, and Change RSVP tests.** Use their current fixture helpers and assert the headings after each user action:

```tsx
await openInvitation(user);
await waitFor(() => expect(screen.getByRole('heading', { name: 'Your household RSVP' })).toHaveFocus());
await selectAllAttendance(user, 'Not attending');
await user.click(screen.getByRole('button', { name: 'Submit RSVP' }));
await waitFor(() => expect(screen.getByRole('heading', { name: "You're all set" })).toHaveFocus());
await user.click(screen.getByRole('button', { name: 'Change RSVP' }));
await waitFor(() => expect(screen.getByRole('heading', { name: 'Your household RSVP' })).toHaveFocus());
```

Add a parameterized passive-restore test for primary and embedded presentation. Hold the household GET, focus an external button while it is pending, then resolve a responded household. The response may render without taking focus:

```tsx
it.each(['primary', 'embedded'] as const)('does not move focus on %s session restore', async (presentation) => {
  const restore = deferredResponse();
  vi.stubGlobal('fetch', vi.fn(() => restore.promise));
  render(<>
    <button type="button">Outside RSVP</button>
    <GuestRsvpFlow event={event} presentation={presentation} />
  </>);
  const outside = screen.getByRole('button', { name: 'Outside RSVP' });
  outside.focus();
  await act(async () => {
    restore.resolve(await success({ household: {
      ...household, firstRespondedAt: '2026-08-01T00:00:00Z',
      invitees: household.invitees.map((invitee) => ({ ...invitee, attendance: 'declined' })),
    } }));
  });
  expect(await screen.findByRole('heading', { name: "You're all set" })).toBeVisible();
  expect(outside).toHaveFocus();
});
```

Import `act`. Also retain/extend the existing lifecycle rerender, first-invalid-radio, plus-one-name, and conflict-review tests: changing answers must leave focus on the changed control; a passive event refresh must not reuse an old explicit-focus flag.

- [x] **Run RED.**

```text
npx vitest run --config vitest.config.ts tests/ui/guest-rsvp-flow.test.tsx
```

Expected: new explicit lookup/receipt focus assertions fail; passive restore remains a control case.

- [x] **Implement explicit screen flags.** Keep `screenForHousehold` passive. Add this helper after the screen-selection functions:

```tsx
function withExplicitHeadingFocus(next: Screen): Screen {
  if (next.kind === 'editing' || next.kind === 'receipt'
    || next.kind === 'read-only' || next.kind === 'before-start') {
    return { ...next, focusHeading: true };
  }
  return next;
}
```

Use it on successful explicit lookup. Set `focusHeading: true` on successful submission's receipt and on editable Change RSVP. Do not use it in the restore effect, `screenForHousehold`, saving/error stages, or the synchronous lifecycle override. Pass the flag from `renderedScreen`, so a lifecycle override cannot inherit the prior screen's focus request. The shared editing/saving render branch passes `focusHeading={renderedScreen.kind === 'editing' && renderedScreen.focusHeading === true}`; saving has no flag. Receipt/read-only/before-start branches pass their own optional flag. Paused receipts omit it.

- [x] **Focus stage headings without changing draft/validation ownership.** Give the form heading an unconditional `tabIndex={-1}`. Keep its existing review effect and add the normal-entry effect below. Its dependencies deliberately exclude draft and ordinary version updates:

```tsx
useEffect(() => {
  if (focusHeading && !reviewUpdated) reviewHeadingRef.current?.focus();
}, [focusHeading, household.id, reviewUpdated]);
```

The review-mode guard is a dependency, but ordinary submission enters saving without an explicit-focus flag, so it cannot refocus this heading. Preserve the existing review effect's `reviewUpdated`/`household.version` behavior; normal entry skips that review case so the two effects do not focus twice for one conflict transition.

Add React's `useEffect` and `useRef` to the receipt and a heading ref:

```tsx
const headingRef = useRef<HTMLHeadingElement>(null);
useEffect(() => {
  if (focusHeading) headingRef.current?.focus();
}, [focusHeading, household.id]);
// On the existing HeadingTag: ref={headingRef} tabIndex={-1}.
```

- [x] **Run GREEN with the same command.** Record focused results. No provider work or RSVP API changes belong in this task.

## Task 3: Browser proof of the changed navigation

**Files:** Modify only `tests/e2e/rsvp-responsive.spec.ts` and `tests/e2e/rsvp-journey.spec.ts`. Leave shared fixture behavior unchanged; the manager test overrides its detail GET locally after registering the existing fixture routes.

**Interfaces:** Use existing `stubGuestRoutes`, `stubManagerRoutes`, fixture records, and layout helpers. Test titles begin `RSVP focus` so the command below selects only this repair.

- [x] **Add a manager browser case** with at least 12 household rows. At 320x568, 390x844, and the desktop project viewport, open a row using its actual rendered button, without scrolling the heading in the test. Assert focus and on-screen placement, then close and assert return focus. Repeat with a different household to exercise the already-true focus case. A representative assertion block is:

Build the 12 rows from `RSVP_HOUSEHOLD_LIST_FIXTURE.households[0]` with unique UUIDs and labels, including The Morgan household and The Rivera household; pass them as `rsvp.households` to `stubManagerRoutes`. The existing stub returns one detail for every ID, so register this GET override afterward. Import the existing `RSVP_HOUSEHOLD_DETAIL_FIXTURE` and navigate to `/manage/event/${EVENT_FIXTURE.id}?section=rsvp`:

```ts
const detailById = new Map(householdRows.map((row) => [row.id, {
  ...RSVP_HOUSEHOLD_DETAIL_FIXTURE,
  id: row.id, householdKey: row.householdKey, label: row.label,
}]));
await page.route('**/api/manage/events/*/rsvp/households/*', async (route) => {
  if (route.request().method() !== 'GET') return route.fallback();
  const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
  const detail = detailById.get(id);
  if (!detail) return route.fallback();
  await route.fulfill({ json: { data: detail, requestId: 'rsvp-focus-fixture' } });
});
```

```ts
const heading = page.getByRole('heading', { name: 'The Rivera household', exact: true });
await expect(heading).toBeFocused();
const box = await heading.boundingBox();
expect(box).not.toBeNull();
expect(box!.y).toBeGreaterThanOrEqual(0);
expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
await page.getByRole('button', { name: 'Close household', exact: true }).click();
await expect(page.getByRole('button', { name: /The Rivera household/ })).toBeFocused();
```

Use the existing viewport-escape/touch-target helpers, and inspect persistent header overlap before accepting the screenshot. Do not make assertions pass with test-side `scrollIntoViewIfNeeded` on the destination heading.

- [x] **Add a guest browser case** covering explicit lookup, first invalid input, completed submit, and Change RSVP with `toBeFocused()` on each actual destination. Include a separate session-restored receipt assertion that keeps an existing external control focused. Use the existing server-fixture submission path, with no production invitations.

- [x] **Run the named browser check.**

```text
npx playwright test tests/e2e/rsvp-responsive.spec.ts tests/e2e/rsvp-journey.spec.ts --grep "RSVP focus" --project=desktop --project=mobile
```

The repository Playwright configuration builds the app and starts its preview server; that build is a prerequisite of this focused browser command, not a repository-wide test gate. Do not weaken CSP or change runtime configuration to make the acceptance command pass. A browser startup/environment failure remains a blocked browser check, not a passing navigation test.

- [x] **Record completion evidence once.** Record the baseline/final working tree, changed file allowlist, each task's latest focused command/result, browser viewport findings, and any untested physical-device accessibility. Run `git diff --check` for the final patch. Do not repeat successful UI suites just to produce controller-owned copies of the same evidence.

## Plan self-review and execution boundary

The tasks cover selection ownership, stale cleanup, delayed write/conflict presentation, repeated-open focus, close restoration, passive guest restoration, explicit guest transitions, validation retention, and real browser geometry. Export and release configuration are excluded.

This document is an implementation plan, not evidence that its unchecked steps have run. Execute only after the design/plan is accepted; choose the execution mode within the task's existing authorization, without adding an unrelated Git publication step.

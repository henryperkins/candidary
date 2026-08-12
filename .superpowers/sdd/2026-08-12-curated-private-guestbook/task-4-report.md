# Task 4 Report: Guest-facing Guestbook and reactive signature

## Status

Implemented and locally verified in the isolated `codex/curated-private-guestbook` worktree.

- Implementation commit: `10b62c99589179c64bce10d8d48c7d16b3063b85`
- Remote actions: none
- Deployment, remote migration, runtime certification, and physical-device acceptance: not performed

## Files

Created:

- `src/features/guestbook/Guestbook.tsx`
- `src/features/guestbook/guestbook-state.ts`
- `tests/ui/guestbook.test.tsx`

Modified:

- `src/app/api.ts`
- `src/features/guest/GuestBeforeStart.tsx`
- `src/features/rsvp/GuestRsvpFlow.tsx`
- `src/features/rsvp/RsvpLookup.tsx`
- `src/features/uploads/GuestUploadFlow.tsx`
- `src/pages/EventPage.tsx`
- `src/styles.css`
- `tests/ui/app.test.tsx`
- `tests/ui/guest-rsvp-flow.test.tsx`
- `tests/ui/guest-upload-flow.test.tsx`

No Manager UI, export, database, Worker route, migration, deployment, or design-sidecar file was changed.

## RED

Before production edits, ran the exact focused command:

```text
npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/app.test.tsx
```

Result: exit 1 in 47.6 seconds; 132 passed and 11 failed out of 143 tests.

Expected Task 4 failures:

- `tests/ui/guestbook.test.tsx`: 4/4 failed because the page exposed only the legacy `Guest notes` unified feed and lacked the `contract=2` split-stream Guestbook behavior.
- `tests/ui/guest-upload-flow.test.tsx`: controlled remembered-name props were ignored.
- `tests/ui/guest-rsvp-flow.test.tsx`: successful lookup did not report the name to the shared owner.

The same run also exposed five stale `tests/ui/app.test.tsx` manager fixtures missing the Task 1 `guestbookPrompt`; those fixtures were corrected narrowly rather than changing production behavior.

A later explicit RED pinned the server count rule:

```text
npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx -t "derives private-section presence"
```

Result: exit 1; 1 failed and 8 skipped. The failure proved the section was incorrectly inferred from array membership. Production now derives its presence from `ownUnsharedCount`, while a server-confirmed private submission is retained optimistically until the first-page reconciliation includes it.

## Implementation

- `EventPage` initializes one reactive remembered guest name once, persists every shared change through the existing device-global storage API, and passes the controlled value/callback to RSVP, upload, and Guestbook.
- `Guestbook` has only the approved six props: `event`, `contributionEnabled`, `guestName`, `onGuestNameChange`, and `openRequest` plus the component call boundary itself; it reports no whole-page state.
- The disclosure remains mounted beneath every active phase and is read-only outside `photos-primary`.
- Guest reads always use `contract=2`; shared and private cursors advance independently, retain the other stream, and dedupe stably by `source:id`.
- Signature controls support signed, changed-name, and current-draft unsigned states. Leaving one note unsigned never clears the remembered name.
- Explicit confirmation precedes every send. Network/ambiguous failure preserves the body, signature choice, and key; Retry reuses it. Editing after failure rotates the key. Exact replay is deduped.
- Feed errors remain local to reading; the composer and draft stay usable.
- Server-confirmed success clears the completed draft, keeps confirmed rows, and announces exactly `Safely sent to <event name>.`
- Terminal photo delivery preserves the complete receipt, adds exactly one `Leave a guestbook note` control, hides RSVP/gallery/previous-delivery surfaces, keeps Guestbook mounted, and opens/scrolls/focuses its heading with reduced-motion awareness even when the feed request fails.
- Guestbook rows use `dir="auto"`, explicit source/state/ownership labels, event-time-zone timestamps, authorized preview URLs only, event semantic tokens, 44-pixel controls, visible focus, associated errors, and polite atomic live feedback.
- `ClientApiError` now retains safe response status, request ID, and parsed `Retry-After` metadata for calm section-local recovery copy.

## GREEN and regressions

Final exact focused command:

```text
npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/app.test.tsx
```

Result: exit 0; 4 files and 148/148 tests passed.

Task 2/3 client contract/cursor and API-envelope regressions:

```text
npx vitest run --config vitest.config.ts tests/unit/api-envelope.test.ts tests/unit/guestbook-contracts.test.ts tests/unit/guestbook-cursor.test.ts
```

Result: exit 0; 3 files and 15/15 tests passed.

Task 2/3 Worker message API regression:

```text
npx vitest run --config vitest.worker.config.ts tests/worker/messages-api.test.ts
```

Result: exit 0; 1 file and 22/22 tests passed. The command emitted the repository's ordinary local missing-secret warning while the workerd suite itself passed.

Final static gates:

```text
npm run typecheck
npm run lint
git diff --check
git diff --cached --check
```

All exited 0. Lint reported zero warnings.

## Impeccable detector

Ran exactly once at final on the changed UI targets:

```text
node C:\Users\htper\.agents\skills\impeccable\scripts\detect.mjs --json src/pages/EventPage.tsx src/features/guestbook/Guestbook.tsx src/features/uploads/GuestUploadFlow.tsx src/features/rsvp/GuestRsvpFlow.tsx src/features/rsvp/RsvpLookup.tsx src/features/guest/GuestBeforeStart.tsx src/styles.css
```

Result: exit 1. The detector scanned the complete monolithic `src/styles.css` and returned its existing repository-wide side-tab, type-ramp, color, and radius inventory. It did not identify a new Guestbook structural antipattern. The known stale `.impeccable/design.json` versus `DESIGN.md` context was left unchanged as explicitly required. New Guestbook font-size literals were mechanically aligned to the documented 0.875rem, 1rem, and 1.6rem steps after this one allowed detector run; the detector was not rerun.

## Self-review

- Scope: all changes are guest UI/reactive name plumbing plus the narrow safe error metadata used by the section; no Manager/export/backend expansion.
- Privacy: UI consumes shared contracts, never renders session IDs, idempotency keys, object keys, raw private fields, or original-photo URLs.
- Pagination: each request advances only one cursor and retains the other stream; first-page refresh replaces both confirmed accumulations without moving focus.
- Draft safety: signature and body edits after a failed send rotate intent; unchanged Retry preserves intent; current-draft unsigned state does not mutate device-global remembered name.
- Terminal behavior: only the Guestbook survives beside the complete receipt and its one action; all prior secondary surfaces remain absent.
- Accessibility: native disclosure/form controls, programmatic labels, `dir="auto"`, 44-pixel targets, `:focus-visible`, section-local live/error regions, and reduced-motion scroll are present.
- Worktree: explicit staging allowlist used; no unrelated files were staged or committed.

## Concerns and evidence boundaries

- The Impeccable detector remains nonzero because of pre-existing full-stylesheet inventory and the known stale sidecar; it is recorded rather than repaired in this task.
- This task ran the required focused unit/UI/static gates and targeted Task 2/3 regressions. It did not run browser screenshots, visual baseline recapture, full repository release verification, deployment, runtime certification, or physical iPhone/Android/assistive-technology acceptance. Those remain later evidence gates.

## Fix round 1: event identity and failed-intent boundaries

Implementation commit: `e592f6dcee75057e99e3187df5e162f22f3c3b63`

### Accepted findings and RED

Added test-first coverage for both accepted review findings in `tests/ui/guestbook.test.tsx`.

The exact four-file focused command initially exited 1 with 2 failed and 148 passed out of 150 tests. The prop-driven signature case showed that changing the controlled name from Taylor to Morgan reused the prior ambiguous-failure idempotency key. The event-switch test first exposed a test-only route synchronization race; after waiting for the B event identity, this targeted RED showed both intended production failures:

```text
npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx -t "resets every private|keys failed intent"
```

Result: exit 1; 2 failed and 9 skipped. Event A's `A private memory.` row remained rendered after Event B was installed, and Morgan's signed retry retained Taylor's key.

### Remediation

- `EventPage` keys the cohesive Guestbook by the stable event ID, creating a hard privacy boundary for rows, drafts, confirmation, errors, cursor state, and idempotency keys.
- Guestbook aborts pending reads on unmount. First-page tickets and an event-lifetime ticket reject late first-page, pagination, and submission completions, while an already-authorized old submission is still allowed to finish on the network.
- Failed sends retain an explicit `{ body, effectiveGuestName, idempotencyKey }` snapshot. Exact ambiguous retries reuse the snapshot key. A changed body or effective signed name rotates the key and clears stale retry/confirmation state before the next confirmation or send.
- A device-global display-name prop change does not rotate an explicitly unsigned draft because its effective signature remains `null`.

### GREEN and final gates

Exact focused Task 4 command:

```text
npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/app.test.tsx
```

Result: exit 0; 4 files and 150/150 tests passed. After the final compile-only state annotation, `tests/ui/guestbook.test.tsx` also passed 11/11.

Task 2/3 regressions remained green:

- Client API envelope/contracts/cursors: 3 files, 15/15 passed.
- Worker messages API: 1 file, 22/22 passed, with only the repository's ordinary local missing-secret warning.

`npm run typecheck`, `npm run lint`, `git diff --check`, and `git diff --cached --check` all exited 0. The first typecheck after snapshot-key wiring identified TypeScript's narrow `crypto.randomUUID()` template-literal inference; explicitly typing the local key state as `string` resolved it, and both final static gates passed with zero lint warnings.

The Impeccable detector was not rerun, as required. No styles or design-sidecar files changed in this fix round. Explicit staging included only the three production modules and one UI test for the code commit, followed by this report alone.

### Fix-round self-review and concerns

- The event boundary is keyed by server event ID, not presentation phase, so lifecycle refreshes within one event preserve valid Guestbook state while cross-event navigation cannot.
- Late Event A pagination is explicitly resolved after Event B is visible in the regression test and cannot repopulate B. B's first send uses a fresh key.
- Signed external-name changes rotate failed intent; exact signed Retry and unsigned prop-only name changes preserve it.
- No Manager, export, Worker, migration, style, remote, deployment, browser, or physical-device surface was changed or exercised in this round.

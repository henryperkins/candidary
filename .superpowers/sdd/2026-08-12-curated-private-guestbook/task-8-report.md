# Task 8 report: Browser, visual, design-record, and accessibility coverage

## Status

Completed locally in the isolated worktree on `codex/curated-private-guestbook`.
Implementation commit: `9aed5c4b783f48a01350814fe15e1c429c64d50d`
(`test: lock guestbook browser acceptance`).

No push, deployment, remote migration, remote database read, production runtime certification,
operating-system print-dialog check, common-spreadsheet opening, degraded-network rehearsal,
physical-device test, VoiceOver test, or TalkBack test was performed.

## Files

The implementation commit contains exactly 30 allowlisted files:

- design records: `design/design-system.md`, `design/fidelity-ledger.md`;
- observed browser-failure corrections: `src/features/guestbook/Guestbook.tsx`,
  `src/features/guestbook/ManagerGuestbookPanel.tsx`, `src/pages/EventPage.tsx`;
- E2E specs/fixtures: `tests/e2e/accessibility.spec.ts`, `tests/e2e/core-journey.spec.ts`,
  `tests/e2e/event-theming-visual.spec.ts`, `tests/e2e/event-theming.spec.ts`,
  `tests/e2e/fixtures/routes.ts`, `tests/e2e/guest-responsive.spec.ts`,
  `tests/e2e/manager-responsive.spec.ts`, `tests/e2e/rsvp-responsive.spec.ts`, and
  `tests/e2e/visual-qa.spec.ts`; and
- 16 snapshot paths: 13 modified, two added, and one superseded baseline deleted, detailed below.

No stylesheet or other production presentation file changed. No broad staging command was used.

## RED

### Baseline contract failure

Before browser-fixture work, the exact command was:

```text
npm run typecheck:e2e
```

It failed with one TypeScript error: the existing guest fixture did not provide the now-required
`GuestEventView.guestbookPrompt`. The fixture also lacked contract-version-2 Guestbook reads and the
safe Manager summary/list/mutation routes required to render the new surfaces.

### Focused browser expectations

The first exact focused browser command after writing the Task 8 expectations was:

```text
npx playwright test tests/e2e/core-journey.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts
```

It ran 128 tests and exited 1 with 108 passes, 12 intentional project skips, and 8 failures:

- terminal receipt Guestbook-heading focus failed in mobile and desktop because the heading ref was
  read in the same animation frame that requested the conditional disclosure mount;
- the reduced-motion terminal focus case failed for the same reason in both projects;
- a page-wide Manager `Share` locator matched both navigation and row actions in both projects; and
- a page-wide RSVP group count also counted the Guestbook disclosure in both projects.

After the post-commit focus fix and scoped locators, an eight-case targeted command returned four
passes and four failures. Axe reported `heading-order` in both projects because the terminal surface
had an `<h1>` and Guestbook `<h3>` with no `<h2>` bridge. Manager moderation in both projects also
showed that removing the confirmed row could move page scroll and could race focus restoration.

The deliberately held-request Manager regression was then run as:

```text
npx playwright test tests/e2e/manager-responsive.spec.ts --grep "keyboard-only Manager moderation"
```

It failed 2/2 before the final correction. The mobile case captured a user scroll of 450 during the
request and observed 439 after the update; the desktop case lost focus from the intended next-row
`Share` action. This proved that action-start scroll capture and pre-commit ref lookup were wrong.

### Compatibility and visual RED

The exact no-update compatibility command was:

```text
npx playwright test tests/e2e/rsvp-responsive.spec.ts tests/e2e/event-theming.spec.ts tests/e2e/event-theming-visual.spec.ts tests/e2e/visual-qa.spec.ts
```

It ran 148 tests and exited 1 with 71 passes, 61 intentional project skips, and 16 failures. Three
were stale locator scopes: the largest-household count in both projects included the Guestbook
details group, and one metadata assertion expected several DOM text nodes to be one exact text node.
The other 13 were the approved Guestbook label/receipt/Settings/surface snapshot deltas. No unrelated
visual failure was accepted.

## Browser-driven corrections

- `Guestbook.tsx` now records each new receipt open request, mounts the disclosure first, then uses a
  post-commit animation frame to scroll and focus the heading with `preventScroll`. Every repeated
  request is handled once. Reduced motion uses `behavior: 'auto'`; ordinary motion retains `smooth`.
- `EventPage.tsx` gives the terminal Guestbook section an sr-only `<h2>` and `aria-labelledby`
  bridge, preserving the visible composition while restoring the semantic heading sequence.
- `ManagerGuestbookPanel.tsx` captures `window.scrollY` immediately before applying the confirmed
  row-state update (so a user's scroll during the request wins), then restores focus and that captured
  position in a layout effect after the committed refs exist. Focus uses `preventScroll`. Failure
  rendering follows the same immediate-before-update capture rule.
- `tests/e2e/fixtures/routes.ts` now serves the required prompt, contract-version-2 guest projection,
  Manager summary/list views, and safe note/caption mutations without exposing source/session keys.

## Accepted coverage

- Guest and Manager containment at 320 x 844, 390 x 844, representative desktop, 640 x 450 as the
  1280-at-200%-zoom equivalent, and 320 CSS pixels as the 1280-at-400%-zoom equivalent.
- The 160-character prompt, 500-character body, 80-character name, Unicode, RTL, `dir="auto"`,
  overflow wrapping, 44 x 44 targets, visible focus, and no horizontal document overflow.
- Keyboard-only guest contribution and Manager moderation, server-confirmed live announcements,
  gallery-off guest/Manager privacy, stable focus/scroll, and repeated terminal receipt activation.
- The terminal receipt's sole `Leave a guestbook note` follow-on and focus on the composer heading,
  never automatic cursor placement in the textarea.
- Manager `Guestbook`, `Guestbook from the day`, pending-only badge, visibility/source filters, and
  row actions.
- Real `buildGuestbookHtml` output rendered with `page.setContent`: escaped text, semantic
  `article[dir="auto"]`, no script/form/remote asset, zero network requests, at least 7:1 body
  contrast, axe-clean screen and print media, white print ground, and `break-inside: avoid`.
- Design records explicitly separate the shared printable keepsake from the separately named private
  CSV archive.

## Snapshot inventory and inspection

All 15 current changed/added tracked PNGs below were opened and inspected at original resolution.
The exact 15-case, zero-tolerance Playwright run subsequently passed without update mode. The one
deleted file was first confirmed to have no current TypeScript spec reference.

### Thirteen modified baselines

| Tracked file | Pixels | Approved delta |
| --- | ---: | --- |
| `guest-coastal-receipt-390-mobile-win32.png` | 390 x 844 | Sole terminal `Leave a guestbook note` action |
| `manager-candidary-default-preset-film-mobile-win32.png` | 350 x 415 | Re-rasterized themed Manager canvas after approved Settings insertion |
| `manager-candidary-default-upload-natural-mobile-win32.png` | 350 x 415 | Same |
| `manager-coastal-light-preset-film-mobile-win32.png` | 350 x 415 | Same |
| `manager-coastal-light-upload-monochrome-mobile-win32.png` | 350 x 415 | Same |
| `manager-event-appearance-390-mobile-win32.png` | 390 x 4218 | Guestbook prompt/reset/review controls in complete Settings state |
| `manager-garden-party-preset-film-mobile-win32.png` | 350 x 415 | Re-rasterized themed Manager canvas after approved Settings insertion |
| `manager-garden-party-upload-warm-mobile-win32.png` | 350 x 415 | Same |
| `manager-midnight-film-preset-film-mobile-win32.png` | 350 x 415 | Same |
| `manager-midnight-film-upload-soft-mobile-win32.png` | 350 x 415 | Same |
| `guest-secondary-long-content-320-mobile-win32.png` | 320 x 1655 | `Guestbook` disclosure/copy replacing legacy Notes surface |
| `manager-nav-768-mobile-win32.png` | 104 x 1244 | `Guestbook` destination label |
| `manager-nav-count-390-mobile-win32.png` | 390 x 112 | `Guestbook` label beside documented maximum count |

### Two new baselines

| Tracked file | Pixels | Accepted state |
| --- | ---: | --- |
| `guest-default-guestbook-390-mobile-win32.png` | 390 x 1682 | Inherited event tokens, maximum RTL prompt/body, composer, and shared entry |
| `manager-guestbook-390-mobile-win32.png` | 390 x 1079 | Global Manager chrome, heading, counts, filters, state, and actions |

### One removed superseded baseline

- `guest-default-notes-390-mobile-win32.png` — 390 x 1050. It was replaced by the current Default
  Guestbook evidence above and is recoverable from Git history.

## GREEN and verification

- Final exact four-file browser command: exit 0; 116 passed, 12 intentional project skips, zero
  failures out of 128 tests.
- Exact compatibility command: exit 0; 87 passed, 61 intentional project skips, zero failures out of
  148 tests.
- Exact current snapshot command without update mode: exit 0; 15/15 passed at zero configured pixel
  tolerance.
- Repeated reduced-motion terminal request: 2/2 passed; observed scroll behavior was exactly
  `['auto', 'auto']`, with heading focus restored after each activation.
- Post-fixture Manager moderation/gallery-off rerun: 4/4 passed.
- Focused UI regression command:
  `npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx tests/ui/manager-guestbook.test.tsx tests/ui/app.test.tsx`;
  exit 0; 3 files and 127/127 tests passed. jsdom printed eight non-failing
  `Not implemented: Window's scrollTo()` notices.
- `npm run typecheck`: exit 0.
- `npm run typecheck:e2e`: exit 0.
- `npm run lint`: exit 0 with zero warnings.
- `git diff --check`: exit 0; Git emitted only the repository's Windows LF-to-CRLF notices.
- Explicit staging validation: exactly 30 staged paths matched the Task 8 allowlist; there were no
  unstaged tracked changes before commit.

Local Playwright builds emitted the expected missing-local-secret, large-chunk, and inspector-port
warnings. They did not fail the build or tests and do not prove configured production secrets.

## Evidence boundary

This is local Chromium automation against production-like built output, contract-version-2 route
fixtures, and deterministic snapshot content. Print-media emulation and zero-request rendering do not
prove an operating-system print dialog or manual opening in common browsers. No common spreadsheet
application opened the private CSV. Physical iPhone/Android, native camera-picker, VoiceOver,
TalkBack, QR, and degraded-network checks remain separate gates. Immutable release-candidate
verification, remote D1 migration, deployment, live authorization/runtime behavior, and production
data remain unproved and were not authorized.

No Impeccable detector was run: Task 8 made no material UI/CSS redesign, and the Task 4/5/6 detector
runs were already consumed as directed.

# Host welcome review remediation plan

> **For agentic workers:** Use superpowers:subagent-driven-development with one fresh implementer and one fresh independent reviewer per task. Run only the named focused checks.

**Goal:** Resolve the welcome review findings while preserving guarded navigation, account identity, and the existing design.

**Architecture:** Keep the account preference hook and tour component separate. Persist confirmed outcomes separately from recoverable pending outcomes. Resolve exit focus and positioning from the current visible destination, and format legacy dates using their trusted event date.

**Tech Stack:** Existing React, TypeScript, Vitest, and Playwright; no new dependencies.

**Spec:** docs/design/host-event-welcome-brief.md and this chat's review of commit 3afb320.

## Global Constraints

- Work only in /home/ubuntu/candidary/.worktrees/host-event-welcome; preserve the original checkout and existing DESIGN.md/.impeccable/design.json changes.
- All remediation is authorized by the user's “Address all findings comprehensively.” Execute continuously without another approval round.
- Preserve account-bound writes, completion precedence, session suppression, manual link-only replay, and stale event/account response ownership.
- Preserve all existing navigation guards, inert/focus ownership, harmless tour transitions, 44px touch minimum, and reduced motion.
- Run focused RED/GREEN checks only. Reuse successful evidence; reviewers do not repeat implementer checks.
- Keep existing backend evidence: no backend change, migration, repository-wide gates, push, deployment, or main integration.
- Do not stage intermediate work. Make one local commit of owned remediation paths after reviews and scoped verification.

## Review Focus

- Failed dismissal/completion survives reload or event remount as a recoverable account-bound preference; pending completion cannot become dismissal.
- Blocked or full session storage preserves document-local suppression; another account never inherits a pending retry.
- Escape/Skip/close after leaving Overview restores a visible current-destination control or heading; Finish keeps its existing Overview action focus.
- Browser navigation superseding a pending tour request exits stale guidance; ordinary guard refusal retains the current step.
- At 320px and enlarged text, the explanatory target and tour controls remain reachable without horizontal overflow; sentinel dates never render as 1969/1970.

---

### Task 1: Recoverable account preference persistence

**Files:** Modify src/features/manager/use-host-welcome-tour.ts. Create tests/ui/host-welcome-persistence.test.tsx.

**Interfaces:** Preserve useHostWelcomeTour({ eventId, eligible }) and its open/start/close/saveFailed/retrySave interface. Session state remains keyed by account and tour version.

- [x] Add failing tests for failed dismissal/completion followed by remount and retry/manual exit, completion precedence, readable-but-unwritable storage, identity isolation, and stale/in-flight writes.
- [x] RED: npm run test:unit -- tests/ui/host-welcome-persistence.test.tsx.
- [x] Separate confirmed outcomes from pending/failed writes; recover retry state only after authenticating the same account. Cache success after PATCH succeeds, maintain completion precedence, and use memory as a fallback even when storage reads succeed but writes fail.
- [x] GREEN with the same command. Report exact counts and invariants; no staging/commit.
- [x] Fresh independent review, reusing successful evidence. Fix only failing checks or Critical/Important findings with the original implementer.

### Task 2: Tour focus, superseding navigation, and narrow layout

**Files:** Modify src/features/manager/HostWelcomeTour.tsx, src/styles.css, tests/ui/host-welcome-tour.test.tsx, and tests/e2e/host-welcome.spec.ts. Only modify ManagerOverview.tsx if a dedicated mobile action anchor is necessary.

**Interfaces:** Preserve HostWelcomeTour(location, blocked, onNavigate, onClose). Tour progress follows committed destinations; no mutating actions. A mobile target may use the actual recommended action when the entire Overview task region cannot fit above the sheet.

- [x] Add failing tests for later-step Escape/Skip/close focus fallback and superseding navigation during pending transitions; retain ordinary guard refusal behavior.
- [x] RED: npm run test:unit -- tests/ui/host-welcome-tour.test.tsx tests/ui/modal-surface.test.tsx.
- [x] Restore a connected visible invoker when available; otherwise focus a visible current destination anchor/heading. Cancel stale guidance when committed navigation supersedes the requested destination, including pending transitions.
- [x] Position mobile guidance using measured target/panel/viewport bounds so the recommended action is fully visible at 320x568. Keep enlarged content scrollable, all controls accessible, and desktop placement following the same real bounds. Resolve new heading-size advisories using the existing type scale where appropriate.
- [x] GREEN with the same UI command, after Task 1 has finished its hook edits so the unchanged persistence regressions are covered once.
- [x] Extend browser regressions for failed-save reload/recovery, later-step focus, interrupted navigation, and no target overlap at 320/390px and enlarged text. Browser RED before layout correction may use the new single layout case in both projects.
- [x] Browser GREEN: npx playwright test --config playwright.welcome.config.ts tests/e2e/host-welcome.spec.ts. Run after Task 3's header correction. Capture desktop/mobile/enlarged views under output/host-welcome-remediation and inspect in one batch, with at most one material-fix confirmation round.
- [x] Fresh independent review, reusing successful evidence; no staging/commit.

### Task 3: Legacy Overview event date

**Files:** Modify src/pages/ManagerPage.tsx and tests/ui/manager-overview.test.tsx.

**Interfaces:** Preserve zoned actual event starts. EVENT_START_MIGRATION_SENTINEL is not a trusted start and must use eventDate plus the existing timezone fallback.

- [x] Add a failing Overview header test for a sentinel start in America/Chicago, requiring September 19, 2026 and refusing December 31, 1969/January 1, 1970. Keep the existing actual zoned-start assertion.
- [x] RED: npm run test:unit -- tests/ui/manager-overview.test.tsx.
- [x] Render the eventDate fallback for the canonical sentinel; preserve valid zoned starts and existing fallback behavior.
- [x] GREEN with the same command. Fresh independent review; no staging/commit.

## Completion

- [x] Record each task's command/result and independent review without duplicate runs.
- [x] Inspect assembled diff and scoped whitespace; check changed TypeScript files/configs under existing compiler settings without repository-wide gates.
- [x] Update the original verification record with the remediation status and remaining device/backend deployment limitations.
- [x] Make one scoped local commit, preserving preexisting design documentation changes.
- [x] Report the commit, final focused evidence, and any remaining findings.

## Verification record

- Task 1: focused new persistence regressions GREEN 15/15; independent review passed with no Critical/Important findings.
- Task 2: focused tour/modal union GREEN 24/24. Browser complete run 23/24, with the unchanged mobile Back helper timing case passing 1/1 in isolation; all 24 unique cases have successful evidence. Eight captures inspected once; target overlap corrected at 320px and 200% text. Independent review passed with no findings.
- Task 3: focused Overview tests GREEN 10/10; independent review passed with no findings.
- Final integration review passed with no findings. No duplicate tests were run by reviewers or controller.
- Scoped TypeScript: eight owned source/test checks, zero diagnostics after a type-only correction. Scoped whitespace clean; detector found no findings in the changed tour/style area and nine inherited mechanical findings elsewhere.
- Minor coverage notes: mismatched successful PATCH response identity and rejected delayed dismissal with queued completion are not directly covered by the new persistence test file. The reviewer found the source branches correct; no probable production defect or additional fix loop.
- Remaining evidence limits: APIs stubbed in browser, physical devices/screen readers unverified, no full production build or repository-wide gate. Backend migration 0027 still requires production application during an authorized release.

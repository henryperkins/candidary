# Candidary onboarding remediation implementation checklist

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. When using subagents, follow `AGENTS.md`: one fresh implementer and one fresh independent reviewer per task, with focused checks and reused evidence.

**Status — reconciled 2026-10-11 (America/Chicago):** The approved remediation was implemented in `fix/onboarding-remediation`, based on `4ffcc33c4eb1662061ef618f0a0552e4b68a8745`, and is now present in local `main` commits `c55ac5e` (implementation) and `31d87aa` (onboarding role-query type correction). These identities were checked in local Git history; remote parity and deployment are not asserted by the historical evidence. Tasks 1–6 and the single Task 7 plus assembled-diff review passed with no Critical/Important findings. Task 6's native announcement fix passed scoped re-review. Those review results accept the inspected scope and evidence boundaries; **complete screen-reader acceptance remains open**, including human listening and untested platforms. The findings follow-up is reviewed and verified, and the user has authorized its commit and push to `main`. Application deployment remains unverified. See the [accessibility verification guide](../../design/host-welcome-accessibility-verification.md) for per-platform status, concrete acceptance steps and signoff requirements.

**Goal:** Make welcome → event creation → Overview → first useful action a coherent experience for hosts collecting private original photos from account-free guests.

**Architecture:** Keep server-confirmed recommendations and the existing navigation guards. Use a short first-run introduction focused on the current task, plus a separate optional tour of event tools. Share one confirmed context between Overview and guidance; retain existing account/version dismissal and completion storage.

**Tech stack:** Existing React, TypeScript, React Router, Vitest and Playwright; Cloudflare Worker/D1 for isolated runtime checks. No new dependency, backend schema or stored progress cursor is planned.

**Spec/evidence:** The current review is `output/playwright/onboarding-review-2026-10-11/REVIEW.md`, with screenshots in its `gallery.html`. These are local ignored artifacts. Reviewed source: `4ffcc33c4eb1662061ef618f0a0552e4b68a8745`. Read `docs/design/host-event-welcome-brief.md` for safeguards and historical scope; this approved remediation extends its creation boundary and separates introductory help from the tools tour. The old plans remain historical evidence, not authorization for this work.

## Global constraints

- Implement only the paths owned by the relevant task; preserve unrelated work. If the checkout is dirty, use an isolated worktree before implementation.
- Preserve the warm paper/Chestnut/Denim design, typography, primary Create action, private originals, account-free guests and labelled navigation.
- Hosts create/manage events and send invitations or share links themselves. Never imply Candidary sends invitations or requires guest accounts/RSVPs for photo delivery.
- Keep bare `/manage/event/:id` URLs as Library. Change only the explicit creation entry and its registration-return path; retain validated deep links, recovery, adoption and PWA destinations.
- Use server lifecycle/availability and nullable confirmed counts. Never derive phase from the browser clock, convert unknown to zero, or infer invitations sent, QR printed or originals downloaded.
- Guide transitions navigate/focus only. They must not add guests, copy/share automatically, upload, publish, change availability, rotate/disable entry or prepare exports.
- Preserve navigation guards and pre-existing autosave semantics. An existing valid draft may save through normal guarded navigation; the guide must introduce no new field changes or bypass a refused save.
- Reuse `host-event-welcome`, version `1`, and terminal account-level state. Do not reopen dismissed/completed onboarding by bumping its version for these presentation changes.
- Preserve completion precedence, pending versus confirmed saves, identity isolation, retry, same-tab suppression and manual link-only help. Reload closes the guide at the committed workspace; replay starts again. Resume is explicitly deferred.
- Keep modal ownership, inert background, heading focus, Escape, reduced motion, minimum 44px touch targets and standard 48px controls.
- Use disposable local events and synthetic fixtures. No production changes, invitations, personal uploads or destructive access changes for verification; disabled/expired states can be mocked and must be labelled.
- Run only each task's named focused checks. Reviewers reuse successful implementer results. No repository-wide test/lint/build/release gates without an explicit request.
- Do not stage intermediate task changes. The original execution required one scoped commit after task reviews and completion checks if subsequently authorized; the local implementation checkpoint is now `c55ac5e`, followed by type correction `31d87aa`. Current follow-up changes remain unstaged; no release action is included here.

## Review focus and coverage

| Finding or open issue | Solution owner |
| --- | --- |
| F1: creation bypass and hidden manual help | Task 4 |
| F2: wrong anchors, obscured QR/controls, enlarged-text collisions | Tasks 1 and 5 |
| F3: offscreen replay focus and browser Back → BODY | Task 2 |
| F4: static state, premature detail and repeated explanations | Tasks 3 and 5 |
| F5: link/QR journey and optional-RSVP clarity | Tasks 4 and 5 |
| F6: accessible phase/action/progress explanation | Task 6 |
| P3: unconditional account-save note, export caveat | Tasks 4 and 5 |
| Historical brief claims and changed entry/guide contracts | Task 7 |
| Native 200% zoom, speech, dirty drafts, competing dialogs, actual runtime proof | Task 7 |

Five conditions receive explicit regression ownership: a target disappearing during resize (Task 1), external navigation while a step is pending (Task 2), a lifecycle change away from Overview (Task 3), account binding completed while the receipt stays mounted (Task 4), and a refused dirty draft or competing app dialog (Task 7).

## Implemented experience and interfaces

1. Welcome explains: create a private event → share a link or QR → guests send originals without accounts → originals arrive privately.
2. Creation's primary receipt action, **Continue to your event**, opens explicit Overview.
3. Overview shows the current phase, reason and one primary task. **Show me how to collect photos** is a secondary introduction/replay action nearby. **Tour event tools** sits beside the workflow heading.
4. An unseen signed-in account automatically receives the short introduction after event identity, lifecycle and account eligibility are confirmed. Link-only hosts remain manual.
5. The introduction uses one screen: product explanation, actual phase/reason and exact task. Its primary **Go to Share / RSVP / Library / Exports / Settings** navigates through the existing recommendation handler, closes after the intended destination commits, and visibly focuses the appropriate control/status without activation. This is the introduction's completion behavior.
6. The optional tools tour retains six stable steps and Back/Next/Skip/Close. Its copy/anchors adapt to the confirmed state. Its **Finish** retains the existing return to Overview and recommended-action focus.
7. Inline guidance beside actual work controls provides optional RSVP, sharing, publishing and export details when relevant. No introductory detour through all tools is required.

Task 3 defines `HostWelcomeMode = 'intro' | 'tools'`; `useHostWelcomeTour` exposes `mode` and `start(mode = 'intro')` alongside its existing open/close/saveFailed/retrySave API. Automatic launch selects `intro`; **Tour event tools** explicitly selects `tools`.

`src/features/manager/host-welcome-content.ts` contains presentation only. Its `HostWelcomeContext` contains current-event confirmed lifecycle (nullable), phase label, the existing `OverviewRecommendation`, zoned event-start label, nullable named-guest/photo counts, and entry availability (`available | disabled | absent | unknown`). It exports `getHostWelcomeIntroduction(context)` and `getHostWelcomeToolSteps(context)`. Introduction content includes its `OverviewDestination`; tools steps retain stable IDs, destinations, anchor IDs, titles and descriptions. Do not put independent lifecycle policy in these functions.

Manager shares `navigateOverviewTask(destination: OverviewDestination): void` between its existing Overview callback and the introduction. Both Overview and the introduction use it. In particular, `originals` calls existing `openCompleteExport`, rather than generic Library navigation or export preparation. Preserve the existing tour's guarded workspace-navigation callback for tool steps.

## Task 1 — P1: actual targets and collision-free placement

**Files:** `src/features/manager/HostWelcomeTour.tsx`, `src/pages/ManagerPage.tsx`, `src/components/ManagerRsvpPanel.tsx`, `src/features/rsvp/GuestListIntakeLauncher.tsx`, `src/features/gallery/ManagerGalleryWorkspace.tsx`, `src/components/ManagerPhotoIntakePanel.tsx`, `src/styles.css`; tests `tests/ui/host-welcome-tour.test.tsx`, `tests/e2e/host-welcome.spec.ts`.

**Produces:** stable explicit anchors consumed by Tasks 3/5/6; no mutation callback changes.

- [x] Add meaningful browser regressions prefixed `onboarding-layout:` for actual Share link/QR, Add guests, Gallery mode controls and Guest uploads status; include target removal/reappearance during resize. Keep geometry assertions in Playwright, not mocked jsdom rectangles.
- [x] Move Share guidance off the H2 onto the real link/QR region. Use a compact control anchor if the complete QR region cannot fit; show the QR inline after dismissal instead of claiming it is visible during the modal.
- [x] Anchor empty guest-list guidance to the rendered **Add guests** control. For an existing or unknown roster, use the real summary/review region or available control with neutral copy; retain the existing active/history/summary checks that define `pristine`.
- [x] Anchor Library publishing explanation to the real mode-switch group; retain the real Exports summary anchor. Anchor Settings to the **Guest uploads** status/action region, with disabled-state status fallback, rather than the distant Settings H2. Never target destructive access controls.
- [x] Generalize the placement fallback to every viewport width. Measure sticky navigation, target and panel; use a compact truthful anchor or inline explanation whenever they cannot coexist. Reserve visible space for the named target, and make enlarged content scrollable with reachable actions.
- [x] Preserve resize/scroll/DOM-change tracking. Missing targets must remove the outline and offer Retry/Skip; restoring an anchor must recover through Retry.
- [x] Run focused RED/GREEN: `npm run test:unit -- tests/ui/host-welcome-tour.test.tsx`; browser command below with `-g 'onboarding-layout:'`.
- [x] Capture and inspect only affected states at 1440×900, 320×568, 375×667 and desktop 200% root-text enlargement. Assert full target visibility, no panel/target or sticky-header intersection, no horizontal overflow, and at least 44px hit areas. Do not shrink type or targets to make the test pass.
- [x] Record results and one independent review; leave intermediate changes unstaged.

**Done when:** the highlighted object matches the instruction, remains visible, and tracks its real bounds. A fallback states what can be inspected now rather than pointing to concealed content.

## Task 2 — P2: visible exit and navigation focus

**Files:** `src/features/manager/HostWelcomeTour.tsx`; tests `tests/ui/host-welcome-tour.test.tsx`, `tests/e2e/host-welcome.spec.ts`.

**Depends on:** Task 1 anchors. **Produces:** one exit-focus routine shared by Escape, Close, Skip and superseding navigation; introduction completion may reuse it in Task 3.

- [x] Add regressions for a connected invoker below the viewport, a removed invoker, browser Back to a different workspace, and external navigation superseding a pending step. Browser cases use `onboarding-focus:`.
- [x] Replace rendered-size-only focus restoration with current-destination selection plus viewport/sticky-header clearance. Restore the invoker visibly when appropriate; otherwise use the visible recommended action, current section control, or focusable status/heading.
- [x] For external navigation, wait for the committed destination before selecting focus. Do not focus stale anchors or redirect the browser back to the tour's old page. A refused navigation keeps its current step and draft.
- [x] Preserve later-step useful focus and tools Finish → Overview action. Focus must never activate Copy, Add guests, uploads, publishing, availability or export preparation.
- [x] Run focused RED/GREEN: `npm run test:unit -- tests/ui/host-welcome-tour.test.tsx`; browser command with `-g 'onboarding-focus:'`.
- [x] Verify Escape/Close/Skip at both phone widths and browser Back after advancing. Assert settled active element is useful, inside the viewport, and not BODY; use rectangle assertions as well as `toBeFocused()`.
- [x] Record results and one independent review; no staging.

**Done when:** every exit leaves visible focus in the committed workspace; no event action is executed and no guard is bypassed.

## Task 3 — P2: short introduction, optional state-aware tools tour

**Files:** create `src/features/manager/host-welcome-content.ts`, `tests/unit/host-welcome-content.test.ts`; modify `src/features/manager/HostWelcomeTour.tsx`, `src/features/manager/use-host-welcome-tour.ts`, `src/features/manager/ManagerOverview.tsx`, `src/pages/ManagerPage.tsx`; tests `tests/unit/overview-policy.test.ts`, `tests/ui/host-welcome-tour.test.tsx`, `tests/ui/host-welcome-persistence.test.tsx`, `tests/ui/manager-overview.test.tsx`, `tests/e2e/host-welcome.spec.ts`.

**Depends on:** Tasks 1–2. **Produces:** the mode/context/content interfaces above and shared recommendation dispatch for Task 4.

- [x] Add state fixtures for every row below, live changes while guidance is open, stale event responses, and refused introduction navigation. Assertions must name actual copy/action/anchor behavior, not mirror a helper's implementation.
- [x] Compute the recommendation once with `resolveOverviewRecommendation` and share it with Overview and guidance. Preserve expired-access precedence over disabled entry and nullable-count behavior.
- [x] Add client-side mode selection. Keep the introduction to one screen and the broader manual tour to six stable IDs; state changes update text/anchors without invalidating the step index or automatically changing event data.
- [x] Route the introduction's primary action through `navigateOverviewTask`. Mark completion only when the intended workspace commits and a useful focus target exists. If a guard refuses, keep guidance and the draft; revalidate changed context before completing a stale request.
- [x] Keep lifecycle/context fresh while guidance is active outside Overview. Currently lifecycle/summary eligibility and lifecycle rechecks are Overview-only (`ManagerPage.tsx:964–995`). Make tour activity available to resource eligibility, preserving a single controller for open state, current-event ownership, rotation pauses, terminal resource handling and existing bounded server-relative refresh. Do not use a browser-clock phase calculation or create redundant polling subscriptions.
- [x] Use actual loaded entry availability. A missing/loading entry is unknown until confirmed; disabled/absent entry produces informative status, never “use this QR.” Refresh state and target coherently if access changes midstep.
- [x] Preserve account/version state and all retry/identity safeguards. Do not add a new migration, cursor or version bump. Reload/replay labels must not promise resume.
- [x] Update existing six-step tests to explicitly launch tools mode; add separate introduction tests. Preserve their safety assertions and exact step counts rather than relaxing assertions to accommodate both flows.
- [x] Run focused RED/GREEN: `npm run test:unit -- tests/unit/host-welcome-content.test.ts tests/unit/overview-policy.test.ts tests/ui/host-welcome-tour.test.tsx tests/ui/host-welcome-persistence.test.tsx tests/ui/manager-overview.test.tsx`; browser command with `-g 'onboarding-context:|six safe steps'`. New browser context cases cover intro handoff, live updates outside Overview and retrieval without preparation.
- [x] Record results and one independent review; no staging.

| Confirmed state | Correct solution |
| --- | --- |
| Lifecycle unknown/loading/failed | Explain checking/retry; no guessed phase or incomplete-setup claim; manual help remains escapable. |
| RSVP open, guests 0 | Add guests; attendance is optional and host sends invitations. |
| RSVP open, guests positive/unknown | Review RSVPs; do not request repeated setup or equate unknown with empty. |
| Before start, usable entry, scheduled uploads | Prepare/share link or QR; show the actual zoned opening time. |
| Uploads open/open early, photos 0 | Share link or QR; say uploads are already open, not that they wait for start. |
| Uploads open, photos positive | Open Library and explain originals are private. |
| Uploads open, photos unknown | Open Library without claiming either photos or emptiness. |
| Intentionally paused | Review availability or leave paused; no error framing or promised automatic opening. |
| Permanently disabled entry | State that link and QR no longer work and cannot be replaced; Settings reviews access, not repairs it. |
| Guest access ended, management valid | Retrieve originals through existing guarded Exports intent; no sharing prompt or automatic export preparation. |
| Both ended and disabled | Retain retrieval precedence and the disabled-entry truth. |

**Done when:** the introduction hands off in one guide advance to the useful confirmed task, broader exploration is optional, and every named state yields truthful instructions. Existing dismissal/completion is respected.

## Task 4 — P1/P3: creation entry, visible help and account receipt state

**Files:** `src/pages/CreatePage.tsx`, `src/features/manager/ManagerOverview.tsx`, `src/pages/ManagerPage.tsx`; tests `tests/ui/app.test.tsx`, `tests/ui/manager-overview.test.tsx`, `tests/unit/manager-location.test.ts`; create `tests/e2e/onboarding-entry.spec.ts`, reuse `tests/e2e/fixtures/routes.ts` where suitable.

**Depends on:** Task 3 modes/dispatch.

- [x] Add anonymous and signed-in creation → receipt → explicit Overview cases, plus account registration return/adoption. Fill all required fields, including RSVP deadline, and stub responses consistently with the current contract.
- [x] Change both explicit creation destinations: receipt primary (`CreatePage.tsx:170`) and account-registration `onStarted` return (`:191`) to `?section=overview`. Label primary **Continue to your event**. Preserve canonical safe-return validation and truthful failed-adoption continuation.
- [x] Put **Show me how to collect photos** beside the recommended task, subordinate to its primary button. Put **Tour event tools** beside the workflow heading; both use explicit mode callbacks rather than handing React click events directly to `start(mode)`.
- [x] Show the account-save deadline note only while `!saved`, including binding completed while the receipt remains mounted. Show **Saved to your account** after success. Keep the private-management-link warning and pending-registration lost-link warning accurate.
- [x] Keep `manager-location.ts` unchanged: bare Manager → Library. Retain direct workspace, account-list Overview, recovery, adoption and login-return semantics outside the two creation call sites.
- [x] Run focused RED/GREEN creation UI: `npm run test:unit -- tests/ui/app.test.tsx -t 'creates an event with its Event link|offers a visible midnight start time|skips registration entirely|moves create-success registration|relaxes the warning'`. Add the mounted-binding note assertions to these existing focused cases.
- [x] Run focused Overview/routes: `npm run test:unit -- tests/ui/manager-overview.test.tsx tests/unit/manager-location.test.ts`; browser command against `tests/e2e/onboarding-entry.spec.ts`.
- [x] Check first phone viewport: event identity, phase, recommended action and secondary help are discoverable without a long scroll. Signed-in unseen accounts get introduction once; anonymous hosts can open it without signing up; dismissed/completed accounts are not forced into it.
- [x] Record results and one independent review; no staging.

**Done when:** creation and its registration return reach Overview intentionally, existing deep links retain their meaning, and receipt account state stays truthful through binding.

## Task 5 — P2/P3: core journey copy and contextual guidance

**Files:** `shared/site-content.ts`, `src/pages/LandingPage.tsx` only if layout needs adjustment, `src/pages/CreatePage.tsx`, `src/pages/ManagerPage.tsx`, `src/features/manager/ManagerOverview.tsx`, `src/features/manager/host-welcome-content.ts`, `src/features/rsvp/GuestListIntakeLauncher.tsx`, `src/components/ManagerRsvpPanel.tsx`, `src/features/gallery/ManagerGalleryWorkspace.tsx`, `src/features/gallery/GalleryExportControl.tsx`; focused tests `tests/ui/app.test.tsx`, `tests/ui/manager-rsvp-panel.test.tsx`, `tests/unit/host-welcome-content.test.ts`, `tests/e2e/public-responsive.spec.ts`.

**Depends on:** Tasks 3–4. Copy below is the proposed replacement, with state-dependent variants rather than universal schedule promises.

| Location | Solution / wording |
| --- | --- |
| Hero and matching site summary | “Create a private event and share its link or QR code. Guests send original photos without an app or account. Photos arrive privately; you choose what to share.” Keep the existing headline and Create CTA. |
| Before example/journey | Explicitly label optional RSVP; retain guest/host-view labels, the same-code timeline and no-send disclosure. Attendance setup must not appear required for photos. |
| Receipt, scheduled usable entry | “Your guest link and QR are ready. Photo uploads open [zoned date/time]. Keep your management link private so you can return.” Use appropriate alternatives for early/open/paused/unavailable entry. |
| Receipt and guest-list help | “RSVP is optional. If you want attendance replies, set up your guest list. You send invitations; guests can send photos without RSVPing.” |
| Required deadline helper | “This date controls attendance replies if you use RSVPs. Photo uploads follow your event’s upload settings.” Keep the required field/API validation; do not label the date optional or make it nullable. |
| Receipt QR aside | “Share this link or print its QR. It opens the guest activity available for your event.” Remove the contradiction that paused RSVP is available “now.” |
| Share heading + inline hint | **Share your link or QR.** “Copy the guest link or download the QR. Guests send originals without an account.” Add the state-correct upload opening/availability sentence. |
| Disabled entry | “This event’s guest link and QR have been permanently disabled. Guests can no longer use them.” No replacement/resume promise. |
| Empty Library, scheduled | “No photos yet. Share your guest link so guests are ready when uploads open.” |
| Empty Library, open | “No photos yet. Share your guest link so guests can send originals.” Paused/disabled/ended states instead describe their confirmed availability. |
| Gallery mode hint | “Originals stay private in Library. Album and Guest gallery are optional ways to share selected photos.” Place beside mode controls; no requirement to switch or publish. |
| Exports contextual hint | “When photos arrive, use Exports to download the originals.” Do not ask an empty collection to prepare a disabled export. |
| Ready complete export | “Your complete export is ready. Open Exports to download it.” Preserve actual readiness and download states; do not mark a download complete from job readiness. |

- [x] Apply shared landing copy consistently to React, public Markdown and site blurb consumers. Remove repeated tour-sized prose from Overview rows; keep one concise purpose per tool.
- [x] Add relevant inline help in the existing workspaces instead of introducing new modal steps. Share controls remain usable after guide dismissal; optional detail must not compete with the primary action.
- [x] Keep state-based copy in the shared content resolver where appropriate. Use the existing trusted zoned formatter and legacy/sentinel fallback; never emit invalid dates or state-inappropriate “opens at start” promises.
- [x] Add content/state assertions to existing focused tests rather than brittle snapshots of full pages. Run `npm run test:unit -- tests/unit/host-welcome-content.test.ts tests/ui/manager-rsvp-panel.test.tsx`; reuse Task 4's creation cases with new copy assertions only when their implementation changes.
- [x] Run focused public browser checks: `npx playwright test --config playwright.welcome.config.ts tests/e2e/public-responsive.spec.ts -g 'landing headline|landing copy|landing onboarding anchor'`.
- [x] Inspect welcome/receipt/Share at 320 and 375 after copy changes; primary actions remain visible, link values do not overflow, host/private links remain clearly distinguished, and the existing lead contrast is preserved.
- [x] Record results and one independent review; no staging.

**Done when:** welcome and receipt explain each person's role, link/QR sharing, private originals and optional RSVP; later details appear beside the work they support.

## Task 6 — P2: accessible dialog context and announcements

**Files:** `src/components/ModalSurface.tsx`, `src/features/manager/HostWelcomeTour.tsx`, `src/pages/ManagerPage.tsx` only for status wiring; tests `tests/ui/modal-surface.test.tsx`, `tests/ui/host-welcome-tour.test.tsx`, `tests/e2e/host-welcome.spec.ts`.

**Depends on:** Task 3 final content/modes and Task 5 copy.

- [x] Add optional `describedBy` support to ModalSurface, leaving other consumers unchanged. Associate the guide's concise body/progress with its dialog; retain `aria-labelledby`, `aria-modal` and heading focus.
- [x] Put confirmed phase, reason and exact task label inside the introductory dialog itself. Do not rely on an inert background target to convey information to screen readers or short-phone users.
- [x] For the tools tour, announce accurate **Step N of 6** and current-step context. Treat the single-screen introduction as an introduction, not an artificial multi-step progress indicator.
- [x] Keep unavailable-target and failed-save messages discoverable as statuses. Avoid simultaneous duplicate live announcements; focus remains in the active step and background controls stay excluded.
- [x] Add accessible-description, step-change and keyboard regression assertions. Run focused RED/GREEN: `npm run test:unit -- tests/ui/modal-surface.test.tsx tests/ui/host-welcome-tour.test.tsx`; browser command with `-g 'onboarding-a11y:'` for AX description/background exclusion, keyboard ring and automated scan.
- [x] Preserve contrast: normal text at least 4.5:1; do not lighten the welcome lead (reviewed at 4.5046:1). Keep button prominence and visible focus treatment.
- [x] Record results and one independent review; native speech proof belongs to Task 7 and cannot be inferred from AX/axe alone.

**Done when:** dialog name/description/contents provide the actual task without reading the background, keyboard containment remains intact, and statuses have clear semantics.

## Task 7 — completion: focused integration, remaining evidence and documentation

**Files:** `tests/e2e/host-welcome.spec.ts` for new recovery/integration cases, `docs/design/host-event-welcome-brief.md`, `docs/superpowers/plans/2026-10-11-onboarding-remediation-checklist.md`; evidence under `output/playwright/onboarding-remediation-2026-10-11/`.

**Depends on:** Tasks 1–6. These are completion checks, not results already obtained.

- [x] Add focused `onboarding-recovery:` cases for dirty guest-list Stay/Leave, valid Settings draft save versus invalid/failed-save refusal, competing app-dialog ownership, and external navigation while a guard is pending. Retain edited input on refusal; distinguish expected pre-existing autosave PATCHes from new event mutations. Use actual app dialog/guard code in the browser fixture, not a bare injected dialog as the sole proof.
- [x] Add one `onboarding-integration:` case for welcome → create → receipt → Overview → short introduction → actual first control, then reload/replay. Record event mutation requests and verify the guide only changes its own preference; copying is a deliberate user action after dismissal.
- [x] Run those newly owned cases once with browser command `-g 'onboarding-recovery:|onboarding-integration:'`. Reuse previous task results; do not rerun a full focused union independently as implementer, reviewer and controller. New changes/failures are the reason to repeat only the affected lane.
- [x] In an isolated actual Worker/D1 runtime, walk anonymous and signed-in creation and intro/tool replay. Capture representative desktop/320/375 views, compare event-domain snapshots, and label synthetic data. Test failed preference PATCH/retry and fresh-session terminal suppression if the mode integration changed those behaviors; report actual backend evidence separately from API-stub browser checks.
- [x] Verify native browser-toolbar 200% zoom in an interactive supported browser; record native setting and viewport. Inspect visible actions/targets, sticky clearance and overflow. Keep CSS 200% text and reflow-proxy evidence separately labelled.
- [ ] Complete actual screen-reader acceptance with a named reader/browser combination: initial name/task, tools progress, Next/Back, spontaneous missing-target status, failed-save retry, Escape/Close/Skip and returned focus. Historical Linux scoped speech observations passed; human listening and the named platform rows remain open. Follow the [verification guide](../../design/host-welcome-accessibility-verification.md) and record utterances/focus per scenario instead of claiming compliance from screenshots/axe or a review PASS.
- [x] Record touch/device and cross-engine checks performed, if any. Unperformed platforms stay explicitly unverified; do not fabricate a supported-browser claim.
- [x] Reconcile the brief: creation now enters Overview, intro and tools replay are distinct, intro handoff differs from tools Finish, and inline help owns optional details. Correct or label historical “no tour record” and bare Host Events link prose. Preserve historical deployment checkpoints and mark current deployment unverified unless separately proven.
- [x] Update this checklist with task-specific command/result, relevant invariant, review result and remaining limitation. The original review's 9/9 Worker and clean-domain evidence remains baseline evidence, not proof of changed implementation. Rerun `npm run test:worker -- tests/worker/host-tour-state.test.ts` only if backend or account/version persistence contracts actually changed.
- [x] Inspect the assembled owned diff, run scoped whitespace/reference checks, and use one independent completion review without duplicate evidence generation. If committing is authorized, stage an explicit owned-file manifest once at the end; no push, merge or deployment is included here.

**Done when:** every finding has a completed solution and acceptance record, no Critical/Important review finding remains, no existing guard/persistence invariant regressed, and evidence limitations are stated accurately. Native zoom/speech checks stay open until performed; a missing environment is a named gap, not a passing check.

## Commands and evidence discipline

The browser shorthand above is:

```bash
npx playwright test --config playwright.welcome.config.ts tests/e2e/host-welcome.spec.ts -g '<task-owned prefix>'
```

Named new prefixes must exist before that task's verification command is used. Use `tests/e2e/onboarding-entry.spec.ts` for Task 4's dedicated entry cases. The welcome config starts Vite on `127.0.0.1:4175` with `reuseExistingServer: false`; ensure the port is free and dependencies/Chromium are present. It exercises the real frontend with explicitly stubbed APIs and does not prove Worker, email or production behavior. It does not require a repository-wide production build.

For source behavior changes, add the named failing regression, record RED for the intended reason, implement, then record GREEN. For copy/documentation alone, use existing focused checks and reference/visual inspection rather than implementation-mirroring tests. If a baseline has an unrelated failure, record it and preserve its assertions; do not claim a green suite from unrelated isolated passes.

Task review passes with no Critical or Important findings. Record Minor coverage/polish notes without a fix/re-review loop unless they reveal a probable production defect. A necessary fix goes back to the original implementer and receives one scoped re-review. The original checklist was documentation-only. Implementation command results below now supersede that planning-time statement; qualified multi-run results are not represented as one uninterrupted green suite.


## Execution evidence — 2026-10-11

Historical execution evidence is retained under `.worktrees/onboarding-remediation/.superpowers/sdd/2026-10-11-onboarding-remediation-checklist/` (task reports/reviews and raw command logs) and that worktree's `output/playwright/onboarding-remediation-2026-10-11/` (browser/runtime artifacts). Paths in the original command records below are relative to that worktree. The original review's **9/9 Worker checks and clean-domain evidence at `4ffcc33` are historical baseline evidence**. The account/version/backend contract was unchanged, so the Worker lane was not rerun for that execution. No repository-wide test, lint, typecheck, build or release gates ran in the recorded 2026-10-11 implementation loop. That historical scope statement does not describe any later qualification or release.

Browser shorthand in the table is `npx playwright test --config playwright.welcome.config.ts <file> -g '<prefix>'`; unit shorthand is `npm run test:unit -- <files>`. The Vite 4175 browser lanes use explicitly stubbed APIs. Explicit viewport matrices belong to one configured project; duplicate project executions are skipped deliberately.

| Task | Focused command and result | Invariant and review |
| --- | --- | --- |
| 1 | Unit `tests/ui/host-welcome-tour.test.tsx`: 20/20. Browser `host-welcome.spec.ts`, `onboarding-layout:`: 6 unique cases. | Real/compact anchors, measured target/panel/sticky separation, resize recovery, 44px targets. Independent review PASS; Minor inline-only fallback coverage note retained. |
| 2 | Unit `tests/ui/host-welcome-tour.test.tsx`: 26/26. Browser same file, `onboarding-focus:`: 11 unique cases. | Visible exit focus and committed navigation; no action activation. Review PASS. Controlled stable intake-anchor fixture is not a real guest-intake interaction proof. |
| 3 | Unit content/policy/tour/persistence/Overview union: 83 distinct cases collectively. Browser `onboarding-context:|six safe steps`: 7 executions plus 4 affected fix executions. | Shared confirmed state, intro handoff, tools replay and unchanged persistence. Scoped re-review PASS after correcting stale-test coverage. |
| 4 | App five named creation/registration cases: 5 passed, 242 excluded. Overview/routes: 75 passed. `onboarding-entry.spec.ts`: 10 unique cases, 10 duplicate skips. | Explicit creation Overview, current saved receipt, manual/unseen/terminal entry semantics. Review PASS. |
| 5 | Content/RSVP: 73; five creation cases: 5; approved direct Share/Library context case: 2. **80 unique unit/UI cases collectively**. Public browser `landing headline|landing copy|landing onboarding anchor`: 6 executions collectively; affected copy rerun only. | Truthful contextual copy and existing bounded resource eligibility. Re-review PASS. Compatibility-only locator lanes were not separately run. |
| 6 | Modal/tour UI: 38 passed. Browser `onboarding-a11y:`: 5 unique cases collectively; four matrix cases had one affected locator correction/rerun. | AX/axe, context, progress, keyboard containment and one status owner. Initial review and scoped native-finding re-review PASS. The follow-up retains full dialog context and short focused-heading progress; 2 focused unit cases and 1 desktop AX case passed. Retry failure clears at retry **start**, before confirmation; focus recovery may happen then. |
| 7 | `host-welcome.spec.ts`, `onboarding-recovery:|onboarding-integration:`: **7 distinct scenarios passed collectively**, with only failed/newly changed cases rerun. Detailed run qualification below. | Actual application guard/modal code, deliberate creation/Copy separated from guide writes; runtime and native evidence below. Independent Task 7 plus assembled-diff completion review PASS; no Critical/Important findings, successful focused evidence reused. |

Task 7 browser logs: first run **4 passed / 3 fixture failures / 7 skips**; affected three **1 passed / 2 fixture failures / 3 skips**; affected two first failed on an assumed Share focus target, then **2 passed / 2 skips**. Additional invalid/failed Settings retention assertions first exposed an incorrect internal-navigation assumption, then **2 passed / 2 skips** with the actual refusal contract. Successful earlier lanes were retained. No blanket retries or duplicate union run. Fixture corrections used actual server recommendation, awaited settled guide geometry, and identified the focusable guest-link `code` control; no production behavior or assertion was weakened.

Recovery uses actual guest intake, Settings autosave, Router blockers and upload ModalSurface. A controlled synthetic setup invokes real React controls/inputs while background is inert, modelling pre-existing/asynchronous state; it does **not** claim a host can interact with inert controls. No bare injected dialog or replacement anchor is the sole proof. The real intake removes its launcher target, so the guide offers Retry/Skip rather than an enabled Next/Back. Stay retains the current guide and edited input; Discard commits a real navigation intent; Browser Back supersedes a pending guarded intent to Overview with useful focus. A host-reachable guide-Next-with-dirty-intake path is not claimed; Task 2's controlled pending-step fixture remains separately qualified. Valid Settings produces one expected autosave PATCH. Invalid/failed drafts preserve input and refuse the exercised external Home and internal Overview Router intents. Actual upload modal owns the only active dialog, then returns to the guide without upload requests.

The integration case records the deliberate `POST /api/events` before the guide, fills all required fields including RSVP deadline, enters Overview from the receipt, completes introduction at the focusable guest-link control, and only then deliberately presses Copy. Guide-only event mutations are zero; only the account preference changes. Reload stays in Share; tools replay begins at step 1.

### Actual isolated Worker evidence

`node output/playwright/onboarding-remediation-2026-10-11/task-7/runtime.mjs` completed against `http://localhost:4186` with separate disposable D1/R2 storage. Synthetic events and a pre-seeded verified local host are used; no registration email, invitation or personal upload is exercised. Browser-only CSP bypass accommodates the Vite preamble; source security headers are unchanged.

Anonymous and signed-in welcome → creation → receipt → Overview → introduction → actual Share focus → reload → six tools/Finish passed. The server confirmed **Before the event / Prepare your QR**, with the real zoned opening time. Representative 1440, 320 and 375 CSS-pixel views were captured. The longer scheduled introduction requires internal panel scrolling for its primary action at some narrow sizes; scrolling brings the control into view without shrinking text or controls. Earlier probe failures were incorrect destination/focus assumptions and an initial-visibility claim; successful runtime evidence is from the corrected final probe, not those failed attempts. Probe attempts created additional disposable local events; none were removed or used as production data.

`domain-before-{false,true}.json` equals its matching `domain-after-{false,true}.json` for all snapshotted event-domain tables during each guide-only interval. The deliberate creation is outside that interval. Signed-in preference failure is one **mocked transport 503**, followed by an **actual Worker PATCH 200** on Retry; it is not an induced D1 failure. `fresh-context.mjs` used a new browser context with cookies only and no restored local/session storage: actual Worker GET confirmed `completed`, automatic introduction stayed suppressed, and manual replay worked. Runtime report, snapshots and fresh-context result are in Task 7's artifact folder; credentials/cookies remain private ignored files.

### Historical native platform evidence and remaining gaps

Chrome for Testing **149.0.7827.55**, native X11 toolbar **Zoom: 200%**, measured **640×418 CSS viewport / DPR 2**. No CSS-font or viewport emulation supplied that native zoom. The real X11 menu screenshot and native measures record the setting. The original CDP `native-zoom-app.png` / `native-zoom-actions.png` captures were blank and are failed visual artifacts; `native-zoom-guide-x11.png` supplies the corrected real desktop guide view. Overflow was zero; the panel remained within the viewport, the recommended target was clear of the sticky header/panel, and keyboard Tab made Close, Skip and Go to Share fully visible (44.4px / 48px / 48px heights). The initial primary lies below the panel's internal scroll; reachability is proven, initial visibility is not. Earlier Tasks 1/6 CSS 200% text and reflow evidence remain separately labelled.

Orca **50.2** with Speech Dispatcher **0.12.1/eSpeak NG** and the same full native browser produced real `SPEECH OUTPUT` records and captured WAV output through an isolated PulseAudio sink. These are actual reader/synthesizer artifacts, not AX/axe inference and not human listening. Initial native checks revealed full body repetition at both dialog and focused heading on intro, Next and Back. The original Task 6 implementer changed only the heading description to short progress, retained the full dialog body, and updated the two focused regressions plus existing AX expectation. The original reviewer accepted the scoped fix without new Critical/Important findings. The actual native follow-up confirms one full-body output for the settled introduction, Next to step 2 and Back to step 1, followed by only short heading progress. The first intro follow-up overlapped document-load speech; only that intro was repeated on the settled page. Exact utterances are in `orca-intro-postfix-speech.txt` and `orca-postfix-speech.txt`. No flow/domain/browser union was repeated. Recovery speech and manual-listening status are recorded in Task 7's report. The missing-target text was spoken through native reader navigation, but spontaneous announcement overlapped ongoing step speech and was not isolated; this is a timing/capture gap. Final Close returned-focus speech was not captured, although native activation and DOM focus passed. Human listening remains unperformed. The complete reader acceptance box remains open for these named gaps.

No physical mobile device, Safari/WebKit, Firefox, VoiceOver or NVDA was tested. Production application deployment and live provider/email behavior remain unverified in these records. The single independent Task 7 plus assembled-diff completion review passed with no Critical/Important findings or new Minor findings (`task-7-review.md`); successful focused evidence was reused without additional test or runtime executions. This is a scoped review PASS, not a clean overall Orca/platform acceptance result. The [verification guide](../../design/host-welcome-accessibility-verification.md) keeps native utterances, DOM/AX checks, audio capture, human listening and platform signoff separate.


Historical scoped completion checks: the approved owned-file manifest is `.superpowers/sdd/2026-10-11-onboarding-remediation-checklist/owned-paths.txt`. Whitespace and referenced-path checks are recorded in `task-7-scoped-checks.log`. The single independent Task 7 plus assembled-diff completion review is **PASS**, recorded in `task-7-review.md`, with no Critical/Important findings and no new Minor findings. The review reused successful focused evidence; no further checks accompanied that metadata update. At that checkpoint, the complete reader acceptance checkbox and named manual speech/platform gaps remained open. The follow-up below records the current Linux capture results.

### Findings follow-up — 2026-10-11 (America/Chicago)

The [accessibility verification guide](../../design/host-welcome-accessibility-verification.md) is the current reader-status and platform-signoff record. It retains historical observations and supplies the concrete intro/tools/recovery/exit/guard sequence, expected task/focus, official reader documentation, artifact requirements and human signoff. Local Git inspection confirms remediation commits `c55ac5e` and `31d87aa`; it does not prove remote parity or deployment.

A new settled Linux/Chrome 149/Orca 50.2 capture reproduced a silent spontaneous missing-target message at source `31d87aa`. The populated status paragraph had been inserted conditionally. The final narrow fix keeps both the polite/atomic status container and its text paragraph mounted; the empty paragraph is visually hidden, and recovery changes existing text without moving heading focus. The container-only intermediate attempt was still silent because the reader discarded the child insertion after the parent event. That unsuccessful attempt remains evidence, not GREEN.

Focused command: `npm run test:unit -- tests/ui/host-welcome-tour.test.tsx -t 'keeps recovery announcements in a persistent polite live region|keeps missing-target and failed-preference recovery'`. The initial RED failed on the absent persistent region; the refinement RED failed on the absent text paragraph; final **2 passed / 31 skipped**. Region/text identity persists across target disappearance and Retry, heading focus stays useful, and missing-target/save failure retain one status owner. Existing JSDOM `scrollBy` diagnostics are recorded. The existing browser retry assertion now expects the retained empty status, rather than a removed node. Its sole affected case passed **1/1** with `npx playwright test --config playwright.welcome.config.ts tests/e2e/host-welcome.spec.ts --project=desktop -g 'failed-save replay and missing target expose one recoverable status'`; the earlier over-anchored selector found no tests and is retained as a selection failure. No browser union accompanied this change.

`CANDIDARY_READER_ONLY_MISSING=1 dbus-run-session -- xvfb-run -a -s '-screen 0 1440x1080x24 -nolisten tcp' bash output/playwright/host-welcome-findings-2026-10-11/reader/native-session.sh`, followed by `node output/playwright/host-welcome-findings-2026-10-11/reader/finalize-evidence.mjs`, passed the single affected native window. At **2026-10-12 01:06:28.231–01:06:35.890 UTC** (Chicago 2026-10-11), earlier speech had completed with 1.605s quiet; Orca and Speech Dispatcher emitted the full unavailable-target sentence **once**, with **Your next task** still focused. WAV header/nonzero PCM are validated; no human listened.

New Close/Escape/Skip windows separately proved returned-focus utterances and matching DOM focus: **Tour event tools**, **Show me how to collect photos**, and **Add guests** in the committed RSVP workspace. Those successful pre-status-fix observations were reused. Skip's Orca debug tail was truncated by buffering; bounded Speech Dispatcher SPEAK/END records and recorded PCM supply its native utterance evidence. All source hashes, raw results, UI logs, original native RED, the unsuccessful intermediate attempt and earlier setup failures are retained under `output/playwright/host-welcome-findings-2026-10-11/reader/`.

The two Linux capture gaps are now addressed for this named combination. Complete-reader acceptance remains open for human listening, physical/native keyboard interaction and the untested Firefox, Safari/WebKit, VoiceOver, NVDA and physical mobile rows. Browser/CDP input and synthetic local fixtures were used; no production data, historical credentials, global reader preferences, broad gates or release action were involved.

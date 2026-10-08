# Host Event Welcome Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Read the approved spec and this task's extracted brief. Run focused RED/GREEN checks only.

**Goal:** Give hosts an Overview with one truthful recommended task and a six-step replayable tour.

**Architecture:** Extend explicit Manager locations while preserving bare Library routing. Overview consumes independent lifecycle and RSVP-summary resources. The tour observes committed guarded destinations, positions a ModalSurface at visible controls, and persists dismissal/completion per account and version.

**Tech Stack:** Existing React/Vite, TypeScript, Hono, D1, Vitest and Playwright; no new product dependencies.

**Spec:** docs/design/host-event-welcome-brief.md, approved by the user.

## Global Constraints

- Preserve DESIGN.md identity, global host palette, labelled navigation, 44px touch floor, 48px standard controls and reduced motion.
- Preserve bare Manager URLs as Gallery → Library. Change only Your events entry to explicit Overview. Preserve creation, recovery, login-return, management-link and PWA destinations.
- Use server phase/access rules. Unknown counts remain unknown. Never claim invitations sent, QR printed, or originals downloaded.
- RSVP is optional. Private originals/retrieval are independent of Album and Guest gallery publication. The same printed QR serves RSVP and delivery.
- Tour navigation explains; it never submits a roster, uploads, publishes, edits settings, opens mutating controls or starts an export.
- Event identity remains the only shell load gate. Preserve independent resource failure/retry and generation ownership.
- One fresh implementer and independent reviewer per task. Reuse successful focused evidence; fix loops only for Critical/Important findings or failing focused checks.
- Work in /home/ubuntu/candidary/.worktrees/host-event-welcome. Do not modify the original checkout, run repository-wide gates, stage intermediate changes, push, deploy or apply remote migrations. Make one scoped local commit at the end. Leave copied DESIGN.md and .impeccable/design.json unstaged.
- The user's Approved. Proceed. authorizes this implementation. Execute without another approval round.

## Review Focus

- Access/accounts: guest/other-event credentials cannot read lifecycle; link-only hosts cannot write account tour state; account changes retire stale reads.
- Lifecycle ambiguity: RSVP, open-early, paused, legacy and expiry boundaries retain server semantics; unknown summaries never select Add guests.
- Refused navigation: dirty RSVP, pending writes, Album preparation and rotated-link gates suspend the tour and retain its step until a destination commits.
- Modals/anchors: hidden/loading targets and child dialogs never get misplaced arrows or a competing focus trap.
- Narrow/large text: 320px and enlarged text retain complete controls without horizontal overflow.

---

### Task 1: Host lifecycle and account tour persistence

**Files:** Modify shared/contracts.ts, worker/routes/manage.ts and worker/routes/host-auth.ts. Create worker/http/host-event-lifecycle.ts, worker/db/host-tours.ts and migrations/0027_host_tours.sql. Tests: tests/worker/host-event-lifecycle.test.ts and tests/worker/host-tour-state.test.ts.

**Interfaces:**
- HostEventLifecycleView: phase: GuestEventPhase; rsvpState: RsvpState; photoIntakeState: PhotoIntakeState; guestAccessEnded: boolean; entryDisabled: boolean; lifecycleRecheckAfterMs: number | null.
- selectHostEventLifecycle(event: EventRecord, now?: Date, entryDisabledAt?: string | null): HostEventLifecycleView; disabled state is loaded from EventEntriesRepository.
- Shared constants HOST_EVENT_WELCOME_TOUR_KEY = 'host-event-welcome' and HOST_EVENT_WELCOME_TOUR_VERSION = 1.
- HostTourStateView: accountId: string; tourKey: typeof HOST_EVENT_WELCOME_TOUR_KEY; version: number; status: 'unseen' | 'dismissed' | 'completed'.
- GET /api/manage/events/:eventId/lifecycle uses requireManager and privateJson.
- GET/PATCH /api/host/tours/host-event-welcome/:version requires host authentication. PATCH accepts only status dismissed/completed and validates host CSRF/origin. Return HostTourStateView; support only current version. PATCH also accepts optional x-candidary-tour-account-id as an expected-identity assertion; mismatch refuses before writing, while persistence always derives account ID from authentication.

- [x] Write failing route tests using resetDatabase, eventAccess, hostAccess, hostWriteHeaders and existing lifecycle fixtures.
- [x] Run RED: npm run test:worker -- tests/worker/host-event-lifecycle.test.ts tests/worker/host-tour-state.test.ts.
- [x] Implement projection using one server now, resolveGuestEventPhase with isRsvpConfigured, and resolvePhotoIntake. Refresh is the earliest positive phase/photo boundary or guest/management expiry. Project entryDisabledAt as entryDisabled; expose no credentials or roster.
- [x] Migration: account FK/cascade, composite primary key (account_id, tour_key, version), constrained terminal status, server timestamps. Missing row is unseen. Idempotent upsert preserves completed against delayed dismissed writes.
- [x] Cover deadline+1/start/guest-expiry boundaries, early-open, paused, legacy, private no-store on success/failure, guest/other-event refusal, missing state, fresh-session/event persistence, account/version isolation, link-only refusal, CSRF/origin and completion precedence.
- [x] Run GREEN with the same command. Report command, counts, invariants and concerns. Do not stage or commit.

### Task 2: Overview policy, resources, entry and navigation

**Files:** Modify src/app/manager-location.ts, src/pages/HostEventsPage.tsx, src/pages/ManagerPage.tsx, src/features/manager/ManagerNavigation.tsx and relevant existing stylesheet. Create src/features/manager/ManagerOverview.tsx and src/features/manager/overview-policy.ts. Tests: tests/unit/manager-location.test.ts, tests/unit/overview-policy.test.ts, tests/ui/manager-overview.test.tsx and tests/ui/host-events.test.tsx.

**Interfaces:**
- Consume Task 1 lifecycle and existing /api/manage/events/:eventId/rsvp/summary returning RsvpSummary.
- Add overview as non-Gallery ManagerSection; default/invalid still canonicalize to Library.
- resolveOverviewRecommendation(lifecycle: HostEventLifecycleView | null, namedInvitees: number | null, deliveredPhotos: number | null) returns label, reason and destination: rsvp | share | library | settings | originals.
- ManagerOverview consumes independent resource states, identity/date, guarded onNavigate(destination), and onTakeTour(). Replay may initially use an optional callback supplied in Task 3.

- [x] Write failing policy/location/entry/component tests. Precedence: guest access ended → originals; disabled QR → settings; rsvp-primary + confirmed zero → Add guests; rsvp-primary + positive/unknown → Review RSVPs; before-start → Share; photos-primary + zero → Share; photos-primary + positive/unknown → Library; waiting → Settings with calm pause copy; unknown lifecycle → neutral Settings/retry.
- [x] Run RED: npm run test:unit -- tests/unit/manager-location.test.ts tests/unit/overview-policy.test.ts tests/ui/manager-overview.test.tsx tests/ui/host-events.test.tsx.
- [x] Add Overview nav and Your events managerHref. Route all choices through existing guards and complete-export focus intent. Retrieval never automatically creates an export.
- [x] Add independent Overview lifecycle and RSVP-summary useManagerResource controllers. Use useLifecycleRecheck with relative delay/visibility/focus. Retire stale identities and refresh lifecycle after trusted event settings/intake/entry changes. Do not mount RSVP editor or fetch roster.
- [x] Render phase, reason, one action, explained workflow rows and replay. Show zoned date visibly on phones. Never coerce absent counts to zero. Show confirmed export information only when available; retrieval is independent of publication.
- [x] Add stable data-host-tour-anchor markers: overview-task, rsvp, share-qr, library, exports, settings. Use real visible regions/headings; Exports is the collapsed summary, not hidden content. Modify owning components as needed.
- [x] Cover identity-only shell gate, independent summary/phase failure/retry, no roster/editor load, server refresh/stale event isolation, explicit Overview and bare/deep route preservation, guarded callbacks.
- [x] Run GREEN with the same command. Report evidence. Do not stage or commit.

### Task 3: Guarded anchored tour and rendered verification

**Files:** Create src/features/manager/HostWelcomeTour.tsx, src/features/manager/use-host-welcome-tour.ts, tests/ui/host-welcome-tour.test.tsx, tests/e2e/host-welcome.spec.ts and playwright.welcome.config.ts plus vite.welcome.config.ts (React frontend dev server with explicitly stubbed APIs). Modify ManagerPage.tsx, ManagerOverview.tsx, anchor-owning components, stylesheet, src/components/ModalSurface.tsx if modal ownership coordination requires it, tests/e2e/manager-mobile-navigation.spec.ts (six nav items), and fixtures/routes.ts only as needed.

**Interfaces:** Consume prior contracts/locations/anchors. Manager provides guarded destination request and guard ownership; tour observes committed location. Sequence: Overview → RSVP → Share QR → Gallery Library → Library Exports summary → Settings. Finish requests Overview and focuses its action once committed.

- [x] Write failing UI tests for signed-in first Overview auto-launch, deep-route non-launch, link-only manual replay, persistent dismissal/completion, replay without reset, lookup-failure suppression, account/event stale responses.
- [x] Run RED: npm run test:unit -- tests/ui/host-welcome-tour.test.tsx tests/ui/modal-surface.test.tsx.
- [x] Read account state via authenticated tour endpoint: 401 is manual-only; other lookup errors suppress automatic launch. Scope to account identity, suppress repeat launches/writes in session, PATCH via existing api credential handling and x-candidary-tour-account-id bound to the observed account ID. Failed writes offer retry without trapping exit and remain suppressed this session.
- [x] Add Back/Next/Skip/close/Escape/Finish/step count. Wait for committed destination and visible connected anchor with settled scrolling; disable repeated activation while moving. Retain current step on refusal. Missing target shows explanation plus Retry/exit, no arrow; avoid indefinite transitions.
- [x] Use ModalSurface without inert exceptions. Focus each step, restore connected visible invoker, and focus Overview action on Finish. Desktop follows actual bounds; phones use reachable bottom sheet with target visible where possible and scrollable enlarged-text content. Follow resize/scroll and reduced motion; never anchor mobile navigation.
- [x] Suspend before guarded navigation if another modal/pending guard owns focus, including child Cover Studio/viewer/export/upload dialogs and rotated-link/save warnings. Resume only when safe. If modal ownership coordination changes ModalSurface, add focused tests ensuring inert/scroll ownership survives tour suspension while another modal remains. Browser Back away must not force a redirect.
- [x] Cover refusal, competing dialogs, unavailable targets, focus/Escape, repeated Next, completion and harmless transitions.
- [x] Run GREEN: npm run test:unit -- tests/ui/host-welcome-tour.test.tsx tests/ui/modal-surface.test.tsx.
- [x] Add focused Playwright config using Vite dev at 127.0.0.1:4175, desktop/mobile projects, no global build/typecheck. Welcome spec explicitly stubs lifecycle/account tour routes.
- [x] Run npx playwright test --config playwright.welcome.config.ts tests/e2e/host-welcome.spec.ts tests/e2e/manager-mobile-navigation.spec.ts. Cover six steps/focus/replay, direct Library, guard refusal, no event mutations, 320/390px, long names, enlarged text, reduced motion, keyboard/inert and relevant axe checks. Update affected nav-count assertion to six.
- [x] Capture desktop, 390px, 320px and enlarged-text Overview/tour under output/host-welcome. Open captures together; batch material fixes and allow one confirmation round. Root reuses captures for visual review.
- [x] Run Impeccable detector once on changed UI targets; report mechanical findings separately from advisories.
- [x] Report commands/results, screenshot paths and unproven lanes. Do not stage or commit.

## Completion

- [x] Independent spec/quality review for each task; no open Critical/Important findings. Reuse successful focused runs; no union re-run.
- [x] Inspect final diff/scoped whitespace. Run node .superpowers/sdd/2026-10-08-host-event-welcome/check-owned-types.mjs to diagnose only changed TypeScript files under existing project settings. Preserve design context and update brief/plan completion.
- [x] One local commit of owned implementation/test/migration/brief/plan paths; no main integration, remote migration, push or deploy.
- [x] Report behavior, focused evidence, branch/commit and limitations.

## Verification record

- Backend lifecycle/tour state: 19/19 focused worker tests passed.
- Overview/location/event entry: 89/89 focused unit/UI tests passed.
- Tour and modal ownership: initial 13/13 focused UI union passed; after the Important late-account persistence fix, the changed tour test subset passed 13/13. The five unchanged modal tests retain their successful evidence. Total final named unit/UI cases: 107.
- Browser: 10/10 welcome cases and 8/8 navigation cases passed in desktop/mobile Chromium projects. API responses are stubbed in browser; real backend routes are covered separately above. No event mutations occur during tour/retrieval navigation.
- Owned TypeScript: initial 32 file/config checks passed with zero diagnostics after type-only corrections; final changed-two-file persistence check also passed with zero diagnostics. Scoped whitespace passed.
- Independent spec/code-quality review passed per task; final integration review passed after one focused persistence fix and scoped re-review. No open Critical/Important findings.
- Eight desktop/390px/320px/200% text captures were inspected in two bounded rounds and reused for final review. At 320x568 the explanatory inert target is partly covered by the tour panel; the reviewer accepted this bounded limitation. Enlarged text uses internal scrolling. Physical devices and screen readers were not verified.
- Detector's nine mechanical border findings predate this feature; its new heading-size advisory is Minor. Existing design context remains unstaged.
- No repository-wide gate, full production build, remote migration, main integration, push or deployment was run. Migration 0027 remains local.

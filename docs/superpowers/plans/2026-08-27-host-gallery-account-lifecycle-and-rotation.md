# Host Gallery Account Lifecycle and Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan one task at a time. Use test-driven development, preserve all existing Slice 1–4 work, and do not commit unless the user asks.

**Goal:** Make registration tell the truth about when an account exists, give the events dashboard the three controls it is missing, make management-link rotation something a host can only do when they can survive it, and normalize seven destructive actions onto one three-rung ladder.

**Architecture:** Registration gains a browser-local pending marker keyed by a digest — never the address — plus one anti-enumeration-safe status endpoint scoped to the browser's own registration cookie. The existing HttpOnly registration cookie remains the only resume credential. Rotation is account-gated and extends `LinkService`, whose transaction landed in the first Slice 5 checkpoint; this checkpoint adds the availability projection, the retire-and-pause discipline around it, and the copy-or-acknowledge gate. The safety ladder reuses the existing typed event-name confirmation and the existing focused-confirmation pattern; it introduces no new dialog framework.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers, D1, React 19, React Router, Vitest with `vitest-pool-workers` and Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-host-gallery-lifecycle-contribution-design.md`

## Global constraints and preflight rulings

- Work only in `/home/henry/candidary/.worktrees/gallery-roadmap-remediation` on branch `codex/gallery-roadmap-remediation`. Do not push, deploy, merge, migrate a remote database, mutate a pull request, or change secrets.
- **Depends on** `2026-08-27-host-gallery-manager-upload-authority.md` for the atomic `LinkService.rotateManagementLink` transaction. Do not reimplement it here.
- No migration belongs to this checkpoint.
- The browser stores only `SHA-256(normalize(email))` and the 15-minute expiry under a versioned `localStorage` key. It never stores the raw email, password, confirmation code, browser secret, or challenge ID. A test must assert each of those five absences explicitly.
- `GET /api/host/register/pending` accepts **no email**. It answers only for the browser's own registration cookie and returns exactly `{ data: { pending, expiresAt }, requestId }` with `private, no-store`. Existing anti-enumeration behavior for another browser or a different address is unchanged — add regressions, do not relax them.
- The management-link secret remains unrecoverable by design. Rotation produces a replacement the host must save; it is not a recovery channel. The broader ownerless-management-link recovery product stays out of scope, and a link-only caller receives the existing `403 ROLE_FORBIDDEN` on a direct probe.
- Rotation never navigates through the credential URL and never mints a second event session or cookie. The signed-in account session remains the Manager authority throughout.
- On a network or transport outcome where commit cannot be known, the UI must not claim either link state. Its exact copy is **Couldn't confirm whether the link changed. Rotate again to create a link you can save.**
- Client-side validation happens before every request on every rung of the ladder. **No request that has a confirmation may be sent before that confirmation succeeds** — which is the two lower rungs. The reversible rung has no confirmation and is deliberately immediate; do not read this constraint as an instruction to add one.
- Preserve the existing host registration, verification, ownership, and management-link services as authoritative. Host Events receives bounded controls, not a new organizer product. Archive is explicitly not introduced.
- Every behavior change follows RED → GREEN → REFACTOR.
- Record RED/GREEN evidence and exact files in `.superpowers/sdd/2026-08-27-host-gallery-account-lifecycle-and-rotation/`, then take an independent spec and code review. Fix every P1/P2 before advancing.

## Checkpoint boundary

This checkpoint owns C-09, C-10, C-16, C-52, and C-59. It does **not** own pause scope and verbs, first-run copy, canonical time formatting, Guestbook default tab, or Cover upload progress. Those belong to the final Slice 5 checkpoint.

---

### Task 1: Truthful registration and a pending marker

**Files:**
- Modify: `worker/routes/host-auth.ts`
- Modify: `worker/services/host-auth.ts`
- Create: `src/app/pending-registration.ts`
- Create: `tests/unit/pending-registration.test.ts`
- Modify: `src/pages/HostRegisterPage.tsx`
- Modify: `src/pages/HostLoginPage.tsx`
- Modify: `tests/worker/host-auth.test.ts`
- Modify: `tests/worker/host-auth-boundary.test.ts`
- Create: `tests/ui/host-auth.test.tsx`

**Interfaces:**
- `POST /api/host/register` accepted response becomes `{ data: { registrationPending: true, resumeExpiresAt }, requestId }`.
- New: `GET /api/host/register/pending` → `{ data: { pending: boolean, expiresAt: string | null }, requestId }`.
- Produces:

```ts
export const PENDING_REGISTRATION_KEY = 'candidary.pending-registration.v1';

export interface PendingRegistrationMarker {
  emailDigest: string;   // SHA-256 of the normalized address, hex
  expiresAt: string;
}

export function rememberPendingRegistration(email: string, expiresAt: string): Promise<void>;
export function readPendingRegistration(now: Date): Promise<PendingRegistrationMarker | null>;
export function matchesPendingRegistration(email: string, now: Date): Promise<boolean>;
export function clearPendingRegistration(): void;
```

- [ ] **Step 1: Write the failing marker tests**

- a stored marker round-trips its digest and expiry;
- the raw address never appears in the serialized value — assert by substring on the whole `localStorage` payload;
- an expired marker reads as `null` and is cleared;
- a corrupt or wrong-version payload reads as `null` without throwing;
- a different address does not match;
- `clearPendingRegistration` removes the key.

- [ ] **Step 2: Write the failing endpoint tests**

- the endpoint accepts no body and no email; sending one is ignored or refused, never used;
- with a valid registration cookie it returns `pending: true` and the expiry;
- with no cookie it returns `pending: false, expiresAt: null`;
- with an expired or stale cookie it returns `pending: false`;
- after completion it returns `pending: false`;
- the response carries `private, no-store`;
- existing anti-enumeration responses for register, login, resend, and forgot-password are unchanged.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/unit/pending-registration.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/host-auth.test.ts -t 'register/pending'
```

Expected: both FAIL.

- [ ] **Step 4: Write the failing page suite**

The two suites above cover the marker module and the endpoint. Neither can prove anything about the pages that use them, and the three obligations that matter most live only there. Create `tests/ui/host-auth.test.tsx` covering:

*The five forbidden stored secrets.* The global constraint requires each of the five absences to be asserted explicitly, and the marker unit test can only speak for one of them — the raw email. Drive the register and sign-in pages through a full submit, then assert on the **whole** `localStorage` payload that none of the raw email, the password, the confirmation code, the browser secret, and the challenge ID appears anywhere, by substring, using values distinctive enough that a partial or encoded leak still matches.

*Password interception.* The routing decision is the security-relevant behavior: submitting sign-in with a non-expired matching local digest calls the status endpoint and, when `pending` is true, routes to `/host/register?pending=1` **without ever issuing the password request** — assert on the request log, not on the resulting screen. A `pending: false` or expired status clears the marker and issues exactly one ordinary sign-in.

*Cross-tab and reload.* A marker written in one tab is honored by a second mount reading the same storage; a reload mid-registration resumes from the marker; and completion, **Start over**, an explicit restart, and expiry each clear it so a later sign-in is not intercepted.

Registration copy states that the account is created only after code confirmation.

```bash
npx vitest run --config vitest.config.ts tests/ui/host-auth.test.tsx
```

Expected: FAIL — the page behavior does not exist.

- [ ] **Step 5: Implement the marker, the endpoint, the pages, and the copy**

- [ ] **Step 6: Verify GREEN**

Every suite this task creates is run here. A test file that is written but never executed and never staged is worse than no test: it reads in review as coverage that does not exist.

```bash
npx vitest run --config vitest.config.ts tests/unit/pending-registration.test.ts tests/ui/host-auth.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/host-auth.test.ts tests/worker/host-auth-boundary.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add worker/routes/host-auth.ts worker/services/host-auth.ts src/app/pending-registration.ts src/pages/HostRegisterPage.tsx src/pages/HostLoginPage.tsx tests/unit/pending-registration.test.ts tests/ui/host-auth.test.tsx tests/worker/host-auth.test.ts tests/worker/host-auth-boundary.test.ts
git commit -m "fix: say when a host account is created"
```

Confirm the file is staged before committing — `git status --short tests/ui/host-auth.test.tsx` must show it as added, not untracked.

---

### Task 2: One deterministic confirmation outcome

**Files:**
- Modify: `src/pages/HostRegisterPage.tsx`
- Modify: `src/app/recovery.ts`
- Modify: `tests/unit/recovery.test.ts`
- Modify: `tests/ui/app.test.tsx`

**Interfaces:**
- Confirmation has exactly two outcomes: resume a still-valid canonical bound-event `returnTo`, or continue to Host Events. Reuse Slice 4's `canonicalManagerReturnPath` for validation — do not add a second return-path validator.
- If binding cannot complete, the result says the account exists but the event was not saved and offers **Continue to Host Events**. It never loops back through confirmation.

- [ ] **Step 1: Write the failing outcome tests**

- confirmation bound to an event with a valid canonical Manager return resumes that exact destination;
- a `returnTo` that fails `canonicalManagerReturnPath` falls back to Host Events rather than being followed;
- standalone or pending registration with no valid event return routes to Host Events;
- a failed bind renders the account-exists / event-not-saved result with **Continue to Host Events** and issues no second confirmation request;
- the pending marker is cleared on every one of those outcomes.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'registration confirmation'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/unit/recovery.test.ts tests/ui/app.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/HostRegisterPage.tsx src/app/recovery.ts tests/unit/recovery.test.ts tests/ui/app.test.tsx
git commit -m "fix: end registration on the events dashboard"
```

---

### Task 3: The events dashboard

**Files:**
- Modify: `worker/routes/host-auth.ts`
- Modify: `shared/contracts.ts`
- Modify: `src/pages/HostEventsPage.tsx`
- Modify: `tests/worker/host-auth.test.ts`
- Create: `tests/ui/host-events.test.tsx`

**Interfaces:**
- The positive event allowlist in `GET /api/host/session` gains `eventTimezone` beside each event's existing `eventDate` and management-expiry instant. Nothing else is added.
- Host Events adds a primary **Create event** link, case-insensitive local search across loaded event names, and deterministic event-date sorting with a newest/oldest choice. Cards and the ownership model are unchanged. Archive is not introduced.

- [ ] **Step 1: Write the failing allowlist and dashboard tests**

- the session response contains exactly the allowlisted per-event keys plus `eventTimezone`, and no others — assert the exact key set;
- Host Events renders `eventDate` with the **date-only** formatter and the management expiry in the **event's own zone**, never UTC and never the browser zone;
- search is case-insensitive, matches across loaded names only, and announces its result count;
- sorting is deterministic for equal dates — assert a stable tiebreak;
- newest and oldest both round-trip;
- **Create event** is the primary action and is reachable by keyboard.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/host-auth.test.ts -t 'eventTimezone'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/host-auth.test.ts
npx vitest run --config vitest.config.ts tests/ui/host-events.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add worker/routes/host-auth.ts shared/contracts.ts src/pages/HostEventsPage.tsx tests/worker/host-auth.test.ts tests/ui/host-events.test.tsx
git commit -m "feat: give the events dashboard create, search, and sort"
```

---

### Task 4: Account-gated rotation availability

**Files:**
- Modify: `shared/contracts.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `tests/worker/manage-api.test.ts`

**Interfaces:**
- The allowlisted Manager event projection gains:

```ts
export interface ManagerLinkRotationAvailability {
  enabled: boolean;
  reason: 'account-required' | null;
}
```

Derived from the **same accepted authorization source** `requireManager` resolved, and invalidated with the event and account resources. Enabled only when authorization resolved through an active host account holding owner or cohost membership for that event.

- [ ] **Step 1: Write the failing availability tests**

- account owner → enabled;
- account cohost → enabled;
- both cookies present, account takes precedence → enabled;
- link-only → `{ enabled: false, reason: 'account-required' }`;
- a disabled account or removed membership → not enabled;
- a direct `POST .../links/manager/rotate` from link-only access still returns `403 ROLE_FORBIDDEN`;
- the existing `OWNER_CLAIM_REQUIRED` 409 precondition is preserved.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts -t 'managerLinkRotationAvailability'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.worker.config.ts tests/worker/manage-api.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add shared/contracts.ts worker/http/event-view.ts worker/routes/manage.ts tests/worker/manage-api.test.ts
git commit -m "feat: gate link rotation on an owning account"
```

---

### Task 5: The rotation dialog and its save gate

**Files:**
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/components/CopyableLinkCard.tsx`
- Modify: `src/components/ManagementLinkRecovery.tsx`
- Modify: `tests/ui/copyable-link-card.test.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/manager-recovery.test.tsx`

**Interfaces:**
- Link-only access renders a focusable disabled action with the inline explanation **Sign in to an account that owns or cohosts this event to rotate its link**, plus the existing sign-in / save-to-account path.
- Before sending, `ManagerPage` retires the current resource generation and pauses export polling and other Manager mutations while retaining the last trusted view behind the dialog.
- The result renders through `CopyableLinkCard` in Slice 2's sensitive mode and initially focuses **Copy management link**.

- [ ] **Step 1: Write the failing dialog suite**

*Confirmation*
- initial focus is **Keep current link**; Escape, backdrop, and that button send **no request** and restore focus to the Rotate trigger;
- **Rotate link** is an explicit nondefault `type="button"`;
- the copy names immediate invalidation and the need to save the replacement.

*Generations*
- a concurrent old-link `TOKEN_REVOKED` response belongs to the retired generation and cannot replace the rotation result;
- on success, reads stay paused until the result closes, then every resource restarts under the still-current account credential.

*Outcomes*
- a clear HTTP failure before commit resumes resources and says the current link was **not** changed;
- a network or transport outcome renders exactly **Couldn't confirm whether the link changed. Rotate again to create a link you can save.** and claims neither state;
- a subsequent account-authorized rotation invalidates any unknown replacement.

*Save gate*
- until Copy succeeds or the fallback acknowledgement is given, Escape and backdrop are disabled, the Router blocker rejects Back **and** a programmatic location change, and `beforeunload` warns;
- a successful Clipboard copy enables and focuses **Continue managing**;
- when Clipboard falls back to reveal-and-select, **I've saved this link — continue** is the explicit acknowledgement;
- only Copy or the acknowledgement releases both gates;
- closing resumes resources and restores focus to the Rotate trigger.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'rotate'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/copyable-link-card.test.tsx tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/ManagerPage.tsx src/components/CopyableLinkCard.tsx src/components/ManagementLinkRecovery.tsx tests/ui/copyable-link-card.test.tsx tests/ui/app.test.tsx tests/ui/manager-recovery.test.tsx
git commit -m "fix: make a rotated link impossible to lose"
```

---

### Task 6: One safety ladder

**Files:**
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/features/gallery/ManagerAlbum.tsx`
- Modify: `src/features/gallery/ManagerPrivateGallery.tsx`
- Modify: `src/components/EventSettingsEditor.tsx`
- Modify: `tests/ui/app.test.tsx`
- Modify: `tests/ui/album-workspace.test.tsx`
- Modify: `tests/ui/manager-recovery.test.tsx`

**Interfaces:**
- Three rungs, assigned by consequence:

| Rung | Actions | Pattern |
| --- | --- | --- |
| Reversible | pick, publish/hide, remove with real Undo, Pause/Resume | immediate, with precise feedback — **no confirmation** |
| Consequential | Stop Album link, rotate Manager link, recoverable original trash | focused confirmation naming audience and recovery |
| Broad or catastrophic | disable printed entry, sign out all guest devices, delete event | typed event-name confirmation after client validation |

- Pause and Resume stay an explicit reversible state change using those exact verbs.
- No new dialog framework. Reuse the existing typed event-name confirmation and the existing focused-confirmation component.

- [ ] **Step 1: Write the failing rung-assignment table**

**The rungs do not share one assertion.** "No request before confirmation" is the *consequential* and *catastrophic* contract; the reversible rung's whole definition is that it is **immediate**, with no confirmation to wait for. A single table demanding that every listed action send nothing until a confirmation resolves would fail Pick, Publish/Hide, remove-with-Undo, and Pause/Resume by design, and the only way to make it pass would be to put a dialog in front of the reversible rung — which is the opposite of what the spec asks for. Each rung therefore gets its own request-timing assertion.

The ladder's ten actions are exactly these, and the table is driven over this list — no action may be added, dropped, or left unnamed. The goal statement's "seven destructive actions" is the six lower-rung rows below plus Album reset, which is asserted separately; the four reversible rows are on the ladder too and are asserted here as well:

| Rung | Action | Surface |
| --- | --- | --- |
| Reversible | Pick / unpick a photo | Manager Album, Private Gallery |
| Reversible | Publish / hide a photo | Manager Intake |
| Reversible | Remove with real Undo | Manager Album |
| Reversible | Pause / Resume guest uploads | Manager Intake |
| Consequential | Stop the Album link | Manager Album sharing |
| Consequential | Rotate the Manager link | Manager settings |
| Consequential | Move an original to Recently deleted | Manager Intake |
| Broad or catastrophic | Disable the printed entry | Manager settings |
| Broad or catastrophic | Sign out all guest devices | Manager settings |
| Broad or catastrophic | Delete the event | Manager settings |

Assert, per rung:

*Reversible* — activation issues **exactly one** request immediately, with no confirmation rendered and no dialog in the tree; the precise feedback names what changed; where an Undo exists, it is offered and reverses with one further request. Assert the immediacy positively: a reversible action that grew a confirmation must fail this table.

*Consequential* — no request precedes the confirmation; initial focus is the nondestructive control; Escape and cancel issue nothing and restore focus to the invoker; explicit activation issues exactly one request.

*Broad or catastrophic* — everything in the consequential row, plus a mismatched event name refused **client-side** with no request issued at all, and the exact name accepted.

Two rows sit outside the ladder table and are asserted separately: Album reset carries its own pre-action and Undo contract, and the two lowest-rung Slice 1 rows — trash a photo and Stop the Album link — already have named expansions in the verification matrix, so assert them here against the same expectations rather than restating a different contract.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx -t 'safety ladder'
```

- [ ] **Step 3: Implement and verify GREEN**

```bash
npx vitest run --config vitest.config.ts tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/ui/manager-recovery.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/ManagerPage.tsx src/features/gallery/ManagerAlbum.tsx src/features/gallery/ManagerPrivateGallery.tsx src/components/EventSettingsEditor.tsx tests/ui/app.test.tsx tests/ui/album-workspace.test.tsx tests/ui/manager-recovery.test.tsx
git commit -m "fix: match confirmation friction to consequence"
```

---

### Task 7: Browser evidence and checkpoint gates

**Files:**
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/manager-navigation-intents.spec.ts`
- Modify: `docs/superpowers/host-gallery-verification-matrix.md`
- Modify: `docs/security.md`

- [ ] **Step 1: Extend the named Axe inventory**

Add gated Axe states for the rotation confirmation, the sensitive rotation result, the pending-registration route, and the events dashboard's search and sort. Update the exact-order inventory assertion in the same commit.

- [ ] **Step 2: Add the keyboard and blocker traces**

Add an end-to-end trace proving Back and reload are refused between a successful rotation and the copy acknowledgement, and released after it.

- [ ] **Step 3: Document the rotation boundary**

In `docs/security.md`, record that rotation is account-gated, that it is not a recovery channel, that a link-only probe receives `ROLE_FORBIDDEN`, and that the browser-local pending-registration marker stores only a digest and an expiry.

- [ ] **Step 4: Record C-09, C-10, C-16, C-52, and C-59**

One row each, naming what changed and the owning tests. Do not fold the Task 1 endpoint's anti-enumeration regressions into a claim about findings this slice does not own.

- [ ] **Step 5: Run the complete checkpoint gates**

```bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npx vitest run --config vitest.worker.config.ts tests/worker/host-auth.test.ts tests/worker/host-auth-boundary.test.ts tests/worker/manage-api.test.ts
npx vitest run --config vitest.config.ts tests/unit/pending-registration.test.ts tests/ui/host-auth.test.tsx tests/ui/app.test.tsx tests/ui/host-events.test.tsx tests/ui/manager-recovery.test.tsx
npm test
npm run build
npm run test:e2e
git diff --check
```

Expected: every command exits zero. The known build chunk-size and missing-local-secret warnings may remain; no new warning is accepted.

- [ ] **Step 6: Commit the record**

```bash
git add tests/e2e/accessibility.spec.ts tests/e2e/manager-navigation-intents.spec.ts docs/superpowers/host-gallery-verification-matrix.md docs/security.md
git commit -m "docs: record account lifecycle and rotation evidence"
```

Do not push. The next Slice 5 checkpoint is pause scope, first run, and deterministic polish.

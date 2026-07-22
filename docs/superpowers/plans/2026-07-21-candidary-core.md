# Candidary Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved private-event photo workflow from event creation through guest contribution, host moderation, shared gallery, and downloadable export.

**Architecture:** A React 19/Vite SPA and Hono Worker share typed contracts. The Worker owns HMAC/AES token security, D1 persistence, private R2 access, signed upload URLs, lifecycle cleanup, and a durable export Workflow; the SPA owns route composition, accessible UI state, and per-file upload orchestration.

**Tech Stack:** TypeScript, React 19, React Router 7, Vite 7, Cloudflare Vite plugin/Wrangler 4, Hono 4, D1, R2, Cloudflare Workflows, Zod 4, Vitest 4, Testing Library, Playwright, fflate, QRCode, Lucide React.

## Global Constraints

- Accepted media types are exactly `image/jpeg`, `image/png`, and `image/webp`.
- Maximum image size is 10 MiB; maximum stored media is 50 images and 300 MiB per event.
- Guest sessions last at most seven days; management sessions last at most twelve hours.
- Guest, management, and purge lifetimes are fixed at 30, 90, and 120 days after the event date, with the same minimum durations from creation.
- Guest downloads, host accounts, albums, video, invitations, RSVP, billing, email, and SMS remain out of scope.
- R2 stays private; every read is authorized and upload keys are server-generated.
- No Guestpix trademarks, copy, screenshots, photographs, QR artwork, or proprietary assets enter shipped code, fixtures, or documentation.
- UI palette is parchment, aubergine, apricot, and moss with sans-forward editorial typography, restrained radii, and original copy.

---

### Task 1: Repository and test harness

**Files:**
- Create: `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.worker.json`, `vite.config.ts`, `vitest.config.ts`, `vitest.worker.config.ts`, `playwright.config.ts`, `index.html`, `wrangler.jsonc`
- Create: `src/test/setup.ts`, `worker/test-env.d.ts`, `README.md`

**Interfaces:**
- Produces scripts `dev`, `build`, `typecheck`, `lint`, `test`, `test:unit`, `test:worker`, and `test:e2e`.
- Produces Worker bindings `DB`, `MEDIA_BUCKET`, `EXPORT_WORKFLOW`, `TOKEN_HMAC_KEY`, `SESSION_HMAC_KEY`, `GUEST_TOKEN_ENCRYPTION_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `APP_ORIGIN`.

- [ ] Create the package and TypeScript/Vite/Worker test configuration with current package releases.
- [ ] Add a smoke test that imports the Worker and React router; verify it fails before those modules exist.
- [ ] Add the minimum module entrypoints; verify smoke tests pass and the clean project builds.
- [ ] Initialize Git and commit the approved design, plan, and harness.

### Task 2: Shared domain contracts and security primitives

**Files:**
- Create: `shared/contracts.ts`, `shared/constants.ts`, `shared/errors.ts`
- Create: `worker/security/crypto.ts`, `worker/security/lifecycle.ts`, `worker/security/filenames.ts`, `worker/security/image-metadata.ts`
- Test: `tests/unit/security.test.ts`, `tests/unit/image-metadata.test.ts`, `tests/unit/errors.test.ts`

**Interfaces:**
- Produces `createSecretToken()`, `digestSecret()`, `constantTimeEqual()`, `encryptGuestSecret()`, `decryptGuestSecret()`, `calculateLifecycle()`, `sanitizeFilename()`, `inspectImageHeader()`, and `ApiError`.
- All timestamps are ISO-8601 UTC strings; secrets use 32 random bytes encoded base64url.

- [ ] Write failing tests for token entropy/shape, digest determinism, constant-time equality behavior, AES-GCM round trips, and lifecycle minimums.
- [ ] Implement only the security and lifecycle primitives required by the tests.
- [ ] Write failing tests for safe collision-resistant filenames and JPEG/PNG/WebP signature and dimension parsing.
- [ ] Implement header inspection and filename sanitization; verify unsupported and truncated inputs fail safely.
- [ ] Verify all unit tests and type checks, then commit.

### Task 3: D1 schema and typed repositories

**Files:**
- Create: `migrations/0001_core.sql`
- Create: `worker/db/types.ts`, `worker/db/events.ts`, `worker/db/tokens.ts`, `worker/db/sessions.ts`, `worker/db/media.ts`, `worker/db/messages.ts`, `worker/db/exports.ts`
- Test: `tests/worker/repositories.test.ts`

**Interfaces:**
- Produces repositories with parameterized statements and conditional transitions for `events`, `event_access_tokens`, `event_sessions`, `media`, `guest_messages`, and `export_jobs`.
- `MediaRepository.reserve()` atomically enforces count/byte quotas and idempotency; `finalize()` converts reserved counters to stored counters once.

- [ ] Write the migration with foreign keys, state checks, idempotency uniqueness, active-export uniqueness, and lookup indexes.
- [ ] Write failing Worker tests for creation, event isolation, reservation idempotency, quota rejection, finalize idempotency, moderation transitions, delete counters, and active-export uniqueness.
- [ ] Implement focused repositories using prepared statements, D1 batches, and conditional affected-row checks.
- [ ] Apply the migration to the local Worker test database and verify repository tests pass.
- [ ] Commit schema and repositories.

### Task 4: Authentication, session exchange, and event creation API

**Files:**
- Create: `worker/env.ts`, `worker/http/context.ts`, `worker/http/cookies.ts`, `worker/http/csrf.ts`, `worker/http/security-headers.ts`
- Create: `worker/auth/service.ts`, `worker/services/events.ts`
- Create: `worker/routes/public.ts`, `worker/routes/exchange.ts`, `worker/routes/event.ts`, `worker/app.ts`, `worker/index.ts`
- Test: `tests/worker/auth-api.test.ts`, `tests/worker/event-api.test.ts`

**Interfaces:**
- Produces `createApp(env)`, public `POST /api/events`, token exchanges, session middleware, `GET /api/event/:slug`, and `GET /api/manage/events/:eventId`.
- Creation returns one-time management and redisplayable guest links, lifecycle dates, and a CSRF token while setting a management session cookie.

- [ ] Write failing tests for valid event creation, field validation, one-time raw-secret handling, encrypted guest-secret storage, and stable error envelopes.
- [ ] Implement creation with Zod validation and token/session persistence.
- [ ] Write failing tests for guest/manager exchanges, token-free redirects, cookie flags, expiry/revocation/deletion checks, and cross-event denial.
- [ ] Implement exchange and session resolution with backing-token verification on every request.
- [ ] Add CSP, `nosniff`, `Referrer-Policy: no-referrer`, origin checks, and CSRF enforcement; verify tests and commit.

### Task 5: Upload reservation, transfer, finalization, and content API

**Files:**
- Create: `worker/storage/presign.ts`, `worker/storage/media.ts`
- Create: `worker/services/uploads.ts`, `worker/routes/uploads.ts`, `worker/routes/content.ts`
- Test: `tests/worker/upload-api.test.ts`, `tests/worker/content-api.test.ts`

**Interfaces:**
- Produces guest upload initiation/cancel/finalize endpoints and object-specific ten-minute signed `PUT` URLs bound to key/content type.
- Produces authorization-checking `GET /api/media/:mediaId/content` with uploader-pending and manager access rules.

- [ ] Write failing tests for MIME/size/upload-disabled/quota checks, server-owned keys, idempotent initiation, and signed URL scope.
- [ ] Implement presigning and transactional reservation.
- [ ] Write failing tests for R2 existence/size/signature/dimension verification, malicious oversize deletion, idempotent finalize, and expired-reservation conflicts.
- [ ] Implement finalization and cancellation.
- [ ] Write failing tests proving guests cannot read another guest's pending/rejected media and old content URLs fail immediately after reject/delete.
- [ ] Implement streaming private reads with private cache headers and commit after all upload/content tests pass.

### Task 6: Moderation, gallery, messages, settings, and link rotation API

**Files:**
- Create: `worker/services/moderation.ts`, `worker/services/messages.ts`, `worker/services/settings.ts`
- Create: `worker/routes/manage.ts`, `worker/routes/gallery.ts`, `worker/routes/messages.ts`
- Test: `tests/worker/manage-api.test.ts`, `tests/worker/messages-api.test.ts`

**Interfaces:**
- Produces manager settings, media/message moderation, batch actions, gallery/feed reads, and guest/management link rotation.
- Gallery/feed responses include only approved shared content plus the current guest's own pending receipts where applicable.

- [ ] Write failing tests for conditional approve/reject/delete, current-selection bulk semantics, toggle behavior, and event isolation.
- [ ] Implement moderation and settings services.
- [ ] Write failing tests for message length, moderation mirroring, combined caption/message chronology, and visibility boundaries.
- [ ] Implement message and gallery routes.
- [ ] Write failing tests that rotation revokes old tokens and sessions immediately while returning the replacement link only to the manager.
- [ ] Implement rotations, verify all Worker tests, and commit.

### Task 7: Export and cleanup Workflows

**Files:**
- Create: `worker/export/csv.ts`, `worker/export/zip-stream.ts`, `worker/workflows/export.ts`, `worker/workflows/cleanup.ts`, `worker/routes/exports.ts`
- Test: `tests/unit/csv.test.ts`, `tests/unit/zip-stream.test.ts`, `tests/worker/export-api.test.ts`, `tests/worker/cleanup.test.ts`

**Interfaces:**
- Produces deterministic approved-media snapshots, collision-safe ZIP paths, `media.csv`, multipart R2 streaming, 24-hour export expiry, and 15-minute manager download URLs.
- Produces scheduled reservation release and inaccessible-first event purge with a final prefix sweep after signed-upload expiry.

- [ ] Write failing CSV and ZIP tests including escaping, Unicode names, collisions, deterministic ordering, and readable archive contents.
- [ ] Implement CSV and streaming multipart ZIP utilities.
- [ ] Write failing tests for empty/oversize/duplicate export requests, state transitions, retries, attempt-specific keys, ready expiry, and partial cleanup.
- [ ] Implement `ExportWorkflow` and export routes.
- [ ] Write failing tests for expired reservation release, immediate event denial, token/session revocation, object cleanup, final prefix sweep, and idempotent retry.
- [ ] Implement cleanup workflow/scheduled handler, verify tests, and commit.

### Task 8: Visual system and public creation journey

**Files:**
- Create: `design/concepts/*`, `src/styles/tokens.css`, `src/styles/global.css`
- Create: `src/main.tsx`, `src/app/router.tsx`, `src/app/AppShell.tsx`, `src/components/*`
- Create: `src/features/landing/LandingPage.tsx`, `src/features/create/CreateEventPage.tsx`, `src/features/create/CreationSuccessPage.tsx`
- Test: `tests/ui/landing.test.tsx`, `tests/ui/create-event.test.tsx`

**Interfaces:**
- Produces public routes `/` and `/create`, accessible primitives, and a creation result state that does not persist management secrets.

- [ ] Generate complete desktop concepts for the public/create, guest event, and manager surfaces plus one narrow-mobile guest concept; save accepted concepts under `design/concepts/`.
- [ ] Extract exact tokens, typography, icon inventory, container rules, and allowed above-the-fold copy into `design/design-system.md`.
- [ ] Write failing component tests for landing navigation, form validation, cover-failure recovery, QR/link actions, and unrecoverable-management-link warning.
- [ ] Implement the public and creation journey to the accepted concepts.
- [ ] Compare browser screenshots to concepts at native dimensions, fix first-viewport drift, verify UI tests, and commit.

### Task 9: Guest event, upload tray, gallery, full-screen, and messages UI

**Files:**
- Create: `src/api/client.ts`, `src/api/query.ts`, `src/features/guest/EventPage.tsx`
- Create: `src/features/uploads/upload-machine.ts`, `src/features/uploads/UploadTray.tsx`, `src/features/uploads/MyContributions.tsx`
- Create: `src/features/gallery/Gallery.tsx`, `src/features/gallery/FullscreenGallery.tsx`, `src/features/messages/MessagesFeed.tsx`
- Test: `tests/unit/upload-machine.test.ts`, `tests/ui/guest-event.test.tsx`, `tests/ui/upload-tray.test.tsx`, `tests/ui/gallery.test.tsx`

**Interfaces:**
- Produces per-file queued/uploading/finalizing/pending/approved/rejected/failed state, one active transfer, retry/cancel, focus-refreshing gallery, and keyboard full-screen viewer.

- [ ] Write failing upload-machine tests for validation, sequential transfer, progress, retry, cancellation, partial failure, and refresh-safe receipts.
- [ ] Implement the upload state machine and API client integration.
- [ ] Write failing UI tests for display-name preference, event states, contribution visibility, gallery visibility/empty/error states, captions, notes, dialog focus, and keyboard viewer controls.
- [ ] Implement guest surfaces and modest full-screen polling with focus refresh.
- [ ] Verify narrow-mobile touch layout, reduced motion, and concept fidelity; commit.

### Task 10: Manager UI

**Files:**
- Create: `src/features/manage/ManagerPage.tsx`, `src/features/manage/EventOverview.tsx`, `src/features/manage/SharePanel.tsx`, `src/features/manage/SettingsPanel.tsx`, `src/features/manage/ModerationQueue.tsx`, `src/features/manage/MessageModeration.tsx`, `src/features/manage/ExportPanel.tsx`, `src/features/manage/DeleteEventDialog.tsx`
- Test: `tests/ui/manager.test.tsx`, `tests/ui/moderation.test.tsx`, `tests/ui/export.test.tsx`

**Interfaces:**
- Produces the manager route with links/QR, counts/lifecycles, settings, selected-item moderation, messages, export polling/retry/download, rotations, and exact-name deletion.

- [ ] Write failing tests for loading/empty/error states, selection-scoped bulk actions, settings mutation, link rotations, export states, and exact-name deletion confirmation.
- [ ] Implement focused manager panels and query invalidation.
- [ ] Verify all actions are keyboard operable and stale state conflicts surface stable actionable errors.
- [ ] Compare desktop/mobile browser screenshots to the manager concept, repair drift, and commit.

### Task 11: End-to-end acceptance, security, and deployment documentation

**Files:**
- Create: `tests/e2e/core-journey.spec.ts`, `tests/e2e/accessibility.spec.ts`, `tests/e2e/security.spec.ts`
- Create: `docs/deployment.md`, `docs/security.md`, `docs/operations.md`, `design/fidelity-ledger.md`
- Modify: `README.md`, `wrangler.jsonc`

**Interfaces:**
- Produces reproducible local setup/migrations, secret provisioning, private R2 CORS, Workflow binding, scheduled cleanup, pilot abuse-protection checklist, and the full verified acceptance journey.

- [ ] Start the local Cloudflare app with local D1/R2 data and run the complete host → guest → moderation → gallery → export journey.
- [ ] Add E2E tests for desktop and 390px mobile, token-free redirects, cross-event authorization, revoked links, private reads, expired/deleted states, and valid ZIP contents.
- [ ] Run typecheck, lint, unit, Worker integration, build, and E2E suites with pristine output.
- [ ] Run browser console/network/accessibility checks and inspect desktop/tablet/mobile screenshots.
- [ ] Use `view_image` on every accepted concept and final corresponding browser screenshot; complete a five-plus-point fidelity ledger and fix all material mismatches.
- [ ] Document intentional deployment prerequisites: real binding IDs, secrets, R2 CORS, Cloudflare rate limiting, and Turnstile before unrestricted event creation.
- [ ] Remove temporary QA artifacts, verify Git status, and commit the complete Core implementation.


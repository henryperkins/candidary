# Wedding Photo Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refocus Candidary on a fast mobile QR-to-private-photo-delivery journey while retaining gallery, notes, publication controls, and complete host exports as secondary features.

**Architecture:** Keep the React/Vite and Hono/D1/private-R2 architecture. Add a pure client upload queue, batch reservation with two concurrent direct R2 transfers, required guest-name snapshots, HEIC/HEIF container validation, cached browser-compatible previews through the Cloudflare Images binding, separate publication state, and partitioned all-original exports.

**Tech Stack:** TypeScript, React 19, Hono, Cloudflare Workers, D1, R2, Images binding, Workflows, Vitest, Testing Library, and Playwright.

## Global Constraints

- The mobile guest journey is capture or library, review, explicit send, progress, then one terminal receipt.
- Guest name is required, 1-80 trimmed characters, and remembered on-device.
- Accepted originals are JPEG, PNG, WebP, HEIC, and HEIF, at most 20 MB each.
- One event supports 500 guests, 10,000 stored photos, and 100 GiB of originals.
- Transfers run at most two at a time and each photo is independently retryable and idempotent.
- Stored originals are private and immediately host-visible; publication state affects only the optional gallery.
- Exports contain every stored, non-deleted original and partition at 2 GiB of source payload.
- The first 390-by-844 viewport contains event identity, required name, Take a photo, and Choose recent photos.

---

### Task 1: Domain model and migration

**Files:**
- Create: `migrations/0002_wedding_photo_drop.sql`
- Modify: `shared/constants.ts`, `shared/contracts.ts`, `worker/db/types.ts`, `worker/db/events.ts`, `worker/db/media.ts`
- Test: `tests/worker/repositories.test.ts`, `tests/worker/helpers.ts`, `vitest.worker.config.ts`

**Interfaces:**
- Produces `PublicationStatus = 'unpublished' | 'published' | 'hidden'`.
- Produces `MediaRecord.publicationStatus`, `publishedAt`, and `previewObjectKey`.
- Produces limits `MAX_IMAGE_BYTES`, `MAX_EVENT_MEDIA`, `MAX_EVENT_BYTES`, and `UPLOAD_BATCH_SIZE`.

- [ ] Add failing repository tests for gallery-off defaults, required names, 10,000/100-GiB quotas, publication transitions, and all-original snapshots.
- [ ] Run `npm run test:worker -- tests/worker/repositories.test.ts`; expect failures against the old schema.
- [ ] Add the migration, constants, types, and repository changes. Backfill blank names as `Guest (legacy upload)` and map pending/approved/rejected to unpublished/published/hidden.
- [ ] Re-run the repository tests and commit with `feat: separate private delivery from publication`.

### Task 2: Photo validation and batch delivery API

**Files:**
- Modify: `worker/security/image-metadata.ts`, `worker/services/uploads.ts`, `worker/routes/uploads.ts`, `worker/storage/media.ts`
- Test: `tests/unit/image-metadata.test.ts`, `tests/worker/upload-api.test.ts`

**Interfaces:**
- Produces `inspectImageHeader(bytes): ImageMetadata` for JPEG/PNG/WebP/HEIC/HEIF.
- Produces `UploadService.initiateBatch(auth, { guestName, files })` with per-file accepted or rejected results.
- `POST /api/event/:slug/uploads/batch` accepts at most 20 metadata records and returns stable per-item results.

- [ ] Add failing HEIC/HEIF parser, required-name, partial-batch, quota-order, and idempotency tests.
- [ ] Run the targeted unit and Worker tests; expect the new assertions to fail.
- [ ] Implement ISO-BMFF brand/dimension parsing, required-name validation, ordered batch reservations, and unpublished finalization.
- [ ] Re-run targeted tests and commit with `feat: add reliable batch photo delivery`.

### Task 3: Private previews and content authorization

**Files:**
- Create: `worker/storage/previews.ts`
- Modify: `worker/env.ts`, `wrangler.jsonc`, `worker-configuration.d.ts`, `worker/routes/content.ts`, `worker/routes/gallery.ts`, `worker/routes/manage.ts`
- Test: `tests/worker/upload-api.test.ts`, `tests/worker/manage-api.test.ts`

**Interfaces:**
- Produces `getOrCreatePreview(env, media): Promise<R2ObjectBody>`.
- `GET /api/media/:mediaId/preview` allows managers, the uploader's status surface, or guests viewing published media while the gallery is enabled.
- `GET /api/media/:mediaId/original` is manager-only.

- [ ] Add failing authorization and preview-cache tests using a deterministic test Images adapter.
- [ ] Add the Images binding, preview service, cached derived keys, and manager-only original route.
- [ ] Verify guests cannot read private originals or unpublished previews; commit with `feat: add private cross-browser previews`.

### Task 4: Mobile upload queue and terminal guest flow

**Files:**
- Create: `src/features/uploads/upload-queue.ts`, `src/features/uploads/GuestUploadFlow.tsx`, `tests/unit/upload-queue.test.ts`, `tests/ui/guest-upload-flow.test.tsx`
- Modify: `src/pages/EventPage.tsx`, `src/app/types.ts`, `src/app/api.ts`, `src/styles.css`, `tests/ui/app.test.tsx`

**Interfaces:**
- Produces queue states `selected`, `reserving`, `queued`, `uploading`, `finalizing`, `delivered`, and `failed`.
- Produces `runUploadQueue(items, transport, concurrency = 2)` and exact receipt-count derivation.
- `GuestUploadFlow` owns the camera input, library input, selection tray, retries, removal, and terminal receipt.

- [ ] Write failing queue tests for concurrency two, partial success, retry, removal, and the terminal condition.
- [ ] Write failing UI tests for required name, remembered name, `capture="environment"`, capture-plus-recents, explicit Send, and the no-action receipt.
- [ ] Implement the pure queue and focused component, then reduce `EventPage` to event loading plus secondary content.
- [ ] Implement the 390-by-844 mobile-first styles and commit with `feat: make guest photo delivery the primary journey`.

### Task 5: Host intake and optional publication

**Files:**
- Modify: `src/pages/ManagerPage.tsx`, `src/app/types.ts`, `src/styles.css`, `worker/routes/manage.ts`
- Test: `tests/ui/app.test.tsx`, `tests/worker/manage-api.test.ts`

**Interfaces:**
- Manager defaults to `intake` and filters by guest name.
- Publication actions are `publish`, `hide`, and `delete`; they never affect private export eligibility.

- [ ] Add failing API/UI tests for intake-first navigation, guest-name filtering, publish/hide transitions, gallery-off defaults, and all-original visibility.
- [ ] Implement the intake surface and demote Gallery, Notes, and Settings to secondary navigation.
- [ ] Verify keyboard operation and commit with `feat: center manager on live intake`.

### Task 6: Partitioned all-original exports

**Files:**
- Modify: `migrations/0002_wedding_photo_drop.sql`, `worker/db/exports.ts`, `worker/db/types.ts`, `worker/export/csv.ts`, `worker/export/zip-stream.ts`, `worker/workflows/export.ts`, `worker/routes/exports.ts`, `src/app/types.ts`, `src/pages/ManagerPage.tsx`
- Test: `tests/unit/export.test.ts`, `tests/worker/export-api.test.ts`, `tests/worker/core-journey.test.ts`

**Interfaces:**
- Produces `partitionExportSnapshot(media, maxBytes)` and persisted `ExportPartRecord` rows.
- Download responses contain the manifest URL and numbered ready part URLs.

- [ ] Add failing tests proving unpublished originals export, snapshots partition deterministically, and all ready parts receive manager-only signed URLs.
- [ ] Add export-part persistence, manifest CSV, partitioned Workflow output, cleanup/retry, and manager UI.
- [ ] Run export and core-journey tests and commit with `feat: export every delivered original in parts`.

### Task 7: Wedding-readiness verification and operations

**Files:**
- Modify: `tests/e2e/core-journey.spec.ts`, `tests/e2e/security.spec.ts`, `tests/e2e/accessibility.spec.ts`, `tests/e2e/visual-qa.spec.ts`, `docs/deployment.md`, `docs/operations.md`, `README.md`

- [ ] Add browser coverage for first-visit name, returning name, camera and library inputs, partial retry, terminal receipt, and secondary feature hierarchy at 390-by-844 and desktop.
- [ ] Add a synthetic load harness for 500 sessions and 10,000 metadata/finalization records without committing generated artifacts.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run test:e2e` with no unexplained failures.
- [ ] Inspect real browser screenshots and network/console behavior; document the remaining physical-iPhone, physical-Android, Images subscription, and production rehearsal gates.
- [ ] Commit with `test: verify wedding photo drop journey`.

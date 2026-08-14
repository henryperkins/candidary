# Curated Private Guestbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing guest-note and photo-caption feed into the approved event-private, host-curated Guestbook with bounded creation, privacy-correct guest and Manager projections, and immutable Guestbook export artifacts.

**Architecture:** Keep `guest_messages` and `media` as the canonical mutation stores. Add a focused `GuestbookRepository` for shared/private guest reads, Manager views, summaries, and export snapshot projection; extend the existing `ExportWorkflow` to render Guestbook HTML and CSV from immutable snapshot rows while retaining the existing live photo-snapshot behavior. Ship the Worker and React compatibility contract together on the existing `/messages` URLs.

**Tech Stack:** TypeScript 6, React 19, Hono, Cloudflare Workers/D1/R2/Workflows/rate limiting, Zod, Vitest with workerd, Playwright.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-12-curated-private-guestbook-design.md` as the authoritative contract.
- Preserve existing dirty and untracked files; patch overlapping files narrowly and never use broad staging.
- Begin every behavioral slice with a focused failing test and observe the expected RED result before production edits.
- Keep guest-note and photo-caption canonical mutations in `MessagesRepository` and `MediaRepository`; never add a second canonical Guestbook table.
- Keep guest reads authorized by the current event session and Manager reads/writes authorized by `requireManager` with the correct CSRF scope.
- Keep legacy `/messages` GET/POST compatibility and version-1 cursor continuation until a separately reviewed removal.
- Preserve historical 14-migration Cover Studio evidence; add distinct post-cutover 15-migration and three-rate-limit/new-secret cases.
- Implementation does not authorize deployment, remote migration, production backfill, runtime certification, or physical-device claims.

---

### Task 1: Post-cutover contracts, migration, and event prompt

**Files:**
- Create: `migrations/0015_curated_private_guestbook.sql`
- Modify: `shared/constants.ts`
- Modify: `shared/contracts.ts`
- Modify: `shared/errors.ts`
- Modify: `shared/load-failure.ts`
- Modify: `worker/db/types.ts`
- Modify: `worker/db/events.ts`
- Modify: `worker/http/event-view.ts`
- Modify: `worker/routes/public.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `src/app/types.ts`
- Modify: `src/features/settings/event-settings-draft.ts`
- Modify: `src/components/EventSettingsEditor.tsx`
- Test: `tests/worker/migration-0015.test.ts`
- Test: `tests/worker/manage-api.test.ts`
- Test: `tests/ui/event-settings-editor.test.tsx`

**Interfaces:**
- Produces `DEFAULT_GUESTBOOK_PROMPT`, the exact numeric limits from design §10, `GUESTBOOK_SOURCE_RANK`, `GuestbookItem` wire types, and `EventView.guestbookPrompt`.
- Extends event settings payloads with required `guestbookPrompt: string` and preserves complete-payload autosave semantics.

- [ ] **Step 1: Write migration and settings tests that expect the new prompt and constraints**

  Assert an event migrated from 0014 reads `Share a wish, memory, or moment from the day.`, fresh event creation stores the same default, prompt lengths outside 1–160 fail, and Settings trims and persists a valid prompt.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/migration-0015.test.ts tests/worker/manage-api.test.ts`

  Expected: failures because migration 0015, `guestbook_prompt`, and settings fields do not exist.

- [ ] **Step 3: Add the shared types and constants**

  Define the approved discriminated union and compatibility aliases from design §5.3, including:

  ```ts
  export type GuestbookSource = 'guest_note' | 'photo_caption';
  export const GUESTBOOK_SOURCE_RANK = { guest_note: 0, photo_caption: 1 } as const;
  export const DEFAULT_GUESTBOOK_PROMPT = 'Share a wish, memory, or moment from the day.';
  export const MAX_EVENT_GUEST_NOTES = 1_000;
  export const MAX_GUEST_NOTES_PER_SESSION_WINDOW = 5;
  export const MAX_GUEST_NOTES_PER_IP_WINDOW = 120;
  export const GUEST_NOTE_WINDOW_MS = 900_000;
  export const MAX_GUESTBOOK_PROMPT_LENGTH = 160;
  export const MANAGER_GUESTBOOK_DEFAULT_PAGE_SIZE = 25;
  export const MANAGER_GUESTBOOK_MAX_PAGE_SIZE = 50;
  ```

- [ ] **Step 4: Add migration 0015 and event persistence**

  Add `events.guestbook_prompt TEXT NOT NULL DEFAULT 'Share a wish, memory, or moment from the day.' CHECK (length(trim(guestbook_prompt)) BETWEEN 1 AND 160)`, bounded note-rate and purge-receipt tables, export metadata columns, immutable `export_guestbook_entries`, and the ordering/ownership/rate indexes specified in design §10.

- [ ] **Step 5: Wire prompt creation, views, and autosave**

  Map `guestbook_prompt` through `EventRecord`, `EventView`, `GuestEventView`, create/default behavior, Settings Zod validation, `EventsRepository.updateSettings`, and the existing serialized/coalescing queue. Add the **Guestbook prompt** textarea and **Reset prompt** action, and rename the moderation toggle to **Review guestbook notes before sharing**.

- [ ] **Step 6: Run focused tests and verify GREEN**

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/migration-0015.test.ts tests/worker/manage-api.test.ts`

  Run: `npx vitest run --config vitest.config.ts tests/ui/event-settings-editor.test.tsx tests/unit/event-settings-draft.test.ts`

---

### Task 2: Privacy-correct projection repository and versioned cursors

**Files:**
- Create: `worker/db/guestbook.ts`
- Create: `worker/http/guestbook-cursor.ts`
- Modify: `worker/db/messages.ts`
- Modify: `worker/http/message-cursor.ts`
- Modify: `worker/routes/messages.ts`
- Modify: `worker/db/media.ts`
- Test: `tests/worker/guestbook-repository.test.ts`
- Test: `tests/worker/messages-api.test.ts`
- Test: `tests/unit/guestbook-cursor.test.ts`

**Interfaces:**
- Consumes `GuestbookItem`, `GuestGuestbookItem`, `ManagerGuestbookItem`, `GUESTBOOK_SOURCE_RANK`, and `GUEST_MESSAGE_PAGE_SIZE`.
- Produces `GuestbookRepository.listGuestShared`, `listGuestOwnUnshared`, `summaryForManager`, `listForManager`, `snapshotStatements`, `noteItemById`, and `captionItemById`.
- Produces versioned cursor payloads bound to stream/event/session or view/event/source as appropriate.

- [ ] **Step 1: Write projection and cursor tests**

  Cover equal timestamps/source rank, gallery-off caption privacy, whitespace captions, >50 newer shared rows hiding no private row, independent private pagination, cross-session/event cursor refusal, Manager four-view mapping, and legacy version-1 continuation.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/guestbook-repository.test.ts tests/worker/messages-api.test.ts`

  Expected: failures because `GuestbookRepository`, split streams, and version-2 cursors do not exist.

- [ ] **Step 3: Implement safe serializers and ordered UNION projections**

  Select only allowlisted wire fields. Shared guest order is `(created_at DESC, source_rank ASC, id DESC)` and export order is `(created_at ASC, source_rank DESC, source_id ASC)`. Trim captions in SQL and exclude null/empty values.

- [ ] **Step 4: Implement split-stream GET contract and legacy compatibility**

  `contract=2` returns:

  ```ts
  interface GuestbookPage {
    items: GuestGuestbookItem[];
    nextCursor: string | null;
    ownUnshared: GuestGuestbookItem[];
    ownUnsharedCount: number;
    ownUnsharedNextCursor: string | null;
  }
  ```

  Accept exactly one continuation cursor; reject two, malformed, wrong stream/session/event, and unsupported versions with 422. Requests without `contract=2` retain the safe legacy unified projection and version-1 ordering/cursors.

- [ ] **Step 5: Narrow existing Manager note/media responses**

  Replace raw database records with `ManagerGuestbookItem` and `ManagerMediaView` allowlists. Remove `previewObjectKey`, object keys, session IDs, and idempotency keys from all list/mutation/compatibility responses.

- [ ] **Step 6: Run focused tests and verify GREEN**

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/guestbook-repository.test.ts tests/worker/messages-api.test.ts tests/worker/manage-api.test.ts`

---

### Task 3: Bounded idempotent creation and permanent deletion

**Files:**
- Create: `worker/security/guest-message.ts`
- Modify: `worker/db/messages.ts`
- Modify: `worker/routes/messages.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `worker/http/client-ip.ts`
- Modify: `tests/worker/helpers.ts`
- Test: `tests/worker/messages-api.test.ts`
- Test: `tests/worker/cleanup.test.ts`
- Test: `tests/unit/security.test.ts`

**Interfaces:**
- Produces `guestMessagePayloadHmac(env, guestName, body)`, domain-separated session/IP digests, and `MessagesRepository.createBounded`/`purgeDeleted`.
- Requires `GUEST_MESSAGE_HMAC_KEY` and `GUEST_MESSAGE_RATE_LIMIT` but stores no raw IP or contributed content in rate-event rows.

- [ ] **Step 1: Add failing protection and purge tests**

  Cover edge rejection before body parse, exact replay without charging quotas, changed-payload conflict, session 5/window, IP 120/window across re-entry, fixed-window boundary, SQL phase race, 1,000 retained-note cap including deleted rows, atomic tombstone+purge, and post-purge replay outcomes.

- [ ] **Step 2: Run tests and verify RED**

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/messages-api.test.ts tests/worker/cleanup.test.ts`

- [ ] **Step 3: Implement canonical request HMAC and trusted-IP scopes**

  HMAC the stable JSON tuple `[normalizedGuestName, normalizedBody]` under domain prefix `guest-message-payload:v1`; derive separate session/IP rate-scope digests without logging either digest.

- [ ] **Step 4: Implement one guarded creation batch**

  Insert the note only when there is no tombstone, SQL phase is `photos-primary`, both fixed-window counts have capacity, and retained notes are below 1,000; insert the rate event only after `changes() = 1`. Discriminate in this order: exact replay, changed replay, purged replay, phase conflict, durable rate limit, event limit.

- [ ] **Step 5: Implement state-guarded moderation/delete/restore/purge**

  Accept `expectedState`; retain deprecated `expectedStatus` for non-deleted states; restore always targets `rejected`; purge inserts a minimal receipt and hard-deletes in one batch. Return only safe item/purged projections and use `MESSAGE_STATE_CONFLICT`, `MESSAGE_EVENT_LIMIT`, `MESSAGE_PURGED`, and `EVENT_PHASE_CONFLICT` exactly.

- [ ] **Step 6: Add bounded cleanup of stale rate events**

  Sweep `guest_message_rate_events` older than one full 15-minute window in bounded pages; retain purge receipts until event purge.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/messages-api.test.ts tests/worker/cleanup.test.ts`

---

### Task 4: Guestbook guest interface and reactive signature

**Files:**
- Create: `src/features/guestbook/Guestbook.tsx`
- Create: `src/features/guestbook/guestbook-state.ts`
- Modify: `src/pages/EventPage.tsx`
- Modify: `src/features/uploads/GuestUploadFlow.tsx`
- Modify: `src/features/rsvp/GuestRsvpFlow.tsx`
- Modify: `src/styles.css`
- Test: `tests/ui/guestbook.test.tsx`
- Test: `tests/ui/guest-upload-flow.test.tsx`
- Test: `tests/ui/guest-rsvp-flow.test.tsx`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**
- `EventPage` owns `rememberedGuestName` and passes `guestName`/`onGuestNameChange` into upload, RSVP, and Guestbook.
- `Guestbook` accepts `event`, `contributionEnabled`, `guestName`, `onGuestNameChange`, `openRequest`, and reports no whole-page state.

- [ ] **Step 1: Write failing guest UI tests**

  Cover signed/change/unsigned controls, shared/private sections, independent cursors, draft/key preservation, replay deduplication, feed-error isolation, phase read-only behavior, terminal receipt action/focus/reduced motion, and two-way RSVP/upload name propagation.

- [ ] **Step 2: Run tests and verify RED**

  Run: `npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/app.test.tsx`

- [ ] **Step 3: Lift remembered-name state to `EventPage`**

  Initialize once with `readGuestName()`, persist through `rememberGuestName`, and update immediately from RSVP lookup, upload name edits, and Guestbook signature edits. Leaving one note unsigned changes only that draft.

- [ ] **Step 4: Implement the Guestbook disclosure and composer**

  Always render the lazy disclosure beneath the active phase. Enable creation only in `photos-primary`; retain confirmed rows/draft when phase or intake changes. Render host prompt/privacy, composer, **Your private entries**, and **Shared guestbook** in that order with `dir="auto"` and source/state labels.

- [ ] **Step 5: Implement terminal receipt integration**

  Keep the complete photo-delivery receipt. Add exactly one **Leave a guestbook note** control; terminal mode keeps only Guestbook mounted, opens it, scrolls according to reduced-motion preference, and focuses its heading.

- [ ] **Step 6: Run focused tests and verify GREEN**

  Run: `npx vitest run --config vitest.config.ts tests/ui/guestbook.test.tsx tests/ui/guest-upload-flow.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/app.test.tsx`

---

### Task 5: Manager summary, pagination, and row-local curation

**Files:**
- Create: `src/features/guestbook/ManagerGuestbookPanel.tsx`
- Create: `src/features/guestbook/manager-guestbook-state.ts`
- Modify: `worker/routes/messages.ts`
- Modify: `worker/routes/manage.ts`
- Modify: `src/pages/ManagerPage.tsx`
- Modify: `src/styles.css`
- Test: `tests/worker/messages-api.test.ts`
- Test: `tests/ui/manager-guestbook.test.tsx`
- Test: `tests/ui/app.test.tsx`

**Interfaces:**
- `GET .../guestbook/summary` returns `needsReviewCount`, `sharedCount`, `hiddenCount`, `deletedCount`, and `galleryVisible`.
- `GET .../guestbook` returns `{ items, nextCursor, summary }` with view/source/limit/cursor binding.
- Note PATCH returns `{ item }` or `{ purged }`; caption PATCH returns `{ media, item }`.

- [ ] **Step 1: Write failing Manager API and UI tests**

  Cover summary-only initial load, pending-only badge, default view, all four views, three source filters, 25/50 bounds, append pagination, row action matrix, row-local failure/retry, Undo, purge confirmation/recovery, explicit refresh, 15-second/focus summary polling only while visible, and no whole-page refresh.

- [ ] **Step 2: Run tests and verify RED**

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/messages-api.test.ts`

  Run: `npx vitest run --config vitest.config.ts tests/ui/manager-guestbook.test.tsx tests/ui/app.test.tsx`

- [ ] **Step 3: Add Manager summary/list endpoints and safe caption mutation projection**

  Validate exact enums and cursor binding. Use `requireManager`, keyset pagination, and the visibility matrix from design §5.4. Caption actions call only `MediaRepository.setPublication` and never delete media.

- [ ] **Step 4: Replace eager Notes loading with lazy Guestbook panel**

  Initial Manager refresh fetches only the small summary. Rename the nav label to **Guestbook**, badge only `needsReviewCount`, and render heading **Guestbook from the day**. Load rows on first entry and keep per-view/filter state local.

- [ ] **Step 5: Implement row-local state and accessibility**

  Disable only the acting row, preserve scroll/focus, merge server-confirmed items, refetch summary, expose immediate Undo for soft delete, require irreversible purge confirmation, and keep stale data on refresh/poll failures.

- [ ] **Step 6: Run focused tests and verify GREEN**

  Run both commands from Step 2 and confirm zero failures.

---

### Task 6: Immutable Guestbook snapshot and export artifacts

**Files:**
- Create: `worker/export/guestbook-html.ts`
- Create: `worker/export/guestbook-csv.ts`
- Modify: `worker/db/guestbook.ts`
- Modify: `worker/db/exports.ts`
- Modify: `worker/db/types.ts`
- Modify: `worker/routes/exports.ts`
- Modify: `worker/workflows/export.ts`
- Modify: `worker/workflows/cleanup.ts`
- Modify: `src/app/types.ts`
- Modify: `src/components/ManagerExportPanel.tsx`
- Test: `tests/unit/guestbook-export.test.ts`
- Test: `tests/worker/export-api.test.ts`
- Test: `tests/worker/cleanup.test.ts`

**Interfaces:**
- Produces immutable `ExportGuestbookEntryRecord[]`, `buildGuestbookHtml`, and `buildGuestbookPrivateCsv`.
- Extends `ExportRecord` with the six object/size/digest fields, counts, and snapshot metadata.
- `markReady` accepts nullable manifest and zero parts only when the new-format inventory groups are complete.

- [ ] **Step 1: Write failing renderer, snapshot, workflow, retry, and cleanup tests**

  Cover hostile HTML values, no remote/script content, oldest-first/event-zoned formatting, empty keepsake, exact CSV columns and formula hardening, snapshot immutability, gallery capture, notes-only/photos-only/private-only/mixed/empty/oversize cases, partial-inventory refusal, retry deletion/reset, photo drift, expiry, legacy rows, and event purge.

- [ ] **Step 2: Run tests and verify RED**

  Run: `npx vitest run --config vitest.config.ts tests/unit/guestbook-export.test.ts`

  Run: `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts tests/worker/cleanup.test.ts`

- [ ] **Step 3: Implement atomic export creation and immutable rows**

  Use one `DB.batch()` whose first guarded `INSERT ... SELECT` creates a queued job only for a non-empty, within-cap snapshot; follow with `INSERT ... SELECT` snapshot rows guarded by `changes()`. Preserve >1,000 legacy notes without truncation and discriminate active/oversize/empty outcomes.

- [ ] **Step 4: Implement self-contained HTML and private CSV renderers**

  Escape every interpolated HTML value, use semantic `article dir="auto"`, inline print CSS, event-zoned dates, and no network-capable content. Use shared `csvCell()` for every CSV field and map caption media IDs to the current photo plan without dropping frozen IDs.

- [ ] **Step 5: Extend `ExportWorkflow` and readiness inventory**

  Re-read immutable Guestbook rows and the existing live photo snapshot, upload photo artifacts when present plus both Guestbook artifacts always for new-format jobs, compute SHA-256/bytes, and atomically mark ready only with complete applicable groups. Delete every attempt object before marking failures.

- [ ] **Step 6: Extend signed downloads, retry, and cleanup**

  Return nullable photo manifest/parts plus separate printable/private descriptors. Refuse retry state before deletion, delete stored inventory keys, reset all six Guestbook artifact fields, retain snapshot rows/metadata, and delete all inventory objects during expiry/event purge.

- [ ] **Step 7: Run focused tests and verify GREEN**

  Run both commands from Step 2 and confirm zero failures.

---

### Task 7: Cloudflare bindings, release topology, and migration verification

**Files:**
- Modify: `wrangler.jsonc`
- Modify: `.dev.vars.example`
- Regenerate: `worker-configuration.d.ts`
- Modify: `scripts/verify-fresh-d1.ts`
- Modify: `scripts/migrate-release.ts`
- Modify: `scripts/staging-release-candidate.ts`
- Modify: `scripts/staging-release.ts`
- Modify: active post-cutover release/staging fixtures under `tests/unit/`
- Modify: `docs/deployment.md`
- Modify: `docs/security.md`
- Modify: `docs/operations.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Adds production `GUEST_MESSAGE_RATE_LIMIT` namespace `1003`, limit `120`, period `60`.
- Adds persisted-data secret `GUEST_MESSAGE_HMAC_KEY`.
- Advances active topology to a named post-Phase3 three-limiter/new-secret baseline without rewriting historical candidate evidence.

- [ ] **Step 1: Write failing binding/topology/migration verifier tests**

  Add post-cutover cases for exactly 15 migrations, terminal `events.guestbook_prompt`, three limiters, and the new required secret. Keep historical 14-migration/two-limiter fixtures named and unchanged.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts tests/unit/migrate-release.test.ts tests/unit/release-candidate.test.ts tests/unit/staging-release-candidate.test.ts tests/unit/staging-release.test.ts tests/unit/deploy-release.test.ts tests/unit/staging-release-evidence.test.ts`

- [ ] **Step 3: Update config and active topology contracts**

  Add the binding/secret, extend exact-match active tuples and parsers, bump `EXPECTED_MIGRATION_COUNT` to 15, append `guestbook_prompt`, and pin its `TEXT NOT NULL DEFAULT` metadata. Add new post-cutover fixture cases instead of mutating immutable historical ledgers.

- [ ] **Step 4: Regenerate bindings and document the inventory**

  Run: `npm run cf-typegen`

  Update deployment/security/operations/architecture docs with the new rate limiter, persisted key, support codes, Guestbook retention/export copy, and explicit non-deployment boundary.

- [ ] **Step 5: Run focused tests and binding/migration checks**

  Run the Step 2 Vitest command, then `npm run verify:bindings`, and run `npm run verify:fresh-d1 -- --run-root <absolute-temp-directory> --report-file <absolute-temp-directory>/migration-verification.json` with a fresh validated temporary directory.

---

### Task 8: Browser, visual, design-record, and accessibility coverage

**Files:**
- Modify: `design/design-system.md`
- Modify: `design/fidelity-ledger.md`
- Modify: `tests/e2e/manager-responsive.spec.ts`
- Modify: `tests/e2e/rsvp-responsive.spec.ts`
- Modify: `tests/e2e/visual-qa.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Modify: `tests/e2e/core-journey.spec.ts`
- Modify: `tests/e2e/guest-responsive.spec.ts`
- Modify: `tests/e2e/event-theming-visual.spec.ts`
- Update only intentionally affected Playwright snapshots.

**Interfaces:**
- Locks Manager label **Guestbook**, heading **Guestbook from the day**, and the sole terminal follow-on action **Leave a guestbook note**.

- [ ] **Step 1: Update failing browser expectations before UI code is accepted**

  Cover 320/390 mobile, desktop, keyboard-only, long/RTL/Unicode content, gallery-off, reduced motion, 200%/400% zoom, no horizontal overflow, axe scans, and printable HTML screen/print rendering.

- [ ] **Step 2: Run focused Playwright tests and inspect RED diffs**

  Run: `npx playwright test tests/e2e/core-journey.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/manager-responsive.spec.ts tests/e2e/accessibility.spec.ts`

- [ ] **Step 3: Amend design records and styles**

  Apply the exact design-system/fidelity-ledger amendments from design §17. Keep theme-token usage, 44px targets, `:focus-visible`, live regions, and reduced-motion behavior.

- [ ] **Step 4: Re-capture only intentional snapshots and rerun focused browser tests**

  Confirm changed baselines correspond only to the approved label/receipt/Guestbook surfaces.

---

### Task 9: Full local verification and evidence boundary

**Files:**
- Inspect all task diffs and generated artifacts; do not stage unrelated files.

- [ ] **Step 1: Run static and unit/Worker gates**

  Run: `npm run typecheck`

  Run: `npm run typecheck:e2e`

  Run: `npm run lint`

  Run: `npm run test`

- [ ] **Step 2: Run build, browser, and binding gates**

  Run: `npm run build`

  Run: `npm run test:e2e`

  Run: `npm run verify:bindings`

- [ ] **Step 3: Run migration verification in a fresh absolute temp directory**

  Run the repository command from Task 7 and retain only local evidence allowed by the repository conventions.

- [ ] **Step 4: Inspect exact diff and requirement coverage**

  Run: `git diff --check`

  Run: `git status --short`

  Re-read design §§5–17 and map every requirement to a passing focused/full gate or report it as an explicit remaining gap.

- [ ] **Step 5: Report only locally proven status**

  Separate implementation and local verification from immutable release-candidate verification, remote migration, deployment, runtime certification, and physical-device acceptance. Do not perform or claim any of those separately authorized gates.

# Task 6 report: immutable Guestbook snapshot and export artifacts

## Status

Implemented and locally verified in the isolated worktree on `codex/curated-private-guestbook`.

Implementation commit: `5961213` (`feat: add immutable guestbook export artifacts`)

No push, deployment, remote D1 migration, remote state change, release certification, browser baseline update, or physical-device claim was made.

## Files

- `worker/export/guestbook-html.ts`
- `worker/export/guestbook-csv.ts`
- `worker/db/guestbook.ts`
- `worker/db/exports.ts`
- `worker/db/types.ts`
- `worker/routes/exports.ts`
- `worker/workflows/export.ts`
- `worker/workflows/cleanup.ts`
- `src/app/types.ts`
- `src/components/ManagerExportPanel.tsx`
- `tests/unit/guestbook-export.test.ts`
- `tests/worker/export-api.test.ts`
- `tests/worker/cleanup.test.ts`
- `tests/worker/guestbook-repository.test.ts` (updated to exercise the required `changes()` snapshot guard)

## RED evidence

1. `npx vitest run --config vitest.config.ts tests/unit/guestbook-export.test.ts`
   - Exit 1.
   - The suite could not resolve the absent `worker/export/guestbook-csv.ts` module; 0 tests ran.
   - This established the missing renderer API before either renderer module was created.

2. `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts tests/worker/cleanup.test.ts`
   - Exit 1.
   - 1 failed, 99 passed.
   - The new atomic notes-only snapshot case received HTTP 409 instead of 202, demonstrating the old photo-only read-then-write creation path.

## GREEN evidence

- `npx vitest run --config vitest.config.ts tests/unit/guestbook-export.test.ts`
  - 1 file passed; 5 tests passed.
- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts tests/worker/cleanup.test.ts`
  - 2 files passed; 113 tests passed.
- `npx vitest run --config vitest.config.ts tests/unit/export.test.ts`
  - 1 file passed; 7 tests passed.
- `npx vitest run --config vitest.worker.config.ts tests/worker/guestbook-repository.test.ts`
  - 1 file passed; 6 tests passed.
- `npm run typecheck`
  - Exit 0.
- `npm run lint`
  - Exit 0 with zero warnings.
- `git diff --check`
  - Exit 0.

Focused test total: 131 passing tests, zero focused failures.

The Worker test harness printed its existing warning that local secret environment variables were not configured; the focused tests supplied their normal fixtures and completed successfully.

## Coverage and self-review

- Renderer safety: escapes hostile event/name/prompt/body/archive values, uses semantic `article dir="auto"`, contains inline print CSS and a network-denying CSP, creates no request-capable DOM nodes, formats in the frozen event time zone, renders oldest-first, and provides empty-shared-book copy.
- CSV: exact requested columns/order, CRLF records, Unicode/quote/newline behavior, shared `csvCell()` on headers and every field, formula hardening, exact source state/visibility, and frozen media-ID/current photo-plan mapping.
- Atomic snapshot: one guarded D1 `batch()` creates the queued job and immutable rows in the same transaction; trigger-induced insertion failure proves rollback; active, empty, and oversized outcomes are distinguished; exact counts and frozen event/prompt/gallery metadata are stored; 1,001 legacy notes are not truncated.
- Workflow: immutable Guestbook rows are keyset-paged in bounded pages; notes-only, photos-only, private-only, and mixed photo/caption inventories produce both new artifacts; photo count drift retains `EXPORT_SNAPSHOT_CHANGED`; count-equal membership drift uses the recomputed plan while retaining the frozen caption media ID; bytes and SHA-256 values are durable.
- Readiness/download: new-format Ready requires complete Guestbook and applicable photo groups; legacy null Guestbook fields remain valid; notes-only manifest/parts are nullable/empty; printable and private descriptors are independently signed after manager authorization with one displayed expiry; guest/public download routes were not added.
- Failure/retry/cleanup: each failed attempt deletes created keys before Failed state; retries refuse state before deletion, delete recorded manifest/parts/HTML/CSV, clear all six artifact fields only after deletion succeeds, and retain immutable rows/metadata; expiry deletes exact inventory before Expired state; event purge deletes durable export keys before dependent rows.
- Current Cloudflare D1 documentation was checked before implementation: `DB.batch()` executes prepared statements sequentially as a transaction and rolls the sequence back on failure. Generated project D1 types were used.

## Impeccable detector

The required detector was run exactly once against `src/components/ManagerExportPanel.tsx` and `src/styles.css`. It exited 1 on pre-existing global `src/styles.css` findings, including thick side borders and design-system literal advisories throughout the unchanged stylesheet. It surfaced no changed-panel finding. No CSS, detector configuration, sidecar, or unrelated global finding was edited.

## Concerns and evidence boundaries

- `npm run typecheck:e2e` remains red at `tests/e2e/fixtures/routes.ts:43`: the Task 8-owned `GuestEventView` fixture is missing `guestbookPrompt`. The explicit Task 6 boundary forbids Task 8/browser/baseline edits, so this unrelated fixture was not changed.
- No browser, print-dialog, common-spreadsheet, remote R2/D1, deployment, or physical-device evidence is claimed by these local unit/Worker results.

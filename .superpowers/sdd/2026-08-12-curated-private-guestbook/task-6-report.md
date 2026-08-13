# Task 6 report: immutable Guestbook snapshot and export artifacts

## Status

Implemented and locally verified in the isolated worktree on `codex/curated-private-guestbook`.

Implementation commit: `5961213` (`feat: add immutable guestbook export artifacts`)

Review-fix commits:

- `4e022e0` (`fix: serialize export workflow ownership`)
- `5b3fffc` (`fix: resume owned export workflow retries`)

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

## Review-fix round 1

### Disposition

1. Accepted: `processExport()` did not verify ownership of the queued-to-running transition. `ExportsRepository.claimRunning()` now returns a discriminated ownership result, and only its owner proceeds. A duplicate invocation returns the current record without uploading, failing, or otherwise processing the attempt; an already-Ready invocation remains an idempotent return.
2. Accepted: the old `markReady()` batch could delete and replace part rows before its final guarded state update lost. The batch now acquires a transaction-local Ready claim in its first statement, guards every part deletion/insertion with that claim, and finalizes inventory only while still owning it. D1 batch atomicity keeps the temporary claim invisible and rolls the whole sequence back on statement failure.
3. Accepted: create, get, list, and retry serialized the internal `ExportRecord`, exposing durable object keys and internal artifact digests. These endpoints now use an explicit Manager projection allowlist; `ExportView` no longer declares `manifestObjectKey`. Signed download descriptors remain separately authorized and unchanged.
4. Accepted: a Workflow callback exception could leave the exclusive claim Running, after which the platform's serialized retry looked like a non-owner and returned without completing the job. The stable Workflow `event.timestamp` now acts as the `started_at` ownership token: the same instance retry resumes while a distinct delivery loses. Before a resumed owner writes, it deletes the exact deterministic current-attempt prefix in bounded R2 pages. Prefix-list/delete failures remain callback failures with the job Running, so unknown orphaned objects cannot be hidden behind a Failed transition.

### Additional RED evidence

- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts`
  - Exit 1; 18 tests total: 2 failed, 16 passed.
  - The duplicate workflow regression showed a non-owner changing an already-Running job to Failed.
  - The lost-transition regression showed stale `markReady()` inventory replacing the winner's durable part row.
  - The already-Ready idempotency regression passed in the same run.
- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts`
  - Exit 1; 19 tests total: 1 failed, 18 passed.
  - The Manager response allowlist failed because the raw record exposed event/internal timestamps, error state, object keys, artifact byte counts, and SHA-256 digests.
- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts -t "same serialized Workflow owner|distinct queued-to-running"`
  - Exit 1; 20 tests total: 1 failed, 1 passed, 18 skipped.
  - The same stable owner remained Running instead of resuming; the distinct-owner exclusion passed.
- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts -t "same serialized Workflow owner"`
  - Exit 1; 20 tests total: 1 failed, 19 skipped.
  - The retry reached Ready without invoking the forced failing prefix delete, proving crashed-attempt orphan cleanup was absent.

### Additional GREEN evidence

- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts -t "queued-to-running|already-Ready"`
  - 2 passed, 16 skipped.
- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts -t "does not mutate winner parts"`
  - 1 passed, 17 skipped.
- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts`
  - 1 file passed; 19 tests passed after the first three fixes.
- `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts -t "same serialized Workflow owner|distinct queued-to-running"`
  - 2 passed, 18 skipped.
  - The same-owner case also proves a prefix-delete failure rejects while retaining Running, then a same-token retry removes the orphan before Ready.
- Final combined verification:
  - `npx vitest run --config vitest.config.ts tests/unit/guestbook-export.test.ts tests/unit/export.test.ts` -- 2 files, 12 tests passed.
  - `npx vitest run --config vitest.worker.config.ts tests/worker/export-api.test.ts tests/worker/cleanup.test.ts tests/worker/guestbook-repository.test.ts` -- 3 files, 124 tests passed.
  - `npm run typecheck` -- exit 0.
  - `npm run lint` -- exit 0 with zero lint warnings.
  - `git diff --check` -- exit 0.

Latest focused total: 136 passing tests, zero focused failures. The Worker harness emitted only its expected missing-local-secret warning.

The Impeccable detector was not rerun during this review-fix round, as required. No Task 8 fixture or browser/baseline file was changed.

## Concerns and evidence boundaries

- `npm run typecheck:e2e` remains red at `tests/e2e/fixtures/routes.ts:43`: the Task 8-owned `GuestEventView` fixture is missing `guestbookPrompt`. The explicit Task 6 boundary forbids Task 8/browser/baseline edits, so this unrelated fixture was not changed.
- No browser, print-dialog, common-spreadsheet, remote R2/D1, deployment, or physical-device evidence is claimed by these local unit/Worker results.

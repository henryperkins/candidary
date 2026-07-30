# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm run dev            # Vite + @cloudflare/vite-plugin — SPA and Worker run together
npm run build          # tsc -b (both projects) then vite build
npm run typecheck      # tsc -b --pretty false
npm run lint           # eslint . --max-warnings=0
npm test               # test:unit + test:worker
npm run test:unit      # jsdom: tests/unit + tests/ui
npm run test:worker    # workerd (vitest-pool-workers): tests/worker
npm run test:e2e       # Playwright against a built `vite preview`
npm run test:load:wedding   # dry-run plan unless CANDIDARY_LOAD_CONFIRM is set
npm run cf-typegen     # regenerate worker-configuration.d.ts after binding changes
npx wrangler d1 migrations apply candidary-core --local   # required before first `npm run dev`
```

Single test runs:

```powershell
npx vitest run --config vitest.config.ts tests/unit/upload-queue.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/upload-api.test.ts -t 'reservation'
npx playwright test tests/e2e/core-journey.spec.ts --project=mobile
```

Local secrets go in `.dev.vars` (copy `.dev.vars.example`). `TOKEN_HMAC_KEY`, `SESSION_HMAC_KEY`,
`LOGIN_HMAC_KEY`, and `GUEST_TOKEN_ENCRYPTION_KEY` must be independent values; the last must be
exactly 32 bytes encoded as base64url.

## Architecture

One Cloudflare Worker (`worker/index.ts`) serves everything: a Hono API, the React SPA via the `ASSETS`
binding, daily cleanup and hourly notification-dispatch scheduled jobs, and the exported
`ExportWorkflow` class. Bindings are `DB` (D1), `MEDIA_BUCKET` (private R2), `IMAGES`,
`EXPORT_WORKFLOW`, `EMAIL`, `HOST_AUTH_RATE_LIMIT`, and `ASSETS`.

Two build TypeScript projects share one repo: `tsconfig.app.json` (`src`, `tests/unit`, `tests/ui`) and
`tsconfig.worker.json` (`worker`, `tests/worker`). Both include `shared/`, which is imported by relative
path (`../../shared/constants`) from either side — there are no path aliases. The separate
`tsconfig.e2e.json` covers `tests/e2e`, `shared`, and `playwright.config.ts`; run
`npx tsc -p tsconfig.e2e.json --pretty false` because `npm run typecheck` does not include it.

### Authorization

Management links and durable host-account membership are two independent manager credentials. A link
is `id.secret`; D1 stores only a keyed HMAC digest of the secret (`worker/security/crypto.ts`).
Host accounts and `event_hosts` membership (`migrations/0006_host_accounts.sql`,
`worker/routes/host-auth.ts`) let an owner manage an event without its link. The management link keeps
working until its own lifecycle ends, and an account is never required to create or run an event.
There is no guest account.
`GET /join/:token` and `/manage/:token` (`routes/exchange.ts`)
exchange the link for an HttpOnly session cookie plus a readable CSRF cookie, then redirect to a
token-free URL. The guest secret is additionally kept as AES-GCM ciphertext so a manager can re-display
the share link; the manager secret is unrecoverable by design.

Guest routes resolve the event session and compare its event, role, and slug with the path; route
identifiers alone never grant access. Manager routes use `requireManager`/`resolveManager` from
`worker/auth/manager.ts`, which tries account membership and management-link credentials with explicit
precedence and lifecycle handling. Manager writes pass `{ write: true }`, so CSRF is checked against
the credential that actually authorized the request; guest writes use their event-session CSRF pair.
Do not replace these helpers with a route-id check or assume the event and host cookies are
interchangeable.

### Upload path (the core journey)

Three phases, because originals never pass through the Worker:

1. **Reserve** — `POST /api/event/:slug/uploads/batch` validates type/size, atomically increments event
   counters, inserts `reserved` media rows, and returns presigned R2 PUT URLs (10 min, MIME-bound).
2. **Transfer** — the browser PUTs bytes straight to R2 (`xhrUpload` in `GuestUploadFlow.tsx`), max two
   concurrent per guest (`runUploadQueue` in `features/uploads/upload-queue.ts`).
3. **Finalize** — `POST .../uploads/:mediaId/finalize` HEADs the object, checks size/content-type, sniffs
   the file signature (`security/image-metadata.ts`), and flips the row to `stored` while moving counters
   from reserved to stored. Failures delete the object and release the reservation.

Every reservation carries a client-generated `idempotencyKey` unique per `(event, session)`. Retry
re-enters the same media row rather than creating a new one — see `MediaRepository.refreshIdempotent`.
The queue distinguishes "retry the whole transfer" from "retry finalize only" via `retryStage`, so a
transient confirmation failure does not re-send bytes.

### Media privacy

`stored` means privately delivered to the host. `publicationStatus` (`unpublished`/`published`/`hidden`)
is orthogonal and never affects retention, host intake, or export eligibility. Originals are
manager-only (`GET /api/media/:id/original`); guests may read a preview only for their own upload or for
a published photo in a visible gallery. Previews are always produced through the `IMAGES` binding into a
separate R2 key so original metadata is not exposed — never fall back to serving the original bytes from
the preview route.

### Exports

`POST /api/manage/events/:eventId/exports` snapshots every stored, non-deleted original at `snapshotAt`
(a partial unique index enforces one active job per event), then kicks off `ExportWorkflow`.
`workflows/export.ts` partitions the snapshot at 2 GiB of source bytes, streams store-mode ZIP parts
through R2 multipart upload, and writes `candidary-export-manifest.csv`. Retries bump `attempt`, write to
a new prefix, and clear prior part rows. Failures surface as `EXPORT_*` codes carried in `errorCode`.

The daily cron (`workflows/cleanup.ts`) releases expired reservations, deletes expired export objects,
and purges retention-due events. The hourly cron dispatches the bounded host-notification outbox.

## Conventions

- **Errors**: throw `ApiError(code, message, status, fieldErrors?)` from `shared/errors.ts`. `code` must be
  in the `ApiErrorCode` union — add new codes there and document them in `docs/operations.md`. `app.onError`
  converts to the wire shape; unknown errors become `INTERNAL_ERROR`. Messages are guest-facing prose.
- **Responses**: always `{ data, requestId: context.get('requestId') }`.
- **D1 concurrency**: capacity and state transitions are enforced in SQL, not in JS. The pattern is a
  `db.batch([...])` where the first statement has the guard in its `WHERE` and later statements append
  `AND changes() = 1`; then check `results[0].meta.changes === 1` and derive the error from current state.
  See `MediaRepository.reserve`/`finalize`/`delete`. Do not read-then-write counters.
- **Limits** live in `shared/constants.ts` (20 MB/photo, 10,000 photos, 100 GiB/event, batch of 20).
  Treat that file as the source of truth.
- **New image format**: update `SUPPORTED_IMAGE_TYPES`, the client `accept`/validation sets in
  `GuestUploadFlow.tsx`, the signature sniffer, *and* add a migration — `mime_type` has a table CHECK
  constraint.
- **New migration**: add the next numbered SQL file under `migrations/`.
  `vitest.worker.config.ts` discovers that directory with `readD1Migrations()` and exposes the same
  ordered set through `TEST_MIGRATIONS`/`TEST_MIGRATION_QUERIES`.
- **New deep-linkable client route**: add it to `assets.run_worker_first` in `wrangler.jsonc` so the
  Worker's security headers apply before `app.notFound` falls back to `ASSETS.fetch`.
- **Lint**: `@typescript-eslint/consistent-type-imports` is an error and warnings fail the build.
  `noUncheckedIndexedAccess` is on in both projects, so indexed reads need `!` or a guard.

## Testing model

- `tests/worker/**` run in real workerd with D1 and R2 miniflare bindings. Build fixtures with
  `tests/worker/helpers.ts` (`eventAccess`, `uploadPending`, `writeHeaders`); call `resetDatabase()` per
  suite. Requests go through `createApp().request(path, init, testEnv)`.
- `tests/e2e/**` run against a *static* `vite preview` build with **no Worker and no database** — every
  API call is stubbed with `page.route`. They verify the guest/host UI journey, mobile layout at 390×844
  and 320×844, and accessibility. Backend behavior belongs in `tests/worker`, not here.
- `tests/unit/upload-queue.test.ts` covers the queue state machine against a fake `UploadTransport`;
  `GuestUploadFlow` accepts a `transport` prop for the same reason.

## Design and process docs

`design/design-system.md` is binding: fixed color/type tokens, and an explicit allow-list of
above-the-fold copy per surface (no eyebrows, badges, pills, fake metrics, or pricing). `design-qa.md`
and `design/fidelity-ledger.md` record verified responsive states. Approved specs and implementation
plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`; `docs/deployment.md` holds the
wedding and physical-device rehearsal gates.

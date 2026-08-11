# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm run dev            # Vite + @cloudflare/vite-plugin — SPA and Worker run together
npm run build          # tsc -b (app, Worker, scripts) then vite build
npm run typecheck      # tsc -b --pretty false
npm run typecheck:e2e  # tests/e2e + shared + Playwright config
npm run lint           # eslint . --max-warnings=0
npm test               # test:unit + test:worker
npm run test:unit      # jsdom: tests/unit + tests/ui
npm run test:worker    # workerd (vitest-pool-workers): tests/worker
npm run test:e2e       # Playwright against a built `vite preview`
npm run verify:bindings    # fail if generated Worker binding types drift
npm run verify:fresh-d1 -- --run-root <existing-absolute-temp>/candidary-release-<id> --report-file <run-root>/migration-verification.json
npm run verify:release -- --sha <full-commit> --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
npm run test:load:wedding   # dry-run plan unless CANDIDARY_LOAD_CONFIRM is set
npm run test:load:rsvp      # dry-run plan unless CANDIDARY_RSVP_CONFIRM is set
npm run build:cover-presets    # regenerate the 720-file preset matrix (needs headless Chromium)
npm run verify:cover-presets   # re-derive every preset byte size, checksum, and decoded size
npm run cover-backfill:inventory   # read-only; emits the statement to run, then plans from its output
npm run cover-backfill:execute     # dry-run plan unless CANDIDARY_COVER_BACKFILL_CONFIRM is set
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
`LOGIN_HMAC_KEY`, `ENTRY_HMAC_KEY`, `RSVP_LOOKUP_HMAC_KEY`, `GUEST_TOKEN_ENCRYPTION_KEY`, and
`ENTRY_ENCRYPTION_KEY` must be independent values; the two encryption keys must each be exactly
32 bytes encoded as base64url. `ENTRY_HMAC_KEY`, `ENTRY_ENCRYPTION_KEY`, and `RSVP_LOOKUP_HMAC_KEY`
are persisted-data keys: rotating one without a re-encryption/re-digest migration breaks every
printed QR or the roster lookup. Ordinary guest-grant and session rotation must leave them alone.
Local `vite dev` reads this file, while production builds explicitly omit it from generated output.

## Architecture

One Cloudflare Worker (`worker/index.ts`) serves everything: a Hono API, the React SPA via the `ASSETS`
binding, daily cleanup and hourly notification-dispatch scheduled jobs, and the exported
`ExportWorkflow`, `CoverRenderWorkflow`, and `CoverBackfillWorkflow` classes. Bindings are `DB` (D1),
`MEDIA_BUCKET` (private R2), `IMAGES`, `EXPORT_WORKFLOW`, `COVER_RENDER_WORKFLOW`,
`COVER_BACKFILL_WORKFLOW`, `EMAIL`, `HOST_AUTH_RATE_LIMIT`, `RSVP_LOOKUP_RATE_LIMIT`, and `ASSETS`.
`CF_VERSION_METADATA` supplies the deployed Worker version identity used by release certification.

Three build TypeScript projects share one repo: `tsconfig.app.json` (`src`, `tests/unit`, `tests/ui`),
`tsconfig.worker.json` (`worker`, `tests/worker`), and `tsconfig.scripts.json` (release and operational
scripts plus Vite/Vitest configuration). The app and Worker projects include `shared/`, which is imported by relative
path (`../../shared/constants`) from either side — there are no path aliases. The separate
`tsconfig.e2e.json` covers `tests/e2e`, `shared`, and `playwright.config.ts`; run
`npm run typecheck:e2e` because `npm run typecheck` does not include it. `verify:release` is the
immutable aggregate candidate gate: it imports the target commit's own dependency-free runner in a
detached temporary worktree and leaves the caller checkout, including dirty or untracked files,
untouched. It creates local evidence only; deployment and remote migration remain separate authority.

### Authorization

Management links and durable host-account membership are two independent manager credentials. A link
is `id.secret`; D1 stores only a keyed HMAC digest of the secret (`worker/security/crypto.ts`).
Host accounts and `event_hosts` membership (`migrations/0006_host_accounts.sql`,
`worker/routes/host-auth.ts`) let an owner manage an event without its link. The management link keeps
working until its own lifecycle ends, and an account is never required to create or run an event.
There is no guest account.

The printed guest credential is separate again and permanent. `event_entry_credentials` holds one
`id.secret` per event, digested with `ENTRY_HMAC_KEY` and additionally kept as AES-GCM ciphertext under
`ENTRY_ENCRYPTION_KEY` so a manager can re-display it. The QR encodes `/join#<id.secret>`: the fragment
is never sent in a request line or a `Referer`, so `EventEntryPage` reads it once, erases it with
`history.replaceState`, and posts it to `POST /api/entry/exchange` (`routes/entry.ts`), which mints an
ordinary guest event session against the event's current internal guest grant. That internal grant may
be rotated freely — `POST /api/manage/events/:eventId/guest-sessions/rotate` signs guest devices out —
and the printed URL is byte-identical afterwards. `POST .../entry/disable` is irreversible: it pauses
uploads and RSVP, revokes guest and RSVP sessions, and there is no replacement. `/manage/:token`
(`routes/exchange.ts`) still exchanges the management link.

`GET /join/:token` is the path form printed before 0008. It still resolves, because a QR already on a
sign cannot be recalled, but it is deliberately narrow. On first use `EventEntryService.adoptPrintedToken`
copies that event's guest access token — id and secret — into `event_entry_credentials`, re-digested
under `ENTRY_HMAC_KEY` and re-encrypted under `ENTRY_ENCRYPTION_KEY`, so the printed string becomes the
entry credential itself; the exchange then runs through the same `exchangeEntry` as the fragment form.
Because it is its own row, signing guest devices out leaves it working and disabling the entry stops it.
`isPrintedPathCredential` refuses anything issued since: a post-0008 entry id has no
`event_access_tokens` row behind it, so the leaky path form cannot be used for it.

Guest routes resolve the event session and compare its event, role, and slug with the path; route
identifiers alone never grant access. Manager routes use `requireManager`/`resolveManager` from
`worker/auth/manager.ts`, which tries account membership and management-link credentials with explicit
precedence and lifecycle handling. Manager writes pass `{ write: true }`, so CSRF is checked against
the credential that actually authorized the request; guest writes use their event-session CSRF pair.
Do not replace these helpers with a route-id check or assume the event and host cookies are
interchangeable.

There are three cookie scopes, and none of them can authorize another's writes:
`candidary_session`/`candidary_csrf` (event guest), `candidary_host`/`candidary_host_csrf` (host
account), and `candidary_rsvp`/`candidary_rsvp_csrf` (one household). `assertCsrf()` picks the header
by scope; `src/app/api.ts` offers all three and each route validates only the one it accepts.

### RSVP

A household proves itself by typing a full name exactly as printed. `normalizeInvitedName()` in
`shared/rsvp.ts` is version 1 and immutable for this release; the normalized name is keyed with
`RSVP_LOOKUP_HMAC_KEY` into `rsvp_invitees.lookup_digest`, so D1 never stores a submitted name.
`POST /api/event/:slug/rsvp/lookup` needs an event guest session, applies the edge limiter before
parsing any body, then charges the D1 budgets (20 per event/IP and 8 per event/name in a fixed
15-minute bucket) before reading anything. A first name matching more than one household returns only
`second_name_required`; misses, paused events, archived households, and unresolved second names all
share one `not_available` body. Success mints the RSVP session and returns the safe household view.

`RsvpService` owns import, lookup, submission, and every host mutation. Household writes are one
guarded `DB.batch()` whose invitee update carries the version, the event's `rsvp_enabled`/deadline, and
the session's captured write deadline in its `WHERE`; a count mismatch sets `version = NULL` so the
NOT NULL constraint rolls the batch back. Every successful `(household, idempotencyKey)` is kept in
`rsvp_submission_receipts` until the event is purged: replaying the same key and payload digest
returns success, and reusing it with different content is `RSVP_SUBMISSION_CONFLICT`. The browser never
infers phase — `resolveGuestEventPhase()` runs on the Worker and returns `rsvp-primary`,
`before-start`, `photos-primary`, or `waiting` with the current `rsvpState` and `rsvpAccess`.

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

### Event covers

An event cover is not guest media and shares none of its limits. `shared/event-cover.ts` owns the
identifiers, strict schemas, registries, geometry, and the twelve pipeline version axes;
`shared/constants.ts` owns the numbers, which are **decimal** — `MAX_COVER_UPLOAD_BYTES` is
`19_000_000` because the Images binding's `.input()` ceiling is 20 MB, and the binary
`MAX_IMAGE_BYTES` must never be reused for a cover.

Raw bytes do not use a presigned PUT. An authenticated, CSRF-protected `PUT .../drafts/:id/raw`
streams through a byte counter that aborts at 19,000,001, writes only to the draft's server-owned
key, and never buffers the whole photo. Inspection normalizes one still WebP master through a
five-rung ladder, and a versioned Web Worker computes an automatic focal point from the authorized
preview. Publication is asynchronous: `POST .../cover/publications` performs a cheap revision check,
pins a durable receipt, allocates a staging render set, and returns `202` while `CoverRenderWorkflow`
materializes 12 to 24 objects — both formats for all six 1x profiles plus the source-qualified 2x
pairs — verifies the exact manifest, and only then flips the pointer in one revision-guarded
transaction. **The previous cover stays live until the replacement is complete.**

Twelve inventory tables in `0012` back this, and every `event_id` among them is
`ON DELETE RESTRICT` — the first such clauses in this schema, and the reason `deleteEventData()`
carries an explicit child-before-parent cover order. A displaced original is never deleted eagerly:
it is inventoried in `event_cover_retired_legacy_objects` and removed only by the bounded cover phase
of `scheduledCleanup`, R2 first with verified absence, then the row.

Six built-in covers ship as 720 versioned static files under `public/assets/event-covers/v1/`,
generated by `npm run build:cover-presets` and checked by `npm run verify:cover-presets`. They are
global release artwork containing no event data. Cover Studio, `ResponsiveEventCover`,
`EventAppearanceCanvas`, the presets, the four non-`natural` styles, manual focus, and the
revision-scoped delivery routes all ship complete and **unwired**; only `{upload, auto, natural}` and
`{none}` are publishable today. See `docs/superpowers/specs/2026-08-03-event-appearance-cover-studio-design.md`
§9.5 for the three-phase cutover.

### Exports

`POST /api/manage/events/:eventId/exports` snapshots every stored, non-deleted original at `snapshotAt`
(a partial unique index enforces one active job per event), then kicks off `ExportWorkflow`.
`workflows/export.ts` partitions the snapshot at 2 GiB of source bytes, streams store-mode ZIP parts
through R2 multipart upload, and writes `candidary-export-manifest.csv`. Retries bump `attempt`, write to
a new prefix, and clear prior part rows. Failures surface as `EXPORT_*` codes carried in `errorCode`.

The daily cron (`workflows/cleanup.ts`) sweeps bounded auth and RSVP scratch, releases expired
reservations, deletes expired export objects, and purges retention-due events. The hourly cron
dispatches the bounded host-notification outbox.

`deleteEventData()` order is load-bearing: revoke every credential and disable the entry, delete the
event's R2 prefix, then delete `media` and `guest_messages` before the event row. Those two tables
reference `event_sessions` with `ON DELETE RESTRICT`, so the event cascade alone cannot remove a
populated event. If object deletion fails the error propagates and the event stays soft-deleted;
the scheduled pass selects `deleted_at IS NOT NULL` rows too, so it retries rather than stranding
objects nothing can find again.

## Conventions

- **Errors**: throw `ApiError(code, message, status, fieldErrors?)` from `shared/errors.ts`. `code` must be
  in the `ApiErrorCode` union — add new codes there and document them in `docs/operations.md`. `app.onError`
  converts to the wire shape; unknown errors become `INTERNAL_ERROR`. Messages are guest-facing prose.
- **Responses**: always `{ data, requestId: context.get('requestId') }`.
- **D1 concurrency**: capacity and state transitions are enforced in SQL, not in JS. The pattern is a
  `db.batch([...])` where the first statement has the guard in its `WHERE` and later statements append
  `AND changes() = 1`; then check `results[0].meta.changes === 1` and derive the error from current state.
  See `MediaRepository.reserve`/`finalize`/`delete`. Do not read-then-write counters.
- **Limits** live in `shared/constants.ts` (20 MB/photo, 10,000 photos, 100 GiB/event, batch of 20)
  and `shared/rsvp.ts` (500 event capacity, 500 households, 20 named and 10 plus-one slots per
  household, 30 people per household). Treat those files as the source of truth.
- **D1 parameter bound**: no statement may bind more than 100 values. A 500-person import commits as
  one `DB.batch()` of parameter-bounded multi-row statements; a household write passes its rows as one
  JSON binding and uses `json_each()`.
- **CSV output**: every exported cell goes through `csvCell()` in `shared/csv.ts`, which prefixes an
  apostrophe to any cell starting with `=`, `+`, `-`, or `@`. Both the media and RSVP exports use it.
- **New image format**: update `SUPPORTED_IMAGE_TYPES`, the client `accept`/validation sets in
  `GuestUploadFlow.tsx`, the signature sniffer, *and* add a migration — `mime_type` has a table CHECK
  constraint. Event covers are a separate intake with its own list: `COVER_UPLOAD_MIME_TYPES` is an
  independent literal tuple, never a filter over `SUPPORTED_IMAGE_TYPES`, so a new guest-media format
  cannot silently widen what a cover accepts. Widening it also means a `0012` CHECK constraint and
  the Images conformance gate in the design spec's §15.5.
- **New application origin**: add it to `ALTERNATE_ORIGINS` in `wrangler.jsonc`, to
  `KNOWN_APPLICATION_ORIGINS` in `shared/origins.ts`, and to `config/r2-cors.json`, then attach it as a
  Custom Domain. Missing the first fails every write with `ORIGIN_FORBIDDEN`; missing the third fails
  every upload. `tests/unit/origins.test.ts` pins the first two together.
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
wedding and physical-device rehearsal gates, and `docs/rsvp-csv.md` is the guest-list import and
export contract.

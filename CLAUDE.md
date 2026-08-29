# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm run test:smoke     # one smoke case against an already-built artifact; never builds
npm run verify:bindings    # fail if generated Worker binding types drift
npm run build:cloudflare   # one typecheck and one Vite build; selects preview off main
npm run deploy             # one build followed by deployment of that exact artifact
npm run deploy:built       # production deploy only; never installs, builds, tests, or migrates
npm run ci:migrations      # fresh local D1 only when migration-sensitive files changed
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

Local secrets go in `.dev.vars` (copy `.dev.vars.example`), whose ten independent key values are
each generated separately. Every encryption key decodes from unpadded base64url to exactly 32
bytes; `ALBUM_SHARE_HMAC_KEY` contains at least 32 random bytes. The entry,
RSVP, Guestbook, and album-share key material protects persisted data: rotating one without a
coordinated re-encryption, re-digest, re-HMAC, or invalidation migration breaks persisted behavior.
Ordinary guest-grant and session rotation must leave them alone. Preview and production album-share
pairs are independently generated; `verify:bindings` proves names, not remote material.
Local `vite dev` reads this file, while production builds explicitly omit it from generated output.

## Architecture

One Cloudflare Worker (`worker/index.ts`) serves everything: a Hono API, the React SPA via the `ASSETS`
binding, daily cleanup and hourly notification-dispatch scheduled jobs, and the exported
`ExportWorkflow`, `CoverRenderWorkflow`, and `CoverBackfillWorkflow` classes. Its bindings are
declared in `wrangler.jsonc`; the R2 buckets are private, and `CF_VERSION_METADATA` exposes
Cloudflare's deployed Worker version metadata.

Three build TypeScript projects share one repo — `tsconfig.app.json`, `tsconfig.worker.json`, and
`tsconfig.scripts.json`. The app and Worker projects include `shared/`, which is imported by relative
path (`../../shared/constants`) from either side — there are no path aliases. The separate
`tsconfig.e2e.json` covers `tests/e2e`, `shared`, and `playwright.config.ts`; run
`npm run typecheck:e2e` because `npm run typecheck` does not include it. Routine deployment is the
short path documented in `docs/deployment.md`: protected pull request, one Cloudflare build, then
deployment of that exact generated artifact. Full browser coverage is nightly/manual. Fresh-D1 work
is conditional on migration-sensitive changes. There is no candidate-manifest or release-evidence
workflow.

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

Manager uploads derive one of two authorities after `requireManager`; request bodies never choose the
authority. A management-link request uses `manager-link` authority with its authenticated Manager
event session. An account owner/cohost uses `manager-account` authority with the current host session
plus one server-only Manager upload actor bound to the account, event, and current live Manager token.
That actor is identity storage, not a browser credential: its source secrets are discarded, it cannot
mint a cookie, and event-session resolution rejects it before secret comparison. Reservation may
atomically ensure the actor; content, finalize, and cancel only look up an existing one.

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

Three phases; canonical-live originals now pass through the authenticated Worker and never receive a
presigned R2 URL:

1. **Reserve** — `POST /api/event/:slug/uploads/batch` validates type/size, atomically increments event
   counters, inserts `reserved` media rows, and returns authenticated same-origin content URLs.
2. **Transfer** — the browser sends at most two CSRF-protected PUTs concurrently. The Worker rechecks
   event/session ownership, buffers no more than the accepted 20 MB, validates exact size, MIME, image
   signature, and dimensions, then writes the deterministic canonical key create-only and re-reads its
   complete bytes before committing D1 `stored` + `canonical`.
3. **Confirm** — `POST .../uploads/:mediaId/finalize` is an idempotent confirmation for the browser
   queue. A committed Stored row succeeds without resending bytes; an uncommitted reservation requires
   the content PUT again. The schema-v2 five historical presign/download capabilities stay false.

Every reservation carries a client-generated `idempotencyKey` unique per `(event, session)`. Retry
re-enters the same media row rather than creating a new one — see `MediaRepository.refreshIdempotent`.
The queue distinguishes "retry the whole transfer" from "retry finalize only" via `retryStage`, so a
transient confirmation failure does not re-send bytes.

The canonical pipeline carries a server-created `UploadAuthority` through reserve, idempotent refresh,
post-buffer claim, commit, and cancel. The authority selects the intake predicate at both service and
SQL layers: guests retain the exact `uploads_enabled` plus event-start schedule, while `manager-link`
and `manager-account` ignore only that guest pause/schedule and still require a live management window,
Worker ingress, capacity, validation, and promotion fences. Both Manager authorities use the four
`/api/manage/events/:eventId/uploads` routes backed by the same upload implementation. They accept no
guest/account/actor attribution field; the server always persists `guest_name = 'Host'`.

Pausing this intake affects only **new guest uploads**. Once the server-owned `guestReadSurfaces`
projection is available, the event shell and any terminal receipt, My deliveries, Guestbook, and an
independently enabled Guest gallery remain available. `/event/:slug/fullscreen` consumes the same
Gallery availability and item projection as the main guest page; it deliberately remains a
Gallery-only shell rather than duplicating the main page's secondary panels.

### Media privacy

`stored` means privately delivered to the host. `publicationStatus` (`unpublished`/`published`/`hidden`)
is orthogonal and never affects retention, host intake, or export eligibility. Originals are
manager-only (`GET /api/media/:id/original`); guests may read a preview only for their own upload or for
a published photo in a visible gallery. Previews are always produced through the `IMAGES` binding into a
separate R2 key so original metadata is not exposed — never fall back to serving the original bytes from
the preview route.

`0015` makes bucket generation categorical and durably inventories every legacy pointer in
`media_object_promotions`. Candidate A disables ingress/copy/pointer/purge; copy-only validates the
exact legacy ETag, MIME, size, SHA-256, and dimensions, creates and completely re-verifies the object
in the distinct canonical bucket, then freezes `target_verified` proof without moving the pointer.
Only canonical-live may perform the exact proof-bound pointer CAS, and it clears the legacy preview
pointer in the same transaction. Exports fail closed until eligible rows are canonical, while content,
export Workflow, deletion, and maintenance always select the bucket recorded by generation.

Permanent non-FK `media_object_write_tombstones`, `legacy_media_scan_state`, and scanner quarantine
outlive media/events. The scanner repeatedly wraps the entire legacy namespace forever; it is not a
finite drain detector. `source_writable_until`, signer revocation, TTL expiry, and repeated HEADs do
not prove an already-admitted legacy operation is gone.

### Recoverable host deletion

Host deletion is recoverable; guest self-deletion is not. `0019_media_recovery.sql` adds
`media.trashed_at`/`media.restore_until` and `events.recoverable_media_count`/`recoverable_bytes`.
A trashed row keeps `upload_state = 'stored'`, its publication status, its favorite, its album
position, and its bytes, and sets `deleted_at = trashed_at` — an exact equality that is both the
discriminator (`deleted_at` alone means permanently deleted) and the compatibility marker an 0018
Worker already reads as ordinary deletion. `restore_until` is
`min(now + 30 days, management_access_expires_at, purge_after)`, computed inside the transition.

Recovery spends capacity. Reservation, idempotent refresh, and finalization all count
`reserved + active stored + recoverable`, and a trigger enforces that sum against `MAX_EVENT_MEDIA`
and `MAX_EVENT_BYTES` on every counter write, so a Restore can never fail for want of room a trash
only looked like it freed. Every ordinary media query adds `trashed_at IS NULL` explicitly; the named
exceptions are the trash listing, restore, terminal cleanup, purge terminalization, guest self-delete,
and the Manager Album retained-slot resolver, which renders a trashed pick as an opaque marker
carrying only a media ID, `restoreUntil`, and `recoverable`/`expired-cleanup-pending`.

`export_media_entries` plus a `queued` or `running` owner is a D1 source hold: while it stands, no
tombstone for that exact `(bucket_generation, object_key)` may enter suppression, from any path.
Physical deletion runs only through `MediaRepository.claimMediaObjectDeletion`, which wins the
suppression transition for the aliases nothing else owns and hands `deleteMediaObjectAliases` a
`MediaObjectDeletionClaim` of exactly those keys — never a `MediaRecord` to derive keys from.
Retry additionally proves every frozen entry still resolves to an active-or-recoverable stored row at
that exact key, and reports `EXPORT_SOURCE_REMOVED` when it does not.

`0019` refuses to run while any export job is `running`, and fails every queued job it cannot vouch
for. After the new Worker admits the first trash write or `attempt-v2` export the release is
forward-fix-only.

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
global release artwork containing no event data. Phase 3 wires one live `EventAppearanceCanvas`,
Cover Studio, and `ResponsiveEventCover`: `{none}`, every preset/effect pair, and upload with automatic
or manual focus and any of the five effects are publishable. Manager event JSON owns the exact nested
six-key `cover` view (`config`, `revision`, `hasCover`, `available2xProfiles`, `surfaceTreatment`,
`preparation`); guest JSON owns the exact four-key subset with no config or preparation. Neither view
contains an object key, master ID, render-set ID, draft ID, receipt ID, or Workflow ID.

Cover bytes are read only through the revision-scoped, allowlisted guest and Manager slot routes.
Every request reauthorizes the event and requires the requested revision to equal the current event
revision. A preset returns a private/no-store `307` to an immutable event-free asset; an upload returns
only the exact current derivative with `private, no-store` and `nosniff`. A stale revision, missing
slot, retired/cross-event set, or impossible pointer graph fails closed. There is no revisionless
reader, legacy-object response, lazy Images transform, or normalized-master fallback. The nine
`0014_event_cover_invariants.sql` triggers make those semantic, receipt, active-set, and ordered-purge
relationships database invariants; Phase 2 ends one file earlier at
`0013_guest_message_hardening.sql`. Those 13/14-migration boundaries remain immutable historical
release evidence. The album scope is also ordered: `0017_event_album.sql` creates the album/order
foundation and `0018_album_end_to_end.sql` adds metadata, sharing, sessions, and export fields;
`0019_media_recovery.sql` adds recoverable host deletion and the export source hold.

### Exports

`POST /api/manage/events/:eventId/exports` without a kind snapshots every stored, non-deleted original
at `snapshotAt`, then kicks off `ExportWorkflow`. `{ "kind": "album" }` instead freezes the album's
ordered photo entries and tail positions in one transaction. That album job never absorbs later picks
or order changes and contains no Guestbook artifacts. Creation and retry enforce one queued or running
export per event across both kinds, so a complete and an album export cannot run concurrently.
`workflows/export.ts` partitions the snapshot at 2 GiB of source bytes, streams store-mode ZIP parts
through R2 multipart upload, and writes `candidary-export-manifest.csv`. Retries bump `attempt`, write to
a new prefix, and clear prior part rows. Failures surface as `EXPORT_*` codes carried in `errorCode`.

Post-cutover export creation also freezes Guestbook metadata and entries for a printable HTML keepsake
and a separate private CSV archive. Both inherit the Ready artifact's 24-hour object expiry; immutable
snapshot rows remain in D1 for authorized retry until event purge.

### Album sharing

An event has at most one active `event_album_shares` row. Its fragment credential is stored as an
`ALBUM_SHARE_HMAC_KEY` digest plus `ALBUM_SHARE_ENCRYPTION_KEY` AES-256-GCM ciphertext so an authorized
Manager can redisplay the current link. Exchange clears the fragment and mints a separate seven-day
HttpOnly/Secure/SameSite=Strict cookie scoped to `/api/album-share`; its digest uses
`SESSION_HMAC_KEY`. The resulting authority reads only the public album projection and previews for
current album picks. It cannot read originals, Manager APIs, guest delivery, or the Shared gallery.

Stopping sharing deletes the parent row and cascades all album-share sessions, so both the old link
and existing cookies immediately receive `ALBUM_SHARE_UNAVAILABLE`. One share atomically admits at
most 2,000 unexpired sessions; expired rows do not count, and capacity returns HTTP 429 with
`Retry-After` derived from the earliest active expiry. An enable response that observed a share before
a concurrent stop cannot recreate the deleted row or authorize access. Scheduled cleanup uses
100-row statements capped at 50 statements/5,000 deletions per daily invocation. Both album-share
keys protect persisted data, rather than routine sessions: rotate them only after revoking all shares
or with a reviewed forward migration that re-HMACs and re-encrypts every active secret under the new
pair.

The daily cron (`workflows/cleanup.ts`) sweeps bounded auth and RSVP scratch, releases expired
reservations, deletes expired export objects, and purges retention-due events. Both the daily pass and
the hourly `47 * * * *` pass independently track bounded media copy/pointer work, the permanent legacy
scanner/tombstone janitor, and the host-notification outbox. Promoter failure or exhaustion cannot
prevent scanner/janitor progress, and scanner failure cannot abandon the already-started janitor.

`deleteEventData()` order is load-bearing: revoke every credential and disable the entry, delete the
event's R2 prefix, then delete `media` and `guest_messages` before the event row. Those two tables
reference `event_sessions` with `ON DELETE RESTRICT`, so the event cascade alone cannot remove a
populated event. If object deletion fails the error propagates and the event stays soft-deleted;
the scheduled pass selects `deleted_at IS NOT NULL` rows too, so it retries rather than stranding
objects nothing can find again.

## Conventions

- **Event-zone display**: `src/app/event-date-time.ts` is the canonical formatter owner for exactly
  four host surfaces: the Intake schedule, Manager header/retention, upload flow, and Host Events.
  Keep date-valued locale formatting out of those callers. The Gallery timeline's same-minute
  grouping remains a separate formatter concern.
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
  cannot silently widen what a cover accepts. Widening it also means a new migration for the CHECK
  constraint introduced by `0012` and verification against real Images in an isolated preview.
- **New application origin**: add it to `ALTERNATE_ORIGINS` in `wrangler.jsonc`, to
  `KNOWN_APPLICATION_ORIGINS` in `shared/origins.ts`, and to `config/r2-cors.json`, then attach it as a
  Custom Domain. Missing the first fails every write with `ORIGIN_FORBIDDEN`; missing the third fails
  every upload. `tests/unit/origins.test.ts` pins the first two together.
- **New migration**: add the next numbered SQL file under `migrations/`.
  `vitest.worker.config.ts` discovers that directory with `readD1Migrations()` and exposes the same
  ordered set through `TEST_MIGRATIONS`/`TEST_MIGRATION_QUERIES`.
- **New deep-linkable client route**: add it to `assets.run_worker_first` in `wrangler.jsonc` so the
  Worker's security headers apply before `app.notFound` falls back to `ASSETS.fetch`.
- **New public page**: it is four edits, not one. `public/sitemap.xml`, `assets.run_worker_first`
  (a page the Worker never sees cannot negotiate), the `MARKDOWN_PAGES` registry in
  `worker/http/agent-markdown.ts`, and its copy in `shared/site-content.ts` — which the React page
  renders and the `Accept: text/markdown` answer is built from, so the two can never say different
  things. Private surfaces belong in none of them, and `public/robots.txt` must keep disallowing
  their prefixes. That file also carries the wildcard group's `Content-Signal` preference.
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

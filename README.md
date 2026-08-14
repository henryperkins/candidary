# Candidary

Candidary is a mobile-first private RSVP and photo drop for weddings and large events. One permanent QR code is printed on the invitation and on the signs at the venue. Before the event it opens the household RSVP; on the day it opens the private photo drop. No account is required, and the printed code never changes.

A household finds its invitation by typing a full name exactly as it appears on it — the guest list is never shown, suggested, or searchable. Each named guest and each approved plus-one slot answers individually, and the response can be revised until the host's deadline.

The photo journey ends with an exact delivery receipt. Shared galleries, notes, and publication controls remain available as secondary features; they never block private host delivery or complete exports.

## What it supports

- One permanent printed event QR that survives guest sign-out, session expiry, and the change from RSVP to photos.
- Household RSVP by exact-name lookup, with individual attendance for every named guest and plus-one slot.
- A host guest list built by one CSV import or by hand, with live totals, filters, archive, and a safe CSV export.
- Camera capture with an environment-camera hint and multi-select recent photos.
- JPEG, PNG, WebP, HEIC, and HEIF originals up to 20 MB each.
- Ordered reservation batches and at most two concurrent transfers per guest.
- Independent retry/removal for partial failures and idempotent finalization.
- Required 1-80 character guest-name snapshots remembered on the device.
- Private R2 originals with authorized Cloudflare Images previews.
- Live host intake, guest-name search, optional gallery publication, and notes.
- Optional host accounts with email and password, so an event survives a lost management link. An address becomes an account only after an emailed code proves the mailbox.
- Emailed getting-started, event-day, and access-expiry notices, sent from a durable D1 outbox with one-click unsubscribe.
- 10,000 photos and 100 GiB per event by design.
- Complete exports containing every stored original in source-bounded 2 GiB ZIP parts plus a manifest.

## Local development

Requirements: Node.js 22+, npm 11+, and a Cloudflare account for browser-direct R2 and Images testing.

For a Linux or Codex cloud checkout, the idempotent setup script installs the
locked dependency tree, generates local-only secrets, and applies the D1
migrations locally:

```bash
./scripts/setup-codex.sh
npm run dev
```

For a manual Windows setup:

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npx wrangler d1 migrations apply candidary-core --local
npm run dev
```

Generate independent local secrets with Node:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Run that command seven times. Use separate values for `TOKEN_HMAC_KEY`, `SESSION_HMAC_KEY`, `GUEST_TOKEN_ENCRYPTION_KEY`, `LOGIN_HMAC_KEY`, `ENTRY_HMAC_KEY`, `ENTRY_ENCRYPTION_KEY`, and `RSVP_LOOKUP_HMAC_KEY`. `GUEST_TOKEN_ENCRYPTION_KEY` and `ENTRY_ENCRYPTION_KEY` must each be exactly 32 bytes encoded as base64url. Direct upload URLs also require an R2 API token in `.dev.vars`.

`ENTRY_HMAC_KEY`, `ENTRY_ENCRYPTION_KEY`, and `RSVP_LOOKUP_HMAC_KEY` are persisted-data keys, not rotation controls: rotating one without a re-encryption or re-digest migration breaks every printed QR or the roster lookup. See [security.md](docs/security.md).

Outbound email needs no local configuration: `wrangler dev` simulates the `EMAIL` binding and writes each message to a file it names in the console. Real sending is described in [deployment.md](docs/deployment.md).

## Verification

```powershell
npm test
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run check
npm run build
npm run verify:bindings
npm run verify:fresh-d1 -- --run-root <absolute-candidary-release-temp-root> --report-file <root>/migration-verification.json
npm run test:e2e
npm run test:load:wedding
npm run test:load:rsvp
```

Both load commands are dry runs unless an operator supplies a dedicated rehearsal event and the explicit live confirmation described in [operations.md](docs/operations.md). Browser automation at 390 by 844 pixels supplements—but does not replace—physical iPhone Safari and Android Chrome acceptance.

For an immutable local release candidate, commit the complete candidate first and pass both exact
commit IDs to the aggregate gate:

```powershell
$reviewedSha = git rev-parse HEAD
npm run verify:release -- --sha $reviewedSha --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
```

The command verifies a detached temporary worktree, including a fresh local D1 through
`npm run verify:fresh-d1`, and writes redacted evidence under `output/release/`. It does not migrate
remote D1, deploy, certify a runtime, or replace physical-device rehearsal. See
[deployment.md](docs/deployment.md) for the evidence and authorization boundaries.

## Architecture

- `src/` — React event entry, household RSVP, event drop, upload queue, secondary guest content, and host intake.
- `worker/` — Hono API, durable event entry, authorization, host accounts, RSVP services, D1 repositories, private R2 storage, Images previews, exports, notifications, and cleanup.
- `migrations/` — D1 schema and state constraints.
- `shared/` — contracts, limits, RSVP normalization, event-local time, CSV parsing, and stable errors.
- `tests/` — unit, Worker integration, and real-browser coverage.
- `docs/superpowers/` — the approved designs and implementation plans.
- `docs/rsvp-csv.md` — the exact guest-list import and export contract.

Deployment and rehearsal steps are in [deployment.md](docs/deployment.md). Operational limits and recovery are in [operations.md](docs/operations.md).

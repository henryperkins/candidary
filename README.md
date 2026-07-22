# Candidary

Candidary is a mobile-first private photo drop for weddings and large events. A guest scans the event QR code, enters one required name, takes a photo or chooses recent photos, reviews the selection, and sends the untouched originals directly to the host. No account is required.

The primary journey ends with an exact delivery receipt. Shared galleries, notes, and publication controls remain available as secondary features; they never block private host delivery or complete exports.

## What it supports

- Camera capture with an environment-camera hint and multi-select recent photos.
- JPEG, PNG, WebP, HEIC, and HEIF originals up to 20 MB each.
- Ordered reservation batches and at most two concurrent transfers per guest.
- Independent retry/removal for partial failures and idempotent finalization.
- Required 1-80 character guest-name snapshots remembered on the device.
- Private R2 originals with authorized Cloudflare Images previews.
- Live host intake, guest-name search, optional gallery publication, and notes.
- 10,000 photos and 100 GiB per event by design.
- Complete exports containing every stored original in source-bounded 2 GiB ZIP parts plus a manifest.

## Local development

Requirements: Node.js 22+, npm 11+, and a Cloudflare account for browser-direct R2 and Images testing.

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

Run that command three times. Use separate values for `TOKEN_HMAC_KEY`, `SESSION_HMAC_KEY`, and `GUEST_TOKEN_ENCRYPTION_KEY`. Direct upload URLs also require an R2 API token in `.dev.vars`.

## Verification

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
npm run test:load:wedding
```

The load command is a dry run unless an operator supplies a dedicated rehearsal event and the explicit live confirmation described in [operations.md](docs/operations.md). Browser automation at 390 by 844 pixels supplements—but does not replace—physical iPhone Safari and Android Chrome acceptance.

## Architecture

- `src/` — React event drop, upload queue, secondary guest content, and host intake.
- `worker/` — Hono API, authorization, D1 repositories, private R2 storage, Images previews, exports, and cleanup.
- `migrations/` — D1 schema and state constraints.
- `shared/` — contracts, limits, and stable errors.
- `tests/` — unit, Worker integration, and real-browser coverage.
- `docs/superpowers/` — the approved wedding photo-drop design and implementation plan.

Deployment and rehearsal steps are in [deployment.md](docs/deployment.md). Operational limits and recovery are in [operations.md](docs/operations.md).

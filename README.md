# Candidary Core

Candidary is a private event-photo workflow built on React, Vite, Hono, Cloudflare Workers, D1, R2, and Workflows. A host creates one event, shares a guest link or QR code, moderates guest originals and notes, publishes an approved gallery, and prepares a private ZIP export.

## Local development

Requirements: Node.js 22+, npm 11+, and a Cloudflare account for browser-direct R2 upload testing.

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

Run that command three times. Use separate values for `TOKEN_HMAC_KEY`, `SESSION_HMAC_KEY`, and `GUEST_TOKEN_ENCRYPTION_KEY`. Direct upload URLs also require an R2 API token in `.dev.vars`; metadata, authentication, D1, and Worker tests run locally without contacting production resources.

## Verification

```powershell
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```

Worker integration tests use isolated local D1 and R2 bindings. The browser suite exercises both 1440 px desktop and 390 px mobile surfaces. The complete host → guest → moderation → gallery → ZIP lifecycle is covered in `tests/worker/core-journey.test.ts` against real Worker handlers and bindings.

## Architecture

- `src/` — React routes, upload orchestration, guest experience, and event manager.
- `worker/` — Hono API, auth/session enforcement, D1 repositories, private R2 delivery, export Workflow, and scheduled cleanup.
- `migrations/` — the D1 schema and state constraints.
- `shared/` — API contracts, fixed limits, and stable error codes.
- `tests/` — unit, Cloudflare Worker integration, and real-browser suites.
- `design/` — approved visual concepts, design system, and fidelity record.

Production prerequisites and exact commands are in [deployment.md](docs/deployment.md). Security invariants are in [security.md](docs/security.md), and lifecycle/runbook details are in [operations.md](docs/operations.md).

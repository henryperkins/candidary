# Deployment

Candidary has one routine release path: merge a protected pull request to `main`, then let
Cloudflare build once and deploy that exact output. There is no local candidate manifest, evidence
bundle, detached release worktree, staging-conformance ceremony, or second deployment build.

## Routine change

1. Open a pull request.
2. GitHub runs the six required checks in `.github/workflows/ci.yml`:
   `Quality`, `Unit and UI`, `Worker`, `Build`, `Smoke`, and `Migration safety`.
   `Build` creates the artifact once; `Smoke` downloads that artifact and serves it without rebuilding.
3. Merge after the required checks pass.
4. Cloudflare Workers Builds runs the production build command once and deploys the generated
   `dist/candidary/wrangler.json` artifact.
5. Confirm the deployed version tag equals the merged commit and perform a lightweight live check.

The local equivalent is:

```powershell
npm run deploy
```

That command runs one Cloudflare build and then one Wrangler deployment. To deploy an artifact that
has already been built, use:

```powershell
npm run deploy:built
```

`deploy:built` refuses malformed commit SHAs, a non-`main` Workers build targeting production, a
missing or linked generated config, and a generated topology that does not match production. It does
not install dependencies, rebuild, run tests, create evidence, or apply migrations.

## Cloudflare Workers Builds commands

Configure the connected repository with these commands:

| Environment | Build command | Deploy command |
| --- | --- | --- |
| Production (`main`) | `npm run build:cloudflare && npm run verify:pwa-build` | `npm run deploy:built` |
| Non-production branches | `npm run build:cloudflare && npm run verify:pwa-build` | `npm run deploy:preview:built` |

Workers Builds supplies `WORKERS_CI_BRANCH` and `WORKERS_CI_COMMIT_SHA`. The build script selects
`env.preview` for any branch other than `main`; both targets intentionally write
`dist/candidary/wrangler.json`, and the deploy script validates the generated Worker's exact name and
resource topology before upload.

Use two Builds triggers against the same repository connection: the `main` trigger belongs to the
`candidary` Worker, and the non-production trigger belongs to the `candidary-preview` Worker. Do not
attach the non-production trigger to `candidary`; connected Builds override a mismatched generated
Worker name with the trigger owner's name, which would defeat preview isolation.

Production remains the only environment with custom domains, Cron triggers, and an email binding.
Production bindings are:

- D1: `candidary-core`
- R2: `candidary-media` and `candidary-media-canonical-v2`
- Workflows: `candidary-export`, `candidary-cover-render`, and `candidary-cover-backfill`
- Origins: `https://candidary.app` and `https://candidary.online`

## Branch previews

Every non-`main` branch uploads a version of `candidary-preview` with a sanitized Workers preview
alias. Preview URLs are public development URLs, but they contain no production data and cannot send
email or run scheduled jobs.

The preview environment has independent resources:

- D1: `candidary-preview-core`
- R2: `candidary-preview-media` and `candidary-preview-media-canonical`
- Workflows: `candidary-preview-export`, `candidary-preview-cover-render`, and
  `candidary-preview-cover-backfill`
- Root URL: `https://candidary-preview.lfd.workers.dev`
- Alias family: `https://<branch-alias>-candidary-preview.lfd.workers.dev`

Preview secrets must be generated independently. Never copy persisted-data keys from production.
The required secret names are:

- `TOKEN_HMAC_KEY`
- `SESSION_HMAC_KEY`
- `GUEST_TOKEN_ENCRYPTION_KEY`
- `LOGIN_HMAC_KEY`
- `ENTRY_HMAC_KEY`
- `ENTRY_ENCRYPTION_KEY`
- `RSVP_LOOKUP_HMAC_KEY`
- `GUEST_MESSAGE_HMAC_KEY`

The preview config deliberately has no `EMAIL` binding and an empty Cron list. `EmailService` returns
`E_DISABLED` in that environment rather than attempting delivery.

## Required CI and non-blocking coverage

The pull-request checks are deliberately bounded:

- `Quality`: production dependency audit, binding drift, E2E TypeScript, and lint.
- `Unit and UI`: the jsdom unit/UI suite.
- `Worker`: the workerd integration suite.
- `Build`: TypeScript plus one Vite build, PWA artifact verification, and a Wrangler dry run.
- `Smoke`: one browser check against the downloaded build artifact.
- `Migration safety`: exits after change detection for ordinary changes. It installs dependencies and
  creates a fresh local D1 only when migrations, `wrangler.jsonc`, or the migration verifier changes.

The full Playwright matrix runs nightly and on manual dispatch through
`.github/workflows/full-e2e.yml`. It remains available locally as `npm run test:e2e`, but it does not
block a simple source or CSS change.

## Database migrations

An ordinary release never runs a D1 migration command. When a pull request changes `migrations/`, the
required migration-safety job applies the complete checked-in sequence to a disposable local D1 and
checks its terminal invariants.

Remote production migration is a separate, explicit operation because it changes durable data:

```powershell
npx wrangler d1 migrations list candidary-core --remote
npx wrangler d1 migrations apply candidary-core --remote
```

Review the exact pending filenames before applying them. Do not rotate persisted-data HMAC or
encryption keys as part of an ordinary release. The preview database uses `--env preview` and must be
migrated independently.

## Rollback

Each deployment is tagged with its full Git commit SHA. Record the previous production version ID
before a deployment. If the lightweight live check fails, use Wrangler's deployment/version commands
to restore that previous version, then verify both production origins. A rollback changes Worker code;
it does not reverse a D1 migration or delete data.

Do not manufacture local evidence to justify a rollback or a deployment. The authoritative facts are
the merged Git commit, required GitHub checks, Cloudflare build result, deployed version/tag, remote
migration ledger when relevant, and the observed live response.

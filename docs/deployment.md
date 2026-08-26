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

The first release that admits migration 0020 trash or `attempt-v2` writes is the sole exception to
steps 3–5. Migration 0020 starts in `legacy-open`; its D1 triggers keep the old protocol usable until
the release owner deliberately closes it. The procedure under **0020 admission exception** cuts over
preview first, then proves the frozen production Worker, drains the old daily Cron and active legacy
exports, atomically closes legacy admission, deploys one new exact-SHA Worker version and all three
Workflow implementations together, and only then opens v2 admission once.

The GitHub workflow is pull-request-only. Merging does not rerun its six jobs or create a duplicate
post-merge build; the Cloudflare `main` trigger owns the one production build and deployment.

The local equivalent is:

```powershell
npm run deploy
```

That command runs one Cloudflare build and then one Wrangler deployment. To deploy an artifact that
has already been built, use:

```powershell
npm run deploy:built
```

`deploy:built` refuses malformed or mismatched commit SHAs, missing or contradictory branch identity,
a dirty or non-`main` production checkout, a missing or linked generated config, and any generated
topology that does not exactly match the requested production or preview resources. It does not
install dependencies, rebuild, run tests, create evidence, or apply migrations.

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

Wrangler 4.123.0 may emit a false non-inheritance diagnostic that names an `undefined` email binding
while resolving the preview environment. The pinned schema requires the email binding's `name`, and
the release invariant is the generated topology: production must contain
`send_email: [{ name: 'EMAIL' }]`; preview must contain `send_email: []`. Config and deploy tests pin
both shapes. Do not add a fake preview binding or rename the schema-valid production field to silence
the diagnostic.

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
Both environments require these ten secret names:

- `TOKEN_HMAC_KEY`
- `SESSION_HMAC_KEY`
- `GUEST_TOKEN_ENCRYPTION_KEY`
- `LOGIN_HMAC_KEY`
- `ENTRY_HMAC_KEY`
- `ENTRY_ENCRYPTION_KEY`
- `RSVP_LOOKUP_HMAC_KEY`
- `GUEST_MESSAGE_HMAC_KEY`
- `ALBUM_SHARE_HMAC_KEY`
- `ALBUM_SHARE_ENCRYPTION_KEY`

For the album keys, generate a new pair for preview and pipe each value directly to Wrangler without
printing it. The HMAC key must contain at least 32 random bytes; the AES-256-GCM key must decode from
unpadded base64url to exactly 32 bytes:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_HMAC_KEY --env preview --config wrangler.jsonc
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_ENCRYPTION_KEY --env preview --config wrangler.jsonc
```

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

An ordinary release with no schema change never runs a D1 migration command. When a pull request
changes `migrations/`, the required migration-safety job applies the complete checked-in sequence to a
disposable local D1 and checks its terminal invariants. Cloudflare Workers Builds does **not** apply
remote D1 migrations; a successful automatic build is not schema provisioning.

For a migration-bearing release, preserve this order so new Worker code never runs against old
schema:

1. Inspect the preview pending ledger and stop if it contains an unexpected file.
2. Provision every required preview secret, including an independently generated album-share pair.
3. Apply the additive preview migrations and verify that no migration remains pending.
4. Publish and verify the exact reviewed branch preview.
5. Capture the current production Worker version, inspect the production pending ledger, provision
   the independently generated production album-share pair, apply the additive production migrations,
   and verify the ledger is empty. The old Worker must remain compatible with these additions.
6. Recheck the immutable PR head and hosted gates, then merge so the connected `main` build performs
   the one production code deployment.

For the first 0020-aware release, replace step 4 with the preview cutover below. Step 6 does not
deploy: the connected production Build must be upload-only before the exact merge, and the resulting
inert version is preflight evidence only. After the daily Cron and active legacy exports drain and D1
atomically closes legacy admission, the same clean exact-SHA artifact is deployed through the cutover
helper so Worker code and all three Workflow implementations advance together.

Preview ledger commands:

```bash
npx wrangler d1 migrations list candidary-preview-core --remote --env preview --config wrangler.jsonc
npx wrangler d1 migrations apply candidary-preview-core --remote --env preview --config wrangler.jsonc
npx wrangler d1 migrations list candidary-preview-core --remote --env preview --config wrangler.jsonc
```

Production provisioning and ledger commands use newly generated values, never the preview pair:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_HMAC_KEY --config wrangler.jsonc
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put ALBUM_SHARE_ENCRYPTION_KEY --config wrangler.jsonc
npx wrangler d1 migrations list candidary-core --remote --config wrangler.jsonc
npx wrangler d1 migrations apply candidary-core --remote --config wrangler.jsonc
npx wrangler d1 migrations list candidary-core --remote --config wrangler.jsonc
```

Review the exact pending filenames before every apply. Do not rotate existing persisted-data HMAC or
encryption keys merely to release application code. `npm run verify:bindings` proves required names in
the checked-in/generated configuration; it cannot prove that a remote secret contains usable material.

### 0020 admission exception

Migration 0019 and migration 0020 have different preconditions. Apply 0019 only after every running
export Workflow becomes terminal. Migration 0020 is compatible with a running legacy row: it preserves
that row as `legacy`, installs the v2 fence, and creates `export_protocol_admission` in the exact
`legacy-open` state. D1 admits an active `export_jobs` INSERT or a terminal-to-active Retry only when
its protocol matches the singleton: `legacy-open` admits `legacy`, `closed` admits neither protocol,
and `open` admits only `attempt-v2`. Existing admitted executions may still run to a terminal state.

The gate is necessary because an inert uploaded Worker version does not prove that the corresponding
Workflow implementations are active. A separate version promotion followed by `triggers deploy` cannot
establish that fact: `triggers deploy` applies routes/domains and Cron Triggers, not Workflow code. The
cutover therefore uses pinned `wrangler deploy` only after admission closes, so Worker code and all three
Workflow implementations advance from one verified generated config while neither protocol may start.
A single D1 statement may move `legacy-open` to `closed` only
when no legacy row is queued or running; serialization makes a racing old INSERT or Retry lose, or makes
the close lose and be retried after that visible job drains. Closing is one-way and is therefore the
export-availability point of no return. The candidate Worker returns safe 503 for complete creation,
Album creation, and terminal Retry while closed, before job mutation, Workflow dispatch, or artifact
deletion. The row may then move from closed to open exactly once with the active lowercase UUID Worker
version ID and canonical UTC timestamps; it cannot be inserted, replaced, deleted, reclosed, or
retargeted.

#### First 0020 preview cutover

Preview has no scheduled lifecycle trigger, but old preview HTTP and the preview Workflow must still
not straddle the protocol change. Keep preview resources isolated and perform this once before the
production admission:

1. Freeze every connected preview Build/upload and choose one reviewed non-`main` branch at one full
   Git SHA. Verify no preview upload is in flight and do not allow another branch to target
   `candidary-preview` until the cutover finishes.
2. Inspect the pending preview ledger, apply 0020, and require the singleton to be exactly
   `{ singleton: 1, state: "legacy-open", closed_at: null, worker_version_id: null, admitted_at: null }`.

```bash
npx wrangler d1 migrations list candidary-preview-core --remote --env preview --config wrangler.jsonc
npx wrangler d1 migrations apply candidary-preview-core --remote --env preview --config wrangler.jsonc
npx wrangler d1 migrations list candidary-preview-core --remote --env preview --config wrangler.jsonc
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json \
  --command "SELECT singleton, state, closed_at, worker_version_id, admitted_at FROM export_protocol_admission"
```

3. Build and upload that exact branch/SHA with the existing preview helper while the candidate is still
   inert and legacy remains admitted. `deploy:preview:built` creates a version and preview alias; it
   does **not** promote the shared `candidary-preview` Worker or update its Workflow definitions. Capture
   the printed preflight version ID only after the upload succeeds, validate it as a lowercase UUID,
   and verify that exact version's full-SHA tag before closing admission. Also describe all three
   preview Workflows and record each `Latest Version` ID as the pre-cutover baseline.

```bash
CANDIDARY_PREVIEW_RELEASE_SHA=<full-reviewed-git-sha>
CANDIDARY_PREVIEW_BRANCH=<exact-reviewed-non-main-branch>
git fetch --prune origin
git rev-parse HEAD
git status --porcelain --untracked-files=all
WORKERS_CI_BRANCH="$CANDIDARY_PREVIEW_BRANCH" \
WORKERS_CI_COMMIT_SHA="$CANDIDARY_PREVIEW_RELEASE_SHA" npm run build:cloudflare
npm run verify:pwa-build
WORKERS_CI_BRANCH="$CANDIDARY_PREVIEW_BRANCH" \
WORKERS_CI_COMMIT_SHA="$CANDIDARY_PREVIEW_RELEASE_SHA" npm run deploy:preview:built
CANDIDARY_PREVIEW_PREFLIGHT_VERSION_ID=<version-id-printed-by-preview-upload>
[[ "$CANDIDARY_PREVIEW_PREFLIGHT_VERSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 1
npx wrangler versions view "$CANDIDARY_PREVIEW_PREFLIGHT_VERSION_ID" \
  --config dist/candidary/wrangler.json --name candidary-preview --json
npx wrangler workflows describe candidary-preview-export --config dist/candidary/wrangler.json
npx wrangler workflows describe candidary-preview-cover-render --config dist/candidary/wrangler.json
npx wrangler workflows describe candidary-preview-cover-backfill --config dist/candidary/wrangler.json
```

`HEAD` must equal `CANDIDARY_PREVIEW_RELEASE_SHA`, Git status must be empty, and the viewed version tag
must equal that SHA. Do not substitute a later branch build.

4. Let every visible legacy queued/running export reach a terminal state. In one D1 statement, close
   only if the count remains zero; require exactly one changed row and read back the exact canonical
   `closed_at`. After this succeeds, a racing old active INSERT or Retry loses at D1 and the preview
   export-availability cutover can move only forward.

```bash
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json \
  --command "SELECT COUNT(*) AS active_legacy_exports FROM export_jobs WHERE execution_protocol = 'legacy' AND state IN ('queued', 'running')"
CANDIDARY_PREVIEW_CLOSED_AT="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json \
  --command "UPDATE export_protocol_admission SET state = 'closed', closed_at = '$CANDIDARY_PREVIEW_CLOSED_AT' WHERE singleton = 1 AND state = 'legacy-open' AND NOT EXISTS (SELECT 1 FROM export_jobs WHERE execution_protocol = 'legacy' AND state IN ('queued', 'running'))"
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json \
  --command "SELECT singleton, state, closed_at, worker_version_id, admitted_at FROM export_protocol_admission"
```

5. Prove the full generated preview config has exactly the intended preview Worker identity and three
   Workflows, with no `route`/`routes`, Cron, queue producer/consumer, event trigger, or address side
   effect. Only after that executable proof, run the existing helper's preview cutover mode from the
   same clean checkout and exact SHA. It uses pinned `wrangler deploy` with the full verified no-Cron
   preview config, creating a new active Worker version and advancing all three Workflow implementations
   together. Capture the new deployed version ID, then require one sole 100% active version with that ID
   and exact-SHA tag. Re-describe all three Workflows; every latest version ID must differ from its
   recorded pre-cutover ID, and the expected `candidary-preview` script/class mappings must remain.
   While admission is closed, verify the deployed preview returns safe 503 for a complete/Album create
   or terminal Retry rather than mutating a job or dispatching work.

```bash
node -e "const c=require('./dist/candidary/wrangler.json'); const q=c.queues??{}; const t=c.triggers??{}; const empty=(v)=>v===undefined||(Array.isArray(v)&&v.length===0); const ok=c.name==='candidary-preview'&&c.workers_dev===true&&c.preview_urls===true&&Array.isArray(c.workflows)&&c.workflows.length===3&&empty(c.route)&&empty(c.routes)&&empty(t.crons)&&empty(t.events)&&empty(q.producers)&&empty(q.consumers)&&empty(c.addresses); if(!ok) throw new Error('preview control-plane config has an unsafe side effect'); console.log({name:c.name,workers_dev:c.workers_dev,preview_urls:c.preview_urls,workflows:c.workflows,route:c.route,routes:c.routes,crons:t.crons,events:t.events,queues:q,addresses:c.addresses});"
WORKERS_CI_BRANCH="$CANDIDARY_PREVIEW_BRANCH" \
WORKERS_CI_COMMIT_SHA="$CANDIDARY_PREVIEW_RELEASE_SHA" npm run deploy:preview-cutover:built
CANDIDARY_PREVIEW_WORKER_VERSION_ID=<new-version-id-printed-by-preview-cutover-deploy>
[[ "$CANDIDARY_PREVIEW_WORKER_VERSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 1
npx wrangler deployments status --config dist/candidary/wrangler.json \
  --name candidary-preview --json
npx wrangler versions view "$CANDIDARY_PREVIEW_WORKER_VERSION_ID" \
  --config dist/candidary/wrangler.json --name candidary-preview --json
npx wrangler workflows describe candidary-preview-export --config dist/candidary/wrangler.json
npx wrangler workflows describe candidary-preview-cover-render --config dist/candidary/wrangler.json
npx wrangler workflows describe candidary-preview-cover-backfill --config dist/candidary/wrangler.json
```

The active ID must also differ from `CANDIDARY_PREVIEW_PREFLIGHT_VERSION_ID`; the upload remains
preflight evidence and is never the admitted version. Stop with admission closed unless the status,
tag, all three changed Workflow version IDs, mappings, and safe-503 checks agree.

6. Choose a canonical UTC millisecond timestamp, open the row once without changing `closed_at`, and
   read it back. Require exactly one changed row and the exact
   version/timestamps before unfreezing preview uploads.

```bash
CANDIDARY_PREVIEW_ADMITTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json \
  --command "UPDATE export_protocol_admission SET state = 'open', worker_version_id = '$CANDIDARY_PREVIEW_WORKER_VERSION_ID', admitted_at = '$CANDIDARY_PREVIEW_ADMITTED_AT' WHERE singleton = 1 AND state = 'closed'"
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json \
  --command "SELECT singleton, state, closed_at, worker_version_id, admitted_at FROM export_protocol_admission"
```

If the control-plane emptiness proof cannot be made, do not run the cutover deployment: keep admission
non-open and record hosted export conformance as unavailable. If any other post-close preview check
fails, keep admission closed and upload only an independently reviewed current forward fix through the
same frozen sequence. Never attempt to restore `legacy-open` or route an old preview Worker back onto
the database.

#### First 0020 production cutover

For the separately authorized production admission:

1. Record one release owner and UTC start. Freeze all production deployments and all `main` merges
   except the exact immutable reviewed release; verify no build/deployment is active.
2. Before applying 0020, capture production deployment status and view its sole 100% active version.
   Its tag must be the full frozen pre-0020 source revision
   `df2b66510ccee6893ca91ab752337df8e52c6207`. That is the code whose legacy SQL and callback prelude
   the cross-version tests freeze. Stop if the active version, traffic percentage, or tag differs;
   first freeze and independently review the actual deployed source instead of assuming compatibility.

```bash
npx wrangler deployments status --config wrangler.jsonc --name candidary --json
npx wrangler versions view <active-production-version-id> \
  --config wrangler.jsonc --name candidary --json
```

3. Change the connected production Build deploy command from `npm run deploy:built` to
   `npm run upload:production-version:built` and verify the saved setting. This command reuses the
   production SHA, clean-tree, branch, generated-config, and topology checks and may run only
   `wrangler versions upload`; it must not deploy traffic, edit triggers, or create a preview alias.
4. Apply and verify 0020 with the old Worker active. Require the remote singleton to be exactly
   `{ singleton: 1, state: "legacy-open", closed_at: null, worker_version_id: null, admitted_at: null }`.
   The old Worker remains fully admitted at this point. Merge only the reviewed full SHA while
   upload-only remains configured. Require the Build to report that exact SHA and capture its printed
   version ID.

```bash
npx wrangler d1 migrations apply candidary-core --remote --config wrangler.jsonc
npx wrangler d1 migrations list candidary-core --remote --config wrangler.jsonc
npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc --json \
  --command "SELECT singleton, state, closed_at, worker_version_id, admitted_at FROM export_protocol_admission"
```

5. From a clean `main` checkout whose `HEAD` and freshly fetched `origin/main` both equal the captured
   SHA, generate and verify the normal production artifact locally, then use the existing deploy helper
   to project the Cron-only and cutover configs. The Cron-only file contains only Worker identity fields.
   The cutover file must equal the complete verified production config except for exactly
   `triggers.crons: []`; it retains Worker code, routes, bindings, and all three Workflow definitions so
   a later full deploy advances them together without reattaching Cron. Capture each production
   Workflow's current `Latest Version` ID before detaching Cron.

```bash
CANDIDARY_RELEASE_SHA=<full-reviewed-git-sha>
CANDIDARY_PREFLIGHT_VERSION_ID=<version-id-printed-by-upload-only-build>
git fetch --prune origin
git rev-parse HEAD
git rev-parse origin/main
git status --porcelain --untracked-files=all
npm run build:cloudflare
npm run verify:pwa-build
npm run prepare:production-cutover-configs:built
node -e "const a=require('node:assert/strict'); const f=require('./dist/candidary/wrangler.json'); const c=require('./dist/candidary/wrangler.cutover.json'); a.deepStrictEqual(c,{...f,triggers:{...f.triggers,crons:[]}}); console.log({cutover:c.name,workflows:c.workflows,crons:c.triggers.crons});"
node -e "const c=require('./dist/candidary/wrangler.cron-only.json'); console.log(Object.keys(c).sort());"
npx wrangler versions view "$CANDIDARY_PREFLIGHT_VERSION_ID" \
  --config dist/candidary/wrangler.json --name candidary --json
npx wrangler workflows describe candidary-export --config dist/candidary/wrangler.json
npx wrangler workflows describe candidary-cover-render --config dist/candidary/wrangler.json
npx wrangler workflows describe candidary-cover-backfill --config dist/candidary/wrangler.json
npx wrangler triggers deploy --config dist/candidary/wrangler.cron-only.json --name candidary \
  --triggers '47 * * * *'
```

Both revisions must exactly equal `CANDIDARY_RELEASE_SHA`; status must be empty; the viewed version tag
must be that SHA. The printed Cron-only keys must be `name`, `compatibility_date`, `workers_dev`,
`preview_urls`, and optional `account_id`; both booleans must be false. The deep comparison must pass,
and every pre-cutover Workflow latest-version ID must be recorded. Stop on any mismatch. Record the successful
daily-Cron detach time, wait at least 30 minutes, and extend the drain through any old daily invocation
observed to finish later. This covers trigger propagation plus one possible invocation; an ordinary
Workflow drain or an assumed timer boundary does not.

6. After the daily Cron drain, let every legacy queued/running export reach a terminal state. Query the
   visible count, then atomically move `legacy-open` to `closed` only if the count is still zero. The
   trigger performs the same zero-active proof inside the statement, so a racing old INSERT or Retry
   either commits first and blocks the close or loses after it. Require exactly one changed row and the
   exact canonical `closed_at`. This close is one-way: export availability is now forward-fix-only, and
   old HTTP writes lose until the cutover deployment succeeds and v2 admission is opened.

```bash
npx wrangler d1 execute candidary-core --remote --config dist/candidary/wrangler.json --json \
  --command "SELECT COUNT(*) AS active_legacy_exports FROM export_jobs WHERE execution_protocol = 'legacy' AND state IN ('queued', 'running')"
CANDIDARY_CLOSED_AT="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
npx wrangler d1 execute candidary-core --remote --config dist/candidary/wrangler.json --json \
  --command "UPDATE export_protocol_admission SET state = 'closed', closed_at = '$CANDIDARY_CLOSED_AT' WHERE singleton = 1 AND state = 'legacy-open' AND NOT EXISTS (SELECT 1 FROM export_jobs WHERE execution_protocol = 'legacy' AND state IN ('queued', 'running'))"
npx wrangler d1 execute candidary-core --remote --config dist/candidary/wrangler.json --json \
  --command "SELECT singleton, state, closed_at, worker_version_id, admitted_at FROM export_protocol_admission"
```

7. Immediately run the existing helper's production cutover mode from the same clean `main` checkout,
   exact SHA, and full verified artifact. The helper regenerates
   `dist/candidary/wrangler.cutover.json`, proves the full production topology, and runs pinned
   `wrangler deploy --strict --tag <sha>` against it. This creates one new active Worker version and
   advances all three Workflow implementations together while leaving Cron detached. Capture the new
   Worker version ID, then prove it is the sole active version at 100%, has the exact release-SHA tag,
   and differs from the inert preflight version. Re-describe all three Workflows; each latest-version ID
   must differ from its recorded pre-cutover ID and retain the expected production script/class mapping.
   The new Worker must return safe 503 for creation/Retry while closed. This deployment remains the
   separate trash/data rollback point: possible trash writes now make a pre-0020 Worker forbidden even
   though v2 export admission is still closed.

```bash
WORKERS_CI_BRANCH=main WORKERS_CI_COMMIT_SHA="$CANDIDARY_RELEASE_SHA" \
  npm run deploy:production-cutover:built
CANDIDARY_WORKER_VERSION_ID=<new-version-id-printed-by-production-cutover-deploy>
[[ "$CANDIDARY_WORKER_VERSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 1
npx wrangler deployments status --config dist/candidary/wrangler.json \
  --name candidary --json
npx wrangler versions view "$CANDIDARY_WORKER_VERSION_ID" \
  --config dist/candidary/wrangler.cutover.json --name candidary --json
npx wrangler workflows describe candidary-export --config dist/candidary/wrangler.cutover.json
npx wrangler workflows describe candidary-cover-render --config dist/candidary/wrangler.cutover.json
npx wrangler workflows describe candidary-cover-backfill --config dist/candidary/wrangler.cutover.json
```

The status JSON must name one active version, exactly `CANDIDARY_WORKER_VERSION_ID`, at 100%; its tag
must equal `CANDIDARY_RELEASE_SHA`; it must differ from `CANDIDARY_PREFLIGHT_VERSION_ID`; and every
Workflow latest-version ID must be new. Otherwise keep admission closed and ship only a reviewed
forward fix.

8. Choose the exact current UTC millisecond timestamp, and open the D1 row once without changing the
   canonical `closed_at`. The trigger also
   refuses to open while any legacy row is queued or running and rejects every later update.
   Immediately read it back and require the exact version ID and both timestamps before restoring
   either Cron.

```bash
[[ "$CANDIDARY_WORKER_VERSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 1
CANDIDARY_ADMITTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
npx wrangler d1 execute candidary-core --remote --config dist/candidary/wrangler.json --json \
  --command "UPDATE export_protocol_admission SET state = 'open', worker_version_id = '$CANDIDARY_WORKER_VERSION_ID', admitted_at = '$CANDIDARY_ADMITTED_AT' WHERE singleton = 1 AND state = 'closed'"
npx wrangler d1 execute candidary-core --remote --config dist/candidary/wrangler.json --json \
  --command "SELECT singleton, state, closed_at, worker_version_id, admitted_at FROM export_protocol_admission"
```

9. Restore both Crons with the Cron-only config only after the open row is proved, then wait for the
   version-attributed daily cleanup proof.

```bash
npx wrangler triggers deploy --config dist/candidary/wrangler.cron-only.json --name candidary \
  --triggers '17 3 * * *' --triggers '47 * * * *'
npx wrangler tail candidary --config dist/candidary/wrangler.json --format json \
  --search cleanup_completed --version-id "$CANDIDARY_WORKER_VERSION_ID"
```

The UPDATE result must report exactly one changed row, and the SELECT must be exactly the one open row
with the captured values. Otherwise stop without reattaching. Keep both freezes through a later
successful `cleanup_completed` record whose `cleanupKind` is `daily-lifecycle`, `cron` is
`17 3 * * *`, timestamp is later than reattachment, and Worker version matches the active ID. Reject
the hourly `47 * * * *` record as gate evidence. Restore the connected command to
`npm run deploy:built` only after that proof; do not retry the already handled Build, and verify the
settings restoration itself created no build or deployment before unfreezing.

Cloudflare references: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/),
[build branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/),
[GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Worker limits](https://developers.cloudflare.com/workers/platform/limits/),
[versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/), and
[Workflows deployment](https://developers.cloudflare.com/workflows/get-started/guide/).

## Rollback

Each deployment is tagged with its full Git commit SHA. Record the previous production version ID
before a deployment. If the lightweight live check fails, use Wrangler's deployment/version commands
to restore that previous version, then verify both production origins. A rollback changes Worker code;
it does not reverse a D1 migration or delete data.

For the 0020 admission, closing `legacy-open` is already a one-way export-availability cutover: it
cannot be undone to make old export creation/Retry legal again. The cutover deployment remains the broader
trash/data rollback point because trash can be admitted immediately even while v2 export admission is
closed. After that deployment, a pre-0020 Worker is forbidden: keep the upload-only Build and release
freeze, merge only an independently reviewed current forward fix, verify its inert preflight
version/tag, then use the matching clean built artifact and gate-appropriate full config with
`wrangler deploy`. Require one new sole active exact-SHA Worker version and three changed latest
Workflow version IDs before proceeding. If the row is still closed, continue the original one-time
open and Cron restoration. If the row is already open, preserve it: deploy only
`attempt-v2`-compatible Worker/Workflow changes, never reclose or rerun admission, and repeat the
applicable version, Workflow, and daily-Cron evidence.

Do not manufacture local evidence to justify a rollback or a deployment. The authoritative facts are
the merged Git commit, required GitHub checks, Cloudflare build result, deployed version/tag, remote
migration ledger when relevant, and the observed live response.

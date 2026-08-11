# Event cover Phase 2 backfill runbook

This is the release-only operator procedure for converting pre-`0012` event covers. The launcher is
a planner: it reads saved Wrangler JSON and writes reviewable SQL/command artifacts. It never connects
to Cloudflare itself. D1 is authoritative; a generated Workflow command is usable only after its exact
claim has committed and been read back.

## 1. Authority boundaries and preconditions

This document grants no authorization. Keep these activities separate:

- Development may run the local dry-walk in the appendix. It uses disposable local D1, deterministic
  Images/Workflow fakes, and no Cloudflare resource.
- A Phase-2 candidate gate may verify one exact, clean commit locally. It does not authorize a remote
  migration, deployment, staging operation, or production backfill.
- A staging gate may deploy that exact candidate to separately identified staging resources and prove
  real Images, codec, and Workflow behavior. It does not authorize production data.
- A production gate may run the remote reads and mutations below only after candidate review and
  staging conformance both pass and production execution is explicitly approved.

Before production execution, require all of the following:

1. A retained `status = passed` candidate manifest and checksum sidecar validate the exact reviewed
   SHA, and a separately retained staging-conformance artifact names that same SHA, version ID/tag,
   resources, timestamps, real-platform results, and cleanup. This runbook and its local rehearsals
   produce neither artifact and mark neither gate passed.
2. Wrangler is exactly `4.113.0`, the worktree is clean at that reviewed 40-character SHA, and the
   deployed Worker tag is that SHA at 100% traffic.
3. The account, Worker `candidary`, D1 database `candidary-core` with ID
   `60bec5de-c8c7-41b5-a26b-2d3f7d184c71`, and Workflows `candidary-cover-render` and
   `candidary-cover-backfill` match the approved target.
4. Remote D1 has exactly the approved `0001` through `0013` migration set. `0013_guest_message_hardening.sql`
   arrived with the `main` integration and is unrelated to covers; the phase-3 invariants migration is
   `0014` and must still be absent. As of the integration, remote D1 is at `0010`, so `0011`, `0012`,
   and `0013` are all unapplied. Applying them, deploying a Worker, and running this backfill remain
   separate authorizations.
5. No other cover run is `inventorying` or `executing`, no event purge/fence backlog is unexplained,
   and a no-deploy window is owned for the later verification interval.
6. Phase 3 remains closed. A green Phase-2 proof permits only a later request to open a Phase-3
   candidate; it does not authorize `0014`, new cover routes, Cover Studio activation, or deployment.

## 2. Prove the target identities

Run from the exact candidate checkout. Every native command is fail-closed:

```powershell
$ErrorActionPreference = 'Stop'
$approvedAccountId = '<approved production account ID>'
if ($approvedAccountId -notmatch '^[0-9a-f]{32}$') {
  throw 'Approved account ID must be one 32-character lowercase ID.'
}
$wranglerConfig = Get-Content -Raw -LiteralPath 'wrangler.jsonc'
$configuredAccountIds = @([regex]::Matches(
  $wranglerConfig,
  '(?m)^[\t ]*"account_id"[\t ]*:[\t ]*"([^"]+)"'
) | ForEach-Object { $_.Groups[1].Value })
if ($configuredAccountIds.Count -gt 1 -or
    ($configuredAccountIds.Count -eq 1 -and $configuredAccountIds[0] -cne $approvedAccountId)) {
  throw 'wrangler.jsonc selects a different or ambiguous account.'
}
$env:CLOUDFLARE_ACCOUNT_ID = $approvedAccountId
if ($env:CLOUDFLARE_ACCOUNT_ID -cne $approvedAccountId) {
  throw 'The Wrangler shell is not pinned to the approved account.'
}
$candidateSha = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $candidateSha -notmatch '^[0-9a-f]{40}$') {
  throw 'Candidate SHA is not one full lowercase commit ID.'
}
$dirty = @(& git status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Candidate checkout is not clean.' }

$candidateManifestPath = '<absolute retained candidate-manifest.json path>'
$candidateSidecarPath = "$candidateManifestPath.sha256"
$candidateManifest = Get-Content -Raw -LiteralPath $candidateManifestPath | ConvertFrom-Json
if ($candidateManifest.status -ne 'passed' -or
    $candidateManifest.candidate.gitSha -ne $candidateSha) {
  throw 'Retained candidate manifest is not passed for this exact SHA.'
}
$manifestHash = (Get-FileHash -LiteralPath $candidateManifestPath -Algorithm SHA256).Hash.ToLower()
$expectedSidecar = "$manifestHash  candidate-manifest.json"
$actualSidecar = (Get-Content -Raw -LiteralPath $candidateSidecarPath).TrimEnd("`r", "`n")
if ($actualSidecar -ne $expectedSidecar) { throw 'Candidate checksum sidecar does not match.' }

$wranglerVersion = (& npx wrangler --version).Trim()
if ($LASTEXITCODE -ne 0 -or $wranglerVersion -ne '4.113.0') {
  throw "Expected Wrangler 4.113.0; found $wranglerVersion."
}

$whoamiJson = @(& npx wrangler whoami --json)
if ($LASTEXITCODE -ne 0) { throw 'Wrangler account identity failed.' }
$whoami = ($whoamiJson -join "`n") | ConvertFrom-Json
$approvedAccounts = @($whoami.accounts | Where-Object { $_.id -eq $approvedAccountId })
if ($whoami.loggedIn -ne $true -or $approvedAccounts.Count -ne 1) {
  throw 'Wrangler is not authenticated to exactly the approved account.'
}

$d1InfoJson = @(& npx wrangler d1 info candidary-core --config wrangler.jsonc --json)
if ($LASTEXITCODE -ne 0) { throw 'D1 identity read failed.' }
$d1Info = ($d1InfoJson -join "`n") | ConvertFrom-Json
if ($d1Info.name -ne 'candidary-core' -or
    $d1Info.uuid -ne '60bec5de-c8c7-41b5-a26b-2d3f7d184c71') {
  throw 'D1 database ID does not match the release-only launcher.'
}

npx wrangler workflows describe candidary-cover-render --config wrangler.jsonc
if ($LASTEXITCODE -ne 0) { throw 'Cover render Workflow identity failed.' }
npx wrangler workflows describe candidary-cover-backfill --config wrangler.jsonc
if ($LASTEXITCODE -ne 0) { throw 'Cover backfill Workflow identity failed.' }

$deploymentJson = @(& npx wrangler deployments status --name candidary --config wrangler.jsonc --json)
if ($LASTEXITCODE -ne 0) { throw 'Current Worker deployment read failed.' }
$deployment = ($deploymentJson -join "`n") | ConvertFrom-Json
$fullTraffic = @($deployment.versions | Where-Object { $_.percentage -eq 100 })
if ($fullTraffic.Count -ne 1 -or @($deployment.versions).Count -ne 1) {
  throw 'The Worker is not on one 100-percent version.'
}
$deployedVersionId = [string]$fullTraffic[0].version_id

$versionsJson = @(& npx wrangler versions list --name candidary --config wrangler.jsonc --json)
if ($LASTEXITCODE -ne 0) { throw 'Worker version list failed.' }
($versionsJson -join "`n") | ConvertFrom-Json | Out-Null
$versionJson = @(& npx wrangler versions view $deployedVersionId --name candidary --config wrangler.jsonc --json)
if ($LASTEXITCODE -ne 0) { throw 'Deployed Worker version read failed.' }
$version = ($versionJson -join "`n") | ConvertFrom-Json
if ($version.id -ne $deployedVersionId -or $version.annotations.'workers/tag' -ne $candidateSha) {
  throw 'The deployed Worker version/tag does not match the candidate SHA.'
}
$bindings = @($version.resources.bindings)
$bindingMap = @{}
foreach ($binding in $bindings) {
  $bindingName = [string]$binding.name
  if (-not $bindingName -or $bindingMap.ContainsKey($bindingName)) {
    throw 'Deployed version contains an unnamed or duplicate binding.'
  }
  $bindingMap[$bindingName] = $binding
}
$requiredBindings = @{
  DB = 'd1'
  MEDIA_BUCKET = 'r2_bucket'
  IMAGES = 'images'
  COVER_RENDER_WORKFLOW = 'workflow'
  COVER_BACKFILL_WORKFLOW = 'workflow'
  CF_VERSION_METADATA = 'version_metadata'
}
foreach ($required in $requiredBindings.GetEnumerator()) {
  if (-not $bindingMap.ContainsKey($required.Key) -or
      $bindingMap[$required.Key].type -ne $required.Value) {
    throw "Deployed binding $($required.Key) is absent or has the wrong type."
  }
}
$deployedD1Ids = @(
  @(
    [string]$bindingMap.DB.database_id
    [string]$bindingMap.DB.id
  ) | Where-Object { $_ -ne '' }
)
if ($deployedD1Ids.Count -lt 1 -or $deployedD1Ids.Count -gt 2 -or
    ($deployedD1Ids.Count -eq 2 -and $deployedD1Ids[0] -cne $deployedD1Ids[1]) -or
    $deployedD1Ids[0] -cne '60bec5de-c8c7-41b5-a26b-2d3f7d184c71' -or
    $bindingMap.MEDIA_BUCKET.bucket_name -ne 'candidary-media' -or
    $bindingMap.COVER_RENDER_WORKFLOW.workflow_name -ne 'candidary-cover-render' -or
    $bindingMap.COVER_BACKFILL_WORKFLOW.workflow_name -ne 'candidary-cover-backfill') {
  throw 'The deployed D1, R2, or Workflow binding target is not the approved topology.'
}
```

`versions view` proves the deployed version, its candidate tag, and the binding topology. At runtime
`CF_VERSION_METADATA` supplies the version ID, tag, and timestamp, but this application exposes no
operator endpoint that returns that binding. Direct runtime-binding behavior is staging-conformance
evidence, not something to infer from a production D1 row. The two human-readable Workflow
`describe` commands are supplementary; the parsed deployed bindings above are the machine check.

Prove the checked-in and applied migration names separately:

```powershell
$expectedMigrations = @(
  '0001_core.sql',
  '0002_wedding_photo_drop.sql',
  '0003_partitioned_exports.sql',
  '0004_manager_media_pagination.sql',
  '0005_media_stored_at.sql',
  '0006_host_accounts.sql',
  '0007_event_theme.sql',
  '0008_event_rsvp.sql',
  '0009_rsvp_roster_batches.sql',
  '0010_event_start.sql',
  '0011_release_certifications.sql',
  '0012_event_cover_storage.sql',
  '0013_guest_message_hardening.sql'
)
$localMigrations = @(Get-ChildItem migrations -Filter '*.sql' -File |
  Sort-Object Name | Select-Object -ExpandProperty Name)
$localMigrationMismatch = $localMigrations.Count -ne $expectedMigrations.Count
for ($index = 0; -not $localMigrationMismatch -and $index -lt $expectedMigrations.Count; $index++) {
  if ($localMigrations[$index] -cne $expectedMigrations[$index]) {
    $localMigrationMismatch = $true
  }
}
if ($localMigrationMismatch) {
  throw 'The checked-in migration set is not exactly 0001 through 0013.'
}

$migrationSql = 'SELECT name FROM d1_migrations ORDER BY id;'
$remoteMigrationJson = @(& npx wrangler d1 execute candidary-core --remote `
  --config wrangler.jsonc --json --command $migrationSql
)
if ($LASTEXITCODE -ne 0) { throw 'Remote migration-ledger read failed.' }
$migrationEnvelope = ($remoteMigrationJson -join "`n") | ConvertFrom-Json
$remoteMigrations = @($migrationEnvelope | ForEach-Object { $_.results } |
  ForEach-Object { $_.name })
$remoteMigrationMismatch = $remoteMigrations.Count -ne $expectedMigrations.Count
for ($index = 0; -not $remoteMigrationMismatch -and $index -lt $expectedMigrations.Count; $index++) {
  if ([string]$remoteMigrations[$index] -cne $expectedMigrations[$index]) {
    $remoteMigrationMismatch = $true
  }
}
if ($remoteMigrationMismatch) {
  throw 'Remote migration names do not exactly match the candidate set.'
}
```

Names in `d1_migrations` do not prove file bytes. The candidate review and manifest bind the checked-in
migration contents; a different SHA or migration digest is drift and a stop condition.

Immediately before **every** mutating D1 `--file` and every generated Workflow trigger/terminate,
rerun the account, D1, current-deployment/version/tag/binding, and remote-migration-ledger machine
checks in this section. Keep doing so through verification closure. Artifact identity steps contain
only `whoami` and D1 info; they do not replace the deployment/tag/binding/migration guards. Any drift
between units stops the operation.

## 3. Remote command grammar

Every D1 read uses this exact shape and checks its exit code:

```powershell
$sql = '<reviewed read-only SQL>'
$json = @(& npx wrangler d1 execute candidary-core --remote `
  --config wrangler.jsonc --json --command $sql
)
if ($LASTEXITCODE -ne 0) { throw 'Remote D1 read failed.' }
($json -join "`n") | ConvertFrom-Json | Out-Null
```

Every D1 mutation is a reviewed generated file, never pasted SQL:

```powershell
# First rerun every section-2 machine guard; drift stops this unit.
$sqlFile = '<absolute private path to the generated .sql file>'
npx wrangler d1 execute candidary-core --remote `
  --config wrangler.jsonc --json --file $sqlFile
if ($LASTEXITCODE -ne 0) { throw 'Remote D1 file unit failed.' }
```

D1 commands always carry `--remote --config wrangler.jsonc --json` and exactly one of `--command` or
`--file`. Generated Workflow trigger and terminate commands carry `--config wrangler.jsonc` and carry
neither `--remote` nor `--local`; Wrangler 4.113 does not accept `--remote` on them. Run Workflow
commands only from a validated artifact and never with `Invoke-Expression`.

## 4. Protect and delete private artifacts

Inventory payloads contain private R2 object keys. Plans contain exact production commands. Use a
new OS-temporary directory outside the checkout and grant only the current Windows identity access:

```powershell
$privateRoot = Join-Path ([IO.Path]::GetTempPath()) `
  ("candidary-cover-backfill-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $privateRoot | Out-Null
$operatorIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $privateRoot /inheritance:r /grant:r "${operatorIdentity}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Private artifact ACL could not be constrained.' }
```

The launcher also permits the ignored repository `output/` directory, but an ACL-constrained OS-temp
directory is preferred. Never put a raw payload, object key, claim, SQL file, or production command in
Git, a ticket, chat, release manifest, or tracked evidence.

Keep a page payload and its generated SQL until the SQL result is certain and a fresh run-state read
matches the artifact's cursor and rolling digest; then delete that page payload. Keep a dispatch claim
through its claimed read and launch, and keep each confirmation unit through its receipt. After final
closure, retain only sanitized run/version/timestamp/count evidence and remove the private directory:

```powershell
$resolvedPrivate = (Resolve-Path -LiteralPath $privateRoot).Path
$resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
if (-not $resolvedPrivate.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
    ([IO.Path]::GetFileName($resolvedPrivate) -notlike 'candidary-cover-backfill-*')) {
  throw 'Refusing to delete an unexpected path.'
}
Remove-Item -LiteralPath $resolvedPrivate -Recurse -Force
```

## 5. Inventory a new run and resume it truthfully

Use `execute` to create durable jobs; `inventory` is a read-only preview of the same page plan. The
page size is 100, ordering is by event ID, and an empty page is the only end-of-inventory marker.

Immediately before the first page, rerun all section-2 machine guards and prove there is no competing
run or unexplained purge/deletion-fence work. The inventory page header has no cross-run database
guard, so this read and its post-apply recheck are load-bearing:

```powershell
$readinessSql = @'
SELECT 'activeRuns' AS name, count(*) AS value FROM event_cover_backfill_runs
  WHERE status IN ('inventorying', 'executing')
UNION ALL SELECT 'purges', count(*) FROM event_cover_purge_progress
UNION ALL SELECT 'unsettledDeletionBlockedFences', count(*) FROM event_cover_workflow_fences f
  WHERE f.state = 'deletion-blocked' AND (
    EXISTS (SELECT 1 FROM events e WHERE e.id = f.event_id)
    OR EXISTS (SELECT 1 FROM event_cover_purge_progress p WHERE p.event_id = f.event_id)
  );
'@
$readinessJson = @(& npx wrangler d1 execute candidary-core --remote `
  --config wrangler.jsonc --json --command $readinessSql)
if ($LASTEXITCODE -ne 0) { throw 'Cover-operation readiness read failed.' }
$readinessEnvelope = ($readinessJson -join "`n") | ConvertFrom-Json
$readinessRows = @($readinessEnvelope | ForEach-Object { $_.results })
if ($readinessRows.Count -ne 3 -or
    @($readinessRows | Where-Object { $_.value -ne 0 }).Count -ne 0) {
  throw 'Another cover run, purge, or deletion-owned fence must be settled first.'
}
```

For the first page:

```powershell
$accountId = $approvedAccountId
$pageNumber = 1
$inventoryPayload = Join-Path $privateRoot "inventory-$pageNumber.json"
$inventoryPlan = Join-Path $privateRoot "inventory-$pageNumber.plan.json"
$inventorySql = @'
SELECT id, cover_object_key, cover_revision FROM events
WHERE cover_object_key IS NOT NULL AND cover_render_set_id IS NULL
  AND deleted_at IS NULL
ORDER BY id LIMIT 100;
'@
& npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc --json `
  --command $inventorySql | Set-Content -LiteralPath $inventoryPayload -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'First inventory read failed.' }

$env:CANDIDARY_COVER_BACKFILL_CONFIRM = '1'
npm run cover-backfill:execute -- --payload-file $inventoryPayload `
  --plan-file $inventoryPlan --account-id $accountId
if ($LASTEXITCODE -ne 0) { throw 'First inventory plan failed.' }
$pagePlan = Get-Content -Raw -LiteralPath $inventoryPlan | ConvertFrom-Json
$runId = [string]$pagePlan.runId
if ($runId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
  throw 'First inventory artifact did not provide one strict UUID run ID.'
}
if ($pagePlan.steps.kind -join ',' -ne 'identity-check,identity-check,ledger,run-state-read') {
  throw 'Inventory artifact order is not the reviewed protocol.'
}
$inventorySqlFile = [IO.Path]::ChangeExtension($inventoryPlan, '.sql')
# Rerun every section-2 machine guard immediately before this file.
npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc --json `
  --file $inventorySqlFile
if ($LASTEXITCODE -ne 0) { throw 'First inventory ledger unit failed.' }

$activeRunSql = "SELECT id, mode, status FROM event_cover_backfill_runs " +
  "WHERE status IN ('inventorying', 'executing') ORDER BY id;"
$activeRunJson = @(& npx wrangler d1 execute candidary-core --remote `
  --config wrangler.jsonc --json --command $activeRunSql)
if ($LASTEXITCODE -ne 0) { throw 'Post-inventory active-run read failed.' }
$activeRunEnvelope = ($activeRunJson -join "`n") | ConvertFrom-Json
$activeRunRows = @($activeRunEnvelope | ForEach-Object { $_.results })
$expectedRunMode = if ($pagePlan.inventoryExhausted) { 'execute' } else { 'inventory' }
$expectedRunStatus = if ($pagePlan.inventoryExhausted) { 'executing' } else { 'inventorying' }
if ($activeRunRows.Count -ne 1 -or $activeRunRows[0].id -ne $runId -or
    $activeRunRows[0].mode -ne $expectedRunMode -or
    $activeRunRows[0].status -ne $expectedRunStatus) {
  throw 'First page did not leave this run as the unique active run.'
}
```

Run that same `$activeRunSql` check immediately before and after every later inventory D1 file and
require this run to remain the unique active row. A retained `deletion-blocked` fence whose event and
purge-progress row are both gone is terminal proof kept for its 31-day lifetime, not a backlog.

Read the durable state after every page; do not infer it from a prior terminal:

```powershell
$runStatePayload = Join-Path $privateRoot "run-state-$pageNumber.json"
$runStateSql = "SELECT 'run' AS kind, id AS run_id, mode, status, cursor, inventory_sha256 " +
  "FROM event_cover_backfill_runs WHERE id = '$runId';"
& npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc --json `
  --command $runStateSql | Set-Content -LiteralPath $runStatePayload -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Run-state read failed.' }
```

Require one state row and require its cursor and `inventory_sha256` to equal the applied plan. For
each later page, validate the saved cursor as a UUID, query `id > '<durable cursor>' ORDER BY id LIMIT
100`, and generate the next file with the exact durable state:

```powershell
$pageNumber += 1
$inventoryPayload = Join-Path $privateRoot "inventory-$pageNumber.json"
$inventoryPlan = Join-Path $privateRoot "inventory-$pageNumber.plan.json"
$durableState = Get-Content -Raw -LiteralPath $runStatePayload | ConvertFrom-Json
$stateRow = @($durableState | ForEach-Object { $_.results })
if ($stateRow.Count -ne 1 -or $stateRow[0].run_id -ne $runId -or
    $stateRow[0].cursor -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
  throw 'Durable run state is missing or invalid.'
}
$cursor = [string]$stateRow[0].cursor
$inventorySql = "SELECT id, cover_object_key, cover_revision FROM events " +
  "WHERE cover_object_key IS NOT NULL AND cover_render_set_id IS NULL " +
  "AND deleted_at IS NULL AND id > '$cursor' ORDER BY id LIMIT 100;"
& npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc --json `
  --command $inventorySql | Set-Content -LiteralPath $inventoryPayload -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Inventory continuation read failed.' }

npm run cover-backfill:execute -- --run-id $runId --run-state-file $runStatePayload `
  --payload-file $inventoryPayload --plan-file $inventoryPlan --account-id $accountId
if ($LASTEXITCODE -ne 0) { throw 'Inventory continuation plan failed.' }
```

Rerun every section-2 machine guard, apply the generated `.sql`, save a fresh state, and repeat. The
rolling digest must change after each nonempty accepted page. On the first empty page, the artifact keeps the prior cursor/digest and sets
`inventoryExhausted: true`; applying it atomically changes the run to `mode = 'execute'`,
`status = 'executing'`, and recounts its jobs. Require that exact state before dispatch.

After any interruption, start with a fresh run-state read. If a D1 file's shell result was uncertain,
reapply that exact saved file and re-read state; the guards make the file replay-safe. Do not rebuild
the same page with new job IDs, guess a cursor, chain a digest locally, or append to a closed run.

## 6. Dispatch in durable one-minute units

Only one active run may dispatch. Repeat this bounded sequence until a fresh dispatch read reports no
eligible row:

1. Run `npm run cover-backfill:dispatch -- --run-id <run-id>` without a payload. It prints the exact
   remote D1 JSON read. Run that PowerShell command and save its JSON under `$privateRoot`.
2. With a fresh UTC `--now`, set `CANDIDARY_COVER_BACKFILL_CONFIRM=1` and run
   `npm run cover-backfill:dispatch -- --run-id <run-id> --payload-file <saved-read.json>
   --plan-file <claim.json> --account-id <account-id> --now <instant>`.
3. Require artifact order `identity-check`, `identity-check`, `claim`, `claimed-read` and require the
   claim artifact to contain no `workflows trigger`. It claims at most 25 rows and records its
   `notBefore`, in-flight, rolling-minute, active-run, and fence decisions from the saved D1 read.
4. Rerun every section-2 machine guard, then re-run the artifact's supplementary identity checks,
   apply the generated claim `.sql` as one D1 `--file` unit, and execute its exact `claimed-read` D1
   command. Save the JSON at `savePayloadAs`. Every proposed candidate must appear exactly once as
   accepted or explicitly refused.
5. At or after `notBefore`, run
   `npm run cover-backfill:launch -- --run-id <run-id> --claim-file <claim.json>
   --payload-file <claimed-read.json> --plan-file <launch.json> --account-id <account-id>
   --now <instant>`. Before `notBefore` the launcher refuses. A missing, duplicate, foreign, wrong-run,
   wrong-generation, wrong-fence, or internally inconsistent row voids the whole launch.
6. Require two identity checks followed, for each accepted candidate, by exactly `trigger`,
   `confirm-read`, `receipt-read`. Workflow commands have `--config wrangler.jsonc` and neither
   locality flag. Immediately before each trigger, rerun every section-2 machine guard. Execute one
   candidate's trigger, save its confirm read, and run the artifact's `confirmWith` command with that
   payload plus a private `--plan-file`, `--account-id`, and fresh `--now`.
7. Inspect the confirmation artifact. It contains two identity checks, an optional generated
   `terminate` only when deletion owns the fence, one D1 `apply`, and one `receipt-read`. Execute in
   that order, rerunning every section-2 machine guard immediately before the terminate (if present)
   and again before the D1 file. For deletion ownership, require artifact `outcome = blocked`, exactly
   one generated terminate, and reviewed SQL containing the generation/fence-guarded
   `failure_code = 'EVENT_DELETED'` settlement. Its receipt cannot display `failure_code`; require the
   expected job/event/instance/generation plus `dispatch_state = blocked`, `status = failed`, and
   `fence_state = deletion-blocked`. Otherwise require the expected confirmed claim. Reapplying
   confirmation SQL is a no-op.
8. Start no second batch inside the rolling minute or while 25 jobs are in flight. Wait for durable
   progress, then perform a completely fresh dispatch read. The launcher creates zero rows when
   another run is active or any limit has no capacity.

If a claim or confirmation D1 result is uncertain, replay the exact saved SQL file and its exact
read. If a Workflow trigger or terminate result is uncertain, do **not** issue it again: stop that
unit and let Worker stale-create recovery/reconciliation settle the stored ID and fence. Never invent
a replacement ID.

## 7. Recovery belongs to the Worker

Operators never run raw `wrangler workflows instances resume` or `restart`. Those commands would move
the platform without atomically moving the D1 generation and fence. The daily Worker pass owns this
order: superseded-job resolution, stale initial-create recovery, platform reconciliation, atomic run
closure, cover expiry, then event-purge coordination.

A `creating` claim older than two minutes is replayed by `createBatch` with the same deterministic ID;
the Worker confirms it whether the first create was lost or already materialized. Reconciliation may
resume a paused instance or restart a retryable errored instance inside 24 hours, always through
guarded D1 generation/fence claims. `CERTIFIED_NOT_FOUND_MATCHERS` remains deliberately empty because
the live Task 11 probe confirmed that absent and invalid IDs expose no stable non-message distinction.
A lookup exception therefore remains `unknown`; after the exact recovery claim and all restoration
guards succeed, the Worker replays only its stored deterministic ID with idempotent `createBatch`.
The platform skips a retained ID, creates an absent ID, and rejects an invalid ID without allocating a
competitor. A successful instance status of `unknown` or an unmapped future status still changes
nothing. Every non-null platform observation emits only a structured
`cover_platform_observation` with fixed `source` and low-cardinality `code` fields; raw status/error
text, Workflow IDs, and object keys are never logged. This diagnostic event does not authorize a
mutation. Operators may run a generated trigger or generated deletion-owned terminate unit; they may
not improvise platform lifecycle commands.

## 8. Observe bounded cleanup from D1 JSON

The candidate does not emit structured cover-cleanup summary logs and exposes no cleanup operator
route. The summary objects returned inside `scheduledCleanup` are not logged. Observe only durable D1
state with `--json`; do not scrape human Wrangler tables or invent metrics.

Save these aggregate snapshots before and after a daily `17 3 * * *` pass:

```powershell
$runSql = "SELECT id, mode, status, cursor, inventory_sha256, total_count, queued_count, " +
  "applied_count, skipped_count, resolved_count, failed_count, needs_replacement_count, " +
  "created_at, updated_at, verified_at, expires_at FROM event_cover_backfill_runs " +
  "WHERE id = '$runId';"
$runJson = & npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc `
  --json --command $runSql
if ($LASTEXITCODE -ne 0) { throw 'Backfill run observation failed.' }

$jobsSql = "SELECT status, dispatch_state, retryable, count(*) AS value, " +
  "min(updated_at) AS oldest_updated_at, max(updated_at) AS newest_updated_at " +
  "FROM event_cover_backfill_jobs WHERE run_id = '$runId' " +
  "GROUP BY status, dispatch_state, retryable ORDER BY status, dispatch_state, retryable;"
$jobsJson = & npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc `
  --json --command $jobsSql
if ($LASTEXITCODE -ne 0) { throw 'Backfill job observation failed.' }

$fenceSql = "SELECT coalesce(f.state, 'missing') AS fence_state, j.dispatch_state, j.status, " +
  "count(*) AS value, sum(CASE WHEN f.workflow_instance_id IS NULL THEN 0 " +
  "WHEN f.dispatch_generation IS j.dispatch_generation THEN 0 ELSE 1 END) " +
  "AS generation_mismatches FROM event_cover_backfill_jobs j LEFT JOIN " +
  "event_cover_workflow_fences f ON f.workflow_binding = 'COVER_BACKFILL_WORKFLOW' " +
  "AND f.workflow_instance_id = j.workflow_instance_id AND f.event_id = j.event_id " +
  "WHERE j.run_id = '$runId' GROUP BY fence_state, j.dispatch_state, j.status " +
  "ORDER BY fence_state, j.dispatch_state, j.status;"
$fenceJson = & npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc `
  --json --command $fenceSql
if ($LASTEXITCODE -ne 0) { throw 'Backfill fence observation failed.' }

$purgeSql = "SELECT phase, count(*) AS events, sum(fences_resolved) AS fences_resolved, " +
  "sum(platform_mutations) AS platform_mutations, min(updated_at) AS oldest_updated_at, " +
  "max(updated_at) AS newest_updated_at FROM event_cover_purge_progress GROUP BY phase ORDER BY phase;"
$purgeJson = & npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc `
  --json --command $purgeSql
if ($LASTEXITCODE -ne 0) { throw 'Cover purge observation failed.' }
```

Backfill selection and each cover-cleanup class are bounded at 100 rows. Dispatch is bounded at 25
in flight and 25 claims per rolling minute. One event-purge pass inspects at most 10 fences and makes
at most five platform mutations. Hitting a bound is not proof of drainage; take a confirming snapshot
after a later pass. An unchanged row is not proof of `unknown`, because unknown deliberately has no
durable marker. Persistent purge/fence state or a platform status that cannot be classified is a stop
for engineering investigation, not permission to edit D1.

## 9. `needs_replacement` requires the host

`needs_replacement` means the exact current legacy source cannot produce a conforming cover. An
operator cannot waive it, mark it resolved, change its fingerprint, or choose another object. Only
the host replacing or removing that same cover through the product changes the source fact; the next
bounded Worker resolver then compare-and-swaps the job to `resolved`. Revision movement alone does not
clear it. While the same fingerprint remains current, the job and global proof stay red.

Observe the count without selecting private keys:

```powershell
$replacementSql = "SELECT count(*) AS value FROM event_cover_backfill_jobs j JOIN events e " +
  "ON e.id = j.event_id WHERE j.status = 'needs_replacement' AND e.deleted_at IS NULL " +
  "AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL;"
$replacementJson = & npx wrangler d1 execute candidary-core --remote `
  --config wrangler.jsonc --json --command $replacementSql
if ($LASTEXITCODE -ne 0) { throw 'needs_replacement observation failed.' }
```

## 10. Create and correlate the verification run

Begin the approved no-deploy window and record its owner and UTC start. Save private before-snapshots
of `deployments status`, `versions list`, and `versions view` from section 2. Require one 100% version
whose ID and `workers/tag` equal the candidate evidence.

Run the canonical four-count query directly:

```powershell
$proofSql = @'
SELECT 'legacyRows' AS name, count(*) AS value FROM events e
  WHERE e.deleted_at IS NULL AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL
UNION ALL SELECT 'blockingJobs' AS name, count(*) AS value FROM event_cover_backfill_jobs j
  JOIN events e ON e.id = j.event_id
  WHERE j.status IN ('needs_replacement', 'failed') AND e.deleted_at IS NULL
    AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL
UNION ALL SELECT 'incompleteActiveSets' AS name, count(*) AS value FROM event_cover_render_sets s
  WHERE s.state = 'active' AND (
    s.manifest_sha256 IS NULL
    OR s.required_slots <> (SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id)
    OR s.required_slots <> (SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id AND o.event_id = s.event_id)
  )
UNION ALL SELECT 'uploadsWithoutActiveSet' AS name, count(*) AS value FROM events e
  WHERE e.deleted_at IS NULL AND json_extract(e.cover_config, '$.source.kind') = 'upload'
    AND (e.cover_object_key IS NULL OR NOT EXISTS (
      SELECT 1 FROM event_cover_render_sets s JOIN event_cover_masters m ON m.id = s.master_id
      WHERE s.id = e.cover_render_set_id AND s.event_id = e.id AND s.state = 'active'
        AND m.event_id = e.id AND m.object_key = e.cover_object_key
    ));
'@
$proofPayload = Join-Path $privateRoot 'zero-legacy-proof.json'
& npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc --json `
  --command $proofSql | Set-Content -LiteralPath $proofPayload -Encoding utf8
if ($LASTEXITCODE -ne 0) { throw 'Zero-legacy proof read failed.' }
npm run cover-backfill:verify -- --payload-file $proofPayload
if ($LASTEXITCODE -ne 0) { throw 'The displayed zero-legacy proof is red or malformed.' }
```

The saved payload is display evidence only. It cannot set `verified_at`. Open a new verification run
by saving the launcher's exact `mode = 'verify', status = 'executing'` INSERT privately:

```powershell
$verificationRunId = [guid]::NewGuid().ToString()
$verificationNow = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$env:CANDIDARY_COVER_BACKFILL_CONFIRM = '1'
$verificationOutput = @(& npm run cover-backfill:verify -- --payload-file $proofPayload `
  --run-id $verificationRunId --now $verificationNow)
if ($LASTEXITCODE -ne 0) { throw 'Verification-run plan failed.' }
$verificationStatement = @($verificationOutput | Where-Object {
  $_ -match '^\s*INSERT INTO event_cover_backfill_runs '
})
$verificationText = $verificationOutput -join "`n"
if ($verificationStatement.Count -ne 1 -or
    $verificationText -match '(?i)\bUPDATE\b|\bverified_at\b' -or
    $verificationStatement[0] -notmatch "'verify', 'executing'") {
  throw 'Expected one executing verification-run INSERT and no closure statement.'
}
$verificationSqlFile = Join-Path $privateRoot 'verification-run.sql'
$verificationStatement[0].Trim() | Set-Content -LiteralPath $verificationSqlFile -Encoding utf8
# Rerun every section-2 machine guard immediately before this file.
npx wrangler d1 execute candidary-core --remote --config wrangler.jsonc --json `
  --file $verificationSqlFile
if ($LASTEXITCODE -ne 0) { throw 'Verification-run INSERT failed.' }
```

Rerun the same guards before each closure observation. Read the run and require `mode = verify`,
`status = executing`, and `verified_at = null`. Wait for the
next Worker cleanup pass; there is no operator closure route. Only the Worker's atomic statement may
change a closable run to `verified` while re-deriving all four zero predicates in that same statement.
It may instead close a genuinely closable red run as `failed`, or leave an ineligible run executing.
Never run an `UPDATE` against `status` or `verified_at`.

After closure, require `status = verified`, a non-null `verified_at`, and all four direct counts still
present and zero. Capture deployment/version JSON again, re-read the clean local SHA, and require the
same 100% deployed version ID and candidate tag for the entire no-deploy interval. Record the before
and after capture instants around `verified_at`.

`event_cover_backfill_runs` has no build-SHA or Worker-version column. Therefore this evidence is an
operational correlation established by the no-deploy window plus before/after version evidence; it is
not an intrinsic, cryptographic, or foreign-key association between `verified_at` and a SHA. Label it
accordingly. A deploy, version/tag change, changed candidate SHA, split traffic, or evidence gap voids
the correlation and is a stop.

## 11. Rollback and recovery boundary

When a legacy cover is converted or displaced, its original is inventoried in
`event_cover_retired_legacy_objects` with a seven-day `cleanup_after`. The bounded sweep deletes R2
first, verifies absence, and then removes the inventory row. This is a recovery window, not an
operator rollback command: this runbook defines no raw R2 copy or D1 restoration. If repair is needed,
stop dispatch, preserve sanitized run/job/receipt references, and obtain a separately reviewed repair
that updates object and relational state together before the seven days elapse.

After the recovery window, the original is not promised. Phase 3 remains closed throughout rollback
or recovery; neither a retained original nor a green proof authorizes Phase-3 work.

## 12. Stop conditions

Stop immediately, preserve private artifacts, and escalate without improvising when any of these is
true:

- account, Worker, D1 name/ID, Workflow name, `CF_VERSION_METADATA` binding, deployed version/tag, or
  100% traffic identity differs from section 2;
- the passed exact-SHA candidate manifest or checksum sidecar is absent, invalid, or unreviewed; or
  the staging-conformance artifact is absent or unreviewed, does not name the exact candidate and
  resources, or lacks real-platform evidence for the no-discriminator contract, retained-ID replay,
  failed-lookup idempotent materialization, and status-unknown preservation;
- Wrangler is not 4.113.0; the candidate is dirty, changed, or not the deployed tag; migration names,
  contents, count, or remote ledger drift;
- another run is active, a resumed cursor/digest/run ID disagrees, an artifact identity or ordered
  step differs, or a saved result is missing, duplicated, foreign, refused unexpectedly, or malformed;
- a production D1 command lacks `--remote --config wrangler.jsonc --json`, or a Workflow command has
  `--remote`/`--local`, is not generated, or attempts raw resume/restart;
- a shell leaves a Workflow trigger/terminate uncertain, a successful lookup returns `unknown`, or an
  instance cannot be classified as active, paused, errored, or complete; a failed lookup is handled
  only by the Worker-owned guarded idempotent-materialization path, never by an operator guess;
- a present fence generation mismatches, a deletion-owned fence does not settle through the expected
  generated `EVENT_DELETED` unit, purge progress or a fence backlog remains unexplained across a
  scheduled pass, or dispatch is at an active-run/in-flight/minute bound;
- a current `needs_replacement` remains, any of the four proof counts is missing, duplicated,
  negative, or nonzero, the verification run is failed or still executing, or Worker closure is not
  observed;
- the no-deploy window is violated, before/after deployment evidence differs, or `verified_at` cannot
  be bracketed by the same version/SHA evidence; or
- the private path/ACL cannot be proved or a raw object key/private payload may have escaped it.

## Appendix: local dry-walk only

The canonical dry-walks are the Task-7 tests. They create disposable migrated databases and never
authenticate or contact a remote resource:

```powershell
npx vitest run --config vitest.config.ts tests/unit/cover-backfill-operator-loop.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Operator-loop local D1 rehearsal failed.' }
npx vitest run --config vitest.worker.config.ts tests/worker/cover-backfill-rehearsal.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Populated Worker rehearsal failed.' }
```

The operator-loop test pins Wrangler 4.113.0, applies exactly `0001` through `0013` to a unique
`--local --persist-to` D1, runs inventory/claim/confirm/proof D1 equivalents, and proves a failing
claim file rolls back. The Worker rehearsal supplies deterministic Images and Workflow fakes. It
validates generated Workflow command strings and order only; it never executes a trigger, terminate,
resume, or restart command. A manual disposable D1 invocation may substitute `--local --persist-to
<unique-temp-directory>` for production D1's `--remote`; production Workflow artifacts retain only
`--config wrangler.jsonc` and are never executed during a local dry-walk.

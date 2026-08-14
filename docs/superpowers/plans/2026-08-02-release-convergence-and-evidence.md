# Release Convergence and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one reviewable Increment 1 candidate that preserves the complete date-driven guest lifecycle history, identifies its exact source and migration set at runtime, and emits a redacted, reproducible local release manifest without merging to `main`, pushing, migrating remotely, deploying, certifying, or beginning later reliability increments.

**Architecture:** Start an isolated feature worktree at the approved spec-bearing `main`, merge the exact lifecycle tip as a two-parent commit, and close its known browser-evidence debt. Add a fail-closed runtime identity composed of the clean build SHA, Cloudflare Worker Version Metadata, the checked-in guest-journey version, and a build-computed migration digest. Add an additive D1 certification contract with no remotely reachable writer. A Node 24 release runner creates its own detached temporary worktree at an explicitly supplied full SHA, runs every local gate sequentially, proves fresh-D1 and deploy-bundle behavior locally, and writes an allowlist-built manifest plus digest outside that worktree.

**Tech Stack:** TypeScript 6, Node.js 24 native type stripping, React 19, Hono 4, Vite 8 with `@cloudflare/vite-plugin` 1.46, Cloudflare Workers/Wrangler 4, D1/SQLite, Zod 4, Vitest/workerd, Playwright, Git worktrees, and SHA-256.

## Global Constraints

- Implement only Increment 1 from `docs/superpowers/specs/2026-08-02-support-free-event-reliability-design.md`: source convergence, runtime release identity, the aggregate local evidence gate, and the redacted certification contract.
- Do not implement event readiness, async-state/export polish, rehearsal state, pairing, synthetic RSVP/media, enrollment, pilot tracking, or legal-copy changes in this branch.
- Do not merge this feature branch into `main`, push any ref, apply a remote migration, execute remote SQL that writes, configure a binding, set a secret, deploy, create a certification row remotely, or enroll a real event. Those remain separate approvals.
- A two-parent merge of the lifecycle tip is allowed only inside the isolated Increment 1 feature branch. Do not cherry-pick, squash, rebase, or copy the lifecycle files piecemeal.
- Preserve the main checkout and its user-owned untracked files unchanged: `CandidaryDesignSystem.zip`, `candidaryhomepageredesign.patch`, `docs/superpowers/plans/2026-08-01-settings-autosave.md`, and this plan file.
- Never clean, stash, reset, remove, or overwrite unrelated work to satisfy a release check. The aggregate gate must create and remove only its own validated OS-temporary worktree.
- Write a failing focused test before each new behavior. Merge validation and visual-baseline recapture are evidence tasks rather than production behavior and are exempt from manufacturing a RED test.
- `verify:release` must require a full 40-character commit ID, run the implementation from that commit's own detached worktree, and fail if `HEAD`, the Git tree, or nonignored worktree status changes.
- The candidate gate is local-only. Every Wrangler D1 command inside it must carry `--local`; every deploy command must carry `--dry-run`; no command plan may contain `--remote`, `deploy` without `--dry-run`, `secret`, or binding-configuration mutations.
- Evidence is constructed from an allowlist. Never serialize process environments, stdout/stderr, test payloads, generated Wrangler configs, metafiles, `.env*`, `.dev.vars*`, hostnames, usernames, absolute paths, database/account/namespace IDs, resource names, variable values, credentials, guest data, URLs, filenames from guests, or free-form notes.
- Local success, branch integration, merge to `main`, remote migration, deployment, post-deploy observation, physical-device evidence, runtime certification, and wedding readiness remain distinct claims.
- Commit each independently testable task. Do not amend the final candidate after a passing release manifest; any correction creates a new SHA and requires a new complete run.

### Pinned planning state

The execution preflight must re-read these values and stop if any differ:

| Ref/fact | Reviewed value |
| --- | --- |
| `main` | `0b92387d2e237d568d2514373dcc3044e7960d4b` |
| `origin/main` | `c3eeb247a9dc917ad965b99d7d587d2d2d48863f` |
| local lifecycle tip | `cdbfe3438383c086530a750571fd1bb51b60d643` |
| remote lifecycle tip | `cdbfe3438383c086530a750571fd1bb51b60d643` |
| merge base | `2d6019278f050800d97f227595cd98a107a66710` |
| divergence before merge | three commits unique to `main`, four unique to lifecycle |
| reviewed merge result | zero Git conflicts; five semantic auto-merge seams |

Current Cloudflare contracts used by this plan are the official [Version Metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/), [Vite Worker-environment configuration](https://developers.cloudflare.com/workers/vite-plugin/reference/vite-environments/), [Vite output-config deployment model](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/), and [Wrangler deploy/dry-run flags](https://developers.cloudflare.com/workers/wrangler/commands/workers/).

---

### Task 1: Reconcile the lifecycle source in an isolated feature worktree

**Files:**
- Merge exactly: `cdbfe3438383c086530a750571fd1bb51b60d643`
- Add through that merge: `migrations/0010_event_start.sql`
- Add through that merge: `scripts/event-start-backfill.ts`
- Add through that merge: `worker/http/event-schedule.ts`
- Add through that merge: `src/features/guest/GuestBeforeStart.tsx`
- Add through that merge: `src/features/guest/GuestWaiting.tsx`
- Add through that merge: `src/features/guest/useLifecycleRecheck.ts`
- Add through that merge: `src/components/ManagerPhotoIntakePanel.tsx`
- Add through that merge: lifecycle unit, UI, Worker, E2E, spec, plan, and screenshot files carried by the four lifecycle commits
- Inspect semantic auto-merges in: `design-qa.md`
- Inspect semantic auto-merges in: `design/design-system.md`
- Inspect semantic auto-merges in: `src/styles.css`
- Inspect semantic auto-merges in: `tests/e2e/accessibility.spec.ts`
- Inspect semantic auto-merges in: `tests/ui/app.test.tsx`

**Interfaces:**
- Preserves: the four lifecycle commits `0f72aaa`, `7fca0fd`, `58218c0`, and `cdbfe343` as the second-parent history.
- Produces: a feature-branch merge commit whose first parent is the pinned spec-bearing `main` and whose second parent is `cdbfe343`.
- Establishes: `0010_event_start.sql` as the canonical migration immediately before Increment 1's new schema.

- [ ] **Step 1: Re-read refs and protect the caller checkout**

From the current main checkout, run:

```powershell
$expectedMain = '0b92387d2e237d568d2514373dcc3044e7960d4b'
$expectedOriginMain = 'c3eeb247a9dc917ad965b99d7d587d2d2d48863f'
$expectedLifecycle = 'cdbfe3438383c086530a750571fd1bb51b60d643'
$expectedBase = '2d6019278f050800d97f227595cd98a107a66710'

git fetch origin --prune
if ($LASTEXITCODE -ne 0) { throw 'Ref refresh failed.' }
git status --short --branch
git worktree list --porcelain

if ((git rev-parse main) -ne $expectedMain) { throw 'main drifted; re-plan before merging.' }
if ((git rev-parse origin/main) -ne $expectedOriginMain) { throw 'origin/main drifted; re-plan before merging.' }
if ((git rev-parse agent/date-driven-guest-phase) -ne $expectedLifecycle) { throw 'The local lifecycle tip drifted.' }
if ((git rev-parse origin/agent/date-driven-guest-phase) -ne $expectedLifecycle) { throw 'The remote lifecycle tip drifted.' }
if ((git merge-base main agent/date-driven-guest-phase) -ne $expectedBase) { throw 'The reviewed merge base changed.' }

$trackedStatus = git status --porcelain=v1 --untracked-files=no
if ($LASTEXITCODE -ne 0 -or $trackedStatus) { throw 'Tracked main-checkout work must be resolved by its owner first.' }

Get-FileHash -Algorithm SHA256 -LiteralPath @(
  'CandidaryDesignSystem.zip',
  'candidaryhomepageredesign.patch',
  'docs/superpowers/plans/2026-08-01-settings-autosave.md',
  'docs/superpowers/plans/2026-08-02-release-convergence-and-evidence.md'
)
```

Record the four hashes in the execution notes. Do not stage these files.

- [ ] **Step 2: Re-read production truth before integration**

This is a read-only preflight from the current checkout. Do not redirect raw responses into the repository or candidate evidence. Parse only the allowlisted fields below and stop if any assertion fails.

```powershell
$expectedLedger = @(
  '0001_core.sql',
  '0002_wedding_photo_drop.sql',
  '0003_partitioned_exports.sql',
  '0004_manager_media_pagination.sql',
  '0005_media_stored_at.sql',
  '0006_host_accounts.sql',
  '0007_event_theme.sql',
  '0008_event_rsvp.sql',
  '0009_rsvp_roster_batches.sql',
  '0010_event_start.sql'
)

$ledgerEnvelope = npx wrangler d1 execute candidary-core --remote --json --command "SELECT id, name FROM d1_migrations ORDER BY id"
if ($LASTEXITCODE -ne 0) { throw 'Remote migration-ledger read failed.' }
$ledgerJson = $ledgerEnvelope | ConvertFrom-Json
$actualLedger = @($ledgerJson[0].results | Sort-Object id | ForEach-Object name)
if ($actualLedger.Count -ne $expectedLedger.Count -or [string]::Join("`n", $actualLedger) -cne [string]::Join("`n", $expectedLedger)) { throw 'Remote migration ledger order differs from 0001-0010.' }

$foreignKeyJson = npx wrangler d1 execute candidary-core --remote --json --command "PRAGMA foreign_key_check" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or @($foreignKeyJson[0].results).Count -ne 0) { throw 'Remote foreign-key evidence is not clean.' }

$sentinelJson = npx wrangler d1 execute candidary-core --remote --json --command "SELECT COUNT(*) AS remaining FROM events WHERE deleted_at IS NULL AND event_start_at = '1970-01-01T00:00:00.000Z'" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or [int]$sentinelJson[0].results[0].remaining -ne 0) { throw 'Remote lifecycle backfill is incomplete.' }

$triggerJson = npx wrangler d1 execute candidary-core --remote --json --command "SELECT COUNT(*) AS remaining FROM sqlite_master WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'" | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or [int]$triggerJson[0].results[0].remaining -ne 0) { throw 'The remote schedule-freeze trigger still exists.' }

$deployment = npx wrangler deployments status --name candidary --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Production deployment read failed.' }
$activeVersions = @($deployment.versions | Where-Object { $_.percentage -gt 0 })
if ($activeVersions.Count -ne 1 -or [int]$activeVersions[0].percentage -ne 100) { throw 'Production is not serving one 100-percent Worker version.' }

$version = npx wrangler versions view $activeVersions[0].version_id --name candidary --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Production Worker-version read failed.' }
$expectedBindings = @(
  'assets:ASSETS', 'd1:DB', 'images:IMAGES', 'r2_bucket:MEDIA_BUCKET',
  'ratelimit:HOST_AUTH_RATE_LIMIT', 'ratelimit:RSVP_LOOKUP_RATE_LIMIT',
  'send_email:EMAIL', 'workflow:EXPORT_WORKFLOW',
  'plain_text:APP_ORIGIN', 'plain_text:EMAIL_FROM', 'plain_text:R2_ACCOUNT_ID',
  'plain_text:R2_BUCKET_NAME', 'secret_text:ENTRY_ENCRYPTION_KEY',
  'secret_text:ENTRY_HMAC_KEY', 'secret_text:GUEST_TOKEN_ENCRYPTION_KEY',
  'secret_text:LOGIN_HMAC_KEY', 'secret_text:R2_ACCESS_KEY_ID',
  'secret_text:R2_SECRET_ACCESS_KEY', 'secret_text:RSVP_LOOKUP_HMAC_KEY',
  'secret_text:SESSION_HMAC_KEY', 'secret_text:TOKEN_HMAC_KEY'
) | Sort-Object
$actualBindings = @($version.resources.bindings | ForEach-Object { "$($_.type):$($_.name)" } | Sort-Object)
if (Compare-Object $expectedBindings $actualBindings) { throw 'Production binding names or kinds drifted.' }
if (-not @($version.resources.script.handlers).Contains('fetch') -or -not @($version.resources.script.handlers).Contains('scheduled')) { throw 'Production Worker handlers drifted.' }
if (-not @($version.resources.script.named_handlers | Where-Object { $_.name -eq 'ExportWorkflow' })) { throw 'The production Export Workflow handler is missing.' }

$liveChecks = @(
  @{ Path = '/'; Status = 200; Type = 'text/html' },
  @{ Path = '/manifest.webmanifest'; Status = 200; Type = 'application/manifest+json' },
  @{ Path = '/icons/candidary-180.png'; Status = 200; Type = 'image/png' },
  @{ Path = '/privacy'; Status = 200; Type = 'text/html' },
  @{ Path = '/terms'; Status = 200; Type = 'text/html' },
  @{ Path = '/api/does-not-exist'; Status = 404; Type = 'application/json' }
)
foreach ($check in $liveChecks) {
  $response = Invoke-WebRequest -Uri ('https://candidary.online' + $check.Path) -Method Get -SkipHttpErrorCheck
  if ([int]$response.StatusCode -ne $check.Status) { throw "Unexpected live status for $($check.Path)." }
  if (($response.Headers['Content-Type'] -join ',') -notlike "$($check.Type)*") { throw "Unexpected live MIME for $($check.Path)." }
  if (($response.Headers['Strict-Transport-Security'] -join ',') -ne 'max-age=31536000; includeSubDomains') { throw "Missing live HSTS for $($check.Path)." }
  if (($response.Headers['X-Content-Type-Options'] -join ',') -ne 'nosniff') { throw "Missing live nosniff for $($check.Path)." }
  if (-not ($response.Headers['Content-Security-Policy'] -join ',')) { throw "Missing live CSP for $($check.Path)." }
  if (($response.Headers['Referrer-Policy'] -join ',') -ne 'no-referrer') { throw "Missing live referrer policy for $($check.Path)." }
  if (($response.Headers['Cross-Origin-Opener-Policy'] -join ',') -ne 'same-origin') { throw "Missing live opener policy for $($check.Path)." }
  if (($response.Headers['Permissions-Policy'] -join ',') -ne 'camera=(), microphone=(), geolocation=()') { throw "Missing live permissions policy for $($check.Path)." }
}
```

These reads establish the pre-integration snapshot only. They do not certify the later candidate or authorize a deploy.

- [ ] **Step 3: Create the implementation worktree through the required skill**

Invoke `superpowers:using-git-worktrees`. Create an isolated worktree and branch named `agent/release-convergence-evidence` from the literal commit `0b92387d2e237d568d2514373dcc3044e7960d4b`. Do not reuse the main checkout or an existing dirty worktree.

- [ ] **Step 4: Merge only the reviewed lifecycle tip**

Inside the new worktree:

```powershell
$expectedLifecycle = 'cdbfe3438383c086530a750571fd1bb51b60d643'
git merge --no-ff --no-commit $expectedLifecycle
if ($LASTEXITCODE -ne 0) { throw 'Unexpected merge conflict; abort and repeat the graph analysis.' }

git diff --name-only --diff-filter=U
git ls-files -u
git diff --cached --check
```

Expected: both conflict listings are empty and `git diff --cached --check` exits zero. If Git reports any conflict, run `git merge --abort`; do not improvise a resolution against a graph different from the one reviewed here.

- [ ] **Step 5: Inspect all five semantic merge seams**

Run:

```powershell
rg -n "Pending recapture|Awaiting verification — date-driven" design-qa.md
rg -n "ChevronDown|Guest before-start|Manager photo intake" design/design-system.md
rg -n "public-shell--landing|rsvp-flow--embedded" src/styles.css
rg -n "How it works|rsvpAccess|eventStartAt" tests/e2e/accessibility.spec.ts
rg -n "The short answers|offers a visible midnight|vi.useRealTimers" tests/ui/app.test.tsx
```

Confirm each file contains both sides of the reviewed result:

- `design-qa.md`: homepage recapture warning plus lifecycle evidence matrix;
- `design/design-system.md`: homepage navigation/FAQ rules plus before-start, waiting, and photo-intake rules;
- `src/styles.css`: homepage header/hero/FAQ/footer/legal selectors plus lifecycle RSVP/waiting selectors;
- `tests/e2e/accessibility.spec.ts`: landing tab order plus lifecycle fixture fields; and
- `tests/ui/app.test.tsx`: landing FAQ/footer/legal tests plus lifecycle timers, creation start time, and phase tests.

- [ ] **Step 6: Run minimum integration verification before committing**

```powershell
npm ci
npm run typecheck
npx vitest run --config vitest.config.ts tests/unit/event-time.test.ts tests/unit/event-start-backfill.test.ts tests/ui/guest-before-start.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0010.test.ts tests/worker/core-journey.test.ts
npx wrangler d1 migrations list candidary-core --remote
git add --all
git diff --cached --name-status
git diff --cached --check
$unstaged = git diff --name-only
$untracked = git ls-files --others --exclude-standard
if ($unstaged -or $untracked) { throw 'The verified merge result is not fully staged.' }
npm run typecheck
npx vitest run --config vitest.config.ts tests/unit/event-time.test.ts tests/unit/event-start-backfill.test.ts tests/ui/guest-before-start.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0010.test.ts tests/worker/core-journey.test.ts
```

Expected: install, typecheck, focused lifecycle tests, and staged diff hygiene pass; Wrangler reports no pending migration through `0010`. These commands make no remote write. If any check fails, keep the merge uncommitted, diagnose the integration, and add any required regression/fix as part of the merge result before continuing. Because this is a dedicated worktree with no caller artifacts, stage the entire intended merge result, inspect its name/status list, require no unstaged/untracked remainder, and rerun focused checks against that exact staged content before committing.

- [ ] **Step 7: Commit the provenance-preserving merge**

```powershell
git commit -m "merge: reconcile date-driven guest lifecycle"
git show --no-patch --pretty=format:"%H%n%P%n%s" HEAD
```

Expected: the commit has exactly two parents, in order: `0b92387d2e237d568d2514373dcc3044e7960d4b` then `cdbfe3438383c086530a750571fd1bb51b60d643`.

---

### Task 2: Close the converged browser-evidence debt

**Files:**
- Modify: `tests/e2e/visual-qa.spec.ts-snapshots/landing-first-fold-320-mobile-win32.png`
- Modify: `tests/e2e/visual-qa.spec.ts-snapshots/landing-workflow-780-mobile-win32.png`
- Preserve replacement from lifecycle merge: `tests/e2e/visual-qa.spec.ts-snapshots/rsvp-before-start-390-mobile-win32.png`
- Preserve deletion from lifecycle merge: `tests/e2e/visual-qa.spec.ts-snapshots/rsvp-closed-390-mobile-win32.png`
- Modify only to record evidence actually observed: `design-qa.md`
- Modify only to record evidence actually observed: `design/fidelity-ledger.md`

**Interfaces:**
- Produces: exact Windows snapshots for the current landing implementation and measured automated browser evidence for the merged lifecycle.
- Preserves: Playwright's zero-pixel and zero-threshold screenshot contract.
- Does not produce: physical-device, production, runtime-certification, or wedding-readiness evidence.

- [ ] **Step 1: Run focused non-visual lifecycle tests**

```powershell
npx vitest run --config vitest.config.ts tests/unit/event-time.test.ts tests/unit/event-start-backfill.test.ts tests/unit/rsvp.test.ts tests/unit/event-read-guard.test.ts tests/unit/event-settings-draft.test.ts tests/unit/manager-event-merge.test.ts tests/ui/app.test.tsx tests/ui/guest-before-start.test.tsx tests/ui/guest-rsvp-flow.test.tsx tests/ui/manager-photo-intake.test.tsx tests/ui/manager-settings-autosave.test.tsx
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0010.test.ts tests/worker/photo-intake-api.test.ts tests/worker/core-journey.test.ts tests/worker/event-entry-api.test.ts tests/worker/manage-api.test.ts tests/worker/rsvp-lookup-api.test.ts tests/worker/rsvp-manage-api.test.ts tests/worker/rsvp-submission-api.test.ts tests/worker/upload-api.test.ts
npx tsc -p tsconfig.e2e.json --pretty false
npx playwright test tests/e2e/guest-lifecycle.spec.ts tests/e2e/rsvp-journey.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/public-responsive.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/rsvp-responsive.spec.ts tests/e2e/security.spec.ts
```

Expected: all merged lifecycle behavior passes before any snapshot is updated. If a behavioral test fails, add a narrower regression and fix its root cause in a separate commit; never update a screenshot to mask it.

- [ ] **Step 2: Save the two old landing images outside the repository**

```powershell
$comparisonLeaf = 'candidary-landing-compare-' + (git rev-parse --short=12 HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the comparison commit.' }
$comparisonRoot = Join-Path ([System.IO.Path]::GetTempPath()) $comparisonLeaf
if (Test-Path -LiteralPath $comparisonRoot) { throw 'The deterministic comparison root already exists; inspect and safely remove that exact temp directory before retrying.' }
New-Item -ItemType Directory -Path $comparisonRoot | Out-Null
$comparisonRoot = (Resolve-Path -LiteralPath $comparisonRoot).Path
if (-not $comparisonRoot.StartsWith([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Comparison root escaped OS temp.' }

$firstFold = 'tests/e2e/visual-qa.spec.ts-snapshots/landing-first-fold-320-mobile-win32.png'
$workflow = 'tests/e2e/visual-qa.spec.ts-snapshots/landing-workflow-780-mobile-win32.png'
Copy-Item -LiteralPath $firstFold -Destination (Join-Path $comparisonRoot 'old-first-fold.png')
Copy-Item -LiteralPath $workflow -Destination (Join-Path $comparisonRoot 'old-workflow.png')
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $comparisonRoot 'old-first-fold.png'), (Join-Path $comparisonRoot 'old-workflow.png')
```

Do not copy or edit any other baseline.

- [ ] **Step 3: Recapture only the invalidated landing case**

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts --project=mobile --grep "landing first fold and workflow band hold their composition" --update-snapshots
```

Expected: exactly the two named landing PNGs change. `git status --short` must not show any other snapshot update.

```powershell
$comparisonRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('candidary-landing-compare-' + (git rev-parse --short=12 HEAD))
$firstFold = 'tests/e2e/visual-qa.spec.ts-snapshots/landing-first-fold-320-mobile-win32.png'
$workflow = 'tests/e2e/visual-qa.spec.ts-snapshots/landing-workflow-780-mobile-win32.png'
if (-not (Test-Path -LiteralPath $comparisonRoot -PathType Container)) { throw 'The Task 2 comparison root is missing.' }
$expectedSnapshots = @($firstFold, $workflow) | Sort-Object
$actualSnapshots = @(git diff --name-only -- 'tests/e2e/visual-qa.spec.ts-snapshots/*.png') | Sort-Object
if (Compare-Object $expectedSnapshots $actualSnapshots) { throw 'Update mode changed an unapproved snapshot set.' }
Copy-Item -LiteralPath $firstFold -Destination (Join-Path $comparisonRoot 'new-first-fold.png')
Copy-Item -LiteralPath $workflow -Destination (Join-Path $comparisonRoot 'new-workflow.png')
```

- [ ] **Step 4: Compare and inspect at the exact source viewports**

Mechanically create one side-by-side PNG per viewport under `$comparisonRoot`, without rescaling either source: old on the left, new on the right, and a 16-pixel neutral divider.

```powershell
Add-Type -AssemblyName System.Drawing.Common
function New-LosslessComparison([string]$OldPath, [string]$NewPath, [string]$OutputPath, [int]$ExpectedWidth, [int]$ExpectedFixedHeight) {
  $oldImage = [System.Drawing.Image]::FromFile($OldPath)
  $newImage = [System.Drawing.Image]::FromFile($NewPath)
  try {
    if ($oldImage.Width -ne $ExpectedWidth -or $newImage.Width -ne $ExpectedWidth) { throw 'Unexpected comparison source width.' }
    if ($ExpectedFixedHeight -gt 0 -and ($oldImage.Height -ne $ExpectedFixedHeight -or $newImage.Height -ne $ExpectedFixedHeight)) { throw 'Unexpected fixed-height comparison source.' }
    $canvasHeight = [Math]::Max($oldImage.Height, $newImage.Height)
    $canvas = [System.Drawing.Bitmap]::new(($ExpectedWidth * 2 + 16), $canvasHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.Clear([System.Drawing.Color]::FromArgb(255, 127, 127, 127))
      $graphics.DrawImageUnscaled($oldImage, 0, 0)
      $graphics.DrawImageUnscaled($newImage, ($ExpectedWidth + 16), 0)
      $canvas.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $canvas.Dispose()
    }
  } finally {
    $oldImage.Dispose()
    $newImage.Dispose()
  }
}

$comparisonRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('candidary-landing-compare-' + (git rev-parse --short=12 HEAD))
if (-not (Test-Path -LiteralPath $comparisonRoot -PathType Container)) { throw 'The Task 2 comparison root is missing.' }
$firstFoldComparison = Join-Path $comparisonRoot 'compare-first-fold.png'
$workflowComparison = Join-Path $comparisonRoot 'compare-workflow.png'
New-LosslessComparison (Join-Path $comparisonRoot 'old-first-fold.png') (Join-Path $comparisonRoot 'new-first-fold.png') $firstFoldComparison 320 568
New-LosslessComparison (Join-Path $comparisonRoot 'old-workflow.png') (Join-Path $comparisonRoot 'new-workflow.png') $workflowComparison 780 0
```

The first-fold sources must both be `320 x 568`, so that composite is `656 x 568`. The workflow snapshot is an element capture taken from the `780 x 900` source viewport: require both source widths to be `780`, preserve each natural height, top-align without scaling, and use the greater source height for the `1576`-pixel-wide composite. Record both natural heights rather than assuming the tracked old image's `557` pixels remain unchanged. Open both resolved composite paths with the local `view_image` inspection tool at original detail, so old and new are judged in the same visual input. Inspect typography, crop, spacing, sticky navigation, hero cluster, workflow rows, focus visibility, overflow, borders, and radii. Accept the new images only when they faithfully represent the already-approved homepage; this task does not select a new design direction. Keep every comparison artifact under the validated temporary root and out of Git.

- [ ] **Step 5: Run the visual and lifecycle browser checks normally**

```powershell
npx playwright test tests/e2e/visual-qa.spec.ts --project=mobile
npx playwright test tests/e2e/guest-lifecycle.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/guest-responsive.spec.ts tests/e2e/rsvp-responsive.spec.ts --project=mobile
```

Expected: exact snapshots, lifecycle transitions, responsive containment, and accessibility checks pass without update mode.

- [ ] **Step 6: Record only measured browser evidence and commit**

Remove the stale landing recapture warning from `design-qa.md`. Replace lifecycle “not yet evidenced” wording only for states actually exercised above, naming the automated test and viewport; keep all physical/manual rows explicitly outstanding. Make the matching narrow updates in `design/fidelity-ledger.md`.

```powershell
git diff --check
git add design-qa.md design/fidelity-ledger.md tests/e2e/visual-qa.spec.ts-snapshots/landing-first-fold-320-mobile-win32.png tests/e2e/visual-qa.spec.ts-snapshots/landing-workflow-780-mobile-win32.png
$comparisonRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('candidary-landing-compare-' + (git rev-parse --short=12 HEAD))
$resolvedComparisonRoot = [System.IO.Path]::GetFullPath($comparisonRoot)
$resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$comparisonItem = Get-Item -LiteralPath $resolvedComparisonRoot
if (-not $resolvedComparisonRoot.StartsWith($resolvedTempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $comparisonItem.Name -notlike 'candidary-landing-compare-*' -or ($comparisonItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Refusing unsafe comparison cleanup.' }
Remove-Item -LiteralPath $resolvedComparisonRoot -Recurse -Force
git commit -m "test: record converged browser evidence"
```

---

### Task 3: Add the redacted release-certification contract

**Files:**
- Create: `config/release.json`
- Create: `shared/release.ts`
- Create: `migrations/0011_release_certifications.sql`
- Modify: `worker/db/types.ts`
- Create: `worker/db/release-certifications.ts`
- Create: `tests/unit/release.test.ts`
- Create: `tests/worker/migration-0011.test.ts`
- Create: `tests/worker/release-certifications.test.ts`

**Interfaces:**

`config/release.json` is the single language-neutral version source:

```json
{
  "evidenceSchemaVersion": 1,
  "guestJourneyVersion": 1
}
```

`shared/release.ts` exports:

```ts
export const RELEASE_EVIDENCE_SCHEMA_VERSION: number;
export const GUEST_JOURNEY_VERSION: number;

export interface RuntimeReleaseIdentity {
  buildSha: string;
  workerVersionId: string;
  guestJourneyVersion: number;
  migrationManifestSha256: string;
}

export type PhysicalEvidenceCategory =
  | 'printed-entry-ios'
  | 'printed-entry-android'
  | 'server-time-lifecycle'
  | 'guest-session-rotation'
  | 'household-rsvp'
  | 'native-picker-ios'
  | 'private-delivery'
  | 'degraded-network-recovery'
  | 'gallery-export-recovery'
  | 'load-scale'
  | 'printed-entry-disable-recovery'
  | 'voiceover'
  | 'talkback';

export interface PhysicalEvidenceReference {
  category: PhysicalEvidenceCategory;
  evidenceId: string;
  manifestSha256: string;
  capturedAt: string;
}

export interface ReleaseCertification extends RuntimeReleaseIdentity {
  evidenceManifestSha256: string;
  physicalEvidenceRefs: PhysicalEvidenceReference[];
  certifiedAt: string;
}

export function parseRuntimeReleaseIdentity(input: {
  buildSha?: unknown;
  workerVersionId?: unknown;
  workerVersionTag?: unknown;
  migrationManifestSha256?: unknown;
}): RuntimeReleaseIdentity | null;

export function parseReleaseCertification(input: unknown): ReleaseCertification | null;
export function releaseCertificationMatches(
  identity: RuntimeReleaseIdentity | null,
  certification: ReleaseCertification | null,
): boolean;
```

Validation requires positive safe integer versions; lowercase 40-character Git SHA; lowercase 64-character SHA-256 digests; a trimmed nonblank Worker version ID of at most 128 characters; `workerVersionTag === buildSha`; a nonempty array of strict, unique-category physical-reference objects with UUID `evidenceId`; valid UTC ISO instants; and no extra keys. The future explicitly authorized certification command must enforce the then-applicable complete Section 14 category set before insert; this increment defines the redacted vocabulary and storage contract but does not decide that the physical matrix passed.

`migrations/0011_release_certifications.sql` uses this exact shape (with the existing migration style preserved):

```sql
CREATE TABLE release_certifications (
  worker_version_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(worker_version_id) BETWEEN 1 AND 128)
    CHECK (worker_version_id = trim(worker_version_id)),
  build_sha TEXT NOT NULL
    CHECK (length(build_sha) = 40)
    CHECK (build_sha NOT GLOB '*[^0-9a-f]*'),
  guest_journey_version INTEGER NOT NULL
    CHECK (typeof(guest_journey_version) = 'integer')
    CHECK (guest_journey_version > 0),
  migration_manifest_sha256 TEXT NOT NULL
    CHECK (length(migration_manifest_sha256) = 64)
    CHECK (migration_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_manifest_sha256 TEXT NOT NULL
    CHECK (length(evidence_manifest_sha256) = 64)
    CHECK (evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  physical_evidence_refs_json TEXT NOT NULL
    CHECK (length(physical_evidence_refs_json) BETWEEN 2 AND 32768)
    CHECK (json_valid(physical_evidence_refs_json))
    CHECK (json_type(physical_evidence_refs_json) = 'array')
    CHECK (json_array_length(physical_evidence_refs_json) > 0),
  certified_at TEXT NOT NULL
    CHECK (length(certified_at) = 24)
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', certified_at) = certified_at)
);

CREATE INDEX release_certifications_exact
  ON release_certifications (
    build_sha,
    guest_journey_version,
    migration_manifest_sha256
  );
```

The repository exposes `insert(record)` and `findExact(identity)` only; no route, scheduled job, CLI write, or automatic certification caller is added.

- [ ] **Step 1: Write failing shared-contract tests**

Cover:

- the two checked-in values are exactly `1`;
- a full lowercase SHA, matching tag, nonblank version ID, and migration digest parse;
- missing, short, uppercase, or padded SHA values fail;
- missing, blank, or padded Worker IDs fail;
- absent or mismatched version tags fail;
- malformed migration/evidence digests fail;
- empty/duplicate-category references, unknown categories, extra physical-reference keys, free-form notes, URLs, filenames, device fields, and invalid timestamps fail; and
- matching returns false for every null or mismatched runtime dimension.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/release.test.ts
```

Expected: the module does not exist.

- [ ] **Step 3: Implement the shared config and strict parsers**

Import `config/release.json` from `shared/release.ts`, validate both integers at module initialization, and implement fail-closed parsers. Do not coerce strings to numbers, trim invalid evidence into validity, or retain unknown keys.

- [ ] **Step 4: Write failing migration and repository tests**

The migration test must insert one valid row, then prove rejection of a duplicate or `NULL` Worker version ID, uppercase/short hashes, zero or fractional journey versions, blank/padded Worker IDs, invalid/non-array/oversized physical JSON, and malformed timestamps. The repository test must prove exact-match lookup across all four runtime dimensions and fail closed when a stored row cannot pass the shared parser.

- [ ] **Step 5: Verify RED for D1**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0011.test.ts tests/worker/release-certifications.test.ts
```

Expected: `release_certifications` and its repository do not exist.

- [ ] **Step 6: Implement migration `0011` and the repository**

Add the row type to `worker/db/types.ts`. Serialize only the strict physical-reference array. The insert method accepts a parsed `ReleaseCertification`, binds each scalar, and never receives an environment, request, raw manifest, device description, or note. `findExact()` binds `workerVersionId`, `buildSha`, `guestJourneyVersion`, and `migrationManifestSha256` and returns `null` for no row or a malformed row.

- [ ] **Step 7: Verify GREEN and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/release.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0011.test.ts tests/worker/release-certifications.test.ts
npm run typecheck
npm run lint
git diff --check
git add config/release.json shared/release.ts migrations/0011_release_certifications.sql worker/db/types.ts worker/db/release-certifications.ts tests/unit/release.test.ts tests/worker/migration-0011.test.ts tests/worker/release-certifications.test.ts
git commit -m "feat: define release certification contract"
```

---

### Task 4: Build deterministic redacted evidence primitives

**Files:**
- Create: `scripts/release-evidence.ts`
- Create: `tests/unit/release-evidence.test.ts`
- Create: `tsconfig.scripts.json`
- Modify: `tsconfig.json`

**Interfaces:**

`scripts/release-evidence.ts` uses Node built-ins only and exports:

```ts
export interface HashedFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MigrationManifest {
  files: HashedFile[];
  sha256: string;
}

export interface MigrationVerification {
  migrationCount: number;
  ledgerSha256: string;
  foreignKeyRows: 0;
  integrity: 'ok';
  terminalSchema: {
    events: true;
    rosterBatchReceipts: true;
    releaseCertifications: true;
  };
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
}

export interface BindingTopology {
  compatibilityDate: string;
  compatibilityFlags: string[];
  workersDev: boolean;
  assets: {
    binding: string;
    notFoundHandling: string;
    runWorkerFirst: string[];
  };
  bindings: {
    d1: string[];
    r2: string[];
    images: string[];
    sendEmail: string[];
    versionMetadata: string | null;
  };
  requiredSecrets: string[];
  variableNames: string[];
  workflows: Array<{ binding: string; className: string }>;
  rateLimits: Array<{ name: string; limit: number; period: number }>;
  crons: string[];
  migrationDirectories: string[];
  observabilityEnabled: boolean;
}

export interface ToolVersions {
  node: string | null;
  npm: string | null;
  git: string | null;
  typescript: string | null;
  eslint: string | null;
  vite: string | null;
  vitest: string | null;
  playwright: string | null;
  wrangler: string | null;
}

export function canonicalJson(value: unknown): string;
export function sha256(value: string | Uint8Array): string;
export function collectMigrationManifest(root: string): MigrationManifest;
export function collectDeployableArtifacts(root: string): {
  worker: HashedFile;
  client: HashedFile[];
  treeSha256: string;
};
export function normalizedBindingTopology(config: unknown): BindingTopology;
export function releaseBuildSha(headSha: unknown, porcelainStatus: string): string;
export function parseVitestReport(report: unknown, filePattern?: RegExp): TestCounts;
export function parsePlaywrightReport(report: unknown): TestCounts;
export function assertRedactedCandidateManifest(
  value: unknown,
): asserts value is CandidateManifest;
```

Migration discovery accepts only `NNNN_lowercase_name.sql`, requires a gap-free sequence beginning at `0001`, sorts by numeric prefix, hashes exact file bytes, then computes `SHA256(canonical JSON([{ path, sha256 }, ...]))`.

Artifact discovery follows `dist/candidary/wrangler.json` only far enough to resolve the Worker main and client assets, then records logical repository-relative paths. It must reject `.env*`, `.dev.vars*`, files outside `dist/candidary` or `dist/client`, and absolute paths in the output model. Sort client entries by logical path and compute `treeSha256` as `SHA256(canonical JSON({ worker, client }))` over the embedded `HashedFile` objects. Do not hash the generated Wrangler JSON as an artifact because it contains absolute worktree paths; instead compare and hash a normalized topology.

`packageLockSha256` and `sourceWranglerConfigSha256` hash the exact bytes of `package-lock.json` and checked-in `wrangler.jsonc`. `generatedTypesSha256` hashes the exact checked-in `worker-configuration.d.ts` bytes. Tool collection uses fixed keys only and records version strings, never executable paths or command output beyond the parsed version token.

Normalized topology contains compatibility date/flags; Worker-dev and observability toggles; asset binding, routing mode, and route patterns; binding names grouped by the fixed kinds above; required-secret and variable names; Workflow binding/class-name pairs; rate-limit names/limits/periods; cron expressions; and normalized migration-directory semantics. Every set-like array is deduplicated and lexically sorted before hashing. It excludes database/bucket/resource names, account/namespace/resource IDs, variable values, absolute paths, and raw config content. `releaseBuildSha()` returns the exact lowercase 40-character `HEAD` only when porcelain status is empty; it otherwise returns `''`, including for malformed SHAs.

The manifest allowlist is:

```ts
export type ReleaseCommandId =
  | 'npm-ci'
  | 'verify-bindings'
  | 'typecheck'
  | 'typecheck-e2e'
  | 'lint'
  | 'unit-ui'
  | 'worker'
  | 'build'
  | 'pwa-before-e2e'
  | 'playwright'
  | 'pwa-after-e2e'
  | 'wrangler-dry-run'
  | 'fresh-d1'
  | 'diff-check';

export type ReleaseFailureCode =
  | 'precondition_failed'
  | `command_failed:${ReleaseCommandId}`
  | 'evidence_invalid'
  | 'artifact_drift'
  | 'binding_drift'
  | 'status_drift'
  | 'cleanup_failed';

export type EvidenceFailureObservation =
  | 'unit_report_missing_or_invalid'
  | 'worker_report_missing_or_invalid'
  | 'playwright_report_missing_or_invalid'
  | 'worker_identity_literal_missing'
  | 'worker_identity_global_unreplaced'
  | 'client_identity_leak'
  | 'forbidden_secret_file'
  | 'artifact_collection_invalid'
  | 'binding_collection_invalid'
  | 'migration_verification_invalid'
  | 'tool_version_invalid';

export type PreconditionFailureObservation =
  | 'candidate_identity_unavailable'
  | 'initial_head_not_detached'
  | 'initial_head_sha_mismatch'
  | 'initial_head_tree_mismatch'
  | 'initial_status_not_clean';

export interface CommandResult<Id extends ReleaseCommandId> {
  id: Id;
  status: 'passed' | 'failed' | 'not_run';
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
}

export interface CandidateManifest {
  kind: 'candidary.release-candidate';
  schemaVersion: 1;
  status: 'passed' | 'failed';
  failureCode: ReleaseFailureCode | null;
  failureObservation: EvidenceFailureObservation | null;
  preconditionObservation: PreconditionFailureObservation | null;
  runId: string;
  candidate: {
    gitSha: string;
    approvedBaseSha: string;
    gitTree: string;
    guestJourneyVersion: number;
    migrationManifestSha256: string;
    packageLockSha256: string;
    sourceWranglerConfigSha256: string;
  } | null;
  execution: {
    startedAt: string;
    finishedAt: string;
    platform: string;
    arch: string;
    initialDetachedHead: boolean | null;
    initialHeadSha: string | null;
    initialHeadTree: string | null;
    initialStatusSha256: string | null;
    finalDetachedHead: boolean | null;
    finalHeadSha: string | null;
    finalHeadTree: string | null;
    finalStatusSha256: string | null;
    cleanupSucceeded: boolean | null;
    tools: ToolVersions;
  };
  commands: [
    CommandResult<'npm-ci'>,
    CommandResult<'verify-bindings'>,
    CommandResult<'typecheck'>,
    CommandResult<'typecheck-e2e'>,
    CommandResult<'lint'>,
    CommandResult<'unit-ui'>,
    CommandResult<'worker'>,
    CommandResult<'build'>,
    CommandResult<'pwa-before-e2e'>,
    CommandResult<'playwright'>,
    CommandResult<'pwa-after-e2e'>,
    CommandResult<'wrangler-dry-run'>,
    CommandResult<'fresh-d1'>,
    CommandResult<'diff-check'>,
  ];
  tests: {
    unitUi: TestCounts | null;
    worker: TestCounts | null;
    playwright: TestCounts | null;
  };
  migrations: {
    manifest: HashedFile[];
    verification: MigrationVerification;
  } | null;
  bindings: {
    topology: BindingTopology;
    sourceTopologySha256: string;
    firstBuildTopologySha256: string | null;
    secondBuildTopologySha256: string | null;
    generatedTypesSha256: string;
  } | null;
  artifacts: {
    worker: HashedFile;
    client: HashedFile[];
    firstTreeSha256: string;
    secondTreeSha256: string | null;
    dryRunWorkerSha256: string | null;
  } | null;
  claims: {
    localAutomated: 'passed' | 'failed';
    remoteMigration: 'not_run';
    deployment: 'not_run';
    physicalDevices: 'not_run';
    runtimeCertification: 'not_run';
  };
}
```

A local candidate cannot know its future Worker version ID. Do not invent one; the post-deploy contract supplies it later. The strict validator permits `null` evidence only on failed manifests. `passed` requires a null failure code, the exact 14-entry command tuple above with every command passed, all candidate/test/migration/binding/artifact fields populated, every tool version populated, zero failed tests, both detached observations `true`, both initial/final HEAD SHA/tree pairs equal the candidate SHA/tree, both status digests equal `SHA256('')`, `cleanupSucceeded === true`, and `localAutomated: 'passed'`. `failed` requires a nonnull failure code and `localAutomated: 'failed'`; its code must agree with the redacted command/precondition/drift/cleanup observations below. Failed-command report truncation preserves the original command failure and leaves the affected counts `null`.

Command cross-fields are exact: `passed` has UTC start/finish instants, nonnegative duration, and exit code `0`; `failed` has start/finish/duration plus a nonzero integer exit code or `null` only for a spawn failure; `not_run` has all four execution fields `null`. The tuple may contain at most one failed command, with a passed prefix and `not_run` suffix. When cleanup succeeds, the presence of that failed entry forces—and is forced by—the matching `command_failed:X`; precondition/evidence/artifact/binding/status codes require no failed command and a passed-prefix/`not_run`-suffix (the prefix may be empty or the suffix may be empty at a post-command check). Only `cleanup_failed` may supersede an underlying tuple that already contains a failed command. `cleanup_failed` requires `cleanupSucceeded === false`; every other final failure requires `cleanupSucceeded === true`. `artifact_drift` requires unequal nonnull first/second tree digests or a nonnull dry-run digest unequal to the Worker digest. `binding_drift` requires at least two nonnull source/first/second topology observations that are unequal. `status_drift` requires a final detached/HEAD/status observation that is null, false, differs from the candidate identity, or differs from `SHA256('')`; initial observations cannot be substituted for final drift.

`precondition_failed` requires exactly one nonnull `preconditionObservation` from the precondition-only union above and a null `failureObservation`. Its cross-field rule is exact: `candidate_identity_unavailable` means `candidate === null`; `initial_head_not_detached` means the initial detached observation is false/null; `initial_head_sha_mismatch` or `initial_head_tree_mismatch` means the corresponding initial value is null or differs from the present candidate value; and `initial_status_not_clean` means the initial digest is null or differs from `SHA256('')`. An invalid or nonliteral approved base is rejected in the outer no-manifest bootstrap boundary and is never represented as candidate evidence. Null test counts, tools, migrations, artifacts, bindings, generated reports, final Git observations, or other evidence-stage values never satisfy a precondition failure. `evidence_invalid` conversely requires exactly one nonnull `failureObservation` and a null `preconditionObservation`. Every other final code and every pass requires both observation fields to be `null`. A report failure after a nonzero/spawn-failed command preserves `command_failed:X` and null counts; a missing/invalid report after exit `0`, identity literal/global policy failure, client leak, forbidden secret file, collection failure, invalid migration-verification file, or missing tool version uses `evidence_invalid` plus the matching observation. These bidirectional relationships make failures representable and prevent relabeling without storing raw output.

The validator recomputes every redundant aggregate for which the allowlisted source data is embedded. Every present candidate requires `approvedBaseSha === '0b92387d2e237d568d2514373dcc3044e7960d4b'`; a passed manifest must have a present candidate. Whenever the relevant nullable sections exist, require the migration-manifest digest to equal `candidate.migrationManifestSha256`, migration count to equal manifest length, filename-only ledger digest to equal `migrations.verification.ledgerSha256`, normalized topology digest to equal `bindings.sourceTopologySha256`, and Worker/client artifact-tree digest to equal `artifacts.firstTreeSha256`. On a pass, every section exists, source/first/second topology digests are equal, first/second artifact-tree digests are equal, and dry-run Worker digest equals `artifacts.worker.sha256`. It also requires each present `TestCounts.total` to equal `passed + failed + skipped`, with `flaky <= passed`, and enforces canonical ordering/uniqueness. Leaf attestations whose bytes are intentionally absent—package lock, source Wrangler config, generated types, and individual files—are lowercase digest/size/path validated and covered by collector tests, but the strict manifest parser does not falsely claim it can recompute them without a repository root.

- [ ] **Step 1: Write failing hashing, parser, and redaction tests**

Use OS-temporary fixtures to prove:

- canonical hashes ignore object-key insertion order but not array order;
- a one-byte migration or artifact change changes the correct digest;
- duplicate, skipped, uppercase, or malformed migration names fail;
- Windows and POSIX separators normalize to `/` logical paths;
- absolute paths and files outside approved build roots fail;
- source and generated binding inventories compare by name/kind while resource values never enter the model;
- Vitest and Playwright reports yield exact pass/fail/skip/flaky counts, including normalized file-path filtering used in focused parser tests;
- a one-field tamper in migration digest/count/ledger, binding topology digest, artifact tree digest, dry-run digest, or test totals fails strict validation;
- command tuple/order and passed/failed/not-run cross-field tampering fails; a failed command cannot be relabeled as precondition/evidence/drift/status failure (except cleanup supersession); precondition-only and evidence-only observations cannot substitute for one another; and each closed failure code requires its corresponding redacted observation;
- unknown manifest keys, stdout, stderr, `env`, secrets, tokens, URLs, email-like values, absolute paths, and free-form notes fail validation; and
- all nonlocal claims remain exactly `not_run`.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/release-evidence.test.ts
```

Expected: the evidence module does not exist.

- [ ] **Step 3: Implement the primitives with built-ins only**

Use `node:crypto`, `node:fs`, and `node:path`. Build manifest objects field by field; do not serialize an arbitrary diagnostic object and then attempt regex redaction. Canonical JSON recursively sorts object keys and preserves array order. File reads used for hashing must stay as bytes.

- [ ] **Step 4: Include all Node scripts in repository typechecking**

Create `tsconfig.scripts.json` with the repository's strict/no-emit options, `lib: ["ES2023"]`, `types: ["node"]`, and `include: ["scripts/**/*.ts", "vite.config.ts", "vitest.config.ts", "vitest.worker.config.ts"]`; add it as a project reference in `tsconfig.json`. Keep browser/UI typing in `tsconfig.app.json` unchanged. Follow the computed dynamic-import pattern in `scripts/event-start-backfill.ts` when a Node 24 runtime needs an explicit `.ts` suffix without weakening repository-wide import rules.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/release-evidence.test.ts
npm run typecheck
npm run lint
git diff --check
git add scripts/release-evidence.ts tests/unit/release-evidence.test.ts tsconfig.scripts.json tsconfig.json
git commit -m "feat: add redacted release evidence primitives"
```

---

### Task 5: Inject and resolve fail-closed runtime release identity

**Files:**
- Modify: `vite.config.ts`
- Modify: `wrangler.jsonc`
- Modify: `worker-configuration.d.ts`
- Modify: `package.json`
- Modify: `shared/release.ts`
- Create: `worker/release-identity.ts`
- Modify: `worker/env.ts`
- Modify: `worker/app.ts`
- Modify: `vitest.worker.config.ts`
- Modify: `tests/unit/release.test.ts`
- Create: `tests/worker/release-identity.test.ts`

**Interfaces:**

Add to the Worker input config:

```json
"version_metadata": {
  "binding": "CF_VERSION_METADATA"
}
```

The `candidary` Vite Worker environment defines two Worker-only globals:

```ts
declare const __CANDIDARY_BUILD_SHA__: string;
declare const __CANDIDARY_MIGRATION_MANIFEST_SHA256__: string;
```

`worker/release-identity.ts` exports:

```ts
export function resolveRuntimeReleaseIdentity(
  env: { CF_VERSION_METADATA?: WorkerVersionMetadata },
): RuntimeReleaseIdentity | null;
```

It reads the two globals with `typeof` guards and calls `parseRuntimeReleaseIdentity`. Production identity exists only when the metadata ID is nonblank, the metadata tag exactly equals the injected SHA, the SHA and migration digest are valid, and the checked-in guest version is valid. Miniflare's random ID plus empty local tag remains `null` unless a test supplies matching metadata.

- [ ] **Step 1: Extend unit tests for build-candidate resolution**

Add cases proving that a clean repository status permits the exact full `HEAD` SHA, while any nonignored tracked or untracked path makes the build SHA unavailable. Ignored `node_modules`, `dist`, `.wrangler`, and `output` do not count. This prevents manually deploying uncommitted source under a clean-looking tag without blocking ordinary local builds; a dirty build still runs, but its runtime identity is `null`.

- [ ] **Step 2: Write failing Worker identity tests**

Cover a fixed test SHA and migration digest with matching metadata, missing binding, empty ID, empty tag, mismatched tag, malformed digest, and uppercase SHA. Assert every invalid case returns `null` rather than throwing.

- [ ] **Step 3: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/release.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/release-identity.test.ts
```

Expected: build-candidate and Worker identity adapters do not exist.

- [ ] **Step 4: Inject only into the Worker environment**

In `vite.config.ts`, resolve the repository root from `import.meta.url`; resolve `HEAD^{commit}` through `execFileSync`; inspect `git status --porcelain=v1 --untracked-files=all`; and call `collectMigrationManifest()`. Validate Git output. Configure:

```ts
const buildSha = releaseBuildSha(headSha, porcelainStatus);

environments: {
  candidary: {
    define: {
      __CANDIDARY_BUILD_SHA__: JSON.stringify(buildSha),
      __CANDIDARY_MIGRATION_MANIFEST_SHA256__: JSON.stringify(migrations.sha256),
    },
  },
}
```

Do not add either value to `vars`, `import.meta.env`, the client environment, or a public API.

- [ ] **Step 5: Bind metadata and normalize it once per request**

Add `CF_VERSION_METADATA` to `wrangler.jsonc`. Add `releaseIdentity: RuntimeReleaseIdentity | null` to `AppBindings.Variables`. In the existing request-initialization middleware, set `requestId` and then `releaseIdentity`. Do not add a public release route; later authenticated readiness code will consume the internal value.

- [ ] **Step 6: Make Worker tests deterministic**

In `vitest.worker.config.ts`, define fixed valid global SHA and migration-digest literals. Tests that exercise fail-closed metadata pass explicit binding-shaped objects to the adapter; do not mistake Miniflare's empty tag for certification evidence.

- [ ] **Step 7: Regenerate once, then add a non-writing drift gate**

Add:

```json
"verify:bindings": "wrangler types --check"
```

Run:

```powershell
npm run cf-typegen
npm run verify:bindings
```

Expected: generated `Cloudflare.Env` contains `CF_VERSION_METADATA: WorkerVersionMetadata`, and the check exits zero without rewriting the file. The pre-existing generated-type drift is resolved in this commit.

- [ ] **Step 8: Verify the real bundle and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/release.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/release-identity.test.ts
npm run typecheck
npm run lint
npm run build
npm run verify:pwa-build
npm run verify:bindings
git diff --check
```

For this ordinary dirty implementation worktree, runtime identity may deliberately be unavailable. The final detached gate will prove exact literals. Confirm `dist/candidary/wrangler.json` contains `version_metadata.binding === "CF_VERSION_METADATA"`. Scan every `dist/client` asset and fail if any contains either global name; the final clean-candidate gate also rejects the resolved full SHA and migration digest in client output.

```powershell
git add vite.config.ts wrangler.jsonc worker-configuration.d.ts package.json shared/release.ts worker/release-identity.ts worker/env.ts worker/app.ts vitest.worker.config.ts tests/unit/release.test.ts tests/worker/release-identity.test.ts
git commit -m "feat: bind runtime release identity"
```

---

### Task 6: Make the explicit deployment path preserve candidate identity

This narrow replacement is part of Increment 1's runtime-identity boundary: a future authorized deployment must upload the exact verified Vite bundle and tag that Worker version with the reviewed SHA, or the fail-closed runtime identity can never resolve. Implementing and unit-testing the guard does not authorize running it.

**Files:**
- Create: `scripts/deploy-release.ts`
- Create: `tests/unit/deploy-release.test.ts`
- Modify: `tests/unit/pwa-assets.test.ts`
- Modify: `package.json`

**Interfaces:**

Replace the implicit deploy script with a guarded command whose operator contract is:

```powershell
$reviewedSha = git rev-parse HEAD
$candidateManifest = Get-ChildItem -LiteralPath "output/release/$reviewedSha" -Recurse -Filter 'candidate-manifest.json' |
  Where-Object { (Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json).status -eq 'passed' } |
  Sort-Object LastWriteTimeUtc |
  Select-Object -Last 1 -ExpandProperty FullName
if (-not $candidateManifest) { throw 'No passed candidate manifest exists for the reviewed SHA.' }
$candidateManifest = (Resolve-Path -LiteralPath $candidateManifest).Path
npm run deploy -- --sha $reviewedSha --manifest $candidateManifest
```

`scripts/deploy-release.ts` must:

1. require `--sha` to be 40 lowercase hexadecimal characters and `--manifest` to be one exact existing file;
2. resolve the supplied SHA as a commit and require it to equal `HEAD`;
3. require an empty nonignored worktree, including untracked files, so deployment occurs from a dedicated clean checkout rather than deleting caller artifacts;
4. validate the candidate manifest and its adjacent `.sha256` sidecar;
5. require `status: passed`, exact SHA/tree, `approvedBaseSha === 0b92387d2e237d568d2514373dcc3044e7960d4b`, journey/migration identity, and all nonlocal claims still `not_run`;
6. run `npm ci`, `npm run build`, and `npm run verify:pwa-build`;
7. compare rebuilt Worker/client hashes and normalized binding topology to the candidate manifest;
8. immediately re-read `HEAD`, tree, and complete nonignored status and require the exact reviewed clean state; and
9. only then execute `wrangler deploy --config dist/candidary/wrangler.json --strict --tag $reviewedSha` with inherited output.

The script does not migrate D1 or create a certification row. It is implemented and unit-tested here but **must not be executed in live mode during this plan**.

- [ ] **Step 1: Write failing CLI/command-plan tests**

Test argument parsing and injected process adapters. Reject missing/short/ref SHAs, missing manifest, digest mismatch, failed candidate, artifact mismatch, wrong tree, initial dirt, post-build drift, and any command without the exact tag. Prove Windows command plans invoke `npm-cli.js` and candidate-local `node_modules/wrangler/bin/wrangler.js` through `process.execPath`, never `.cmd`, a shell, or `npx`. Prove the production command uses exactly `--config dist/candidary/wrangler.json`, `--strict`, and `--tag`; includes neither `--dry-run` nor D1/secret commands; and is never reached after a failed precondition. Update `tests/unit/pwa-assets.test.ts` for the guarded npm script while preserving its proof that the wrapper's command plan includes build and PWA verification.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/deploy-release.test.ts tests/unit/pwa-assets.test.ts
```

Expected: the guarded deploy module does not exist.

- [ ] **Step 3: Implement with argument arrays, never a shell string**

Use `spawnSync`/`execFileSync` with `process.execPath`, explicit argument arrays, and `shell: false`. Resolve npm's actual `npm-cli.js` entrypoint from a validated absolute `process.env.npm_execpath` or the Node installation; do not spawn `npm.cmd`, which is invalid with `shell: false` on Windows. After `npm ci`, resolve Wrangler only as the clean checkout's `node_modules/wrangler/bin/wrangler.js` and invoke it through `process.execPath`; never use `.cmd`, `npx`, or a fallback download. Never interpolate the manifest path or SHA into a shell command. Keep command construction pure and injectable for tests.

- [ ] **Step 4: Change `npm run deploy` without running it**

Set:

```json
"deploy": "node --experimental-strip-types scripts/deploy-release.ts"
```

Do not invoke `npm run deploy` in this plan.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/deploy-release.test.ts tests/unit/pwa-assets.test.ts
npm run typecheck
npm run lint
git diff --check
git add scripts/deploy-release.ts tests/unit/deploy-release.test.ts tests/unit/pwa-assets.test.ts package.json
git commit -m "feat: require tagged evidence-backed deploys"
```

---

### Task 7: Prove all migrations on a fresh local D1

**Files:**
- Create: `scripts/verify-fresh-d1.ts`
- Create: `tests/unit/verify-fresh-d1.test.ts`
- Modify: `package.json`

**Interfaces:**

Add:

```json
"verify:fresh-d1": "node --experimental-strip-types scripts/verify-fresh-d1.ts"
```

The script accepts required `--run-root` and `--report-file` absolute paths. The run root must be under OS temp; the report must be the exact not-yet-existing direct child `$runRoot/migration-verification.json`. It rejects a missing/non-directory root, a root outside OS temp, any symlink/junction/reparse-point component, a pre-existing report, and a pre-existing `fresh-d1` child. It creates `$validatedRunRoot/fresh-d1` exclusively and resolves the candidate-local `node_modules/wrangler/bin/wrangler.js` without an `npx` fallback. Its Wrangler command plan is exactly:

```text
process.execPath $localWranglerJs d1 migrations apply DB --config wrangler.jsonc --local --persist-to $freshD1
process.execPath $localWranglerJs d1 execute DB --config wrangler.jsonc --local --persist-to $freshD1 --json --command $readOnlyInvariantQuery
```

Every child runs with `shell: false` and `cwd` equal to the candidate root. The local Wrangler JavaScript entrypoint must exist after `npm ci`; the verifier invokes it with `process.execPath` and must never spawn `wrangler.cmd` or download a replacement. The exact read-only invariant string is:

```sql
SELECT id, name FROM d1_migrations ORDER BY id;
PRAGMA foreign_key_check;
PRAGMA integrity_check;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('events') ORDER BY cid;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('rsvp_roster_batch_receipts') ORDER BY cid;
SELECT cid, name, type, "notnull", dflt_value, pk
  FROM pragma_table_info('release_certifications') ORDER BY cid;
```

Require these terminal rows in addition to the complete ordered-ledger, foreign-key, and integrity checks:

```ts
const expectedTerminalColumns = {
  events: [
    { name: 'legacy_owner_claim_open', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'event_start_at', type: 'TEXT', notnull: 1, dflt_value: "'1970-01-01T00:00:00.000Z'", pk: 0 },
    { name: 'photos_open_from', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  ],
  rsvp_roster_batch_receipts: [
    { name: 'event_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
    { name: 'idempotency_key', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
    { name: 'request_digest', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'receipt_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  ],
  release_certifications: [
    { name: 'worker_version_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
    { name: 'build_sha', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'guest_journey_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'migration_manifest_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'evidence_manifest_sha256', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'physical_evidence_refs_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'certified_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  ],
} as const;

const expectedColumnNames = {
  events: [
    'id', 'slug', 'name', 'event_date', 'welcome_message', 'cover_object_key',
    'uploads_enabled', 'gallery_visible', 'moderation_required',
    'reserved_media_count', 'stored_media_count', 'reserved_bytes', 'stored_bytes',
    'guest_access_expires_at', 'management_access_expires_at', 'purge_after',
    'created_at', 'deleted_at', 'legacy_owner_claim_open', 'theme_config',
    'event_timezone', 'rsvp_enabled', 'rsvp_deadline_at', 'rsvp_roster_version',
    'event_start_at', 'photos_open_from',
  ],
  rsvp_roster_batch_receipts: [
    'event_id', 'idempotency_key', 'request_digest', 'receipt_json', 'created_at',
  ],
  release_certifications: [
    'worker_version_id', 'build_sha', 'guest_journey_version',
    'migration_manifest_sha256', 'evidence_manifest_sha256',
    'physical_evidence_refs_json', 'certified_at',
  ],
} as const;
```

Require every listed type/nullability/default/primary-key field exactly. Require the complete column-name sequences above, so an unexpected or missing column fails rather than passing a subset check.

- [ ] **Step 1: Write failing parser and safety tests**

Prove:

- only an absolute OS-temp release root with the `candidary-release-` prefix and no reparse-point traversal is accepted;
- `fresh-d1` must not already exist and is created exclusively;
- the report path must be the absent direct child `migration-verification.json`; traversal, overwrite, symlink, or another filename is rejected;
- the plan always uses binding `DB`, `--config wrangler.jsonc`, `--local`, and the exact persistence path;
- `--remote`, missing `--local`, or any write-oriented execute SQL is rejected;
- Wrangler JSON envelopes parse deterministically;
- migration ledger names must exactly equal `collectMigrationManifest().files.map((file) => basename(file.path))`;
- foreign-key rows fail;
- integrity output other than one `ok` row fails; and
- missing/wrong lifecycle, roster-receipt, or certification columns, nullability, and defaults fail;
- success writes one canonical, schema-valid report atomically without overwriting; and
- any command/parser/invariant failure leaves the final report path absent.

- [ ] **Step 2: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
```

Expected: the fresh-D1 verifier does not exist.

- [ ] **Step 3: Implement local-only execution and invariant parsing**

Set `CI=1` for the migration subprocess so Wrangler does not wait for confirmation. Capture Wrangler JSON only for parsing; do not include raw results in evidence. Stream ordinary progress to the console. On success, build the exact `MigrationVerification` shape from Task 4, write canonical UTF-8 JSON plus one trailing newline through an exclusive temporary sibling, and atomically rename it to the absent `--report-file`. Do not write a report on failure. `ledgerSha256` hashes canonical JSON of the filename-only ordered ledger. Never compare or persist it as the content-bound `migrationManifestSha256` used by runtime identity and certification.

- [ ] **Step 4: Run against an actual new local D1**

```powershell
$runRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('candidary-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot | Out-Null
try {
  $migrationReport = Join-Path $runRoot 'migration-verification.json'
  npm run verify:fresh-d1 -- --run-root $runRoot --report-file $migrationReport
  $migrationVerification = Get-Content -Raw -LiteralPath $migrationReport | ConvertFrom-Json
  if ([int]$migrationVerification.migrationCount -ne 11 -or $migrationVerification.integrity -ne 'ok') { throw 'Unexpected migration verification report.' }
} finally {
  $resolvedRoot = [System.IO.Path]::GetFullPath($runRoot)
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $rootItem = Get-Item -LiteralPath $resolvedRoot
  if (-not $resolvedRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetFileName($resolvedRoot) -notlike 'candidary-release-*' -or ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Refusing unsafe temporary cleanup.' }
  Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
```

Expected: migrations `0001` through `0011` apply in order, the ledger exactly matches, foreign keys are clean, integrity is `ok`, and the terminal columns exist. This is local persistence only.

- [ ] **Step 5: Verify populated upgrade semantics**

```powershell
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0010.test.ts tests/worker/migration-0011.test.ts
```

Expected: both populated migration tests pass. Fresh application and populated upgrades are separate evidence.

- [ ] **Step 6: Verify GREEN and commit**

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-fresh-d1.test.ts
npm run typecheck
npm run lint
git diff --check
git add scripts/verify-fresh-d1.ts tests/unit/verify-fresh-d1.test.ts package.json
git commit -m "test: verify fresh local migration history"
```

---

### Task 8A: Build the dependency-free immutable candidate runner

**Files:**
- Create: `scripts/verify-release.ts`
- Create: `tests/unit/verify-release.test.ts`
- Modify: `scripts/release-evidence.ts`
- Modify: `tests/unit/release-evidence.test.ts`

**Interfaces:**

`scripts/verify-release.ts` and every module in its pre-install import graph may import only `node:*`, JSON, and other dependency-free candidate modules. It exports:

```ts
export interface ReleaseRunRequest {
  callerRoot: string;
  candidateRoot: string;
  runRoot: string;
  runId: string;
  candidateSha: string;
  approvedBaseSha: string;
}

export interface CandidateManifestDraft {
  manifest: CandidateManifest;
}

export interface ReleaseAdapters {
  run(input: {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{ exitCode: number }>;
  git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }>;
  now(): string;
  randomUUID(): string;
}

export async function runCandidate(
  request: ReleaseRunRequest,
  adapters?: ReleaseAdapters,
): Promise<CandidateManifestDraft>;

export function finalizeCandidateManifest(
  draft: CandidateManifestDraft,
  cleanupSucceeded: boolean,
): CandidateManifest;
```

The outer CLI requires two explicit commits:

```powershell
$reviewedSha = git rev-parse HEAD
$approvedBaseSha = '0b92387d2e237d568d2514373dcc3044e7960d4b'
node --experimental-strip-types scripts/verify-release.ts --sha $reviewedSha --base-sha $approvedBaseSha
```

Validate both as full lowercase commit IDs, require `approvedBaseSha` to equal the literal Increment 1 base `0b92387d2e237d568d2514373dcc3044e7960d4b`, require that base to be an ancestor of the candidate, and record both. The strict manifest validator enforces the same literal; an arbitrary older ancestor can never be labeled approved or produce a passing manifest.

The outer runner creates `mkdtemp(tmpdir()/candidary-release-)`, adds `$runRoot/worktree` with `git worktree add --detach`, dynamically imports that candidate's own `scripts/verify-release.ts`, and calls its exported inner runner before installing dependencies. Track worktree registration before import. If add/import/bootstrap fails before a candidate finalizer exists, an outer-owned `finally` runs `git worktree remove --force` only for that exact registered path, verifies registry and disk absence, and then removes the validated run root. It prints `bootstrap_failed` when cleanup succeeds or `bootstrap_cleanup_failed` when it must preserve the path for diagnosis, exits nonzero, and writes no candidate manifest.

The exact inner command plan is shown by logical command below; every npm/Wrangler row is physically invoked as `process.execPath` plus the resolved JavaScript CLI entrypoint and remaining arguments:

```text
npm ci
npm run verify:bindings
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run test:unit -- --reporter=default --reporter=json --outputFile.json=$unitReport
npm run test:worker -- --reporter=default --reporter=json --outputFile.json=$workerReport
npm run build
npm run verify:pwa-build
npm run test:e2e -- --reporter=list,json
npm run verify:pwa-build
$localWrangler deploy --config dist/candidary/wrangler.json --dry-run --strict --tag $candidateSha --outdir $dryRunOutput
npm run verify:fresh-d1 -- --run-root $runRoot --report-file $migrationReport
git diff --check $approvedBaseSha..$candidateSha
```

Every child uses an argument array with `shell: false` and `cwd` equal to the candidate root. Resolve npm's validated absolute `npm-cli.js`; never spawn `npm.cmd`. After `npm ci`, require `node_modules/wrangler/bin/wrangler.js`; never spawn `wrangler.cmd` or permit a package download fallback. Invoke both CLIs with `process.execPath`, and record the exact local Wrangler version.

Set `PLAYWRIGHT_JSON_OUTPUT_FILE` to the temporary report path for the E2E child. Sanitize child environments by removing Cloudflare credentials, all required secret names, all `VITE_*` values, and generic token/secret/password/cookie/authorization variables; retain only operating-system/process essentials, dependency/tool paths, and variables deliberately set by the runner. Set `CI=1`, `WRANGLER_SEND_METRICS=false`, and `CLOUDFLARE_VITE_FORCE_LOCAL=true`. The temp worktree contains no caller `.dev.vars`, and a test must prove preview cannot opt into remote bindings.

Before commands, require detached `HEAD`, exact SHA/tree, and empty nonignored status. After the first build, collect Worker/client artifacts and normalized bindings. After Playwright's production-like build, collect them again and require byte-identical hashes. After the Wrangler dry run, require `$dryRunOutput/index.js` to hash exactly like `dist/candidary/index.js`; ignore only the timestamped dry-run README. Require the Worker bundle to contain the exact SHA and migration digest and neither unreplaced global name. Scan all files under `dist/candidary`, `dist/client`, and dry-run output for forbidden `.env*`/`.dev.vars*` names. Scan every client JS/HTML asset and fail if it contains the exact SHA, migration digest, or either global name.

Precompute `$migrationReport` as the absent direct child `$runRoot/migration-verification.json`. After a successful `fresh-d1` command, read that file, strictly validate the exact `MigrationVerification` shape, and place it in the manifest; missing/invalid output after exit `0` becomes `evidence_invalid` with `migration_verification_invalid`. Re-read detached state, exact SHA/tree, and complete nonignored status after the final command. Stream output for diagnosis but retain only command IDs, times, durations, and exit codes. Missing/truncated test-report JSON after a command failure leaves counts `null` without replacing the original `command_failed:*` code.

- [ ] **Step 1: Write failing bootstrap and isolation tests**

With injected Git/process/clock adapters and OS-temporary filesystem fixtures, prove rejection of short SHAs, refs like `HEAD`, non-commit objects, any full ancestor other than the literal approved base, a non-ancestor base, mismatched/invalid UUID run IDs, attached inner `HEAD`, wrong SHA/tree, initial dirt, final tracked drift, and new nonignored output. Prove the outer runner generates exactly one run ID, passes that ID into the candidate request, and uses it for the output directory and manifest. Prove it imports the target commit's module, not the caller's copy. Create a candidate fixture with no `node_modules` and prove the module graph still loads; reject any bare-package import in that bootstrap graph. Simulate import failure after successful `git worktree add` and prove the outer bootstrap cleanup removes/verifies the registered worktree and run root, or preserves it with `bootstrap_cleanup_failed`, without writing candidate evidence.

- [ ] **Step 2: Write failing command and environment tests**

Assert the exact command IDs/order above. On Windows, prove npm and Wrangler are launched as `node.exe npm-cli.js ...` and `node.exe node_modules/wrangler/bin/wrangler.js ...`, never through `.cmd`, a shell, or `npx`. Prove all children use candidate `cwd`; Wrangler comes only from candidate `node_modules`; D1 operations are local; deploy is dry-run against the generated Vite config; the diff range is base-to-candidate; and no remote/secret/configuration write exists. Prove every child receives `CLOUDFLARE_VITE_FORCE_LOCAL=true` and no Cloudflare credential or caller `VITE_*` value.

- [ ] **Step 3: Write failing artifact/report tests**

Cover pre/post artifact and topology drift, dry-run mismatch, all forbidden secret-file roots, resolved identity leakage into client JS/HTML, missing/invalid test or migration report JSON after both zero and nonzero exits, exact Vitest/Playwright counts, immutable initial/final detached-SHA-tree-status rechecks (including a clean post-command HEAD move), and the typed fresh-D1 result. Assert every post-command policy failure maps to `evidence_invalid` plus one exact allowlisted observation, a final Git-identity change maps to `status_drift`, and a failed command remains `command_failed:X` with null counts.

- [ ] **Step 4: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-release.test.ts tests/unit/release-evidence.test.ts
```

Expected: the dependency-free runner and orchestration contracts do not exist.

- [ ] **Step 5: Implement and verify the inner runner**

Build command records field by field. Fail fast, set remaining commands to `not_run`, close all child handles, and return an in-memory manifest draft from `finally`. Do not write final evidence or recursively remove anything in this task.

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-release.test.ts tests/unit/release-evidence.test.ts
npm run typecheck
npm run lint
git diff --check
git add scripts/verify-release.ts scripts/release-evidence.ts tests/unit/verify-release.test.ts tests/unit/release-evidence.test.ts
git commit -m "feat: add immutable release runner"
```

---

### Task 8B: Finalize, digest, and expose candidate evidence

**Files:**
- Modify: `scripts/verify-release.ts`
- Modify: `tests/unit/verify-release.test.ts`
- Modify: `scripts/release-evidence.ts`
- Modify: `tests/unit/release-evidence.test.ts`
- Modify: `package.json`

**Interfaces:**

Add:

```json
"typecheck:e2e": "tsc -p tsconfig.e2e.json --pretty false",
"verify:release": "node --experimental-strip-types scripts/verify-release.ts"
```

The public command is:

```powershell
$reviewedSha = git rev-parse HEAD
npm run verify:release -- --sha $reviewedSha --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
```

Before creating the temporary worktree, validate that the caller's repository-local `output/release` chain contains no symlink/junction/reparse-point traversal and reserve a UUID run ID in memory. After the candidate module loads but before `runCandidate()`, revalidate the chain and create `output/release/{candidateSha}/{runId}` exclusively. The no-manifest bootstrap boundary lasts until both candidate import and exclusive safe output-directory creation succeed. An import, reparse, collision, or exclusive-create failure runs the guarded outer bootstrap cleanup from Task 8A, prints only the stable outer failure code, and writes no candidate evidence. From the successful boundary onward, every inner failure must produce candidate evidence.

Finalization order is exact:

1. receive the dependency-free candidate draft in memory and close every subprocess handle;
2. run `git worktree remove --force` for the one exactly registered `$runRoot/worktree` path;
3. verify that path is absent from `git worktree list --porcelain` and from disk;
4. only after successful Git removal, validate and recursively remove the remaining `candidary-release-` run root; never delete a worktree directory behind Git after a failed worktree removal;
5. call the already-loaded candidate's `finalizeCandidateManifest(draft, cleanupSucceeded)` so cleanup failure is part of the digested bytes; and
6. write canonical UTF-8 JSON plus one trailing newline and its SHA-256 sidecar through exclusive temporary files, then atomically rename without overwriting an existing run.

Hash the exact final manifest bytes. The adjacent sidecar is exactly `<64 lowercase hex>  candidate-manifest.json\n`. Never serialize an exception message, environment, command output, absolute path, or unsafe free-form value.

- [ ] **Step 1: Write failing manifest-finalization tests**

Prove pass and every closed failure code after the candidate-import-plus-safe-output boundary produce a schema-valid manifest; import or safe-output preparation failure produces no candidate manifest and still performs guarded bootstrap cleanup; pass/fail cross-field invariants hold; all nonlocal claims remain `not_run`; and a failed manifest can never be accepted by `deploy-release.ts`.

- [ ] **Step 2: Write failing cleanup/output tests**

Cover registered-worktree removal success, Git-removal failure without recursive fallback, post-removal registry verification, run-root cleanup failure, output reparse traversal, exclusive UUID directory creation, atomic temporary writes, exact digest bytes, sidecar content, and refusal to overwrite. Prove caller dirty/untracked paths are never named by cleanup, stash, reset, or remove commands.

- [ ] **Step 3: Verify RED**

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-release.test.ts tests/unit/release-evidence.test.ts
```

- [ ] **Step 4: Implement finalization and the public command**

Keep finalization dependency-free so the already-loaded candidate module still works after its worktree disappears. On cleanup failure, preserve the temporary root for diagnosis, emit `cleanup_failed`, and report its validated path to the console only; the path never enters evidence.

- [ ] **Step 5: Verify and commit without running the complete gate**

```powershell
npx vitest run --config vitest.config.ts tests/unit/verify-release.test.ts tests/unit/release-evidence.test.ts
npm run typecheck
npm run lint
git diff --check
git add scripts/verify-release.ts scripts/release-evidence.ts tests/unit/verify-release.test.ts tests/unit/release-evidence.test.ts package.json
git commit -m "feat: emit candidate evidence digests"
```

Do not run the complete gate yet; documentation and final review must be committed first so the gate's SHA is immutable.

---

### Task 9: Document the release boundary and evidence contract

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/deployment.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Documents: candidate verification, tagged evidence-backed deploy syntax, runtime identity, migration digest, certification schema, and distinct claim boundaries.
- Does not document: a certification write command, because Increment 7 owns that explicitly authorized operation.

- [ ] **Step 1: Update repository command references**

Add `typecheck:e2e`, `verify:bindings`, `verify:fresh-d1`, and `verify:release` to README/CLAUDE command sections. State that `verify:release` must receive the full candidate SHA and approved base SHA and creates a detached temporary worktree, so user files in the caller checkout are irrelevant and untouched.

- [ ] **Step 2: Document candidate evidence fields and redaction**

In `docs/deployment.md`, document the output directory, manifest/sidecar pair, migration digest algorithm, artifact scope, test counts, normalized binding inventory, failure behavior, and the five `claims` values. State that the unkeyed SHA-256 sidecar is an integrity checksum, not an authenticity signature. State explicitly that candidate evidence has no Worker version ID and cannot be called deployed, physical, certified, or wedding-ready.

- [ ] **Step 3: Document the guarded future deploy path without running it**

Document the exact PowerShell variable flow from Task 6. Explain that the Vite plugin's built output config is the deploy source; Worker Version Metadata supplies ID/tag/timestamp; and the deploy wrapper tags the Worker version with the exact full candidate SHA. State that a separate deployment authorization is still required.

- [ ] **Step 4: Document the D1 certification contract**

In `docs/operations.md`, list the exact `release_certifications` fields and redacted physical-reference shape. State that no route or command in Increment 1 writes it, and that later readiness must match Worker version ID, build SHA, journey version, and migration digest exactly. Missing binding, empty/mismatched tag, unknown certification, pending migration, or malformed evidence fails closed.

- [ ] **Step 5: Preserve the `0010` rollout runbook**

Do not replace or shorten the lifecycle branch's IANA backfill/freeze/deploy-gap instructions. Add the local candidate gate around them while keeping remote `0010` operations and future `0011` application separate and explicitly authorized.

- [ ] **Step 6: Verify docs and commit**

```powershell
rg -n "verify:release|CF_VERSION_METADATA|guestJourneyVersion|migrationManifestSha256|release_certifications|not_run" README.md CLAUDE.md docs/deployment.md docs/operations.md
npm run typecheck
npm run lint
git diff --check
git add README.md CLAUDE.md docs/deployment.md docs/operations.md
git commit -m "docs: define release evidence operations"
```

---

### Task 10: Review, commit the final candidate, and run the immutable gate

**Files:**
- Review every path changed by Tasks 1–9.
- Modify only when a failing regression demonstrates an Increment 1 defect.
- Write generated evidence only under ignored `output/release/`.

- [ ] **Step 1: Run focused release-contract tests in the feature worktree**

```powershell
npx vitest run --config vitest.config.ts tests/unit/release.test.ts tests/unit/release-evidence.test.ts tests/unit/deploy-release.test.ts tests/unit/verify-fresh-d1.test.ts tests/unit/verify-release.test.ts
npx vitest run --config vitest.worker.config.ts tests/worker/migration-0010.test.ts tests/worker/migration-0011.test.ts tests/worker/release-certifications.test.ts tests/worker/release-identity.test.ts
npm run verify:bindings
npm run typecheck
npm run typecheck:e2e
npm run lint
git diff --check
```

Expected: all focused checks pass. Do not run `npm run deploy`.

- [ ] **Step 2: Review the complete branch against Increment 1**

Confirm:

- the lifecycle history is a two-parent merge, not duplicated patches;
- `0010` remains byte-identical to the reviewed lifecycle tip and `0011` is the sole next migration;
- no readiness/rehearsal/pilot/legal implementation entered the branch;
- runtime identity is internal and null for every missing/mismatched value;
- build SHA and migration digest are Worker-only literals, not mutable vars;
- candidate evidence contains no runtime Worker ID and makes no remote/manual claim;
- `verify:release` cannot invoke a remote/mutating Cloudflare command;
- the only non-dry deploy path requires exact evidence and always tags with the SHA;
- there is no remotely reachable certification writer; and
- the main checkout's protected untracked hashes still match Task 1.

- [ ] **Step 3: Request code review before final evidence**

Invoke `superpowers:requesting-code-review`. Require the reviewer to inspect Git provenance, migration numbering/constraints, fail-closed identity, config/client leakage, manifest redaction, path traversal and temp cleanup, command injection, local/remote boundaries, report-count parsing, bundle determinism, D1 invariants, and deploy-tag enforcement. Address findings through `superpowers:receiving-code-review`, with a failing regression and a new commit for every behavioral correction.

- [ ] **Step 4: Establish the immutable candidate SHA**

```powershell
$candidateSha = git rev-parse HEAD
if ($candidateSha -notmatch '^[0-9a-f]{40}$') { throw 'Expected a full lowercase commit SHA.' }
if (git status --porcelain=v1 --untracked-files=all) { throw 'The feature worktree must be clean before candidate verification.' }
git show --no-patch --format='%H %T %s' $candidateSha
```

Do not amend or add a documentation/evidence commit after this point.

- [ ] **Step 5: Run the single aggregate gate on that exact SHA**

```powershell
$candidateSha = git rev-parse HEAD
if ($candidateSha -notmatch '^[0-9a-f]{40}$') { throw 'Expected a full lowercase commit SHA.' }
if (git status --porcelain=v1 --untracked-files=all) { throw 'The feature worktree must still be clean.' }
npm run verify:release -- --sha $candidateSha --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
```

Expected: one detached temporary worktree is created and removed; every command exits zero; unit/UI, Worker, and Playwright counts plus the typed migration verification are present; first/second/dry-run bundles agree; bindings and fresh D1 pass; the approved committed range passes diff hygiene; initial/final status digests agree; manifest status is `passed`; all nonlocal claims are `not_run`; and the printed manifest SHA-256 matches its sidecar.

If any gate fails, fix the root cause in the feature worktree with a regression and commit it. Then loop back through Step 1's focused checks and Step 3's requesting/receiving-code-review workflow (at minimum, review the complete post-review delta), establish a new immutable SHA in Step 4, and rerun the complete aggregate command. Never hand off a candidate newer than the reviewed SHA, and never edit or relabel a failed manifest.

- [ ] **Step 6: Repeat read-only live drift checks without changing the candidate claim**

Rerun the complete read-only production script from Task 1 Step 2, including the exact remote `d1_migrations` ledger, active Worker version/binding-name assertions, critical live asset/route/MIME/header reads, foreign-key check, zero-sentinel check, and removed-trigger check. Then run:

```powershell
npx wrangler d1 migrations list candidary-core --remote
```

Expected: production still has a clean `0010` state and now reports `0011_release_certifications.sql` as pending because this plan deliberately did not apply it. These reads do not upgrade the local manifest's `remoteMigration: not_run` claim and do not certify the new candidate.

- [ ] **Step 7: Stop at the handoff boundary**

Report:

- feature branch and final candidate SHA/tree;
- the lifecycle merge parents;
- migration names `0010_event_start.sql` and pending `0011_release_certifications.sql`;
- candidate manifest path and SHA-256;
- exact automated counts and gate results;
- read-only remote drift facts separately;
- unchanged hashes for protected user files;
- no push, `main` merge, remote D1 write, deployment, binding/secret change, certification write, or physical-device claim; and
- the next required approval: review/integrate the candidate, then separately plan and authorize migration/deployment/post-deploy/physical certification work.

## Increment 1 Acceptance Trace

| Approved Increment 1 outcome | Planned proof |
| --- | --- |
| One canonical lifecycle source and migration history | Task 1 two-parent merge, exact SHAs, semantic seam review, remote `0010` reads |
| Existing visual debt does not invalidate the complete browser gate | Task 2 exact two-image recapture, side-by-side inspection, normal rerun |
| Checked-in guest journey contract | Tasks 3 and 5, `config/release.json`, shared parser tests |
| Runtime build and Worker version identity fail closed | Task 5 Worker-only defines, Version Metadata binding, tag equality, null tests |
| Runtime migration identity is available for later readiness matching | Tasks 4 and 5 deterministic digest injected into Worker identity |
| Redacted D1 certification contract exists without implicit certification | Task 3 migration, strict parser, local repository tests, no reachable writer |
| One aggregate immutable local gate | Tasks 8A–8B detached worktree runner, finalizer, and command-plan tests |
| Type, lint, unit/Worker, build, PWA, E2E, binding, D1, diff, and status gates run | Task 8A exact sequence; Task 10 final manifest |
| Manifest has SHA, versions, migrations, commands, counts, artifact hashes, and times | Task 4 schema and Tasks 8A–8B writer/parser tests |
| Evidence never conflates local, remote, deploy, physical, or certification claims | Manifest `claims` contract and Tasks 9–10 handoff |
| Deployment cannot silently create an untagged or different build | Task 6 exact-SHA/evidence/artifact guard and `--tag` tests |
| No unrelated user work or remote resource is mutated | Global constraints, Task 1 hashes, Tasks 8A–8B temp-path tests, Task 10 report |

# Mobile image preview release plan

Status: prepared locally on 2026-09-25 and corrected on 2026-09-26 (task C16) after a read-only
preflight of the preview account. On 2026-09-26 the owner approved the checkpoint-then-squash sequence
(29 candidate cases at 128 MiB) and authorized steps 1–8. **Step 1 is done:** preview D1 is at 0026,
applied through the import path described there, and the deployed root passed the old-code check.
Later steps are recorded in the task ledger as they complete. Each step marked **[authorization]** is
an external action that needs the release owner's explicit, separate approval. Earlier approvals (the
local implementation, the 20 MiB animated-preview cap, "Resume") do not cover any of them.

This plan applies the migration-first order in `docs/deployment.md` (**Mobile-image admission and
migration 0026**) to the **preview** environment only: migration first, private decoder second, main
Worker third, intake last. Production follows later under its own authorization.

## Decision required first: the commit sequence

The single-final-commit rule cannot be kept on an honest preview path. Three facts, each checked on
2026-09-26:

1. **The live lanes need the candidate deployed, not just uploaded under a branch alias.** The
   non-production Workers Build runs `npm run deploy:preview:built`, which is
   `wrangler versions upload --preview-alias`. In Wrangler 4.123.0, `versionsUpload` never registers
   Workflows. Only `deploy` does, through `triggersDeploy`, which sends `PUT /workflows/<name>` with the
   script and class. Cloudflare documents that a Workflow binding "runs that Workflow's deployed code
   and bindings", and that calling a Workflow that does not exist fails with `workflow.not_found`
   ([Previews: resources](https://developers.cloudflare.com/workers/previews/resources/)). The preview
   account has neither `candidary-upload-completion-preview` nor `candidary-image-preview-preview`.
   `candidary-preview-export` runs the deployed root's 0020-era code. On a branch alias, resumable
   completion, preview regeneration and the frozen ZIP would not run the candidate code.
2. **Only one repository path deploys the shared preview Worker, and it requires a clean, exact
   commit.** `npm run deploy:preview-cutover:built` runs `wrangler deploy --strict --tag <HEAD SHA>`.
   It refuses any tracked or untracked change (`assertDeploymentTreeClean` in
   `scripts/deploy-built.ts`). The deployed version is tagged with the Git SHA, so the deployed
   candidate has to be a commit.
3. **The preview candidate and the release need different release records.** Runtime admission reads
   the `config/*-release.json` files bundled at build time (`worker/mobile-image-release.ts`). Preview
   qualification needs candidate case records in that build. The final commit may contain only
   records whose local, live, iOS, Android and load evidence all verify.

Other routes technically avoid a second commit, but each removes the reviewable identity the rule
protects: a raw `wrangler deploy` of the dirty tree, hiding edits with `git update-index
--skip-worktree`, or deploying a detached commit object. None is offered here.

**Recommended; needs the owner's explicit approval: local checkpoint commits, then one squashed
commit.**

- **C1** (local only, never pushed) holds the complete implementation, the pinned decoder digest and
  the preview candidate records. Tag it locally as `mobile-image-preview-candidate-1`, so the SHA in
  the deployed version tag still resolves after the squash.
- **C2** (local only) holds the records-only change made once the evidence exists.
- **F** squashes C1 and C2 into one commit on `codex/mobile-image-compatibility` before the first
  push. `git diff mobile-image-preview-candidate-1 F --stat` must show only the release records, the
  corpus manifest, the release-record unit test and documentation. That proves the preview ran the
  final code. Pushing and opening the pull request need a further authorization.

The alternative is to push the checkpoints and squash-merge on GitHub. It is not recommended: pushing
C1 starts a Workers Build alias upload, publishes a branch that must never merge in its candidate
state, and still needs every check above.

## Read-only preflight, 2026-09-26

Plain `SELECT` statements and `GET` listings only; no resource was created, migrated, deployed or
pushed. `wrangler d1 migrations list --remote` was deliberately not used: it first runs
`CREATE TABLE IF NOT EXISTS d1_migrations` on the remote database. `wrangler containers images list`
was also skipped, because it mints short-lived push/pull registry credentials. The sanitized
evidence and the reusable script are in the ignored
`output/verification/mobile-image-research/c16-preview-preflight/`: `preview-preflight.mjs`,
`preflight-summary.json`, `preview-schema.json` and `preflight-population.json`.

| Check | Observed |
| --- | --- |
| Preview D1 ledger | 25 applied (last `0025_library_delivery_sequence.sql`, 2026-09-20); pending exactly `0026_mobile_image_compatibility.sql` |
| Preview D1 schema vs reviewed 0025 snapshot | 201 = 201 objects, none missing or extra. The stored SQL text differs for 14 objects (11 tables, and the triggers `media_object_write_tombstone_guard_update`, `media_stored_legacy_guard_update`, `media_trash_pair_update`). All 14 differ only in comments and whitespace: remote D1 stores migration SQL without comments. Zero semantic differences. 0026 drops and recreates its 30 triggers by name and never compares stored SQL text |
| Preview D1 population | 0 events, 0 media, 0 promotions, 0 write tombstones; export protocol `open` since 2026-08-28 |
| Deployed preview root | version `40755551-894f-4336-8897-df8973b28376` at 100%, tag `af68fba7` (2026-08-26, "fix: deploy workflows during gallery cutover"). It predates migrations 0021–0025. Bindings: 3 Workflows, no `IMAGE_DECODER`. The earlier assumption that the root ran the `fa4aae3` lineage was wrong |
| Workflows | Only `candidary-preview-{export,cover-render,cover-backfill}` and the production three. Both new preview Workflows are absent |
| `candidary-image-decoder-preview` | Does not exist (API code 10007) |
| Container applications | One unrelated application; none for Candidary |
| `origin/main` | `fa4aae3`, unchanged since 2026-09-25; no remote `codex/mobile-image-compatibility` branch |
| Wrangler OAuth scopes (C15) | Workers, D1 and Containers write; no Account Analytics read, so the load export needs a separate API token |

## Fixed facts

| Item | Value |
| --- | --- |
| Branch / worktree | `codex/mobile-image-compatibility`, isolated worktree; baseline `eceb405` |
| Preview D1 / R2 | `candidary-preview-core`; `candidary-preview-media`, `candidary-preview-media-canonical` |
| Preview main Worker | `candidary-preview` (root `https://candidary-preview.lfd.workers.dev`) |
| Private decoder twin | `candidary-image-decoder-preview` from `services/image-decoder/worker/wrangler.jsonc --env preview`; no route, no workers.dev URL |
| Migration | `0026_mobile_image_compatibility.sql` (marker `mobile_image_schema(1, 26, 1)`, 32 admission rows, all disabled) |
| Decoder image (local candidate) | `candidary-image-decoder:verification` (also `:b12h`) = `sha256:8d4ac6bec3609b0989b00c3cd9923ef9d696a5a199dee29f0c1c3e0e97d3c15c`, fingerprint `a4c238603f67f9c7ebfd9796fe4c722b773f75611b19d6c5b403db7fd8418651` |
| Corpus manifest SHA-256 (current) | `a8d314a8e02d3d9f9fdb02f5debe70633179db5439220033aba24094054fd07f` (changes when evidence pointers change) |
| Candidate cases | The 29 locally qualified cases. `heic-sequence` is missing, so HEIC/HEIF **sequence** declarations stay closed; the two Live Photo cases are device observations, not admission cases |

The candidate includes the approved 20 MiB animated-preview cap, lossless encoding and the 8 MiB
still cap. B12h's rendering union passes all 39 available fixtures. Any further native change needs a
rebuild, one union and refreshed pointers.

## Local preconditions (no authorization)

1. Native build and union on `a4c23860`: done (B12h). Corpus `--check-manifest`: structure valid,
   29/32. `verify-mobile-image-release --local`: valid, zero admitted, `universal: false`.
2. Fresh-clone simulation (C16): a throwaway repository with the fingerprint inputs, the corpus
   manifest and `.gitattributes` was committed, then cloned with `core.autocrlf=true` and `false`. Both
   clones' `lock-image-decoder --verify` print `a4c23860…`, and the manifest hash is unchanged. The
   real post-commit fresh clone is still required.
3. Registry CLI path (C16, no push): the Windows Docker CLI 29.8.0 (context `desktop-linux`) reaches
   the Docker Desktop engine 29.8.0 that holds the candidate image. The image is `linux/amd64`; its only
   RepoDigest is the local containerd one, which the release verifier refuses. WSL has no Linux Node,
   so run Wrangler from Windows PowerShell. `wrangler containers push` logs in through
   `docker login --password-stdin` with 15-minute push/pull credentials, then tags and pushes.
4. `.gitignore` now ignores `__pycache__/`. Two stray bytecode files would otherwise have left the
   tree dirty and blocked the clean-tree deploy.
5. Live-lane recorder (C18): `scripts/mobile-image-live-workflow.mjs` produces the `live-workflow`
   evidence that `verify-mobile-image-corpus.mjs` requires. Its status is in the task ledger; step 8
   depends on it.
6. Publication gates. These are repository-wide, so they run only when authorized, on F: `npm run
   cf-typegen` (no diff), `npm run typecheck`, `npm run typecheck:e2e`, `npm run verify:bindings`, the
   decoder service's `typecheck` and `verify:bindings`, `npm run lint`,
   `npm run ci:local -- --base origin/main --head <F>` (six lanes), and the local real-original
   integration with the native bridge.

## Remote sequence (preview)

### 1. Migrate preview D1 to 0026 **[authorization: remote D1 migration]**

a. *Optional, recommended.* Seed a small population through the deployed root (`af68fba7`) so 0026
   rebuilds real rows: create one dedicated event through the normal host flow, deliver two small JPEGs
   as a guest, and Trash and restore one of them as Manager. Record only the event ID privately. This
   also baselines the root: if any of these operations already fails on 0025, stop. The root is then
   incompatible with the current schema, and 0026 must not be applied until that is understood.

b. Immediately before applying, rerun the read-only preflight from the repository root:
   `node output/verification/mobile-image-research/c16-preview-preflight/preview-preflight.mjs`.
   Stop unless `ledger.pending` is exactly `["0026_mobile_image_compatibility.sql"]`,
   `schema.semanticallyEqualToReviewed0025` is `true`, and `schema.has0026Marker` is `false`. With
   seeding, the population counts will be non-zero.

c. Apply. **`wrangler d1 migrations apply --remote` cannot apply 0026.** On 2026-09-26 it failed on preview
   with HTTP 400 `incomplete input: SQLITE_ERROR [code: 7500]`, and a read-only check confirmed nothing
   had been applied. Remote `migrations apply` sends the whole file plus the ledger insert as one
   string to D1's `/query` endpoint, which processes it server-side. The same file applies locally,
   both through Wrangler `--local` (the Migration-safety lane path) and through the Worker test applier.
   At 61,313 bytes the query is nearly twice the largest migration D1 has accepted (32,965 bytes).
   That size is the prime suspect but is not proven; statement count, quoting, comments and `/*` were
   ruled out. Apply the byte-identical file, plus the exact ledger insert Wrangler appends, through
   D1's import pipeline instead. It runs in one transaction and restores the database on failure:

```powershell
$migration = Get-Content -Raw -Encoding utf8 migrations/0026_mobile_image_compatibility.sql
$sqlFile = Join-Path $env:TEMP '0026-with-ledger.sql'
[IO.File]::WriteAllText($sqlFile, $migration + "`nINSERT INTO `"d1_migrations`" (name)`nvalues ('0026_mobile_image_compatibility.sql');", [Text.UTF8Encoding]::new($false))
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --file $sqlFile
```

   Before running, confirm that the file starts with the committed migration's exact bytes (preview used
   61,313 bytes, prefix-identical). Production needs the same path, or a reviewed fix of 0026, before its
   migration step.

d. Verify, using `SELECT` statements only:

```powershell
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json --command "SELECT singleton, version, protocol FROM mobile_image_schema"
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --json --command "SELECT count(*) AS cases, sum(enabled) AS enabled FROM mobile_image_admission"
```

   Expected: `0026_mobile_image_compatibility.sql`; `1|26|1`; `cases = 32`, `enabled = 0`.

e. Old-code check on the version actually serving preview (`af68fba7`, not the `eceb405` baseline
   proved locally): entry exchange, one small JPEG direct upload and its receipt, Manager original
   download, and Trash and restore. Any seeded rows must still list and download. Extended intake
   stays closed.

### 2. Publish the decoder image **[authorization: registry push]**

From Windows PowerShell in the repository root:

```powershell
docker tag candidary-image-decoder:verification candidary-image-decoder:a4c23860
docker image inspect candidary-image-decoder:a4c23860 --format '{{.Id}}'   # sha256:8d4ac6be…
npx wrangler containers push candidary-image-decoder:a4c23860
docker logout registry.cloudflare.com
docker image inspect candidary-image-decoder:a4c23860 --format '{{json .RepoDigests}}'
```

**Executed 2026-09-26; `wrangler containers push` failed as written.** Docker Desktop's containerd image
store holds the build as an OCI index that also references a build-attestation manifest. All 17 layers
uploaded, then the registry rejected the index with `blob unknown to registry`. What worked, using
the same authorization:

1. Mint 15-minute credentials with `npx wrangler containers registries credentials
   registry.cloudflare.com --push --pull --json`. Read them in memory only, pass the password to
   `docker login --username <user> --password-stdin registry.cloudflare.com`, then run
   `docker push --platform linux/amd64 registry.cloudflare.com/<account>/candidary-image-decoder:a4c23860`
   and `docker logout registry.cloudflare.com`.
2. This pushes only the `linux/amd64` manifest, with the same config and layers. The registry
   digest is that manifest's, `sha256:d014ac551e24b9ce74737a4aebdd9c2f7d0ba0d4e50a2a87bd5fa4c5d3b82f80`,
   not the local index ID `8d4ac6be…`.
3. Do not trust the local RepoDigests afterwards. The containerd store recorded a registry RepoDigest
   carrying the index digest, which the registry never accepted. Pull the manifest back by digest with
   pull-only credentials, and qualify that reference. Its RepoDigest names exactly what the registry
   serves.

Record `registry.cloudflare.com/<account>/candidary-image-decoder@sha256:<digest>` privately. The
reference necessarily contains the account ID. It will appear in the committed decoder config and
release record: an identifier, not a credential. Then rerun the rendering union once on that image.
The report's `image.registryDigests` must list the registry reference, because the release verifier
matches native lanes by it. Use an explicit report path: the wrapper's `-Action verify` always writes
`output/verification/mobile-images/rendering-wsl.json` and would overwrite a retained report.

```powershell
$env:WSL_UTF8 = '1'
$root = (wsl.exe --distribution Ubuntu-26.04 --exec wslpath -a -u (Get-Location).Path).Trim()
wsl.exe --distribution Ubuntu-26.04 --cd $root --exec env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock python3 services/image-decoder/native/verify_service.py --image candidary-image-decoder:a4c23860 --manifest tests/fixtures/mobile-images/manifest.json --group rendering --report output/verification/mobile-images/rendering-registry-wsl.json
```

Expected: exit 1 with `complete:false`, only because `heic-sequence` has no file. 39 fixtures pass;
`runtime.privateLogsEmpty` is true; preview and source hashes are identical to B12h. Copy the report
to `tests/fixtures/mobile-images/evidence/<sha256>.json`. Replace all 39 `evidence.local` pointers
with it, and deep-compare the manifest to prove that nothing else changed. Then
`node scripts/verify-mobile-image-corpus.mjs --check-manifest` must report 29 qualified cases.

### 3. Candidate records and digest pin (local; part of the approved sequence)

- `services/image-decoder/worker/wrangler.jsonc`: in `env.preview.containers`, set both `image`
  values to the digest reference and remove their `image_build_context`. Production entries stay
  unchanged until production is authorized. A 2026-09-25 local `--dry-run` accepted this form with a
  placeholder account (`C8-wrangler-digest-dry-run.log`); the API's acceptance is unverified.
- Qualification record, SHA-named in the evidence root:
  `{ "kind": "mobile-image-qualification", "harnessVersion": 1, "buildFingerprint": "a4c23860…",
  "imageRef": "<digest reference>", "previewProfile": "mobile-preview-v1", "manifestSha256":
  "<manifest hash after the step 2 pointer update>", "maxOriginalBytes": 134217728, "caseIds": [<29>] }`.
  It has no `loadEvidenceSha256` until a load report exists.
- `config/image-decoder-release.json`: one release, `{ imageRef, buildFingerprint, protocolVersion: 1,
  previewProfile: "mobile-preview-v1", verifiedCaseIds: [<29>], evidenceSha256: <qualification> }`.
- `config/mobile-image-release.json`: 29 case records,
  `{ caseId, buildFingerprint, evidenceSha256: <qualification>, maxOriginalBytes: 134217728 }`.
  **Proposed candidate limit: 128 MiB.** That is above the largest declared load source (79,999,280 B)
  and a typical 48 MP ProRAW, and below the 512 MiB global candidate. It is a candidate, not a
  measured safe limit, and the owner must confirm it. The runtime limit is the minimum of the global
  cap, the D1 row and this record.
- `tests/unit/mobile-image-release.test.ts` reads the committed files as its empty baseline (lines
  10–11 and 51). Replace those with literal closed objects in the same change, so C1 and F both keep
  that test meaningful.
- Expected `node scripts/verify-mobile-image-release.mjs` (with explicit `--manifest`,
  `--fixture-root` and `--evidence-root`): the decoder release is accepted, every case is refused for
  missing live, iOS, Android and load evidence, and the result is `valid: false`, `admittedCaseIds: []`.
  That is the correct state for a preview candidate, and it must never merge.

### 4. Checkpoint commit C1 **[authorization: local checkpoint commit]**

Move the two session handoffs (`docs/verification/2026-09-2{5,6}-mobile-image-handoff.md`) to ignored
`output/verification/mobile-image-handoffs/`, unless the owner wants them committed. Then commit from
the worktree:

```powershell
git add -A
git diff --cached --name-only        # review against the allowlist; no originals/, references/, evidence/, output/, .dev.vars
git diff --cached --check            # only the ~424 preserved CR lines in CMakeLists.txt, decode_raw.cpp, dependencies.lock.json
git commit -m "feat: preview candidate for mobile image compatibility (checkpoint C1)"
git tag mobile-image-preview-candidate-1
git status --porcelain --untracked-files=all   # must print nothing
```

Clone C1 fresh twice, with `core.autocrlf=true` and `false`. Copy the dependency source cache into
each clone rather than linking it: `--verify` rewrites `build-identity.json` in that cache. Confirm
that `node scripts/lock-image-decoder.mjs --verify` prints `a4c23860…` in both.

### 5. Deploy the private preview decoder **[authorization: decoder deployment]**

From the clean C1 worktree:

```powershell
npx wrangler deploy --dry-run --config services/image-decoder/worker/wrangler.jsonc --env preview
npx wrangler deploy --config services/image-decoder/worker/wrangler.jsonc --env preview
npx wrangler versions list --name candidary-image-decoder-preview --json
npx wrangler containers list --json
```

Stop if the API rejects the digest form, and do not fall back to a mutable tag. Verify: no route,
workers.dev or preview URL; bindings `UPLOAD_DECODERS`, `PREVIEW_DECODERS` and `DECODER_METRICS`; two
container applications at the pinned digest. The Worker goes live before the container rollout
finishes, and the rollout is not transactional. Until instances report the pinned fingerprint, the
main Worker's health check keeps extended intake closed.

### 6. Deploy the candidate to the preview Worker **[authorization: preview cutover deployment]**

This replaces the deployed preview root (`af68fba7`) with C1. Freeze other preview uploads and
cutovers first, and confirm none is in flight.

```powershell
$env:WORKERS_CI_BRANCH = 'codex/mobile-image-compatibility'
$env:WORKERS_CI_COMMIT_SHA = (git rev-parse HEAD)
npm run build:cloudflare
npm run verify:pwa-build
npm run deploy:preview-cutover:built
Remove-Item Env:WORKERS_CI_BRANCH, Env:WORKERS_CI_COMMIT_SHA
npx wrangler deployments status --name candidary-preview --json
npx wrangler workflows list --per-page 100
```

Verify: the new version is at 100% with tag = C1's full SHA. Its bindings include
`IMAGE_DECODER → candidary-image-decoder-preview`, `IMAGE_METRICS` and five Workflows, including
`candidary-upload-completion-preview` and `candidary-image-preview-preview`. There is no Container or
Durable Object. A baseline direct JPEG upload works while every D1 case is still disabled. Rollback:
before any extended write, `npx wrangler rollback 40755551-894f-4336-8897-df8973b28376 --name
candidary-preview` restores the previous root. After extended writes, only schema-26-compatible code
is a valid target.

### 7. Open the candidate cases on preview only **[authorization: preview D1 write]**

```powershell
npx wrangler d1 execute candidary-preview-core --remote --env preview --config wrangler.jsonc --command "UPDATE mobile_image_admission SET enabled = 1, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE case_id IN ('jpeg-baseline','jpeg-progressive','jpeg-exif-orientation','jpeg-hdr','jpeg-ultra-hdr-gainmap','jpeg-motion-photo-still','png','apng','webp-lossy','webp-lossless','webp-animated','heic-primary','heic-grid','heic-auxiliary','heif-generic','dng-bayer','dng-linear','dng-proraw','dng-jpeg','dng-proraw-jxl','avif-still','avif-sequence','gif-still','gif-animated','tiff','bmp','jp2','jxl-still','jxl-animated')"
```

The revision trigger rejects anything but `+1`. Closing uses the same statement with `enabled = 0`.
Verify as a guest on a dedicated event: `GET /api/event/<slug>/uploads/capabilities` lists the
extended types with `maxOriginalBytes` 134217728. If any decoder instance still reports another
fingerprint, the endpoint must stay closed; record that observation as the mixed-rollout check.

### 8. Deployed original/privacy/deletion lane **[authorization: live preview tests]**

Use the C18 recorder on one dedicated preview event. Run the dry run first, then the live run with a
private authorization file (preview origin, event, expiry within 72 hours, credentials path,
`identity` = fingerprint, digest reference and the step 6 version ID, and the case list), plus
`CANDIDARY_LIVE_WORKFLOW_CONFIRM=I_UNDERSTAND`. For every fixture it performs a negotiated upload, a
stored receipt, owner and Manager preview allowed, other guest and signed-out denied, intake paused,
the direct original and frozen ZIP member at the source SHA-256, Trash and Restore with an unchanged
original, then guest permanent deletion with every read denied. It writes one SHA-named
`live-workflow` document. Paste its pointer into each fixture's `evidence.live` and run
`--check-manifest`.

### 9. Load rehearsal **[authorization: live preview load, one per scenario; Cloudflare API read]**

Follow `docs/verification/mobile-image-load-rehearsal.md` without reducing the workload. It moves
about 1.07 TB up and 1.07 TB down across cold, warm and mixed. It needs 13 dedicated events created
through the product, three expiring authorization files, an otherwise idle preview, a
well-connected load host, and an API token with *Account Analytics: Read*; the OAuth session lacks
that scope. Deleting the rehearsal data afterwards is a separate authorization.

### 10. Physical devices

Follow `docs/verification/mobile-image-device-protocol.md`: a Pro iPhone for ProRAW and Live Photo,
Pixel/Samsung hardware for Ultra HDR, Motion Photo and RAW, a Mac for Safari Web Inspector, a tester,
and consent for any captures.

### 11. Records-only checkpoint C2 **[authorization: local checkpoint commit]**

Regenerate the qualification record with the final manifest hash and `loadEvidenceSha256`. Keep a
case record only if its local, live, iOS, Android and load evidence all verify. Remove failed,
missing and platform-limited cases from `config/mobile-image-release.json`, and close their preview
D1 rows. Run the release verifier with explicit roots; it must print `valid: true` with exactly the
qualified cases. `universal` stays `false` while any required case is missing, failing or
platform-limited.

### 12. Squash, gates, push **[authorization: squash, repository gates, branch push]**

```powershell
git reset --soft eceb4053b572562ed00247a7c6469a2599416723
git commit -m "<final scoped message>"
git diff mobile-image-preview-candidate-1 HEAD --stat   # records, manifest, release test, docs only
```

If `origin/main` has advanced, rebase before the squash. Rerun whatever the rebase affects, and state
which preview evidence it invalidates. Then run a real fresh-clone `lock-image-decoder --verify`
(`a4c23860…`), confirm the manifest hash equals the qualification record's, run the publication
gates listed under local preconditions on F, then push and open the pull request. Merging is part of
the production release: production migration first, then the production decoder, then the merge
build. Each needs separate authorization.

## Authorizations to request, in order

| # | Action | Remote effect | Reversal |
| --- | --- | --- | --- |
| 0 | Approve the checkpoint-then-squash sequence, the 29 candidate cases and the 128 MiB candidate limit | none | — |
| 1 | Seed (optional) and migrate preview D1 to 0026, then the old-code check | preview schema change | Forward-only; never drop 0026 |
| 2 | `wrangler containers push` of `a4c23860` | registry image in the account | Image deletion; the digest stays recorded |
| 4 | Local checkpoint commit C1 and tag | none (local) | Local reset |
| 5 | Deploy `candidary-image-decoder-preview` | new private Worker and containers | Delete the Worker |
| 6 | Preview cutover of `candidary-preview` to C1 | preview root serves the candidate | Rollback to `40755551…` before extended writes only |
| 7 | Enable the 29 preview D1 cases | preview extended intake opens | Same SQL with `enabled = 0` |
| 8 | Live original/privacy/deletion lane | preview data | Product deletion |
| 9 | Three load scenarios and the Analytics export | ~2.14 TB of transfer; ~1.07 TB stored | Product deletion (separate authorization) |
| 11–12 | C2, squash, repository gates, push | branch on GitHub | — |

## Rollback

Close the D1 rows first (`enabled = 0`); this stops new extended intake immediately. After any
extended original or native preview exists, keep a schema-26-compatible reader/export/cleanup
version. The deployed pre-0026 root (`af68fba7`) and any pre-0026 Worker are **not** valid rollback
targets after that point. Never drop 0026, restore a pre-migration database, or delete retained write
inventories.

## Remaining external prerequisites

- The commit-sequence decision and explicit authorization for each bracketed step.
- An API token with *Account Analytics: Read* for the load export; the OAuth session lacks that scope.
  Registry publication and the API's acceptance of the digest form remain unverified until step 2.
- Lawful HEIC-sequence originals, or a consented platform-produced HEICS with an independent
  reference, and consented physical Live Photo observations.
- Physical iPhone and Android devices, a Mac with Safari Web Inspector, a tester, and consent for any
  captured test photos.
- A load-generation host with enough bandwidth and an otherwise idle preview window.

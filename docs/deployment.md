# Deployment

## Provision Cloudflare resources

Create one D1 database and one private R2 bucket, enable Cloudflare Images for the account, then confirm the IDs, names, and public origin in `wrangler.jsonc`.

```powershell
npx wrangler d1 create candidary-core
npx wrangler r2 bucket create candidary-media
```

The Worker uses an `IMAGES` binding for metadata-free browser previews, including HEIC and HEIF. Confirm the account plan and Images availability before deploying; preview failure never removes an already delivered original, but hosts need the binding to view phone formats cross-browser.

The R2 CORS policy names every application origin, so it has to be reset whenever that set changes — a signed browser `PUT` comes from the page, not from the Worker, and a missing origin fails every upload from that hostname while leaving the rest of the app working. Set it after replacing the example origins:

```powershell
Copy-Item config/r2-cors.example.json config/r2-cors.json
npx wrangler r2 bucket cors set candidary-media --file config/r2-cors.json
```

The committed policy lists `candidary.app` and `candidary.online` because both serve the application. This list and `APP_ORIGIN`/`ALTERNATE_ORIGINS` have to hold the same origins: nothing checks them against each other, and a hostname present in one but not the other produces a front door where every page loads and no photo uploads.

The bucket remains private. CORS permits signed browser PUT requests from the application origin with the signed `content-type` header. Originals are manager-only; previews are authorization-checked; export links are short-lived and manager-only.

## Application origins

Candidary answers on `candidary.app` and `candidary.online`, and both are real front doors rather than
one origin and one redirect. Two vars say so. `APP_ORIGIN` is the canonical origin, and
`ALTERNATE_ORIGINS` is a comma- or whitespace-separated list of the others; `worker/origins.ts` reads
both and is the only place that decides what counts as this application.

Two rules follow from it, and they are deliberately different:

- **Every write is checked against the whole set.** `assertRequestOrigin` in `worker/http/csrf.ts` tests
  membership, not equality, so a create, an upload, an RSVP, or a sign-in works from either hostname.
  Comparison is normalized, so a trailing slash or an explicit `:443` in the config does not fail a
  write. A request with no `Origin` header still fails: no header is not one of the origins.
- **Every link handed to a browser is built on the origin the request arrived on.** `requestOrigin`
  reads it from the request URL rather than the `Origin` header, because a `GET` navigation carries
  none. A host who works on `candidary.online` prints a QR on `candidary.online` and rotates into a
  management link on `candidary.online` — that last one matters, because the client follows the returned
  link with a full-page navigation and a canonical link would move them to the other domain mid-session.
  A hostname the deployment does not answer on falls back to the canonical origin instead of echoing
  itself. The hosts that reach the Worker are this account's own — a Custom Domain requires a zone the
  account controls. The committed Wrangler configuration explicitly disables both the `workers.dev`
  route and Preview URLs because uploaded versions use the production bindings and Preview URLs are
  otherwise public. The application-level origin check remains defense in depth if either route is
  re-enabled or configuration drifts. Echoing an unknown host back would put its hostname into a
  printed QR or a management link a host then saves.

**A credential is never exchanged off an application host.** `GET /manage/:token` and the pre-0008
`GET /join/:token` are the only places a bearer credential becomes a session through a navigation, and a
navigation carries no `Origin` header, so `assertRequestOrigin` cannot reach them and every other guard
runs after the session exists. `worker/routes/exchange.ts` checks the request's own host first and sends
an unrecognized one to the canonical origin's recovery page without the credential. Writes from such a
host would already fail, but a session still *reads* — a manager session reads event data and
re-displays the printed entry credential — so the boundary has to sit ahead of the exchange. The same
check on the browser side keeps management-link recovery from offering the move in the first place;
neither side is sufficient alone, because the URL can be typed.

**Mail is the exception and stays canonical.** `services/notifications.ts` and
`services/host-auth.ts` build from `APP_ORIGIN` always. Notifications are composed by the hourly Cron,
where there is no request to take a host from, and a `From` domain that differs from the domain of the
links inside the message still passes SPF, DKIM, and DMARC — nothing fails loudly, it just reads as a
phishing attempt to the host being asked to click a login code.

Adding a hostname is four settings, and skipping any one of them produces a front door that looks like
a working deployment until someone tries to do something:

1. Attach it to the Worker as a Custom Domain, and confirm **Always Use HTTPS** and the HSTS
   preconditions below for its zone.
2. Add it to `ALTERNATE_ORIGINS` and deploy. Without this the hostname renders the SPA and then fails
   every write with `ORIGIN_FORBIDDEN`.
3. Add it to `config/r2-cors.json` and apply the policy. Without this every page works and every photo
   upload fails at the browser-direct `PUT`.
4. Add it to `KNOWN_APPLICATION_ORIGINS` in `shared/origins.ts`. Without this a host who was mailed a
   management link on the canonical origin cannot paste it while on the new one.

The fourth is the one that looks optional and is not. The browser cannot read `ALTERNATE_ORIGINS`, so
that constant is its copy of the list. `tests/unit/origins.test.ts` reads `wrangler.jsonc` off disk and
fails if the two disagree, which catches the omission at build time — but only if steps 2 and 4 land in
the same commit.

There must be no zone Redirect Rule sending one application origin to another; a `301` at the edge runs
ahead of the Worker and would make the second hostname unreachable no matter what the Worker allows.
When scoping any other rule on these zones, name the host rather than matching everything —
`forum.candidary.online` is a Custom Domain for a different Worker on the same zone, and an unscoped
`true` expression would swallow it.

Confirm each origin after deploying, because the read path and the write path fail separately and only
the write path is silent from a browser tab that is already open. Post a deliberately invalid body: the
origin check runs before the schema does, so the two outcomes are distinguishable and neither creates an
event.

```powershell
foreach ($host in 'candidary.app', 'candidary.online') {
  curl.exe -sS -X POST "https://$host/api/events" -H 'content-type: application/json' `
    -H "origin: https://$host" --data '{}'
}
```

Expected `VALIDATION_FAILED` from every origin. `ORIGIN_FORBIDDEN` means that hostname is serving pages
it cannot accept a write from — it is attached to the Worker but missing from `ALTERNATE_ORIGINS`, or the
deployed version predates its addition. Check what is actually deployed rather than what was uploaded:
a version upload from a branch build changes the script's settings without changing the version serving
traffic.

Cookies are scoped to a host, so the two origins do not share sessions. A host signed in on one is not
signed in on the other, a guest who scanned a QR on one re-scans if they arrive on the other, and an
RSVP household is looked up per origin. Nothing in D1 or R2 is per-origin: one credential is one row and
resolves on every front door, which is why moving between them costs a session and never an event.

Retiring an origin is the expensive direction. Every QR printed while it was serving carries it, and a
QR already on a sign cannot be recalled — so a hostname that has ever been minted into printed
credentials keeps needing either a Custom Domain or a Redirect Rule for as long as those invitations
exist. Changing which origin is canonical is cheaper: it moves only where mail points and where an
unrecognized host falls back.

## Transport security

Enable **SSL/TLS → Edge Certificates → Always Use HTTPS** for the zone. A plain-HTTP request is then redirected at the edge and never reaches the Worker. Leave the **HSTS** card in that same panel switched off — the policy ships from the repo instead, and the check at the end of this section catches it if both are on.

Both response surfaces send `Strict-Transport-Security: max-age=31536000; includeSubDomains`: `worker/http/security-headers.ts` for the paths in `assets.run_worker_first`, and `public/_headers` for everything the asset server answers directly — including `/`, which is where most first visits land. The Worker emits it only when the request URL scheme is `https:`, as RFC 6797 requires, so its absence under `npm run dev` over localhost is correct rather than a regression.

The value is pinned once per surface — `tests/unit/static-headers.test.ts` reads `public/_headers` off disk, and `tests/worker/security-headers.test.ts` exercises the middleware in workerd. Neither test can see the other's surface, so a green `npm run test:unit` says nothing about the Worker's copy; only `npm test` covers both.

Both zones carry the policy, and both need the same two switches. Before changing either apex, confirm no subdomain is expected to answer over plain HTTP. `includeSubDomains` commits every subdomain to HTTPS for a year and cannot be withdrawn from browsers that already saw it. The 2026-07-28 audit found only the mail return-path subdomain `cf-bounce`, which carried DNS records rather than an HTTP service. The 2026-08-04 recheck adds `cf-bounce.candidary.app`, also DNS-only, and `forum.candidary.online`, which is an HTTP service — a Custom Domain for a different Worker — but one Cloudflare already serves over HTTPS, so the commitment costs it nothing. Recheck both zones before any later policy change. `preload` is omitted on purpose.

After deploying, confirm exactly one policy is in force on each origin:

```powershell
(curl.exe -sSI https://candidary.app/ | Select-String 'strict-transport-security').Count
(curl.exe -sSI https://candidary.online/ | Select-String 'strict-transport-security').Count
```

Expected `1`. A `2` means the zone's own HSTS setting is on as well and is appending a second policy, which may carry a different max-age — switch the dashboard setting off rather than reconciling the two. Keeping one source in the repo is what keeps the value under version control and under test.

## Secrets

Generate independent 32-byte values and store them with Wrangler. The guest encryption value is base64url-encoded for AES-256-GCM.

```powershell
npx wrangler secret put TOKEN_HMAC_KEY
npx wrangler secret put SESSION_HMAC_KEY
npx wrangler secret put GUEST_TOKEN_ENCRYPTION_KEY
npx wrangler secret put LOGIN_HMAC_KEY
npx wrangler secret put ENTRY_HMAC_KEY
npx wrangler secret put ENTRY_ENCRYPTION_KEY
npx wrangler secret put RSVP_LOOKUP_HMAC_KEY
npx wrangler secret put GUEST_MESSAGE_HMAC_KEY
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

Scope the R2 credentials to the single Candidary bucket with object read/write permissions. Never reuse the token or session HMAC key. Both encryption values are base64url-encoded 32-byte keys.

Four of these are **persisted-data keys, not rotation controls**. `ENTRY_HMAC_KEY` digests the credential printed on every invitation, `ENTRY_ENCRYPTION_KEY` encrypts the same credential for redisplay, `RSVP_LOOKUP_HMAC_KEY` keys every stored name digest and RSVP rate-limit scope, and `GUEST_MESSAGE_HMAC_KEY` keys durable Guestbook replay receipts plus session/IP rate-window digests. Rotating the Guestbook key requires a coordinated re-HMAC migration or an explicit invalidation decision; ordinary credential rotation is unsafe while receipts remain. Signing guest devices out and rotating a management link must never touch these four. Verify only their names in release evidence, never their values, and provision them through secret-safe tooling rather than shell history.

All ten are listed under `secrets.required` in `wrangler.jsonc`. That declaration is the source of truth for generated binding types and makes Wrangler refuse to deploy a Worker whose required secret is missing, so a forgotten value fails the upload rather than the first Guestbook submission. Run `npm run cf-typegen` after changing it.

## Rate-limiting bindings

The active post-cutover inventory has exactly three isolated Cloudflare rate-limit bindings:
`HOST_AUTH_RATE_LIMIT` (`1001`, 20 per 60 seconds), `RSVP_LOOKUP_RATE_LIMIT` (`1002`, 30 per 60
seconds), and `GUEST_MESSAGE_RATE_LIMIT` (`1003`, 120 per 60 seconds per event/trusted client IP).
The Guestbook limiter is coarse edge shedding; D1 separately enforces durable session and IP windows.
Historical Phase-2/Phase-3 candidate evidence still correctly records only the first two bindings.
Confirm the exact target-specific namespace IDs before release; staging uses separately authorized
nonproduction identities (the post-cutover baseline reserves `2003` for Guestbook).

## Build immutable local candidate evidence

Commit the complete candidate before running the aggregate gate. The SHA and approved base must be
full lowercase commit IDs; a branch name, `HEAD`, shortened SHA, or another ancestor is refused.

```powershell
$reviewedSha = git rev-parse HEAD
$approvedBaseSha = '0b92387d2e237d568d2514373dcc3044e7960d4b'
if ($reviewedSha -notmatch '^[0-9a-f]{40}$') { throw 'Expected a full lowercase commit SHA.' }
npm run verify:release -- --sha $reviewedSha --base-sha $approvedBaseSha
```

`verify:release` creates a detached `candidary-release-` worktree under the OS temporary directory,
imports that commit's own dependency-free runner, installs dependencies there, and removes the
worktree through Git before finalizing evidence. Dirty or untracked files in the caller checkout are
irrelevant and untouched. Its command plan is local-only: binding generation, application and E2E
typechecks, lint, unit/UI and Worker tests, two production builds with PWA checks around Playwright,
a strict Wrangler **dry run**, a new local D1 containing every migration, diff hygiene, and final
detached-SHA/tree/status checks. It never uses `--remote` and never writes remote D1, R2, bindings,
secrets, or a Worker version.

Successful bootstrap writes exactly:

```text
output/release/<candidate-sha>/<run-id>/candidate-manifest.json
output/release/<candidate-sha>/<run-id>/candidate-manifest.json.sha256
```

The manifest includes the candidate SHA, approved base, Git tree, guest-journey version, lockfile,
source-Wrangler hash, and deploy-Wrangler hash, plus tool versions, command
IDs/times/durations/exit codes, exact Vitest and Playwright counts, fresh-D1 results, normalized
binding topology, and Worker/client artifact hashes.
The content-bound `migrationManifestSha256` is SHA-256 over canonical JSON of the ordered migration
`{ path, sha256 }` pairs after CRLF-to-LF normalization. The fresh-D1 report's separate `ledgerSha256` hashes canonical JSON of the
ordered filenames only; the two digests are deliberately not interchangeable.

Artifact evidence covers the generated Worker main, every regular client asset selected by the
generated Vite/Wrangler config, and a canonical deploy config containing every production-target
value. Only the checkout-local `configPath` and `userConfigPath` provenance fields are omitted from
that deploy config. First build, Playwright rebuild, and dry-run Worker hashes must agree.
The Worker contains the exact candidate and migration literals; client JS/HTML contains neither.
Secret-file names, links, unexpected dry-run files, report output, environment values, command output,
absolute temporary paths, and unsafe free-form strings are never serialized.

The adjacent sidecar is exactly `<sha256>  candidate-manifest.json\n`, hashing the final canonical
manifest bytes including their trailing newline. This unkeyed SHA-256 is an integrity checksum, not
an authenticity signature. Bootstrap failures before safe output creation write no manifest; closed
candidate failures after that boundary write a schema-valid failed manifest.

The five claims are intentionally separate. Only `claims.localAutomated` can become `passed`; the
`remoteMigration`, `deployment`, `physicalDevices`, and `runtimeCertification` claims remain
`not_run`. Candidate evidence has no Worker version ID. It must not be described as migrated,
deployed, physically verified, certified, wedding-ready, or production-ready.

## Migrate and deploy only with separate authorization

Local candidate evidence does not authorize a remote migration or deployment. Inventory the remote
ledger and follow the migration-specific runbook first, under its own approval. Do not apply every
pending migration merely because it is checked in: `0010_event_start.sql` has the data-aware procedure
below, `0011_release_certifications.sql` is a distinct, later schema operation and does not
certify anything by being applied, and `0012_event_cover_storage.sql` is a third, later still — and
applying it is not authorization to run the cover backfill that follows it.

After the approved remote migration state is compatible, select the passed manifest for the exact
clean checkout and request deployment authorization separately:

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

The guarded wrapper requires an exact clean SHA/tree, validates the manifest and sidecar, runs
`npm ci`, rebuilds, rechecks PWA assets, and requires artifact/binding identity to match before it can
reach Wrangler. It copies only the verified Worker, client, and canonical deploy-config bytes into an
operator-owned temporary snapshot, verifies that snapshot again, and makes Wrangler read from the
snapshot rather than the caller's ignored, writable `dist/`. The only live deploy command is strict
and tags the Worker version with the full reviewed SHA. Cloudflare
Worker Version Metadata supplies the runtime version ID, tag, and timestamp through
`CF_VERSION_METADATA`; runtime identity fails closed unless the tag equals the embedded build SHA.
The wrapper does not migrate D1 and does not create a certification row.

### Historical Phase 3 release sequence — immutable 14-migration contract

The current boundaries are exact: the Phase-2 proof has 13 migrations and ends at
`0013_guest_message_hardening.sql`; the Phase-3 candidate has 14 and adds only
`0014_event_cover_invariants.sql`. The older cover plan called the invariant migration `0013` before
the guest-message migration was integrated. Do not rename either file, reuse the old number, or infer
a migration boundary from prose in a historical plan.

The active source/config baseline now has 15 migrations and ends at
`0015_curated_private_guestbook.sql`, three rate-limit bindings, and the new required persisted-data
secret. Those local changes do not amend or supersede the historical candidate/staging artifacts
below. Production secret provisioning, deployment, remote migration, runtime certification, policy
approval, and physical-device acceptance each remain separately authorized evidence gates.

Each row below requires its own named authorization and evidence. Passing one row does not authorize
the next.

| Gate | Required action and proof | Explicitly still unproven |
| --- | --- | --- |
| Local candidate | Commit a clean Phase-3 head, run the complete local gate and `verify:release`, then independently review the exact SHA and manifest/sidecar. | Any remote resource, platform behavior, deployment, production state, or physical device. |
| Workflow-conformance staging | On isolated disposable resources ending at migration 0013, deploy the exact Phase-3 Worker with no route, `workers.dev`, preview URL, or cron. Prove the Phase-3-modified `CoverBackfillWorkflow`, then destroy every resource and verify absence. | User-serving cutover behavior. These resources and fixtures may not be reused by cutover staging. |
| Cutover staging | Initialize a different empty D1 through 0013, deploy the exact Phase-2 proof at 100%, apply only 0014, prove the Phase-2 reader/publication/removal/hard-purge canaries, deploy the exact Phase-3 candidate at 100%, then prove real Images, render Workflow, delivery, Studio, recovery, and browser matrices. Destroy everything and verify absence. | Landing, production, or physical-device support. |
| Staging evidence | Finalize and independently verify the canonical artifact and sidecar only after both staging topologies and all fixtures are absent. | Permission to push or mutate production. |
| Exact-SHA landing | With a new authorization naming the expected old `origin/main` and candidate SHA, fast-forward that exact SHA only and re-read the remote ref. | Production migration or deployment. |
| Production cutover | Reverify landing, candidate, staging artifact, production topology/ledger/zero counts, and a fresh Time Travel bookmark. Apply only 0014, prove the still-deployed Phase-2 Worker, then deploy only the staged Phase-3 SHA and close runtime checks. | iPhone, Android, VoiceOver, TalkBack, or wedding-readiness evidence. |
| Physical acceptance | Run the separately named real-device and assistive-technology matrix against the exact deployed SHA. | Nothing may substitute for the named physical observations. |

#### Strict staging inputs and outputs

Every external JSON input is canonical, regular, nonsymlinked, exact-schema data beneath ignored
`output/staging-input/`; unknown, duplicate, empty, path-escaping, secret-shaped, or production-reusing
fields fail closed. The v1 target descriptor has exactly the top-level keys `kind`, `schemaVersion`,
`purpose`, `accountId`, `worker`, `d1`, `r2`, `images`, `assets`, `email`, `rateLimits`, `workflows`,
`crons`, `vars`, `requiredSecretNames`, `observability`, `placement`, `expiresAt`, and `cleanupOwner`.
Its nested contract names:

- Worker name, routes, `workersDev`, and `previewUrls`;
- D1 `DB`, R2 `MEDIA_BUCKET`, Images `IMAGES`, assets `ASSETS`, Email `EMAIL`, both rate-limit
  bindings with their fixed limits, and all three Workflow bindings/classes;
- cron list; `APP_ORIGIN`, `ALTERNATE_ORIGINS`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, and `EMAIL_FROM`;
- the exact required secret-name set, smart placement, observability state, expiry, and cleanup owner.

It contains no secret value, token, object key, private URL, private image, or reusable production
identity. `purpose: workflow-conformance` additionally requires empty routes/crons and false
`workersDev`/`previewUrls`; `purpose: cutover` may expose only the separately authorized staging
topology. The review authorization binds approved main, the 13-migration Phase-2 SHA/manifest digest,
the 14-migration Phase-3 SHA/manifest digest, reviewer, issue time, and expiry. The staging
authorization binds its review digest, run ID, both candidate SHAs, both target digests, allowed
modes/crons, all three expected schema digests, issue/expiry times, and cleanup owner.

The sanitized evidence input and final output use the exact
`candidary.staging-conformance` v1 schema: `status: passed`, candidate/run/approved-main identity;
Phase-2 and Phase-3 source/manifest/migration-manifest digests; both authorization and target digests;
the 13- and 14-file ledgers, bootstrap/migration/bundle hashes, nine trigger names, integrity,
foreign-key result, and four zero counts; three deployment version/tag/metadata/100%-traffic records;
complete Images, Backfill Workflow, Render Workflow, route, and browser case matrices; complete
absence booleans for both topologies; and start/finish times. It is written as canonical JSON plus
`staging-conformance.json.sha256` beneath
`output/staging/<phase3-sha>/<run-id>/`. `finalize` re-derives source and bundle hashes; `verify`
independently rechecks both manifests, authorizations, the artifact bytes, sidecar, all matrices, and
both destruction records.

#### Guarded staging commands

Populate every variable below only from the separately approved descriptors and canonical artifacts:

```powershell
npm run release:staging -- initialize --candidate-root $phase2Root --sha $phase2Sha --manifest $phase2Manifest --target $workflowTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId --through 0013_guest_message_hardening.sql
npm run release:staging -- deploy --candidate-root $phase3Root --sha $candidateSha --manifest $candidateManifest --target $workflowTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId

# After conformance passes, destroy that entire topology and verify absence.
npm run release:staging -- initialize --candidate-root $phase2Root --sha $phase2Sha --manifest $phase2Manifest --target $cutoverTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId --through 0013_guest_message_hardening.sql
npm run release:staging -- deploy --candidate-root $phase2Root --sha $phase2Sha --manifest $phase2Manifest --target $cutoverTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId
npm run release:staging -- migrate --candidate-root $phase3Root --sha $candidateSha --manifest $candidateManifest --target $cutoverTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId
# Prove the Phase-2 compatibility canaries under 0014 before this upload.
npm run release:staging -- deploy --candidate-root $phase3Root --sha $candidateSha --manifest $candidateManifest --target $cutoverTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --run-id $runId

# After every real-platform matrix passes and both topologies are destroyed:
npm run release:staging -- finalize --sha $candidateSha --manifest $candidateManifest --phase2-manifest $phase2Manifest --workflow-target $workflowTarget --cutover-target $cutoverTarget --review-authorization $reviewAuthorization --authorization $stagingAuthorization --evidence-input $sanitizedEvidenceInput --run-id $runId
npm run release:staging -- verify --artifact $stagingArtifact --sidecar $stagingArtifactSidecar --manifest $candidateManifest --phase2-manifest $phase2Manifest --review-authorization $reviewAuthorization --authorization $stagingAuthorization
```

For each remote mode the wrapper rebuilds and rehashes the exact source, then creates only
`output/staging/<candidate-sha>/<run-id>/deploy-root/`. That owned root contains the verified
`dist/candidary/wrangler.json`, Worker bundle/files, `dist/client/`, and `migrations/` in their original
relative layout. A closed overlay replaces or disables every production-capable binding. Wrangler
runs from that root with `--config dist/candidary/wrangler.json`; the wrapper rehashes the files and
removes the entire owned root after the command. Never copy a bare config elsewhere or let relative
`main`, assets, or `migrations_dir` paths resolve against a caller-owned directory.

Empty-D1 initialization and the 0014 cutover deliberately do **not** use
`wrangler d1 migrations apply --remote`. Pinned Wrangler 4.113.0 cannot parse the repository's
compound `0008_event_rsvp.sql` through that path. The wrapper instead generates one manifest-hashed
file containing the exact ordered migration bytes and deterministic ledger writes, then invokes only
the repository-pinned `wrangler d1 execute DB --remote --config dist/candidary/wrangler.json --file
<owned-bundle>`. D1's file-import boundary is atomic remotely; the pinned local implementation uses a
single `db.batch()`. The wrapper does not add `BEGIN`/`COMMIT` because D1 rejects explicit transaction
SQL in this API. A failed bootstrap must re-prove the same database entirely empty before retry; any
residue requires verified destruction and a new descriptor/authorization. A failed 0014 import must
re-prove the exact 13-file ledger/schema pre-state. Never synthesize a ledger row, resume a partial
prefix, use `migrations apply`, upgrade Wrangler during the run, or reuse a failed disposable D1.

#### Production migration-first cutover

Remote migration is first because `0014` is explicitly tested with the exact Phase-2 writer and hard
purge. This leaves the Phase-2 Worker as the rollback deployment while the new triggers are proved.
The production authorization is a strict v1 record binding run ID, approved main/candidate/manifest,
canonical production topology/account/D1, `0014` name and migration/bundle hashes, Time Travel
bookmark digest, pre/post schema hashes, authorization/expiry times, and named no-deploy-window and
rollback owners. The bookmark is a separate exact v1 record binding the same account/D1 plus bookmark
ID and recording time. With those inputs, and only after the independently verified staging artifact:

```powershell
npm run release:migrate -- --sha $candidateSha --manifest $candidateManifest --authorization $productionAuthorization --bookmark $timeTravelBookmarkArtifact
# Keep Phase 2 at 100% and prove reader, publication, removal, and hard purge under 0014.
npm run deploy -- --sha $candidateSha --manifest $candidateManifest
```

`release:migrate` accepts only those four flags, verifies the exact clean landed 14-migration
candidate, canonical production topology, bookmark/authorization digests, 13-file ledger, sole pending
0014, four zero counts, integrity, foreign keys, and pre-schema hash before it runs the hashed atomic
single-file import. It then requires the exact 14-file ledger, nine triggers, post-schema hash, zero
counts, integrity, and foreign keys. `npm run deploy` remains the only Worker deployment command and
does not migrate. Require one 100% version whose tag and `CF_VERSION_METADATA` equal the reviewed SHA,
then verify protected negatives, nested projections, current/stale slots, preset redirect, upload
no-store bytes, cover-only refresh, D1 integrity/zero counts, and fixture R2 inventory.

If migration fails, do not deploy. If the migration succeeds but the Phase-2 canary fails, keep Phase
2 at 100%, preserve the bookmark/evidence, and let the named rollback owner choose a reviewed forward
repair or restore after accounting for post-bookmark writes. If Phase-3 upload or runtime checks fail,
keep or restore the exact Phase-2 Worker; do not drop triggers, edit the ledger, enable a legacy reader,
or return a normalized master. Only after all runtime evidence correlates to one SHA may the no-deploy
window close. Physical device and assistive-technology acceptance remains a later, separate gate.

`placement.mode` is `smart`, and it is in `wrangler.jsonc` because anything the live Worker has that the
repository does not declare is silently dropped by the next deploy. It arrived the other way around: an
account API token named `Clouder-App-d4911219-1785224589` patched the Worker's settings directly on
2026-08-04, which created version 77 and made Wrangler refuse the next strict upload rather than
discard the setting. That refusal is the guard behaving correctly — a Worker whose live configuration
and whose repository disagree cannot be deployed from the repository without losing the difference.
Settle such a difference by declaring it here, not by weakening the upload.

The following 0008 note records a historical incident. The numbered legacy runbooks remain useful for
their own migrations, but the Phase-2/Phase-3 cover boundaries use the guarded wrappers above.

> **`migrations apply --remote` failed on 0008 (wrangler 4.113.0).** It returned
> `incomplete input: SQLITE_ERROR [code: 7500]` and applied nothing — the ledger stayed at 0007 and no
> object was created, so the database was never left half-migrated. The file itself is fine: applying
> the identical file with `wrangler d1 execute --remote --file` to a throwaway remote database created
> from 0001–0007 executed all 17 statements cleanly, and so did the same command against production.
> It is a fault in the `migrations apply` code path, not in the SQL.
>
> Do not generalize the historical recovery into a current operator pattern. In particular, never run
> a migration file and its ledger insert as separate Phase-2/Phase-3 commands. The current wrappers
> build a manifest-hashed file whose migration bytes and ledger write share D1's atomic import
> boundary, verify the exact before/after state, and refuse `migrations apply --remote`. A new failure
> stops for diagnosis and the migration-specific rollback rule; it is not repaired with a hand-written
> ledger row. Any export contains real event, guest, and message data and must remain outside the
> repository under its separately approved retention procedure.

Migration-before-compatible-Worker order is load-bearing rather than tidy: the manager's intake
queries select and order by
`media.stored_at` (`worker/db/media.ts`), so Worker code deployed against a database without that
column fails the manager's first request. The opposite order strands nobody — `0005` carries a
compatibility trigger that stamps `stored_at` for any finalization performed by Worker code older
than the column, so a migrated database serving the previous deployment is a state the schema was
written to sit in.

Production was read-only verified through `0010_event_start.sql` on 2026-08-02, with
`0011_release_certifications.sql` and `0012_event_cover_storage.sql` pending. This dated statement is
not authority: re-read the exact remote ledger before every release. A pending migration blocks claims about remote convergence but
does not alter a local manifest's `remoteMigration: not_run` claim.

### 0008 is a clean-launch migration with no backfill

`0008_event_rsvp.sql` is purely additive — new columns on `events`, two deadline triggers, and the
entry, household, invitee, receipt, session, and rate-limit tables — so applying it to a populated
database succeeds. What the migration itself does **not** do is create an entry credential row for
events that already exist; no SQL migration could, because that row needs an HMAC digest and AES
ciphertext computed with the new secrets.

Existing events survive anyway. An event created before 0008 adopts its printed credential on first
use — see the "Codes printed before migration 0008" section of [security.md](security.md) — so the QR
already on its invitations keeps working, and the manager surface unlocks the first time it is
opened. Nothing has to be run by hand.

Two consequences worth knowing before you deploy:

1. **Adoption needs the new secrets in place.** It re-digests under `ENTRY_HMAC_KEY` and re-encrypts
   under `ENTRY_ENCRYPTION_KEY`. Provision both before the deploy, not after, or the first scan of a
   legacy code fails. Once adopted, those two become persisted-data keys for that event like any
   other.
2. **The path form stays open only for those events.** Anything issued after 0008 is a fragment
   credential and is refused on `/join/<token>` even when valid.

Count what will be affected so you know what to watch:

```powershell
npx wrangler d1 execute candidary-core --remote --command "SELECT id, slug, event_date, uploads_enabled, guest_access_expires_at FROM events WHERE deleted_at IS NULL ORDER BY guest_access_expires_at"
```

If that returns nothing, there is nothing to adopt. If it returns rows, scan one of their printed
codes yourself after deploying and confirm it lands on `/event/<slug>` with a session cookie, then
confirm the manager's Share surface shows a link for that event.

A clean-D1 or fresh-D1 reset is therefore no longer required to ship this migration. If you choose
one anyway, first confirm the exact account, Worker, D1 database ID **and** name, and R2 bucket you
are pointed at, and record separately whether R2 objects are preserved — permission to reset D1 is
never permission to delete objects, and objects whose D1 rows are gone cannot be found by any later
cleanup pass.

After applying, prove there are no pending migrations and that referential integrity is intact:

```powershell
npx wrangler d1 migrations list candidary-core --remote
npx wrangler d1 execute candidary-core --remote --command "PRAGMA foreign_key_check"
```

Both must come back empty.

### 0010 is gated on a data-aware backfill, not on its own SQL

`0010_event_start.sql` adds `events.event_start_at` and `events.photos_open_from`, backfills the start
from `event_date || 'T00:00:00.000Z'`, and stamps `photos_open_from` on every event whose photo
delivery is already on. **It must not be treated as safe on the strength of that stamp alone.** SQLite
has no IANA database, so the backfilled start lands at UTC midnight rather than local midnight — up to
roughly fourteen hours off. For an event whose delivery is already on, the stamp makes that
irrelevant. For an uploads-off event with an active roster it is not irrelevant at all: under the new
Worker its guest RSVP routes would begin refusing at the approximate start, potentially most of a day
early or late.

Before start-time enforcement is enabled, release must either:

1. prove there are no non-deleted legacy events; or
2. perform a data-aware backfill that resolves each non-deleted event's start through its own IANA
   zone.

A second condition applies to either path, and checking only for the backfill's zone error is
insufficient. An existing event whose RSVP deadline **date equals its event date** can never satisfy
`rsvpDeadlineAt < eventStartAt` at any start time on that date: the stored deadline is the last
millisecond of that local day, which is after every start the day contains. Those rows need an explicit
host correction or a reviewed data correction before the new validation is enforced.

The rollout order is deterministic. Keep the inventory, plan, and SQL artifacts outside the
repository because they contain event identifiers. The `event-start-backfill:*` tools only read local
JSON or write deterministic plan, backfill, freeze, and cleanup artifacts. They never invoke Wrangler
or connect to D1. **Any nonzero release-tool exit blocks the migration, SQL apply, or deployment that
follows it.** In particular, plan mode exits nonzero and emits no new SQL when a deadline is not
strictly before the expected local-midnight start. Plan version 3 snapshots the database inventory
instant, `uploads_enabled`, and printed-entry state. Its pre-deploy SQL preserves old-Worker-open
photo delivery but deliberately leaves a legacy future event off under the old boolean semantics.
Only the separately reviewed post-deploy SQL restores that row to scheduled capability, after the
compatible Worker is live. Verification proves both stages and preserves disabled-entry tombstones.

Run the immutable local candidate gate above before starting this remote procedure, and retain its
`$reviewedSha`. Immediately before step 4, repeat the guarded passed-manifest selection so
`$candidateManifest` still names evidence for that exact SHA. The local result does not replace any
inventory or authorize any write. If an environment is still behind `0010`, the approved migration source must
present **exactly** `0010_event_start.sql` as pending at step 2; do not run the command from a source
that would also apply `0011_release_certifications.sql` or `0012_event_cover_storage.sql`. Apply each
of `0011` and `0012` only as its own separately reviewed and authorized operation.

1. **Before applying `0010`, inventory and plan every non-deleted event.** Start with a fresh artifact
   directory, capture Wrangler's machine-readable envelope, then let the Node tool resolve each local
   midnight through `instantForLocalDateTime`. Review both artifacts before continuing. A blocked row
   needs an explicit host correction or reviewed data correction; never do the zone arithmetic in SQL.

   ```powershell
   $eventStartGate = Join-Path ([System.IO.Path]::GetTempPath()) ('candidary-event-start-release-' + [guid]::NewGuid().ToString('N'))
   New-Item -ItemType Directory -Path $eventStartGate | Out-Null
   $pre0010Inventory = Join-Path $eventStartGate 'pre-0010-inventory.json'
   $pre0010Plan = Join-Path $eventStartGate 'pre-0010-plan.json'
   $pre0010Sql = Join-Path $eventStartGate 'pre-0010-backfill.sql'
   $pre0010PostDeploySql = Join-Path $eventStartGate 'pre-0010-post-deploy.sql'
   $freezeInstallSql = Join-Path $eventStartGate 'install-schedule-freeze.sql'
   $freezeRemoveSql = Join-Path $eventStartGate 'remove-schedule-freeze.sql'

   npx wrangler d1 execute candidary-core --remote --json --command "SELECT id, slug, event_date, event_timezone, rsvp_deadline_at, uploads_enabled, EXISTS (SELECT 1 FROM event_entry_credentials WHERE event_id = events.id AND disabled_at IS NULL) AS entry_enabled, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS inventory_at, deleted_at FROM events WHERE deleted_at IS NULL ORDER BY id" | Set-Content -Encoding utf8 -LiteralPath $pre0010Inventory
   if ($LASTEXITCODE -ne 0) { throw 'Pre-0010 inventory failed; release is blocked.' }
   npm run event-start-backfill:plan -- --input $pre0010Inventory --plan $pre0010Plan --sql $pre0010Sql --post-deploy-sql $pre0010PostDeploySql
   if ($LASTEXITCODE -ne 0) { throw 'Event-start planning failed; release is blocked.' }
   npm run event-start-backfill:freeze -- --install $freezeInstallSql --remove $freezeRemoveSql
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze artifact generation failed; release is blocked.' }
   ```

2. **Apply only `0010` while the old Worker is still serving.** Its UTC-midnight values are not yet
   interpreted as lifecycle starts, so the approximation is inert for as long as this step lasts.

   ```powershell
   # Proceed only after the remote pending set and reviewed source prove 0010 is the sole apply.
   npx wrangler d1 migrations apply candidary-core --remote
   if ($LASTEXITCODE -ne 0) { throw 'Migration apply failed; release is blocked.' }
   ```

3. **Install the narrow lifecycle-source freeze, apply the reviewed pre-deploy SQL, then verify every
   pre-migration ID and source field exactly.** The temporary trigger rejects only an actual change
   to `event_date`, `event_timezone`, or `rsvp_deadline_at`. It does not block event creation,
   unchanged source values included in an unrelated settings write, or the backfill's
   `event_start_at` and `photos_open_from` update. Photo capability and printed-entry state remain
   independently guarded in the generated SQL and exact inventories. An edit that
   commits before trigger creation is caught by the guarded SQL or the inventory that follows; an edit
   after creation is rejected by SQLite. Keep the trigger installed through step 5's final sentinel
   and exact-state checks.

   ```powershell
   $freezeStateBeforeDeploy = Join-Path $eventStartGate 'freeze-state-before-deploy.json'
   npx wrangler d1 execute candidary-core --remote --file $freezeInstallSql
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze install failed; release is blocked.' }
   npx wrangler d1 execute candidary-core --remote --json --command "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'" | Set-Content -Encoding utf8 -LiteralPath $freezeStateBeforeDeploy
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze presence inventory failed; release is blocked.' }
   npm run event-start-backfill:freeze:verify -- --input $freezeStateBeforeDeploy --expect installed
   if ($LASTEXITCODE -ne 0) { throw 'The exact reviewed schedule freeze is not installed; release is blocked.' }

   $pre0010PlanContents = Get-Content -Raw -LiteralPath $pre0010Plan | ConvertFrom-Json
   if ($pre0010PlanContents.events.Count -gt 0) {
     npx wrangler d1 execute candidary-core --remote --file $pre0010Sql
     if ($LASTEXITCODE -ne 0) { throw 'Event-start SQL apply failed; release is blocked.' }
   }

   $post0010Inventory = Join-Path $eventStartGate 'post-0010-inventory.json'
   npx wrangler d1 execute candidary-core --remote --json --command "SELECT id, event_date, event_timezone, rsvp_deadline_at, event_start_at, photos_open_from, uploads_enabled, EXISTS (SELECT 1 FROM event_entry_credentials WHERE event_id = events.id AND disabled_at IS NULL) AS entry_enabled, deleted_at FROM events WHERE deleted_at IS NULL ORDER BY id" | Set-Content -Encoding utf8 -LiteralPath $post0010Inventory
   if ($LASTEXITCODE -ne 0) { throw 'Post-0010 inventory failed; release is blocked.' }
   npm run event-start-backfill:verify -- --plan $pre0010Plan --input $post0010Inventory --stage predeploy --require-predeploy-completeness
   if ($LASTEXITCODE -ne 0) { throw 'Pre-deploy event-start verification failed; release is blocked.' }
   ```

   Pre-deploy completeness rejects an unplanned non-sentinel row created between inventory and
   migration, while allowing an epoch-sentinel row created by the old Worker after migration for
   step 5. Do not deploy while a missing ID, source drift, lost photo-open stamp, UTC-midnight
   approximation, unexpected trigger definition, or other mismatch remains.

4. **Deploy the compatible Worker, then finalize legacy scheduled capability.** An event created by the old Worker after the migration was
   applied carries the epoch default `1970-01-01T00:00:00.000Z`. The new Worker recognizes that
   sentinel and temporarily retains the pre-0010 boolean/deadline phase rules and guest RSVP route
   availability for such a row, so a deploy-gap event cannot begin refusing RSVPs at a start it does
   not really have.

   ```powershell
   $reviewedSha = git rev-parse HEAD
   $candidateManifest = Get-ChildItem -LiteralPath "output/release/$reviewedSha" -Recurse -Filter 'candidate-manifest.json' |
     Where-Object { (Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json).status -eq 'passed' } |
     Sort-Object LastWriteTimeUtc |
     Select-Object -Last 1 -ExpandProperty FullName
   if (-not $candidateManifest) { throw 'No passed candidate manifest exists for the reviewed SHA.' }
   $candidateManifest = (Resolve-Path -LiteralPath $candidateManifest).Path
   npm run deploy -- --sha $reviewedSha --manifest $candidateManifest
   if ($LASTEXITCODE -ne 0) { throw 'Worker deploy failed; the schedule freeze remains installed. Retry deploy or use the explicit abort procedure below.' }

   $freezeStateAfterDeploy = Join-Path $eventStartGate 'freeze-state-after-deploy.json'
   $postDeployInventory = Join-Path $eventStartGate 'post-deploy-original-plan-inventory.json'
   npx wrangler d1 execute candidary-core --remote --json --command "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'" | Set-Content -Encoding utf8 -LiteralPath $freezeStateAfterDeploy
   if ($LASTEXITCODE -ne 0) { throw 'Post-deploy schedule-freeze inventory failed; release is blocked.' }
   npm run event-start-backfill:freeze:verify -- --input $freezeStateAfterDeploy --expect installed
   if ($LASTEXITCODE -ne 0) { throw 'The schedule freeze did not remain installed through deployment; release is blocked.' }

   if ($pre0010PlanContents.events.Count -gt 0) {
     npx wrangler d1 execute candidary-core --remote --file $pre0010PostDeploySql
     if ($LASTEXITCODE -ne 0) { throw 'Post-deploy photo-capability finalization failed; keep the freeze installed and stop.' }
   }

   npx wrangler d1 execute candidary-core --remote --json --command "SELECT id, event_date, event_timezone, rsvp_deadline_at, event_start_at, photos_open_from, uploads_enabled, EXISTS (SELECT 1 FROM event_entry_credentials WHERE event_id = events.id AND disabled_at IS NULL) AS entry_enabled, deleted_at FROM events WHERE deleted_at IS NULL ORDER BY id" | Set-Content -Encoding utf8 -LiteralPath $postDeployInventory
   if ($LASTEXITCODE -ne 0) { throw 'Post-deploy original-plan inventory failed; release is blocked.' }
   npm run event-start-backfill:verify -- --plan $pre0010Plan --input $postDeployInventory
   if ($LASTEXITCODE -ne 0) { throw 'Post-deploy original-plan verification failed; keep the freeze installed and stop.' }

   ```

   A failed deploy or failed post-deploy verification deliberately leaves the freeze installed. An
   operator may retry the deploy or verification against that frozen state. To abandon the release,
   apply the generated removal SQL and machine-verify absence:

   ```powershell
   npx wrangler d1 execute candidary-core --remote --file $freezeRemoveSql
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze abort cleanup failed; it may still be installed.' }
   $freezeAbortState = Join-Path $eventStartGate 'freeze-state-after-abort.json'
   npx wrangler d1 execute candidary-core --remote --json --command "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'" | Set-Content -Encoding utf8 -LiteralPath $freezeAbortState
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze abort inventory failed.' }
   npm run event-start-backfill:freeze:verify -- --input $freezeAbortState --expect absent
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze abort cleanup is not proven.' }
   ```

   Explicit abort/removal invalidates every earlier inventory and verification artifact. Before a
   later deployment attempt, take a fresh full inventory, regenerate and review the plan and SQL,
   correct any non-migration stale start explicitly, reinstall the freeze, and repeat both the
   pre-deploy and post-deploy checks. Never continue from the old plan after reopening schedule writes.

5. **Repeat the inventory, plan, SQL apply, and exact verification for deploy-gap sentinels.** Plan
   mode validates each gap row's deadline before emitting SQL. If the plan contains no events, skip
   the SQL apply. Repeat this block if the final scan finds another gap row; do not close the gate
   until the final count is exactly zero.

   ```powershell
   $gapInventory = Join-Path $eventStartGate 'deploy-gap-inventory.json'
   $gapPlan = Join-Path $eventStartGate 'deploy-gap-plan.json'
   $gapSql = Join-Path $eventStartGate 'deploy-gap-backfill.sql'
   $gapPostDeploySql = Join-Path $eventStartGate 'deploy-gap-post-deploy.sql'
   $postGapInventory = Join-Path $eventStartGate 'post-gap-inventory.json'

   npx wrangler d1 execute candidary-core --remote --json --command "SELECT id, slug, event_date, event_timezone, rsvp_deadline_at, event_start_at, photos_open_from, uploads_enabled, EXISTS (SELECT 1 FROM event_entry_credentials WHERE event_id = events.id AND disabled_at IS NULL) AS entry_enabled, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS inventory_at, deleted_at FROM events WHERE deleted_at IS NULL AND event_start_at = '1970-01-01T00:00:00.000Z' ORDER BY id" | Set-Content -Encoding utf8 -LiteralPath $gapInventory
   if ($LASTEXITCODE -ne 0) { throw 'Deploy-gap inventory failed; release is blocked.' }
   npm run event-start-backfill:plan -- --input $gapInventory --plan $gapPlan --sql $gapSql --post-deploy-sql $gapPostDeploySql
   if ($LASTEXITCODE -ne 0) { throw 'Deploy-gap planning failed; release is blocked.' }

   $gapPlanContents = Get-Content -Raw -LiteralPath $gapPlan | ConvertFrom-Json
   if ($gapPlanContents.events.Count -gt 0) {
     npx wrangler d1 execute candidary-core --remote --file $gapSql
     if ($LASTEXITCODE -ne 0) { throw 'Deploy-gap SQL apply failed; release is blocked.' }
     npx wrangler d1 execute candidary-core --remote --file $gapPostDeploySql
     if ($LASTEXITCODE -ne 0) { throw 'Deploy-gap capability finalization failed; release is blocked.' }
   }

   npx wrangler d1 execute candidary-core --remote --json --command "SELECT id, event_date, event_timezone, rsvp_deadline_at, event_start_at, photos_open_from, uploads_enabled, EXISTS (SELECT 1 FROM event_entry_credentials WHERE event_id = events.id AND disabled_at IS NULL) AS entry_enabled, deleted_at FROM events WHERE deleted_at IS NULL ORDER BY id" | Set-Content -Encoding utf8 -LiteralPath $postGapInventory
   if ($LASTEXITCODE -ne 0) { throw 'Post-gap inventory failed; release is blocked.' }
   npm run event-start-backfill:verify -- --plan $gapPlan --input $postGapInventory --require-no-sentinel
   if ($LASTEXITCODE -ne 0) { throw 'Deploy-gap verification failed; release is blocked.' }

   npx wrangler d1 execute candidary-core --remote --command "SELECT COUNT(*) AS remaining FROM events WHERE deleted_at IS NULL AND event_start_at = '1970-01-01T00:00:00.000Z'"
   if ($LASTEXITCODE -ne 0) { throw 'Final sentinel scan failed; release is blocked.' }

   npx wrangler d1 execute candidary-core --remote --file $freezeRemoveSql
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze removal failed; release remains blocked.' }
   $freezeStateRemoved = Join-Path $eventStartGate 'freeze-state-removed.json'
   npx wrangler d1 execute candidary-core --remote --json --command "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'candidary_event_start_schedule_freeze'" | Set-Content -Encoding utf8 -LiteralPath $freezeStateRemoved
   if ($LASTEXITCODE -ne 0) { throw 'Schedule-freeze removal inventory failed; release remains blocked.' }
   npm run event-start-backfill:freeze:verify -- --input $freezeStateRemoved --expect absent
   if ($LASTEXITCODE -ne 0) { throw 'Schedule freeze is still installed; release remains blocked.' }
   ```

   The final query must report `remaining = 0`; otherwise repeat step 5 with fresh artifact names.

The epoch value is therefore an intermediate migration sentinel and never a live start. Corrected
legacy rows and events created by the new Worker use the new lifecycle immediately; a deploy-gap row
stays safely on the old behavior only until step 5.

### 0011 creates a certification ledger; it does not certify a release

`0011_release_certifications.sql` is the next migration after the lifecycle rollout. The local
candidate gate applies it only to a disposable local D1 so schema and upgrade invariants can be
proved. Applying it to remote D1 is a separate operation requiring explicit authorization after the
`0010` state has converged; never let a generic pending-migration apply silently combine the two
procedures.

The migration creates storage for a later certification record. Neither `verify:release`, the guarded
deploy wrapper, nor any HTTP route or checked-in command inserts that record. A deployed Worker is
therefore still uncertified until a future, explicitly designed physical-evidence workflow records an
exact matching Worker version, build SHA, journey version, migration digest, evidence-manifest digest,
and redacted physical references. See [operations.md](operations.md) for the fail-closed contract.

### Historical Phase-1/Phase-2 cover boundary: 0012 authorizes no later phase

`0012_event_cover_storage.sql` is additive: three `events` columns and twelve cover inventory tables.
It is the widest schema change in this repository's history, and it is also the one most likely to be
misread as permission to do the work that follows it. It is not. The event cover cutover is three
explicitly separated releases, each with its own authorization:

| Phase | What it is | What it does **not** authorize |
| --- | --- | --- |
| 1 | Apply `0012`; deploy the Worker with `COVER_RENDER_WORKFLOW`, `COVER_BACKFILL_WORKFLOW`, and the versioned preset assets. New and replacement uploads use the bounded pipeline; the client contract is unchanged. | Running the backfill. Enabling Cover Studio or the responsive reader. Authoring the later invariant migration. |
| 2 | Convert every pre-`0012` legacy cover with the backfill launcher and produce the zero-legacy proof. | Phase 3. A green proof authorizes opening that candidate and nothing else. |
| 3 | `0014_event_cover_invariants.sql` after integrated `0013_guest_message_hardening.sql`, the new Manager and guest projections, the revision-scoped delivery routes, and Cover Studio. | Anything before its own review and release. |

Phase 2 itself has three authorization gates. They are sequential evidence boundaries, not three
steps authorized by one approval:

| Phase-2 gate | Required evidence | What passing it does not authorize |
| --- | --- | --- |
| Candidate verification | One exact clean SHA; independent source review; exactly 13 migrations, ending in `0013_guest_message_hardening.sql` from the `main` integration; the complete local release gate plus the populated Worker rehearsal and local-D1 operator loop; local claims only. | Remote migration, deployment, staging, production data, or the backfill. |
| Staging deployment and conformance | Deploy that exact candidate to separately identified staging resources. Prove real Images/codec behavior and real `COVER_BACKFILL_WORKFLOW` create, status, retry, resume, restart, terminate, retained-ID, failed-lookup idempotent materialization, status-unknown preservation, and deletion-fence behavior. The certified-not-found matcher remains empty because the deployed probe found no stable non-message discriminator. Record the staging account/resources, deployed version ID/tag, candidate SHA, timestamps, sanitized results, and cleanup. | Production migration/data/backfill or any Phase-3 activity. Deterministic local fakes do not satisfy this gate. |
| Production backfill | New explicit production authorization after both earlier gates pass; exact account/Worker/D1/Workflow/migration identity; the exact candidate at 100% traffic; an owned no-deploy window; and execution of the bounded claim/launch/confirm/proof protocol in the runbook. | `0014_event_cover_invariants.sql`, responsive projections/routes, Cover Studio activation, or a Phase-3 deployment. |

A new commit, migration, deployed version/tag, binding change, or staging remediation invalidates later
gate evidence until the affected gate is repeated on the new exact candidate. This table records the
Phase-1/Phase-2 authorization boundary; it is not the current Phase-3 execution runbook and marks no
Phase-3 gate passed. Use the 14-migration sequence above for current work.

Two properties make the phase-1 apply safe to perform on its own. Every new column has a SQLite-safe
constant default, so a populated database migrates without a data pass. And the compatibility reader
keeps the current `coverObjectKey` projection and the current cover URL shape, so a deployed Worker
serves exactly what it served before — for a legacy row, the original; for a converted one, the
`wide-expanded` 1x JPEG derivative.

One behaviour changes at phase 1 and is worth stating plainly: **a displaced cover original is no
longer deleted eagerly.** It is inventoried in `event_cover_retired_legacy_objects` with a seven-day
`cleanup_after`, and only the bounded scheduled sweep removes it from R2 — after verifying absence and
before removing the row that named it. Storage therefore grows slightly during the recovery window,
which is the trade the recovery window buys.

Every cover table's `event_id` is `ON DELETE RESTRICT`, the first such clauses in this schema. Event
purge handles them in an explicit child-before-parent order. If a purge ever fails with a foreign-key
error after this migration, the cause is a cover row the order does not cover, not a corrupt event.

The executable operator procedure is [cover-backfill-runbook.md](cover-backfill-runbook.md); the
design-time task contract remains in
`docs/superpowers/plans/2026-08-05-event-appearance-cover-studio-phase-2.md`. Applying `0012` and
deploying does not start the backfill, and nothing in this repository starts it automatically.

## Wedding rehearsal gate

Do not describe a deployment as wedding-ready until a dedicated rehearsal event passes all of the following:

1. Print the actual QR at intended reception size and scan it from normal guest distance. Decode the
   printed artefact locally and record only a SHA-256 fingerprint plus the non-secret origin and path
   prefix — never the raw credential URL.
2. On current iPhone Safari and Android Chrome, scan that same physical artefact during RSVP-primary,
   again after an ordinary **Sign out guest devices** rotation, and again during photos-primary.
   Confirm the credential disappears from the address bar each time, and compare the local SHA-256
   fingerprints: they must not change.
3. Enter a name, take a new photo, append recent photos, send, and reach the exact terminal receipt.
4. Repeat over deliberately degraded reception; recover one partial failure and one expired signed URL without duplicating a delivery or re-uploading an already transferred original.
5. Upload JPEG, PNG, WebP, HEIC, and HEIF samples, including vendor-specific phone MIME values; view metadata-free private previews while retaining byte-identical originals. Confirm preview requests fail safely when the Images binding is intentionally unavailable.
6. Confirm a different guest cannot read unpublished previews or any original, and a host can download every original.
7. Enable the gallery, publish one preview, hide it again, and confirm hiding never removes it from intake or export.
8. Run both opt-in load harnesses against the disposable event at the intended target, monitor Worker/D1/R2/Images/Workflow telemetry, then delete the event. Reconcile the RSVP harness's imported and responded totals against the manager summary.
9. Prepare the manifest and every export part, download them with a common ZIP tool, and reconcile counts.
10. Sign guest devices out, confirm old sessions stop while the printed link is unchanged, and test scheduled reservation/export cleanup.
11. Import a guest list, then rehearse the RSVP journey end to end: an exact-name match, an ambiguous first name resolved by a second name, individual attend/decline with an attending plus-one name, a revision, deadline closure, and a host correction afterwards.
12. Rehearse **Disable printed event QR** on a disposable event only. Prove that future scans and existing guest and household sessions all stop while manager access still works, and that no replacement is offered.
13. Review live logs for the rehearsal window and confirm no line carries a raw credential, ciphertext, submitted name, RSVP body, or CSV row.

Desktop emulation is supplementary. Physical iPhone and Android evidence, Images availability, load evidence, and this production-like rehearsal are release gates.

## Device and assistive-technology rehearsal gate

These are **production rehearsal gates performed by a person on real hardware**. They are not covered
by the automated suite and nothing below may be recorded as passed on the strength of a green
`npm run test:e2e`. The suite runs one Chromium engine under viewport emulation on Windows: it can
prove geometry, containment, target size, focus order, resolved contrast, reduced motion, and
`axe-core` 4.12.1's default rule set plus `target-size` — 90 of the 105 rules it ships, nothing
scoped away, with the omissions and complete global/event-theme surface matrix enumerated in
`design-qa.md` — and it can prove none of the following.

The engine currently reports zero accessibility violations, but note what that is and is not. It
means computed colour pairings clear WCAG AA arithmetically on the states the suite renders. Muted
ink on parchment clears it by 0.0046 — see `design-qa.md`. Arithmetic is not legibility: check the
guest captions, the disclosure summaries, and the footer on a real phone screen at reception
brightness, outdoors, and at whatever the device's own contrast and text-size settings are set to.

14. **Physical iPhone Safari.** Scan the printed code on a current iPhone. Confirm the RSVP lookup's
    first fold before the event and the photo drop's first fold on the day, that both photo sources
    are reachable without scrolling, that the dynamic toolbar appearing and disappearing never hides
    a control or introduces horizontal scrolling, and that rotating to landscape keeps a full camera
    target on screen. Repeat on the manager link and step through all six sections.
15. **Physical Android Chrome.** Repeat the same pass on a current Android phone, including the
    address bar collapsing on scroll and the on-screen keyboard opening over the RSVP name field, the
    guest name field, and the note field.
16. **Real HEIC selection.** From the iPhone's own photo library, select genuine HEIC and HEIF
    captures — not files copied through a desktop — and send them. Confirm the picker accepts them,
    the vendor MIME value is accepted, private previews render, and the originals stay byte-identical.
17. **VoiceOver on iOS.** With VoiceOver on, reach and operate the guest name field, both photo
    sources, the review list, and the send action; confirm each upload state change is announced and
    that a failure announces both what happened and the way out of it. On the RSVP household form,
    confirm every person is announced as a named group with two labelled radios, that an incomplete
    row announces its own error, and that a refused write announces the review heading it moves to.
    On the manager, confirm the six destinations announce their names and selected state, and that a
    refused write announces through the live region without moving focus.
18. **TalkBack on Android.** Repeat the guest, RSVP, and manager passes with TalkBack, including swipe
    navigation through the section rail and the full-screen gallery's close control.
19. **10,000-photo disposable event.** On a disposable event loaded to the documented per-event cap,
    confirm on a phone that intake still pages rather than loading everything, that the count badge
    renders the full five-digit number, that scrolling stays smooth, and that a complete export can
    be prepared and downloaded. Delete the event afterwards.
20. **Degraded-network RSVP retry.** On the venue network, drop a submission mid-flight and confirm
    the retry either commits once or replays the same successful response — never a second, different
    answer for the same household.

Record the device models, OS versions, and browser versions with the result. A gate exercised on an
emulator, a simulator, or a desktop browser's device mode does not count.

## Public-launch gate

The event-creation endpoint is suitable for a controlled deployment. Before unrestricted public traffic, add Cloudflare rate limiting and Turnstile to `POST /api/events`, alert on creation/upload spikes, and assign an abuse-response owner.

## Email

Host accounts send confirmation codes, password resets, and lifecycle notifications through the `EMAIL` binding (Cloudflare Email Service).

`candidary.app` is onboarded as a sending domain with DNS status `ready`: SPF and DKIM on the `cf-bounce` return-path subdomain, and `_dmarc` at `p=reject`. Mail is sent as `hello@candidary.app`, set in `EMAIL_FROM`, and Email Routing forwards replies. The account quota is 1,000 messages per day.

`candidary.online` is onboarded and `ready` on the same terms, but it is not a second sending domain and no mail is sent from it. Being onboarded means only that its DNS is already in place, so making it the sending domain later would not wait on propagation. It is a standby, not a live alternative: `EMAIL_FROM` names exactly one address, and moving it to `candidary.online` means moving `APP_ORIGIN` with it in the same change.

There is one sending domain and one canonical origin, and they should not be allowed to drift apart. Mail whose `From` domain differs from the domain of the links inside it still passes SPF, DKIM, and DMARC, so nothing fails loudly — it just reads as a phishing attempt to the host being asked to click a login code. This is why `EMAIL_FROM` is paired with `APP_ORIGIN` specifically and not with whichever origin a host happens to be using: the alternate origins serve the application, but no mail is ever built on them.

Setting up a different domain means repeating three things:

1. Create a sending subdomain for the zone and let Cloudflare write its SPF, DKIM, and DMARC records. A `workers.dev` subdomain cannot be used — those records need DNS you control.
2. Point `EMAIL_FROM` at an address on that domain.
3. Confirm the account is on the Workers Paid plan. The free plan can only send to verified destination addresses in your own account, which is not enough for real hosts.

`LOGIN_HMAC_KEY` is a secret like the others and is required whether or not mail is configured — it signs the emailed codes and the unsubscribe links.

Without remote bindings, `wrangler dev` simulates sending and writes each message to a local file, so local development needs no mail configuration at all. Add `"remote": true` to the `send_email` binding to send real mail from a local Worker.

# Task 11 Staging Conformance Harness Design

**Date:** 2026-08-10

**Status:** Approved for implementation

## Objective

Finish the Phase-2 Task 11 harness and use it to produce honest, immutable
deployed-platform evidence for one exact Candidary candidate. The completed gate
must prove the real Cloudflare Images and Workflow behavior required by design
section 15.5, the complete backfill and purge lifecycle matrix named by Task 11,
and runtime correlation through `CF_VERSION_METADATA`.

This work may change `agent/event-cover-studio-phase-2`, adopt the platform-proven
idempotent materialization contract, create a new candidate SHA, rerun Task 10, and
redeploy isolated staging. It must not modify `main`, push, merge, deploy to
production, mutate production D1 or R2, operate a production Workflow, begin
Task 12, or claim physical-device support.

## Existing state

- Candidate `2696dcccdf07cef5f5403c75fadb3eab86cfc12e` passed Task 10 with all
  fourteen release gates green.
- That candidate is deployed to route-disabled Worker
  `candidary-staging-conformance`, version
  `8ba0cf3b-4d15-4b8a-88e8-650d3b031ab2`.
- Its isolated D1 has all thirteen Phase-2-plus-current-main migrations, its R2
  bucket is `candidary-media-staging`, and its three Workflow names use the
  `candidary-staging-` prefix.
- The retained staging artifact is correctly `partial`. It proves source SHA,
  fresh remote D1 application, and topology isolation, but it does not prove
  runtime metadata, real Images behavior, the Workflow lifecycle matrix,
  purge ordering, or verification closure.
- `CERTIFIED_NOT_FOUND_MATCHERS` is intentionally empty. The Task 11 live probe
  found no stable non-message discriminator; guarded recovery uses idempotent
  materialization without adding one.

The existing partial artifact is historical evidence. The harness archives it
under a run-specific ignored evidence directory before replacing the canonical
Task 11 artifact. It never edits the old bytes in place or presents them as a
passing run.

## Approaches considered

### 1. Route-less named RPC entrypoint — selected

The exact candidate exports a named `WorkerEntrypoint` that is callable only
through a same-account service binding. A local driver Worker uses a remote
service binding to reach it, while its own HTTP listener remains bound to
`127.0.0.1`. No route, `workers.dev` hostname, or preview URL is attached to the
deployed candidate or probe Worker.

This is the only approach that simultaneously observes the candidate's runtime
version metadata, calls its real bindings, preserves the no-public-route
constraint, and allows deterministic lifecycle control.

### 2. Temporary authenticated HTTP route — rejected

An authenticated staging-only route would be straightforward to drive, but it
would add a public ingress surface and contradict the approved topology. A
secret on a public route reduces exposure; it does not prove route absence.

### 3. Wrangler and REST APIs only — rejected

External APIs can prove deployed versions, bindings, migration state, and
Workflow instance status. They cannot prove what `CF_VERSION_METADATA` contains
inside the runtime or what the Workflows binding throws to application code.
This approach can only reproduce the current partial artifact.

## Architecture

The harness has four independently testable units.

### Candidate conformance entrypoint

Create a focused Worker module that exports `StagingConformanceEntrypoint` from
`worker/index.ts`. The production Wrangler topology does not bind or route this
entrypoint. The isolated staging overlay permits a same-account service binding
to name it.

Every method first checks all of these predicates:

1. `APP_ORIGIN` is exactly `https://staging.candidary.invalid`;
2. the caller supplies one canonical UUID run ID;
3. every event, run, job, operation, render-set, draft, and instance identifier
   belongs to that run's deterministic namespace; and
4. every R2 operation stays beneath that run's private conformance prefix.

Failure returns a fixed sanitized error and performs no D1, R2, Images, or
Workflow call. Because production's `APP_ORIGIN` cannot satisfy the first
predicate, a same-account service binding accidentally pointed at production
still cannot use the conformance methods.

The entrypoint exposes only bounded, typed operations:

- `runtimeIdentity` returns version ID, tag, and timestamp after validating the
  existing immutable build identity;
- `inspectImageCase`, `normalizeImageCase`, `renderPreviewCase`, and
  `renderProfileCase` invoke the real shared image pipeline on run-scoped R2
  fixtures and return only format, dimensions, byte size, checksum, rung, and
  adoption state;
- `workflowLookup`, `createBackfillBatch`, `resumeBackfill`,
  `restartBackfill`, and `terminateBackfill` call the candidate's real Workflow
  accessor and return only the closed status/disposition vocabulary;
- `runScheduledCleanup` invokes the same bounded cleanup function as the Cron
  handler with one supplied UTC instant; and
- `readConformanceSummary` returns aggregate counts and phases without object
  keys, private payloads, credentials, or raw platform errors.

The RPC contract never returns image bytes, R2 keys, raw D1 rows, private URLs,
tokens, secrets, or `error.message`.

### Missing-instance contract probe and idempotent materialization

Before choosing a recovery primitive, `staging-release probe` deploys a minimal,
route-disabled probe Worker with a binding to the existing isolated backfill
Workflow definition. The probe is called through a local remote service binding
and has no D1, R2, Images, Email, rate-limit, assets, or production binding.

It performs repeated calls for:

- multiple syntactically valid but absent instance IDs;
- invalid IDs at each platform validation boundary; and
- fixed synthetic errors representing non-platform failures.

The probe reduces thrown values to an allowlisted structural fingerprint:
constructor family, `name`, stable scalar `code`-like fields, and fixed own-key
names. It explicitly discards messages, stacks, causes containing text,
identifiers, URLs, and unknown scalar values. A property would qualify only when
it is identical across repeated absent-ID probes and distinct from every invalid
and synthetic case. The live probe found no such property, matching the
documented binding contract: `get()` throws for both an absent and an invalid ID.

The implementation therefore keeps `CERTIFIED_NOT_FOUND_MATCHERS` empty and
never guesses from message text. Recovery owns canonical deterministic IDs and,
only after all D1, fence, generation, currentness, capacity, and checkpoint
guards pass, replays that exact ID through documented idempotent `createBatch`.
The platform skips a retained ID, creates an absent ID, and rejects an invalid
ID. A successful lookup whose instance reports `unknown`, an unmapped status,
or an untrusted synthetic lookup label remains mutation-free. Focused tests
cover publication and backfill materialization, retained-ID replay, rejected
materialization, and status-unknown preservation.

### Deterministic staging fault controls

Automatic step retry must be observed, not inferred. The candidate therefore
includes one staging-only fail-once helper used at explicitly named Workflow
step boundaries.

The helper is dormant unless `APP_ORIGIN` equals the staging sentinel and the
payload belongs to the canonical conformance run namespace. It checks for one
run-scoped R2 marker, deletes it with a conditional identity check, emits a fixed
sanitized conformance event, and throws a fixed error exactly once. Production
performs only the sentinel comparison and never reads R2 for this path.

The harness arms only an allowlisted step name and verifies this sequence:

1. first attempt consumes the marker and fails;
2. Cloudflare automatically retries the same named step;
3. the retry reuses the same Workflow ID and pinned payload;
4. completed prior steps are not repeated; and
5. the instance reaches the expected terminal state.

No RPC method can request arbitrary code, SQL, object paths, delays, exception
text, or step-history options.

### Node orchestration and evidence

Create `scripts/staging-release.ts` as the only operator CLI for this Task 11
run. It has six closed modes:

- `probe`: validate the current partial target and record the Workflow
  missing-instance contract, including the no-discriminator fallback;
- `deploy`: validate and deploy one new exact Task 10 candidate to the approved
  isolated topology;
- `conform`: create run-scoped fixtures and execute the Images, Workflow,
  backfill, deletion, purge, and verification matrices;
- `cleanup`: remove run-scoped fixtures and, after a green run, destroy every
  disposable staging resource and prove absence;
- `finalize`: accept only complete sanitized results and write canonical JSON
  plus its SHA-256 sidecar;
- `verify`: independently rehash candidate, manifest, sidecars, target inputs,
  results, and cleanup evidence, then require `status = passed`.

The only passing sequence is `probe` → `deploy` → `conform` → `cleanup` →
`finalize` → `verify`. A resumed run may skip a phase only after independently
rehashing its complete predecessor receipt and re-proving the associated remote
state.

Arguments use a closed grammar. Unknown, duplicate, missing, empty, symlinked,
path-escaping, or noncanonical values fail before any remote command. Remote
modes require the exact account ID, target descriptor digest, full candidate
SHA, candidate manifest and sidecar, run ID, and explicit staging authorization
record.

The runner resolves Node, npm, and Wrangler only from the verified candidate.
Wrangler must be `4.113.0`. It never uses `npx`, `PATH` fallback, automatic
provisioning, `migrations apply --remote`, or `scripts/deploy-release.ts`.

The owned deploy root preserves the generated artifact layout so Worker main,
assets, and migrations resolve exactly as they did during Task 10. Before and
after every remote phase, the runner rechecks candidate HEAD, tree, cleanliness,
manifest bytes, generated artifact hashes, migration manifest, and source
topology hash.

## Staging topology

The target remains isolated from every canonical production identity:

- Worker: `candidary-staging-conformance`;
- D1: `candidary-core-staging`;
- R2: `candidary-media-staging`;
- Workflows: `candidary-staging-export`,
  `candidary-staging-cover-render`, and
  `candidary-staging-cover-backfill`;
- no routes, custom domains, `workers.dev`, or preview URLs; and
- no scheduled triggers during the controlled conformance run.

The harness invokes the real cleanup pass through the internal RPC entrypoint,
so autonomous Cron execution cannot race fixture setup or lifecycle assertions.
Email and both rate-limit bindings remain explicitly isolated or disabled.
Assets, observability, placement, all nonsecret variables, and the exact secret
name set are included in the target digest.

The placeholder R2 S3 credentials are not used. Fixture transfer uses the
Cloudflare API through the repository-pinned Wrangler and the Worker uses the
`MEDIA_BUCKET` binding. If any tested product path unexpectedly reaches S3
presigning, the run stops as blocked rather than replacing the placeholders or
inventing credentials.

## Images conformance matrix

Fixtures live beneath ignored `output/staging-input/` and are referenced by
content digest. The generator or provenance record must account for JPEG,
opaque PNG, transparent PNG, WebP, iPhone HEIC, rejected HEIF/sequence, EXIF
orientation, GPS and nonessential metadata, complete and partial 2x geometry,
and deterministic dense inputs calibrated to each ladder outcome. No private
user photo is used.

The deployed matrix proves:

- declared and detected type agreement for accepted inputs and rejection for
  excluded inputs;
- exact 19,000,000-byte acceptance and 19,000,001-byte refusal;
- orientation normalization and absence of GPS/nonessential metadata in every
  materialized result;
- all five master rungs, all four preview rungs, and every WebP/JPEG profile
  output quality rung through inputs whose first passing result is that rung;
- all five effects, deterministic trim and focal crops, complete and partial 2x
  eligibility, no upscaling, and transparent matte parity;
- exact MIME, dimensions, byte ceilings, content digests, and stored inventory;
  and
- conditional-create replay adopts byte-identical existing objects rather than
  overwriting them.

The artifact contains only fixture digests, case IDs, numeric measurements,
closed result codes, and approved quality rungs. It contains no fixture bytes,
object keys, private URLs, or raw transformation errors.

## Workflow and ledger conformance matrix

All fixtures use deterministic IDs derived from the run UUID. D1 setup and
observations use manifest-bound SQL files and the pinned Wrangler with explicit
`--remote`, `--config`, and `--json`. Every mutation is followed by a direct
read proving its guarded predicate and exact row count.

The matrix proves:

- create and first-step D1 confirmation;
- automatic named-step retry and deterministic per-profile replay;
- retained-ID idempotence and `createBatch` recovery after an interrupted
  initial `creating` claim;
- pause/resume and same-instance restart without step-history overrides;
- errored, terminated, complete, active, invalid, failed-lookup, and
  status-unknown platform observations before any D1 mutation;
- rolling creation-minute, in-flight, active-run, and batch bounds;
- deletion before dispatch, after dispatch, before Workflow preflight, and
  after preflight, with zero R2 writes after the matching deletion fence;
- persisted purge cursor and phase across bounded passes;
- status-unknown preservation, failed-lookup idempotent materialization,
  termination, terminal proof, and R2-before-relational deletion;
- a `needs_replacement` row that remains blocking until the same host source is
  replaced or removed, then resolves through the Worker path; and
- canonical verification-run closure by the Worker with all four proof counts
  present and zero and no stale-payload authorization path.

The runner never issues an improvised production-style raw Workflow resume or
restart. Lifecycle operations are either the exact harness RPC calls or the
repository's generated, run-bound operation units.

## Evidence model

Each attempt writes beneath:

```text
output/operations/event-cover/<candidate-sha>/task-11/<run-id>/
```

Evidence is append-only during execution. Phase receipts bind their predecessor
digest so a later phase cannot silently replace earlier input. `finalize` writes
`staging-conformance.json` and `staging-conformance.json.sha256` atomically and
exclusively only when every required matrix is complete.

The passing artifact records:

- exact candidate SHA, Git tree, Task 10 manifest digest, approved base, and
  integrated main SHA;
- account and isolated resource identities;
- deployed Worker version ID, tag, timestamp, and 100% deployment identity;
- runtime `CF_VERSION_METADATA` correlation;
- migration names and hashes;
- sanitized Images and Workflow case results;
- the closed no-discriminator probe result and idempotent materialization
  observation codes, never raw errors;
- four zero-proof counts and immutable verification timestamp;
- fixture cleanup results; and
- resource destruction and absence results.

Any missing, duplicated, foreign, unknown, noncanonical, checksum-mismatched,
or secret-shaped field makes finalization fail. A partial or failed run remains
non-passing and cannot authorize Task 12.

## Cleanup and destructive boundary

The temporary discovery probe is destroyed and absence-checked immediately
after `probe`, whether discovery succeeds or fails.

During an incomplete conformance run, the harness removes only fixtures and
temporary callers that it can identify exactly. It preserves the isolated core
topology for diagnosis and records the remaining billing resources. It never
deletes a partially identified or production-matching resource.

After every matrix passes, `cleanup` verifies the exact approved staging names
and IDs, then destroys the disposable Worker, D1 database, R2 bucket, three
Workflow definitions and instances, assets attachment, and any probe resources.
It performs read-only absence checks for each target. Finalization cannot emit
`status = passed` until all fixture and resource absence checks are green.

Nothing in cleanup targets `candidary`, `candidary-core`,
`candidary-media`, or a Workflow without the exact approved staging identity.

## Error handling and resumability

- Every remote action writes a pre-action intent receipt and a post-action
  observation receipt.
- An uncertain shell or network result stops. Resume begins with read-only
  state discovery and never blindly repeats a create, migration, Workflow
  mutation, or deletion.
- Existing instances and conditional R2 objects are adopted only after exact
  identity and content verification.
- A candidate tree change invalidates all candidate and staging evidence.
- A platform behavior change, new error shape, unrecognized Workflow status,
  unexplained fence, nonzero proof count, or incomplete cleanup produces a
  non-passing artifact and no production authorization.
- Raw platform errors are retained only in the private local diagnostic stream
  for the active run and are excluded from canonical artifacts. Missing-instance
  discovery additionally refuses to persist raw messages at all.

## Test strategy

Implementation follows red-green-refactor for every behavior change.

Unit tests cover:

- closed CLI grammar and path safety;
- exact candidate, manifest, sidecar, target, and pinned-tool verification;
- production-identity rejection and route/preview/cron rejection;
- RPC input namespaces and production fail-closed behavior;
- error-fingerprint redaction and matcher discrimination;
- exact Wrangler command plans and uncertain-result recovery;
- canonical evidence, predecessor digests, sidecars, and secret/key/URL
  rejection; and
- cleanup target resolution and production-name refusal.

Worker tests cover:

- entrypoint staging sentinel and run namespace enforcement;
- sanitized return shapes;
- fail-once marker consumption;
- absent/invalid/synthetic error classification; and
- use of the existing shared accessors and cleanup path.

Local integration tests use the repository-pinned Wrangler against owned local
D1/R2/Workflow simulations where fidelity permits. Adapter fakes verify remote
command plans. Only the separately authorized final execution calls the real
Cloudflare resources.

Before the new candidate is fixed, run focused tests, both typechecks, lint, the
complete unit and Worker suites, and browser gates required by the release
runner. Then run:

```powershell
$candidateSha = (git rev-parse HEAD).Trim()
npm run verify:release -- --sha $candidateSha --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
```

Only that exact passed SHA may be redeployed and used by `conform`, `finalize`,
and `verify`.

## Completion criteria

The work is complete only when all of these are true:

1. the harness and focused tests are committed on a clean cover branch;
2. the no-discriminator platform result and idempotent materialization path have
   focused positive and negative coverage;
3. Task 10 passes on the new exact SHA with a valid independent manifest hash;
4. that exact SHA is deployed only to the approved isolated staging topology;
5. every Images, Workflow, backfill, deletion, purge, and verification case
   passes against the real platform;
6. fixtures and every disposable staging resource are destroyed and proven
   absent;
7. the immutable Task 11 artifact and sidecar independently verify as passed;
8. no change was made to `main`, no push or merge occurred, and no production
   resource was read through a private-data path or mutated; and
9. Task 12 remains unstarted and separately gated.

# Task 11 Staging Conformance Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and execute the route-less Task 11 harness so one new exact candidate proves the required Cloudflare Images, Workflows, purge, and runtime-identity behavior, then tears down the isolated staging estate and emits a checksum-verified `passed` artifact.

**Architecture:** A small staging-only `WorkerEntrypoint` exposes closed, run-scoped RPC operations over a same-account service binding. A repository-pinned Node runner owns candidate verification, route-disabled deployment, live missing-instance discovery, conformance orchestration, append-only evidence, destructive target validation, teardown, and independent verification. Existing production handlers and deployment tooling remain unchanged except for exporting the inert entrypoint and adding a sentinel-gated fail-once hook to the backfill Workflow.

**Tech Stack:** TypeScript 6, Node 24 type stripping, Vitest 4, Cloudflare Workers/Workflows/D1/R2/Images, Wrangler 4.113.0, canonical JSON and SHA-256 evidence.

## Global Constraints

- Work only in `C:\Users\htper\candidary\.worktrees\cover-studio-phase-2` on `agent/event-cover-studio-phase-2`.
- Do not edit the main checkout, push, merge, deploy production, mutate a production resource, begin Task 12, or claim device acceptance.
- Use the exact staging names approved in the design. Reject every canonical production name and every topology with a route, custom domain, `workers_dev`, preview URL, or Cron.
- Do not replace the deliberate R2 S3 placeholder secrets. Fixture transfer uses Wrangler/API or the `MEDIA_BUCKET` binding only.
- Use only the candidate's Node/npm and `node_modules/.bin/wrangler.cmd`; require Wrangler `4.113.0`; never use `npx`, PATH fallback, `migrations apply --remote`, or `scripts/deploy-release.ts`.
- Every implementation step is red-green-refactor. Run the named RED command and see the intended assertion fail before editing implementation.
- Remote steps stop on uncertain results. Resume starts with read-only discovery and predecessor-receipt verification.
- The live missing-instance discriminator is unknowable until the probe executes. Do not add a matcher before that evidence. If no stable non-message discriminator exists, retain a non-passing artifact, clean up the probe, and stop.
- A code change after Task 10 invalidates the candidate. Run the complete exact-head release gate only after all code and tests are committed.
- Do not write `status: "passed"` until conformance, fixture cleanup, resource destruction, and absence checks all verify.

---

### Task 1: Define the closed Task 11 contract and target boundary

**Files:**
- Create: `scripts/staging-release-contract.ts`
- Test: `tests/unit/staging-release-contract.test.ts`

- [ ] **Step 1: Write failing tests for identifiers, topology, and closed result shapes**

```ts
import { describe, expect, it } from 'vitest';
import {
  STAGING_TARGET,
  assertCanonicalRunId,
  assertOwnedConformanceId,
  assertSafeStagingTarget,
  conformancePrefix,
  parseMode,
} from '../../scripts/staging-release-contract';

const RUN_ID = '10000000-0000-4000-8000-000000000001';

describe('Task 11 contract', () => {
  it('accepts only the six closed modes', () => {
    for (const mode of ['probe', 'deploy', 'conform', 'cleanup', 'finalize', 'verify']) {
      expect(parseMode(mode)).toBe(mode);
    }
    expect(() => parseMode('migrate')).toThrow(/mode/u);
  });

  it('derives one run-owned namespace', () => {
    expect(assertCanonicalRunId(RUN_ID)).toBe(RUN_ID);
    expect(conformancePrefix(RUN_ID)).toBe(`conformance/${RUN_ID}/`);
    expect(assertOwnedConformanceId(RUN_ID, `c11-${RUN_ID}-event-01`)).toBeTruthy();
    expect(() => assertOwnedConformanceId(RUN_ID, 'production-event')).toThrow(/run namespace/u);
  });

  it('rejects every production or publicly reachable target', () => {
    expect(assertSafeStagingTarget(STAGING_TARGET)).toEqual(STAGING_TARGET);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, workerName: 'candidary' })).toThrow(/production/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, workersDev: true })).toThrow(/workers_dev/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, crons: ['17 3 * * *'] })).toThrow(/cron/u);
  });
});
```

- [ ] **Step 2: Run the RED test**

```powershell
npm run test:unit -- --run tests/unit/staging-release-contract.test.ts
```

Expected: FAIL because `scripts/staging-release-contract.ts` does not exist.

- [ ] **Step 3: Implement the contract with literal staging identities**

```ts
export const STAGING_ORIGIN = 'https://staging.candidary.invalid' as const;
export const STAGING_TARGET = {
  workerName: 'candidary-staging-conformance',
  databaseName: 'candidary-core-staging',
  bucketName: 'candidary-media-staging',
  workflows: {
    export: 'candidary-staging-export',
    render: 'candidary-staging-cover-render',
    backfill: 'candidary-staging-cover-backfill',
  },
  workersDev: false,
  previewUrls: false,
  routes: [] as readonly string[],
  customDomains: [] as readonly string[],
  crons: [] as readonly string[],
} as const;

export const STAGING_RELEASE_MODES = [
  'probe', 'deploy', 'conform', 'cleanup', 'finalize', 'verify',
] as const;

export type StagingReleaseMode = typeof STAGING_RELEASE_MODES[number];
export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function conformancePrefix(runId: string): string {
  return `conformance/${assertCanonicalRunId(runId)}/`;
}
```

Add exhaustive interfaces for sanitized runtime, Images, Workflow, ledger, cleanup, phase-receipt, and final-artifact records. Use string-literal vocabularies for all statuses. There must be no index signature and no field capable of carrying bytes, object keys, URLs, SQL, arbitrary platform messages, or secrets.

- [ ] **Step 4: Add negative tests for duplicate CLI flags, unknown fields, noncanonical UUIDs, symlinks, path escape, and secret-shaped values**

- [ ] **Step 5: Run focused tests and commit**

```powershell
npm run test:unit -- --run tests/unit/staging-release-contract.test.ts
git add -- scripts/staging-release-contract.ts tests/unit/staging-release-contract.test.ts
git commit -m "test: define the task 11 staging boundary"
```

---

### Task 2: Add append-only, canonical evidence receipts

**Files:**
- Create: `scripts/staging-release-evidence.ts`
- Test: `tests/unit/staging-release-evidence.test.ts`
- Reuse: `scripts/release-evidence.ts`

- [ ] **Step 1: Write failing tests for canonical receipts and predecessor chaining**

```ts
it('chains each receipt to the exact predecessor digest', () => {
  const first = makeReceipt({ phase: 'probe', predecessorSha256: null, result: probeResult });
  const second = makeReceipt({ phase: 'deploy', predecessorSha256: sha256(canonicalJson(first)), result: deployResult });
  expect(verifyReceipt(first, null).sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(verifyReceipt(second, sha256(canonicalJson(first))).sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(() => verifyReceipt(second, '0'.repeat(64))).toThrow(/predecessor/u);
});
```

Also require tests proving exclusive writes, immutable existing bytes, SHA sidecars, redaction rejection, URL/object-key/raw-error rejection, and refusal to finalize a non-cleaned run.

- [ ] **Step 2: Run the RED test**

```powershell
npm run test:unit -- --run tests/unit/staging-release-evidence.test.ts
```

- [ ] **Step 3: Implement evidence helpers by reusing `canonicalJson` and `sha256`**

```ts
export function task11Root(projectRoot: string, candidateSha: string, runId: string): string {
  return resolveInside(
    resolve(projectRoot, 'output', 'operations', 'event-cover', assertSha(candidateSha), 'task-11'),
    assertCanonicalRunId(runId),
  );
}

export function writeExclusiveCanonical(path: string, value: unknown): string {
  assertSanitizedEvidence(value);
  const bytes = `${canonicalJson(value)}\n`;
  writeFileSync(path, bytes, { encoding: 'utf8', flag: 'wx' });
  const digest = sha256(bytes);
  writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`, { encoding: 'utf8', flag: 'wx' });
  return digest;
}
```

Use temporary sibling files plus atomic rename only for the final artifact, and refuse if either destination already exists. Phase receipts themselves use `wx` and monotonically numbered file names.

- [ ] **Step 4: Add a final verifier that reparses and rehashes every predecessor, input digest, and sidecar**

- [ ] **Step 5: Run focused tests and commit**

```powershell
npm run test:unit -- --run tests/unit/staging-release-evidence.test.ts
git add -- scripts/staging-release-evidence.ts tests/unit/staging-release-evidence.test.ts
git commit -m "test: bind task 11 evidence receipts"
```

---

### Task 3: Verify the immutable candidate and build an owned staging deploy root

**Files:**
- Create: `scripts/staging-release-candidate.ts`
- Test: `tests/unit/staging-release-candidate.test.ts`
- Modify: `package.json`
- Reuse: `scripts/release-evidence.ts`

- [ ] **Step 1: Write failing fixture tests for exact-head verification**

Test full 40-character SHA matching, clean tree, manifest/sidecar hash, `status: passed`, all fourteen successful gates, migration count and hashes, generated artifacts, pinned Wrangler, and source topology. Mutating one byte in each fixture must fail.

```ts
expect(verifyTask10Candidate(fixture.root, fixture.sha)).toMatchObject({
  sha: fixture.sha,
  wranglerVersion: '4.113.0',
  migrationCount: 13,
});
expect(() => verifyTask10Candidate(fixture.root, 'f'.repeat(40))).toThrow(/HEAD/u);
```

- [ ] **Step 2: Write failing topology-overlay tests**

The generated `wrangler.staging.jsonc` must set the exact approved names, `APP_ORIGIN`, version metadata, no routes, `workers_dev: false`, `preview_urls: false`, and no triggers. It must preserve Images, assets, Email, rate-limit, observability, placement, and the exact secret-name set without preserving production resource identities.

- [ ] **Step 3: Run the RED test**

```powershell
npm run test:unit -- --run tests/unit/staging-release-candidate.test.ts
```

- [ ] **Step 4: Implement read-only candidate verification and owned-root copying**

```ts
export interface VerifiedCandidate {
  readonly sha: string;
  readonly tree: string;
  readonly manifestSha256: string;
  readonly migrationManifestSha256: string;
  readonly wranglerPath: string;
  readonly wranglerVersion: '4.113.0';
}

export function createOwnedDeployRoot(candidate: VerifiedCandidate, runRoot: string): OwnedDeployRoot {
  // Copy only manifest-bound dist/candidary files plus migrations into a new,
  // non-symlinked directory. Rehash every copied byte before returning.
}
```

Do not call `scripts/deploy-release.ts`. Accept the staging D1 ID only from the separately hashed target authorization record and reject the production D1 ID even if its name is altered.

- [ ] **Step 5: Add the CLI package script**

```json
"release:staging": "node --experimental-strip-types scripts/staging-release.ts"
```

- [ ] **Step 6: Run focused tests and commit**

```powershell
npm run test:unit -- --run tests/unit/staging-release-candidate.test.ts
git add -- package.json scripts/staging-release-candidate.ts tests/unit/staging-release-candidate.test.ts
git commit -m "test: verify task 11 staging candidates"
```

---

### Task 4: Build the redacting missing-instance discovery probe

**Files:**
- Create: `scripts/staging-release-probe.ts`
- Create: `worker/staging-workflow-probe.ts`
- Test: `tests/unit/staging-release-probe.test.ts`

- [ ] **Step 1: Write failing sanitizer and qualifier tests**

```ts
it('never retains messages, stacks, identifiers, URLs, or unknown scalars', () => {
  const error = Object.assign(new Error('instance abc at https://example.invalid'), {
    code: 10091,
    instanceId: 'abc',
    internal: 'secret',
  });
  expect(fingerprintWorkflowError(error)).toEqual({
    constructorFamily: 'Error',
    name: 'Error',
    code: 10091,
    ownKeys: ['code', 'instanceId', 'internal'],
  });
});

it('qualifies exactly one value stable for absent IDs and distinct elsewhere', () => {
  expect(qualifyMissingFingerprint(samples)).toEqual({ field: 'code', value: 10091 });
  expect(() => qualifyMissingFingerprint(ambiguousSamples)).toThrow(/stable discriminator/u);
});
```

Allow only constructor family, `name`, exact own-key names, and scalar fields whose names are in a fixed `code` allowlist. Never read or serialize `message`, `stack`, `cause`, response bodies, IDs, or URLs.

- [ ] **Step 2: Run the RED test**

```powershell
npm run test:unit -- --run tests/unit/staging-release-probe.test.ts
```

- [ ] **Step 3: Implement the minimal route-disabled probe module and deploy plan**

```ts
export class StagingWorkflowProbe extends WorkerEntrypoint<ProbeEnv> {
  async sample(instanceId: string): Promise<WorkflowErrorFingerprint | { readonly outcome: 'found' }> {
    try {
      await this.env.COVER_BACKFILL_WORKFLOW.get(instanceId).status();
      return { outcome: 'found' };
    } catch (error) {
      return fingerprintForRpc(error); // same hard allowlist; no message access
    }
  }
}
```

Generate a temporary config with only the existing isolated backfill Workflow binding, version metadata, no route, no assets, no D1/R2/Images/Email/rate limits, no Cron, and `workers_dev`/preview disabled. Generate a local caller config with `services[].entrypoint = "StagingWorkflowProbe"`, remote service binding enabled, and a listener on `127.0.0.1` only.

- [ ] **Step 4: Test cleanup is unconditional**

The adapter test must prove `wrangler delete` plus absence lookup runs after success, qualification failure, deploy failure after creation, and interrupted caller startup.

- [ ] **Step 5: Run focused tests and commit**

```powershell
npm run test:unit -- --run tests/unit/staging-release-probe.test.ts
git add -- scripts/staging-release-probe.ts worker/staging-workflow-probe.ts tests/unit/staging-release-probe.test.ts
git commit -m "test: add the workflow missing-instance probe"
```

---

### Task 5: Add the sentinel-gated candidate RPC entrypoint

**Files:**
- Create: `worker/staging-conformance.ts`
- Modify: `worker/index.ts`
- Modify: `worker/env.ts` only if generated binding types require a narrow local augmentation
- Test: `tests/worker/staging-conformance.test.ts`

- [ ] **Step 1: Write failing Worker tests for fail-closed authorization**

Instantiate the entrypoint with a fake environment and prove production origin, malformed run ID, foreign event/job/instance ID, and foreign R2 prefix fail before any fake binding records a call.

```ts
await expect(entrypoint.runtimeIdentity({ runId: RUN_ID })).rejects.toThrow('STAGING_CONFORMANCE_DISABLED');
expect(bindingCalls).toEqual([]);
```

- [ ] **Step 2: Write failing tests for sanitized runtime and image methods**

The runtime result is exactly `{ versionId, versionTag, versionTimestamp }`. Image results are exactly `{ caseId, outcome, detectedType, format, width, height, byteSize, sha256, qualityRung, adopted }`; assert that serialized results contain none of `key`, `url`, `bytes`, `message`, or fixture payload.

- [ ] **Step 3: Write failing tests that each operation delegates to existing shared functions**

Inject narrow adapters around `readCoverSourceInfo`, `normalizeCoverMaster`, `renderCoverPreview`, `renderCoverProfileObject`, Workflow accessors, and `scheduledCleanup`. Do not duplicate image or purge policy inside the entrypoint.

- [ ] **Step 4: Run the RED test**

```powershell
npm run test:worker -- --run tests/worker/staging-conformance.test.ts
```

- [ ] **Step 5: Implement `StagingConformanceEntrypoint`**

```ts
export class StagingConformanceEntrypoint extends WorkerEntrypoint<AppEnv> {
  runtimeIdentity(input: RunRequest): RuntimeIdentityResult {
    const scope = assertStagingScope(this.env, input);
    const metadata = this.env.CF_VERSION_METADATA;
    return sanitizeRuntimeIdentity(metadata, scope);
  }

  async runScheduledCleanup(input: CleanupRequest): Promise<CleanupResult> {
    assertStagingScope(this.env, input);
    await scheduledCleanup(this.env, new Date(assertUtcInstant(input.now)));
    return readCleanupSummary(this.env, input.runId);
  }
}
```

Expose only the approved methods. Put all namespace checks in one pure guard, use fixed error codes, and return closed records. Export it from `worker/index.ts` with `WorkerEntrypoint` imported from `cloudflare:workers`. The default handler and production configuration remain unchanged.

- [ ] **Step 6: Run focused tests and commit**

```powershell
npm run test:worker -- --run tests/worker/staging-conformance.test.ts
npm run typecheck
git add -- worker/staging-conformance.ts worker/index.ts worker/env.ts tests/worker/staging-conformance.test.ts
git commit -m "feat: expose route-less staging conformance RPC"
```

---

### Task 6: Add one deterministic Workflow fail-once boundary

**Files:**
- Create: `worker/workflows/staging-conformance-fault.ts`
- Modify: `worker/index.ts`
- Test: `tests/worker/staging-conformance-fault.test.ts`
- Test: `tests/worker/cover-backfill-workflow.test.ts`

- [ ] **Step 1: Write failing tests for dormant production behavior and one-time staging failure**

```ts
expect(await consumeStagingFailOnce(productionEnv, payload, 'normalize')).toBe(false);
expect(productionBucketCalls).toEqual([]);

await expect(consumeStagingFailOnce(stagingEnv, payload, 'normalize')).rejects.toThrow('STAGING_CONFORMANCE_FAIL_ONCE');
expect(await consumeStagingFailOnce(stagingEnv, payload, 'normalize')).toBe(false);
```

The armed marker must be beneath the run prefix and name one enum step. Deletion must use the marker's observed identity/etag; a changed marker fails closed.

- [ ] **Step 2: Run the RED test**

```powershell
npm run test:worker -- --run tests/worker/staging-conformance-fault.test.ts tests/worker/cover-backfill-workflow.test.ts
```

- [ ] **Step 3: Implement the helper and invoke it at the normalization step boundary**

```ts
await step.do('normalize legacy cover master', async () => {
  await consumeStagingFailOnce(this.env, event.payload, 'normalize');
  return coverBackfillNormalize(this.env, event.payload);
});
```

Production must execute only the `APP_ORIGIN !== STAGING_ORIGIN` comparison before returning. The helper must not expose arbitrary step names, object paths, delays, or error strings.

- [ ] **Step 4: Run focused tests and commit**

```powershell
npm run test:worker -- --run tests/worker/staging-conformance-fault.test.ts tests/worker/cover-backfill-workflow.test.ts
git add -- worker/workflows/staging-conformance-fault.ts worker/index.ts tests/worker/staging-conformance-fault.test.ts tests/worker/cover-backfill-workflow.test.ts
git commit -m "test: prove one-time backfill workflow retry"
```

---

### Task 7: Define reproducible image fixtures and the complete §15.5 case matrix

**Files:**
- Create: `scripts/staging-release-fixtures.ts`
- Create: `scripts/staging-release-images.ts`
- Test: `tests/unit/staging-release-fixtures.test.ts`
- Test: `tests/unit/staging-release-images.test.ts`
- Runtime input: ignored `output/staging-input/task-11-fixtures.json` and digest-addressed fixture files

- [ ] **Step 1: Write failing fixture-manifest tests**

Require JPEG, opaque PNG, transparent PNG, WebP, iPhone HEIC, rejected HEIF/sequence, EXIF orientation, GPS metadata, 19,000,000 bytes, 19,000,001 bytes, complete 2x, partial 2x, and dense ladder inputs. Each entry requires case ID, SHA-256, byte size, MIME claim, provenance kind, and license/source digest when externally sourced. Reject private paths and inline bytes.

- [ ] **Step 2: Write failing matrix-coverage tests**

```ts
expect(assertCompleteImageMatrix(plan)).toMatchObject({
  masterRungs: [1, 2, 3, 4, 5],
  previewRungs: [1, 2, 3, 4],
  effects: ['natural', 'warm', 'cool', 'mono', 'vivid'],
  formats: ['webp', 'jpeg'],
});
```

Assert every output quality rung, trim/focal crop, transparent matte parity, no-upscale, complete/partial 2x, metadata stripping, conditional adoption, MIME/dimensions/ceilings/checksum/inventory.

- [ ] **Step 3: Run the RED tests**

```powershell
npm run test:unit -- --run tests/unit/staging-release-fixtures.test.ts tests/unit/staging-release-images.test.ts
```

- [ ] **Step 4: Implement deterministic local generation and provenance verification**

Generate safe synthetic raster inputs deterministically. Store external HEIC/HEIF fixtures only under ignored output with pinned HTTPS source, source revision, license, byte count, and SHA-256. The acquisition command must require the expected digest before renaming into place. Never use user media.

- [ ] **Step 5: Implement the image case planner and result reducer**

Each case uploads under the run-owned prefix, calls the candidate RPC method, independently downloads only its known fixture output through Wrangler for digest/metadata inspection, reduces the observation to the approved numeric/closed fields, then deletes the local downloaded bytes. An unexpected presigning request is the fixed blocker `R2_PRESIGNING_REQUIRED`.

- [ ] **Step 6: Run focused tests and commit source only**

```powershell
npm run test:unit -- --run tests/unit/staging-release-fixtures.test.ts tests/unit/staging-release-images.test.ts
git add -- scripts/staging-release-fixtures.ts scripts/staging-release-images.ts tests/unit/staging-release-fixtures.test.ts tests/unit/staging-release-images.test.ts
git commit -m "test: define the task 11 images matrix"
```

Do not stage ignored fixture bytes or runtime manifests.

---

### Task 8: Define the Workflow, ledger, deletion, purge, and verification matrices

**Files:**
- Create: `scripts/staging-release-workflows.ts`
- Create: `scripts/staging-release-sql.ts`
- Test: `tests/unit/staging-release-workflows.test.ts`
- Test: `tests/unit/staging-release-sql.test.ts`
- Reuse: `shared/cover-dispatch.ts`
- Reuse: `shared/cover-backfill-proof.ts`
- Reuse: `scripts/cover-backfill.ts`

- [ ] **Step 1: Write failing matrix-completeness tests**

Require case IDs for create/confirm, automatic retry, retained ID, interrupted-claim `createBatch`, pause/resume/restart/terminate, all platform mappings, active-run/in-flight/minute/batch bounds, four deletion timing cases, purge cursor/phases, unknown retry, certified-missing materialize/terminate, terminal proof, R2-before-relational deletion, needs-replacement resolution, and four-zero verification closure.

- [ ] **Step 2: Write failing SQL safety tests**

Each mutation unit must be a tracked file whose SHA is included in its intent receipt. It must bind only deterministic run-owned IDs, contain a guarded predicate, and be followed by an exact read with expected row count. Reject arbitrary SQL arguments and production database identities.

- [ ] **Step 3: Run the RED tests**

```powershell
npm run test:unit -- --run tests/unit/staging-release-workflows.test.ts tests/unit/staging-release-sql.test.ts
```

- [ ] **Step 4: Implement deterministic case IDs and bounded operation units**

Use existing cover-backfill planner/proof helpers for claim and closure semantics. Use RPC for Workflow lifecycle actions and the same Worker cleanup function for purge. Record only closed dispositions, counts, phases, timestamps, and digests.

- [ ] **Step 5: Encode ordering assertions**

For every deletion case, compare pre-fence and post-fence R2 inventory counts. For purge, require persisted cursor/phase observations and an R2-absence observation before a relational-row-absence observation. For verification closure, require exactly four named counts and all values `0`, followed by a Worker-written immutable `verified_at` associated with the candidate SHA.

- [ ] **Step 6: Run focused tests and commit**

```powershell
npm run test:unit -- --run tests/unit/staging-release-workflows.test.ts tests/unit/staging-release-sql.test.ts
git add -- scripts/staging-release-workflows.ts scripts/staging-release-sql.ts tests/unit/staging-release-workflows.test.ts tests/unit/staging-release-sql.test.ts
git commit -m "test: define task 11 workflow conformance"
```

---

### Task 9: Implement the six-mode orchestrator and destructive cleanup guard

**Files:**
- Create: `scripts/staging-release.ts`
- Create: `scripts/staging-release-cloudflare.ts`
- Test: `tests/unit/staging-release.test.ts`
- Test: `tests/unit/staging-release-cloudflare.test.ts`

- [ ] **Step 1: Write failing CLI state-machine tests**

Require the only passing order `probe -> deploy -> conform -> cleanup -> finalize -> verify`. A resumed phase must independently verify the predecessor receipt and re-observe remote identity. Unknown/duplicate flags, missing authorization, candidate drift, target drift, or a skipped phase must fail before adapter calls.

- [ ] **Step 2: Write failing exact-command-plan tests**

Assert every command uses the candidate's pinned executable and explicit `--config`, account, remote/local mode, and JSON where supported. Assert no planned argument includes `npx`, production names, `migrations apply`, or `scripts/deploy-release.ts`.

- [ ] **Step 3: Write failing cleanup guard tests**

Cleanup must accept only exact name-and-ID pairs already bound into the target digest. It must reject `candidary`, `candidary-core`, `candidary-media`, unprefixed Workflow names, partial IDs, missing intent receipts, and changed remote observations. Prove incomplete-run cleanup preserves the core staging estate while green-run cleanup destroys it.

- [ ] **Step 4: Run the RED tests**

```powershell
npm run test:unit -- --run tests/unit/staging-release.test.ts tests/unit/staging-release-cloudflare.test.ts
```

- [ ] **Step 5: Implement an injectable Cloudflare adapter**

```ts
export interface StagingCloudflareAdapter {
  runWrangler(args: readonly string[], options: ExactCommandOptions): Promise<ExactCommandResult>;
  callCandidateRpc<T>(method: CandidateRpcMethod, payload: unknown): Promise<T>;
  observeTarget(): Promise<ObservedStagingTarget>;
}
```

Capture stdout/stderr only in the private diagnostic file. Sanitizers convert expected results to canonical receipts; uncertain exit, non-JSON output, identity mismatch, or unfamiliar status stops the phase.

- [ ] **Step 6: Implement the six modes**

`probe` discovers and immediately removes the temporary probe. `deploy` applies the 13 manifest-hashed migrations to a fresh approved D1 and deploys the exact candidate. `conform` runs all image/workflow matrices. `cleanup` first removes run fixtures, then on green destroys the approved Worker, D1, R2, three Workflow definitions/instances, caller, assets attachment, and probe remnants and observes absence. `finalize` emits only a complete artifact. `verify` reparses/re-hashes without trusting in-memory state.

- [ ] **Step 7: Run focused tests and commit**

```powershell
npm run test:unit -- --run tests/unit/staging-release.test.ts tests/unit/staging-release-cloudflare.test.ts
npm run typecheck
npm run lint
git add -- scripts/staging-release.ts scripts/staging-release-cloudflare.ts tests/unit/staging-release.test.ts tests/unit/staging-release-cloudflare.test.ts
git commit -m "feat: orchestrate task 11 staging conformance"
```

---

### Task 10: Execute the live discovery gate and certify exactly one matcher

**Files:**
- Modify only after evidence: `worker/workflows/cover-platform.ts`
- Test: `tests/worker/cover-backfill-workflow.test.ts`
- Evidence: `output/operations/event-cover/<pre-candidate-sha>/task-11/<run-id>/...`

- [ ] **Step 1: Record current branch identity and run all local focused tests**

```powershell
$preProbeSha = (git rev-parse HEAD).Trim()
git status --short
npm run test:unit -- --run tests/unit/staging-release*.test.ts
npm run test:worker -- --run tests/worker/staging-conformance*.test.ts tests/worker/cover-backfill-workflow.test.ts
```

- [ ] **Step 2: Run `probe` against only the approved isolated Workflow**

```powershell
npm run release:staging -- probe --candidate-sha $preProbeSha --run-id <canonical-run-id> --target <hashed-target-authorization-path>
```

Inspect the sanitized receipt and independently confirm the temporary probe Worker is absent. If the result is ambiguous or absent, stop with a non-passing artifact; do not modify the matcher.

- [ ] **Step 3: Write the RED matcher test from the exact observed structural property**

The literal test uses only the qualifying property. It must also prove invalid IDs, synthetic failures, unknown shapes, and message-only lookalikes remain `unknown`.

```ts
expect(classifyWorkflowLookupError(platformAbsentShape)).toEqual({ kind: 'missing' });
expect(classifyWorkflowLookupError(new Error('not found'))).toEqual({ kind: 'unknown' });
```

- [ ] **Step 4: Run the RED test, then implement exactly one matcher**

```powershell
npm run test:worker -- --run tests/worker/cover-backfill-workflow.test.ts
```

Add one narrow predicate to `CERTIFIED_NOT_FOUND_MATCHERS`. It may inspect only the one platform-proven structural field plus necessary object/type guards. It must not inspect message text or broaden any existing status mapping.

- [ ] **Step 5: Run focused tests and commit**

```powershell
npm run test:worker -- --run tests/worker/cover-backfill-workflow.test.ts tests/worker/staging-conformance.test.ts
git add -- worker/workflows/cover-platform.ts tests/worker/cover-backfill-workflow.test.ts
git commit -m "fix: certify the workflow missing-instance shape"
```

---

### Task 11: Verify and fix the implementation before freezing the candidate

**Files:** all Task 11 source and tests

- [ ] **Step 1: Run focused unit and Worker suites**

```powershell
npm run test:unit -- --run tests/unit/staging-release-contract.test.ts tests/unit/staging-release-evidence.test.ts tests/unit/staging-release-candidate.test.ts tests/unit/staging-release-probe.test.ts tests/unit/staging-release-fixtures.test.ts tests/unit/staging-release-images.test.ts tests/unit/staging-release-workflows.test.ts tests/unit/staging-release-sql.test.ts tests/unit/staging-release.test.ts tests/unit/staging-release-cloudflare.test.ts
npm run test:worker -- --run tests/worker/staging-conformance.test.ts tests/worker/staging-conformance-fault.test.ts tests/worker/cover-backfill-workflow.test.ts
```

- [ ] **Step 2: Run typechecks, lint, full unit, and full Worker suites**

```powershell
npm run typecheck
npm run typecheck:e2e
npm run lint
npm run test:unit
npm run test:worker
git diff --check 0b92387d2e237d568d2514373dcc3044e7960d4b HEAD
```

- [ ] **Step 3: Review scope and production dormancy**

Confirm `wrangler.jsonc` production identities and triggers are byte-unchanged, `scripts/deploy-release.ts` is unchanged, the main checkout still points to its original SHA, and no staged/untracked file outside Task 11 is present.

- [ ] **Step 4: Commit any review fixes and repeat Steps 1-3**

No uncommitted code may enter the candidate gate.

---

### Task 12: Run the new immutable Task 10 candidate gate

**Evidence:** ignored `output/release/<candidate-sha>/candidate-manifest.json` and sidecar

- [ ] **Step 1: Fix the exact candidate SHA and prove the tree is clean**

```powershell
$candidateSha = (git rev-parse HEAD).Trim()
if ((git status --porcelain).Length -ne 0) { throw 'Candidate tree is not clean.' }
```

- [ ] **Step 2: Run the full fourteen-gate release verifier**

```powershell
npm run verify:release -- --sha $candidateSha --base-sha 0b92387d2e237d568d2514373dcc3044e7960d4b
if ($LASTEXITCODE -ne 0) { throw 'Task 10 candidate gate failed.' }
```

- [ ] **Step 3: Independently hash and inspect the manifest**

Require exact candidate/base/tree, `status: passed`, fourteen green commands, migration count 13, terminal schema exactly three keys, expected staging-deployable artifacts, and a sidecar digest equal to the exact manifest bytes.

- [ ] **Step 4: Recheck HEAD and cleanliness**

Any drift invalidates the gate and returns to Task 11.

---

### Task 13: Redeploy the exact candidate and run complete remote conformance

**Evidence:** append-only Task 11 run directory

- [ ] **Step 1: Create a new canonical run ID and archive the old partial artifact by digest**

The archive receipt references the old artifact and sidecar; it does not rewrite either file.

- [ ] **Step 2: Run the passing phase sequence through `conform`**

```powershell
npm run release:staging -- probe --candidate-sha $candidateSha --run-id $runId --target $targetAuthorization
npm run release:staging -- deploy --candidate-sha $candidateSha --run-id $runId --target $targetAuthorization
npm run release:staging -- conform --candidate-sha $candidateSha --run-id $runId --target $targetAuthorization
```

After each command, independently inspect the new receipt, confirm its predecessor hash, recheck Git identity, and observe remote identity. `deploy` must prove 100% of the route-disabled Worker deployment is the new version and runtime metadata equals it.

- [ ] **Step 3: Review every conformance result before teardown**

Require every Images case, Workflow lifecycle case, bound, deletion fence, purge ordering case, needs-replacement resolution, and the four-zero verification closure. A missing or unknown case stops and preserves the core isolated topology for diagnosis.

---

### Task 14: Tear down staging, finalize, and independently verify Task 11

**Evidence:** `output/operations/event-cover/<candidate-sha>/task-11/<run-id>/staging-conformance.json` and `.sha256`

- [ ] **Step 1: Run exact-target cleanup after all matrix checks are green**

```powershell
npm run release:staging -- cleanup --candidate-sha $candidateSha --run-id $runId --target $targetAuthorization
```

Require deletion and read-only absence proof for the Worker, D1, R2 bucket, three Workflow definitions and their instances, temporary caller, assets attachment, and probe. Record whether each deleted resource is recoverable; none is expected to be recoverable.

- [ ] **Step 2: Finalize and verify from disk**

```powershell
npm run release:staging -- finalize --candidate-sha $candidateSha --run-id $runId --target $targetAuthorization
npm run release:staging -- verify --candidate-sha $candidateSha --run-id $runId --target $targetAuthorization
```

- [ ] **Step 3: Perform independent final checks**

Rehash the Task 10 manifest, every Task 11 receipt, final JSON, and final sidecar. Confirm `status: passed`, exact candidate/runtime/deployment correlation, four zeros, fixture absence, staging-resource absence, no raw secret/key/URL/error fields, clean candidate tree, unchanged main HEAD, no push/merge/production action, and Task 12 unstarted.

- [ ] **Step 4: Report the exact candidate and artifact paths**

Report any destroyed resources explicitly and state they are not recoverable. Do not call the production gate authorized; say only that Task 11 is passed and Task 12 remains separately gated.

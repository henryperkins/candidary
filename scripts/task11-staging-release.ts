import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256 } from './release-evidence.ts';
import {
  assertCandidateSha,
  assertCanonicalRunId,
  assertSanitizedValue,
  parseStagingArgs,
  resolveSafeExistingInput,
  type CleanupObservation,
  type RuntimeIdentityResult,
  type StagingReleaseMode,
} from './staging-release-contract.ts';
import {
  assertStagingTargetAuthorization,
  type StagingTargetAuthorization,
} from './staging-release-candidate.ts';
import {
  assertCompleteCleanup,
  makePhaseReceipt,
  task11Root,
  verifyReceiptFile,
  writeFinalArtifact,
  writePhaseReceipt,
  type VerifiedReceipt,
} from './staging-release-evidence.ts';
import type {
  ProbeDiscoveryFallbackResult,
  ProbeDiscoveryResult,
} from './staging-release-probe.ts';

const APPROVED_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b' as const;
const INTEGRATED_MAIN_SHA = 'b5339a0cb211b933366059af8fa3f89488bb4e20' as const;
const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface Task11CandidateEvidence {
  readonly sha: string;
  readonly tree: string;
  readonly manifestSha256: string;
  readonly migrationManifestSha256: string;
  readonly approvedBaseSha: typeof APPROVED_BASE_SHA;
  readonly integratedMainSha: typeof INTEGRATED_MAIN_SHA;
}

export interface Task11DeployResult {
  readonly status: 'passed';
  readonly versionId: string;
  readonly trafficPercent: 100;
  readonly sourceDigest: string;
  readonly migrationCount: 13;
  readonly migrationLedgerSha256: string;
}

export interface Task11MatrixObservation {
  readonly caseId: string;
  readonly status: 'passed';
  readonly observationCode: string;
}

export interface Task11ConformanceResult {
  readonly status: 'passed';
  readonly runtime: RuntimeIdentityResult;
  readonly fixtureManifestSha256: string;
  readonly images: readonly Task11MatrixObservation[];
  readonly workflows: readonly Task11MatrixObservation[];
  readonly zeroProof: {
    readonly legacyRows: 0;
    readonly blockingJobs: 0;
    readonly incompleteActiveSets: 0;
    readonly uploadsWithoutActiveSet: 0;
  };
  readonly verifiedAt: string;
}

export interface StagingReleasePhaseAdapters {
  readonly now: () => string;
  readonly verifyCandidate: (
    projectRoot: string,
    candidateSha: string,
  ) => Task11CandidateEvidence;
  readonly probe: (context: Task11RemoteContext) => Promise<ProbeDiscoveryResult | ProbeDiscoveryFallbackResult>;
  readonly deploy: (context: Task11RemoteContext) => Promise<Task11DeployResult>;
  readonly conform: (context: Task11RemoteContext) => Promise<Task11ConformanceResult>;
  readonly cleanup: (context: Task11RemoteContext) => Promise<CleanupObservation>;
}

export interface StagingReleasePhaseRequest {
  readonly projectRoot: string;
  readonly mode: StagingReleaseMode;
  readonly candidateSha: string;
  readonly runId: string;
  readonly targetPath: string;
}

export interface Task11RemoteContext {
  readonly projectRoot: string;
  readonly runRoot: string;
  readonly candidate: Task11CandidateEvidence;
  readonly runId: string;
  readonly target: StagingTargetAuthorization;
  readonly targetPath: string;
  readonly targetSha256: string;
}

interface ReceiptEnvelope<Result> {
  readonly status: 'passed';
  readonly candidateTree: string;
  readonly manifestSha256: string;
  readonly targetSha256: string;
  readonly observation: Result;
}

const PHASE_SEQUENCE = [
  'probe', 'deploy', 'conform', 'cleanup', 'finalize', 'verify',
] as const satisfies readonly StagingReleaseMode[];

function canonicalInstant(value: string): string {
  if (!ISO_PATTERN.test(value) || new Date(value).toISOString() !== value) {
    throw new Error('Task 11 adapter returned a noncanonical timestamp.');
  }
  return value;
}

function assertSha1(value: string, label: string): string {
  if (!SHA1_PATTERN.test(value)) throw new Error(`${label} is not a lowercase Git SHA.`);
  return value;
}

function assertSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} is not a lowercase SHA-256 digest.`);
  return value;
}

function verifyCandidateEvidence(
  value: Task11CandidateEvidence,
  candidateSha: string,
): Task11CandidateEvidence {
  if (value.sha !== candidateSha) throw new Error('Task 11 candidate verifier returned a different SHA.');
  assertSha1(value.sha, 'Candidate SHA');
  assertSha1(value.tree, 'Candidate tree');
  assertSha256(value.manifestSha256, 'Candidate manifest digest');
  assertSha256(value.migrationManifestSha256, 'Migration manifest digest');
  if (value.approvedBaseSha !== APPROVED_BASE_SHA || value.integratedMainSha !== INTEGRATED_MAIN_SHA) {
    throw new Error('Task 11 candidate base or integrated main identity is not approved.');
  }
  return value;
}

function readTarget(
  projectRoot: string,
  targetPath: string,
): { path: string; sha256: string; value: StagingTargetAuthorization } {
  const path = resolveSafeExistingInput(projectRoot, targetPath);
  const bytes = readFileSync(path);
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  return {
    path,
    sha256: sha256(bytes),
    value: assertStagingTargetAuthorization(parsed),
  };
}

function phasePath(runRoot: string, sequence: number, phase: StagingReleaseMode): string {
  return resolve(runRoot, `${String(sequence).padStart(2, '0')}-${phase}.json`);
}

function expectedPredecessors(mode: StagingReleaseMode): readonly StagingReleaseMode[] {
  const index = PHASE_SEQUENCE.indexOf(mode);
  if (index < 0) throw new Error('Task 11 mode is unknown.');
  return PHASE_SEQUENCE.slice(0, index);
}

interface LoadedReceipt<Result = unknown> {
  readonly phase: StagingReleaseMode;
  readonly sha256: string;
  readonly result: ReceiptEnvelope<Result>;
}

function loadPredecessors(
  runRoot: string,
  request: StagingReleasePhaseRequest,
  context: Task11RemoteContext,
): LoadedReceipt[] {
  const expected = expectedPredecessors(request.mode);
  let predecessor: string | null = null;
  const loaded: LoadedReceipt[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const phase = expected[index]!;
    const path = phasePath(runRoot, index + 1, phase);
    if (!existsSync(path) || !existsSync(`${path}.sha256`)) {
      throw new Error(`Task 11 predecessor ${phase} is missing.`);
    }
    const verified: VerifiedReceipt<ReceiptEnvelope<unknown>> = verifyReceiptFile<ReceiptEnvelope<unknown>>(
      path,
      predecessor,
    );
    const receipt = verified.receipt;
    if (receipt.phase !== phase || receipt.candidateSha !== request.candidateSha
      || receipt.runId !== request.runId) {
      throw new Error(`Task 11 predecessor ${phase} identity does not match.`);
    }
    const result = receipt.result;
    if (result === null || typeof result !== 'object' || result.status !== 'passed'
      || result.candidateTree !== context.candidate.tree
      || result.manifestSha256 !== context.candidate.manifestSha256
      || result.targetSha256 !== context.targetSha256) {
      throw new Error(`Task 11 predecessor ${phase} binding does not match.`);
    }
    loaded.push({ phase, sha256: verified.sha256, result });
    predecessor = verified.sha256;
  }
  return loaded;
}

function envelope<Result>(
  context: Task11RemoteContext,
  observation: Result,
): ReceiptEnvelope<Result> {
  const result: ReceiptEnvelope<Result> = {
    status: 'passed',
    candidateTree: context.candidate.tree,
    manifestSha256: context.candidate.manifestSha256,
    targetSha256: context.targetSha256,
    observation,
  };
  assertSanitizedValue(result);
  return result;
}

function writeReceipt<Result>(
  context: Task11RemoteContext,
  mode: StagingReleaseMode,
  predecessors: readonly LoadedReceipt[],
  now: string,
  observation: Result,
) {
  const sequence = PHASE_SEQUENCE.indexOf(mode) + 1;
  if (sequence < 1) throw new Error('Task 11 mode is unknown.');
  const predecessorSha256 = predecessors.at(-1)?.sha256 ?? null;
  const receipt = makePhaseReceipt({
    phase: mode,
    candidateSha: context.candidate.sha,
    runId: context.runId,
    predecessorSha256,
    recordedAt: canonicalInstant(now),
    result: envelope(context, observation),
  });
  return writePhaseReceipt(context.runRoot, sequence, receipt);
}

function artifactPath(runRoot: string): string {
  return resolve(runRoot, 'staging-conformance.json');
}

function parseArtifactSidecar(path: string): string {
  const match = /^([0-9a-f]{64}) {2}staging-conformance\.json\r?\n$/u.exec(
    readFileSync(`${path}.sha256`, 'utf8'),
  );
  if (!match) throw new Error('Task 11 artifact sidecar format is invalid.');
  return match[1]!;
}

function verifyArtifact(
  path: string,
  context: Task11RemoteContext,
): { value: Record<string, unknown>; sha256: string } {
  if (!existsSync(path) || !existsSync(`${path}.sha256`)) {
    throw new Error('Task 11 final artifact is missing.');
  }
  const bytes = readFileSync(path, 'utf8');
  const digest = sha256(bytes);
  if (parseArtifactSidecar(path) !== digest) {
    throw new Error('Task 11 final artifact sidecar does not match.');
  }
  const value = JSON.parse(bytes) as Record<string, unknown>;
  if (value.kind !== 'candidary.task-11-staging-conformance'
    || value.schemaVersion !== 1 || value.status !== 'passed'
    || value.candidateSha !== context.candidate.sha || value.runId !== context.runId
    || value.targetSha256 !== context.targetSha256) {
    throw new Error('Task 11 final artifact identity or status does not match.');
  }
  assertCompleteCleanup(value.cleanup);
  assertSanitizedValue(value);
  if (`${canonicalJson(value)}\n` !== bytes) {
    throw new Error('Task 11 final artifact bytes are noncanonical.');
  }
  return { value, sha256: digest };
}

function contextFor(request: StagingReleasePhaseRequest, adapters: StagingReleasePhaseAdapters): Task11RemoteContext {
  const projectRoot = realpathSync(request.projectRoot);
  const candidateSha = assertCandidateSha(request.candidateSha);
  const runId = assertCanonicalRunId(request.runId);
  const target = readTarget(projectRoot, request.targetPath);
  const candidate = verifyCandidateEvidence(adapters.verifyCandidate(projectRoot, candidateSha), candidateSha);
  return {
    projectRoot,
    runRoot: task11Root(projectRoot, candidateSha, runId),
    candidate,
    runId,
    target: target.value,
    targetPath: target.path,
    targetSha256: target.sha256,
  };
}

export async function runStagingReleasePhase(
  request: StagingReleasePhaseRequest,
  adapters: StagingReleasePhaseAdapters,
): Promise<unknown> {
  const context = contextFor(request, adapters);
  const predecessors = loadPredecessors(context.runRoot, request, context);
  const now = canonicalInstant(adapters.now());

  if (request.mode === 'probe') {
    const result = await adapters.probe(context);
    if (result.status !== 'passed' || result.probeAbsent !== true) {
      throw new Error('Task 11 probe did not pass with proved cleanup.');
    }
    return writeReceipt(context, 'probe', predecessors, now, result);
  }
  if (request.mode === 'deploy') {
    const result = await adapters.deploy(context);
    if (result.status !== 'passed' || result.trafficPercent !== 100
      || result.migrationCount !== 13) {
      throw new Error('Task 11 deployment did not close.');
    }
    return writeReceipt(context, 'deploy', predecessors, now, result);
  }
  if (request.mode === 'conform') {
    const result = await adapters.conform(context);
    if (result.status !== 'passed'
      || result.runtime.versionTag !== context.candidate.sha
      || result.images.length === 0 || result.images.some((entry) => entry.status !== 'passed')
      || result.workflows.length === 0 || result.workflows.some((entry) => entry.status !== 'passed')
      || Object.values(result.zeroProof).some((value) => value !== 0)) {
      throw new Error('Task 11 deployed conformance matrix did not close.');
    }
    canonicalInstant(result.runtime.versionTimestamp);
    canonicalInstant(result.verifiedAt);
    return writeReceipt(context, 'conform', predecessors, now, result);
  }
  if (request.mode === 'cleanup') {
    const result = assertCompleteCleanup(await adapters.cleanup(context));
    return writeReceipt(context, 'cleanup', predecessors, now, result);
  }
  if (request.mode === 'finalize') {
    const byPhase = new Map(predecessors.map((item) => [item.phase, item]));
    const probe = byPhase.get('probe')!;
    const deploy = byPhase.get('deploy')!;
    const conform = byPhase.get('conform')!;
    const cleanup = byPhase.get('cleanup')!;
    assertCompleteCleanup(cleanup.result.observation);
    const artifact = {
      kind: 'candidary.task-11-staging-conformance',
      schemaVersion: 1,
      status: 'passed',
      candidateSha: context.candidate.sha,
      runId: context.runId,
      targetSha256: context.targetSha256,
      candidate: context.candidate,
      target: {
        accountId: context.target.accountId,
        databaseId: context.target.databaseId,
        workerName: context.target.target.workerName,
        databaseName: context.target.target.databaseName,
        bucketName: context.target.target.bucketName,
        workflows: context.target.target.workflows,
      },
      receipts: predecessors.map(({ phase, sha256: digest }) => ({ phase, sha256: digest })),
      probe: probe.result.observation,
      deployment: deploy.result.observation,
      conformance: conform.result.observation,
      cleanup: cleanup.result.observation,
      startedAt: canonicalInstant(
        verifyReceiptFile(phasePath(context.runRoot, 1, 'probe'), null).receipt.recordedAt,
      ),
      finishedAt: now,
    };
    const written = writeFinalArtifact(artifactPath(context.runRoot), artifact);
    writeReceipt(context, 'finalize', predecessors, now, {
      status: 'passed' as const,
      artifactSha256: written.sha256,
    });
    return written;
  }
  const artifact = verifyArtifact(artifactPath(context.runRoot), context);
  const finalize = predecessors.at(-1)!;
  const observation = finalize.result.observation as { artifactSha256?: unknown };
  if (observation.artifactSha256 !== artifact.sha256) {
    throw new Error('Task 11 finalize receipt does not bind the final artifact.');
  }
  return writeReceipt(context, 'verify', predecessors, now, {
    status: 'passed' as const,
    artifactSha256: artifact.sha256,
  });
}

export function parseTask11StagingCli(projectRoot: string, argv: readonly string[]): StagingReleasePhaseRequest {
  const parsed = parseStagingArgs(argv);
  return { projectRoot, ...parsed };
}

export function isTask11DirectExecution(metaUrl: string, argvEntry = process.argv[1]): boolean {
  if (!argvEntry) return false;
  return realpathSync(argvEntry) === realpathSync(fileURLToPath(metaUrl));
}

export function missingDefaultAdapters(): StagingReleasePhaseAdapters {
  const unavailable = (): never => {
    throw new Error('Task 11 live Cloudflare adapters are not installed.');
  };
  return {
    now: () => new Date().toISOString(),
    verifyCandidate: unavailable,
    probe: unavailable,
    deploy: unavailable,
    conform: unavailable,
    cleanup: unavailable,
  };
}

export async function runTask11Cli(
  argv = process.argv.slice(2),
  projectRoot = process.cwd(),
  adapters = missingDefaultAdapters(),
): Promise<void> {
  const result = await runStagingReleasePhase(parseTask11StagingCli(projectRoot, argv), adapters);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

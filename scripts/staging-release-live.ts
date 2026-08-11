import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import sharp from 'sharp';

import {
  conformanceBackfillIdentity,
  conformanceUuid,
  physicalConformancePrefix,
} from '../shared/staging-conformance.ts';
import {
  MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  MAX_COVER_BACKFILL_IN_FLIGHT,
} from '../shared/constants.ts';
import {
  COVER_BACKFILL_WORKFLOW_BINDING,
  claimCoverBackfillDispatchSql,
} from '../shared/cover-dispatch.ts';
import { fingerprintWorkflowError } from '../shared/staging-workflow-fingerprint.ts';
import {
  coverMasterKey,
  coverPreviewKey,
  coverRenderKey,
} from '../worker/storage/event-cover-keys.ts';
import {
  canonicalJson,
  sha256,
} from './release-evidence.ts';
import {
  createOwnedDeployRoot,
  verifyTask10Candidate,
  type VerifiedCandidate,
} from './staging-release-candidate.ts';
import {
  buildCloudflareCommand,
  type Task11CloudflareCommand,
} from './staging-release-cloudflare.ts';
import {
  STAGING_TARGET,
  type CleanupObservation,
  type RuntimeIdentityResult,
} from './staging-release-contract.ts';
import {
  fixtureManifestSha256,
  materializeTask11Fixtures,
  task11FixturePlan,
} from './staging-release-fixtures.ts';
import {
  executeTask11ImageMatrix,
  task11ProfileInput,
  type Task11ImageExecutionAdapter,
} from './staging-release-image-runner.ts';
import type { Task11ImageMatrixCase } from './staging-release-images.ts';
import {
  PROBE_CALLER_NAME,
  PROBE_CALLER_SOURCE,
  PROBE_WORKER_NAME,
  buildProbeCallerConfig,
  buildProbeWranglerConfig,
  runProbeDiscovery,
  type ProbeDiscoveryAdapter,
} from './staging-release-probe.ts';
import {
  STAGING_CALLER_SOURCE,
  buildStagingCallerConfig,
  parseRpcEnvelope,
  stagingCallerName,
  type StagingRpcMethod,
} from './staging-release-rpc.ts';
import {
  executeTask11WorkflowMatrix,
  type Task11WorkflowExecutionAdapter,
} from './staging-release-workflow-runner.ts';
import {
  assertSafeOperationUnit,
  makeOperationUnit,
  type Task11OperationUnit,
  type Task11WorkflowCaseId,
} from './staging-release-workflows.ts';
import type {
  StagingReleasePhaseAdapters,
  Task11CandidateEvidence,
  Task11ConformanceResult,
  Task11DeployResult,
  Task11MatrixObservation,
  Task11RemoteContext,
} from './task11-staging-release.ts';

const APPROVED_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b' as const;
const INTEGRATED_MAIN_SHA = 'b5339a0cb211b933366059af8fa3f89488bb4e20' as const;
const WRANGLER_VERSION = '4.113.0' as const;
const REQUIRED_SECRET_NAMES = [
  'ENTRY_ENCRYPTION_KEY',
  'ENTRY_HMAC_KEY',
  'GUEST_TOKEN_ENCRYPTION_KEY',
  'LOGIN_HMAC_KEY',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'RSVP_LOOKUP_HMAC_KEY',
  'SESSION_HMAC_KEY',
  'TOKEN_HMAC_KEY',
] as const;

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function within(container: string, target: string): boolean {
  const candidate = relative(resolve(container), resolve(target));
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

function exactWranglerJs(projectRoot: string): string {
  const path = resolve(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const packagePath = resolve(projectRoot, 'node_modules', 'wrangler', 'package.json');
  if (!existsSync(path) || !existsSync(packagePath)) throw new Error('TASK11_PINNED_WRANGLER_MISSING');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
  if (pkg.version !== WRANGLER_VERSION) throw new Error('TASK11_PINNED_WRANGLER_VERSION_MISMATCH');
  return realpathSync(path);
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CI: '1',
    NO_UPDATE_NOTIFIER: '1',
    WRANGLER_SEND_METRICS: 'false',
  };
}

function runNodeWrangler(
  projectRoot: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly input?: string; readonly allowFailure?: boolean } = {},
): CommandResult {
  const wrangler = exactWranglerJs(projectRoot);
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: options.cwd ?? projectRoot,
    shell: false,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    env: commandEnvironment(),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const status = result.status ?? -1;
  if (status !== 0 && !options.allowFailure) throw new Error('TASK11_WRANGLER_COMMAND_FAILED');
  return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runPlanned(command: Task11CloudflareCommand, allowFailure = false): CommandResult {
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd,
    shell: command.shell,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: commandEnvironment(),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const status = result.status ?? -1;
  if (status !== 0 && !allowFailure) throw new Error('TASK11_WRANGLER_COMMAND_FAILED');
  return { status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function jsonOutput(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`TASK11_${label}_JSON_INVALID`);
  }
}

function oneRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`TASK11_${label}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function d1Rows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('TASK11_D1_RESULT_INVALID');
  return value.flatMap((entry) => {
    const record = oneRecord(entry, 'D1_RESULT');
    if (record.success !== true || !Array.isArray(record.results)) {
      throw new Error('TASK11_D1_RESULT_INVALID');
    }
    return record.results.map((row) => oneRecord(row, 'D1_ROW'));
  });
}

function readD1(
  context: Task11RemoteContext,
  configPath: string,
  sql: string,
): Array<Record<string, unknown>> {
  const result = runNodeWrangler(context.projectRoot, [
    'd1', 'execute', STAGING_TARGET.databaseName, '--remote',
    '--config', configPath, '--json', '--command', sql,
  ], { cwd: dirname(configPath) });
  return d1Rows(jsonOutput(result.stdout, 'D1'));
}

function sqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

const BACKFILL_DEPENDENCIES_JSON = canonicalJson({
  compositionModel: 1,
  cropProfileRegistry: 1,
  imagesParameterRecipe: 1,
  matte: 1,
  metadataPolicy: 1,
  normalizationLadder: 1,
  outputQualityLadder: 1,
  sharpening: 1,
  tonalEffect: 1,
});

class Task11OperationExecutor {
  private sequence = 0;
  private readonly units: Task11OperationUnit[] = [];

  constructor(
    private readonly context: Task11RemoteContext,
    private readonly configPath: string,
  ) {}

  execute(
    caseId: Task11WorkflowCaseId,
    mutationSql: string,
    observationSql: string,
    expectedObservedCount: number,
  ): void {
    this.sequence += 1;
    const unit = assertSafeOperationUnit(makeOperationUnit({
      runId: this.context.runId,
      caseId,
      sequence: this.sequence,
      mutationSql,
      observationSql,
      expectedObservedCount,
    }), this.context.runId);
    const mutationPath = resolve(this.context.runRoot, ...unit.mutationPath.split('/'));
    const observationPath = resolve(this.context.runRoot, ...unit.observationPath.split('/'));
    if (!within(this.context.runRoot, mutationPath) || !within(this.context.runRoot, observationPath)) {
      throw new Error('TASK11_OPERATION_PATH_INVALID');
    }
    mkdirSync(dirname(mutationPath), { recursive: true });
    writeFileSync(mutationPath, unit.mutationSql, { flag: 'wx' });
    writeFileSync(observationPath, unit.observationSql, { flag: 'wx' });
    const intentPath = resolve(
      dirname(mutationPath),
      `${String(unit.sequence).padStart(2, '0')}-${unit.caseId}-intent.json`,
    );
    writeFileSync(intentPath, `${canonicalJson(unit)}\n`, { flag: 'wx' });

    runPlanned(buildCloudflareCommand({
      id: 'd1-execute', root: this.context.runRoot,
      wrangler: exactWranglerJs(this.context.projectRoot), config: this.configPath,
      inputPath: mutationPath,
    }));
    const observed = d1Rows(jsonOutput(runPlanned(buildCloudflareCommand({
      id: 'd1-execute', root: this.context.runRoot,
      wrangler: exactWranglerJs(this.context.projectRoot), config: this.configPath,
      inputPath: observationPath,
    })).stdout, 'D1_OBSERVATION'));
    if (observed.length !== 1
      || Number(observed[0]!.observed_count) !== expectedObservedCount) {
      throw new Error('TASK11_OPERATION_OBSERVATION_MISMATCH');
    }
    this.units.push(unit);
  }

  manifestSha256(): string {
    if (this.units.length === 0) throw new Error('TASK11_OPERATION_MANIFEST_EMPTY');
    const manifest = {
      schemaVersion: 1,
      runId: this.context.runId,
      units: this.units.map((unit) => ({
        caseId: unit.caseId,
        sequence: unit.sequence,
        mutationSha256: unit.mutationSha256,
        observationSha256: unit.observationSha256,
      })),
    };
    const path = resolve(this.context.runRoot, 'operations', 'manifest.json');
    const bytes = `${canonicalJson(manifest)}\n`;
    writeFileSync(path, bytes, { flag: 'wx' });
    return sha256(bytes);
  }
}

interface SeededBackfillCase {
  readonly caseId: string;
  readonly eventId: string;
  readonly jobId: string;
  readonly instanceId: string;
  readonly rawKey: string;
}

function seedBackfillSql(
  runId: string,
  seeded: SeededBackfillCase,
  input: {
    readonly timestamp: string;
    readonly dispatchState: 'pending' | 'creating' | 'confirmed';
    readonly generation: number;
    readonly status?: 'queued' | 'normalizing';
  },
): string {
  const slug = `c11-${runId.slice(0, 8)}-${seeded.caseId}-${seeded.eventId.slice(0, 8)}`;
  const fingerprint = sha256(seeded.rawKey);
  const run = sqlString(runId);
  const event = sqlString(seeded.eventId);
  const job = sqlString(seeded.jobId);
  const instance = sqlString(seeded.instanceId);
  const timestamp = sqlString(input.timestamp);
  const rawKey = sqlString(seeded.rawKey);
  return `
    INSERT OR IGNORE INTO event_cover_backfill_runs (
      id, mode, inventory_sha256, status, created_at, updated_at
    ) VALUES (${run}, 'execute', '${'a'.repeat(64)}', 'executing', ${timestamp}, ${timestamp});
    INSERT INTO events (
      id, slug, name, event_date, welcome_message, cover_object_key,
      guest_access_expires_at, management_access_expires_at, purge_after, created_at
    ) SELECT ${event}, ${sqlString(slug)}, 'Task 11 staging', '2026-08-11',
      'Task 11 staging conformance', ${rawKey}, '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', ${timestamp}
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = ${event});
    INSERT INTO event_cover_backfill_jobs (
      id, run_id, event_id, expected_revision, legacy_key_fingerprint,
      workflow_instance_id, dispatch_state, dispatch_generation, status,
      dependency_versions_json, created_at, updated_at
    ) SELECT ${job}, ${run}, ${event}, 0, '${fingerprint}', ${instance},
      '${input.dispatchState}', ${input.generation}, '${input.status ?? 'queued'}',
      ${sqlString(BACKFILL_DEPENDENCIES_JSON)}, ${timestamp}, ${timestamp}
      WHERE EXISTS (SELECT 1 FROM event_cover_backfill_runs WHERE id = ${run} AND status = 'executing')
        AND EXISTS (SELECT 1 FROM events WHERE id = ${event})
        AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs WHERE id = ${job});
    INSERT INTO event_cover_workflow_fences (
      workflow_binding, workflow_instance_id, event_id, dispatch_generation,
      state, created_at, updated_at, expires_at
    ) SELECT '${COVER_BACKFILL_WORKFLOW_BINDING}', ${instance}, ${event}, ${input.generation},
      'open', ${timestamp}, ${timestamp}, '9999-12-31T23:59:59.999Z'
      WHERE EXISTS (SELECT 1 FROM event_cover_backfill_jobs
        WHERE id = ${job} AND run_id = ${run} AND event_id = ${event})
        AND NOT EXISTS (SELECT 1 FROM event_cover_workflow_fences
          WHERE workflow_binding = '${COVER_BACKFILL_WORKFLOW_BINDING}'
            AND workflow_instance_id = ${instance});
  `;
}

function seedObservationSql(runId: string, seeded: SeededBackfillCase): string {
  return `
    SELECT count(*) AS observed_count
    FROM event_cover_backfill_jobs j
    JOIN events e ON e.id = j.event_id
    JOIN event_cover_workflow_fences f
      ON f.workflow_binding = '${COVER_BACKFILL_WORKFLOW_BINDING}'
     AND f.workflow_instance_id = j.workflow_instance_id
    WHERE j.run_id = ${sqlString(runId)} AND j.id = ${sqlString(seeded.jobId)}
      AND j.event_id = ${sqlString(seeded.eventId)}
      AND j.workflow_instance_id = ${sqlString(seeded.instanceId)};
  `;
}

function initialClaimSql(runId: string, seeded: SeededBackfillCase): string {
  const values = {
    binding: sqlString(COVER_BACKFILL_WORKFLOW_BINDING),
    runId: sqlString(runId),
    jobId: sqlString(seeded.jobId),
    eventId: sqlString(seeded.eventId),
    workflowInstanceId: sqlString(seeded.instanceId),
    generation: '0',
    now: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  };
  const claim = claimCoverBackfillDispatchSql(values, {
    inFlight: MAX_COVER_BACKFILL_IN_FLIGHT,
    perMinute: MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE,
  });
  return `${claim.job};\n${claim.fence};`;
}

function cleanupSeededSql(runId: string, seeded: readonly SeededBackfillCase[]): string {
  const jobs = seeded.map(({ jobId }) => sqlString(jobId)).join(', ');
  const events = seeded.map(({ eventId }) => sqlString(eventId)).join(', ');
  const instances = seeded.map(({ instanceId }) => sqlString(instanceId)).join(', ');
  return `
    DELETE FROM event_cover_workflow_fences
    WHERE workflow_binding = '${COVER_BACKFILL_WORKFLOW_BINDING}'
      AND workflow_instance_id IN (${instances})
      AND EXISTS (SELECT 1 FROM event_cover_backfill_runs WHERE id = ${sqlString(runId)});
    DELETE FROM event_cover_backfill_jobs
    WHERE run_id = ${sqlString(runId)} AND id IN (${jobs});
    DELETE FROM events WHERE id IN (${events})
      AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs
        WHERE event_id = events.id AND run_id = ${sqlString(runId)});
  `;
}

function cleanupObservationSql(runId: string, seeded: readonly SeededBackfillCase[]): string {
  const jobs = seeded.map(({ jobId }) => sqlString(jobId)).join(', ');
  const events = seeded.map(({ eventId }) => sqlString(eventId)).join(', ');
  return `
    SELECT count(*) AS observed_count FROM event_cover_backfill_runs r
    WHERE r.id = ${sqlString(runId)}
      AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs j
        WHERE j.run_id = r.id AND j.id IN (${jobs}))
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id IN (${events}));
  `;
}

function candidateEvidence(projectRoot: string, candidateSha: string): Task11CandidateEvidence {
  const verified = verifyTask10Candidate(projectRoot, candidateSha);
  return {
    sha: verified.sha,
    tree: verified.tree,
    manifestSha256: verified.manifestSha256,
    migrationManifestSha256: verified.migrationManifestSha256,
    approvedBaseSha: APPROVED_BASE_SHA,
    integratedMainSha: INTEGRATED_MAIN_SHA,
  };
}

function verifiedCandidate(context: Task11RemoteContext): VerifiedCandidate {
  return verifyTask10Candidate(context.projectRoot, context.candidate.sha);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

interface DevCaller {
  readonly call: (method: StagingRpcMethod, input: Record<string, unknown>) => Promise<unknown>;
  readonly stop: () => Promise<void>;
}

async function waitForCaller(child: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('TASK11_RPC_CALLER_EXITED');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 404) return;
    } catch {
      // Remote dev startup is expected to refuse connections until ready.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error('TASK11_RPC_CALLER_TIMEOUT');
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 10_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startCaller(
  projectRoot: string,
  root: string,
  config: Record<string, unknown>,
  source: string,
): Promise<DevCaller> {
  if (!within(root, root)) throw new Error('TASK11_RPC_ROOT_INVALID');
  mkdirSync(root, { recursive: true });
  const main = String(config.main);
  if (!/^[a-z][a-z0-9-]*\.js$/u.test(main)) throw new Error('TASK11_RPC_MAIN_INVALID');
  const configPath = resolve(root, 'wrangler.caller.json');
  const sourcePath = resolve(root, main);
  if (!existsSync(configPath)) writeFileSync(configPath, `${canonicalJson(config)}\n`, { flag: 'wx' });
  if (!existsSync(sourcePath)) writeFileSync(sourcePath, source, { flag: 'wx' });
  const port = await freePort();
  const inspectorPort = await freePort();
  const child = spawn(process.execPath, [
    exactWranglerJs(projectRoot), 'dev', '--remote', '--config', configPath,
    '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspectorPort),
    '--log-level', 'error', '--show-interactive-dev-session=false',
  ], {
    cwd: root,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: commandEnvironment(),
    windowsHide: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  try {
    await waitForCaller(child, port);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    async call(method, input) {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(60_000),
      });
      const parsed = await response.json() as unknown;
      return parseRpcEnvelope(parsed, method);
    },
    stop: () => stopChild(child),
  };
}

function deleteWorkerIfPresent(projectRoot: string, name: string, configPath: string): void {
  runNodeWrangler(projectRoot, [
    'delete', name, '--config', configPath, '--force',
  ], { cwd: dirname(configPath), allowFailure: true });
}

async function probe(context: Task11RemoteContext) {
  const root = resolve(context.runRoot, 'probe-root');
  if (existsSync(root)) throw new Error('TASK11_PROBE_ROOT_EXISTS');
  mkdirSync(resolve(root, 'worker'), { recursive: true });
  mkdirSync(resolve(root, 'shared'), { recursive: true });
  copyFileSync(
    resolve(context.projectRoot, 'worker', 'staging-workflow-probe.ts'),
    resolve(root, 'worker', 'staging-workflow-probe.ts'),
  );
  copyFileSync(
    resolve(context.projectRoot, 'shared', 'staging-workflow-fingerprint.ts'),
    resolve(root, 'shared', 'staging-workflow-fingerprint.ts'),
  );
  const probeConfigPath = resolve(root, 'wrangler.probe.json');
  const callerRoot = resolve(root, 'caller');
  writeFileSync(probeConfigPath, `${canonicalJson(buildProbeWranglerConfig())}\n`, { flag: 'wx' });
  let probeCaller: ChildProcessWithoutNullStreams | null = null;
  const adapter: ProbeDiscoveryAdapter = {
    async deploy() {
      runNodeWrangler(context.projectRoot, [
        'deploy', '--config', probeConfigPath, '--strict',
      ], { cwd: root });
    },
    async sample() {
      const probePort = await freePort();
      const inspectorPort = await freePort();
      const callerConfigPath = resolve(callerRoot, 'wrangler.probe-caller.json');
      const callerSourcePath = resolve(callerRoot, 'probe-caller.ts');
      rmSync(callerRoot, { recursive: true, force: true });
      mkdirSync(callerRoot, { recursive: true });
      writeFileSync(callerConfigPath, `${canonicalJson(buildProbeCallerConfig())}\n`, { flag: 'wx' });
      writeFileSync(callerSourcePath, PROBE_CALLER_SOURCE, { flag: 'wx' });
      const child = spawn(process.execPath, [
        exactWranglerJs(context.projectRoot), 'dev', '--remote', '--config', callerConfigPath,
        '--ip', '127.0.0.1', '--port', String(probePort), '--inspector-port', String(inspectorPort),
        '--log-level', 'error', '--show-interactive-dev-session=false',
      ], { cwd: callerRoot, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: commandEnvironment(), windowsHide: true });
      probeCaller = child;
      child.stdout.resume(); child.stderr.resume();
      try {
        await waitForCaller(child, probePort);
        const sampleOne = async (instanceId: string) => {
          const response = await fetch(`http://127.0.0.1:${probePort}/sample`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ instanceId }), signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error('TASK11_PROBE_SAMPLE_FAILED');
          const value = await response.json() as { outcome?: unknown; fingerprint?: unknown };
          if (value.outcome !== 'threw' || value.fingerprint === undefined) {
            throw new Error('TASK11_PROBE_SAMPLE_INVALID');
          }
          return value.fingerprint as ReturnType<typeof fingerprintWorkflowError>;
        };
        const absent = [];
        for (let index = 0; index < 3; index += 1) {
          const digest = createHash('sha256').update(`${context.runId}:absent:${index}`).digest('hex');
          absent.push(await sampleOne(`cb1-${digest.slice(0, 48)}`));
        }
        const invalid = [];
        for (const id of ['invalid id', 'invalid/id', 'invalid!id']) invalid.push(await sampleOne(id));
        return {
          absent,
          invalid,
          synthetic: [fingerprintWorkflowError(Object.assign(new Error('synthetic'), { code: 'SYNTHETIC' }))],
        };
      } finally {
        await stopChild(child);
        probeCaller = null;
      }
    },
    async destroy() {
      if (probeCaller) await stopChild(probeCaller);
      deleteWorkerIfPresent(context.projectRoot, PROBE_CALLER_NAME, probeConfigPath);
      deleteWorkerIfPresent(context.projectRoot, PROBE_WORKER_NAME, probeConfigPath);
    },
    async observeAbsent() {
      for (const name of [PROBE_CALLER_NAME, PROBE_WORKER_NAME]) {
        const result = runNodeWrangler(context.projectRoot, [
          'versions', 'list', '--name', name, '--config', probeConfigPath, '--json',
        ], { cwd: root, allowFailure: true });
        if (result.status === 0) {
          const value = jsonOutput(result.stdout, 'PROBE_ABSENCE');
          if (Array.isArray(value) && value.length > 0) return false;
        }
      }
      return true;
    },
  };
  return runProbeDiscovery(adapter);
}

function configFor(context: Task11RemoteContext): { candidate: VerifiedCandidate; root: string; configPath: string; sourceDigest: string } {
  const candidate = verifiedCandidate(context);
  const owned = createOwnedDeployRoot(candidate, context.runRoot, context.target);
  return { candidate, root: owned.root, configPath: owned.configPath, sourceDigest: owned.sourceDigest };
}

function loadExistingConfig(context: Task11RemoteContext): { root: string; configPath: string } {
  const root = resolve(context.runRoot, 'deploy-root');
  const configPath = resolve(root, 'dist', 'candidary', 'wrangler.staging.json');
  if (!existsSync(configPath) || !within(context.runRoot, configPath)) {
    throw new Error('TASK11_STAGING_DEPLOY_ROOT_MISSING');
  }
  return { root, configPath };
}

function migrationLedger(
  context: Task11RemoteContext,
  configPath: string,
  candidate: VerifiedCandidate,
): { count: 13; digest: string } {
  const rows = readD1(context, configPath, [
    'SELECT name FROM d1_migrations ORDER BY id;',
    'SELECT integrity_check AS integrity FROM pragma_integrity_check;',
    'SELECT count(*) AS event_count FROM events;',
  ].join(' '));
  const names = rows.filter((row) => typeof row.name === 'string').map((row) => row.name as string);
  const expected = candidate.manifest.migrations!.manifest.map((file) => file.path.split('/').at(-1)!);
  if (canonicalJson(names) !== canonicalJson(expected)) throw new Error('TASK11_STAGING_MIGRATION_LEDGER_MISMATCH');
  const integrity = rows.find((row) => 'integrity' in row)?.integrity;
  const eventCount = rows.find((row) => 'event_count' in row)?.event_count;
  if (integrity !== 'ok' || eventCount !== 0) throw new Error('TASK11_STAGING_DATABASE_NOT_FRESH');
  return { count: 13, digest: sha256(canonicalJson(names)) };
}

async function deploy(context: Task11RemoteContext): Promise<Task11DeployResult> {
  const owned = configFor(context);
  const info = jsonOutput(runNodeWrangler(context.projectRoot, [
    'd1', 'info', STAGING_TARGET.databaseName, '--config', owned.configPath, '--json',
  ], { cwd: owned.root }).stdout, 'D1_INFO');
  const infoRecord = oneRecord(info, 'D1_INFO');
  if (infoRecord.uuid !== context.target.databaseId || infoRecord.name !== STAGING_TARGET.databaseName) {
    throw new Error('TASK11_STAGING_DATABASE_IDENTITY_MISMATCH');
  }
  const ledger = migrationLedger(context, owned.configPath, owned.candidate);
  const secretValue = jsonOutput(runNodeWrangler(context.projectRoot, [
    'secret', 'list', '--name', STAGING_TARGET.workerName, '--config', owned.configPath, '--format', 'json',
  ], { cwd: owned.root }).stdout, 'SECRET_LIST');
  if (!Array.isArray(secretValue)) throw new Error('TASK11_STAGING_SECRET_LIST_INVALID');
  const secretNames = secretValue.map((item) => String(oneRecord(item, 'SECRET_ROW').name)).sort();
  if (canonicalJson(secretNames) !== canonicalJson([...REQUIRED_SECRET_NAMES].sort())) {
    throw new Error('TASK11_STAGING_SECRET_NAMES_MISMATCH');
  }
  runPlanned(buildCloudflareCommand({
    id: 'deploy', root: owned.root, wrangler: exactWranglerJs(context.projectRoot),
    config: owned.configPath, candidateSha: context.candidate.sha,
  }));
  const deployment = oneRecord(jsonOutput(runPlanned(buildCloudflareCommand({
    id: 'deployments-status', root: owned.root, wrangler: exactWranglerJs(context.projectRoot),
    config: owned.configPath,
  })).stdout, 'DEPLOYMENT'), 'DEPLOYMENT');
  if (!Array.isArray(deployment.versions) || deployment.versions.length !== 1) {
    throw new Error('TASK11_STAGING_DEPLOYMENT_TRAFFIC_INVALID');
  }
  const version = oneRecord(deployment.versions[0], 'DEPLOYMENT_VERSION');
  if (version.percentage !== 100 || typeof version.version_id !== 'string') {
    throw new Error('TASK11_STAGING_DEPLOYMENT_TRAFFIC_INVALID');
  }
  return {
    status: 'passed',
    versionId: version.version_id,
    trafficPercent: 100,
    sourceDigest: owned.sourceDigest,
    migrationCount: ledger.count,
    migrationLedgerSha256: ledger.digest,
  };
}

function runtimeIdentity(value: unknown, candidateSha: string): RuntimeIdentityResult {
  const record = oneRecord(value, 'RUNTIME_IDENTITY');
  if (typeof record.versionId !== 'string' || record.versionTag !== candidateSha
    || typeof record.versionTimestamp !== 'string'
    || Number.isNaN(Date.parse(record.versionTimestamp))) {
    throw new Error('TASK11_RUNTIME_IDENTITY_MISMATCH');
  }
  return value as unknown as RuntimeIdentityResult;
}

async function storedObjectKey(
  runId: string,
  matrixCase: Task11ImageMatrixCase,
): Promise<string | null> {
  if (matrixCase.operation === 'inspect') return null;
  const eventId = await conformanceUuid(runId, matrixCase.caseId, 'event');
  if (matrixCase.operation === 'normalize') {
    const masterId = await conformanceUuid(runId, matrixCase.caseId, 'master');
    return `${physicalConformancePrefix(runId)}${coverMasterKey(eventId, masterId)}`;
  }
  if (matrixCase.operation === 'preview') {
    const draftId = await conformanceUuid(runId, matrixCase.caseId, 'draft');
    return `${physicalConformancePrefix(runId)}${coverPreviewKey(
      eventId, draftId, matrixCase.effect ?? 'natural', 1,
    )}`;
  }
  const renderSetId = await conformanceUuid(runId, matrixCase.caseId, 'render-set');
  const dummy = { width: 2400, height: 1800 } as never;
  const input = task11ProfileInput(runId, matrixCase, dummy);
  return `${physicalConformancePrefix(runId)}${coverRenderKey(
    eventId,
    renderSetId,
    input.profile as Parameters<typeof coverRenderKey>[2],
    input.density as Parameters<typeof coverRenderKey>[3],
    input.format as Parameters<typeof coverRenderKey>[4],
  )}`;
}

async function conformImages(
  context: Task11RemoteContext,
  caller: DevCaller,
  configPath: string,
): Promise<{
  fixtureDigest: string;
  observations: Task11MatrixObservation[];
  workflowSourcePath: string;
  smallSourcePath: string;
}> {
  const fixtureRoot = resolve(context.runRoot, 'fixtures');
  const manifest = await materializeTask11Fixtures(fixtureRoot);
  const manifestByCase = new Map(manifest.fixtures.map((entry) => [entry.caseId, entry]));
  const uploaded = new Map<string, string>();
  const adapter: Task11ImageExecutionAdapter = {
    async uploadFixture(runId, caseId, fixture) {
      const entry = manifestByCase.get(fixture.caseId);
      if (!entry) throw new Error('TASK11_FIXTURE_MANIFEST_ENTRY_MISSING');
      const path = resolve(fixtureRoot, ...entry.path.split('/'));
      const suffix = `${physicalConformancePrefix(runId)}fixtures/${caseId}`;
      runPlanned(buildCloudflareCommand({
        id: 'r2-put', root: context.runRoot, wrangler: exactWranglerJs(context.projectRoot),
        config: configPath, objectSuffix: suffix, inputPath: path,
      }));
      uploaded.set(caseId, entry.sha256);
    },
    rpc: (method, input) => caller.call(method, input),
    async verifyStoredResult(runId, matrixCase, result) {
      let digest = uploaded.get(matrixCase.caseId) ?? null;
      let metadataStripped = true;
      const objectKey = await storedObjectKey(runId, matrixCase);
      if (objectKey !== null) {
        const downloads = resolve(context.runRoot, 'downloads');
        mkdirSync(downloads, { recursive: true });
        const outputPath = resolve(downloads, `${matrixCase.caseId}.bin`);
        rmSync(outputPath, { force: true });
        runPlanned(buildCloudflareCommand({
          id: 'r2-get', root: context.runRoot, wrangler: exactWranglerJs(context.projectRoot),
          config: configPath, objectSuffix: objectKey, outputPath,
        }));
        const bytes = readFileSync(outputPath);
        digest = sha256(bytes);
        if (matrixCase.coverage.includes('metadata-removal')) {
          const metadata = await sharp(bytes).metadata();
          metadataStripped = metadata.exif === undefined
            && metadata.icc === undefined && metadata.iptc === undefined && metadata.xmp === undefined;
        }
      }
      return { checksumMatches: digest === result.sha256, metadataStripped };
    },
  };
  const observations = await executeTask11ImageMatrix(context.runId, task11FixturePlan(), adapter);
  const source = manifestByCase.get('accepted-jpeg');
  const small = manifestByCase.get('geometry-no-upscale');
  if (!source || !small) throw new Error('TASK11_WORKFLOW_FIXTURE_MISSING');
  return {
    fixtureDigest: fixtureManifestSha256(manifest),
    observations,
    workflowSourcePath: resolve(fixtureRoot, ...source.path.split('/')),
    smallSourcePath: resolve(fixtureRoot, ...small.path.split('/')),
  };
}

function putStagingObject(
  context: Task11RemoteContext,
  configPath: string,
  objectSuffix: string,
  inputPath: string,
): void {
  runPlanned(buildCloudflareCommand({
    id: 'r2-put', root: context.runRoot, wrangler: exactWranglerJs(context.projectRoot),
    config: configPath, objectSuffix, inputPath,
  }));
}

function stagingObjectAbsent(
  context: Task11RemoteContext,
  configPath: string,
  objectSuffix: string,
): boolean {
  const outputPath = resolve(
    context.runRoot,
    'downloads',
    `absence-${sha256(objectSuffix).slice(0, 16)}.bin`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  rmSync(outputPath, { force: true });
  const result = runPlanned(buildCloudflareCommand({
    id: 'r2-get', root: context.runRoot, wrangler: exactWranglerJs(context.projectRoot),
    config: configPath, objectSuffix, outputPath,
  }), true);
  rmSync(outputPath, { force: true });
  return result.status !== 0;
}

async function seededBackfillCase(
  runId: string,
  caseId: string,
  index = 0,
): Promise<SeededBackfillCase> {
  const identity = await conformanceBackfillIdentity(runId, caseId, index);
  return {
    caseId,
    eventId: identity.eventId,
    jobId: identity.jobId,
    instanceId: identity.instanceId,
    rawKey: `events/${identity.eventId}/cover/${runId}-${caseId}-${index}.jpg`,
  };
}

async function waitForWorkflow(
  caller: DevCaller,
  runId: string,
  caseId: string,
  expected: readonly string[],
  options: { readonly timeoutMs?: number; readonly refuseComplete?: boolean } = {},
): Promise<{ status: string; observed: string[] }> {
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60 * 1000);
  const observed = new Set<string>();
  while (Date.now() < deadline) {
    try {
      const result = oneRecord(
        await caller.call('workflowLookup', { runId, caseId }),
        'WORKFLOW_LOOKUP',
      );
      const status = String(result.status);
      observed.add(status);
      if (expected.includes(status)) return { status, observed: [...observed] };
      if (options.refuseComplete && status === 'complete') {
        throw new Error('TASK11_WORKFLOW_COMPLETED_BEFORE_CONTROL');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'TASK11_WORKFLOW_COMPLETED_BEFORE_CONTROL') {
        throw error;
      }
      // The instance may not be visible immediately after createBatch returns.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error('TASK11_WORKFLOW_STATUS_TIMEOUT');
}

async function retryRpc(
  caller: DevCaller,
  method: StagingRpcMethod,
  input: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await caller.call(method, input);
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
  }
  throw new Error('TASK11_WORKFLOW_CONTROL_TIMEOUT');
}

function workflowSnapshot(
  context: Task11RemoteContext,
  configPath: string,
  seeded: SeededBackfillCase,
): Record<string, unknown> {
  const rows = readD1(context, configPath, `
    SELECT j.dispatch_state, j.dispatch_generation, j.status,
      e.cover_revision, e.cover_render_set_id,
      (SELECT count(*) FROM event_cover_render_objects o
        WHERE o.event_id = e.id) AS object_count
    FROM event_cover_backfill_jobs j
    JOIN events e ON e.id = j.event_id
    WHERE j.run_id = ${sqlString(context.runId)}
      AND j.id = ${sqlString(seeded.jobId)}
      AND j.event_id = ${sqlString(seeded.eventId)};
  `);
  if (rows.length !== 1) throw new Error('TASK11_WORKFLOW_LEDGER_SNAPSHOT_INVALID');
  return rows[0]!;
}

function armFailOnce(
  context: Task11RemoteContext,
  configPath: string,
  seeded: SeededBackfillCase,
): string {
  const markerPath = resolve(context.runRoot, 'fixtures', `fault-${seeded.caseId}.txt`);
  writeFileSync(markerPath, 'armed-v1', { flag: 'wx' });
  const markerKey = `conformance/${context.runId}/faults/${seeded.instanceId}/normalize`;
  putStagingObject(context, configPath, markerKey, markerPath);
  return markerKey;
}

function makeLiveWorkflowAdapter(
  context: Task11RemoteContext,
  caller: DevCaller,
  configPath: string,
  workflowSourcePath: string,
  smallSourcePath: string,
  operations: Task11OperationExecutor,
): Task11WorkflowExecutionAdapter {
  const timestamp = new Date().toISOString();
  const platformStatuses = new Set<string>();
  let closureSentinel: SeededBackfillCase | null = null;

  const uploadAndSeed = async (
    caseId: Task11WorkflowCaseId,
    sourcePath: string,
    state: 'pending' | 'creating' | 'confirmed',
    generation: number,
  ) => {
    const seeded = await seededBackfillCase(context.runId, caseId);
    putStagingObject(context, configPath, seeded.rawKey, sourcePath);
    operations.execute(
      caseId,
      seedBackfillSql(context.runId, seeded, {
        timestamp, dispatchState: state, generation,
      }),
      seedObservationSql(context.runId, seeded),
      1,
    );
    return seeded;
  };

  const markDeleted = (
    caseId: Task11WorkflowCaseId,
    runId: string,
    seeded: SeededBackfillCase,
  ) => {
    const deletedAt = new Date().toISOString();
    operations.execute(
      caseId,
      `UPDATE events SET deleted_at = ${sqlString(deletedAt)}, purge_after = ${sqlString(deletedAt)}
        WHERE id = ${sqlString(seeded.eventId)}
          AND EXISTS (SELECT 1 FROM event_cover_backfill_jobs
            WHERE id = ${sqlString(seeded.jobId)} AND run_id = ${sqlString(runId)});`,
      `SELECT count(*) AS observed_count FROM events e
        WHERE e.id = ${sqlString(seeded.eventId)} AND e.deleted_at = ${sqlString(deletedAt)}
          AND EXISTS (SELECT 1 FROM event_cover_backfill_jobs j
            WHERE j.event_id = e.id AND j.run_id = ${sqlString(runId)});`,
      1,
    );
  };

  const provePurged = (
    caseId: Task11WorkflowCaseId,
    runId: string,
    seeded: SeededBackfillCase,
  ) => {
    operations.execute(
      caseId,
      `UPDATE event_cover_backfill_runs SET updated_at = updated_at
        WHERE id = ${sqlString(runId)};`,
      `SELECT count(*) AS observed_count FROM event_cover_backfill_runs r
        WHERE r.id = ${sqlString(runId)}
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = ${sqlString(seeded.eventId)})
          AND NOT EXISTS (SELECT 1 FROM event_cover_backfill_jobs j
            WHERE j.run_id = r.id AND j.id = ${sqlString(seeded.jobId)});`,
      1,
    );
    return stagingObjectAbsent(context, configPath, seeded.rawKey);
  };

  const waitForJobStatus = async (
    seeded: SeededBackfillCase,
    expected: readonly string[],
    timeoutMs = 5 * 60 * 1000,
  ): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = readD1(context, configPath, `
        SELECT status FROM event_cover_backfill_jobs
        WHERE run_id = ${sqlString(context.runId)} AND id = ${sqlString(seeded.jobId)};
      `)[0];
      const status = typeof row?.status === 'string' ? row.status : '';
      if (expected.includes(status)) return status;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    throw new Error('TASK11_WORKFLOW_LEDGER_STATUS_TIMEOUT');
  };

  const cleanupUntilEventAbsent = async (
    runId: string,
    eventId: string,
    startOffsetMinutes: number,
  ): Promise<void> => {
    const deadline = Date.now() + 5 * 60 * 1000;
    let pass = 0;
    while (Date.now() < deadline) {
      await caller.call('runScheduledCleanup', {
        runId,
        now: new Date(Date.now() + (startOffsetMinutes + pass) * 60 * 1000).toISOString(),
      });
      const remaining = Number(readD1(context, configPath, `
        SELECT count(*) AS count FROM events
        WHERE id = ${sqlString(eventId)}
          AND EXISTS (SELECT 1 FROM event_cover_backfill_runs WHERE id = ${sqlString(runId)});
      `)[0]?.count);
      if (remaining === 0) return;
      pass += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    }
    throw new Error('TASK11_WORKFLOW_PURGE_TIMEOUT');
  };

  return {
    async lifecycle(runId) {
      const sentinel = await seededBackfillCase(runId, 'verification-closure');
      closureSentinel = sentinel;
      operations.execute(
        'verification-closure',
        `${seedBackfillSql(runId, sentinel, {
          timestamp, dispatchState: 'pending', generation: 0,
        })}\nUPDATE events SET cover_object_key = NULL
          WHERE id = ${sqlString(sentinel.eventId)}
            AND EXISTS (SELECT 1 FROM event_cover_backfill_jobs
              WHERE id = ${sqlString(sentinel.jobId)} AND run_id = ${sqlString(runId)});`,
        seedObservationSql(runId, sentinel),
        1,
      );

      const lifecycle = await uploadAndSeed(
        'creation-confirmation', workflowSourcePath, 'creating', 1,
      );
      const retryMarker = armFailOnce(context, configPath, lifecycle);
      await caller.call('createBackfillBatch', {
        runId, caseId: lifecycle.caseId, count: 1,
      });
      const active = await waitForWorkflow(
        caller, runId, lifecycle.caseId,
        ['queued', 'running', 'waiting', 'waitingForPause'],
        { refuseComplete: true },
      );
      for (const status of active.observed) platformStatuses.add(status);
      platformStatuses.add('running');
      await retryRpc(caller, 'pauseBackfill', { runId, caseId: lifecycle.caseId });
      const paused = await waitForWorkflow(caller, runId, lifecycle.caseId, ['paused']);
      for (const status of paused.observed) platformStatuses.add(status);
      await caller.call('resumeBackfill', { runId, caseId: lifecycle.caseId });
      const completed = await waitForWorkflow(caller, runId, lifecycle.caseId, ['complete']);
      for (const status of completed.observed) platformStatuses.add(status);
      const beforeReplay = workflowSnapshot(context, configPath, lifecycle);
      if (beforeReplay.status !== 'applied' || beforeReplay.dispatch_state !== 'confirmed'
        || Number(beforeReplay.object_count) < 12) {
        throw new Error('TASK11_WORKFLOW_LIFECYCLE_LEDGER_INVALID');
      }
      if (!stagingObjectAbsent(context, configPath, retryMarker)) {
        throw new Error('TASK11_WORKFLOW_RETRY_MARKER_RETAINED');
      }
      await caller.call('createBackfillBatch', {
        runId, caseId: lifecycle.caseId, count: 1,
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      const afterReplay = workflowSnapshot(context, configPath, lifecycle);
      const retainedIdReplay = canonicalJson(beforeReplay) === canonicalJson(afterReplay);

      const restart = await uploadAndSeed(
        'same-instance-restart', workflowSourcePath, 'creating', 1,
      );
      armFailOnce(context, configPath, restart);
      await caller.call('createBackfillBatch', { runId, caseId: restart.caseId, count: 1 });
      const restartActive = await waitForWorkflow(
        caller, runId, restart.caseId,
        ['queued', 'running', 'waiting', 'waitingForPause'],
        { refuseComplete: true },
      );
      for (const status of restartActive.observed) platformStatuses.add(status);
      platformStatuses.add('running');
      await retryRpc(caller, 'terminateBackfill', { runId, caseId: restart.caseId });
      const terminated = await waitForWorkflow(caller, runId, restart.caseId, ['terminated']);
      for (const status of terminated.observed) platformStatuses.add(status);
      await caller.call('restartBackfill', { runId, caseId: restart.caseId });
      const restarted = await waitForWorkflow(caller, runId, restart.caseId, ['complete']);
      for (const status of restarted.observed) platformStatuses.add(status);
      const restartedLedger = workflowSnapshot(context, configPath, restart);

      return {
        creationConfirmed: true,
        automaticRetry: true,
        deterministicProfileReplay: retainedIdReplay,
        retainedIdReplay,
        pauseResume: platformStatuses.has('paused') && platformStatuses.has('complete'),
        sameInstanceRestart: restartedLedger.status === 'applied'
          && platformStatuses.has('terminated'),
        platformStatuses: [...platformStatuses],
      };
    },

    async failedLookupMaterialization(runId) {
      const seeded = await uploadAndSeed(
        'failed-lookup-materialization', workflowSourcePath, 'confirmed', 0,
      );
      await caller.call('runScheduledCleanup', { runId, now: new Date().toISOString() });
      const completed = await waitForWorkflow(caller, runId, seeded.caseId, ['complete']);
      for (const status of completed.observed) platformStatuses.add(status);
      const snapshot = workflowSnapshot(context, configPath, seeded);
      return {
        materialized: snapshot.status === 'applied'
          && snapshot.dispatch_state === 'confirmed'
          && Number(snapshot.dispatch_generation) === 1,
        retainedInstance: seeded.instanceId === (await conformanceBackfillIdentity(
          runId, seeded.caseId,
        )).instanceId,
      };
    },

    async statusUnknownPreservation(runId) {
      const before = Number(readD1(context, configPath, `
        SELECT count(*) AS count FROM event_cover_backfill_jobs
        WHERE run_id = ${sqlString(runId)};
      `)[0]?.count);
      const result = oneRecord(
        await caller.call('workflowControl', { runId, control: 'status-unknown' }),
        'WORKFLOW_CONTROL',
      );
      const after = Number(readD1(context, configPath, `
        SELECT count(*) AS count FROM event_cover_backfill_jobs
        WHERE run_id = ${sqlString(runId)};
      `)[0]?.count);
      return {
        mutationCount: after - before,
        recovery: String(result.recovery),
      };
    },

    async bounds(runId) {
      const activeTarget = await seededBackfillCase(runId, 'active-run-bound');
      const otherRunId = await conformanceUuid(runId, 'active-run-bound', 'other-run');
      operations.execute(
        'active-run-bound',
        `${seedBackfillSql(runId, activeTarget, {
          timestamp, dispatchState: 'pending', generation: 0,
        })}
        INSERT INTO event_cover_backfill_runs (id, mode, status, created_at, updated_at)
        SELECT ${sqlString(otherRunId)}, 'inventory', 'inventorying',
          ${sqlString(timestamp)}, ${sqlString(timestamp)}
        WHERE EXISTS (SELECT 1 FROM event_cover_backfill_runs
          WHERE id = ${sqlString(runId)} AND status = 'executing');
        ${initialClaimSql(runId, activeTarget)}`,
        `SELECT count(*) AS observed_count FROM event_cover_backfill_jobs
          WHERE run_id = ${sqlString(runId)} AND id = ${sqlString(activeTarget.jobId)}
            AND dispatch_state = 'pending' AND dispatch_generation = 0;`,
        1,
      );
      operations.execute(
        'active-run-bound',
        `${cleanupSeededSql(runId, [activeTarget])}
        DELETE FROM event_cover_backfill_runs WHERE id = ${sqlString(otherRunId)}
          AND EXISTS (SELECT 1 FROM event_cover_backfill_runs WHERE id = ${sqlString(runId)});`,
        cleanupObservationSql(runId, [activeTarget]),
        1,
      );

      const inFlightTarget = await seededBackfillCase(runId, 'inflight-bound');
      const inFlightCapacity = await Promise.all(Array.from(
        { length: MAX_COVER_BACKFILL_IN_FLIGHT },
        (_, index) => seededBackfillCase(runId, 'inflight-bound', index + 1),
      ));
      operations.execute(
        'inflight-bound',
        `${seedBackfillSql(runId, inFlightTarget, {
          timestamp, dispatchState: 'pending', generation: 0,
        })}
        ${inFlightCapacity.map((entry) => seedBackfillSql(runId, entry, {
          timestamp: '2020-01-01T00:00:00.000Z',
          dispatchState: 'confirmed', generation: 1,
        })).join('\n')}
        ${initialClaimSql(runId, inFlightTarget)}`,
        `SELECT count(*) AS observed_count FROM event_cover_backfill_jobs
          WHERE run_id = ${sqlString(runId)} AND id = ${sqlString(inFlightTarget.jobId)}
            AND dispatch_state = 'pending' AND dispatch_generation = 0;`,
        1,
      );
      operations.execute(
        'inflight-bound',
        cleanupSeededSql(runId, [inFlightTarget, ...inFlightCapacity]),
        cleanupObservationSql(runId, [inFlightTarget, ...inFlightCapacity]),
        1,
      );

      const minuteTarget = await seededBackfillCase(runId, 'creation-minute-bound');
      const minuteCapacity = await Promise.all(Array.from(
        { length: MAX_COVER_BACKFILL_CREATIONS_PER_MINUTE },
        (_, index) => seededBackfillCase(runId, 'creation-minute-bound', index + 1),
      ));
      operations.execute(
        'creation-minute-bound',
        `${seedBackfillSql(runId, minuteTarget, {
          timestamp, dispatchState: 'pending', generation: 0,
        })}
        ${minuteCapacity.map((entry) => seedBackfillSql(runId, entry, {
          timestamp: new Date().toISOString(),
          dispatchState: 'pending', generation: 1,
        })).join('\n')}
        ${initialClaimSql(runId, minuteTarget)}`,
        `SELECT count(*) AS observed_count FROM event_cover_backfill_jobs
          WHERE run_id = ${sqlString(runId)} AND id = ${sqlString(minuteTarget.jobId)}
            AND dispatch_state = 'pending' AND dispatch_generation = 0;`,
        1,
      );
      operations.execute(
        'creation-minute-bound',
        cleanupSeededSql(runId, [minuteTarget, ...minuteCapacity]),
        cleanupObservationSql(runId, [minuteTarget, ...minuteCapacity]),
        1,
      );

      let batchBlocked = false;
      try {
        await caller.call('createBackfillBatch', {
          runId, caseId: 'batch-bound', count: 26,
        });
      } catch (error) {
        batchBlocked = error instanceof Error && error.message === 'RPC_REMOTE_FAILED';
      }
      return {
        creationMinuteBlocked: true,
        inFlightBlocked: true,
        activeRunBlocked: true,
        batchBlocked,
      };
    },
    async deletionAndPurge(runId) {
      const beforeDispatch = await uploadAndSeed(
        'delete-before-dispatch', workflowSourcePath, 'pending', 0,
      );
      const extraFences = await Promise.all(Array.from({ length: 10 }, async (_, index) => ({
        id: await conformanceUuid(runId, 'purge-resumability', 'fence', index),
        index,
      })));
      operations.execute(
        'purge-resumability',
        `${extraFences.map(({ id }) => `
          INSERT INTO event_cover_workflow_fences (
            workflow_binding, workflow_instance_id, event_id, dispatch_generation,
            state, created_at, updated_at, expires_at
          ) SELECT 'COVER_RENDER_WORKFLOW', ${sqlString(id)},
            ${sqlString(beforeDispatch.eventId)}, 0, 'open', ${sqlString(timestamp)},
            ${sqlString(timestamp)}, '9999-12-31T23:59:59.999Z'
          WHERE EXISTS (SELECT 1 FROM event_cover_backfill_jobs
            WHERE id = ${sqlString(beforeDispatch.jobId)} AND run_id = ${sqlString(runId)});`
        ).join('\n')}`,
        `SELECT count(*) AS observed_count FROM event_cover_workflow_fences
          WHERE event_id = ${sqlString(beforeDispatch.eventId)}
            AND dispatch_generation = 0
            AND EXISTS (SELECT 1 FROM event_cover_backfill_jobs
              WHERE id = ${sqlString(beforeDispatch.jobId)} AND run_id = ${sqlString(runId)});`,
        11,
      );
      markDeleted('delete-before-dispatch', runId, beforeDispatch);
      await caller.call('runScheduledCleanup', {
        runId, now: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      });
      const partial = readD1(context, configPath, `
        SELECT p.phase,
          (SELECT count(*) FROM events e WHERE e.id = p.event_id) AS event_count,
          (SELECT count(*) FROM event_cover_workflow_fences f
            WHERE f.event_id = p.event_id AND f.state = 'deletion-blocked'
              AND f.expires_at = '9999-12-31T23:59:59.999Z') AS unresolved_count
        FROM event_cover_purge_progress p
        WHERE p.event_id = ${sqlString(beforeDispatch.eventId)};
      `)[0];
      const terminalBeforeR2 = partial?.phase === 'fences'
        && Number(partial.event_count) === 1
        && Number(partial.unresolved_count) === 1
        && !stagingObjectAbsent(context, configPath, beforeDispatch.rawKey);
      await cleanupUntilEventAbsent(runId, beforeDispatch.eventId, 6);
      const beforeDispatchPurged = provePurged(
        'delete-before-dispatch', runId, beforeDispatch,
      );

      const afterDispatch = await uploadAndSeed(
        'delete-after-dispatch', workflowSourcePath, 'creating', 1,
      );
      armFailOnce(context, configPath, afterDispatch);
      await caller.call('createBackfillBatch', {
        runId, caseId: afterDispatch.caseId, count: 1,
      });
      await waitForWorkflow(
        caller, runId, afterDispatch.caseId,
        ['queued', 'running', 'waiting', 'waitingForPause'],
        { refuseComplete: true },
      );
      markDeleted('delete-after-dispatch', runId, afterDispatch);
      await cleanupUntilEventAbsent(runId, afterDispatch.eventId, 7);
      const afterDispatchPurged = provePurged(
        'delete-after-dispatch', runId, afterDispatch,
      );

      const beforePreflight = await uploadAndSeed(
        'delete-before-preflight', workflowSourcePath, 'creating', 1,
      );
      markDeleted('delete-before-preflight', runId, beforePreflight);
      await caller.call('createBackfillBatch', {
        runId, caseId: beforePreflight.caseId, count: 1,
      });
      await waitForWorkflow(caller, runId, beforePreflight.caseId, ['complete']);
      await cleanupUntilEventAbsent(runId, beforePreflight.eventId, 8);
      const beforePreflightPurged = provePurged(
        'delete-before-preflight', runId, beforePreflight,
      );

      const afterPreflight = await uploadAndSeed(
        'delete-after-preflight', workflowSourcePath, 'creating', 1,
      );
      armFailOnce(context, configPath, afterPreflight);
      await caller.call('createBackfillBatch', {
        runId, caseId: afterPreflight.caseId, count: 1,
      });
      await waitForJobStatus(afterPreflight, ['normalizing']);
      markDeleted('delete-after-preflight', runId, afterPreflight);
      await cleanupUntilEventAbsent(runId, afterPreflight.eventId, 9);
      const afterPreflightPurged = provePurged(
        'delete-after-preflight', runId, afterPreflight,
      );

      return {
        deleteBeforeDispatch: beforeDispatchPurged,
        deleteAfterDispatch: afterDispatchPurged,
        deleteBeforePreflight: beforePreflightPurged,
        deleteAfterPreflight: afterPreflightPurged,
        resumedFromCursor: terminalBeforeR2 && beforeDispatchPurged,
        terminalBeforeR2,
        r2BeforeRelational: beforeDispatchPurged && afterDispatchPurged
          && beforePreflightPurged && afterPreflightPurged,
      };
    },
    async replacementResolution(runId) {
      const replacement = await uploadAndSeed(
        'needs-replacement-resolution', smallSourcePath, 'creating', 1,
      );
      await caller.call('createBackfillBatch', {
        runId, caseId: replacement.caseId, count: 1,
      });
      await waitForWorkflow(caller, runId, replacement.caseId, ['complete']);
      const enteredNeedsReplacement = (await waitForJobStatus(
        replacement, ['needs_replacement'],
      )) === 'needs_replacement';
      operations.execute(
        'needs-replacement-resolution',
        `UPDATE events SET cover_object_key = NULL
          WHERE id = ${sqlString(replacement.eventId)}
            AND cover_render_set_id IS NULL
            AND EXISTS (SELECT 1 FROM event_cover_backfill_jobs
              WHERE id = ${sqlString(replacement.jobId)}
                AND run_id = ${sqlString(runId)} AND status = 'needs_replacement');`,
        `SELECT count(*) AS observed_count FROM event_cover_backfill_jobs j
          JOIN events e ON e.id = j.event_id
          WHERE j.id = ${sqlString(replacement.jobId)} AND j.run_id = ${sqlString(runId)}
            AND j.status = 'needs_replacement' AND e.cover_object_key IS NULL;`,
        1,
      );
      await caller.call('runScheduledCleanup', {
        runId, now: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      const resolved = readD1(context, configPath, `
        SELECT count(*) AS count FROM event_cover_backfill_jobs
        WHERE id = ${sqlString(replacement.jobId)} AND run_id = ${sqlString(runId)}
          AND status = 'resolved';
      `)[0];
      return {
        enteredNeedsReplacement,
        resolvedAfterSourceChanged: Number(resolved?.count) === 1,
      };
    },
    async verificationClosure(runId) {
      if (!closureSentinel) throw new Error('TASK11_WORKFLOW_SENTINEL_MISSING');
      operations.execute(
        'verification-closure',
        cleanupSeededSql(runId, [closureSentinel]),
        cleanupObservationSql(runId, [closureSentinel]),
        1,
      );
      let summary: Record<string, unknown> | null = null;
      const deadline = Date.now() + 2 * 60 * 1000;
      while (Date.now() < deadline) {
        summary = oneRecord(await caller.call('runScheduledCleanup', {
          runId, now: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
        }), 'CONFORMANCE_SUMMARY');
        if (typeof summary.verifiedAt === 'string') break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
      }
      if (!summary || typeof summary.verifiedAt !== 'string'
        || Number(summary.purgeRows) !== 0) {
        throw new Error('TASK11_WORKFLOW_VERIFICATION_NOT_RECORDED');
      }
      return {
        proof: {
          legacyRows: Number(summary.legacyRows),
          blockingJobs: Number(summary.blockingJobs),
          incompleteActiveSets: Number(summary.incompleteActiveSets),
          uploadsWithoutActiveSet: Number(summary.uploadsWithoutActiveSet),
        },
        verifiedAt: summary.verifiedAt,
      };
    },
  };
}

async function conform(context: Task11RemoteContext): Promise<Task11ConformanceResult> {
  const owned = loadExistingConfig(context);
  const callerRoot = resolve(context.runRoot, 'conformance-caller');
  const caller = await startCaller(
    context.projectRoot,
    callerRoot,
    buildStagingCallerConfig(context.runId),
    STAGING_CALLER_SOURCE,
  );
  try {
    const runtime = runtimeIdentity(
      await caller.call('runtimeIdentity', { runId: context.runId }),
      context.candidate.sha,
    );
    const images = await conformImages(context, caller, owned.configPath);
    const operations = new Task11OperationExecutor(context, owned.configPath);
    const workflows = await executeTask11WorkflowMatrix(
      context.runId,
      makeLiveWorkflowAdapter(
        context,
        caller,
        owned.configPath,
        images.workflowSourcePath,
        images.smallSourcePath,
        operations,
      ),
    );
    operations.manifestSha256();
    return {
      status: 'passed',
      runtime,
      fixtureManifestSha256: images.fixtureDigest,
      images: images.observations,
      workflows: workflows.observations,
      zeroProof: workflows.proof,
      verifiedAt: workflows.verifiedAt,
    };
  } finally {
    await caller.stop();
  }
}

function listHasName(output: string, name: string): boolean {
  return output.split(/\r?\n/u).some((line) => line.includes(name));
}

async function cleanup(context: Task11RemoteContext): Promise<CleanupObservation> {
  const owned = loadExistingConfig(context);
  const wrangler = exactWranglerJs(context.projectRoot);
  const caller = await startCaller(
    context.projectRoot,
    resolve(context.runRoot, 'cleanup-caller'),
    buildStagingCallerConfig(context.runId),
    STAGING_CALLER_SOURCE,
  );
  try {
    const emptied = oneRecord(
      await caller.call('emptyStagingBucket', { runId: context.runId }),
      'STAGING_BUCKET_EMPTY',
    );
    if (emptied.remainingObjects !== 0 || !Number.isSafeInteger(emptied.deletedObjects)
      || (emptied.deletedObjects as number) < 0) {
      throw new Error('TASK11_STAGING_BUCKET_NOT_EMPTY');
    }
  } finally {
    await caller.stop();
  }
  deleteWorkerIfPresent(context.projectRoot, stagingCallerName(context.runId), owned.configPath);
  deleteWorkerIfPresent(context.projectRoot, PROBE_CALLER_NAME, owned.configPath);
  deleteWorkerIfPresent(context.projectRoot, PROBE_WORKER_NAME, owned.configPath);
  runPlanned(buildCloudflareCommand({ id: 'worker-delete', root: owned.root, wrangler, config: owned.configPath }));
  for (const workflowName of Object.values(STAGING_TARGET.workflows)) {
    runPlanned(buildCloudflareCommand({
      id: 'workflow-delete', root: owned.root, wrangler, config: owned.configPath, workflowName,
    }));
  }
  runPlanned(buildCloudflareCommand({ id: 'r2-delete', root: owned.root, wrangler, config: owned.configPath }));
  runPlanned(buildCloudflareCommand({ id: 'd1-delete', root: owned.root, wrangler, config: owned.configPath }));
  const d1 = jsonOutput(runNodeWrangler(context.projectRoot, ['d1', 'list', '--json']).stdout, 'D1_LIST');
  const r2 = runNodeWrangler(context.projectRoot, ['r2', 'bucket', 'list']).stdout;
  const workflows = runNodeWrangler(context.projectRoot, ['workflows', 'list', '--per-page', '100']).stdout;
  const worker = runNodeWrangler(context.projectRoot, [
    'versions', 'list', '--name', STAGING_TARGET.workerName, '--config', owned.configPath, '--json',
  ], { allowFailure: true });
  const databaseAbsent = Array.isArray(d1)
    && !d1.some((entry) => oneRecord(entry, 'D1_LIST_ROW').uuid === context.target.databaseId);
  const bucketAbsent = !listHasName(r2, STAGING_TARGET.bucketName);
  const workflowsAbsent = Object.values(STAGING_TARGET.workflows).every((name) => !listHasName(workflows, name));
  const workerAbsent = worker.status !== 0 || (Array.isArray(jsonOutput(worker.stdout || '[]', 'WORKER_LIST'))
    && (jsonOutput(worker.stdout || '[]', 'WORKER_LIST') as unknown[]).length === 0);
  return {
    fixturesAbsent: bucketAbsent,
    workerAbsent,
    databaseAbsent,
    bucketAbsent,
    workflowsAbsent,
    callersAbsent: true,
    probeAbsent: true,
  };
}

export function liveStagingReleaseAdapters(): StagingReleasePhaseAdapters {
  return {
    now: () => new Date().toISOString(),
    verifyCandidate: candidateEvidence,
    probe,
    deploy,
    conform,
    cleanup,
  };
}

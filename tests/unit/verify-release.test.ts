// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROVED_RELEASE_BASE_SHA,
  assertDependencyFreeBootstrapGraph,
  bootstrapRelease,
  executeRelease,
  finalizeCandidateManifest,
  runCandidate,
  writeCandidateEvidence,
  type CandidateReleaseModule,
  type ReleaseBootstrapAdapters,
  type ReleaseAdapters,
  type ReleaseRunRequest,
} from '../../scripts/verify-release';
import { runDeployRelease } from '../../scripts/deploy-release';
import {
  assertRedactedCandidateManifest,
  type MigrationVerification,
} from '../../scripts/release-evidence';

const CANDIDATE_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryRoot(prefix = 'candidary-verify-release-test-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function put(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, 'utf8');
}

function independentCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${independentCanonical(record[key])}`).join(',')}}`;
  }
  throw new TypeError('fixture is not JSON');
}

function independentSha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bootstrapAdapters(options: {
  importFailure?: boolean;
  cleanupFailure?: boolean;
  registryStale?: boolean;
  runRootRemovalFailure?: boolean;
  draftRunId?: string;
  missingExport?: 'runCandidate' | 'finalizeCandidateManifest';
  candidateModule?: CandidateReleaseModule;
  onImport?: () => Promise<void>;
} = {}): ReleaseBootstrapAdapters & {
  calls: Array<{ args: string[]; cwd: string }>;
  imports: string[];
  generatedIds: number;
  statuses: string[];
  runRootRemovals: string[];
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const imports: string[] = [];
  const statuses: string[] = [];
  const runRootRemovals: string[] = [];
  let generatedIds = 0;
  let registeredWorktree: string | null = null;

  return {
    calls,
    imports,
    statuses,
    runRootRemovals,
    get generatedIds() {
      return generatedIds;
    },
    randomUUID() {
      generatedIds += 1;
      return RUN_ID;
    },
    async git(args, cwd) {
      calls.push({ args: [...args], cwd });
      if (args[0] === 'rev-parse' && args[2] === `${CANDIDATE_SHA}^{commit}`) {
        return { exitCode: 0, stdout: `${CANDIDATE_SHA}\n` };
      }
      if (args[0] === 'rev-parse' && args[2] === `${APPROVED_RELEASE_BASE_SHA}^{commit}`) {
        return { exitCode: 0, stdout: `${APPROVED_RELEASE_BASE_SHA}\n` };
      }
      if (args[0] === 'merge-base') return { exitCode: 0, stdout: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        registeredWorktree = args[3]!;
        await mkdir(registeredWorktree, { recursive: true });
        await put(registeredWorktree, 'scripts/verify-release.ts', '// candidate module fixture\n');
        return { exitCode: 0, stdout: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        if (options.cleanupFailure) return { exitCode: 1, stdout: '' };
        if (registeredWorktree) await rm(registeredWorktree, { force: true, recursive: true });
        if (!options.registryStale) registeredWorktree = null;
        return { exitCode: 0, stdout: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          exitCode: 0,
          stdout: registeredWorktree ? `worktree ${registeredWorktree}\n\n` : '',
        };
      }
      throw new Error(`Unexpected Git call: ${args.join(' ')}`);
    },
    async importCandidate(url) {
      imports.push(url);
      await options.onImport?.();
      if (options.importFailure) throw new Error('simulated candidate import failure');
      if (options.candidateModule) return options.candidateModule;
      const candidateModule: Partial<CandidateReleaseModule> = {
        async runCandidate(request) {
          return {
            manifest: {
              runId: options.draftRunId ?? request.runId,
              candidate: { gitSha: request.candidateSha, gitTree: TREE_SHA },
            },
          } as never;
        },
        finalizeCandidateManifest(draft) {
          return draft.manifest;
        },
      };
      if (options.missingExport) delete candidateModule[options.missingExport];
      return candidateModule as CandidateReleaseModule;
    },
    writeStatus(status) {
      statuses.push(status);
    },
    async removeRunRoot(runRoot) {
      runRootRemovals.push(runRoot);
      if (options.runRootRemovalFailure) throw new Error('simulated run-root cleanup failure');
      await rm(runRoot, { force: true, recursive: true });
    },
  };
}

const sourceWranglerConfig = {
  name: 'candidary',
  main: 'worker/index.ts',
  compatibility_date: '2026-07-21',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: true,
  assets: {
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/api/*', '/manage/*'],
  },
  version_metadata: { binding: 'CF_VERSION_METADATA' },
  d1_databases: [{ binding: 'DB', database_name: 'local', database_id: 'fixture', migrations_dir: 'migrations' }],
  r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'fixture' }],
  images: { binding: 'IMAGES' },
  send_email: [{ name: 'EMAIL' }],
  ratelimits: [{ name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '1', simple: { limit: 20, period: 60 } }],
  workflows: [{ name: 'fixture', binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' }],
  triggers: { crons: ['17 3 * * *'] },
  vars: { APP_ORIGIN: 'https://example.test' },
  secrets: { required: ['SESSION_HMAC_KEY', 'TOKEN_HMAC_KEY'] },
  observability: { enabled: true },
};

const migrationVerification: MigrationVerification = {
  migrationCount: 1,
  ledgerSha256: independentSha(independentCanonical(['0001_initial.sql'])),
  foreignKeyRows: 0,
  integrity: 'ok',
  terminalSchema: {
    events: true,
    rosterBatchReceipts: true,
    releaseCertifications: true,
  },
};

interface InnerOptions {
  attachedInitial?: boolean;
  initialHead?: string;
  initialTree?: string;
  initialStatus?: string;
  finalAttached?: boolean;
  finalHead?: string;
  finalTree?: string;
  finalStatus?: string;
  failCommand?: string;
  invalidReport?: 'unit-ui' | 'worker' | 'playwright';
  missingReport?: 'unit-ui' | 'worker' | 'playwright';
  artifactDrift?: boolean;
  bindingDrift?: boolean;
  dryRunMismatch?: boolean;
  dryRunExtraFile?: boolean;
  workerIdentityMissing?: boolean;
  workerGlobalUnreplaced?: boolean;
  clientIdentityLeak?: boolean;
  forbiddenSecretAt?: 'worker' | 'client' | 'dry-run';
  invalidMigrationReport?: boolean;
  generatedTypesMissing?: boolean;
  wranglerLinkEscape?: boolean;
  dryRunLinkEscape?: boolean;
  candidateIdentityUnavailable?: boolean;
}

interface InnerFixture {
  request: ReleaseRunRequest;
  adapters: ReleaseAdapters;
  calls: Array<{
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }>;
  gitCalls: string[][];
  migrationDigest: string;
  unitReport: string;
  workerReport: string;
  playwrightReport: string;
  migrationReport: string;
  dryRunRoot: string;
}

function vitestReport(total: number, passed: number, failed: number, skipped: number): unknown {
  const assertions = [
    ...Array.from({ length: passed }, () => ({ status: 'passed' })),
    ...Array.from({ length: failed }, () => ({ status: 'failed' })),
    ...Array.from({ length: skipped }, () => ({ status: 'skipped' })),
  ];
  return {
    numTotalTestSuites: 1,
    numPassedTestSuites: failed === 0 ? 1 : 0,
    numFailedTestSuites: failed > 0 ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: total,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: skipped,
    numTodoTests: 0,
    success: failed === 0,
    testResults: [{ name: 'fixture.test.ts', assertionResults: assertions }],
  };
}

function playwrightReport(): unknown {
  return {
    config: {},
    suites: [],
    errors: [],
    stats: {
      startTime: '2026-08-03T00:00:00.000Z',
      duration: 100,
      expected: 7,
      unexpected: 0,
      flaky: 1,
      skipped: 2,
    },
  };
}

async function createInnerFixture(options: InnerOptions = {}): Promise<InnerFixture> {
  const callerRoot = await temporaryRoot();
  const runRoot = await temporaryRoot('candidary-release-');
  const candidateRoot = resolve(runRoot, 'worktree');
  await mkdir(candidateRoot, { recursive: true });
  const migrationBytes = 'CREATE TABLE fixture (id TEXT PRIMARY KEY);\n';
  await put(candidateRoot, 'migrations/0001_initial.sql', migrationBytes);
  await put(candidateRoot, 'package-lock.json', '{"lockfileVersion":3}\n');
  await put(candidateRoot, 'config/release.json', '{"guestJourneyVersion":1}\n');
  await put(candidateRoot, 'wrangler.jsonc', `${JSON.stringify(sourceWranglerConfig, null, 2)}\n`);
  const migrationFileSha = independentSha(migrationBytes);
  const migrationDigest = independentSha(independentCanonical([
    { path: 'migrations/0001_initial.sql', sha256: migrationFileSha },
  ]));
  const unitReport = resolve(runRoot, 'unit-report.json');
  const workerReport = resolve(runRoot, 'worker-report.json');
  const playwrightReportPath = resolve(runRoot, 'playwright-report.json');
  const migrationReport = resolve(runRoot, 'migration-verification.json');
  const dryRunRoot = resolve(runRoot, 'wrangler-dry-run');
  const calls: InnerFixture['calls'] = [];
  const gitCalls: string[][] = [];
  let clock = Date.parse('2026-08-03T00:00:00.000Z');
  let statusReads = 0;

  const packageVersions: Array<[string, string]> = [
    ['typescript', '6.0.3'],
    ['eslint', '10.7.0'],
    ['vite', '8.1.5'],
    ['vitest', '4.1.10'],
    ['@playwright/test', '1.61.1'],
    ['wrangler', '4.113.0'],
  ];

  const installDependencies = async (): Promise<void> => {
    for (const [name, version] of packageVersions) {
      if (name === 'wrangler' && options.wranglerLinkEscape) continue;
      await put(candidateRoot, `node_modules/${name}/package.json`, `${JSON.stringify({ name, version })}\n`);
    }
    if (options.wranglerLinkEscape) {
      const escapedWranglerRoot = resolve(callerRoot, 'outside-wrangler');
      await put(escapedWranglerRoot, 'package.json', `${JSON.stringify({ name: 'wrangler', version: '4.113.0' })}\n`);
      await put(escapedWranglerRoot, 'bin/wrangler.js', '// escaped fixture Wrangler CLI\n');
      await mkdir(resolve(candidateRoot, 'node_modules'), { recursive: true });
      await symlink(
        escapedWranglerRoot,
        resolve(candidateRoot, 'node_modules/wrangler'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } else {
      await put(candidateRoot, 'node_modules/wrangler/bin/wrangler.js', '// fixture Wrangler CLI\n');
    }
  };

  const generatedConfig = (): Record<string, unknown> => ({
    ...structuredClone(sourceWranglerConfig),
    main: 'index.js',
    assets: { ...sourceWranglerConfig.assets, directory: '../client' },
    ...(options.bindingDrift ? { compatibility_date: '2026-07-22' } : {}),
  });

  const writeBuild = async (second: boolean): Promise<void> => {
    let worker = `${CANDIDATE_SHA}:${migrationDigest}`;
    if (options.workerIdentityMissing) worker = 'worker-without-release-identity';
    if (options.workerGlobalUnreplaced) worker += ':__CANDIDARY_BUILD_SHA__';
    if (second && options.artifactDrift) worker += ':second-build-drift';
    await put(candidateRoot, 'dist/candidary/index.js', worker);
    await put(candidateRoot, 'dist/candidary/wrangler.json', `${JSON.stringify(generatedConfig())}\n`);
    await put(candidateRoot, 'dist/client/index.html', options.clientIdentityLeak
      ? `<script>${CANDIDATE_SHA}:${migrationDigest}</script>`
      : '<script src="/assets/app.js"></script>');
    await put(candidateRoot, 'dist/client/assets/app.js', 'console.log("fixture");\n');
    if (options.forbiddenSecretAt === 'worker') await put(candidateRoot, 'dist/candidary/.dev.vars', 'SECRET=x\n');
    if (options.forbiddenSecretAt === 'client') await put(candidateRoot, 'dist/client/.ENV.production', 'SECRET=x\n');
  };

  const commandId = (executable: string, args: readonly string[]): string => {
    if (executable.toLowerCase().endsWith('git') || executable.toLowerCase().endsWith('git.exe')) return 'diff-check';
    if (args[1] === 'ci') return 'npm-ci';
    if (args[1] === 'run') {
      const script = args[2];
      if (script === 'verify:bindings') return 'verify-bindings';
      if (script === 'typecheck') return 'typecheck';
      if (script === 'typecheck:e2e') return 'typecheck-e2e';
      if (script === 'lint') return 'lint';
      if (script === 'test:unit') return 'unit-ui';
      if (script === 'test:worker') return 'worker';
      if (script === 'build') return 'build';
      if (script === 'verify:pwa-build') return calls.filter((call) => call.args[2] === 'verify:pwa-build').length === 0
        ? 'pwa-before-e2e'
        : 'pwa-after-e2e';
      if (script === 'test:e2e') return 'playwright';
      if (script === 'verify:fresh-d1') return 'fresh-d1';
    }
    if (args[1] === 'deploy') return 'wrangler-dry-run';
    throw new Error(`Unknown fixture command: ${executable} ${args.join(' ')}`);
  };

  const adapters: ReleaseAdapters = {
    async run(input) {
      const id = commandId(input.executable, input.args);
      calls.push({ ...input, args: [...input.args], env: { ...input.env } });
      if (id === 'npm-ci') await installDependencies();
      if (id === 'verify-bindings' && !options.generatedTypesMissing) {
        await put(candidateRoot, 'worker-configuration.d.ts', '// generated binding types\n');
      }
      if (id === 'unit-ui' && options.missingReport !== id) {
        await writeFile(unitReport, options.invalidReport === id ? '{' : JSON.stringify(vitestReport(4, 3, 0, 1)), 'utf8');
      }
      if (id === 'worker' && options.missingReport !== id) {
        await writeFile(workerReport, options.invalidReport === id ? '{' : JSON.stringify(vitestReport(3, 3, 0, 0)), 'utf8');
      }
      if (id === 'build') await writeBuild(false);
      if (id === 'playwright') {
        await writeBuild(true);
        if (options.missingReport !== id) {
          await writeFile(playwrightReportPath, options.invalidReport === id ? '{' : JSON.stringify(playwrightReport()), 'utf8');
        }
      }
      if (id === 'wrangler-dry-run') {
        if (options.dryRunLinkEscape) {
          const escapedDryRunRoot = resolve(callerRoot, 'outside-dry-run');
          await mkdir(escapedDryRunRoot, { recursive: true });
          await symlink(
            escapedDryRunRoot,
            dryRunRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        }
        const worker = await readFile(resolve(candidateRoot, 'dist/candidary/index.js'), 'utf8');
        await put(runRoot, 'wrangler-dry-run/index.js', options.dryRunMismatch ? `${worker}:mismatch` : worker);
        await put(
          runRoot,
          'wrangler-dry-run/README.md',
          `This folder contains the built output assets for the worker "candidary" generated at ${new Date(clock).toISOString()}.`,
        );
        if (options.dryRunExtraFile) await put(runRoot, 'wrangler-dry-run/extra.js', 'unexpected');
        if (options.forbiddenSecretAt === 'dry-run') await put(runRoot, 'wrangler-dry-run/.env.local', 'SECRET=x\n');
      }
      if (id === 'fresh-d1') {
        const report = options.invalidMigrationReport ? { ...migrationVerification, integrity: 'bad' } : migrationVerification;
        await writeFile(migrationReport, JSON.stringify(report), 'utf8');
      }
      return { exitCode: options.failCommand === id ? 7 : 0 };
    },
    async git(args) {
      gitCalls.push([...args]);
      if (args[0] === '--version') return { exitCode: 0, stdout: 'git version 2.50.1.windows.1\n' };
      if (args[0] === 'rev-parse' && args[2] === `${CANDIDATE_SHA}^{commit}`) {
        return options.candidateIdentityUnavailable
          ? { exitCode: 1, stdout: '' }
          : { exitCode: 0, stdout: `${CANDIDATE_SHA}\n` };
      }
      if (args[0] === 'rev-parse' && args[2] === `${APPROVED_RELEASE_BASE_SHA}^{commit}`) {
        return { exitCode: 0, stdout: `${APPROVED_RELEASE_BASE_SHA}\n` };
      }
      if (args[0] === 'rev-parse' && args[2] === `${CANDIDATE_SHA}^{tree}`) {
        return { exitCode: 0, stdout: `${TREE_SHA}\n` };
      }
      if (args[0] === 'merge-base') return { exitCode: 0, stdout: '' };
      const final = statusReads > 0;
      if (args[0] === 'symbolic-ref') {
        const attached = final ? options.finalAttached : options.attachedInitial;
        return { exitCode: attached ? 0 : 1, stdout: attached ? 'refs/heads/fixture\n' : '' };
      }
      if (args[0] === 'rev-parse' && args[2] === 'HEAD^{commit}') {
        return { exitCode: 0, stdout: `${final ? (options.finalHead ?? CANDIDATE_SHA) : (options.initialHead ?? CANDIDATE_SHA)}\n` };
      }
      if (args[0] === 'rev-parse' && args[2] === 'HEAD^{tree}') {
        return { exitCode: 0, stdout: `${final ? (options.finalTree ?? TREE_SHA) : (options.initialTree ?? TREE_SHA)}\n` };
      }
      if (args[0] === 'status') {
        const stdout = statusReads === 0 ? (options.initialStatus ?? '') : (options.finalStatus ?? '');
        statusReads += 1;
        return { exitCode: 0, stdout };
      }
      throw new Error(`Unexpected inner Git call: ${args.join(' ')}`);
    },
    now() {
      const value = new Date(clock).toISOString();
      clock += 1_000;
      return value;
    },
    randomUUID() {
      return '323e4567-e89b-42d3-a456-426614174000';
    },
  };

  return {
    request: {
      callerRoot,
      candidateRoot,
      runRoot,
      runId: RUN_ID,
      candidateSha: CANDIDATE_SHA,
      approvedBaseSha: APPROVED_RELEASE_BASE_SHA,
    },
    adapters,
    calls,
    gitCalls,
    migrationDigest,
    unitReport,
    workerReport,
    playwrightReport: playwrightReportPath,
    migrationReport,
    dryRunRoot,
  };
}

async function releaseModuleFixture(options: InnerOptions = {}): Promise<CandidateReleaseModule> {
  const fixture = await createInnerFixture(options);
  const draft = await runCandidate(fixture.request, fixture.adapters);
  return {
    async runCandidate(request) {
      const candidateDraft = structuredClone(draft);
      candidateDraft.manifest.runId = request.runId;
      if (candidateDraft.manifest.candidate) {
        candidateDraft.manifest.candidate.gitSha = request.candidateSha;
        candidateDraft.manifest.candidate.approvedBaseSha = request.approvedBaseSha;
      }
      return candidateDraft;
    },
    finalizeCandidateManifest,
  };
}

describe('release bootstrap isolation', () => {
  it.each([
    ['short candidate SHA', ['--sha', 'abc', '--base-sha', APPROVED_RELEASE_BASE_SHA]],
    ['candidate ref', ['--sha', 'HEAD', '--base-sha', APPROVED_RELEASE_BASE_SHA]],
    ['short base SHA', ['--sha', CANDIDATE_SHA, '--base-sha', 'abc']],
    ['unapproved full ancestor', ['--sha', CANDIDATE_SHA, '--base-sha', 'c'.repeat(40)]],
  ])('rejects %s before reserving a run', async (_label, args) => {
    const callerRoot = await temporaryRoot();
    const adapters = bootstrapAdapters();
    await expect(bootstrapRelease(args, callerRoot, adapters)).rejects.toThrow();
    expect(adapters.generatedIds).toBe(0);
    expect(adapters.calls).toHaveLength(0);
  });

  it('rejects non-commit objects and a non-ancestor approved base before worktree creation', async () => {
    const callerRoot = await temporaryRoot();
    for (const failure of ['candidate-object', 'non-ancestor'] as const) {
      const adapters = bootstrapAdapters();
      const originalGit = adapters.git.bind(adapters);
      adapters.git = async (args, cwd) => {
        if (failure === 'candidate-object' && args[0] === 'rev-parse' && args[2] === `${CANDIDATE_SHA}^{commit}`) {
          return { exitCode: 1, stdout: '' };
        }
        if (failure === 'non-ancestor' && args[0] === 'merge-base') {
          return { exitCode: 1, stdout: '' };
        }
        return originalGit(args, cwd);
      };

      await expect(bootstrapRelease(
        ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA],
        callerRoot,
        adapters,
      )).rejects.toThrow();
      expect(adapters.calls.some(({ args }) => args[0] === 'worktree' && args[1] === 'add')).toBe(false);
      expect(adapters.generatedIds).toBe(0);
    }
  });

  it('generates one UUID and binds it to the target import, request, output path, and draft', async () => {
    const callerRoot = await temporaryRoot();
    const adapters = bootstrapAdapters();

    const result = await bootstrapRelease(
      ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA],
      callerRoot,
      adapters,
    );
    roots.push(result.runRoot);

    expect(adapters.generatedIds).toBe(1);
    expect(result.runId).toBe(RUN_ID);
    expect(result.request.runId).toBe(RUN_ID);
    expect(result.draft.manifest.runId).toBe(RUN_ID);
    expect(result.outputDirectory).toBe(resolve(callerRoot, 'output/release', CANDIDATE_SHA, RUN_ID));
    expect(result.request.candidateRoot).toBe(resolve(result.runRoot, 'worktree'));
    expect(fileURLToPath(new URL(adapters.imports[0]!))).toBe(
      resolve(result.request.candidateRoot, 'scripts/verify-release.ts'),
    );
    expect(fileURLToPath(new URL(adapters.imports[0]!))).not.toBe(
      resolve(callerRoot, 'scripts/verify-release.ts'),
    );
  });

  it('rejects a candidate draft whose run ID differs from the one reserved by the outer runner', async () => {
    const callerRoot = await temporaryRoot();
    const adapters = bootstrapAdapters({ draftRunId: '223e4567-e89b-42d3-a456-426614174000' });
    await expect(bootstrapRelease(
      ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA],
      callerRoot,
      adapters,
    )).rejects.toThrow(/bootstrap_failed/iu);
    expect(adapters.statuses).toEqual(['bootstrap_failed']);
  });

  it('loads a dependency-free candidate graph before node_modules exists and rejects bare imports', async () => {
    const candidateRoot = await temporaryRoot();
    await put(candidateRoot, 'scripts/release-evidence.ts', "import { createHash } from 'node:crypto';\nexport const digest = createHash('sha256');\n");
    await put(candidateRoot, 'scripts/verify-release.ts', "import './release-evidence.ts';\nexport const loaded = true;\n");
    expect(await readFile(resolve(candidateRoot, 'scripts/verify-release.ts'), 'utf8')).toContain('release-evidence');
    expect(await assertDependencyFreeBootstrapGraph(resolve(candidateRoot, 'scripts/verify-release.ts'))).toEqual([
      resolve(candidateRoot, 'scripts/release-evidence.ts'),
      resolve(candidateRoot, 'scripts/verify-release.ts'),
    ]);

    await put(candidateRoot, 'scripts/release-evidence.ts', "import 'vitest';\nexport const loaded = true;\n");
    await expect(assertDependencyFreeBootstrapGraph(
      resolve(candidateRoot, 'scripts/verify-release.ts'),
    )).rejects.toThrow(/bare-package/iu);

    await put(
      candidateRoot,
      'scripts/verify-release.ts',
      "const dependency = './release-evidence.ts';\nawait import(dependency + '?unreviewed');\n",
    );
    await expect(assertDependencyFreeBootstrapGraph(
      resolve(candidateRoot, 'scripts/verify-release.ts'),
    )).rejects.toThrow(/dynamic bootstrap import/iu);
  });

  it('follows the production computed import and rejects a relative escape from the candidate', async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    expect(await assertDependencyFreeBootstrapGraph(
      resolve(repositoryRoot, 'scripts/verify-release.ts'),
    )).toEqual([
      resolve(repositoryRoot, 'scripts/release-evidence.ts'),
      resolve(repositoryRoot, 'scripts/verify-release.ts'),
    ]);

    const fixtureRoot = await temporaryRoot();
    await put(fixtureRoot, 'outside.ts', 'export const outside = true;\n');
    await put(fixtureRoot, 'candidate/scripts/verify-release.ts', "import '../../outside.ts';\n");
    await expect(assertDependencyFreeBootstrapGraph(
      resolve(fixtureRoot, 'candidate/scripts/verify-release.ts'),
    )).rejects.toThrow(/escape/iu);
  });

  it('loads the production bootstrap graph in a directory with no node_modules', async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const isolatedRoot = await temporaryRoot();
    for (const path of ['scripts/release-evidence.ts', 'scripts/verify-release.ts']) {
      await put(isolatedRoot, path, await readFile(resolve(repositoryRoot, path), 'utf8'));
    }
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(pathToFileURL(resolve(isolatedRoot, 'scripts/verify-release.ts')).href)})`,
    ], {
      cwd: isolatedRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
      shell: false,
    });
    expect(result.status, result.stderr).toBe(0);
    await expect(readFile(resolve(isolatedRoot, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans an exactly registered worktree and run root after import failure without evidence', async () => {
    const callerRoot = await temporaryRoot();
    const adapters = bootstrapAdapters({ importFailure: true });

    await expect(bootstrapRelease(
      ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA],
      callerRoot,
      adapters,
    )).rejects.toThrow(/bootstrap_failed/u);

    const add = adapters.calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add');
    expect(add).toBeDefined();
    const worktreeRoot = add!.args[3]!;
    await expect(readFile(resolve(dirname(worktreeRoot), 'candidate-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(worktreeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(dirname(worktreeRoot))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(adapters.statuses).toEqual(['bootstrap_failed']);
  });

  it.each(['runCandidate', 'finalizeCandidateManifest'] as const)(
    'treats a candidate module missing %s as bootstrap_failed',
    async (missingExport) => {
      const callerRoot = await temporaryRoot();
      const adapters = bootstrapAdapters({ missingExport });
      await expect(bootstrapRelease(
        ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA],
        callerRoot,
        adapters,
      )).rejects.toThrow(/bootstrap_failed/u);
      expect(adapters.statuses).toEqual(['bootstrap_failed']);
      expect(adapters.calls.some(({ args }) => args[0] === 'worktree' && args[1] === 'remove')).toBe(true);
    },
  );

  it('preserves a registered worktree when cleanup fails and reports only bootstrap_cleanup_failed', async () => {
    const callerRoot = await temporaryRoot();
    const adapters = bootstrapAdapters({ importFailure: true, cleanupFailure: true });

    await expect(bootstrapRelease(
      ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA],
      callerRoot,
      adapters,
    )).rejects.toThrow(/bootstrap_cleanup_failed/u);

    const add = adapters.calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add')!;
    const worktreeRoot = add.args[3]!;
    roots.push(dirname(worktreeRoot));
    expect(basename(dirname(worktreeRoot))).toMatch(/^candidary-release-/u);
    expect(await readFile(resolve(worktreeRoot, 'scripts/verify-release.ts'), 'utf8')).toContain('candidate');
    expect(adapters.statuses).toEqual(['bootstrap_cleanup_failed']);
  });

  it('preserves the registered temp worktree when bootstrap output cannot be removed safely', async () => {
    const callerRoot = await temporaryRoot();
    const candidateModule: CandidateReleaseModule = {
      async runCandidate(request) {
        const outputDirectory = resolve(
          callerRoot,
          'output/release',
          request.candidateSha,
          request.runId,
        );
        await writeFile(resolve(outputDirectory, 'unexpected.txt'), 'preserve\n', 'utf8');
        return { manifest: { runId: '223e4567-e89b-42d3-a456-426614174000' } } as never;
      },
      finalizeCandidateManifest(draft) {
        return draft.manifest;
      },
    };
    const adapters = bootstrapAdapters({ candidateModule });
    await expect(bootstrapRelease(
      ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA],
      callerRoot,
      adapters,
    )).rejects.toThrow(/bootstrap_cleanup_failed/u);
    const add = adapters.calls.find(({ args }) => args[0] === 'worktree' && args[1] === 'add')!;
    const runRoot = dirname(add.args[3]!);
    roots.push(runRoot);
    expect((await lstat(add.args[3]!)).isDirectory()).toBe(true);
    expect(adapters.runRootRemovals).toHaveLength(0);
    expect(adapters.statuses).toEqual(['bootstrap_cleanup_failed']);
  });
});

describe('immutable candidate command runner', () => {
  it('runs the exact local-only command plan through Node CLIs with a sanitized environment', async () => {
    const fixture = await createInnerFixture();
    const changedEnvironmentNames = [
      'CLOUDFLARE_API_TOKEN',
      'ClOuDfLaRe_Account_ID',
      'VITE_REMOTE_BINDINGS',
      'DEPLOY_TOKEN',
      'SESSION_COOKIE',
      'OPENAI_API_KEY',
      'CANDIDARY_UNRELATED_VALUE',
      'NODE_PATH',
    ] as const;
    const original = new Map(changedEnvironmentNames.map((name) => [name, process.env[name]]));
    process.env.CLOUDFLARE_API_TOKEN = 'cloudflare-token';
    process.env.ClOuDfLaRe_Account_ID = 'cloudflare-account';
    process.env.VITE_REMOTE_BINDINGS = 'true';
    process.env.DEPLOY_TOKEN = 'generic-token';
    process.env.SESSION_COOKIE = 'cookie';
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.CANDIDARY_UNRELATED_VALUE = 'must-not-cross-boundary';
    process.env.NODE_PATH = resolve(fixture.request.callerRoot, 'caller-controlled-node-modules');
    let draft;
    try {
      draft = await runCandidate(fixture.request, fixture.adapters);
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const manifest = finalizeCandidateManifest(draft, true);
    assertRedactedCandidateManifest(manifest);

    expect(manifest.status).toBe('passed');
    expect(manifest.commands.map(({ id }) => id)).toEqual([
      'npm-ci', 'verify-bindings', 'typecheck', 'typecheck-e2e', 'lint', 'unit-ui', 'worker',
      'build', 'pwa-before-e2e', 'playwright', 'pwa-after-e2e', 'wrangler-dry-run',
      'fresh-d1', 'diff-check',
    ]);
    expect(fixture.calls).toHaveLength(14);
    expect(fixture.calls.every(({ cwd }) => cwd === fixture.request.candidateRoot)).toBe(true);
    expect(fixture.calls.slice(0, 13).every(({ executable }) => executable === process.execPath)).toBe(true);
    expect(fixture.calls[13]!.executable).toMatch(/(?:^|[\\/])git(?:\.exe)?$/iu);

    const npmCli = fixture.calls[0]!.args[0]!;
    const wranglerCli = resolve(fixture.request.candidateRoot, 'node_modules/wrangler/bin/wrangler.js');
    expect(npmCli).toMatch(/npm-cli\.js$/iu);
    expect(fixture.calls[0]!.args).toEqual([npmCli, 'ci']);
    expect(fixture.calls[1]!.args).toEqual([npmCli, 'run', 'verify:bindings']);
    expect(fixture.calls[2]!.args).toEqual([npmCli, 'run', 'typecheck']);
    expect(fixture.calls[3]!.args).toEqual([npmCli, 'run', 'typecheck:e2e']);
    expect(fixture.calls[4]!.args).toEqual([npmCli, 'run', 'lint']);
    expect(fixture.calls[5]!.args).toEqual([
      npmCli, 'run', 'test:unit', '--', '--reporter=default', '--reporter=json',
      `--outputFile.json=${fixture.unitReport}`,
    ]);
    expect(fixture.calls[6]!.args).toEqual([
      npmCli, 'run', 'test:worker', '--', '--reporter=default', '--reporter=json',
      `--outputFile.json=${fixture.workerReport}`,
    ]);
    expect(fixture.calls[7]!.args).toEqual([npmCli, 'run', 'build']);
    expect(fixture.calls[8]!.args).toEqual([npmCli, 'run', 'verify:pwa-build']);
    expect(fixture.calls[9]!.args).toEqual([npmCli, 'run', 'test:e2e', '--', '--reporter=list,json']);
    expect(fixture.calls[10]!.args).toEqual([npmCli, 'run', 'verify:pwa-build']);
    expect(fixture.calls[11]!.args).toEqual([
      wranglerCli, 'deploy', '--config', 'dist/candidary/wrangler.json', '--dry-run', '--strict',
      '--tag', CANDIDATE_SHA, '--outdir', fixture.dryRunRoot,
    ]);
    expect(fixture.calls[12]!.args).toEqual([
      npmCli, 'run', 'verify:fresh-d1', '--', '--run-root', fixture.request.runRoot,
      '--report-file', fixture.migrationReport,
    ]);
    expect(fixture.calls[13]!.args).toEqual([
      'diff', '--check', `${APPROVED_RELEASE_BASE_SHA}..${CANDIDATE_SHA}`,
    ]);
    const serialized = JSON.stringify(fixture.calls.map(({ executable, args }) => ({ executable, args })));
    expect(serialized).not.toMatch(/\.cmd|\bnpx\b|--remote|secret (?:put|delete)|d1 migrations apply/iu);

    for (const call of fixture.calls) {
      expect(call.env.CI).toBe('1');
      expect(call.env.WRANGLER_SEND_METRICS).toBe('false');
      expect(call.env.CLOUDFLARE_VITE_FORCE_LOCAL).toBe('true');
      const keys = Object.keys(call.env);
      expect(keys.some((key) => /^vite_/iu.test(key))).toBe(false);
      expect(keys.some((key) => /cloudflare.*(?:token|key|account)|(?:token|secret|password|cookie|authorization)/iu.test(key))).toBe(false);
      expect(call.env.SESSION_HMAC_KEY).toBeUndefined();
      expect(call.env.TOKEN_HMAC_KEY).toBeUndefined();
      expect(call.env.OPENAI_API_KEY).toBeUndefined();
      expect(call.env.CANDIDARY_UNRELATED_VALUE).toBeUndefined();
      expect(call.env.NODE_PATH).toBeUndefined();
    }
    expect(fixture.calls[9]!.env.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe(fixture.playwrightReport);
  });

  it('ignores a relative npm_execpath even when it names a regular npm-cli.js', async () => {
    const fixture = await createInnerFixture();
    const fakeRoot = await temporaryRoot();
    const fakeNpmCli = resolve(fakeRoot, 'npm-cli.js');
    await writeFile(fakeNpmCli, '// caller-controlled npm CLI\n', 'utf8');
    const original = process.env.npm_execpath;
    process.env.npm_execpath = relative(process.cwd(), fakeNpmCli);
    try {
      await runCandidate(fixture.request, fixture.adapters);
    } finally {
      if (original === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = original;
    }
    expect(fixture.calls[0]!.args[0]).not.toBe(fakeNpmCli);
  });

  it.each([
    ['attached HEAD', { attachedInitial: true }, 'initial_head_not_detached'],
    ['wrong SHA', { initialHead: 'c'.repeat(40) }, 'initial_head_sha_mismatch'],
    ['wrong tree', { initialTree: 'd'.repeat(40) }, 'initial_head_tree_mismatch'],
    ['tracked dirt', { initialStatus: ' M worker/app.ts\n' }, 'initial_status_not_clean'],
  ] as const)('fails closed on initial %s', async (_label, options, observation) => {
    const fixture = await createInnerFixture(options);
    const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
    assertRedactedCandidateManifest(manifest);
    expect(manifest).toMatchObject({
      status: 'failed',
      failureCode: 'precondition_failed',
      preconditionObservation: observation,
      claims: { localAutomated: 'failed' },
    });
    expect(fixture.calls).toHaveLength(0);
  });

  it.each([
    ['clean HEAD move', { finalHead: 'e'.repeat(40) }],
    ['final tree move', { finalTree: 'f'.repeat(40) }],
    ['final tracked drift', { finalStatus: ' M worker/app.ts\n' }],
    ['new nonignored output', { finalStatus: '?? unexpected.txt\n' }],
    ['final attached HEAD', { finalAttached: true }],
  ] as const)('records status_drift for %s after all commands', async (_label, options) => {
    const fixture = await createInnerFixture(options);
    const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
    assertRedactedCandidateManifest(manifest);
    expect(manifest.failureCode).toBe('status_drift');
    expect(manifest.commands.every(({ status }) => status === 'passed')).toBe(true);
  });

  it.each(['unit-ui', 'worker', 'playwright'] as const)(
    'preserves command_failed:%s when the failed command leaves a missing report',
    async (id) => {
      const fixture = await createInnerFixture({ failCommand: id, missingReport: id });
      const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
      assertRedactedCandidateManifest(manifest);
      expect(manifest.failureCode).toBe(`command_failed:${id}`);
      expect(manifest.failureObservation).toBeNull();
      expect(manifest.tests[id === 'unit-ui' ? 'unitUi' : id]).toBeNull();
      const failedIndex = manifest.commands.findIndex((command) => command.id === id);
      expect(manifest.commands[failedIndex]!.status).toBe('failed');
      expect(manifest.commands.slice(failedIndex + 1).every(({ status }) => status === 'not_run')).toBe(true);
    },
  );

  it.each(['unit-ui', 'worker', 'playwright'] as const)(
    'does not relabel command_failed:%s when the failed command leaves invalid JSON',
    async (id) => {
      const fixture = await createInnerFixture({ failCommand: id, invalidReport: id });
      const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
      assertRedactedCandidateManifest(manifest);
      expect(manifest.failureCode).toBe(`command_failed:${id}`);
      expect(manifest.failureObservation).toBeNull();
      expect(manifest.tests[id === 'unit-ui' ? 'unitUi' : id]).toBeNull();
    },
  );

  it.each([
    ['unit-ui', 'unit_report_missing_or_invalid'],
    ['worker', 'worker_report_missing_or_invalid'],
    ['playwright', 'playwright_report_missing_or_invalid'],
  ] as const)('maps a zero-exit invalid %s report to one evidence observation', async (id, observation) => {
    const fixture = await createInnerFixture({ invalidReport: id });
    const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
    assertRedactedCandidateManifest(manifest);
    expect(manifest.failureCode).toBe('evidence_invalid');
    expect(manifest.failureObservation).toBe(observation);
    expect(manifest.tests[id === 'unit-ui' ? 'unitUi' : id]).toBeNull();
  });

  it('records exact Vitest, Playwright, migration, and local Wrangler evidence', async () => {
    const fixture = await createInnerFixture();
    const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
    assertRedactedCandidateManifest(manifest);
    expect(manifest.tests).toEqual({
      unitUi: { total: 4, passed: 3, failed: 0, skipped: 1, flaky: 0 },
      worker: { total: 3, passed: 3, failed: 0, skipped: 0, flaky: 0 },
      playwright: { total: 10, passed: 8, failed: 0, skipped: 2, flaky: 1 },
    });
    expect(manifest.migrations?.verification).toEqual(migrationVerification);
    expect(manifest.execution.tools.wrangler).toBe('4.113.0');
    expect(manifest.candidate?.migrationManifestSha256).toBe(fixture.migrationDigest);
  });

  it.each([
    ['artifact drift', { artifactDrift: true }, 'artifact_drift', null],
    ['binding drift', { bindingDrift: true }, 'binding_drift', null],
    ['dry-run mismatch', { dryRunMismatch: true }, 'artifact_drift', null],
    ['unexpected dry-run file', { dryRunExtraFile: true }, 'evidence_invalid', 'artifact_collection_invalid'],
    ['missing Worker identity', { workerIdentityMissing: true }, 'evidence_invalid', 'worker_identity_literal_missing'],
    ['unreplaced Worker global', { workerGlobalUnreplaced: true }, 'evidence_invalid', 'worker_identity_global_unreplaced'],
    ['client identity leak', { clientIdentityLeak: true }, 'evidence_invalid', 'client_identity_leak'],
    ['Worker secret file', { forbiddenSecretAt: 'worker' }, 'evidence_invalid', 'forbidden_secret_file'],
    ['client secret file', { forbiddenSecretAt: 'client' }, 'evidence_invalid', 'forbidden_secret_file'],
    ['dry-run secret file', { forbiddenSecretAt: 'dry-run' }, 'evidence_invalid', 'forbidden_secret_file'],
    ['linked Wrangler directory', { wranglerLinkEscape: true }, 'evidence_invalid', 'tool_version_invalid'],
    ['linked dry-run directory', { dryRunLinkEscape: true }, 'evidence_invalid', 'artifact_collection_invalid'],
    ['invalid migration result', { invalidMigrationReport: true }, 'evidence_invalid', 'migration_verification_invalid'],
    ['missing generated binding types', { generatedTypesMissing: true }, 'evidence_invalid', 'binding_collection_invalid'],
  ] as const)('maps %s deterministically', async (_label, options, failureCode, observation) => {
    const fixture = await createInnerFixture(options);
    const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
    assertRedactedCandidateManifest(manifest);
    expect(manifest.failureCode).toBe(failureCode);
    expect(manifest.failureObservation).toBe(observation);
  });

  it('validates explicit full commit IDs, the approved ancestry, run-root layout, and UUID', async () => {
    const fixture = await createInnerFixture();
    for (const request of [
      { ...fixture.request, candidateSha: 'abc' },
      { ...fixture.request, candidateSha: 'HEAD' },
      { ...fixture.request, approvedBaseSha: 'c'.repeat(40) },
      { ...fixture.request, runId: 'not-a-uuid' },
      { ...fixture.request, runId: '223e4567-e89b-12d3-a456-426614174000' },
      { ...fixture.request, candidateRoot: fixture.request.callerRoot },
    ]) {
      await expect(runCandidate(request, fixture.adapters)).rejects.toThrow();
    }
  });

  it('returns candidate_identity_unavailable when inner candidate identity cannot be established', async () => {
    const fixture = await createInnerFixture();
    const originalGit = fixture.adapters.git.bind(fixture.adapters);
    fixture.adapters.git = async (args, cwd) => args[0] === 'rev-parse'
      && args[2] === `${CANDIDATE_SHA}^{commit}`
      ? { exitCode: 1, stdout: '' }
      : originalGit(args, cwd);
    const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
    assertRedactedCandidateManifest(manifest);
    expect(manifest).toMatchObject({
      status: 'failed',
      failureCode: 'precondition_failed',
      preconditionObservation: 'candidate_identity_unavailable',
      candidate: null,
    });
    expect(fixture.calls).toHaveLength(0);
  });

  it('returns status_drift when the final Git state cannot be read', async () => {
    const fixture = await createInnerFixture();
    const originalGit = fixture.adapters.git.bind(fixture.adapters);
    let statusReads = 0;
    fixture.adapters.git = async (args, cwd) => {
      if (args[0] === 'status' && statusReads++ === 1) throw new Error('simulated final status failure');
      return originalGit(args, cwd);
    };
    const manifest = finalizeCandidateManifest(await runCandidate(fixture.request, fixture.adapters), true);
    assertRedactedCandidateManifest(manifest);
    expect(manifest.failureCode).toBe('status_drift');
    expect(manifest.execution.finalStatusSha256).toBeNull();
  });

  it.each([
    'unit-report.json',
    'worker-report.json',
    'playwright-report.json',
    'migration-verification.json',
    'wrangler-dry-run/existing.txt',
  ])('rejects a pre-existing candidate evidence target %s before running commands', async (path) => {
    const fixture = await createInnerFixture();
    await put(fixture.request.runRoot, path, 'caller-owned\n');
    await expect(runCandidate(fixture.request, fixture.adapters)).rejects.toThrow(/already exists/iu);
    expect(fixture.calls).toHaveLength(0);
  });

  it('finalizes cleanup exactly once and lets cleanup failure supersede an otherwise valid result', async () => {
    const fixture = await createInnerFixture();
    const draft = await runCandidate(fixture.request, fixture.adapters);
    expect(draft.manifest.execution.cleanupSucceeded).toBeNull();

    const passed = finalizeCandidateManifest(draft, true);
    assertRedactedCandidateManifest(passed);
    expect(passed.status).toBe('passed');
    expect(passed.execution.cleanupSucceeded).toBe(true);

    const cleanupFailed = finalizeCandidateManifest(draft, false);
    assertRedactedCandidateManifest(cleanupFailed);
    expect(cleanupFailed).toMatchObject({
      status: 'failed',
      failureCode: 'cleanup_failed',
      failureObservation: null,
      preconditionObservation: null,
      execution: { cleanupSucceeded: false },
      claims: { localAutomated: 'failed' },
    });
    expect(() => finalizeCandidateManifest({ manifest: passed }, true)).toThrow(/finalized/iu);
  });
});

describe('release finalization and evidence output', () => {
  const releaseArgs = ['--sha', CANDIDATE_SHA, '--base-sha', APPROVED_RELEASE_BASE_SHA] as const;

  async function executeFixture(
    innerOptions: InnerOptions = {},
    bootstrapOptions: Parameters<typeof bootstrapAdapters>[0] = {},
  ) {
    const callerRoot = await temporaryRoot();
    const candidateModule = await releaseModuleFixture(innerOptions);
    const adapters = bootstrapAdapters({ ...bootstrapOptions, candidateModule });
    const result = await executeRelease(releaseArgs, callerRoot, adapters);
    return { callerRoot, adapters, result };
  }

  it('writes a passed manifest and exact digest only after successful cleanup', async () => {
    const { adapters, result } = await executeFixture();
    assertRedactedCandidateManifest(result.manifest);
    expect(result.manifest.status).toBe('passed');
    expect(result.manifest.execution.cleanupSucceeded).toBe(true);
    expect(result.manifest.claims).toEqual({
      localAutomated: 'passed',
      remoteMigration: 'not_run',
      deployment: 'not_run',
      physicalDevices: 'not_run',
      runtimeCertification: 'not_run',
    });
    const bytes = await readFile(result.manifestPath, 'utf8');
    expect(bytes).toBe(`${independentCanonical(result.manifest)}\n`);
    expect(result.digest).toBe(independentSha(bytes));
    expect(await readFile(result.sidecarPath, 'utf8')).toBe(
      `${result.digest}  candidate-manifest.json\n`,
    );
    await expect(lstat(result.runRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(adapters.runRootRemovals).toEqual([result.runRoot]);
    expect(adapters.calls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'remove'))
      .toEqual([{
        args: ['worktree', 'remove', '--force', resolve(result.runRoot, 'worktree')],
        cwd: expect.any(String),
      }]);
    expect(adapters.calls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'list'))
      .toHaveLength(1);
  });

  it.each([
    ['precondition_failed', { attachedInitial: true }, 'precondition_failed'],
    ['command_failed', { failCommand: 'lint' }, 'command_failed:lint'],
    ['evidence_invalid', { invalidReport: 'unit-ui' }, 'evidence_invalid'],
    ['artifact_drift', { artifactDrift: true }, 'artifact_drift'],
    ['binding_drift', { bindingDrift: true }, 'binding_drift'],
    ['status_drift', { finalStatus: '?? drift.txt\n' }, 'status_drift'],
  ] as const)('writes schema-valid %s evidence after the safe-output boundary', async (
    _label,
    innerOptions,
    failureCode,
  ) => {
    const { callerRoot, result } = await executeFixture(innerOptions);
    assertRedactedCandidateManifest(result.manifest);
    expect(result.manifest.status).toBe('failed');
    expect(result.manifest.failureCode).toBe(failureCode);
    expect(result.manifest.execution.cleanupSucceeded).toBe(true);
    expect(result.manifest.claims.remoteMigration).toBe('not_run');
    expect(result.manifest.claims.deployment).toBe('not_run');
    expect(result.manifest.claims.physicalDevices).toBe('not_run');
    expect(result.manifest.claims.runtimeCertification).toBe('not_run');
    expect(() => runDeployRelease({
      candidateRoot: callerRoot,
      sha: CANDIDATE_SHA,
      manifestPath: result.manifestPath,
    })).toThrow(/complete passed candidate/iu);
  });

  it.each([
    ['Git removal failure', { cleanupFailure: true }, 0],
    ['stale worktree registry', { registryStale: true }, 0],
    ['run-root removal failure', { runRootRemovalFailure: true }, 1],
  ] as const)('emits cleanup_failed and preserves the temp root for %s', async (
    _label,
    bootstrapOptions,
    expectedRunRootRemovals,
  ) => {
    const callerRoot = await temporaryRoot();
    const callerOwned = resolve(callerRoot, 'caller-dirty.txt');
    await writeFile(callerOwned, 'preserve\n', 'utf8');
    const adapters = bootstrapAdapters({
      ...bootstrapOptions,
      candidateModule: await releaseModuleFixture(),
    });
    const result = await executeRelease(releaseArgs, callerRoot, adapters);
    assertRedactedCandidateManifest(result.manifest);
    expect(result.manifest.failureCode).toBe('cleanup_failed');
    expect(result.manifest.execution.cleanupSucceeded).toBe(false);
    expect((await lstat(result.runRoot)).isDirectory()).toBe(true);
    expect(adapters.runRootRemovals).toHaveLength(expectedRunRootRemovals);
    expect(JSON.stringify(adapters.calls.map(({ args }) => args))).not.toContain(callerOwned);
    expect(adapters.calls.flatMap(({ args }) => args).some((arg) => /^(?:stash|reset|clean)$/u.test(arg))).toBe(false);
    expect(await readFile(callerOwned, 'utf8')).toBe('preserve\n');
    roots.push(result.runRoot);
  });

  it.each([
    ['attached initial HEAD', { attachedInitial: true }],
    ['unavailable candidate identity', { candidateIdentityUnavailable: true }],
  ] as const)('lets cleanup failure supersede %s without losing schema validity', async (
    _label,
    innerOptions,
  ) => {
    const { result } = await executeFixture(innerOptions, { cleanupFailure: true });
    assertRedactedCandidateManifest(result.manifest);
    expect(result.manifest.failureCode).toBe('cleanup_failed');
    expect(result.manifest.execution.cleanupSucceeded).toBe(false);
    roots.push(result.runRoot);
  });

  it('rejects an output reparse point before reserving a run or touching Git', async () => {
    const callerRoot = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, resolve(callerRoot, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
    const adapters = bootstrapAdapters({ candidateModule: await releaseModuleFixture() });
    await expect(executeRelease(releaseArgs, callerRoot, adapters)).rejects.toThrow(/output/iu);
    expect(adapters.generatedIds).toBe(0);
    expect(adapters.calls).toHaveLength(0);
  });

  it('revalidates output after import and cleans bootstrap state without evidence on a new reparse point', async () => {
    const callerRoot = await temporaryRoot();
    const outside = await temporaryRoot();
    const adapters = bootstrapAdapters({
      candidateModule: await releaseModuleFixture(),
      async onImport() {
        await symlink(outside, resolve(callerRoot, 'output'), process.platform === 'win32' ? 'junction' : 'dir');
      },
    });
    await expect(executeRelease(releaseArgs, callerRoot, adapters)).rejects.toThrow(/bootstrap_failed/iu);
    expect(adapters.statuses).toEqual(['bootstrap_failed']);
    expect(adapters.calls.some(({ args }) => args[0] === 'worktree' && args[1] === 'remove')).toBe(true);
    expect(await readdir(outside)).toEqual([]);
  });

  it('creates the UUID output directory exclusively and refuses an existing run', async () => {
    const callerRoot = await temporaryRoot();
    const collisionRoot = resolve(callerRoot, 'output/release', CANDIDATE_SHA, RUN_ID);
    await mkdir(collisionRoot, { recursive: true });
    await writeFile(resolve(collisionRoot, 'caller-owned.txt'), 'preserve\n', 'utf8');
    const adapters = bootstrapAdapters({ candidateModule: await releaseModuleFixture() });
    await expect(executeRelease(releaseArgs, callerRoot, adapters)).rejects.toThrow(/bootstrap_failed/iu);
    expect(await readFile(resolve(collisionRoot, 'caller-owned.txt'), 'utf8')).toBe('preserve\n');
    await expect(readFile(resolve(collisionRoot, 'candidate-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes canonical bytes through exclusive temporary files and refuses overwrite', async () => {
    const callerRoot = await temporaryRoot();
    const outputDirectory = resolve(callerRoot, 'output/release', CANDIDATE_SHA, RUN_ID);
    await mkdir(outputDirectory, { recursive: true });
    const candidateModule = await releaseModuleFixture();
    const draft = await candidateModule.runCandidate({
      callerRoot,
      candidateRoot: callerRoot,
      runRoot: callerRoot,
      runId: RUN_ID,
      candidateSha: CANDIDATE_SHA,
      approvedBaseSha: APPROVED_RELEASE_BASE_SHA,
    });
    const manifest = candidateModule.finalizeCandidateManifest(draft, true);
    const written = await writeCandidateEvidence(outputDirectory, manifest);
    expect((await readdir(outputDirectory)).sort()).toEqual([
      'candidate-manifest.json',
      'candidate-manifest.json.sha256',
    ]);
    const bytes = await readFile(written.manifestPath, 'utf8');
    expect(bytes).toBe(`${independentCanonical(manifest)}\n`);
    expect(written.digest).toBe(independentSha(bytes));
    expect(await readFile(written.sidecarPath, 'utf8')).toBe(
      `${written.digest}  candidate-manifest.json\n`,
    );
    await expect(writeCandidateEvidence(outputDirectory, manifest)).rejects.toThrow(/already exists/iu);
    expect(await readFile(written.manifestPath, 'utf8')).toBe(bytes);
  });

  it('refuses to publish through an output-chain reparse point introduced after reservation', async () => {
    const callerRoot = await temporaryRoot();
    const outsideOutput = await temporaryRoot();
    const outsideRun = resolve(outsideOutput, 'release', CANDIDATE_SHA, RUN_ID);
    await mkdir(outsideRun, { recursive: true });
    await symlink(
      outsideOutput,
      resolve(callerRoot, 'output'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const candidateModule = await releaseModuleFixture();
    const draft = await candidateModule.runCandidate({
      callerRoot,
      candidateRoot: callerRoot,
      runRoot: callerRoot,
      runId: RUN_ID,
      candidateSha: CANDIDATE_SHA,
      approvedBaseSha: APPROVED_RELEASE_BASE_SHA,
    });
    const manifest = candidateModule.finalizeCandidateManifest(draft, true);
    await expect(writeCandidateEvidence(
      resolve(callerRoot, 'output/release', CANDIDATE_SHA, RUN_ID),
      manifest,
    )).rejects.toThrow(/output/iu);
    expect(await readdir(outsideRun)).toEqual([]);
  });

  it('exposes the E2E typecheck and immutable release commands without running them', async () => {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['typecheck:e2e']).toBe('tsc -p tsconfig.e2e.json --pretty false');
    expect(packageJson.scripts['verify:release']).toBe('node --experimental-strip-types scripts/verify-release.ts');
  });
});

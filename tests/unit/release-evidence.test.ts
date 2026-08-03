// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertRedactedCandidateManifest,
  canonicalJson,
  collectDeployableArtifacts,
  collectMigrationManifest,
  normalizedBindingTopology,
  parsePlaywrightReport,
  parseVitestReport,
  releaseBuildSha,
  sha256,
  type BindingTopology,
  type CandidateManifest,
  type CommandResult,
  type ReleaseCommandId,
  type ToolVersions,
} from '../../scripts/release-evidence';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'candidary-release-evidence-'));
  roots.push(root);
  return root;
}

async function put(root: string, path: string, contents: string | Uint8Array): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function independentCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(independentCanonical).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${independentCanonical(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('fixture is not JSON');
}

function independentSha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const commandIds = [
  'npm-ci',
  'verify-bindings',
  'typecheck',
  'typecheck-e2e',
  'lint',
  'unit-ui',
  'worker',
  'build',
  'pwa-before-e2e',
  'playwright',
  'pwa-after-e2e',
  'wrangler-dry-run',
  'fresh-d1',
  'diff-check',
] as const satisfies readonly ReleaseCommandId[];

const passedCommand = <Id extends ReleaseCommandId>(id: Id): CommandResult<Id> => ({
  id,
  status: 'passed',
  startedAt: '2026-08-03T00:00:00.000Z',
  finishedAt: '2026-08-03T00:00:01.000Z',
  durationMs: 1_000,
  exitCode: 0,
});

const toolVersions: ToolVersions = {
  node: 'v24.16.0',
  npm: '11.13.0',
  git: '2.50.1',
  typescript: '5.9.3',
  eslint: '9.39.2',
  vite: '7.3.1',
  vitest: '4.1.10',
  playwright: '1.61.1',
  wrangler: '4.67.0',
};

const topology: BindingTopology = {
  compatibilityDate: '2026-07-21',
  compatibilityFlags: ['nodejs_compat'],
  workersDev: true,
  assets: {
    binding: 'ASSETS',
    notFoundHandling: 'single-page-application',
    runWorkerFirst: ['/api/*', '/manage/*'],
  },
  bindings: {
    d1: ['DB'],
    r2: ['MEDIA_BUCKET'],
    images: ['IMAGES'],
    sendEmail: ['EMAIL'],
    versionMetadata: null,
  },
  requiredSecrets: ['SESSION_HMAC_KEY', 'TOKEN_HMAC_KEY'],
  variableNames: ['APP_ORIGIN'],
  workflows: [{ binding: 'EXPORT_WORKFLOW', className: 'ExportWorkflow' }],
  rateLimits: [{ name: 'HOST_AUTH_RATE_LIMIT', limit: 20, period: 60 }],
  crons: ['17 3 * * *'],
  migrationDirectories: ['migrations'],
  observabilityEnabled: true,
};

function passedManifest(): CandidateManifest {
  const migrationFile = {
    path: 'migrations/0001_initial.sql',
    bytes: 12,
    sha256: 'c'.repeat(64),
  };
  const migrationDigest = independentSha(
    independentCanonical([{ path: migrationFile.path, sha256: migrationFile.sha256 }]),
  );
  const worker = { path: 'dist/candidary/index.js', bytes: 20, sha256: 'd'.repeat(64) };
  const client = [{ path: 'dist/client/index.html', bytes: 30, sha256: 'e'.repeat(64) }];
  const artifactDigest = independentSha(independentCanonical({ worker, client }));
  const topologyDigest = independentSha(independentCanonical(topology));
  const gitSha = 'a'.repeat(40);
  const gitTree = 'b'.repeat(40);

  return {
    kind: 'candidary.release-candidate',
    schemaVersion: 1,
    status: 'passed',
    failureCode: null,
    failureObservation: null,
    preconditionObservation: null,
    runId: '123e4567-e89b-42d3-a456-426614174000',
    candidate: {
      gitSha,
      approvedBaseSha: '0b92387d2e237d568d2514373dcc3044e7960d4b',
      gitTree,
      guestJourneyVersion: 1,
      migrationManifestSha256: migrationDigest,
      packageLockSha256: '1'.repeat(64),
      sourceWranglerConfigSha256: '2'.repeat(64),
    },
    execution: {
      startedAt: '2026-08-03T00:00:00.000Z',
      finishedAt: '2026-08-03T00:01:00.000Z',
      platform: 'win32',
      arch: 'x64',
      initialDetachedHead: true,
      initialHeadSha: gitSha,
      initialHeadTree: gitTree,
      initialStatusSha256: independentSha(''),
      finalDetachedHead: true,
      finalHeadSha: gitSha,
      finalHeadTree: gitTree,
      finalStatusSha256: independentSha(''),
      cleanupSucceeded: true,
      tools: { ...toolVersions },
    },
    commands: commandIds.map(passedCommand) as CandidateManifest['commands'],
    tests: {
      unitUi: { total: 10, passed: 9, failed: 0, skipped: 1, flaky: 1 },
      worker: { total: 5, passed: 5, failed: 0, skipped: 0, flaky: 0 },
      playwright: { total: 4, passed: 3, failed: 0, skipped: 1, flaky: 1 },
    },
    migrations: {
      manifest: [migrationFile],
      verification: {
        migrationCount: 1,
        ledgerSha256: independentSha(independentCanonical(['0001_initial.sql'])),
        foreignKeyRows: 0,
        integrity: 'ok',
        terminalSchema: {
          events: true,
          rosterBatchReceipts: true,
          releaseCertifications: true,
        },
      },
    },
    bindings: {
      topology: structuredClone(topology),
      sourceTopologySha256: topologyDigest,
      firstBuildTopologySha256: topologyDigest,
      secondBuildTopologySha256: topologyDigest,
      generatedTypesSha256: '3'.repeat(64),
    },
    artifacts: {
      worker,
      client,
      firstTreeSha256: artifactDigest,
      secondTreeSha256: artifactDigest,
      dryRunWorkerSha256: worker.sha256,
    },
    claims: {
      localAutomated: 'passed',
      remoteMigration: 'not_run',
      deployment: 'not_run',
      physicalDevices: 'not_run',
      runtimeCertification: 'not_run',
    },
  };
}

function expectInvalid(value: unknown): void {
  expect(() => assertRedactedCandidateManifest(value)).toThrow();
}

describe('canonical evidence hashing', () => {
  it('sorts nested object keys, preserves array order, and hashes exact bytes', () => {
    const first = { z: [{ b: 2, a: 1 }], a: true };
    const reordered = { a: true, z: [{ a: 1, b: 2 }] };
    expect(canonicalJson(first)).toBe(independentCanonical(reordered));
    expect(sha256(canonicalJson(first))).toBe(independentSha(independentCanonical(first)));
    expect(canonicalJson({ value: [1, 2] })).not.toBe(canonicalJson({ value: [2, 1] }));
    expect(sha256(new Uint8Array([0, 255, 10]))).toBe(independentSha(new Uint8Array([0, 255, 10])));
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1n,
    () => undefined,
    new Date('2026-08-03T00:00:00.000Z'),
    Object.assign(Object.create(null) as Record<string, unknown>, { ok: true }),
  ])('fails closed for non-JSON input %#', (value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it('rejects cycles and sparse arrays', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sparse = Array.from({ length: 2 }) as unknown[];
    delete sparse[0];
    expect(() => canonicalJson(cycle)).toThrow();
    expect(() => canonicalJson(sparse)).toThrow();

    const accessor = [1];
    Object.defineProperty(accessor, '0', { enumerable: true, get: () => 1 });
    expect(() => canonicalJson(accessor)).toThrow();

    const symbolKey = [1] as unknown[] & { [key: symbol]: string };
    symbolKey[Symbol('hidden')] = 'secret';
    expect(() => canonicalJson(symbolKey)).toThrow();

    const nonPlain = [1];
    Object.setPrototypeOf(nonPlain, null);
    expect(() => canonicalJson(nonPlain)).toThrow();
  });
});

describe('migration manifests', () => {
  it('sorts a gap-free sequence and changes only when exact bytes change', async () => {
    const root = await temporaryRoot();
    await put(root, 'migrations/0002_add_table.sql', 'two\r\n');
    await put(root, 'migrations/0001_initial.sql', new Uint8Array([0xef, 0xbb, 0xbf, 0x31]));

    const first = collectMigrationManifest(root);
    expect(first.files.map((file) => file.path)).toEqual([
      'migrations/0001_initial.sql',
      'migrations/0002_add_table.sql',
    ]);
    expect(first.files[0]?.bytes).toBe(4);
    expect(first.sha256).toBe(
      independentSha(
        independentCanonical(first.files.map(({ path, sha256: digest }) => ({ path, sha256: digest }))),
      ),
    );

    await put(root, 'migrations/0002_add_table.sql', 'twO\r\n');
    expect(collectMigrationManifest(root).sha256).not.toBe(first.sha256);
  });

  it.each([
    ['0001_initial.sql', '0003_gap.sql'],
    ['0001_initial.sql', '0001_duplicate.sql'],
    ['0001_INITIAL.sql'],
    ['001_initial.sql'],
    ['0000_initial.sql'],
    ['0001_initial.SQL'],
  ])('rejects invalid migration inventories %#', async (...names: string[]) => {
    const root = await temporaryRoot();
    for (const name of names) await put(root, `migrations/${name}`, 'select 1;');
    expect(() => collectMigrationManifest(root)).toThrow();
  });
});

describe('deployable artifacts', () => {
  async function validBuild(): Promise<string> {
    const root = await temporaryRoot();
    await put(
      root,
      'dist/candidary/wrangler.json',
      JSON.stringify({ main: 'chunks\\worker.js', assets: { directory: '../client' } }),
    );
    await put(root, 'dist/candidary/chunks/worker.js', new Uint8Array([1, 2, 3]));
    await put(root, 'dist/client/index.html', '<main>ok</main>');
    await put(root, 'dist/client/assets/app.js', 'ok');
    return root;
  }

  it('normalizes logical paths and hashes a deterministic worker/client tree', async () => {
    const root = await validBuild();
    const first = collectDeployableArtifacts(root);
    expect(first.worker.path).toBe('dist/candidary/chunks/worker.js');
    expect(first.client.map((file) => file.path)).toEqual([
      'dist/client/assets/app.js',
      'dist/client/index.html',
    ]);
    expect(first.treeSha256).toBe(
      independentSha(independentCanonical({ worker: first.worker, client: first.client })),
    );
    await put(root, 'dist/client/assets/app.js', 'oK');
    expect(collectDeployableArtifacts(root).treeSha256).not.toBe(first.treeSha256);
  });

  it.each([
    { main: '../../outside.js', assets: { directory: '../client' } },
    { main: 'C:\\outside.js', assets: { directory: '../client' } },
    { main: '/outside.js', assets: { directory: '../client' } },
    { main: 'wrangler.json', assets: { directory: '../client' } },
    { main: 'index.js', assets: { directory: '../../client-evil' } },
  ])('rejects paths outside approved build roots %#', async (config) => {
    const root = await temporaryRoot();
    await put(root, 'dist/candidary/wrangler.json', JSON.stringify(config));
    await put(root, 'dist/candidary/index.js', 'worker');
    await put(root, 'outside.js', 'outside');
    await put(root, 'dist/client/index.html', 'client');
    await put(root, 'dist/client-evil/index.html', 'evil');
    expect(() => collectDeployableArtifacts(root)).toThrow();
  });

  it('rejects forbidden secret files and symlink escapes', async () => {
    const root = await validBuild();
    await put(root, 'dist/client/assets/.env.production', 'SECRET=value');
    expect(() => collectDeployableArtifacts(root)).toThrow();
    await rm(join(root, 'dist/client/assets/.env.production'));

    await put(root, 'outside.txt', 'outside');
    const link = join(root, 'dist/client/assets/linked.txt');
    try {
      await symlink(join(root, 'outside.txt'), link, 'file');
      expect(() => collectDeployableArtifacts(root)).toThrow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });
});

describe('binding topology', () => {
  it('normalizes set-like fields and excludes resource values and path spellings', () => {
    const source = {
      compatibility_date: '2026-07-21',
      compatibility_flags: ['nodejs_compat', 'nodejs_compat'],
      workers_dev: true,
      assets: {
        binding: 'ASSETS',
        not_found_handling: 'single-page-application',
        run_worker_first: ['/manage/*', '/api/*', '/api/*'],
      },
      d1_databases: [
        { binding: 'DB', database_name: 'secret-name', database_id: 'secret-id', migrations_dir: 'migrations' },
      ],
      r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'secret-bucket' }],
      images: { binding: 'IMAGES' },
      send_email: [{ name: 'EMAIL' }],
      version_metadata: { binding: 'WORKER_VERSION' },
      secrets: { required: ['TOKEN_HMAC_KEY', 'TOKEN_HMAC_KEY'] },
      vars: { APP_ORIGIN: 'https://secret.example', PRIVATE_VALUE: 'do-not-record' },
      workflows: [{ binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow', name: 'secret-name' }],
      ratelimits: [{ name: 'AUTH', namespace_id: 'secret-id', simple: { limit: 20, period: 60 } }],
      triggers: { crons: ['47 * * * *', '17 3 * * *'] },
      observability: { enabled: true },
    };
    const generated = structuredClone(source);
    generated.d1_databases[0]!.database_name = 'different';
    generated.d1_databases[0]!.database_id = 'different-id';
    generated.d1_databases[0]!.migrations_dir = '../../migrations';
    generated.r2_buckets[0]!.bucket_name = 'different';
    generated.vars.APP_ORIGIN = 'https://different.invalid';
    generated.workflows[0]!.name = 'different';
    generated.ratelimits[0]!.namespace_id = 'different';

    const normalized = normalizedBindingTopology(source);
    expect(normalizedBindingTopology(generated)).toEqual(normalized);
    expect(normalized.assets.runWorkerFirst).toEqual(['/api/*', '/manage/*']);
    expect(normalized.compatibilityFlags).toEqual(['nodejs_compat']);
    expect(normalized.variableNames).toEqual(['APP_ORIGIN', 'PRIVATE_VALUE']);
    expect(canonicalJson(normalized)).not.toContain('secret');
    expect(canonicalJson(normalized)).not.toContain('https://');
  });

  it('detects topology changes and rejects malformed or absolute migration semantics', () => {
    const base = {
      compatibility_date: '2026-07-21',
      workers_dev: true,
      assets: { binding: 'ASSETS', not_found_handling: '404-page', run_worker_first: [] },
      d1_databases: [{ binding: 'DB', migrations_dir: 'migrations' }],
      observability: { enabled: true },
    };
    const changed = structuredClone(base);
    changed.d1_databases[0]!.binding = 'OTHER_DB';
    expect(normalizedBindingTopology(changed)).not.toEqual(normalizedBindingTopology(base));
    expect(() => normalizedBindingTopology({ ...base, workers_dev: 'true' })).toThrow();
    expect(() =>
      normalizedBindingTopology({
        ...base,
        d1_databases: [{ binding: 'DB', migrations_dir: 'C:\\repo\\migrations' }],
      }),
    ).toThrow();
    expect(() =>
      normalizedBindingTopology({
        ...base,
        d1_databases: [{ binding: 'DB', migrations_dir: '../../../migrations' }],
      }),
    ).toThrow();
  });
});

describe('test report parsers', () => {
  it('parses Vitest aggregates and normalized focused file paths without coercion', () => {
    const report = {
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 1,
      numTodoTests: 1,
      numTotalTests: 5,
      numTotalTestSuites: 3,
      numPassedTestSuites: 2,
      numFailedTestSuites: 1,
      numPendingTestSuites: 0,
      success: false,
      testResults: [
        {
          name: 'C:\\repo\\tests\\unit\\one.test.ts',
          assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'todo' }],
        },
        {
          name: '/repo/tests/unit/two.test.ts',
          assertionResults: [{ status: 'passed' }, { status: 'failed' }],
        },
      ],
    };
    expect(parseVitestReport(report)).toEqual({ total: 5, passed: 2, failed: 1, skipped: 2, flaky: 0 });
    expect(parseVitestReport(report, /tests\/unit\/one\.test\.ts/g)).toEqual({
      total: 3,
      passed: 1,
      failed: 0,
      skipped: 2,
      flaky: 0,
    });
    expect(parseVitestReport(report, /does-not-match/y)).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      flaky: 0,
    });
    expect(() => parseVitestReport({ ...report, numPassedTests: '2' })).toThrow();
    expect(() => parseVitestReport({ ...report, numFailedTests: -1 })).toThrow();
    expect(() => parseVitestReport({ ...report, numTotalTests: undefined })).toThrow();
    expect(() => parseVitestReport({ ...report, numPassedTests: 3 }, /one\.test\.ts/)).toThrow();
  });

  it('maps Playwright authoritative stats without counting retries twice', () => {
    const report = {
      config: {},
      errors: [],
      stats: {
        startTime: '2026-08-03T00:00:00.000Z',
        duration: 1_669.929,
        expected: 7,
        unexpected: 2,
        flaky: 3,
        skipped: 4,
      },
      suites: [{ specs: [{ tests: [{ results: [{ status: 'failed' }, { status: 'passed' }] }] }] }],
    };
    expect(parsePlaywrightReport(report)).toEqual({
      total: 16,
      passed: 10,
      failed: 2,
      skipped: 4,
      flaky: 3,
    });
    expect(() => parsePlaywrightReport({
      config: {}, errors: [], suites: [],
      stats: { startTime: '2026-08-03T00:00:00.000Z', duration: 1, expected: 1, unexpected: 0, flaky: Number.NaN, skipped: 0 },
    })).toThrow();
    expect(() => parsePlaywrightReport({ ...report, errors: [{ message: 'collection failed' }] })).toThrow();
    expect(() => parsePlaywrightReport({ stats: report.stats })).toThrow();
    expect(() => parsePlaywrightReport({
      ...report,
      stats: {
        ...report.stats,
        expected: Number.MAX_SAFE_INTEGER,
        flaky: Number.MAX_SAFE_INTEGER,
      },
    })).toThrow();
    expect(() => parsePlaywrightReport({})).toThrow();
  });
});

describe('release build identity', () => {
  it('returns only a clean lowercase full SHA', () => {
    expect(releaseBuildSha('a'.repeat(40), '')).toBe('a'.repeat(40));
    expect(releaseBuildSha('A'.repeat(40), '')).toBe('');
    expect(releaseBuildSha('a'.repeat(39), '')).toBe('');
    expect(releaseBuildSha('a'.repeat(40), ' M file')).toBe('');
    expect(releaseBuildSha(null, '')).toBe('');
  });
});

describe('strict redacted candidate manifests', () => {
  it('accepts a complete internally consistent pass', () => {
    expect(() => assertRedactedCandidateManifest(passedManifest())).not.toThrow();
  });

  it('rejects one-field aggregate and equality tampering', () => {
    const mutations: Array<(manifest: CandidateManifest) => void> = [
      (manifest) => { manifest.candidate!.migrationManifestSha256 = 'f'.repeat(64); },
      (manifest) => { manifest.migrations!.verification.migrationCount = 2; },
      (manifest) => { manifest.migrations!.verification.ledgerSha256 = 'f'.repeat(64); },
      (manifest) => { manifest.bindings!.sourceTopologySha256 = 'f'.repeat(64); },
      (manifest) => { manifest.bindings!.secondBuildTopologySha256 = 'f'.repeat(64); },
      (manifest) => { manifest.artifacts!.firstTreeSha256 = 'f'.repeat(64); },
      (manifest) => { manifest.artifacts!.secondTreeSha256 = 'f'.repeat(64); },
      (manifest) => { manifest.artifacts!.dryRunWorkerSha256 = 'f'.repeat(64); },
      (manifest) => { manifest.tests.unitUi!.total += 1; },
      (manifest) => { manifest.tests.playwright!.flaky = 4; },
    ];
    for (const mutate of mutations) {
      const manifest = passedManifest();
      mutate(manifest);
      expectInvalid(manifest);
    }
  });

  it('rejects command tuple, pass-state, claim, ordering, and secret-bearing tampering', () => {
    const wrongOrder = passedManifest();
    const swapped = [...wrongOrder.commands] as CommandResult<ReleaseCommandId>[];
    const first = swapped[0]!;
    swapped[0] = swapped[1]!;
    swapped[1] = first;
    wrongOrder.commands = swapped as CandidateManifest['commands'];
    expectInvalid(wrongOrder);

    const skippedCommand = passedManifest();
    skippedCommand.commands[3] = {
      id: 'typecheck-e2e', status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null,
    };
    expectInvalid(skippedCommand);

    const remoteClaim = passedManifest();
    remoteClaim.claims.deployment = 'passed' as 'not_run';
    expectInvalid(remoteClaim);

    for (const key of ['stdout', 'stderr', 'env', 'secrets', 'tokens', 'notes']) {
      const unknown = passedManifest() as CandidateManifest & Record<string, unknown>;
      unknown[key] = 'safe-looking text';
      expectInvalid(unknown);
    }

    const leaked = passedManifest();
    leaked.execution.platform = 'https://example.invalid/token=abc';
    expectInvalid(leaked);

    const absolute = passedManifest();
    absolute.artifacts!.worker.path = 'C:\\secret\\worker.js';
    expectInvalid(absolute);

    const credentialPlatform = passedManifest();
    credentialPlatform.execution.platform = 'ghp_abcdefghijklmnopqrstuvwxyz';
    expectInvalid(credentialPlatform);

    const freeFormMode = passedManifest();
    freeFormMode.bindings!.topology.assets.notFoundHandling = 'Bearer ghp_abc123';
    const freeFormTopologyHash = independentSha(independentCanonical(freeFormMode.bindings!.topology));
    freeFormMode.bindings!.sourceTopologySha256 = freeFormTopologyHash;
    freeFormMode.bindings!.firstBuildTopologySha256 = freeFormTopologyHash;
    freeFormMode.bindings!.secondBuildTopologySha256 = freeFormTopologyHash;
    expectInvalid(freeFormMode);

    const secretShapedName = passedManifest();
    secretShapedName.bindings!.topology.requiredSecrets = ['sk_live_51ABCDEF12345678'];
    const secretTopologyHash = independentSha(independentCanonical(secretShapedName.bindings!.topology));
    secretShapedName.bindings!.sourceTopologySha256 = secretTopologyHash;
    secretShapedName.bindings!.firstBuildTopologySha256 = secretTopologyHash;
    secretShapedName.bindings!.secondBuildTopologySha256 = secretTopologyHash;
    expectInvalid(secretShapedName);

    const credentialPath = passedManifest();
    credentialPath.artifacts!.client[0]!.path = 'dist/client/\nBearer ghp_abc123.txt';
    const credentialTreeHash = independentSha(independentCanonical({
      worker: credentialPath.artifacts!.worker,
      client: credentialPath.artifacts!.client,
    }));
    credentialPath.artifacts!.firstTreeSha256 = credentialTreeHash;
    credentialPath.artifacts!.secondTreeSha256 = credentialTreeHash;
    expectInvalid(credentialPath);

    const hidden = passedManifest();
    Object.defineProperty(hidden, 'stdout', { value: 'secret', enumerable: false });
    expectInvalid(hidden);
  });

  it('enforces command failure, cleanup supersession, and relabel prevention', () => {
    const failed = passedManifest();
    failed.status = 'failed';
    failed.failureCode = 'command_failed:lint';
    failed.claims.localAutomated = 'failed';
    failed.commands = commandIds.map((id, index) => {
      if (index < 4) return passedCommand(id);
      if (index === 4) return {
        id,
        status: 'failed',
        startedAt: '2026-08-03T00:00:00.000Z',
        finishedAt: '2026-08-03T00:00:01.000Z',
        durationMs: 1_000,
        exitCode: 1,
      };
      return { id, status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null };
    }) as CandidateManifest['commands'];
    failed.tests = { unitUi: null, worker: null, playwright: null };
    failed.migrations = null;
    failed.bindings = null;
    failed.artifacts = null;
    expect(() => assertRedactedCandidateManifest(failed)).not.toThrow();

    for (const relabel of ['precondition_failed', 'evidence_invalid', 'artifact_drift', 'binding_drift', 'status_drift'] as const) {
      const invalid = structuredClone(failed);
      invalid.failureCode = relabel;
      if (relabel === 'evidence_invalid') invalid.failureObservation = 'unit_report_missing_or_invalid';
      if (relabel === 'precondition_failed') invalid.preconditionObservation = 'initial_head_not_detached';
      expectInvalid(invalid);
    }

    const cleanup = structuredClone(failed);
    cleanup.failureCode = 'cleanup_failed';
    cleanup.execution.cleanupSucceeded = false;
    expect(() => assertRedactedCandidateManifest(cleanup)).not.toThrow();

    const falseCleanupLabel = structuredClone(failed);
    falseCleanupLabel.failureCode = 'cleanup_failed';
    falseCleanupLabel.execution.cleanupSucceeded = true;
    expectInvalid(falseCleanupLabel);
  });

  it('ties nullable evidence bidirectionally to the command that produced it', () => {
    const reportWithoutCommand = passedManifest();
    reportWithoutCommand.status = 'failed';
    reportWithoutCommand.failureCode = 'evidence_invalid';
    reportWithoutCommand.failureObservation = 'unit_report_missing_or_invalid';
    reportWithoutCommand.claims.localAutomated = 'failed';
    reportWithoutCommand.commands = commandIds.map((id, index) => index < 5
      ? passedCommand(id)
      : { id, status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null }) as CandidateManifest['commands'];
    reportWithoutCommand.tests = { unitUi: null, worker: null, playwright: null };
    reportWithoutCommand.migrations = null;
    reportWithoutCommand.bindings = null;
    reportWithoutCommand.artifacts = null;
    expectInvalid(reportWithoutCommand);

    const missingPassedReport = passedManifest();
    missingPassedReport.status = 'failed';
    missingPassedReport.failureCode = 'artifact_drift';
    missingPassedReport.claims.localAutomated = 'failed';
    missingPassedReport.tests.unitUi = null;
    missingPassedReport.artifacts!.secondTreeSha256 = 'f'.repeat(64);
    expectInvalid(missingPassedReport);

    const failedCommandWithCounts = passedManifest();
    failedCommandWithCounts.status = 'failed';
    failedCommandWithCounts.failureCode = 'command_failed:unit-ui';
    failedCommandWithCounts.claims.localAutomated = 'failed';
    failedCommandWithCounts.commands = commandIds.map((id, index) => {
      if (index < 5) return passedCommand(id);
      if (index === 5) return {
        id,
        status: 'failed',
        startedAt: '2026-08-03T00:00:00.000Z',
        finishedAt: '2026-08-03T00:00:01.000Z',
        durationMs: 1_000,
        exitCode: 1,
      };
      return { id, status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null };
    }) as CandidateManifest['commands'];
    expectInvalid(failedCommandWithCounts);

    const missingToolRelabeled = passedManifest();
    missingToolRelabeled.status = 'failed';
    missingToolRelabeled.failureCode = 'artifact_drift';
    missingToolRelabeled.claims.localAutomated = 'failed';
    missingToolRelabeled.execution.tools.node = null;
    missingToolRelabeled.artifacts!.secondTreeSha256 = 'f'.repeat(64);
    expectInvalid(missingToolRelabeled);

    const missingBindingRelabeled = passedManifest();
    missingBindingRelabeled.status = 'failed';
    missingBindingRelabeled.failureCode = 'artifact_drift';
    missingBindingRelabeled.claims.localAutomated = 'failed';
    missingBindingRelabeled.bindings = null;
    missingBindingRelabeled.artifacts!.secondTreeSha256 = 'f'.repeat(64);
    expectInvalid(missingBindingRelabeled);

    const failedCountsBehindPassedCommand = passedManifest();
    failedCountsBehindPassedCommand.status = 'failed';
    failedCountsBehindPassedCommand.failureCode = 'artifact_drift';
    failedCountsBehindPassedCommand.claims.localAutomated = 'failed';
    failedCountsBehindPassedCommand.tests.unitUi = { total: 10, passed: 8, failed: 1, skipped: 1, flaky: 0 };
    failedCountsBehindPassedCommand.artifacts!.secondTreeSha256 = 'f'.repeat(64);
    expectInvalid(failedCountsBehindPassedCommand);

    const cleanupCannotMaskEvidence = passedManifest();
    cleanupCannotMaskEvidence.status = 'failed';
    cleanupCannotMaskEvidence.failureCode = 'cleanup_failed';
    cleanupCannotMaskEvidence.claims.localAutomated = 'failed';
    cleanupCannotMaskEvidence.execution.cleanupSucceeded = false;
    cleanupCannotMaskEvidence.execution.tools = {
      node: null, npm: null, git: null, typescript: null, eslint: null,
      vite: null, vitest: null, playwright: null, wrangler: null,
    };
    cleanupCannotMaskEvidence.tests = { unitUi: null, worker: null, playwright: null };
    cleanupCannotMaskEvidence.migrations = null;
    cleanupCannotMaskEvidence.bindings = null;
    cleanupCannotMaskEvidence.artifacts = null;
    expectInvalid(cleanupCannotMaskEvidence);

    const jwtVersion = passedManifest();
    jwtVersion.execution.tools.node = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature';
    expectInvalid(jwtVersion);

    const failedInstallWithDependencyTools = passedManifest();
    failedInstallWithDependencyTools.status = 'failed';
    failedInstallWithDependencyTools.failureCode = 'command_failed:npm-ci';
    failedInstallWithDependencyTools.claims.localAutomated = 'failed';
    failedInstallWithDependencyTools.commands = commandIds.map((id, index) => index === 0
      ? {
          id,
          status: 'failed',
          startedAt: '2026-08-03T00:00:00.000Z',
          finishedAt: '2026-08-03T00:00:01.000Z',
          durationMs: 1_000,
          exitCode: 1,
        }
      : { id, status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null }) as CandidateManifest['commands'];
    failedInstallWithDependencyTools.tests = { unitUi: null, worker: null, playwright: null };
    failedInstallWithDependencyTools.migrations = null;
    failedInstallWithDependencyTools.bindings = null;
    failedInstallWithDependencyTools.artifacts = null;
    expectInvalid(failedInstallWithDependencyTools);
  });

  it('keeps precondition and evidence observations disjoint and witnessed', () => {
    const precondition = passedManifest();
    precondition.status = 'failed';
    precondition.failureCode = 'precondition_failed';
    precondition.preconditionObservation = 'candidate_identity_unavailable';
    precondition.candidate = null;
    precondition.claims.localAutomated = 'failed';
    precondition.commands = commandIds.map((id) => ({
      id, status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null,
    })) as CandidateManifest['commands'];
    precondition.tests = { unitUi: null, worker: null, playwright: null };
    precondition.migrations = null;
    precondition.bindings = null;
    precondition.artifacts = null;
    precondition.execution.initialDetachedHead = null;
    precondition.execution.initialHeadSha = null;
    precondition.execution.initialHeadTree = null;
    precondition.execution.initialStatusSha256 = null;
    precondition.execution.finalDetachedHead = null;
    precondition.execution.finalHeadSha = null;
    precondition.execution.finalHeadTree = null;
    precondition.execution.finalStatusSha256 = null;
    precondition.execution.tools = {
      node: null,
      npm: null,
      git: null,
      typescript: null,
      eslint: null,
      vite: null,
      vitest: null,
      playwright: null,
      wrangler: null,
    };
    expect(() => assertRedactedCandidateManifest(precondition)).not.toThrow();

    const wrongWitness = structuredClone(precondition);
    wrongWitness.preconditionObservation = 'initial_head_not_detached';
    wrongWitness.execution.initialDetachedHead = true;
    expectInvalid(wrongWitness);

    const evidence = passedManifest();
    evidence.status = 'failed';
    evidence.failureCode = 'evidence_invalid';
    evidence.failureObservation = 'tool_version_invalid';
    evidence.claims.localAutomated = 'failed';
    evidence.execution.tools.node = null;
    evidence.commands = commandIds.map((id, index) => index === 0
      ? passedCommand(id)
      : { id, status: 'not_run', startedAt: null, finishedAt: null, durationMs: null, exitCode: null }) as CandidateManifest['commands'];
    evidence.tests = { unitUi: null, worker: null, playwright: null };
    evidence.migrations = null;
    evidence.bindings = null;
    evidence.artifacts = null;
    expect(() => assertRedactedCandidateManifest(evidence)).not.toThrow();

    const substituted = structuredClone(evidence);
    substituted.failureObservation = null;
    substituted.preconditionObservation = 'initial_status_not_clean';
    expectInvalid(substituted);
  });

  it('requires concrete witnesses for every drift code and final state for status drift', () => {
    const artifact = passedManifest();
    artifact.status = 'failed';
    artifact.failureCode = 'artifact_drift';
    artifact.claims.localAutomated = 'failed';
    artifact.artifacts!.secondTreeSha256 = 'f'.repeat(64);
    expect(() => assertRedactedCandidateManifest(artifact)).not.toThrow();

    const binding = passedManifest();
    binding.status = 'failed';
    binding.failureCode = 'binding_drift';
    binding.claims.localAutomated = 'failed';
    binding.bindings!.secondBuildTopologySha256 = 'f'.repeat(64);
    expect(() => assertRedactedCandidateManifest(binding)).not.toThrow();

    const status = passedManifest();
    status.status = 'failed';
    status.failureCode = 'status_drift';
    status.claims.localAutomated = 'failed';
    status.execution.finalHeadSha = null;
    expect(() => assertRedactedCandidateManifest(status)).not.toThrow();

    for (const code of ['artifact_drift', 'binding_drift', 'status_drift'] as const) {
      const unwitnessed = passedManifest();
      unwitnessed.status = 'failed';
      unwitnessed.failureCode = code;
      unwitnessed.claims.localAutomated = 'failed';
      expectInvalid(unwitnessed);
    }

    const initialOnly = passedManifest();
    initialOnly.status = 'failed';
    initialOnly.failureCode = 'status_drift';
    initialOnly.claims.localAutomated = 'failed';
    initialOnly.execution.initialHeadSha = null;
    expectInvalid(initialOnly);
  });
});

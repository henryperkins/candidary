// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  collectMigrationManifest,
  deployWranglerConfigBytes,
  normalizedBindingTopology,
  sha256,
  type CandidateManifest,
  type ReleaseCommandId,
} from '../../scripts/release-evidence';
import {
  assertSafeStagingWranglerConfig,
  buildStagingWranglerConfig,
  createOwnedDeployRoot,
  verifyTask10Candidate,
  type CandidateObservationAdapter,
  type StagingTargetAuthorization,
} from '../../scripts/staging-release-candidate';
import { STAGING_ORIGIN, STAGING_TARGET } from '../../scripts/staging-release-contract';

const CANDIDATE_SHA = 'a'.repeat(40);
const GIT_TREE = 'b'.repeat(40);
const BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const roots = new Set<string>();

const commandIds = [
  'npm-ci', 'verify-bindings', 'typecheck', 'typecheck-e2e', 'lint', 'unit-ui',
  'worker', 'build', 'pwa-before-e2e', 'playwright', 'pwa-after-e2e',
  'wrangler-dry-run', 'fresh-d1', 'diff-check',
] as const satisfies readonly ReleaseCommandId[];

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-staging-candidate-'));
  roots.add(root);
  return root;
}

function put(root: string, path: string, contents: string): void {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function sourceConfig(): Record<string, unknown> {
  return {
    name: 'candidary',
    main: 'worker/index.ts',
    compatibility_date: '2026-07-21',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    assets: {
      binding: 'ASSETS', not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*'],
    },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    d1_databases: [{
      binding: 'DB', database_name: 'candidary-core', database_id: 'production-db',
      migrations_dir: 'migrations',
    }],
    r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'candidary-media' }],
    images: { binding: 'IMAGES' },
    send_email: [{ name: 'EMAIL' }],
    ratelimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '1001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '1002', simple: { limit: 30, period: 60 } },
    ],
    workflows: [
      { name: 'candidary-export', binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
      { name: 'candidary-cover-render', binding: 'COVER_RENDER_WORKFLOW', class_name: 'CoverRenderWorkflow' },
      { name: 'candidary-cover-backfill', binding: 'COVER_BACKFILL_WORKFLOW', class_name: 'CoverBackfillWorkflow' },
    ],
    triggers: { crons: ['17 3 * * *', '47 * * * *'] },
    vars: {
      APP_ORIGIN: 'https://candidary.app',
      ALTERNATE_ORIGINS: 'https://candidary.online',
      R2_ACCOUNT_ID: 'f'.repeat(32),
      R2_BUCKET_NAME: 'candidary-media',
      EMAIL_FROM: 'hello@candidary.app',
    },
    secrets: { required: [
      'ENTRY_ENCRYPTION_KEY', 'ENTRY_HMAC_KEY', 'GUEST_TOKEN_ENCRYPTION_KEY',
      'LOGIN_HMAC_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
      'RSVP_LOOKUP_HMAC_KEY', 'SESSION_HMAC_KEY', 'TOKEN_HMAC_KEY',
    ] },
    observability: { enabled: true },
    placement: { mode: 'smart' },
  };
}

function generatedConfig(): Record<string, unknown> {
  return {
    ...sourceConfig(),
    configPath: 'C:\\private\\candidate\\wrangler.jsonc',
    userConfigPath: 'C:\\private\\candidate\\wrangler.jsonc',
    main: 'index.js',
    assets: {
      binding: 'ASSETS', not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*'], directory: '../client',
    },
    d1_databases: [{
      binding: 'DB', database_name: 'candidary-core', database_id: 'production-db',
      migrations_dir: '../../migrations',
    }],
    no_bundle: true,
  };
}

function makeManifest(root: string): CandidateManifest {
  put(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  put(root, 'wrangler.jsonc', `${JSON.stringify(sourceConfig())}\n`);
  for (let index = 1; index <= 13; index += 1) {
    put(root, `migrations/${String(index).padStart(4, '0')}_fixture.sql`, `SELECT ${index};\n`);
  }
  put(root, 'dist/candidary/index.js', 'export default {};\n');
  put(root, 'dist/candidary/wrangler.json', `${JSON.stringify(generatedConfig())}\n`);
  put(root, 'dist/client/index.html', '<!doctype html>\n');
  put(root, process.platform === 'win32'
    ? 'node_modules/.bin/wrangler.cmd'
    : 'node_modules/.bin/wrangler', 'fixture executable\n');

  const migrations = collectMigrationManifest(root);
  const topology = normalizedBindingTopology(sourceConfig());
  const topologyDigest = sha256(canonicalJson(topology));
  const hashed = (path: string) => {
    const bytes = readFileSync(join(root, ...path.split('/')));
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  };
  const deployConfigBytes = deployWranglerConfigBytes(generatedConfig());
  const deployWranglerConfig = {
    path: 'dist/candidary/wrangler.json',
    bytes: deployConfigBytes.length,
    sha256: sha256(deployConfigBytes),
  };
  const worker = hashed('dist/candidary/index.js');
  const client = [hashed('dist/client/index.html')];
  const artifactDigest = sha256(canonicalJson({ deployWranglerConfig, worker, client }));
  const passedCommand = (id: ReleaseCommandId) => ({
    id,
    status: 'passed' as const,
    startedAt: '2026-08-10T12:00:00.000Z',
    finishedAt: '2026-08-10T12:00:01.000Z',
    durationMs: 1_000,
    exitCode: 0,
  });

  const manifest: CandidateManifest = {
    kind: 'candidary.release-candidate',
    schemaVersion: 1,
    status: 'passed',
    failureCode: null,
    failureObservation: null,
    preconditionObservation: null,
    runId: RUN_ID,
    candidate: {
      gitSha: CANDIDATE_SHA,
      approvedBaseSha: BASE_SHA,
      gitTree: GIT_TREE,
      guestJourneyVersion: 2,
      migrationManifestSha256: migrations.sha256,
      packageLockSha256: sha256(readFileSync(join(root, 'package-lock.json'))),
      sourceWranglerConfigSha256: sha256(readFileSync(join(root, 'wrangler.jsonc'))),
    },
    execution: {
      startedAt: '2026-08-10T12:00:00.000Z',
      finishedAt: '2026-08-10T12:01:00.000Z',
      platform: 'win32',
      arch: 'x64',
      initialDetachedHead: true,
      initialHeadSha: CANDIDATE_SHA,
      initialHeadTree: GIT_TREE,
      initialStatusSha256: sha256(''),
      finalDetachedHead: true,
      finalHeadSha: CANDIDATE_SHA,
      finalHeadTree: GIT_TREE,
      finalStatusSha256: sha256(''),
      cleanupSucceeded: true,
      tools: {
        node: process.version,
        npm: '11.13.0',
        git: '2.55.0.windows.3',
        typescript: '6.0.3',
        eslint: '10.7.0',
        vite: '8.1.5',
        vitest: '4.1.10',
        playwright: '1.61.1',
        wrangler: '4.113.0',
      },
    },
    commands: commandIds.map(passedCommand) as CandidateManifest['commands'],
    tests: {
      unitUi: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      worker: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      playwright: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
    },
    migrations: {
      manifest: migrations.files,
      verification: {
        migrationCount: 13,
        ledgerSha256: sha256(canonicalJson(migrations.files.map((file) => file.path.split('/').at(-1)))),
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
      topology,
      sourceTopologySha256: topologyDigest,
      firstBuildTopologySha256: topologyDigest,
      secondBuildTopologySha256: topologyDigest,
      generatedTypesSha256: '3'.repeat(64),
    },
    artifacts: {
      deployWranglerConfig,
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

  const runRoot = join(root, 'output', 'release', CANDIDATE_SHA, RUN_ID);
  mkdirSync(runRoot, { recursive: true });
  const bytes = `${canonicalJson(manifest)}\n`;
  put(root, `output/release/${CANDIDATE_SHA}/${RUN_ID}/candidate-manifest.json`, bytes);
  put(root, `output/release/${CANDIDATE_SHA}/${RUN_ID}/candidate-manifest.json.sha256`,
    `${sha256(bytes)}  candidate-manifest.json\n`);
  return manifest;
}

function observation(overrides: Partial<CandidateObservationAdapter> = {}): CandidateObservationAdapter {
  return {
    head: () => CANDIDATE_SHA,
    tree: () => GIT_TREE,
    status: () => '',
    wranglerVersion: () => '4.113.0',
    ...overrides,
  };
}

function authorization(): StagingTargetAuthorization {
  return {
    schemaVersion: 1,
    authorization: 'approved',
    accountId: 'f'.repeat(32),
    databaseId: '1000000a-0000-4000-8000-000000000002',
    hostAuthRateLimitNamespaceId: '2001',
    rsvpRateLimitNamespaceId: '2002',
    target: structuredClone(STAGING_TARGET),
  };
}

describe('Task 10 candidate verification for Task 11', () => {
  it('accepts only exact clean passed candidates with fourteen gates and thirteen migrations', () => {
    const root = temporaryRoot();
    makeManifest(root);
    const verified = verifyTask10Candidate(root, CANDIDATE_SHA, observation());
    expect(verified).toMatchObject({
      sha: CANDIDATE_SHA,
      tree: GIT_TREE,
      wranglerVersion: '4.113.0',
      migrationCount: 13,
    });
    expect(verified.manifest.commands).toHaveLength(14);
    expect(Object.keys(verified.manifest.migrations!.verification.terminalSchema)).toHaveLength(3);
  });

  it('accepts generated config relocated to this worktree while preserving its portable bytes', () => {
    const root = temporaryRoot();
    makeManifest(root);
    const relocated = {
      ...generatedConfig(),
      configPath: join(root, 'wrangler.jsonc'),
      userConfigPath: join(root, 'wrangler.jsonc'),
    };
    put(root, 'dist/candidary/wrangler.json', `${JSON.stringify(relocated)}\n`);

    expect(() => verifyTask10Candidate(root, CANDIDATE_SHA, observation())).not.toThrow();

    put(root, 'dist/candidary/wrangler.json', `${JSON.stringify({
      ...relocated, workers_dev: true,
    })}\n`);
    expect(() => verifyTask10Candidate(root, CANDIDATE_SHA, observation()))
      .toThrow(/Wrangler config artifact/u);
  });

  it('rejects head, tree, status, manifest-sidecar, and artifact drift', () => {
    const headRoot = temporaryRoot();
    makeManifest(headRoot);
    expect(() => verifyTask10Candidate(headRoot, CANDIDATE_SHA,
      observation({ head: () => 'c'.repeat(40) }))).toThrow(/HEAD/u);
    expect(() => verifyTask10Candidate(headRoot, CANDIDATE_SHA,
      observation({ tree: () => 'c'.repeat(40) }))).toThrow(/tree/u);
    expect(() => verifyTask10Candidate(headRoot, CANDIDATE_SHA,
      observation({ status: () => ' M worker/index.ts' }))).toThrow(/clean/u);

    const sidecarRoot = temporaryRoot();
    makeManifest(sidecarRoot);
    put(sidecarRoot, `output/release/${CANDIDATE_SHA}/${RUN_ID}/candidate-manifest.json.sha256`,
      `${'0'.repeat(64)}  candidate-manifest.json\n`);
    expect(() => verifyTask10Candidate(sidecarRoot, CANDIDATE_SHA, observation()))
      .toThrow(/sidecar/u);

    const artifactRoot = temporaryRoot();
    makeManifest(artifactRoot);
    put(artifactRoot, 'dist/candidary/index.js', 'mutated\n');
    expect(() => verifyTask10Candidate(artifactRoot, CANDIDATE_SHA, observation()))
      .toThrow(/artifact/u);
  });
});

describe('owned staging deployment root', () => {
  it('rewrites only resource identities and removes all public and scheduled ingress', () => {
    const config = buildStagingWranglerConfig(generatedConfig(), authorization());
    expect(assertSafeStagingWranglerConfig(config, authorization())).toEqual(config);
    expect(config).toMatchObject({
      name: STAGING_TARGET.workerName,
      main: 'index.js',
      workers_dev: false,
      preview_urls: false,
      version_metadata: { binding: 'CF_VERSION_METADATA' },
      vars: {
        APP_ORIGIN: STAGING_ORIGIN,
        ALTERNATE_ORIGINS: '',
        R2_ACCOUNT_ID: 'f'.repeat(32),
        R2_BUCKET_NAME: STAGING_TARGET.bucketName,
        EMAIL_FROM: 'hello@staging.candidary.invalid',
      },
    });
    expect(config).not.toHaveProperty('triggers');
    expect(config).not.toHaveProperty('routes');
    expect(config).not.toHaveProperty('configPath');
    expect(config).not.toHaveProperty('userConfigPath');
    expect(config.d1_databases).toEqual([{
      binding: 'DB',
      database_name: STAGING_TARGET.databaseName,
      database_id: authorization().databaseId,
      migrations_dir: '../../migrations',
    }]);
    expect(config.r2_buckets).toEqual([{
      binding: 'MEDIA_BUCKET', bucket_name: STAGING_TARGET.bucketName,
    }]);
    expect(config.workflows).toEqual([
      { name: STAGING_TARGET.workflows.export, binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
      { name: STAGING_TARGET.workflows.render, binding: 'COVER_RENDER_WORKFLOW', class_name: 'CoverRenderWorkflow' },
      { name: STAGING_TARGET.workflows.backfill, binding: 'COVER_BACKFILL_WORKFLOW', class_name: 'CoverBackfillWorkflow' },
    ]);
  });

  it('copies and rehashes only manifest-bound artifacts and migrations', () => {
    const root = temporaryRoot();
    makeManifest(root);
    const verified = verifyTask10Candidate(root, CANDIDATE_SHA, observation());
    const runRoot = join(root, 'output', 'operations', 'owned-run');
    const owned = createOwnedDeployRoot(verified, runRoot, authorization());

    expect(readFileSync(join(owned.root, 'dist', 'candidary', 'index.js'), 'utf8'))
      .toBe('export default {};\n');
    expect(readFileSync(join(owned.root, 'migrations', '0013_fixture.sql'), 'utf8'))
      .toBe('SELECT 13;\n');
    expect(assertSafeStagingWranglerConfig(
      JSON.parse(readFileSync(owned.configPath, 'utf8')) as unknown,
      authorization(),
    )).toBeTruthy();
    expect(owned.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

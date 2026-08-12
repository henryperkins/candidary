// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  collectDeployableArtifacts,
  collectMigrationManifest,
  normalizedBindingTopology,
  sha256,
  type CandidateManifest,
  type ReleaseCommandId,
} from '../../scripts/release-evidence';
import {
  PHASE_2_MIGRATION,
  PHASE_3_MIGRATION,
  buildAtomicMigrationBundle,
  buildPhase2BootstrapBundle,
  verifyExactReleaseCandidate,
  type ReleaseCandidateObservationAdapter,
} from '../../scripts/release-candidate';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const APPROVED_BASE = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const roots = new Set<string>();

const MIGRATIONS = [
  '0001_core.sql',
  '0002_wedding_photo_drop.sql',
  '0003_partitioned_exports.sql',
  '0004_manager_media_pagination.sql',
  '0005_media_stored_at.sql',
  '0006_host_accounts.sql',
  '0007_event_theme.sql',
  '0008_event_rsvp.sql',
  '0009_rsvp_roster_batches.sql',
  '0010_event_start.sql',
  '0011_release_certifications.sql',
  '0012_event_cover_storage.sql',
  PHASE_2_MIGRATION,
  PHASE_3_MIGRATION,
  '0015_curated_private_guestbook.sql',
] as const;

const COMMANDS = [
  'npm-ci', 'verify-bindings', 'typecheck', 'typecheck-e2e', 'lint', 'unit-ui',
  'worker', 'build', 'pwa-before-e2e', 'playwright', 'pwa-after-e2e',
  'wrangler-dry-run', 'fresh-d1', 'diff-check',
] as const satisfies readonly ReleaseCommandId[];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-release-candidate-'));
  roots.add(root);
  return root;
}

function put(root: string, path: string, contents: string | Buffer): void {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function generatedConfig(): Record<string, unknown> {
  return {
    name: 'candidary',
    main: 'index.js',
    compatibility_date: '2026-07-21',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    assets: {
      binding: 'ASSETS', directory: '../client',
      not_found_handling: 'single-page-application', run_worker_first: ['/api/*'],
    },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    d1_databases: [{
      binding: 'DB', database_name: 'candidary-core', database_id: 'production-db',
      migrations_dir: '../../migrations',
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
      APP_ORIGIN: 'https://candidary.app', ALTERNATE_ORIGINS: 'https://candidary.online',
      R2_ACCOUNT_ID: 'f'.repeat(32), R2_BUCKET_NAME: 'candidary-media',
      EMAIL_FROM: 'hello@candidary.app',
    },
    secrets: { required: [
      'TOKEN_HMAC_KEY', 'SESSION_HMAC_KEY', 'GUEST_TOKEN_ENCRYPTION_KEY',
      'LOGIN_HMAC_KEY', 'ENTRY_HMAC_KEY', 'ENTRY_ENCRYPTION_KEY',
      'RSVP_LOOKUP_HMAC_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    ] },
    observability: { enabled: true },
    placement: { mode: 'smart' },
    no_bundle: true,
  };
}

interface CandidateFixture {
  root: string;
  manifest: CandidateManifest;
  manifestPath: string;
  writeManifest(): void;
}

function candidateFixture(migrationCount: 13 | 14 | 15): CandidateFixture {
  const root = temporaryRoot();
  const packageLock = `${canonicalJson({
    lockfileVersion: 3,
    packages: { 'node_modules/wrangler': { version: '4.113.0' } },
  })}\n`;
  const sourceConfig = `${canonicalJson({ ...generatedConfig(), main: 'worker/index.ts' })}\n`;
  put(root, 'package.json', `${canonicalJson({ devDependencies: { wrangler: '4.113.0' } })}\n`);
  put(root, 'package-lock.json', packageLock);
  put(root, 'config/release.json', '{"guestJourneyVersion":2}\n');
  put(root, 'wrangler.jsonc', sourceConfig);
  put(root, 'node_modules/wrangler/package.json', '{"version":"4.113.0"}\n');
  put(root, 'node_modules/wrangler/bin/wrangler.js', '#!/usr/bin/env node\n');
  for (const [index, name] of MIGRATIONS.slice(0, migrationCount).entries()) {
    put(root, `migrations/${name}`, `CREATE TABLE fixture_${index + 1} (id INTEGER);\n`);
  }
  put(root, 'dist/candidary/index.js', 'export default {};\n');
  put(root, 'dist/candidary/wrangler.json', `${canonicalJson(generatedConfig())}\n`);
  put(root, 'dist/client/index.html', '<!doctype html>\n');

  const migrations = collectMigrationManifest(root);
  const artifacts = collectDeployableArtifacts(root);
  const topology = normalizedBindingTopology(generatedConfig());
  const topologySha = sha256(canonicalJson(topology));
  const command = (id: ReleaseCommandId) => ({
    id,
    status: 'passed' as const,
    startedAt: '2026-08-10T12:00:00.000Z',
    finishedAt: '2026-08-10T12:00:01.000Z',
    durationMs: 1_000,
    exitCode: 0 as const,
  });
  const manifest: CandidateManifest = {
    kind: 'candidary.release-candidate', schemaVersion: 1, status: 'passed',
    failureCode: null, failureObservation: null, preconditionObservation: null, runId: RUN_ID,
    candidate: {
      gitSha: SHA, approvedBaseSha: APPROVED_BASE, gitTree: TREE, guestJourneyVersion: 2,
      migrationManifestSha256: migrations.sha256,
      packageLockSha256: sha256(readFileSync(join(root, 'package-lock.json'))),
      sourceWranglerConfigSha256: sha256(readFileSync(join(root, 'wrangler.jsonc'))),
    },
    execution: {
      startedAt: '2026-08-10T12:00:00.000Z', finishedAt: '2026-08-10T12:01:00.000Z',
      platform: 'win32', arch: 'x64', initialDetachedHead: true, initialHeadSha: SHA,
      initialHeadTree: TREE, initialStatusSha256: sha256(''), finalDetachedHead: true,
      finalHeadSha: SHA, finalHeadTree: TREE, finalStatusSha256: sha256(''),
      cleanupSucceeded: true,
      tools: {
        node: process.version, npm: '11.0.0', git: '2.55.0', typescript: '6.0.3',
        eslint: '10.7.0', vite: '8.1.5', vitest: '4.1.10', playwright: '1.61.1',
        wrangler: '4.113.0',
      },
    },
    commands: COMMANDS.map(command) as CandidateManifest['commands'],
    tests: {
      unitUi: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      worker: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      playwright: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
    },
    migrations: {
      manifest: migrations.files,
      verification: {
        migrationCount,
        ledgerSha256: sha256(canonicalJson(migrations.files.map(({ path }) => path.split('/').at(-1)))),
        foreignKeyRows: 0, integrity: 'ok',
        terminalSchema: { events: true, rosterBatchReceipts: true, releaseCertifications: true },
      },
    },
    bindings: {
      topology, sourceTopologySha256: topologySha, firstBuildTopologySha256: topologySha,
      secondBuildTopologySha256: topologySha, generatedTypesSha256: '3'.repeat(64),
    },
    artifacts: {
      deployWranglerConfig: artifacts.deployWranglerConfig, worker: artifacts.worker,
      client: artifacts.client, firstTreeSha256: artifacts.treeSha256,
      secondTreeSha256: artifacts.treeSha256, dryRunWorkerSha256: artifacts.worker.sha256,
    },
    claims: {
      localAutomated: 'passed', remoteMigration: 'not_run', deployment: 'not_run',
      physicalDevices: 'not_run', runtimeCertification: 'not_run',
    },
  };
  const manifestPath = join(root, 'output/release', SHA, RUN_ID, 'candidate-manifest.json');
  const writeManifest = () => {
    const bytes = `${canonicalJson(manifest)}\n`;
    put(root, `output/release/${SHA}/${RUN_ID}/candidate-manifest.json`, bytes);
    put(root, `output/release/${SHA}/${RUN_ID}/candidate-manifest.json.sha256`,
      `${sha256(bytes)}  candidate-manifest.json\n`);
  };
  writeManifest();
  return { root, manifest, manifestPath, writeManifest };
}

function observation(
  overrides: Partial<ReleaseCandidateObservationAdapter> = {},
): ReleaseCandidateObservationAdapter {
  return {
    resolveCommit: () => SHA,
    head: () => SHA,
    tree: () => TREE,
    status: () => '',
    ...overrides,
  };
}

describe('exact release candidate verification', () => {
  it('accepts the exact clean Phase-2 and Phase-3 candidates and binds every source artifact', () => {
    for (const migrationCount of [13, 14] as const) {
      const fixture = candidateFixture(migrationCount);
      const verified = verifyExactReleaseCandidate({
        candidateRoot: fixture.root,
        sha: SHA,
        manifestPath: fixture.manifestPath,
        approvedBaseSha: APPROVED_BASE,
        expectedMigrationCount: migrationCount,
      }, observation());
      expect(verified).toMatchObject({
        sha: SHA, tree: TREE, migrationCount, wranglerVersion: '4.113.0',
      });
      expect(verified.manifestSha256).toHaveLength(64);
      expect(verified.artifactTreeSha256).toBe(fixture.manifest.artifacts!.firstTreeSha256);
    }
  });

  it('accepts the post-cutover fifteen-migration candidate without changing historical boundaries', () => {
    const fixture = candidateFixture(15);
    expect(() => verifyExactReleaseCandidate({
      candidateRoot: fixture.root,
      sha: SHA,
      manifestPath: fixture.manifestPath,
      approvedBaseSha: APPROVED_BASE,
      expectedMigrationCount: 15,
    }, observation())).not.toThrow();
  });

  it('rejects wrong commit, HEAD, tree, dirt, base, sidecar, migration, artifact, and symlink identity', () => {
    const cases: Array<{
      mutate?: (fixture: CandidateFixture) => void;
      adapters?: Partial<ReleaseCandidateObservationAdapter>;
      message: RegExp;
    }> = [
      { adapters: { resolveCommit: () => 'c'.repeat(40) }, message: /commit/u },
      { adapters: { head: () => 'c'.repeat(40) }, message: /HEAD/u },
      { adapters: { tree: () => 'c'.repeat(40) }, message: /tree/u },
      { adapters: { status: () => ' M worker/index.ts\n' }, message: /clean/u },
      { mutate: (fixture) => { fixture.manifest.candidate!.approvedBaseSha = 'd'.repeat(40); fixture.writeManifest(); }, message: /base/iu },
      { mutate: (fixture) => put(fixture.root, `output/release/${SHA}/${RUN_ID}/candidate-manifest.json.sha256`, `${'0'.repeat(64)}  candidate-manifest.json\n`), message: /sidecar/u },
      { mutate: (fixture) => put(fixture.root, `migrations/${PHASE_3_MIGRATION}`, 'SELECT 42;\n'), message: /migration/u },
      { mutate: (fixture) => put(fixture.root, 'dist/candidary/index.js', 'drifted\n'), message: /artifact/u },
    ];
    for (const candidate of cases) {
      const fixture = candidateFixture(14);
      candidate.mutate?.(fixture);
      expect(() => verifyExactReleaseCandidate({
        candidateRoot: fixture.root, sha: SHA, manifestPath: fixture.manifestPath,
        approvedBaseSha: APPROVED_BASE, expectedMigrationCount: 14,
      }, observation(candidate.adapters))).toThrow(candidate.message);
    }

    const fixture = candidateFixture(14);
    const link = join(fixture.root, 'linked-candidate-manifest.json');
    try {
      symlinkSync(fixture.manifestPath, link, 'file');
      expect(() => verifyExactReleaseCandidate({
        candidateRoot: fixture.root, sha: SHA, manifestPath: link,
        approvedBaseSha: APPROVED_BASE, expectedMigrationCount: 14,
      }, observation())).toThrow(/regular|symlink/u);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  });
});

describe('manifest-bound atomic migration bundles', () => {
  it('builds the Phase-2 bootstrap in order through 0013 and inserts one ledger row after each exact file', () => {
    const fixture = candidateFixture(13);
    const verified = verifyExactReleaseCandidate({
      candidateRoot: fixture.root, sha: SHA, manifestPath: fixture.manifestPath,
      approvedBaseSha: APPROVED_BASE, expectedMigrationCount: 13,
    }, observation());
    const outputPath = join(fixture.root, 'output/bootstrap.sql');
    const bundle = buildPhase2BootstrapBundle({
      verifiedPhase2Candidate: verified,
      through: PHASE_2_MIGRATION,
      outputPath,
    });
    const sql = readFileSync(outputPath, 'utf8');
    expect(bundle.migrations).toEqual(MIGRATIONS.slice(0, 13));
    expect(bundle.sha256).toBe(sha256(readFileSync(outputPath)));
    expect(sql).toMatch(/^CREATE TABLE IF NOT EXISTS "d1_migrations"/u);
    expect(sql).toMatch(/CREATE TABLE fixture_8 \(id INTEGER\);\nINSERT INTO "d1_migrations" \(name\) VALUES \('0008_event_rsvp.sql'\);/u);
    expect(sql.indexOf('0012_event_cover_storage.sql')).toBeLessThan(sql.indexOf(PHASE_2_MIGRATION));
    expect(sql.endsWith(`INSERT INTO "d1_migrations" (name) VALUES ('${PHASE_2_MIGRATION}');\n`)).toBe(true);
    expect(() => buildPhase2BootstrapBundle({
      verifiedPhase2Candidate: verified,
      through: '0012_event_cover_storage.sql' as typeof PHASE_2_MIGRATION,
      outputPath: join(fixture.root, 'output/wrong.sql'),
    })).toThrow(/through/u);
  });

  it('builds only the exact 0014 migration and deterministic ledger insert for the atomic cutover', () => {
    const fixture = candidateFixture(14);
    const verified = verifyExactReleaseCandidate({
      candidateRoot: fixture.root, sha: SHA, manifestPath: fixture.manifestPath,
      approvedBaseSha: APPROVED_BASE, expectedMigrationCount: 14,
    }, observation());
    const outputPath = join(fixture.root, 'output/0014.sql');
    const bundle = buildAtomicMigrationBundle({
      verifiedCandidate: verified,
      expectedLedger: MIGRATIONS.slice(0, 13),
      migration: PHASE_3_MIGRATION,
      outputPath,
    });
    const sql = readFileSync(outputPath, 'utf8');
    expect(bundle.migrationHash).toBe(verified.migrations.at(-1)!.sha256);
    expect(bundle.sha256).toBe(sha256(readFileSync(outputPath)));
    expect(sql).toBe([
      'CREATE TABLE fixture_14 (id INTEGER);',
      `INSERT INTO "d1_migrations" (name) VALUES ('${PHASE_3_MIGRATION}');`,
      '',
    ].join('\n'));
    expect(() => buildAtomicMigrationBundle({
      verifiedCandidate: verified,
      expectedLedger: MIGRATIONS.slice(0, 12),
      migration: PHASE_3_MIGRATION,
      outputPath: join(fixture.root, 'output/wrong-ledger.sql'),
    })).toThrow(/ledger/u);
  });
});

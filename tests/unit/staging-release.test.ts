// @vitest-environment node

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  type VerifiedReleaseCandidate,
} from '../../scripts/release-candidate';
import { PRODUCTION_TRIGGER_NAMES, type ZeroLegacyObservation } from '../../scripts/migrate-release';
import {
  REQUIRED_STAGING_SECRET_NAMES,
  buildStagingOverlay,
  createOwnedStagingDeployRoot,
  parseStagingReleaseArgsV1,
  finalizeStagingRelease,
  parseStagingTargetDescriptor,
  runStagingRelease,
  stagingTargetSha256,
  verifyFinalStagingRelease,
  type ReviewAuthorizationV1,
  type StagingAuthorizationV1,
  type StagingCommand,
  type StagingDatabaseObservation,
  type StagingDeploymentObservation,
  type StagingReleaseAdapters,
  type StagingTargetDescriptorV1,
} from '../../scripts/staging-release';
import {
  STAGING_BROWSER_CASE_IDS,
  STAGING_IMAGES_CASE_IDS,
  STAGING_ROUTE_CASE_IDS,
  STAGING_WORKFLOW_CASE_IDS,
  type StagingConformanceArtifactV1,
} from '../../scripts/staging-release-evidence';

const PHASE_2_SHA = 'c'.repeat(40);
const PHASE_3_SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const ACCOUNT = 'f'.repeat(32);
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const NOW = '2026-08-10T12:00:00.000Z';
const roots = new Set<string>();

const migrations = [
  '0001_core.sql', '0002_wedding_photo_drop.sql', '0003_partitioned_exports.sql',
  '0004_manager_media_pagination.sql', '0005_media_stored_at.sql', '0006_host_accounts.sql',
  '0007_event_theme.sql', '0008_event_rsvp.sql', '0009_rsvp_roster_batches.sql',
  '0010_event_start.sql', '0011_release_certifications.sql',
  '0012_event_cover_storage.sql', PHASE_2_MIGRATION, PHASE_3_MIGRATION,
] as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-staging-release-'));
  roots.add(root);
  return root;
}

function put(root: string, path: string, contents: string | Buffer): string {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
}

function generatedConfig(): Record<string, unknown> {
  return {
    name: 'candidary', main: 'index.js', workers_dev: false, preview_urls: false,
    compatibility_date: '2026-07-21', compatibility_flags: ['nodejs_compat'],
    assets: {
      binding: 'ASSETS', directory: '../client',
      not_found_handling: 'single-page-application', run_worker_first: ['/api/*'],
    },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    d1_databases: [{
      binding: 'DB', database_name: 'candidary-core',
      database_id: '60bec5de-c8c7-41b5-a26b-2d3f7d184c71', migrations_dir: '../../migrations',
    }],
    r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'candidary-media' }],
    images: { binding: 'IMAGES' }, send_email: [{ name: 'EMAIL' }],
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
      R2_ACCOUNT_ID: 'e'.repeat(32), R2_BUCKET_NAME: 'candidary-media',
      EMAIL_FROM: 'hello@candidary.app',
    },
    secrets: { required: [...REQUIRED_STAGING_SECRET_NAMES] },
    observability: { enabled: true }, placement: { mode: 'smart' }, no_bundle: true,
  };
}

function target(purpose: 'workflow-conformance' | 'cutover'): StagingTargetDescriptorV1 {
  const prefix = purpose === 'workflow-conformance' ? 'wf-proof' : 'cutover';
  const enabled = purpose === 'cutover';
  return {
    kind: 'candidary.staging-target', schemaVersion: 1, purpose, accountId: ACCOUNT,
    worker: {
      name: `candidary-${prefix}`, routes: purpose === 'cutover' ? ['cutover.candidary.invalid/*'] : [],
      workersDev: false, previewUrls: false,
    },
    d1: { binding: 'DB', databaseName: `candidary-core-${prefix}`, databaseId: `1000000a-0000-4000-8000-00000000000${enabled ? '2' : '1'}` },
    r2: { binding: 'MEDIA_BUCKET', enabled: true, bucketName: `candidary-media-${prefix}` },
    images: { binding: 'IMAGES', enabled: true, identity: `images-${prefix}` },
    assets: { binding: 'ASSETS', enabled, identity: `assets-${prefix}` },
    email: { binding: 'EMAIL', enabled, destinationAddress: `sink-${prefix}@candidary.invalid` },
    rateLimits: {
      hostAuth: { binding: 'HOST_AUTH_RATE_LIMIT', enabled, namespaceId: enabled ? '2001' : '2101', limit: 20, period: 60 },
      rsvpLookup: { binding: 'RSVP_LOOKUP_RATE_LIMIT', enabled, namespaceId: enabled ? '2002' : '2102', limit: 30, period: 60 },
    },
    workflows: {
      export: { binding: 'EXPORT_WORKFLOW', enabled: true, name: `candidary-export-${prefix}`, className: 'ExportWorkflow' },
      render: { binding: 'COVER_RENDER_WORKFLOW', enabled: true, name: `candidary-cover-render-${prefix}`, className: 'CoverRenderWorkflow' },
      backfill: { binding: 'COVER_BACKFILL_WORKFLOW', enabled: true, name: `candidary-cover-backfill-${prefix}`, className: 'CoverBackfillWorkflow' },
    },
    crons: [],
    vars: {
      APP_ORIGIN: `https://${prefix}.candidary.invalid`, ALTERNATE_ORIGINS: '',
      R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: `candidary-media-${prefix}`,
      EMAIL_FROM: `hello-${prefix}@candidary.invalid`,
    },
    requiredSecretNames: [...REQUIRED_STAGING_SECRET_NAMES],
    observability: { enabled: true }, placement: { mode: 'smart' },
    expiresAt: '2026-08-11T12:00:00.000Z', cleanupOwner: 'staging-owner',
  };
}

function postCutoverTarget(purpose: 'workflow-conformance' | 'cutover'): Record<string, unknown> {
  const historical = target(purpose);
  const enabled = purpose === 'cutover';
  return {
    ...historical,
    schemaVersion: 2,
    rateLimits: {
      ...historical.rateLimits,
      guestMessage: {
        binding: 'GUEST_MESSAGE_RATE_LIMIT', enabled,
        namespaceId: enabled ? '2003' : '2103', limit: 120, period: 60,
      },
    },
    requiredSecretNames: [...historical.requiredSecretNames, 'GUEST_MESSAGE_HMAC_KEY'],
  };
}

function candidateFixture(count: 13 | 14, sha: string): VerifiedReleaseCandidate {
  const root = tempRoot();
  put(root, 'dist/candidary/index.js', 'export default {};\n');
  put(root, 'dist/candidary/wrangler.json', `${canonicalJson(generatedConfig())}\n`);
  put(root, 'dist/client/index.html', '<!doctype html>\n');
  for (const [index, name] of migrations.slice(0, count).entries()) {
    put(root, `migrations/${name}`, index === 13
      ? 'CREATE TABLE phase_3_guard (id INTEGER);\n'
      : `CREATE TABLE fixture_${index + 1} (id INTEGER);\n`);
  }
  const artifacts = collectDeployableArtifacts(root);
  const migrationManifest = collectMigrationManifest(root);
  const wranglerCliPath = put(root, 'node_modules/wrangler/bin/wrangler.js', 'fixture\n');
  const topology = normalizedBindingTopology(generatedConfig());
  const topologySha256 = sha256(canonicalJson(topology));
  const commandIds: ReleaseCommandId[] = [
    'npm-ci', 'verify-bindings', 'typecheck', 'typecheck-e2e', 'lint', 'unit-ui',
    'worker', 'build', 'pwa-before-e2e', 'playwright', 'pwa-after-e2e',
    'wrangler-dry-run', 'fresh-d1', 'diff-check',
  ];
  const manifest: CandidateManifest = {
    kind: 'candidary.release-candidate', schemaVersion: 1, status: 'passed',
    failureCode: null, failureObservation: null, preconditionObservation: null, runId: RUN_ID,
    candidate: {
      gitSha: sha, approvedBaseSha: BASE, gitTree: TREE, guestJourneyVersion: 2,
      migrationManifestSha256: migrationManifest.sha256,
      packageLockSha256: '6'.repeat(64), sourceWranglerConfigSha256: '7'.repeat(64),
    },
    execution: {
      startedAt: '2026-08-10T10:00:00.000Z', finishedAt: '2026-08-10T10:01:00.000Z',
      platform: 'win32', arch: 'x64', initialDetachedHead: true, initialHeadSha: sha,
      initialHeadTree: TREE, initialStatusSha256: sha256(''), finalDetachedHead: true,
      finalHeadSha: sha, finalHeadTree: TREE, finalStatusSha256: sha256(''), cleanupSucceeded: true,
      tools: {
        node: process.version, npm: '11.0.0', git: '2.55.0', typescript: '6.0.3',
        eslint: '10.7.0', vite: '8.1.5', vitest: '4.1.10', playwright: '1.61.1',
        wrangler: '4.113.0',
      },
    },
    commands: commandIds.map((id) => ({
      id, status: 'passed', startedAt: '2026-08-10T10:00:00.000Z',
      finishedAt: '2026-08-10T10:00:01.000Z', durationMs: 1_000, exitCode: 0,
    })) as CandidateManifest['commands'],
    tests: {
      unitUi: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      worker: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
      playwright: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
    },
    migrations: {
      manifest: migrationManifest.files,
      verification: {
        migrationCount: count,
        ledgerSha256: sha256(canonicalJson(migrationManifest.files.map((file) => basename(file.path)))),
        foreignKeyRows: 0, integrity: 'ok',
        terminalSchema: { events: true, rosterBatchReceipts: true, releaseCertifications: true },
      },
    },
    bindings: {
      topology, sourceTopologySha256: topologySha256,
      firstBuildTopologySha256: topologySha256, secondBuildTopologySha256: topologySha256,
      generatedTypesSha256: '8'.repeat(64),
    },
    artifacts: {
      deployWranglerConfig: artifacts.deployWranglerConfig,
      worker: artifacts.worker, client: artifacts.client,
      firstTreeSha256: artifacts.treeSha256, secondTreeSha256: artifacts.treeSha256,
      dryRunWorkerSha256: artifacts.worker.sha256,
    },
    claims: {
      localAutomated: 'passed', remoteMigration: 'not_run', deployment: 'not_run',
      physicalDevices: 'not_run', runtimeCertification: 'not_run',
    },
  };
  const manifestBytes = `${canonicalJson(manifest)}\n`;
  const manifestPath = put(root, `output/release/${sha}/${RUN_ID}/candidate-manifest.json`, manifestBytes);
  put(root, `output/release/${sha}/${RUN_ID}/candidate-manifest.json.sha256`,
    `${sha256(manifestBytes)}  candidate-manifest.json\n`);
  return {
    candidateRoot: root, sha, tree: TREE, approvedBaseSha: BASE,
    manifestPath, manifestSha256: sha256(manifestBytes), manifest,
    migrations: migrationManifest.files, migrationCount: count,
    artifactTreeSha256: artifacts.treeSha256, wranglerVersion: '4.113.0', wranglerCliPath,
  };
}

interface ReleaseInputs {
  candidate: VerifiedReleaseCandidate;
  workflowTarget: StagingTargetDescriptorV1;
  cutoverTarget: StagingTargetDescriptorV1;
  targetPath: string;
  reviewPath: string;
  authorizationPath: string;
  review: ReviewAuthorizationV1;
  authorization: StagingAuthorizationV1;
}

function writeInput(root: string, name: string, value: unknown): { path: string; digest: string } {
  const path = put(root, `output/staging-input/${name}`, `${canonicalJson(value)}\n`);
  const digest = sha256(readFileSync(path));
  put(root, `output/staging-input/${name}.sha256`, `${digest}  ${name}\n`);
  return { path, digest };
}

function inputs(count: 13 | 14, purpose: 'workflow-conformance' | 'cutover'): ReleaseInputs {
  const candidate = candidateFixture(count, count === 13 ? PHASE_2_SHA : PHASE_3_SHA);
  const workflowTarget = target('workflow-conformance');
  const cutoverTarget = target('cutover');
  const phase2ManifestSha256 = count === 13 ? candidate.manifestSha256 : '8'.repeat(64);
  const phase3ManifestSha256 = count === 14 ? candidate.manifestSha256 : '9'.repeat(64);
  const review: ReviewAuthorizationV1 = {
    kind: 'candidary.phase-3-review-authorization', schemaVersion: 1,
    approvedMainSha: BASE, phase2Sha: PHASE_2_SHA, phase2ManifestSha256,
    candidateSha: PHASE_3_SHA, candidateManifestSha256: phase3ManifestSha256,
    reviewer: 'release-reviewer', issuedAt: '2026-08-10T11:00:00.000Z',
    expiresAt: '2026-08-11T12:00:00.000Z',
  };
  const reviewInput = writeInput(candidate.candidateRoot, 'review.json', review);
  const authorization: StagingAuthorizationV1 = {
    kind: 'candidary.staging-authorization', schemaVersion: 1, runId: RUN_ID,
    reviewAuthorizationSha256: reviewInput.digest,
    allowedCandidateShas: [PHASE_2_SHA, PHASE_3_SHA],
    targetSha256s: {
      workflowConformance: stagingTargetSha256(workflowTarget),
      cutover: stagingTargetSha256(cutoverTarget),
    },
    allowedModes: ['initialize', 'deploy', 'migrate', 'finalize', 'verify'],
    cutoverCrons: [],
    expectedSchemaSha256s: {
      workflowConformancePhase2: '3'.repeat(64),
      cutoverPhase2: '4'.repeat(64),
      cutoverPhase3: '5'.repeat(64),
    },
    issuedAt: '2026-08-10T11:01:00.000Z', expiresAt: '2026-08-11T12:00:00.000Z',
    cleanupOwner: 'staging-owner',
  };
  const authorizationInput = writeInput(candidate.candidateRoot, 'staging-authorization.json', authorization);
  const descriptor = purpose === 'workflow-conformance' ? workflowTarget : cutoverTarget;
  const targetInput = writeInput(candidate.candidateRoot, `${purpose}.json`, descriptor);
  return {
    candidate, workflowTarget, cutoverTarget, targetPath: targetInput.path,
    reviewPath: reviewInput.path, authorizationPath: authorizationInput.path,
    review, authorization,
  };
}

const zeroCounts: ZeroLegacyObservation = {
  legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0, uploadsWithoutActiveSet: 0,
};

function database(
  ledger: readonly string[],
  schemaSha256: string,
): StagingDatabaseObservation {
  return {
    empty: ledger.length === 0, applicationObjectCount: ledger.length === 0 ? 0 : 1,
    ledger: [...ledger], schemaSha256, integrity: 'ok', foreignKeyRows: 0,
    triggerNames: ledger.length === 14 ? [...PRODUCTION_TRIGGER_NAMES] : [], zeroCounts,
  };
}

function adapters(
  source: ReleaseInputs,
  observations: StagingDatabaseObservation[],
  options: { exitCode?: number; secretNames?: string[]; deployment?: StagingDeploymentObservation } = {},
): { value: StagingReleaseAdapters; commands: StagingCommand[]; verifies: number } {
  const commands: StagingCommand[] = [];
  let observationIndex = 0;
  const holder = {
    verifies: 0,
    value: {
      now: () => NOW,
      verifyCandidate() { holder.verifies += 1; return source.candidate; },
      prepareCandidate() { /* command-free fake for the unit boundary */ },
      listSecretNames: () => options.secretNames ?? [...REQUIRED_STAGING_SECRET_NAMES],
      observeDatabase: () => observations[Math.min(observationIndex++, observations.length - 1)]!,
      observeDeployment: () => options.deployment ?? {
        versionId: '1000000a-0000-4000-8000-000000000099',
        tagSha: source.candidate.sha, metadataSha: source.candidate.sha,
        trafficPercent: 100, topologySha256: stagingTargetSha256(
          parseStagingTargetDescriptor(JSON.parse(readFileSync(source.targetPath, 'utf8')) as unknown, NOW),
        ),
      },
      hashFile: (path) => sha256(readFileSync(path)),
      run(command) {
        commands.push(command);
        expect(command.cwd).toMatch(/deploy-root$/u);
        expect(readFileSync(join(command.cwd, 'dist/candidary/wrangler.json'), 'utf8')).not.toContain('candidary-core"');
        return options.exitCode ?? 0;
      },
    } satisfies StagingReleaseAdapters,
    commands,
  };
  return holder;
}

function request(source: ReleaseInputs, mode: 'initialize' | 'deploy' | 'migrate') {
  return {
    mode, candidateRoot: source.candidate.candidateRoot, sha: source.candidate.sha,
    manifestPath: source.candidate.manifestPath, targetPath: source.targetPath,
    reviewAuthorizationPath: source.reviewPath, authorizationPath: source.authorizationPath,
    runId: RUN_ID, through: mode === 'initialize' ? PHASE_2_MIGRATION : undefined,
  } as const;
}

describe('staging target and CLI contract', () => {
  it('parses and overlays the post-cutover three-limiter/new-secret target', () => {
    const descriptor = postCutoverTarget('cutover');
    const parsed = parseStagingTargetDescriptor(descriptor, NOW);
    const overlay = buildStagingOverlay(generatedConfig(), parsed, []);
    expect(overlay.config.ratelimits).toEqual([
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '2001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '2002', simple: { limit: 30, period: 60 } },
      { name: 'GUEST_MESSAGE_RATE_LIMIT', namespace_id: '2003', simple: { limit: 120, period: 60 } },
    ]);
    expect((overlay.config.secrets as { required: string[] }).required)
      .toContain('GUEST_MESSAGE_HMAC_KEY');
  });

  it('accepts a closed staging descriptor and rejects unknown fields, production reuse, and public conformance ingress', () => {
    const valid = target('workflow-conformance');
    expect(parseStagingTargetDescriptor(valid, NOW)).toEqual(valid);
    expect(() => parseStagingTargetDescriptor({ ...valid, token: 'secret' }, NOW)).toThrow(/unknown|field/u);
    expect(() => parseStagingTargetDescriptor({
      ...valid, worker: { ...valid.worker, name: 'candidary' },
    }, NOW)).toThrow(/production/u);
    for (const worker of [
      { ...valid.worker, routes: ['public.invalid/*'] },
      { ...valid.worker, workersDev: true },
      { ...valid.worker, previewUrls: true },
    ]) expect(() => parseStagingTargetDescriptor({ ...valid, worker }, NOW)).toThrow(/workflow|route|public|workers|preview/u);
    expect(() => parseStagingTargetDescriptor({ ...valid, crons: ['* * * * *'] }, NOW)).toThrow(/cron/u);
  });

  it('parses only each mode exact grammar and derives purpose from the descriptor', () => {
    const source = inputs(13, 'cutover');
    const parsed = parseStagingReleaseArgsV1([
      'initialize', '--candidate-root', source.candidate.candidateRoot,
      '--sha', PHASE_2_SHA, '--manifest', source.candidate.manifestPath,
      '--target', source.targetPath, '--review-authorization', source.reviewPath,
      '--authorization', source.authorizationPath, '--run-id', RUN_ID,
      '--through', PHASE_2_MIGRATION,
    ], source.candidate.candidateRoot);
    expect(parsed).toMatchObject({ mode: 'initialize', sha: PHASE_2_SHA, through: PHASE_2_MIGRATION });
    expect(() => parseStagingReleaseArgsV1([
      'deploy', '--purpose', 'cutover', '--candidate-root', source.candidate.candidateRoot,
    ], source.candidate.candidateRoot)).toThrow(/unknown|purpose/u);
  });
});

describe('closed staging overlay and remote modes', () => {
  it('replaces or disables every production-capable surface', () => {
    for (const purpose of ['workflow-conformance', 'cutover'] as const) {
      const descriptor = target(purpose);
      const result = buildStagingOverlay(generatedConfig(), descriptor, []);
      expect(result.targetSha256).toBe(stagingTargetSha256(descriptor));
      expect(result.config).toMatchObject({
        name: descriptor.worker.name, workers_dev: false, preview_urls: false,
        d1_databases: [{ database_name: descriptor.d1.databaseName, database_id: descriptor.d1.databaseId }],
        vars: descriptor.vars,
      });
      const serialized = canonicalJson(result.config);
      for (const identity of [
        'candidary-core"', 'candidary-media"', 'candidary-export"',
        'candidary-cover-render"', 'candidary-cover-backfill"',
      ]) expect(serialized).not.toContain(identity);
      if (purpose === 'workflow-conformance') {
        expect(result.config).not.toHaveProperty('routes');
        expect(result.config).not.toHaveProperty('triggers');
        expect(result.config).not.toHaveProperty('send_email');
        expect(result.config).not.toHaveProperty('ratelimits');
        expect(result.config).not.toHaveProperty('assets');
      }
    }
    expect(() => buildStagingOverlay({ ...generatedConfig(), mystery_binding: [] }, target('cutover'), []))
      .toThrow(/unclassified/u);
    expect(() => buildStagingOverlay({
      ...generatedConfig(), kv_namespaces: [{ binding: 'LEAK', id: 'production' }],
    }, target('cutover'), [])).toThrow(/unclassified|kv_namespaces/u);
  });

  it('initializes only an empty D1 from the exact 13-migration candidate with one atomic file import', () => {
    const source = inputs(13, 'cutover');
    const before = database([], source.authorization.expectedSchemaSha256s.cutoverPhase2);
    const after = database(migrations.slice(0, 13), source.authorization.expectedSchemaSha256s.cutoverPhase2);
    const run = adapters(source, [before, after]);
    const result = runStagingRelease(request(source, 'initialize'), run.value);
    expect(run.verifies).toBe(2);
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]!.args).toEqual([
      source.candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--remote',
      '--config', 'dist/candidary/wrangler.json', '--file', run.commands[0]!.inputPath,
    ]);
    expect(result).toMatchObject({ mode: 'initialize', ledger: migrations.slice(0, 13) });

    const dirty = inputs(13, 'cutover');
    const nonempty = database([], dirty.authorization.expectedSchemaSha256s.cutoverPhase2);
    nonempty.empty = false;
    nonempty.applicationObjectCount = 1;
    const refused = adapters(dirty, [nonempty]);
    expect(() => runStagingRelease(request(dirty, 'initialize'), refused.value)).toThrow(/empty/u);
    expect(refused.commands).toHaveLength(0);
  });

  it('deploys from the owned root with exact tag, secret names, metadata, topology, and 100% cutover traffic', () => {
    const source = inputs(14, 'cutover');
    const run = adapters(source, [database(migrations, '5'.repeat(64))]);
    const result = runStagingRelease(request(source, 'deploy'), run.value);
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]!.args).toEqual([
      source.candidate.wranglerCliPath, 'deploy', '--config', 'dist/candidary/wrangler.json',
      '--strict', '--tag', PHASE_3_SHA,
    ]);
    expect(result).toMatchObject({ mode: 'deploy', candidateSha: PHASE_3_SHA, trafficPercent: 100 });
    expect(() => readFileSync(run.commands[0]!.cwd)).toThrow();

    const secrets = inputs(14, 'cutover');
    const refused = adapters(secrets, [database(migrations, '5'.repeat(64))], { secretNames: [] });
    expect(() => runStagingRelease(request(secrets, 'deploy'), refused.value)).toThrow(/secret/u);
    expect(refused.commands).toHaveLength(0);
  });

  it('migrates cutover from exactly 0013 to 0014 and proves rollback on a failed import', () => {
    const source = inputs(14, 'cutover');
    const before = database(migrations.slice(0, 13), source.authorization.expectedSchemaSha256s.cutoverPhase2);
    const after = database(migrations, source.authorization.expectedSchemaSha256s.cutoverPhase3);
    const run = adapters(source, [before, after]);
    expect(runStagingRelease(request(source, 'migrate'), run.value)).toMatchObject({
      mode: 'migrate', ledger: [...migrations],
    });
    expect(run.commands[0]!.args.join(' ')).not.toMatch(/migrations apply|npx/iu);

    const failed = inputs(14, 'cutover');
    const failedBefore = database(migrations.slice(0, 13), failed.authorization.expectedSchemaSha256s.cutoverPhase2);
    const failedRun = adapters(failed, [failedBefore, failedBefore], { exitCode: 1 });
    expect(() => runStagingRelease(request(failed, 'migrate'), failedRun.value)).toThrow(/failed|rollback/u);
    expect(failedRun.commands).toHaveLength(1);
  });

  it('rejects topology substitution and source drift on the final pre-command candidate recheck', () => {
    const source = inputs(14, 'cutover');
    const run = adapters(source, [database(migrations, '5'.repeat(64))]);
    const original = run.value.verifyCandidate;
    let call = 0;
    run.value.verifyCandidate = (value) => {
      const verified = original(value);
      call += 1;
      return call === 1 ? verified : { ...verified, tree: 'd'.repeat(40) };
    };
    expect(() => runStagingRelease(request(source, 'deploy'), run.value)).toThrow(/drift/u);
    expect(run.commands).toHaveLength(0);
  });
});

function completeMatrix(caseIds: readonly string[]) {
  return caseIds.map((caseId) => ({ caseId, status: 'passed' as const, observationCode: 'verified' }));
}

function completeDestruction() {
  return {
    fixturesAbsent: true, workerAbsent: true, databaseAbsent: true, r2Absent: true,
    imagesAbsent: true, emailAbsent: true, rateLimitsAbsent: true, workflowsAbsent: true,
    assetsAbsent: true,
  };
}

describe('staging finalization and independent verification', () => {
  it('rehashes both candidates, authorizations, targets, derived bundles, cleanup, and matrices', () => {
    const phase2 = candidateFixture(13, PHASE_2_SHA);
    const phase3 = candidateFixture(14, PHASE_3_SHA);
    const workflow = target('workflow-conformance');
    const cutover = target('cutover');
    const review: ReviewAuthorizationV1 = {
      kind: 'candidary.phase-3-review-authorization', schemaVersion: 1,
      approvedMainSha: BASE, phase2Sha: PHASE_2_SHA,
      phase2ManifestSha256: phase2.manifestSha256,
      candidateSha: PHASE_3_SHA, candidateManifestSha256: phase3.manifestSha256,
      reviewer: 'release-reviewer', issuedAt: '2026-08-10T11:00:00.000Z',
      expiresAt: '2026-08-11T12:00:00.000Z',
    };
    const reviewInput = writeInput(phase3.candidateRoot, 'final-review.json', review);
    const authorization: StagingAuthorizationV1 = {
      kind: 'candidary.staging-authorization', schemaVersion: 1, runId: RUN_ID,
      reviewAuthorizationSha256: reviewInput.digest,
      allowedCandidateShas: [PHASE_2_SHA, PHASE_3_SHA],
      targetSha256s: {
        workflowConformance: stagingTargetSha256(workflow), cutover: stagingTargetSha256(cutover),
      },
      allowedModes: ['initialize', 'deploy', 'migrate', 'finalize', 'verify'], cutoverCrons: [],
      expectedSchemaSha256s: {
        workflowConformancePhase2: '3'.repeat(64), cutoverPhase2: '4'.repeat(64),
        cutoverPhase3: '5'.repeat(64),
      },
      issuedAt: '2026-08-10T11:01:00.000Z', expiresAt: '2026-08-11T12:00:00.000Z',
      cleanupOwner: 'staging-owner',
    };
    const authorizationInput = writeInput(phase3.candidateRoot, 'final-authorization.json', authorization);
    const workflowInput = writeInput(phase3.candidateRoot, 'final-workflow.json', workflow);
    const cutoverInput = writeInput(phase3.candidateRoot, 'final-cutover.json', cutover);
    const bootstrapPath = resolve(phase2.candidateRoot, 'output/precompute-bootstrap.sql');
    const bootstrap = buildPhase2BootstrapBundle({
      verifiedPhase2Candidate: phase2, through: PHASE_2_MIGRATION, outputPath: bootstrapPath,
    });
    const bundlePath = resolve(phase3.candidateRoot, 'output/precompute-phase3.sql');
    const phase3Bundle = buildAtomicMigrationBundle({
      verifiedCandidate: phase3, expectedLedger: migrations.slice(0, 13),
      migration: PHASE_3_MIGRATION, outputPath: bundlePath,
    });
    rmSync(bootstrapPath);
    rmSync(bundlePath);
    const artifact: StagingConformanceArtifactV1 = {
      kind: 'candidary.staging-conformance', schemaVersion: 1, status: 'passed',
      candidateSha: PHASE_3_SHA, runId: RUN_ID, approvedMainSha: BASE,
      sources: {
        phase2: {
          sha: PHASE_2_SHA, manifestSha256: phase2.manifestSha256,
          migrationManifestSha256: phase2.manifest.candidate!.migrationManifestSha256,
        },
        phase3: {
          sha: PHASE_3_SHA, manifestSha256: phase3.manifestSha256,
          migrationManifestSha256: phase3.manifest.candidate!.migrationManifestSha256,
        },
      },
      authorizations: {
        reviewSha256: reviewInput.digest, stagingSha256: authorizationInput.digest,
      },
      targets: {
        workflowConformanceSha256: workflowInput.digest, cutoverSha256: cutoverInput.digest,
      },
      migrations: {
        phase2Ledger: [...migrations.slice(0, 13)], phase3Ledger: [...migrations],
        bootstrapSha256: bootstrap.sha256, phase3MigrationSha256: phase3Bundle.migrationHash,
        phase3BundleSha256: phase3Bundle.sha256, triggerNames: [...PRODUCTION_TRIGGER_NAMES],
        zeroCounts, integrity: 'ok', foreignKeyRows: 0,
      },
      deployments: {
        workflowConformance: {
          versionId: '1000000a-0000-4000-8000-000000000011',
          tagSha: PHASE_3_SHA, metadataSha: PHASE_3_SHA, trafficPercent: 100,
        },
        phase2Cutover: {
          versionId: '1000000a-0000-4000-8000-000000000012',
          tagSha: PHASE_2_SHA, metadataSha: PHASE_2_SHA, trafficPercent: 100,
        },
        phase3Cutover: {
          versionId: '1000000a-0000-4000-8000-000000000013',
          tagSha: PHASE_3_SHA, metadataSha: PHASE_3_SHA, trafficPercent: 100,
        },
      },
      matrices: {
        images: completeMatrix(STAGING_IMAGES_CASE_IDS),
        backfillWorkflow: completeMatrix(STAGING_WORKFLOW_CASE_IDS),
        renderWorkflow: completeMatrix(STAGING_WORKFLOW_CASE_IDS),
        routes: completeMatrix(STAGING_ROUTE_CASE_IDS), browser: completeMatrix(STAGING_BROWSER_CASE_IDS),
      },
      cleanup: { workflowConformance: completeDestruction(), cutover: completeDestruction() },
      startedAt: '2026-08-10T12:00:00.000Z', finishedAt: '2026-08-10T14:00:00.000Z',
    };
    const evidenceInput = writeInput(phase3.candidateRoot, 'final-evidence.json', artifact);
    const localAdapters = {
      verifyCandidate(value: { expectedMigrationCount: 13 | 14 | 15 }) {
        if (value.expectedMigrationCount === 15) throw new Error('Historical staging evidence cannot use post-cutover candidates.');
        return value.expectedMigrationCount === 13 ? phase2 : phase3;
      },
    };
    const written = finalizeStagingRelease({
      sha: PHASE_3_SHA, manifestPath: phase3.manifestPath,
      phase2ManifestPath: phase2.manifestPath,
      workflowTargetPath: workflowInput.path, cutoverTargetPath: cutoverInput.path,
      reviewAuthorizationPath: reviewInput.path, authorizationPath: authorizationInput.path,
      evidenceInputPath: evidenceInput.path, runId: RUN_ID,
    }, localAdapters);
    expect(verifyFinalStagingRelease({
      artifactPath: written.path, sidecarPath: `${written.path}.sha256`,
      manifestPath: phase3.manifestPath, phase2ManifestPath: phase2.manifestPath,
      reviewAuthorizationPath: reviewInput.path, authorizationPath: authorizationInput.path,
    }, localAdapters)).toMatchObject({ sha256: written.sha256, artifact });
  });
});

describe('repository-pinned Wrangler path resolution', () => {
  it('resolves isolated main/assets plus real migrations and atomically applies 0013 then 0014 locally', { timeout: 120_000 }, () => {
    const repositoryRoot = resolve(import.meta.dirname, '../..');
    // `npm test` must work in a clean checkout, before `npm run build` creates
    // repository `dist/`. Keep the deployable tree owned by this test while
    // copying the real migration bytes and using the repository-pinned CLI.
    const candidateRoot = tempRoot();
    put(candidateRoot, 'dist/candidary/index.js', [
      'export default {};',
      'export class ExportWorkflow {}',
      'export class CoverRenderWorkflow {}',
      'export class CoverBackfillWorkflow {}',
      '',
    ].join('\n'));
    put(candidateRoot, 'dist/candidary/wrangler.json', `${canonicalJson(generatedConfig())}\n`);
    put(candidateRoot, 'dist/client/index.html', '<!doctype html>\n');
    const repositoryMigrations = collectMigrationManifest(repositoryRoot);
    for (const migration of repositoryMigrations.files) {
      put(candidateRoot, migration.path, readFileSync(resolve(repositoryRoot, migration.path)));
    }
    const artifacts = collectDeployableArtifacts(candidateRoot);
    const migrationManifest = collectMigrationManifest(candidateRoot);
    const historicalMigrationFiles = migrationManifest.files.slice(0, 14);
    expect(migrationManifest).toEqual(repositoryMigrations);
    const candidate = {
      candidateRoot, sha: PHASE_3_SHA, tree: TREE, approvedBaseSha: BASE,
      manifestPath: resolve(candidateRoot, 'output/unused-manifest.json'),
      manifestSha256: '1'.repeat(64),
      manifest: {
        artifacts: {
          deployWranglerConfig: artifacts.deployWranglerConfig, worker: artifacts.worker,
          client: artifacts.client, firstTreeSha256: artifacts.treeSha256,
          secondTreeSha256: artifacts.treeSha256, dryRunWorkerSha256: artifacts.worker.sha256,
        },
        migrations: { manifest: historicalMigrationFiles },
      } as unknown as CandidateManifest,
      migrations: historicalMigrationFiles, migrationCount: 14,
      artifactTreeSha256: artifacts.treeSha256, wranglerVersion: '4.113.0',
      wranglerCliPath: resolve(repositoryRoot, 'node_modules/wrangler/bin/wrangler.js'),
    } satisfies VerifiedReleaseCandidate;
    const ownedBase = resolve(candidateRoot, 'output/staging', PHASE_3_SHA, RUN_ID, 'local-path-proof');
    rmSync(ownedBase, { force: true, recursive: true });
    try {
      const owned = createOwnedStagingDeployRoot(candidate, target('cutover'), ownedBase, []);
      const dryRun = resolve(owned.root, 'wrangler-dry-run');
      execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'deploy', '--dry-run',
        '--config', 'dist/candidary/wrangler.json', '--outdir', dryRun,
      ], { cwd: owned.root, stdio: 'pipe' });
      expect(readFileSync(resolve(dryRun, 'index.js'), 'utf8').length).toBeGreaterThan(0);

      const phase2Candidate = { ...candidate, migrationCount: 13 as const, migrations: candidate.migrations.slice(0, 13) };
      const bootstrapPath = resolve(owned.root, 'phase2-bootstrap.sql');
      const bootstrap = buildPhase2BootstrapBundle({
        verifiedPhase2Candidate: { ...phase2Candidate, candidateRoot: owned.root },
        through: PHASE_2_MIGRATION,
        outputPath: bootstrapPath,
      });
      expect(bootstrap.migrations.at(-1)).toBe(PHASE_2_MIGRATION);
      // workerd's Windows SQLite open still needs a short persistence path.
      const persist = tempRoot();
      execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'migrations', 'list', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json', '--persist-to', persist,
      ], { cwd: owned.root, stdio: 'pipe' });
      execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json', '--file', bootstrapPath, '--persist-to', persist,
      ], { cwd: owned.root, stdio: 'pipe' });
      const atomic = buildAtomicMigrationBundle({
        verifiedCandidate: { ...candidate, candidateRoot: owned.root },
        expectedLedger: migrations.slice(0, 13), migration: PHASE_3_MIGRATION,
        outputPath: resolve(owned.root, 'phase3.sql'),
      });
      execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json', '--file', atomic.outputPath, '--persist-to', persist,
      ], { cwd: owned.root, stdio: 'pipe' });
      const ledger = execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json',
        '--command', 'SELECT name FROM d1_migrations ORDER BY id;', '--persist-to', persist, '--json',
      ], { cwd: owned.root, encoding: 'utf8' });
      expect(ledger).toContain(PHASE_3_MIGRATION);

      const faultPersist = tempRoot();
      execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json', '--file', bootstrapPath,
        '--persist-to', faultPersist,
      ], { cwd: owned.root, stdio: 'pipe' });
      const faultMigrationPath = resolve(owned.root, 'phase3-fault.sql');
      writeFileSync(faultMigrationPath, `${readFileSync(atomic.outputPath, 'utf8')}
INSERT INTO "d1_migrations" (name) VALUES ('${PHASE_2_MIGRATION}');\n`);
      expect(() => execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json', '--file', faultMigrationPath,
        '--persist-to', faultPersist,
      ], { cwd: owned.root, stdio: 'pipe' })).toThrow();
      const faultLedger = execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json',
        '--command', 'SELECT name FROM d1_migrations ORDER BY id;',
        '--persist-to', faultPersist, '--json',
      ], { cwd: owned.root, encoding: 'utf8' });
      expect(faultLedger).toContain(PHASE_2_MIGRATION);
      expect(faultLedger).not.toContain(PHASE_3_MIGRATION);
      const faultTriggers = execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json',
        '--command', "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name;",
        '--persist-to', faultPersist, '--json',
      ], { cwd: owned.root, encoding: 'utf8' });
      for (const triggerName of PRODUCTION_TRIGGER_NAMES) expect(faultTriggers).not.toContain(triggerName);

      const bootstrapFaultPersist = tempRoot();
      const bootstrapFaultPath = resolve(owned.root, 'phase2-bootstrap-fault.sql');
      writeFileSync(bootstrapFaultPath, `${readFileSync(bootstrapPath, 'utf8')}
INSERT INTO "d1_migrations" (name) VALUES ('0001_core.sql');\n`);
      expect(() => execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json', '--file', bootstrapFaultPath,
        '--persist-to', bootstrapFaultPersist,
      ], { cwd: owned.root, stdio: 'pipe' })).toThrow();
      const bootstrapFaultSchema = execFileSync(process.execPath, [
        candidate.wranglerCliPath, 'd1', 'execute', 'DB', '--local',
        '--config', 'dist/candidary/wrangler.json',
        '--command', "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%';",
        '--persist-to', bootstrapFaultPersist, '--json',
      ], { cwd: owned.root, encoding: 'utf8' });
      expect(bootstrapFaultSchema).not.toContain('d1_migrations');
      expect(bootstrapFaultSchema).not.toContain('events');
    } finally {
      rmSync(ownedBase, { force: true, recursive: true });
    }
  });
});

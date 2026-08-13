import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
  assertDeploymentCommandPlan,
  buildDeploymentCommandPlan,
  parseDeployReleaseArgs,
  runDeployRelease,
  type DeployCommand,
  type DeployReleaseAdapters,
} from '../../scripts/deploy-release';
import {
  POST_CUTOVER_PRODUCTION_TRIGGER_NAMES,
  productionTopologySha256,
} from '../../scripts/migrate-release';
import {
  CUTOVER_DISABLED_CAPABILITIES,
  LEGACY_MEDIA_SCANNER_CONTRACT,
} from '../../scripts/media-cutover-release-contract';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const TREE = 'b'.repeat(40);
const APPROVED_BASE = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

const migrationNames = [
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
  '0013_guest_message_hardening.sql',
  '0014_event_cover_invariants.sql',
  '0015_curated_private_guestbook.sql',
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function put(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

const commandIds: ReleaseCommandId[] = [
  'npm-ci', 'verify-bindings', 'typecheck', 'typecheck-e2e', 'lint', 'unit-ui', 'worker', 'build',
  'pwa-before-e2e', 'playwright', 'pwa-after-e2e', 'wrangler-dry-run', 'fresh-d1', 'diff-check',
];

function passedCommand(id: ReleaseCommandId) {
  return {
    id,
    status: 'passed' as const,
    startedAt: '2026-08-03T00:00:00.000Z',
    finishedAt: '2026-08-03T00:00:01.000Z',
    durationMs: 1_000,
    exitCode: 0 as const,
  };
}

interface Fixture {
  root: string;
  manifestPath: string;
  sidecarPath: string;
  npmCliPath: string;
  wranglerCliPath: string;
  manifest: CandidateManifest;
  writeManifest(manifest?: CandidateManifest): Promise<void>;
}

interface PostCutoverMigrationEvidenceFixture {
  path: string;
  evidence: Record<string, unknown>;
  write(evidence?: Record<string, unknown>): Promise<void>;
}

async function candidateFixture(migrationCount: 14 | 15 = 14): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'candidary-deploy-test-'));
  roots.push(root);
  await put(root, 'config/release.json', '{"guestJourneyVersion":1}\n');
  if (migrationCount === 15) {
    const mediaUploadReleaseBytes = `${canonicalJson({
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-cutover-disabled',
      capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
    })}\n`;
    const scannerBytes = `${canonicalJson(LEGACY_MEDIA_SCANNER_CONTRACT)}\n`;
    await put(root, 'config/media-upload-release.json', mediaUploadReleaseBytes);
    await put(root, 'config/legacy-media-scanner.json', scannerBytes);
    await put(
      root,
      'config/legacy-media-scanner.json.sha256',
      `${sha256(scannerBytes)}  legacy-media-scanner.json\n`,
    );
  }
  for (const [index, name] of migrationNames.slice(0, migrationCount).entries()) {
    await put(root, `migrations/${name}`, `select ${index + 1};\n`);
  }
  await put(root, 'dist/candidary/index.js', `worker-${SHA}\n`);
  await put(root, 'dist/client/index.html', '<!doctype html><title>Candidary</title>\n');

  const historicalRequiredSecrets = [
    'TOKEN_HMAC_KEY', 'SESSION_HMAC_KEY', 'GUEST_TOKEN_ENCRYPTION_KEY',
    'LOGIN_HMAC_KEY', 'ENTRY_HMAC_KEY', 'ENTRY_ENCRYPTION_KEY',
    'RSVP_LOOKUP_HMAC_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  ];
  const generatedConfig = {
    name: 'candidary',
    main: 'index.js',
    compatibility_date: '2026-07-21',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    preview_urls: false,
    assets: {
      binding: 'ASSETS',
      directory: '../client',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*'],
    },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    d1_databases: [{
      binding: 'DB', database_name: 'candidary-core',
      database_id: '60bec5de-c8c7-41b5-a26b-2d3f7d184c71', migrations_dir: '../../migrations',
    }],
    r2_buckets: [
      { binding: 'MEDIA_BUCKET', bucket_name: 'candidary-media' },
      ...(migrationCount === 15 ? [{
        binding: 'CANONICAL_MEDIA_BUCKET',
        bucket_name: 'candidary-media-canonical-v2',
      }] : []),
    ],
    images: { binding: 'IMAGES' },
    send_email: [{ name: 'EMAIL' }],
    ratelimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '1001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '1002', simple: { limit: 30, period: 60 } },
      ...(migrationCount === 15 ? [{
        name: 'GUEST_MESSAGE_RATE_LIMIT', namespace_id: '1003', simple: { limit: 120, period: 60 },
      }] : []),
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
      ...(migrationCount === 14 ? {
        R2_ACCOUNT_ID: 'f'.repeat(32),
        R2_BUCKET_NAME: 'candidary-media',
      } : {}),
      EMAIL_FROM: 'hello@candidary.app',
    },
    secrets: {
      required: migrationCount === 15
        ? [
          ...historicalRequiredSecrets.filter((name) =>
            name !== 'R2_ACCESS_KEY_ID' && name !== 'R2_SECRET_ACCESS_KEY'),
          'GUEST_MESSAGE_HMAC_KEY',
        ]
        : historicalRequiredSecrets,
    },
    observability: { enabled: true },
    placement: { mode: 'smart' },
  };
  await put(root, 'dist/candidary/wrangler.json', JSON.stringify(generatedConfig));
  const packageLock = `${canonicalJson({
    lockfileVersion: 3,
    packages: { 'node_modules/wrangler': { version: '4.113.0' } },
  })}\n`;
  const sourceConfig = `${canonicalJson({ ...generatedConfig, main: 'worker/index.ts' })}\n`;
  await put(root, 'package.json', `${canonicalJson({ devDependencies: { wrangler: '4.113.0' } })}\n`);
  await put(root, 'package-lock.json', packageLock);
  await put(root, 'wrangler.jsonc', sourceConfig);
  const npmCliPath = resolve(root, 'tooling/npm-cli.js');
  const wranglerCliPath = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  await put(root, 'tooling/npm-cli.js', '');
  await put(root, 'node_modules/wrangler/bin/wrangler.js', '');
  await put(root, 'node_modules/wrangler/package.json', '{"version":"4.113.0"}\n');

  const migrations = collectMigrationManifest(root);
  const artifacts = collectDeployableArtifacts(root);
  const topology = normalizedBindingTopology(generatedConfig);
  const topologySha = sha256(canonicalJson(topology));
  const emptyStatusSha = sha256('');
  const manifest: CandidateManifest = {
    kind: 'candidary.release-candidate',
    schemaVersion: 1,
    status: 'passed',
    failureCode: null,
    failureObservation: null,
    preconditionObservation: null,
    runId: RUN_ID,
    candidate: {
      gitSha: SHA,
      approvedBaseSha: APPROVED_BASE,
      gitTree: TREE,
      guestJourneyVersion: 1,
      migrationManifestSha256: migrations.sha256,
      packageLockSha256: sha256(packageLock),
      sourceWranglerConfigSha256: sha256(sourceConfig),
    },
    execution: {
      startedAt: '2026-08-03T00:00:00.000Z',
      finishedAt: '2026-08-03T00:01:00.000Z',
      platform: 'win32',
      arch: 'x64',
      initialDetachedHead: true,
      initialHeadSha: SHA,
      initialHeadTree: TREE,
      initialStatusSha256: emptyStatusSha,
      finalDetachedHead: true,
      finalHeadSha: SHA,
      finalHeadTree: TREE,
      finalStatusSha256: emptyStatusSha,
      cleanupSucceeded: true,
      tools: {
        node: '24.0.0', npm: '11.0.0', git: '2.50.0', typescript: '6.0.3', eslint: '10.7.0',
        vite: '8.1.5', vitest: '4.1.10', playwright: '1.61.1', wrangler: '4.113.0',
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
        migrationCount: migrations.files.length,
        ledgerSha256: sha256(canonicalJson(migrations.files.map((file) => file.path.split('/').at(-1)!))),
        foreignKeyRows: 0,
        integrity: 'ok',
        terminalSchema: { events: true, rosterBatchReceipts: true, releaseCertifications: true },
      },
    },
    bindings: {
      topology,
      sourceTopologySha256: topologySha,
      firstBuildTopologySha256: topologySha,
      secondBuildTopologySha256: topologySha,
      generatedTypesSha256: '3'.repeat(64),
    },
    artifacts: {
      deployWranglerConfig: artifacts.deployWranglerConfig,
      worker: artifacts.worker,
      client: artifacts.client,
      firstTreeSha256: artifacts.treeSha256,
      secondTreeSha256: artifacts.treeSha256,
      dryRunWorkerSha256: artifacts.worker.sha256,
    },
    claims: {
      localAutomated: 'passed',
      remoteMigration: 'not_run',
      deployment: 'not_run',
      physicalDevices: 'not_run',
      runtimeCertification: 'not_run',
    },
  };
  const manifestPath = resolve(root, 'output/release', SHA, RUN_ID, 'candidate-manifest.json');
  const sidecarPath = `${manifestPath}.sha256`;
  const writeManifest = async (candidate: CandidateManifest = manifest): Promise<void> => {
    const bytes = `${canonicalJson(candidate)}\n`;
    await put(root, manifestPath.slice(root.length + 1), bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await put(root, sidecarPath.slice(root.length + 1), `${digest}  candidate-manifest.json\n`);
  };
  await writeManifest();
  return { root, manifestPath, sidecarPath, npmCliPath, wranglerCliPath, manifest, writeManifest };
}

async function postCutoverMigrationEvidence(
  fixture: Fixture,
): Promise<PostCutoverMigrationEvidenceFixture> {
  if (fixture.manifest.candidate === null || fixture.manifest.migrations === null
    || fixture.manifest.bindings === null || fixture.manifest.artifacts === null) {
    throw new Error('Post-cutover deploy fixture requires a complete candidate.');
  }
  const evidenceRunId = '22222222-2222-4222-8222-222222222222';
  const ledger = fixture.manifest.migrations.manifest.map((migration) => migration.path.split('/').at(-1)!);
  const terminalMigration = fixture.manifest.migrations.manifest.at(-1)!;
  const evidence: Record<string, unknown> = {
    kind: 'candidary.production-migration-evidence',
    schemaVersion: 2,
    status: 'passed',
    runId: evidenceRunId,
    candidate: {
      sha: SHA,
      approvedMainSha: SHA,
      manifestSha256: sha256(readFileSync(fixture.manifestPath)),
      artifactTreeSha256: fixture.manifest.artifacts.secondTreeSha256,
      bindingTopologySha256: fixture.manifest.bindings.sourceTopologySha256,
    },
    production: {
      topologySha256: productionTopologySha256(fixture.root),
      accountId: 'f'.repeat(32),
      databaseName: 'candidary-core',
      databaseId: '60bec5de-c8c7-41b5-a26b-2d3f7d184c71',
    },
    authorizationSha256: '5'.repeat(64),
    bridge: {
      sha: OTHER_SHA,
      deploymentEvidenceSha256: 'a'.repeat(64),
      versionId: '22222222-2222-4222-8222-222222222299',
      r2SigningTokenId: 'c580e42d532fea4f8cf3897a9c637346',
      revocationEvidenceSha256: 'b'.repeat(64),
      revocationReceiptSha256: 'c'.repeat(64),
      statusObservationSha256: 'd'.repeat(64),
    },
    mediaUploadReleaseConfigSha256: sha256(readFileSync(resolve(
      fixture.root,
      'config/media-upload-release.json',
    ))),
    legacyMediaScannerConfigSha256: sha256(readFileSync(resolve(
      fixture.root,
      'config/legacy-media-scanner.json',
    ))),
    canonicalMediaBucketProvisioningEvidenceSha256: 'e'.repeat(64),
    migration: {
      name: '0015_curated_private_guestbook.sql',
      sha256: terminalMigration.sha256,
      bundleSha256: '6'.repeat(64),
    },
    before: {
      ledger: ledger.slice(0, 14),
      schemaSha256: '7'.repeat(64),
    },
    after: {
      ledger,
      pendingMigrations: [],
      schemaSha256: '8'.repeat(64),
      integrity: 'ok',
      foreignKeyRows: 0,
      triggerNames: [...POST_CUTOVER_PRODUCTION_TRIGGER_NAMES],
      zeroCounts: {
        legacyRows: 0,
        blockingJobs: 0,
        incompleteActiveSets: 0,
        uploadsWithoutActiveSet: 0,
      },
    },
    rollback: {
      bookmarkSha256: '9'.repeat(64),
      bookmarkRecordedAt: '2026-08-10T11:55:00.000Z',
      rollbackOwner: 'database-owner',
    },
    observedAt: '2026-08-10T12:05:00.000Z',
  };
  const path = resolve(
    fixture.root,
    'output/production-migration',
    SHA,
    evidenceRunId,
    'post-cutover-migration-evidence.json',
  );
  const write = async (value: Record<string, unknown> = evidence): Promise<void> => {
    const bytes = `${canonicalJson(value)}\n`;
    await put(fixture.root, path.slice(fixture.root.length + 1), bytes);
    await put(
      fixture.root,
      `${path.slice(fixture.root.length + 1)}.sha256`,
      `${sha256(bytes)}  post-cutover-migration-evidence.json\n`,
    );
  };
  await write();
  return { path, evidence, write };
}

interface AdapterOptions {
  resolvedCommit?: string;
  headSha?: string;
  initialTree?: string;
  finalTree?: string;
  initialStatus?: string;
  finalStatus?: string;
  failCommand?: DeployCommand['id'];
  onRun?: (command: DeployCommand) => void;
}

function fakeAdapters(fixture: Fixture, options: AdapterOptions = {}) {
  const commands: DeployCommand[] = [];
  let statusReads = 0;
  let treeReads = 0;
  const adapters: DeployReleaseAdapters = {
    nodeExecPath: process.execPath,
    npmExecPath: fixture.npmCliPath,
    environment: {},
    git(args) {
      if (args[0] === 'status') {
        const status = statusReads === 0 ? options.initialStatus ?? '' : options.finalStatus ?? '';
        statusReads += 1;
        return status;
      }
      const revision = args.at(-1);
      if (revision === `${SHA}^{commit}`) return `${options.resolvedCommit ?? SHA}\n`;
      if (revision === 'HEAD^{commit}') return `${options.headSha ?? SHA}\n`;
      if (revision === 'HEAD^{tree}') {
        const tree = treeReads === 0 ? options.initialTree ?? TREE : options.finalTree ?? TREE;
        treeReads += 1;
        return `${tree}\n`;
      }
      throw new Error(`Unexpected Git command: ${args.join(' ')}`);
    },
    run(command) {
      commands.push(command);
      options.onRun?.(command);
      return command.id === options.failCommand ? 1 : 0;
    },
  };
  return { adapters, commands };
}

describe('guarded release deployment', () => {
  it('preserves the historical 14-migration deployment contract without post-cutover evidence', async () => {
    const fixture = await candidateFixture(14);
    const run = fakeAdapters(fixture);
    expect(() => runDeployRelease({
      candidateRoot: fixture.root, sha: SHA, manifestPath: fixture.manifestPath,
    }, run.adapters)).not.toThrow();
    expect(run.commands.map((command) => command.id)).toEqual([
      'npm-ci', 'build', 'verify-pwa-build', 'deploy',
    ]);
  });

  it('refuses a 15-migration deployment without exact post-cutover migration evidence', async () => {
    const fixture = await candidateFixture(15);
    const run = fakeAdapters(fixture);
    expect(() => runDeployRelease({
      candidateRoot: fixture.root, sha: SHA, manifestPath: fixture.manifestPath,
    }, run.adapters)).toThrow(/migration evidence|post-cutover/iu);
    expect(run.commands).toHaveLength(0);
  });

  it('requires canonical migration-closure proof before a 15-migration deployment', async () => {
    const fixture = await candidateFixture(15);
    const migrationEvidence = await postCutoverMigrationEvidence(fixture);
    const deploymentRequest = {
      candidateRoot: fixture.root,
      sha: SHA,
      manifestPath: fixture.manifestPath,
      migrationEvidencePath: migrationEvidence.path,
    } as Parameters<typeof runDeployRelease>[0];
    const run = fakeAdapters(fixture);
    expect(() => runDeployRelease(deploymentRequest, run.adapters)).not.toThrow();
    expect(run.commands.map((command) => command.id)).toEqual([
      'npm-ci', 'build', 'verify-pwa-build', 'deploy',
    ]);

    const mutations: Array<(evidence: Record<string, unknown>) => void> = [
      (evidence) => {
        (evidence.candidate as Record<string, unknown>).bindingTopologySha256 = '0'.repeat(64);
      },
      (evidence) => {
        ((evidence.after as Record<string, unknown>).ledger as string[]).pop();
      },
      (evidence) => {
        (evidence.migration as Record<string, unknown>).sha256 = '0'.repeat(64);
      },
      (evidence) => {
        (evidence.after as Record<string, unknown>).pendingMigrations = ['0015_curated_private_guestbook.sql'];
      },
    ];
    for (const mutate of mutations) {
      const mutatedFixture = await candidateFixture(15);
      const mutatedEvidence = await postCutoverMigrationEvidence(mutatedFixture);
      const value = structuredClone(mutatedEvidence.evidence);
      mutate(value);
      await mutatedEvidence.write(value);
      const mutatedRun = fakeAdapters(mutatedFixture);
      expect(() => runDeployRelease({
        candidateRoot: mutatedFixture.root,
        sha: SHA,
        manifestPath: mutatedFixture.manifestPath,
        migrationEvidencePath: mutatedEvidence.path,
      } as Parameters<typeof runDeployRelease>[0], mutatedRun.adapters)).toThrow();
      expect(mutatedRun.commands).toHaveLength(0);
    }
  });

  it('accepts Candidate A migration evidence for a distinct compatible copy-only or live candidate', async () => {
    const candidateA = await candidateFixture(15);
    const laterCandidate = await candidateFixture(15);
    const migrationEvidence = await postCutoverMigrationEvidence(candidateA);
    const candidateAEvidence = structuredClone(migrationEvidence.evidence);
    const candidateAIdentity = candidateAEvidence.candidate as Record<string, unknown>;
    candidateAIdentity.sha = OTHER_SHA;
    candidateAIdentity.approvedMainSha = OTHER_SHA;
    candidateAIdentity.manifestSha256 = '1'.repeat(64);
    candidateAIdentity.artifactTreeSha256 = '2'.repeat(64);
    await migrationEvidence.write(candidateAEvidence);
    const run = fakeAdapters(laterCandidate);

    expect(() => runDeployRelease({
      candidateRoot: laterCandidate.root,
      sha: SHA,
      manifestPath: laterCandidate.manifestPath,
      migrationEvidencePath: migrationEvidence.path,
    } as Parameters<typeof runDeployRelease>[0], run.adapters)).not.toThrow();
    expect(run.commands.map((command) => command.id)).toEqual([
      'npm-ci', 'build', 'verify-pwa-build', 'deploy',
    ]);
  });

  it('requires one exact SHA and existing candidate manifest argument', async () => {
    const fixture = await candidateFixture();
    const postCutover = await candidateFixture(15);
    const migrationEvidence = await postCutoverMigrationEvidence(postCutover);
    expect(() => parseDeployReleaseArgs([])).toThrow();
    expect(() => parseDeployReleaseArgs(['--sha', 'HEAD', '--manifest', fixture.manifestPath])).toThrow();
    expect(() => parseDeployReleaseArgs(['--sha', SHA.slice(0, 39), '--manifest', fixture.manifestPath])).toThrow();
    expect(() => parseDeployReleaseArgs(['--sha', SHA])).toThrow();
    expect(() => parseDeployReleaseArgs(['--sha', SHA, '--manifest', join(fixture.root, 'missing.json')])).toThrow();
    expect(parseDeployReleaseArgs(['--manifest', fixture.manifestPath, '--sha', SHA])).toEqual({
      sha: SHA,
      manifestPath: fixture.manifestPath,
    });
    expect(parseDeployReleaseArgs([
      '--migration-evidence', migrationEvidence.path,
      '--manifest', postCutover.manifestPath,
      '--sha', SHA,
    ])).toEqual({
      sha: SHA,
      manifestPath: postCutover.manifestPath,
      migrationEvidencePath: migrationEvidence.path,
    });
  });

  it('schema-validates the manifest before selecting its migration boundary', async () => {
    const fixture = await candidateFixture();
    await writeFile(fixture.manifestPath, JSON.stringify({
      status: 'passed',
      candidate: {},
      migrations: {},
      bindings: {},
      artifacts: {},
    }), 'utf8');
    const run = fakeAdapters(fixture);

    expect(() => runDeployRelease({
      candidateRoot: fixture.root, sha: SHA, manifestPath: fixture.manifestPath,
    }, run.adapters)).toThrow(/candidate manifest has unknown or missing keys/iu);
    expect(run.commands).toHaveLength(0);
  });

  it('rejects sidecar, failed-manifest, journey, and current-migration mismatches before deploy', async () => {
    const sidecar = await candidateFixture();
    await writeFile(sidecar.sidecarPath, `${'0'.repeat(64)}  candidate-manifest.json\n`, 'utf8');
    const sidecarRun = fakeAdapters(sidecar);
    expect(() => runDeployRelease({
      candidateRoot: sidecar.root, sha: SHA, manifestPath: sidecar.manifestPath,
    }, sidecarRun.adapters)).toThrow();
    expect(sidecarRun.commands).toHaveLength(0);

    const failed = await candidateFixture();
    failed.manifest.status = 'failed';
    await failed.writeManifest();
    const failedRun = fakeAdapters(failed);
    expect(() => runDeployRelease({
      candidateRoot: failed.root, sha: SHA, manifestPath: failed.manifestPath,
    }, failedRun.adapters)).toThrow();
    expect(failedRun.commands).toHaveLength(0);

    const journey = await candidateFixture();
    journey.manifest.candidate!.guestJourneyVersion = 2;
    await journey.writeManifest();
    const journeyRun = fakeAdapters(journey);
    expect(() => runDeployRelease({
      candidateRoot: journey.root, sha: SHA, manifestPath: journey.manifestPath,
    }, journeyRun.adapters)).toThrow();
    expect(journeyRun.commands).toHaveLength(0);

    const migrations = await candidateFixture();
    await put(migrations.root, 'migrations/0002_added.sql', 'select 2;\n');
    const migrationRun = fakeAdapters(migrations);
    expect(() => runDeployRelease({
      candidateRoot: migrations.root, sha: SHA, manifestPath: migrations.manifestPath,
    }, migrationRun.adapters)).toThrow();
    expect(migrationRun.commands).toHaveLength(0);
  });

  it('rejects unresolved identity, wrong HEAD/tree, and initial dirt before any process runs', async () => {
    for (const options of [
      { resolvedCommit: OTHER_SHA },
      { headSha: OTHER_SHA },
      { initialTree: 'd'.repeat(40) },
      { initialStatus: '?? caller-owned.txt\n' },
    ]) {
      const fixture = await candidateFixture();
      const run = fakeAdapters(fixture, options);
      expect(() => runDeployRelease({
        candidateRoot: fixture.root, sha: SHA, manifestPath: fixture.manifestPath,
      }, run.adapters)).toThrow();
      expect(run.commands).toHaveLength(0);
    }
  });

  it('rejects rebuilt artifact mismatch, failed commands, and post-build Git drift without deploying', async () => {
    const artifact = await candidateFixture();
    const artifactRun = fakeAdapters(artifact, {
      onRun(command) {
        if (command.id === 'build') {
          writeFileSync(join(artifact.root, 'dist/candidary/index.js'), 'different worker\n', 'utf8');
        }
      },
    });
    expect(() => runDeployRelease({
      candidateRoot: artifact.root, sha: SHA, manifestPath: artifact.manifestPath,
    }, artifactRun.adapters)).toThrow();
    expect(artifactRun.commands.map((command) => command.id)).not.toContain('deploy');

    const failedCommand = await candidateFixture();
    const failedCommandRun = fakeAdapters(failedCommand, { failCommand: 'build' });
    expect(() => runDeployRelease({
      candidateRoot: failedCommand.root, sha: SHA, manifestPath: failedCommand.manifestPath,
    }, failedCommandRun.adapters)).toThrow();
    expect(failedCommandRun.commands.map((command) => command.id)).toEqual(['npm-ci', 'build']);

    const drift = await candidateFixture();
    const driftRun = fakeAdapters(drift, { finalStatus: ' M worker/app.ts\n' });
    expect(() => runDeployRelease({
      candidateRoot: drift.root, sha: SHA, manifestPath: drift.manifestPath,
    }, driftRun.adapters)).toThrow();
    expect(driftRun.commands.map((command) => command.id)).toEqual([
      'npm-ci', 'build', 'verify-pwa-build',
    ]);
  });

  it('uses only node-invoked local CLIs and the exact tagged production deploy command', async () => {
    const fixture = await candidateFixture();
    const run = fakeAdapters(fixture);
    runDeployRelease({
      candidateRoot: fixture.root,
      sha: SHA,
      manifestPath: fixture.manifestPath,
    }, run.adapters);

    expect(run.commands.map((command) => command.id)).toEqual([
      'npm-ci', 'build', 'verify-pwa-build', 'deploy',
    ]);
    expect(run.commands.every((command) => command.executable === process.execPath)).toBe(true);
    expect(run.commands.slice(0, 3).every((command) => command.cwd === fixture.root && command.shell === false)).toBe(true);
    expect(run.commands[3]!.cwd).not.toBe(fixture.root);
    expect(run.commands[3]!.shell).toBe(false);
    expect(run.commands[0]!.args).toEqual([fixture.npmCliPath, 'ci']);
    expect(run.commands[1]!.args).toEqual([fixture.npmCliPath, 'run', 'build']);
    expect(run.commands[2]!.args).toEqual([fixture.npmCliPath, 'run', 'verify:pwa-build']);
    expect(run.commands[3]!.args).toEqual([
      fixture.wranglerCliPath,
      'deploy',
      '--config',
      'dist/candidary/wrangler.json',
      '--strict',
      '--tag',
      SHA,
    ]);
    const serialized = JSON.stringify(run.commands);
    expect(serialized).not.toMatch(/\.cmd|\bnpx\b|--dry-run|\bd1\b|secret/iu);
  });

  it('deploys only an isolated snapshot of the verified artifact bytes', async () => {
    const fixture = await candidateFixture();
    const originalWorker = readFileSync(join(fixture.root, 'dist/candidary/index.js'), 'utf8');
    const originalConfig = readFileSync(join(fixture.root, 'dist/candidary/wrangler.json'), 'utf8');
    let deployRoot = '';
    let deployedWorker = '';
    let deployedConfig = '';
    const run = fakeAdapters(fixture, {
      onRun(command) {
        if (command.id !== 'deploy') return;
        deployRoot = command.cwd;
        writeFileSync(join(fixture.root, 'dist/candidary/index.js'), 'swapped after verification\n', 'utf8');
        writeFileSync(
          join(fixture.root, 'dist/candidary/wrangler.json'),
          JSON.stringify({ main: 'different.js', assets: { directory: '../client' } }),
          'utf8',
        );
        deployedWorker = readFileSync(join(command.cwd, 'dist/candidary/index.js'), 'utf8');
        deployedConfig = readFileSync(join(command.cwd, 'dist/candidary/wrangler.json'), 'utf8');
      },
    });

    runDeployRelease({
      candidateRoot: fixture.root,
      sha: SHA,
      manifestPath: fixture.manifestPath,
    }, run.adapters);

    expect(deployRoot).not.toBe(fixture.root);
    expect(deployedWorker).toBe(originalWorker);
    expect(JSON.parse(deployedConfig)).toEqual(JSON.parse(originalConfig));
    expect(existsSync(deployRoot)).toBe(false);
  });

  it('withholds deployment credentials from every prerequisite process', async () => {
    const fixture = await candidateFixture();
    const run = fakeAdapters(fixture);
    const deploymentEnvironment: NodeJS.ProcessEnv = {
      PATH: 'C:\\tooling',
      CLOUDFLARE_API_TOKEN: 'deploy-only',
      SESSION_HMAC_KEY: 'worker-secret',
      VITE_ACCIDENTAL_SECRET: 'client-visible',
      UNRELATED_VALUE: 'not-needed-by-build',
    };
    (run.adapters as DeployReleaseAdapters & { environment: NodeJS.ProcessEnv }).environment =
      deploymentEnvironment;

    runDeployRelease({
      candidateRoot: fixture.root,
      sha: SHA,
      manifestPath: fixture.manifestPath,
    }, run.adapters);

    for (const command of run.commands.slice(0, 3)) {
      const environment = (command as DeployCommand & { env?: NodeJS.ProcessEnv }).env;
      expect(environment).toMatchObject({
        PATH: 'C:\\tooling',
        CI: '1',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
      });
      expect(environment).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
      expect(environment).not.toHaveProperty('SESSION_HMAC_KEY');
      expect(environment).not.toHaveProperty('VITE_ACCIDENTAL_SECRET');
      expect(environment).not.toHaveProperty('UNRELATED_VALUE');
    }
    expect((run.commands[3] as DeployCommand & { env?: NodeJS.ProcessEnv }).env)
      .toBe(deploymentEnvironment);
  });

  it('fails closed when a deployment plan loses its exact config, strictness, or tag', async () => {
    const fixture = await candidateFixture();
    const input = {
      candidateRoot: fixture.root,
      deployRoot: resolve(fixture.root, 'sealed-deploy'),
      sha: SHA,
      nodeExecPath: process.execPath,
      npmCliPath: fixture.npmCliPath,
      wranglerCliPath: fixture.wranglerCliPath,
      prerequisiteEnv: {},
      deployEnv: {},
    };
    const plan = buildDeploymentCommandPlan(input);
    expect(() => assertDeploymentCommandPlan(plan, input)).not.toThrow();
    for (const args of [
      [fixture.wranglerCliPath, 'deploy', '--config', 'wrangler.jsonc', '--strict', '--tag', SHA],
      [fixture.wranglerCliPath, 'deploy', '--config', 'dist/candidary/wrangler.json', '--tag', SHA],
      [fixture.wranglerCliPath, 'deploy', '--config', 'dist/candidary/wrangler.json', '--strict', '--tag', OTHER_SHA],
    ]) {
      const mutated = structuredClone(plan);
      mutated[3]!.args = args;
      expect(() => assertDeploymentCommandPlan(mutated, input)).toThrow();
    }
  });
});

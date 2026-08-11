// @vitest-environment node

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256, type CandidateManifest } from '../../scripts/release-evidence';
import {
  PHASE_2_MIGRATION,
  PHASE_3_MIGRATION,
  buildAtomicMigrationBundle,
  type VerifiedReleaseCandidate,
} from '../../scripts/release-candidate';
import {
  PRODUCTION_TRIGGER_NAMES,
  parseMigrateReleaseArgs,
  productionTopologySha256,
  runMigrateRelease,
  type MigrateReleaseAdapters,
  type ProductionDatabaseObservation,
  type ProductionMigrationAuthorizationV1,
  type ProductionMigrationCommand,
  type TimeTravelBookmarkV1,
} from '../../scripts/migrate-release';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const ACCOUNT = 'f'.repeat(32);
const DATABASE_ID = '60bec5de-c8c7-41b5-a26b-2d3f7d184c71';
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const NOW = '2026-08-10T12:00:00.000Z';
const roots = new Set<string>();

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
  PHASE_2_MIGRATION,
  PHASE_3_MIGRATION,
] as const;

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-production-migrate-'));
  roots.add(root);
  return root;
}

function put(root: string, path: string, contents: string): string {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  return target;
}

function productionConfig(): Record<string, unknown> {
  return {
    name: 'candidary', main: 'index.js', workers_dev: false, preview_urls: false,
    compatibility_date: '2026-07-21', compatibility_flags: ['nodejs_compat'],
    assets: {
      binding: 'ASSETS', directory: '../client',
      not_found_handling: 'single-page-application', run_worker_first: ['/api/*'],
    },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    d1_databases: [{
      binding: 'DB', database_name: 'candidary-core', database_id: DATABASE_ID,
      migrations_dir: '../../migrations',
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
      R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: 'candidary-media', EMAIL_FROM: 'hello@candidary.app',
    },
    secrets: { required: [
      'TOKEN_HMAC_KEY', 'SESSION_HMAC_KEY', 'GUEST_TOKEN_ENCRYPTION_KEY',
      'LOGIN_HMAC_KEY', 'ENTRY_HMAC_KEY', 'ENTRY_ENCRYPTION_KEY',
      'RSVP_LOOKUP_HMAC_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    ] },
    observability: { enabled: true }, placement: { mode: 'smart' }, no_bundle: true,
  };
}

interface Fixture {
  root: string;
  verified: VerifiedReleaseCandidate;
  manifestPath: string;
  authorizationPath: string;
  bookmarkPath: string;
  authorization: ProductionMigrationAuthorizationV1;
  bookmark: TimeTravelBookmarkV1;
  pre: ProductionDatabaseObservation;
  post: ProductionDatabaseObservation;
}

function writeCanonicalInput(path: string, value: unknown): string {
  const bytes = `${canonicalJson(value)}\n`;
  put(dirname(path), basename(path), bytes);
  const digest = sha256(bytes);
  put(dirname(path), `${basename(path)}.sha256`, `${digest}  ${basename(path)}\n`);
  return digest;
}

function fixture(): Fixture {
  const root = temporaryRoot();
  const migrationFiles = migrationNames.map((name, index) => {
    const contents = index === 13
      ? 'CREATE TABLE phase_3_guard (id INTEGER);\n'
      : `SELECT ${index + 1};\n`;
    put(root, `migrations/${name}`, contents);
    return {
      path: `migrations/${name}`,
      bytes: Buffer.byteLength(contents),
      sha256: sha256(contents),
    };
  });
  put(root, 'dist/candidary/wrangler.json', `${canonicalJson(productionConfig())}\n`);
  const wranglerCliPath = put(root, 'node_modules/wrangler/bin/wrangler.js', 'fixture\n');
  const manifestPath = put(root, 'candidate-manifest.json', '{}\n');
  const verified = {
    candidateRoot: root, sha: SHA, tree: TREE, approvedBaseSha: BASE,
    manifestPath, manifestSha256: '1'.repeat(64), manifest: {} as CandidateManifest,
    migrations: migrationFiles, migrationCount: 14,
    artifactTreeSha256: '2'.repeat(64), wranglerVersion: '4.113.0', wranglerCliPath,
  } satisfies VerifiedReleaseCandidate;

  const scratch = resolve(root, 'output/precomputed.sql');
  const precomputed = buildAtomicMigrationBundle({
    verifiedCandidate: verified,
    expectedLedger: migrationNames.slice(0, 13),
    migration: PHASE_3_MIGRATION,
    outputPath: scratch,
  });
  rmSync(scratch);

  const bookmarkPath = resolve(root, 'bookmark.json');
  const bookmark: TimeTravelBookmarkV1 = {
    kind: 'candidary.d1-time-travel-bookmark', schemaVersion: 1,
    accountId: ACCOUNT, databaseName: 'candidary-core', databaseId: DATABASE_ID,
    bookmarkId: 'bookmark-20260810-production', recordedAt: '2026-08-10T11:55:00.000Z',
  };
  const bookmarkSha256 = writeCanonicalInput(bookmarkPath, bookmark);
  const authorizationPath = resolve(root, 'authorization.json');
  const authorization: ProductionMigrationAuthorizationV1 = {
    kind: 'candidary.production-migration-authorization', schemaVersion: 1, runId: RUN_ID,
    approvedMainSha: SHA, candidateSha: SHA, manifestSha256: verified.manifestSha256,
    productionTopologySha256: productionTopologySha256(root),
    accountId: ACCOUNT, databaseName: 'candidary-core', databaseId: DATABASE_ID,
    migrationName: PHASE_3_MIGRATION,
    migrationSha256: migrationFiles.at(-1)!.sha256,
    bundleSha256: precomputed.sha256, bookmarkSha256,
    preSchemaSha256: '3'.repeat(64), postSchemaSha256: '4'.repeat(64),
    authorizedAt: '2026-08-10T11:56:00.000Z', expiresAt: '2026-08-10T13:00:00.000Z',
    noDeployWindowOwner: 'release-owner', rollbackOwner: 'database-owner',
  };
  writeCanonicalInput(authorizationPath, authorization);
  const zeroCounts = {
    legacyRows: 0, blockingJobs: 0, incompleteActiveSets: 0, uploadsWithoutActiveSet: 0,
  } as const;
  const pre: ProductionDatabaseObservation = {
    ledger: [...migrationNames.slice(0, 13)], pendingMigrations: [PHASE_3_MIGRATION],
    schemaSha256: authorization.preSchemaSha256, integrity: 'ok', foreignKeyRows: 0,
    triggerNames: [], zeroCounts,
  };
  const post: ProductionDatabaseObservation = {
    ledger: [...migrationNames], pendingMigrations: [],
    schemaSha256: authorization.postSchemaSha256, integrity: 'ok', foreignKeyRows: 0,
    triggerNames: [...PRODUCTION_TRIGGER_NAMES], zeroCounts,
  };
  return {
    root, verified, manifestPath, authorizationPath, bookmarkPath, authorization, bookmark, pre, post,
  };
}

function fakeAdapters(
  source: Fixture,
  options: {
    verifyError?: Error;
    states?: ProductionDatabaseObservation[];
    exitCode?: number;
    hash?: string;
  } = {},
): { adapters: MigrateReleaseAdapters; commands: ProductionMigrationCommand[]; verifyCalls: number } {
  const commands: ProductionMigrationCommand[] = [];
  let stateIndex = 0;
  const holder = {
    verifyCalls: 0,
    adapters: {
      now: () => NOW,
      verifyCandidate() {
        holder.verifyCalls += 1;
        if (options.verifyError) throw options.verifyError;
        return source.verified;
      },
      observeDatabase() {
        const states = options.states ?? [source.pre, source.post];
        return states[Math.min(stateIndex++, states.length - 1)]!;
      },
      hashFile(path) {
        return options.hash ?? sha256(readFileSync(path));
      },
      run(command) {
        commands.push(command);
        expect(readFileSync(command.bundlePath, 'utf8')).toContain(PHASE_3_MIGRATION);
        return options.exitCode ?? 0;
      },
    } satisfies MigrateReleaseAdapters,
    commands,
  };
  return holder;
}

function request(source: Fixture) {
  return {
    candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
    authorizationPath: source.authorizationPath, bookmarkPath: source.bookmarkPath,
  };
}

describe('production migration CLI', () => {
  it('accepts only the exact five required arguments and regular inputs', () => {
    const source = fixture();
    expect(parseMigrateReleaseArgs([
      '--sha', SHA, '--manifest', source.manifestPath,
      '--authorization', source.authorizationPath, '--bookmark', source.bookmarkPath,
    ], source.root)).toEqual({
      sha: SHA, manifestPath: source.manifestPath,
      authorizationPath: source.authorizationPath, bookmarkPath: source.bookmarkPath,
    });
    expect(() => parseMigrateReleaseArgs(['--sha', SHA], source.root)).toThrow(/missing|required/u);
    expect(() => parseMigrateReleaseArgs([
      '--sha', SHA, '--sha', SHA, '--manifest', source.manifestPath,
      '--authorization', source.authorizationPath, '--bookmark', source.bookmarkPath,
    ], source.root)).toThrow(/duplicate|unknown/u);
  });
});

describe('guarded production migration', () => {
  it('rechecks the exact candidate and runs only the pinned atomic 0014 import', () => {
    const source = fixture();
    const run = fakeAdapters(source);
    const result = runMigrateRelease(request(source), run.adapters);

    expect(run.verifyCalls).toBe(2);
    expect(run.commands).toHaveLength(1);
    const command = run.commands[0]!;
    expect(command).toMatchObject({ executable: process.execPath, cwd: source.root, shell: false });
    expect(command.args).toEqual([
      source.verified.wranglerCliPath,
      'd1', 'execute', 'DB', '--remote',
      '--config', 'dist/candidary/wrangler.json',
      '--file', command.bundlePath,
    ]);
    expect(JSON.stringify(command)).not.toMatch(/migrations apply|npx|restore/iu);
    expect(result).toMatchObject({
      candidateSha: SHA, migrationName: PHASE_3_MIGRATION,
      bundleSha256: source.authorization.bundleSha256,
    });
    expect(() => readFileSync(command.bundlePath)).toThrow();
  });

  it('rejects candidate, authorization, bookmark, topology, expiry, and bundle drift before writing', () => {
    const candidate = fixture();
    const candidateRun = fakeAdapters(candidate, { verifyError: new Error('candidate checkout is dirty') });
    expect(() => runMigrateRelease(request(candidate), candidateRun.adapters)).toThrow(/dirty/u);
    expect(candidateRun.commands).toHaveLength(0);

    const mutations: Array<(source: Fixture) => void> = [
      (source) => { source.authorization.candidateSha = 'c'.repeat(40); },
      (source) => { source.authorization.productionTopologySha256 = '5'.repeat(64); },
      (source) => { source.authorization.databaseId = '00000000-0000-4000-8000-000000000000'; },
      (source) => { source.authorization.expiresAt = '2026-08-10T11:59:59.000Z'; },
      (source) => { source.authorization.bookmarkSha256 = '6'.repeat(64); },
      (source) => { source.authorization.bundleSha256 = '7'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const source = fixture();
      mutate(source);
      writeCanonicalInput(source.authorizationPath, source.authorization);
      const run = fakeAdapters(source);
      expect(() => runMigrateRelease(request(source), run.adapters)).toThrow();
      expect(run.commands).toHaveLength(0);
    }

    const sidecar = fixture();
    writeFileSync(`${sidecar.bookmarkPath}.sha256`, `${'0'.repeat(64)}  bookmark.json\n`);
    const sidecarRun = fakeAdapters(sidecar);
    expect(() => runMigrateRelease(request(sidecar), sidecarRun.adapters)).toThrow(/sidecar|digest/u);
    expect(sidecarRun.commands).toHaveLength(0);

    const bundle = fixture();
    const bundleRun = fakeAdapters(bundle, { hash: '0'.repeat(64) });
    expect(() => runMigrateRelease(request(bundle), bundleRun.adapters)).toThrow(/bundle/u);
    expect(bundleRun.commands).toHaveLength(0);
  });

  it('requires exactly the Phase-2 ledger, sole pending 0014, zero proofs, integrity, and repository CLI', () => {
    const cases: ProductionDatabaseObservation[] = [
      { ...fixture().pre, ledger: migrationNames.slice(0, 12) },
      { ...fixture().pre, pendingMigrations: [PHASE_3_MIGRATION, '0015_unknown.sql'] },
      { ...fixture().pre, integrity: 'failed' as 'ok' },
      { ...fixture().pre, foreignKeyRows: 1 as 0 },
      { ...fixture().pre, zeroCounts: { ...fixture().pre.zeroCounts, legacyRows: 1 } },
    ];
    for (const pre of cases) {
      const source = fixture();
      const run = fakeAdapters(source, { states: [pre] });
      expect(() => runMigrateRelease(request(source), run.adapters)).toThrow();
      expect(run.commands).toHaveLength(0);
    }

    const cli = fixture();
    cli.verified.wranglerCliPath = resolve(cli.root, '..', 'wrangler.js');
    const run = fakeAdapters(cli);
    expect(() => runMigrateRelease(request(cli), run.adapters)).toThrow(/Wrangler|candidate root/u);
    expect(run.commands).toHaveLength(0);

    const unclassified = fixture();
    put(unclassified.root, 'dist/candidary/wrangler.json', `${canonicalJson({
      ...productionConfig(), kv_namespaces: [{ binding: 'LEAK', id: 'production' }],
    })}\n`);
    expect(() => productionTopologySha256(unclassified.root)).toThrow(/unclassified|kv_namespaces/u);
  });

  it('on command failure proves exact rollback and rejects any residual state', () => {
    const unchanged = fixture();
    const unchangedRun = fakeAdapters(unchanged, { exitCode: 1, states: [unchanged.pre, unchanged.pre] });
    expect(() => runMigrateRelease(request(unchanged), unchangedRun.adapters)).toThrow(/failed/u);
    expect(unchangedRun.commands).toHaveLength(1);

    const residual = fixture();
    const residualRun = fakeAdapters(residual, { exitCode: 1, states: [residual.pre, residual.post] });
    expect(() => runMigrateRelease(request(residual), residualRun.adapters)).toThrow(/residual|rollback/u);
    expect(residualRun.commands).toHaveLength(1);
  });

  it('rejects a successful command until the exact post-migration closure is observed', () => {
    for (const post of [
      { ...fixture().post, ledger: migrationNames.slice(0, 13) },
      { ...fixture().post, schemaSha256: '9'.repeat(64) },
      { ...fixture().post, triggerNames: PRODUCTION_TRIGGER_NAMES.slice(0, -1) },
      { ...fixture().post, pendingMigrations: [PHASE_3_MIGRATION] },
    ]) {
      const source = fixture();
      const run = fakeAdapters(source, { states: [source.pre, post] });
      expect(() => runMigrateRelease(request(source), run.adapters)).toThrow(/post|ledger|schema|trigger|pending/u);
      expect(run.commands).toHaveLength(1);
    }
  });
});

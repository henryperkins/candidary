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
  POST_CUTOVER_MIGRATION,
  buildAtomicMigrationBundle,
  type VerifiedReleaseCandidate,
} from '../../scripts/release-candidate';
import {
  POST_CUTOVER_PRODUCTION_TRIGGER_NAMES,
  PRODUCTION_TRIGGER_NAMES,
  historicalPhase3ProductionTopologySha256,
  parseMigrateReleaseArgs,
  productionTopologySha256,
  runMigrateRelease,
  type MigrateReleaseAdapters,
  type ProductionDatabaseObservation,
  type ProductionMigrationAuthorizationV1,
  type ProductionMigrationCommand,
  type TimeTravelBookmarkV1,
} from '../../scripts/migrate-release';
import {
  CANONICAL_COPY_ONLY_CAPABILITIES,
  CANONICAL_LIVE_CAPABILITIES,
  CANONICAL_MEDIA_BINDING,
  CANONICAL_MEDIA_BUCKET_NAME,
  CUTOVER_DISABLED_CAPABILITIES,
  LEGACY_MEDIA_SCANNER_CONTRACT,
  LEGACY_MEDIA_BINDING,
  LEGACY_MEDIA_BUCKET_NAME,
  type CanonicalMediaBucketProvisioningEvidenceV1,
} from '../../scripts/media-cutover-release-contract';
import {
  BRIDGE_CAPABILITIES,
  BRIDGE_SOURCE_MAIN_SHA,
  type MediaWriteBridgeDeploymentEvidenceV1,
  type R2SigningTokenRevocationEvidenceV1,
} from '../../scripts/bridge-release-contract';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BASE = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const ACCOUNT = 'f'.repeat(32);
const DATABASE_ID = '60bec5de-c8c7-41b5-a26b-2d3f7d184c71';
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const NOW = '2026-08-10T12:00:00.000Z';
const TOKEN_ID = 'c580e42d532fea4f8cf3897a9c637346';
const BRIDGE_SHA = 'c'.repeat(40);
const BRIDGE_VERSION_ID = '1000000a-0000-4000-8000-000000000099';
const roots = new Set<string>();

const POST_CUTOVER_TRIGGER_NAMES = POST_CUTOVER_PRODUCTION_TRIGGER_NAMES;

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

function postCutoverProductionConfig(): Record<string, unknown> {
  const config = productionConfig();
  (config.r2_buckets as unknown[]).push({
    binding: CANONICAL_MEDIA_BINDING,
    bucket_name: CANONICAL_MEDIA_BUCKET_NAME,
  });
  (config.ratelimits as unknown[]).push({
    name: 'GUEST_MESSAGE_RATE_LIMIT', namespace_id: '1003', simple: { limit: 120, period: 60 },
  });
  const required = (config.secrets as { required: string[] }).required;
  (config.secrets as { required: string[] }).required = required
    .filter((name) => name !== 'R2_ACCESS_KEY_ID' && name !== 'R2_SECRET_ACCESS_KEY');
  ((config.secrets as { required: string[] }).required).push('GUEST_MESSAGE_HMAC_KEY');
  delete (config.vars as Record<string, unknown>).R2_ACCOUNT_ID;
  delete (config.vars as Record<string, unknown>).R2_BUCKET_NAME;
  return config;
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

interface PostCutoverFixture extends Omit<Fixture, 'authorization'> {
  authorization: Record<string, unknown>;
  evidencePath: string;
  bucketEvidencePath: string;
  bucketEvidence: CanonicalMediaBucketProvisioningEvidenceV1;
  bridgeEvidencePath: string;
  bridgeEvidence: MediaWriteBridgeDeploymentEvidenceV1;
  revocationEvidencePath: string;
  revocationEvidence: R2SigningTokenRevocationEvidenceV1;
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
    manifestPath, manifestSha256: '1'.repeat(64),
    manifest: {
      bindings: { sourceTopologySha256: '7'.repeat(64) },
      artifacts: {},
    } as CandidateManifest,
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
    productionTopologySha256: historicalPhase3ProductionTopologySha256(root),
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

function postCutoverFixture(): PostCutoverFixture {
  const source = fixture();
  const migrationContents = 'CREATE TABLE post_cutover_guard (id INTEGER);\n';
  const migrationPath = put(source.root, `migrations/${POST_CUTOVER_MIGRATION}`, migrationContents);
  const migration = {
    path: `migrations/${POST_CUTOVER_MIGRATION}`,
    bytes: Buffer.byteLength(migrationContents),
    sha256: sha256(migrationContents),
  };
  source.verified = {
    ...source.verified,
    migrations: [...source.verified.migrations, migration],
    migrationCount: 15,
  };
  put(source.root, 'dist/candidary/wrangler.json', `${canonicalJson(postCutoverProductionConfig())}\n`);
  const mediaUploadRelease = {
    kind: 'candidary.media-upload-release',
    schemaVersion: 2,
    mode: 'canonical-cutover-disabled',
    capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
  } as const;
  put(source.root, 'config/media-upload-release.json', `${canonicalJson(mediaUploadRelease)}\n`);
  writeCanonicalInput(
    resolve(source.root, 'config/legacy-media-scanner.json'),
    LEGACY_MEDIA_SCANNER_CONTRACT,
  );
  const bundleBytes = migrationContents
    + `INSERT INTO "d1_migrations" (name) VALUES ('${POST_CUTOVER_MIGRATION}');\n`;
  const bucketEvidencePath = resolve(
    source.root,
    'canonical-media-bucket-provisioning-evidence.json',
  );
  const bucketEvidence: CanonicalMediaBucketProvisioningEvidenceV1 = {
    kind: 'candidary.canonical-media-bucket-provisioning-evidence',
    schemaVersion: 1,
    status: 'ready',
    runId: RUN_ID,
    provider: 'cloudflare-r2',
    accountId: ACCOUNT,
    legacyBucket: {
      binding: LEGACY_MEDIA_BINDING,
      bucketName: LEGACY_MEDIA_BUCKET_NAME,
      r2SigningTokenId: TOKEN_ID,
    },
    canonicalBucket: {
      binding: CANONICAL_MEDIA_BINDING,
      bucketName: CANONICAL_MEDIA_BUCKET_NAME,
    },
    providerResponses: {
      bucketCreateReceiptSha256: 'a'.repeat(64),
      bucketStatusObservationSha256: 'b'.repeat(64),
      corsPolicyObservationSha256: 'c'.repeat(64),
      publicAccessObservationSha256: 'd'.repeat(64),
      initialEmptyBucketObservationSha256: 'e'.repeat(64),
    },
    canonicalAccess: {
      publicAccess: 'disabled',
      developmentUrl: 'disabled',
      cors: 'none',
    },
    createdAt: '2026-08-10T11:30:00.000Z',
    observedAt: '2026-08-10T11:45:00.000Z',
    operator: 'storage-owner',
  };
  const bucketEvidenceSha256 = writeCanonicalInput(bucketEvidencePath, bucketEvidence);
  const bridgeRuntime = {
    kind: 'candidary.media-upload-release' as const,
    schemaVersion: 1 as const,
    mode: 'bridge-disabled' as const,
    capabilities: { ...BRIDGE_CAPABILITIES },
  };
  const bridgeEvidencePath = resolve(source.root, 'media-write-bridge-deployment-evidence.json');
  const bridgeEvidence: MediaWriteBridgeDeploymentEvidenceV1 = {
    kind: 'candidary.media-write-bridge-deployment-evidence',
    schemaVersion: 1,
    status: 'passed',
    runId: RUN_ID,
    bridgeCandidate: {
      sha: BRIDGE_SHA,
      approvedMainSha: BRIDGE_SOURCE_MAIN_SHA,
      manifestSha256: 'a'.repeat(64),
      artifactTreeSha256: 'b'.repeat(64),
      migrationCount: 14,
    },
    runtimeContract: {
      ...bridgeRuntime,
      sha256: sha256(`${canonicalJson(bridgeRuntime)}\n`),
    },
    production: {
      accountId: ACCOUNT,
      workerName: 'candidary',
      topologySha256: 'c'.repeat(64),
    },
    canonicalBucketProvisioningEvidenceSha256: bucketEvidenceSha256,
    authorizationSha256: 'd'.repeat(64),
    upload: {
      versionId: BRIDGE_VERSION_ID,
      tagSha: BRIDGE_SHA,
      uploadMessageSha256: sha256(
        `candidary-bridge:${RUN_ID}:${'a'.repeat(64)}:${'b'.repeat(64)}`,
      ),
      trafficPercent: 0,
      providerScriptEtag: '1'.repeat(64),
      localWorkerSha256: '2'.repeat(64),
      bindingsSha256: '3'.repeat(64),
      runtimeSha256: '4'.repeat(64),
      observedAt: '2026-08-10T11:48:30.000Z',
    },
    deployment: {
      versionId: BRIDGE_VERSION_ID,
      tagSha: BRIDGE_SHA,
      trafficPercent: 100,
      disposition: 'deployed',
    },
    signerFree: {
      artifactScan: { xAmzUrlCount: 0, r2SignerReferenceCount: 0 },
      exportDownloadCanary: {
        status: 'passed', httpStatus: 200,
        method: 'GET', artifactUrlSha256: '6'.repeat(64),
        expectedArtifactSha256: '4'.repeat(64), responseSha256: '4'.repeat(64),
        expectedByteLength: 128, responseByteLength: 128,
        sameOrigin: true, redirected: false,
        cacheControl: 'private, no-store', contentDisposition: 'attachment',
        contentType: 'application/zip', xContentTypeOptions: 'nosniff',
        observedAt: '2026-08-10T11:49:00.000Z',
      },
    },
    r2SigningTokenId: TOKEN_ID,
    observedAt: '2026-08-10T11:50:00.000Z',
  };
  const bridgeEvidenceSha256 = writeCanonicalInput(bridgeEvidencePath, bridgeEvidence);
  const revocationEvidencePath = resolve(source.root, 'r2-token-revocation-evidence.json');
  const revocationEvidence: R2SigningTokenRevocationEvidenceV1 = {
    kind: 'candidary.r2-signing-token-revocation-evidence',
    schemaVersion: 1,
    status: 'revoked',
    bridgeDeploymentEvidenceSha256: bridgeEvidenceSha256,
    canonicalBucketProvisioningEvidenceSha256: bucketEvidenceSha256,
    provider: 'cloudflare-r2',
    accountId: ACCOUNT,
    r2SigningTokenId: TOKEN_ID,
    providerStatus: {
      tokenId: TOKEN_ID,
      state: 'disabled',
      scope: 'all-buckets',
      permission: 'admin-read-write',
      observedAt: '2026-08-10T11:53:00.000Z',
    },
    providerResponses: {
      revocationReceiptSha256: 'e'.repeat(64),
      statusObservationSha256: 'f'.repeat(64),
      legacySignedPutProbeObservationSha256: '0'.repeat(64),
      legacyProbeObjectAbsenceObservationSha256: '9'.repeat(64),
      canonicalSignedPutProbeObservationSha256: '1'.repeat(64),
      canonicalPostRevocationEmptyObservationSha256: '2'.repeat(64),
      bridgeExportDownloadCanaryAfterRevocationObservationSha256: '3'.repeat(64),
    },
    legacyBucketSignerProbe: {
      status: 'access_denied',
      httpStatus: 403,
      method: 'PUT',
      targetBucket: LEGACY_MEDIA_BUCKET_NAME,
      signingAccessKeyId: TOKEN_ID,
      objectKeySha256: '8'.repeat(64),
      signedWhileActiveAt: '2026-08-10T11:48:00.000Z',
      invokedAt: '2026-08-10T11:54:00.000Z',
      expiresAt: '2026-08-10T12:10:00.000Z',
    },
    legacyBucketProbeAbsence: {
      status: 'absent',
      httpStatus: 404,
      method: 'HEAD',
      targetBucket: LEGACY_MEDIA_BUCKET_NAME,
      objectKeySha256: '8'.repeat(64),
      observedAt: '2026-08-10T11:55:00.000Z',
    },
    canonicalBucketSignerProbe: {
      status: 'access_denied',
      httpStatus: 403,
      method: 'PUT',
      targetBucket: CANONICAL_MEDIA_BUCKET_NAME,
      signingAccessKeyId: TOKEN_ID,
      objectKeySha256: '3'.repeat(64),
      signedWhileActiveAt: '2026-08-10T11:49:00.000Z',
      invokedAt: '2026-08-10T11:54:30.000Z',
      expiresAt: '2026-08-10T12:10:00.000Z',
    },
    canonicalPostRevocationEmpty: {
      operation: 'LIST',
      targetBucket: CANONICAL_MEDIA_BUCKET_NAME,
      observedAt: '2026-08-10T11:55:00.000Z',
      truncated: false,
      objectCount: 0,
      probeObjectKeySha256: '3'.repeat(64),
    },
    bridgeExportDownloadCanaryAfterRevocation: {
      status: 'passed', httpStatus: 200,
      method: 'GET', artifactUrlSha256: '6'.repeat(64),
      expectedArtifactSha256: '4'.repeat(64), responseSha256: '4'.repeat(64),
      expectedByteLength: 128, responseByteLength: 128,
      sameOrigin: true, redirected: false,
      cacheControl: 'private, no-store', contentDisposition: 'attachment',
      contentType: 'application/zip', xContentTypeOptions: 'nosniff',
      observedAt: '2026-08-10T11:56:00.000Z',
    },
    revokedAt: '2026-08-10T11:51:00.000Z',
    operator: 'credential-owner',
  };
  const revocationEvidenceSha256 = writeCanonicalInput(revocationEvidencePath, revocationEvidence);
  const authorization: Record<string, unknown> = {
    ...source.authorization,
    schemaVersion: 2,
    productionTopologySha256: productionTopologySha256(source.root),
    migrationName: POST_CUTOVER_MIGRATION,
    migrationSha256: sha256(readFileSync(migrationPath)),
    bundleSha256: sha256(bundleBytes),
    preSchemaSha256: '5'.repeat(64),
    postSchemaSha256: '6'.repeat(64),
    canonicalMediaBucketProvisioningEvidenceSha256: bucketEvidenceSha256,
    bridgeSha: BRIDGE_SHA,
    bridgeDeploymentEvidenceSha256: bridgeEvidenceSha256,
    r2SigningTokenId: TOKEN_ID,
    r2RevocationEvidenceSha256: revocationEvidenceSha256,
    mediaUploadReleaseConfigSha256: sha256(`${canonicalJson(mediaUploadRelease)}\n`),
    legacyMediaScannerConfigSha256: sha256(
      `${canonicalJson(LEGACY_MEDIA_SCANNER_CONTRACT)}\n`,
    ),
  };
  writeCanonicalInput(source.authorizationPath, authorization);
  const pre: ProductionDatabaseObservation = {
    ...source.pre,
    ledger: [...migrationNames],
    pendingMigrations: [POST_CUTOVER_MIGRATION],
    schemaSha256: authorization.preSchemaSha256 as string,
    triggerNames: [...PRODUCTION_TRIGGER_NAMES],
  };
  const post: ProductionDatabaseObservation = {
    ...source.post,
    ledger: [...migrationNames, POST_CUTOVER_MIGRATION],
    schemaSha256: authorization.postSchemaSha256 as string,
    triggerNames: [...POST_CUTOVER_TRIGGER_NAMES],
  };
  return {
    ...source,
    authorization,
    bucketEvidencePath,
    bucketEvidence,
    bridgeEvidencePath,
    bridgeEvidence,
    revocationEvidencePath,
    revocationEvidence,
    pre,
    post,
    evidencePath: resolve(
      source.root,
      'output/production-migration',
      SHA,
      RUN_ID,
      'post-cutover-migration-evidence.json',
    ),
  };
}

function fakeAdapters(
  source: Fixture | PostCutoverFixture,
  options: {
    verifyError?: Error;
    states?: ProductionDatabaseObservation[];
    exitCode?: number;
    hash?: string;
    onRun?: (command: ProductionMigrationCommand, bundle: string) => void;
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
        const bundle = readFileSync(command.bundlePath, 'utf8');
        expect(bundle)
          .toContain(basename(source.verified.migrations.at(-1)!.path));
        options.onRun?.(command, bundle);
        return options.exitCode ?? 0;
      },
    } satisfies MigrateReleaseAdapters,
    commands,
  };
  return holder;
}

function request(source: Fixture | PostCutoverFixture) {
  const common = {
    candidateRoot: source.root, sha: SHA, manifestPath: source.manifestPath,
    authorizationPath: source.authorizationPath, bookmarkPath: source.bookmarkPath,
  };
  return 'bucketEvidencePath' in source
    ? {
      ...common,
      canonicalBucketEvidencePath: source.bucketEvidencePath,
      bridgeEvidencePath: source.bridgeEvidencePath,
      revocationEvidencePath: source.revocationEvidencePath,
    }
    : common;
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

describe('post-cutover production topology', () => {
  it('requires the dual-bucket signer-free Candidate A topology without signer-era vars', () => {
    const root = temporaryRoot();
    put(root, 'dist/candidary/wrangler.json', `${canonicalJson(postCutoverProductionConfig())}\n`);
    expect(productionTopologySha256(root)).toMatch(/^[0-9a-f]{64}$/u);

    const missingRate = postCutoverProductionConfig();
    (missingRate.ratelimits as unknown[]).pop();
    put(root, 'dist/candidary/wrangler.json', `${canonicalJson(missingRate)}\n`);
    expect(() => productionTopologySha256(root)).toThrow(/topology/u);

    const missingSecret = postCutoverProductionConfig();
    (missingSecret.secrets as { required: string[] }).required.pop();
    put(root, 'dist/candidary/wrangler.json', `${canonicalJson(missingSecret)}\n`);
    expect(() => productionTopologySha256(root)).toThrow(/topology/u);

    const signerSecret = postCutoverProductionConfig();
    (signerSecret.secrets as { required: string[] }).required.push('R2_ACCESS_KEY_ID');
    put(root, 'dist/candidary/wrangler.json', `${canonicalJson(signerSecret)}\n`);
    expect(() => productionTopologySha256(root)).toThrow(/topology/u);

    const signerVar = postCutoverProductionConfig();
    (signerVar.vars as Record<string, unknown>).R2_ACCOUNT_ID = ACCOUNT;
    put(root, 'dist/candidary/wrangler.json', `${canonicalJson(signerVar)}\n`);
    expect(() => productionTopologySha256(root)).toThrow(/topology/u);
  });

  it('accepts canonical bucket provisioning evidence as a schema-v2 input', () => {
    const source = postCutoverFixture();
    expect(parseMigrateReleaseArgs([
      '--sha', SHA, '--manifest', source.manifestPath,
      '--authorization', source.authorizationPath, '--bookmark', source.bookmarkPath,
      '--canonical-bucket-evidence', source.bucketEvidencePath,
      '--bridge-evidence', source.bridgeEvidencePath,
      '--revocation-evidence', source.revocationEvidencePath,
    ], source.root)).toMatchObject({
      canonicalBucketEvidencePath: source.bucketEvidencePath,
      bridgeEvidencePath: source.bridgeEvidencePath,
      revocationEvidencePath: source.revocationEvidencePath,
    });
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

  it('runs only sole 0015 from the exact 14-ledger state and writes candidate-bound rollback evidence', () => {
    const source = postCutoverFixture();
    let invokedBundle = '';
    const run = fakeAdapters(source, { onRun: (_command, bundle) => { invokedBundle = bundle; } });
    const result = runMigrateRelease(request(source), run.adapters) as unknown as Record<string, unknown>;

    expect(run.verifyCalls).toBe(2);
    expect(run.commands).toHaveLength(1);
    const command = run.commands[0]!;
    expect(invokedBundle).toContain(POST_CUTOVER_MIGRATION);
    expect(invokedBundle).not.toContain(PHASE_3_MIGRATION);
    expect(result).toMatchObject({
      candidateSha: SHA,
      migrationName: POST_CUTOVER_MIGRATION,
      migrationSha256: source.authorization.migrationSha256,
      bundleSha256: source.authorization.bundleSha256,
      evidencePath: source.evidencePath,
    });
    const evidenceBytes = readFileSync(source.evidencePath, 'utf8');
    const evidence = JSON.parse(evidenceBytes) as Record<string, unknown>;
    expect(evidenceBytes).toBe(`${canonicalJson(evidence)}\n`);
    expect(evidence).toMatchObject({
      kind: 'candidary.production-migration-evidence',
      schemaVersion: 2,
      status: 'passed',
      runId: RUN_ID,
      candidate: {
        sha: SHA,
        manifestSha256: source.verified.manifestSha256,
        artifactTreeSha256: source.verified.artifactTreeSha256,
      },
      authorizationSha256: sha256(readFileSync(source.authorizationPath)),
      migration: {
        name: POST_CUTOVER_MIGRATION,
        sha256: source.authorization.migrationSha256,
        bundleSha256: source.authorization.bundleSha256,
      },
      before: { ledger: [...migrationNames], schemaSha256: source.pre.schemaSha256 },
      after: {
        ledger: [...migrationNames, POST_CUTOVER_MIGRATION],
        pendingMigrations: [],
        schemaSha256: source.post.schemaSha256,
        integrity: 'ok',
        foreignKeyRows: 0,
      },
      rollback: {
        bookmarkSha256: source.authorization.bookmarkSha256,
        bookmarkRecordedAt: source.bookmark.recordedAt,
        rollbackOwner: source.authorization.rollbackOwner,
      },
    });
    expect(readFileSync(`${source.evidencePath}.sha256`, 'utf8'))
      .toBe(`${sha256(evidenceBytes)}  post-cutover-migration-evidence.json\n`);
    expect(() => readFileSync(command.bundlePath)).toThrow();
  });

  it('requires exact isolated-bucket and disabled runtime-config proof before remote observation', () => {
    const mutations: Array<{
      name: string;
      mutate(source: PostCutoverFixture): void;
    }> = [
      {
        name: 'bucket evidence digest drift',
        mutate(source) {
          source.authorization.canonicalMediaBucketProvisioningEvidenceSha256 = '0'.repeat(64);
        },
      },
      {
        name: 'canonical bucket identity drift',
        mutate(source) {
          source.bucketEvidence.canonicalBucket.bucketName = LEGACY_MEDIA_BUCKET_NAME as typeof CANONICAL_MEDIA_BUCKET_NAME;
          writeCanonicalInput(source.bucketEvidencePath, source.bucketEvidence);
          source.authorization.canonicalMediaBucketProvisioningEvidenceSha256 = sha256(
            readFileSync(source.bucketEvidencePath),
          );
        },
      },
      {
        name: 'canonical bucket becomes publicly accessible',
        mutate(source) {
          (source.bucketEvidence.canonicalAccess as unknown as Record<string, unknown>).publicAccess = 'enabled';
          writeCanonicalInput(source.bucketEvidencePath, source.bucketEvidence);
          source.authorization.canonicalMediaBucketProvisioningEvidenceSha256 = sha256(
            readFileSync(source.bucketEvidencePath),
          );
        },
      },
      {
        name: 'bridge evidence digest drift',
        mutate(source) { source.authorization.bridgeDeploymentEvidenceSha256 = '0'.repeat(64); },
      },
      {
        name: 'bridge not at 100 percent',
        mutate(source) {
          source.bridgeEvidence.deployment.trafficPercent = 99 as 100;
          writeCanonicalInput(source.bridgeEvidencePath, source.bridgeEvidence);
          source.authorization.bridgeDeploymentEvidenceSha256 = sha256(
            readFileSync(source.bridgeEvidencePath),
          );
          source.revocationEvidence.bridgeDeploymentEvidenceSha256 =
            source.authorization.bridgeDeploymentEvidenceSha256 as string;
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'bridge version tag drift',
        mutate(source) {
          source.bridgeEvidence.deployment.tagSha = 'd'.repeat(40);
          writeCanonicalInput(source.bridgeEvidencePath, source.bridgeEvidence);
          source.authorization.bridgeDeploymentEvidenceSha256 = sha256(
            readFileSync(source.bridgeEvidencePath),
          );
          source.revocationEvidence.bridgeDeploymentEvidenceSha256 =
            source.authorization.bridgeDeploymentEvidenceSha256 as string;
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'revocation evidence digest drift',
        mutate(source) { source.authorization.r2RevocationEvidenceSha256 = '0'.repeat(64); },
      },
      {
        name: 'revocation status drift',
        mutate(source) {
          (source.revocationEvidence as unknown as Record<string, unknown>).status = 'requested';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'legacy-bucket revoked signer negative probe drift',
        mutate(source) {
          (source.revocationEvidence.legacyBucketSignerProbe as unknown as Record<string, unknown>)
            .status = 'allowed';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'legacy-bucket revoked signer probe expired before invocation',
        mutate(source) {
          source.revocationEvidence.legacyBucketSignerProbe.expiresAt =
            source.revocationEvidence.legacyBucketSignerProbe.invokedAt;
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'legacy-bucket denied probe object is not proven absent',
        mutate(source) {
          source.revocationEvidence.legacyBucketProbeAbsence.objectKeySha256 = '7'.repeat(64);
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'legacy-bucket absence observation targets another bucket',
        mutate(source) {
          source.revocationEvidence.legacyBucketProbeAbsence.targetBucket =
            CANONICAL_MEDIA_BUCKET_NAME as typeof LEGACY_MEDIA_BUCKET_NAME;
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'provider status is not disabled',
        mutate(source) {
          (source.revocationEvidence.providerStatus as unknown as Record<string, unknown>).state = 'active';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'provider status narrows token scope',
        mutate(source) {
          (source.revocationEvidence.providerStatus as unknown as Record<string, unknown>).scope =
            'legacy-bucket-only';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'canonical isolation probe targets the legacy bucket',
        mutate(source) {
          source.revocationEvidence.canonicalBucketSignerProbe.targetBucket =
            LEGACY_MEDIA_BUCKET_NAME as typeof CANONICAL_MEDIA_BUCKET_NAME;
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'post-revocation empty proof predates the denied probe',
        mutate(source) {
          source.revocationEvidence.canonicalPostRevocationEmpty.observedAt =
            '2026-08-10T11:53:30.000Z';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'post-revocation empty proof occurs after authorization',
        mutate(source) {
          source.revocationEvidence.canonicalPostRevocationEmpty.observedAt =
            '2026-08-10T12:00:01.000Z';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'empty listing does not bind the denied probe object key',
        mutate(source) {
          source.revocationEvidence.canonicalPostRevocationEmpty.probeObjectKeySha256 = '4'.repeat(64);
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'post-revocation bucket listing is truncated',
        mutate(source) {
          source.revocationEvidence.canonicalPostRevocationEmpty.truncated = true as false;
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'post-revocation empty listing targets the legacy bucket',
        mutate(source) {
          source.revocationEvidence.canonicalPostRevocationEmpty.targetBucket =
            LEGACY_MEDIA_BUCKET_NAME as typeof CANONICAL_MEDIA_BUCKET_NAME;
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'post-revocation export canary returns different bytes',
        mutate(source) {
          source.revocationEvidence.bridgeExportDownloadCanaryAfterRevocation.responseSha256 =
            '5'.repeat(64);
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'post-revocation export canary targets a different artifact URL',
        mutate(source) {
          source.revocationEvidence.bridgeExportDownloadCanaryAfterRevocation
            .artifactUrlSha256 = '5'.repeat(64);
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'post-revocation export canary occurs after authorization',
        mutate(source) {
          source.revocationEvidence.bridgeExportDownloadCanaryAfterRevocation.observedAt =
            '2026-08-10T12:00:01.000Z';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'revocation precedes bridge serving proof',
        mutate(source) {
          source.revocationEvidence.revokedAt = '2026-08-10T11:45:00.000Z';
          source.revocationEvidence.providerStatus.observedAt = '2026-08-10T11:46:00.000Z';
          source.revocationEvidence.legacyBucketSignerProbe.signedWhileActiveAt =
            '2026-08-10T11:44:00.000Z';
          source.revocationEvidence.legacyBucketSignerProbe.invokedAt =
            '2026-08-10T11:47:00.000Z';
          source.revocationEvidence.legacyBucketProbeAbsence.observedAt =
            '2026-08-10T11:47:30.000Z';
          source.revocationEvidence.canonicalBucketSignerProbe.signedWhileActiveAt =
            '2026-08-10T11:44:30.000Z';
          source.revocationEvidence.canonicalBucketSignerProbe.invokedAt =
            '2026-08-10T11:47:15.000Z';
          source.revocationEvidence.canonicalPostRevocationEmpty.observedAt = '2026-08-10T11:48:00.000Z';
          writeCanonicalInput(source.revocationEvidencePath, source.revocationEvidence);
          source.authorization.r2RevocationEvidenceSha256 = sha256(
            readFileSync(source.revocationEvidencePath),
          );
        },
      },
      {
        name: 'schema-v2 config byte drift',
        mutate(source) {
          put(source.root, 'config/media-upload-release.json', `${canonicalJson({
            kind: 'candidary.media-upload-release',
            schemaVersion: 2,
            mode: 'canonical-cutover-disabled',
            capabilities: {
              ...CUTOVER_DISABLED_CAPABILITIES,
              authenticatedWorkerIngress: true,
            },
          })}\n`);
        },
      },
      {
        name: 'permanent scanner config byte drift',
        mutate(source) {
          put(source.root, 'config/legacy-media-scanner.json', `${canonicalJson({
            ...LEGACY_MEDIA_SCANNER_CONTRACT,
            throughput: {
              ...LEGACY_MEDIA_SCANNER_CONTRACT.throughput,
              fullEpochSlaHours: 48,
            },
          })}\n`);
        },
      },
      {
        name: 'permanent scanner authorization digest drift',
        mutate(source) {
          source.authorization.legacyMediaScannerConfigSha256 = '7'.repeat(64);
        },
      },
      {
        name: 'copy-only config in migration candidate',
        mutate(source) {
          put(source.root, 'config/media-upload-release.json', `${canonicalJson({
            kind: 'candidary.media-upload-release', schemaVersion: 2,
            mode: 'canonical-copy-only',
            capabilities: { ...CANONICAL_COPY_ONLY_CAPABILITIES },
          })}\n`);
          source.authorization.mediaUploadReleaseConfigSha256 = sha256(
            readFileSync(resolve(source.root, 'config/media-upload-release.json')),
          );
        },
      },
      {
        name: 'live config in migration candidate',
        mutate(source) {
          put(source.root, 'config/media-upload-release.json', `${canonicalJson({
            kind: 'candidary.media-upload-release', schemaVersion: 2,
            mode: 'canonical-live',
            capabilities: { ...CANONICAL_LIVE_CAPABILITIES },
          })}\n`);
          source.authorization.mediaUploadReleaseConfigSha256 = sha256(
            readFileSync(resolve(source.root, 'config/media-upload-release.json')),
          );
        },
      },
    ];

    for (const testCase of mutations) {
      const source = postCutoverFixture();
      testCase.mutate(source);
      writeCanonicalInput(source.authorizationPath, source.authorization);
      let observations = 0;
      const run = fakeAdapters(source);
      const adapters: MigrateReleaseAdapters = {
        ...run.adapters,
        observeDatabase(context) {
          observations += 1;
          return run.adapters.observeDatabase(context);
        },
      };
      expect(
        () => runMigrateRelease(request(source), adapters),
        testCase.name,
      ).toThrow(/bucket|signer|runtime|config|schema|scanner|digest|evidence|capabilit|disabled|mode|revocation|order/iu);
      expect(observations, testCase.name).toBe(0);
      expect(run.commands, testCase.name).toHaveLength(0);
      expect(() => readFileSync(source.evidencePath)).toThrow();
    }
  });

  it('keeps historical schema-v1 migration independent of canonical bucket evidence', () => {
    const source = fixture();
    const run = fakeAdapters(source);
    expect(() => runMigrateRelease({
      ...request(source),
      canonicalBucketEvidencePath: source.authorizationPath,
    }, run.adapters)).toThrow(/schema-v1|historical|canonical|bucket/iu);
    expect(run.commands).toHaveLength(0);
  });

  it('fails closed around the post-cutover pre-state, rollback, and post-ledger proof', () => {
    const wrongPre = postCutoverFixture();
    const wrongPreRun = fakeAdapters(wrongPre, {
      states: [{ ...wrongPre.pre, ledger: migrationNames.slice(0, 13) }],
    });
    expect(() => runMigrateRelease(request(wrongPre), wrongPreRun.adapters)).toThrow(/ledger|boundary/iu);
    expect(wrongPreRun.commands).toHaveLength(0);

    const wrongPending = postCutoverFixture();
    const wrongPendingRun = fakeAdapters(wrongPending, {
      states: [{ ...wrongPending.pre, pendingMigrations: [PHASE_3_MIGRATION, POST_CUTOVER_MIGRATION] }],
    });
    expect(() => runMigrateRelease(request(wrongPending), wrongPendingRun.adapters)).toThrow(/pending/iu);
    expect(wrongPendingRun.commands).toHaveLength(0);

    const unchanged = postCutoverFixture();
    const unchangedRun = fakeAdapters(unchanged, {
      exitCode: 1,
      states: [unchanged.pre, unchanged.pre],
    });
    expect(() => runMigrateRelease(request(unchanged), unchangedRun.adapters)).toThrow(/rollback|failed/iu);
    expect(() => readFileSync(unchanged.evidencePath)).toThrow();

    const residual = postCutoverFixture();
    const residualRun = fakeAdapters(residual, {
      exitCode: 1,
      states: [residual.pre, residual.post],
    });
    expect(() => runMigrateRelease(request(residual), residualRun.adapters)).toThrow(/residual|rollback/iu);
    expect(() => readFileSync(residual.evidencePath)).toThrow();

    const incomplete = postCutoverFixture();
    const incompleteRun = fakeAdapters(incomplete, {
      states: [incomplete.pre, { ...incomplete.post, ledger: [...migrationNames] }],
    });
    expect(() => runMigrateRelease(request(incomplete), incompleteRun.adapters)).toThrow(/post|ledger/iu);
    expect(() => readFileSync(incomplete.evidencePath)).toThrow();
  });

  it('uses exact phase-specific trigger inventories and refuses any mismatch before migration', () => {
    expect(PRODUCTION_TRIGGER_NAMES).toEqual([
      'event_cover_master_live_reference_delete',
      'event_cover_render_object_manifest_delete',
      'event_cover_render_object_manifest_insert',
      'event_cover_render_object_manifest_update',
      'event_cover_render_set_live_reference_delete',
      'event_cover_render_set_manifest_insert',
      'event_cover_render_set_manifest_update',
      'event_cover_source_pointer_insert',
      'event_cover_source_pointer_update',
      'events_rsvp_deadline_insert',
      'events_rsvp_deadline_update',
      'media_stamp_stored_at_compat',
    ]);

    for (const triggerNames of [
      PRODUCTION_TRIGGER_NAMES.slice(0, -1),
      [...PRODUCTION_TRIGGER_NAMES, 'unexpected_pre_cutover_trigger'],
    ]) {
      const source = postCutoverFixture();
      const run = fakeAdapters(source, {
        states: [{ ...source.pre, triggerNames }],
      });
      expect(() => runMigrateRelease(request(source), run.adapters)).toThrow(/trigger/iu);
      expect(run.commands).toHaveLength(0);
    }

    for (const triggerNames of [
      POST_CUTOVER_TRIGGER_NAMES.slice(0, -1),
      [...POST_CUTOVER_TRIGGER_NAMES, 'unexpected_post_cutover_trigger'],
    ]) {
      const source = postCutoverFixture();
      const run = fakeAdapters(source, {
        states: [source.pre, { ...source.post, triggerNames }],
      });
      expect(() => runMigrateRelease(request(source), run.adapters)).toThrow(/trigger/iu);
      expect(run.commands).toHaveLength(1);
      expect(() => readFileSync(source.evidencePath)).toThrow();
    }
  });

  it('rejects stale schema-v2 authorization and migration bytes before invoking Wrangler', () => {
    const migrationDrift = postCutoverFixture();
    put(
      migrationDrift.root,
      `migrations/${POST_CUTOVER_MIGRATION}`,
      'CREATE TABLE post_cutover_guard (id INTEGER, drifted INTEGER);\n',
    );
    const driftRun = fakeAdapters(migrationDrift);
    expect(() => runMigrateRelease(request(migrationDrift), driftRun.adapters)).toThrow(/drift/iu);
    expect(driftRun.commands).toHaveLength(0);

    for (const field of ['migrationSha256', 'bundleSha256'] as const) {
      const source = postCutoverFixture();
      source.authorization[field] = '0'.repeat(64);
      writeCanonicalInput(source.authorizationPath, source.authorization);
      const run = fakeAdapters(source);
      expect(() => runMigrateRelease(request(source), run.adapters)).toThrow(/migration|bundle|authorization/iu);
      expect(run.commands).toHaveLength(0);
      expect(() => readFileSync(source.evidencePath)).toThrow();
    }
  });

  it('withholds v2 evidence when the authorized post-schema fingerprint is not observed', () => {
    const source = postCutoverFixture();
    const run = fakeAdapters(source, {
      states: [source.pre, { ...source.post, schemaSha256: '7'.repeat(64) }],
    });
    expect(() => runMigrateRelease(request(source), run.adapters)).toThrow(/schema/iu);
    expect(run.commands).toHaveLength(1);
    expect(() => readFileSync(source.evidencePath)).toThrow();
  });
});

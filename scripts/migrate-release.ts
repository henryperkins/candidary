import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256 } from './release-evidence.ts';
import {
  verifyMediaWriteBridgeDeploymentEvidence,
  verifyR2SigningTokenRevocationEvidence,
  type MediaWriteBridgeDeploymentEvidenceV1,
  type R2SigningTokenRevocationEvidenceV1,
} from './bridge-release-contract.ts';
import {
  CANONICAL_MEDIA_BINDING,
  CANONICAL_MEDIA_BUCKET_NAME,
  LEGACY_MEDIA_BINDING,
  LEGACY_MEDIA_BUCKET_NAME,
  LEGACY_MEDIA_SCANNER_CONFIG_PATH,
  MEDIA_UPLOAD_RELEASE_CONFIG_PATH,
  verifyCanonicalMediaBucketProvisioningEvidence,
  verifyLegacyMediaScannerContract,
  verifyMediaUploadReleaseContract,
  type CanonicalMediaBucketProvisioningEvidenceV1,
} from './media-cutover-release-contract.ts';
import {
  PHASE_2_MIGRATION,
  PHASE_3_MIGRATION,
  POST_CUTOVER_MIGRATION,
  buildAtomicMigrationBundle,
  buildPostCutoverAtomicMigrationBundle,
  verifyExactReleaseCandidate,
  type ReleaseCandidateVerificationRequest,
  type VerifiedReleaseCandidate,
} from './release-candidate.ts';

const APPROVED_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const D1_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const PRODUCTION_DATABASE_NAME = 'candidary-core';
const PRODUCTION_DATABASE_ID = '60bec5de-c8c7-41b5-a26b-2d3f7d184c71';

export const PRODUCTION_TRIGGER_NAMES = [
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
] as const;

const HISTORICAL_PHASE_3_REQUIRED_SECRET_NAMES = [
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

export const POST_CUTOVER_PRODUCTION_TRIGGER_NAMES = [
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
  'legacy_media_scan_quarantine_permanent',
  'legacy_media_scan_state_permanent',
  'media_object_promotion_inventory_insert',
  'media_object_promotion_inventory_update',
  'media_object_promotion_reservation_capability_guard',
  'media_object_promotion_verified_delete_guard',
  'media_object_promotion_verified_proof_immutable',
  'media_object_write_tombstone_guard_insert',
  'media_object_write_tombstone_guard_update',
  'media_object_write_tombstone_immutable',
  'media_object_write_tombstone_inventory_insert',
  'media_object_write_tombstone_inventory_update',
  'media_object_write_tombstone_permanent',
  'media_stamp_stored_at_compat',
  'media_stored_legacy_guard_insert',
  'media_stored_legacy_guard_update',
] as const;

const POST_CUTOVER_REQUIRED_SECRET_NAMES = [
  ...HISTORICAL_PHASE_3_REQUIRED_SECRET_NAMES
    .filter((name) => name !== 'R2_ACCESS_KEY_ID' && name !== 'R2_SECRET_ACCESS_KEY'),
  'GUEST_MESSAGE_HMAC_KEY',
] as const;

type ProductionTopologyBaseline = 'historical-phase-3' | 'media-write-bridge' | 'post-cutover';

export interface ProductionMigrationAuthorizationV1 {
  kind: 'candidary.production-migration-authorization';
  schemaVersion: 1;
  runId: string;
  approvedMainSha: string;
  candidateSha: string;
  manifestSha256: string;
  productionTopologySha256: string;
  accountId: string;
  databaseName: string;
  databaseId: string;
  migrationName: typeof PHASE_3_MIGRATION;
  migrationSha256: string;
  bundleSha256: string;
  bookmarkSha256: string;
  preSchemaSha256: string;
  postSchemaSha256: string;
  authorizedAt: string;
  expiresAt: string;
  noDeployWindowOwner: string;
  rollbackOwner: string;
}

export interface ProductionMigrationAuthorizationV2 {
  kind: 'candidary.production-migration-authorization';
  schemaVersion: 2;
  runId: string;
  approvedMainSha: string;
  candidateSha: string;
  manifestSha256: string;
  productionTopologySha256: string;
  accountId: string;
  databaseName: string;
  databaseId: string;
  migrationName: typeof POST_CUTOVER_MIGRATION;
  migrationSha256: string;
  bundleSha256: string;
  bookmarkSha256: string;
  preSchemaSha256: string;
  postSchemaSha256: string;
  canonicalMediaBucketProvisioningEvidenceSha256: string;
  bridgeSha: string;
  bridgeDeploymentEvidenceSha256: string;
  r2SigningTokenId: string;
  r2RevocationEvidenceSha256: string;
  mediaUploadReleaseConfigSha256: string;
  legacyMediaScannerConfigSha256: string;
  authorizedAt: string;
  expiresAt: string;
  noDeployWindowOwner: string;
  rollbackOwner: string;
}

export type ProductionMigrationAuthorization =
  | ProductionMigrationAuthorizationV1
  | ProductionMigrationAuthorizationV2;

export interface TimeTravelBookmarkV1 {
  kind: 'candidary.d1-time-travel-bookmark';
  schemaVersion: 1;
  accountId: string;
  databaseName: string;
  databaseId: string;
  bookmarkId: string;
  recordedAt: string;
}

export interface ZeroLegacyObservation {
  legacyRows: number;
  blockingJobs: number;
  incompleteActiveSets: number;
  uploadsWithoutActiveSet: number;
}

export interface ProductionDatabaseObservation {
  ledger: string[];
  pendingMigrations: string[];
  schemaSha256: string;
  integrity: 'ok';
  foreignKeyRows: 0;
  triggerNames: string[];
  zeroCounts: ZeroLegacyObservation;
}

export interface ProductionMigrationCommand {
  executable: string;
  args: string[];
  cwd: string;
  shell: false;
  bundlePath: string;
}

export interface ProductionObservationContext {
  candidate: VerifiedReleaseCandidate;
  authorization: ProductionMigrationAuthorization;
}

export interface MigrateReleaseAdapters {
  now(): string;
  verifyCandidate(request: ReleaseCandidateVerificationRequest): VerifiedReleaseCandidate;
  observeDatabase(context: ProductionObservationContext): ProductionDatabaseObservation;
  hashFile(path: string): string;
  run(command: ProductionMigrationCommand): number;
}

export interface MigrateReleaseRequest {
  candidateRoot: string;
  sha: string;
  manifestPath: string;
  authorizationPath: string;
  bookmarkPath: string;
  bridgeEvidencePath?: string;
  revocationEvidencePath?: string;
  canonicalBucketEvidencePath?: string;
}

export interface MigrateReleaseArguments {
  sha: string;
  manifestPath: string;
  authorizationPath: string;
  bookmarkPath: string;
  bridgeEvidencePath?: string;
  revocationEvidencePath?: string;
  canonicalBucketEvidencePath?: string;
}

export interface ProductionMigrationResult {
  candidateSha: string;
  migrationName: typeof PHASE_3_MIGRATION | typeof POST_CUTOVER_MIGRATION;
  migrationSha256: string;
  bundleSha256: string;
  preSchemaSha256: string;
  postSchemaSha256: string;
  evidencePath?: string;
  evidenceSha256?: string;
}

export interface ProductionMigrationEvidenceV2 {
  kind: 'candidary.production-migration-evidence';
  schemaVersion: 2;
  status: 'passed';
  runId: string;
  candidate: {
    sha: string;
    approvedMainSha: string;
    manifestSha256: string;
    artifactTreeSha256: string;
    bindingTopologySha256: string;
  };
  production: {
    topologySha256: string;
    accountId: string;
    databaseName: string;
    databaseId: string;
  };
  authorizationSha256: string;
  bridge: {
    sha: string;
    deploymentEvidenceSha256: string;
    versionId: string;
    r2SigningTokenId: string;
    revocationEvidenceSha256: string;
    revocationReceiptSha256: string;
    statusObservationSha256: string;
  };
  mediaUploadReleaseConfigSha256: string;
  legacyMediaScannerConfigSha256: string;
  canonicalMediaBucketProvisioningEvidenceSha256: string;
  migration: {
    name: typeof POST_CUTOVER_MIGRATION;
    sha256: string;
    bundleSha256: string;
  };
  before: {
    ledger: string[];
    schemaSha256: string;
  };
  after: ProductionDatabaseObservation;
  rollback: {
    bookmarkSha256: string;
    bookmarkRecordedAt: string;
    rollbackOwner: string;
  };
  observedAt: string;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unknown or missing field.`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function patternString(value: unknown, pattern: RegExp, label: string): string {
  const result = exactString(value, label);
  if (!pattern.test(result)) throw new Error(`${label} has an invalid format.`);
  return result;
}

function sha1(value: unknown, label: string): string {
  return patternString(value, SHA_PATTERN, label);
}

function sha256Value(value: unknown, label: string): string {
  return patternString(value, SHA256_PATTERN, label);
}

function instant(value: unknown, label: string): string {
  const result = patternString(value, ISO_PATTERN, label);
  if (new Date(result).toISOString() !== result) throw new Error(`${label} is not a canonical UTC instant.`);
  return result;
}

function exactRegularFile(path: string, label: string): string {
  try {
    const absolute = resolve(path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return absolute;
  } catch (error) {
    throw new Error(`${label} must be one exact regular nonsymlinked file.`, { cause: error });
  }
}

function within(container: string, target: string): boolean {
  const path = relative(container, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

interface CanonicalInput<T> {
  value: T;
  digest: string;
  path: string;
}

function readCanonicalInput<T>(path: string, label: string): CanonicalInput<T> {
  const inputPath = exactRegularFile(path, label);
  const bytes = readFileSync(inputPath, 'utf8');
  const digest = sha256(bytes);
  const sidecar = readFileSync(exactRegularFile(`${inputPath}.sha256`, `${label} sidecar`), 'utf8');
  if (sidecar !== `${digest}  ${basename(inputPath)}\n`) {
    throw new Error(`${label} sidecar digest does not match.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (bytes !== `${canonicalJson(value)}\n`) throw new Error(`${label} JSON is not canonical.`);
  return { value: value as T, digest, path: inputPath };
}

function parseBookmark(value: unknown): TimeTravelBookmarkV1 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'accountId', 'databaseName', 'databaseId', 'bookmarkId', 'recordedAt',
  ], 'Time Travel bookmark');
  if (item.kind !== 'candidary.d1-time-travel-bookmark' || item.schemaVersion !== 1) {
    throw new Error('Time Travel bookmark identity is invalid.');
  }
  const bookmarkId = patternString(item.bookmarkId, /^[A-Za-z0-9][A-Za-z0-9:._-]{7,255}$/u, 'bookmarkId');
  return {
    kind: 'candidary.d1-time-travel-bookmark', schemaVersion: 1,
    accountId: patternString(item.accountId, ACCOUNT_ID_PATTERN, 'bookmark accountId'),
    databaseName: exactString(item.databaseName, 'bookmark databaseName'),
    databaseId: patternString(item.databaseId, D1_ID_PATTERN, 'bookmark databaseId'),
    bookmarkId,
    recordedAt: instant(item.recordedAt, 'bookmark recordedAt'),
  };
}

function parseAuthorization(value: unknown): ProductionMigrationAuthorization {
  const identity = object(value, 'Production migration authorization');
  const postCutover = identity.kind === 'candidary.production-migration-authorization'
    && identity.schemaVersion === 2;
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'runId', 'approvedMainSha', 'candidateSha', 'manifestSha256',
    'productionTopologySha256', 'accountId', 'databaseName', 'databaseId', 'migrationName',
    'migrationSha256', 'bundleSha256', 'bookmarkSha256', 'preSchemaSha256',
    'postSchemaSha256', 'authorizedAt', 'expiresAt', 'noDeployWindowOwner', 'rollbackOwner',
    ...(postCutover ? [
      'canonicalMediaBucketProvisioningEvidenceSha256',
      'bridgeSha', 'bridgeDeploymentEvidenceSha256', 'r2SigningTokenId',
      'r2RevocationEvidenceSha256', 'mediaUploadReleaseConfigSha256',
      'legacyMediaScannerConfigSha256',
    ] : []),
  ], 'Production migration authorization');
  const historical = item.kind === 'candidary.production-migration-authorization'
    && item.schemaVersion === 1;
  if (!historical && !postCutover) {
    throw new Error('Production migration authorization identity is invalid.');
  }
  const migrationName = historical ? PHASE_3_MIGRATION : POST_CUTOVER_MIGRATION;
  if (item.migrationName !== migrationName) {
    throw new Error(`Production authorization must name only ${migrationName}.`);
  }
  const owner = (entry: unknown, label: string) =>
    patternString(entry, /^[a-z][a-z0-9._-]{2,63}$/u, label);
  const common = {
    kind: 'candidary.production-migration-authorization' as const,
    runId: patternString(item.runId, UUID_PATTERN, 'authorization runId'),
    approvedMainSha: sha1(item.approvedMainSha, 'approvedMainSha'),
    candidateSha: sha1(item.candidateSha, 'candidateSha'),
    manifestSha256: sha256Value(item.manifestSha256, 'manifestSha256'),
    productionTopologySha256: sha256Value(item.productionTopologySha256, 'productionTopologySha256'),
    accountId: patternString(item.accountId, ACCOUNT_ID_PATTERN, 'accountId'),
    databaseName: exactString(item.databaseName, 'databaseName'),
    databaseId: patternString(item.databaseId, D1_ID_PATTERN, 'databaseId'),
    migrationSha256: sha256Value(item.migrationSha256, 'migrationSha256'),
    bundleSha256: sha256Value(item.bundleSha256, 'bundleSha256'),
    bookmarkSha256: sha256Value(item.bookmarkSha256, 'bookmarkSha256'),
    preSchemaSha256: sha256Value(item.preSchemaSha256, 'preSchemaSha256'),
    postSchemaSha256: sha256Value(item.postSchemaSha256, 'postSchemaSha256'),
    authorizedAt: instant(item.authorizedAt, 'authorizedAt'),
    expiresAt: instant(item.expiresAt, 'expiresAt'),
    noDeployWindowOwner: owner(item.noDeployWindowOwner, 'noDeployWindowOwner'),
    rollbackOwner: owner(item.rollbackOwner, 'rollbackOwner'),
  };
  return historical
    ? { ...common, schemaVersion: 1, migrationName: PHASE_3_MIGRATION }
    : {
      ...common,
      schemaVersion: 2,
      migrationName: POST_CUTOVER_MIGRATION,
      canonicalMediaBucketProvisioningEvidenceSha256: sha256Value(
        item.canonicalMediaBucketProvisioningEvidenceSha256,
        'canonicalMediaBucketProvisioningEvidenceSha256',
      ),
      bridgeSha: sha1(item.bridgeSha, 'bridgeSha'),
      bridgeDeploymentEvidenceSha256: sha256Value(
        item.bridgeDeploymentEvidenceSha256,
        'bridgeDeploymentEvidenceSha256',
      ),
      r2SigningTokenId: patternString(
        item.r2SigningTokenId,
        /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u,
        'r2SigningTokenId',
      ),
      r2RevocationEvidenceSha256: sha256Value(
        item.r2RevocationEvidenceSha256,
        'r2RevocationEvidenceSha256',
      ),
      mediaUploadReleaseConfigSha256: sha256Value(
        item.mediaUploadReleaseConfigSha256,
        'mediaUploadReleaseConfigSha256',
      ),
      legacyMediaScannerConfigSha256: sha256Value(
        item.legacyMediaScannerConfigSha256,
        'legacyMediaScannerConfigSha256',
      ),
    };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function namedEntries(value: unknown, label: string): Record<string, unknown>[] {
  return array(value, label).map((entry, index) => object(entry, `${label}[${index}]`));
}

const PRODUCTION_CONFIG_KEYS = new Set([
  'agent_memory', 'ai_search', 'ai_search_namespaces', 'analytics_engine_datasets',
  'artifacts', 'assets', 'cloudchamber', 'compatibility_date', 'compatibility_flags',
  'configPath', 'd1_databases', 'definedEnvironments', 'dev', 'dispatch_namespaces',
  'durable_objects', 'exports', 'flagship', 'hyperdrive', 'images', 'jsx_factory',
  'jsx_fragment', 'kv_namespaces', 'logfwdr', 'main', 'migrations', 'mtls_certificates',
  'name', 'no_bundle', 'observability', 'pipelines', 'placement', 'preview_urls',
  'python_modules', 'queues', 'r2_buckets', 'ratelimits', 'route', 'routes', 'rules',
  'secrets', 'secrets_store_secrets', 'send_email', 'services', 'topLevelName',
  'triggers', 'unsafe_hello_world', 'userConfigPath', 'vars', 'vectorize',
  'version_metadata', 'vpc_networks', 'vpc_services', 'worker_loaders', 'workers_dev',
  'workflows',
]);

const PRODUCTION_UNCLASSIFIED_BINDING_FIELDS = [
  'agent_memory', 'ai_search', 'ai_search_namespaces', 'analytics_engine_datasets',
  'artifacts', 'cloudchamber', 'dispatch_namespaces', 'durable_objects', 'flagship',
  'hyperdrive', 'kv_namespaces', 'migrations', 'mtls_certificates', 'pipelines',
  'queues', 'secrets_store_secrets', 'services', 'vectorize', 'vpc_networks',
  'vpc_services', 'worker_loaders',
] as const;

function containsConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some(containsConfiguredValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>)
    .some(containsConfiguredValue);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return String(value).length > 0;
}

function productionTopology(
  candidateRoot: string,
  baseline: ProductionTopologyBaseline,
): Record<string, unknown> {
  const configPath = exactRegularFile(
    resolve(candidateRoot, 'dist/candidary/wrangler.json'),
    'Production Wrangler config',
  );
  const config = object(JSON.parse(readFileSync(configPath, 'utf8')) as unknown, 'Production Wrangler config');
  const unknown = Object.keys(config).filter((key) => !PRODUCTION_CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Production config contains an unclassified field: ${unknown.sort().join(', ')}.`);
  }
  for (const field of PRODUCTION_UNCLASSIFIED_BINDING_FIELDS) {
    if (containsConfiguredValue(config[field])) {
      throw new Error(`Production config contains an unclassified ${field} binding surface.`);
    }
  }
  const d1 = namedEntries(config.d1_databases, 'd1_databases');
  const r2 = namedEntries(config.r2_buckets, 'r2_buckets');
  const email = namedEntries(config.send_email, 'send_email');
  const rates = namedEntries(config.ratelimits, 'ratelimits');
  const workflows = namedEntries(config.workflows, 'workflows');
  const assets = object(config.assets, 'assets');
  const images = object(config.images, 'images');
  const vars = object(config.vars, 'vars');
  const secrets = object(config.secrets, 'secrets');
  const triggers = object(config.triggers, 'triggers');
  const observability = object(config.observability, 'observability');
  const placement = object(config.placement, 'placement');
  const versionMetadata = object(config.version_metadata, 'version_metadata');
  const requiredSecrets = array(secrets.required, 'secrets.required').map((entry) => exactString(entry, 'secret name')).sort();
  const topology = {
    worker: {
      name: config.name,
      workersDev: config.workers_dev,
      previewUrls: config.preview_urls,
      routes: config.routes ?? [],
      main: config.main,
      versionMetadataBinding: versionMetadata.binding,
    },
    d1: d1.map((entry) => ({
      binding: entry.binding, databaseName: entry.database_name,
      databaseId: entry.database_id, migrationsDir: entry.migrations_dir,
    })),
    r2: r2.map((entry) => ({ binding: entry.binding, bucketName: entry.bucket_name })),
    images: { binding: images.binding },
    assets: {
      binding: assets.binding, directory: assets.directory,
      notFoundHandling: assets.not_found_handling, runWorkerFirst: assets.run_worker_first,
    },
    email: email.map((entry) => ({ name: entry.name })),
    rateLimits: rates.map((entry) => ({ name: entry.name, namespaceId: entry.namespace_id, simple: entry.simple })),
    workflows: workflows.map((entry) => ({
      name: entry.name, binding: entry.binding, className: entry.class_name,
    })),
    crons: triggers.crons,
    vars,
    requiredSecrets,
    observability,
    placement,
  };

  const expected = {
    worker: {
      name: 'candidary', workersDev: false, previewUrls: false, routes: [],
      main: 'index.js', versionMetadataBinding: 'CF_VERSION_METADATA',
    },
    d1: [{
      binding: 'DB', databaseName: PRODUCTION_DATABASE_NAME,
      databaseId: PRODUCTION_DATABASE_ID, migrationsDir: '../../migrations',
    }],
    r2: [
      { binding: LEGACY_MEDIA_BINDING, bucketName: LEGACY_MEDIA_BUCKET_NAME },
      ...(baseline === 'post-cutover' ? [{
        binding: CANONICAL_MEDIA_BINDING,
        bucketName: CANONICAL_MEDIA_BUCKET_NAME,
      }] : []),
    ],
    images: { binding: 'IMAGES' },
    assets: {
      binding: 'ASSETS', directory: '../client',
      notFoundHandling: 'single-page-application', runWorkerFirst: assets.run_worker_first,
    },
    email: [{ name: 'EMAIL' }],
    rateLimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespaceId: '1001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespaceId: '1002', simple: { limit: 30, period: 60 } },
      ...(baseline === 'post-cutover' ? [{
        name: 'GUEST_MESSAGE_RATE_LIMIT', namespaceId: '1003', simple: { limit: 120, period: 60 },
      }] : []),
    ],
    workflows: [
      { name: 'candidary-export', binding: 'EXPORT_WORKFLOW', className: 'ExportWorkflow' },
      { name: 'candidary-cover-render', binding: 'COVER_RENDER_WORKFLOW', className: 'CoverRenderWorkflow' },
      { name: 'candidary-cover-backfill', binding: 'COVER_BACKFILL_WORKFLOW', className: 'CoverBackfillWorkflow' },
    ],
    crons: ['17 3 * * *', '47 * * * *'],
    vars: baseline === 'post-cutover'
      ? {
        APP_ORIGIN: 'https://candidary.app', ALTERNATE_ORIGINS: 'https://candidary.online',
        EMAIL_FROM: 'hello@candidary.app',
      }
      : {
        APP_ORIGIN: 'https://candidary.app', ALTERNATE_ORIGINS: 'https://candidary.online',
        R2_ACCOUNT_ID: vars.R2_ACCOUNT_ID, R2_BUCKET_NAME: 'candidary-media',
        EMAIL_FROM: 'hello@candidary.app',
      },
    requiredSecrets: baseline === 'post-cutover'
      ? [...POST_CUTOVER_REQUIRED_SECRET_NAMES].sort()
      : baseline === 'media-write-bridge'
        ? [...HISTORICAL_PHASE_3_REQUIRED_SECRET_NAMES]
        : [...HISTORICAL_PHASE_3_REQUIRED_SECRET_NAMES],
    observability: { enabled: true },
    placement: { mode: 'smart' },
  };
  if ((baseline !== 'post-cutover' && !ACCOUNT_ID_PATTERN.test(String(vars.R2_ACCOUNT_ID)))
    || canonicalJson(topology) !== canonicalJson(expected)) {
    throw new Error('Generated config is not the exact canonical production topology.');
  }
  return topology;
}

export function productionTopologySha256(candidateRoot: string): string {
  return sha256(canonicalJson(productionTopology(candidateRoot, 'post-cutover')));
}

export function historicalPhase3ProductionTopologySha256(candidateRoot: string): string {
  return sha256(canonicalJson(productionTopology(candidateRoot, 'historical-phase-3')));
}

export function mediaWriteBridgeProductionTopologySha256(candidateRoot: string): string {
  return sha256(canonicalJson(productionTopology(candidateRoot, 'media-write-bridge')));
}

function productionAccountId(
  candidateRoot: string,
  baseline: Exclude<ProductionTopologyBaseline, 'post-cutover'>,
): string {
  const topology = productionTopology(candidateRoot, baseline);
  return (topology.vars as Record<string, unknown>).R2_ACCOUNT_ID as string;
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return [...value];
}

function assertZeroCounts(value: unknown): ZeroLegacyObservation {
  const counts = exactRecord(value, [
    'legacyRows', 'blockingJobs', 'incompleteActiveSets', 'uploadsWithoutActiveSet',
  ], 'zero-count observation');
  for (const [name, count] of Object.entries(counts)) {
    if (count !== 0) throw new Error(`Production zero proof ${name} must be exactly zero.`);
  }
  return value as ZeroLegacyObservation;
}

function validatedObservation(value: unknown): ProductionDatabaseObservation {
  const observation = exactRecord(value, [
    'ledger', 'pendingMigrations', 'schemaSha256', 'integrity',
    'foreignKeyRows', 'triggerNames', 'zeroCounts',
  ], 'production database observation');
  if (observation.integrity !== 'ok' || observation.foreignKeyRows !== 0) {
    throw new Error('Production database integrity or foreign keys are not clean.');
  }
  return {
    ledger: exactStringArray(observation.ledger, 'ledger'),
    pendingMigrations: exactStringArray(observation.pendingMigrations, 'pending migrations'),
    schemaSha256: sha256Value(observation.schemaSha256, 'schemaSha256'),
    integrity: 'ok', foreignKeyRows: 0,
    triggerNames: exactStringArray(observation.triggerNames, 'trigger names'),
    zeroCounts: assertZeroCounts(observation.zeroCounts),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function expectedLedger(candidate: VerifiedReleaseCandidate, count: number): string[] {
  return candidate.migrations.slice(0, count).map((migration) => basename(migration.path));
}

function assertPreState(
  observation: ProductionDatabaseObservation,
  candidate: VerifiedReleaseCandidate,
  authorization: ProductionMigrationAuthorization,
): void {
  const historical = authorization.schemaVersion === 1;
  const preCount = historical ? 13 : 14;
  const preBoundary = historical ? PHASE_2_MIGRATION : PHASE_3_MIGRATION;
  const pendingMigration = historical ? PHASE_3_MIGRATION : POST_CUTOVER_MIGRATION;
  const expected = expectedLedger(candidate, preCount);
  if (expected.at(-1) !== preBoundary || !sameStrings(observation.ledger, expected)) {
    throw new Error(`Production ledger is not exactly at the ${preBoundary} boundary.`);
  }
  if (!sameStrings(observation.pendingMigrations, [pendingMigration])) {
    throw new Error(`Production must have only the exact ${pendingMigration} migration pending.`);
  }
  if (observation.schemaSha256 !== authorization.preSchemaSha256) {
    throw new Error('Production pre-migration schema does not match authorization.');
  }
  if (!historical && !sameStrings(observation.triggerNames, [...PRODUCTION_TRIGGER_NAMES])) {
    throw new Error('Production pre-migration trigger set is incomplete or unexpected.');
  }
}

function assertPostState(
  observation: ProductionDatabaseObservation,
  candidate: VerifiedReleaseCandidate,
  authorization: ProductionMigrationAuthorization,
): void {
  const postCount = authorization.schemaVersion === 1 ? 14 : 15;
  if (!sameStrings(observation.ledger, expectedLedger(candidate, postCount))) {
    throw new Error('Production post-migration ledger is incomplete or out of order.');
  }
  if (observation.pendingMigrations.length !== 0) {
    throw new Error('Production post-migration state still has a pending migration.');
  }
  if (observation.schemaSha256 !== authorization.postSchemaSha256) {
    throw new Error('Production post-migration schema fingerprint does not match authorization.');
  }
  const expectedTriggers = authorization.schemaVersion === 1
    ? PRODUCTION_TRIGGER_NAMES
    : POST_CUTOVER_PRODUCTION_TRIGGER_NAMES;
  if (!sameStrings(observation.triggerNames, [...expectedTriggers])) {
    throw new Error('Production post-migration trigger set is incomplete or unexpected.');
  }
}

function sameObservation(left: ProductionDatabaseObservation, right: ProductionDatabaseObservation): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateCrossReferences(
  request: MigrateReleaseRequest,
  candidate: VerifiedReleaseCandidate,
  authorization: ProductionMigrationAuthorization,
  bookmark: CanonicalInput<TimeTravelBookmarkV1>,
  now: string,
): void {
  if (authorization.approvedMainSha !== request.sha || authorization.candidateSha !== request.sha
    || candidate.sha !== request.sha || authorization.manifestSha256 !== candidate.manifestSha256) {
    throw new Error('Production authorization does not bind the exact landed candidate and manifest.');
  }
  const topologySha = authorization.schemaVersion === 1
    ? historicalPhase3ProductionTopologySha256(candidate.candidateRoot)
    : productionTopologySha256(candidate.candidateRoot);
  const accountId = authorization.schemaVersion === 1
    ? productionAccountId(candidate.candidateRoot, 'historical-phase-3')
    : authorization.accountId;
  if (authorization.productionTopologySha256 !== topologySha
    || authorization.accountId !== accountId
    || authorization.databaseName !== PRODUCTION_DATABASE_NAME
    || authorization.databaseId !== PRODUCTION_DATABASE_ID) {
    throw new Error('Production authorization does not bind the canonical account, config, and D1 topology.');
  }
  if (bookmark.digest !== authorization.bookmarkSha256
    || bookmark.value.accountId !== authorization.accountId
    || bookmark.value.databaseName !== authorization.databaseName
    || bookmark.value.databaseId !== authorization.databaseId) {
    throw new Error('Time Travel bookmark does not bind the authorized production D1.');
  }
  if (authorization.authorizedAt > now || now >= authorization.expiresAt
    || bookmark.value.recordedAt > authorization.authorizedAt) {
    throw new Error('Production authorization or Time Travel bookmark timing is invalid or expired.');
  }
  const migration = candidate.migrations.at(-1);
  const migrationCount = authorization.schemaVersion === 1 ? 14 : 15;
  const migrationName = authorization.schemaVersion === 1 ? PHASE_3_MIGRATION : POST_CUTOVER_MIGRATION;
  if (candidate.migrationCount !== migrationCount || basename(migration?.path ?? '') !== migrationName
    || migration?.sha256 !== authorization.migrationSha256) {
    throw new Error('Production authorization does not bind the sole manifest-hashed migration.');
  }
}

function validateCandidateCli(candidate: VerifiedReleaseCandidate): void {
  const expected = resolve(candidate.candidateRoot, 'node_modules/wrangler/bin/wrangler.js');
  let actual: string;
  try {
    actual = realpathSync(exactRegularFile(candidate.wranglerCliPath, 'Wrangler CLI'));
  } catch (error) {
    throw new Error('Wrangler CLI is not the repository-pinned candidate executable.', { cause: error });
  }
  if (actual !== realpathSync(expected) || !within(realpathSync(candidate.candidateRoot), actual)) {
    throw new Error('Wrangler CLI must remain inside the exact candidate root.');
  }
}

interface ValidatedBridgePrerequisites {
  bucket: CanonicalMediaBucketProvisioningEvidenceV1;
  bucketSha256: string;
  bridge: MediaWriteBridgeDeploymentEvidenceV1;
  bridgeSha256: string;
  revocation: R2SigningTokenRevocationEvidenceV1;
  revocationSha256: string;
  mediaUploadReleaseConfigSha256: string;
  legacyMediaScannerConfigSha256: string;
}

function validateBridgePrerequisites(
  request: MigrateReleaseRequest,
  candidate: VerifiedReleaseCandidate,
  authorization: ProductionMigrationAuthorizationV2,
): ValidatedBridgePrerequisites {
  if (request.canonicalBucketEvidencePath === undefined
    || request.bridgeEvidencePath === undefined || request.revocationEvidencePath === undefined) {
    throw new Error('Schema-v2 migration requires exact bucket, bridge, and revocation evidence inputs.');
  }
  const bucketInput = verifyCanonicalMediaBucketProvisioningEvidence(
    request.canonicalBucketEvidencePath,
  );
  const bridgeInput = verifyMediaWriteBridgeDeploymentEvidence(request.bridgeEvidencePath);
  const revocationInput = verifyR2SigningTokenRevocationEvidence(request.revocationEvidencePath);
  const runtimeInput = verifyMediaUploadReleaseContract(
    resolve(candidate.candidateRoot, MEDIA_UPLOAD_RELEASE_CONFIG_PATH),
    'canonical-cutover-disabled',
  );
  const scannerInput = verifyLegacyMediaScannerContract(resolve(
    candidate.candidateRoot,
    LEGACY_MEDIA_SCANNER_CONFIG_PATH,
  ));
  const bucket = bucketInput.artifact;
  const bridge = bridgeInput.artifact;
  const revocation = revocationInput.artifact;
  if (bucketInput.sha256 !== authorization.canonicalMediaBucketProvisioningEvidenceSha256
    || bucket.accountId !== authorization.accountId
    || bridgeInput.sha256 !== authorization.bridgeDeploymentEvidenceSha256
    || bridge.bridgeCandidate.sha !== authorization.bridgeSha
    || bridge.bridgeCandidate.migrationCount !== 14
    || bridge.deployment.tagSha !== authorization.bridgeSha
    || bridge.deployment.trafficPercent !== 100
    || bridge.production.accountId !== authorization.accountId
    || bridge.production.workerName !== 'candidary'
    || bridge.r2SigningTokenId !== authorization.r2SigningTokenId
    || bridge.canonicalBucketProvisioningEvidenceSha256 !== bucketInput.sha256) {
    throw new Error('Schema-v2 authorization does not bind the exact 100-percent bridge deployment.');
  }
  if (revocationInput.sha256 !== authorization.r2RevocationEvidenceSha256
    || revocation.bridgeDeploymentEvidenceSha256 !== bridgeInput.sha256
    || revocation.accountId !== authorization.accountId
    || revocation.r2SigningTokenId !== authorization.r2SigningTokenId
    || revocation.canonicalBucketProvisioningEvidenceSha256 !== bucketInput.sha256
    || revocation.status !== 'revoked') {
    throw new Error('Schema-v2 authorization does not bind exact revoked R2 signing-token evidence.');
  }
  if (runtimeInput.sha256 !== authorization.mediaUploadReleaseConfigSha256
    || scannerInput.sha256 !== authorization.legacyMediaScannerConfigSha256) {
    throw new Error('Schema-v2 authorization does not bind the exact runtime and permanent scanner configs.');
  }
  const bridgeExportCanary = bridge.signerFree.exportDownloadCanary;
  const postRevocationExportCanary = revocation.bridgeExportDownloadCanaryAfterRevocation;
  if (bridgeExportCanary.expectedArtifactSha256 !== postRevocationExportCanary.expectedArtifactSha256
    || bridgeExportCanary.method !== postRevocationExportCanary.method
    || bridgeExportCanary.artifactUrlSha256 !== postRevocationExportCanary.artifactUrlSha256
    || bridgeExportCanary.expectedByteLength !== postRevocationExportCanary.expectedByteLength
    || postRevocationExportCanary.responseSha256 !== bridgeExportCanary.responseSha256
    || postRevocationExportCanary.responseByteLength !== bridgeExportCanary.responseByteLength) {
    throw new Error('Post-revocation export canary does not reproduce the exact bridge artifact bytes.');
  }
  if (bucket.observedAt > bridge.observedAt
    || bridge.observedAt > revocation.revokedAt
    || revocation.revokedAt > revocation.providerStatus.observedAt
    || revocation.providerStatus.observedAt > revocation.legacyBucketSignerProbe.invokedAt
    || revocation.providerStatus.observedAt > revocation.canonicalBucketSignerProbe.invokedAt
    || revocation.canonicalBucketSignerProbe.invokedAt
      > revocation.canonicalPostRevocationEmpty.observedAt
    || revocation.legacyBucketSignerProbe.invokedAt
      > revocation.legacyBucketProbeAbsence.observedAt
    || revocation.canonicalPostRevocationEmpty.observedAt > authorization.authorizedAt
    || revocation.legacyBucketProbeAbsence.observedAt > authorization.authorizedAt
    || postRevocationExportCanary.observedAt > authorization.authorizedAt) {
    throw new Error('Bridge deployment, R2 revocation, status observation, and authorization are out of order.');
  }
  return {
    bucket,
    bucketSha256: bucketInput.sha256,
    bridge,
    bridgeSha256: bridgeInput.sha256,
    revocation,
    revocationSha256: revocationInput.sha256,
    mediaUploadReleaseConfigSha256: runtimeInput.sha256,
    legacyMediaScannerConfigSha256: scannerInput.sha256,
  };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function productionMigrationEvidencePath(
  candidate: VerifiedReleaseCandidate,
  runId: string,
): string {
  return resolve(
    candidate.candidateRoot,
    'output/production-migration',
    candidate.sha,
    runId,
    'post-cutover-migration-evidence.json',
  );
}

function prepareEvidenceOutput(candidate: VerifiedReleaseCandidate, runId: string): string {
  const path = productionMigrationEvidencePath(candidate, runId);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  if (!within(realpathSync(candidate.candidateRoot), realpathSync(parent))) {
    throw new Error('Production migration evidence path escaped the candidate root.');
  }
  if (pathExists(path) || pathExists(`${path}.sha256`)) {
    throw new Error('Production migration evidence output must be absent before migration.');
  }
  return path;
}

function writeProductionMigrationEvidence(
  path: string,
  evidence: ProductionMigrationEvidenceV2,
): { path: string; sha256: string } {
  const bytes = `${canonicalJson(evidence)}\n`;
  const digest = sha256(bytes);
  writeFileSync(path, bytes, { encoding: 'utf8', flag: 'wx' });
  try {
    writeFileSync(
      `${path}.sha256`,
      `${digest}  post-cutover-migration-evidence.json\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return { path, sha256: digest };
}

function parseProductionMigrationEvidence(value: unknown): ProductionMigrationEvidenceV2 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'status', 'runId', 'candidate', 'production',
    'authorizationSha256', 'bridge', 'mediaUploadReleaseConfigSha256',
    'legacyMediaScannerConfigSha256',
    'canonicalMediaBucketProvisioningEvidenceSha256',
    'migration', 'before', 'after', 'rollback', 'observedAt',
  ], 'Production migration evidence');
  if (item.kind !== 'candidary.production-migration-evidence'
    || item.schemaVersion !== 2 || item.status !== 'passed') {
    throw new Error('Production migration evidence identity or status is invalid.');
  }
  const candidate = exactRecord(item.candidate, [
    'sha', 'approvedMainSha', 'manifestSha256', 'artifactTreeSha256', 'bindingTopologySha256',
  ], 'Production migration evidence candidate');
  const production = exactRecord(item.production, [
    'topologySha256', 'accountId', 'databaseName', 'databaseId',
  ], 'Production migration evidence topology');
  const migration = exactRecord(item.migration, [
    'name', 'sha256', 'bundleSha256',
  ], 'Production migration evidence migration');
  const bridge = exactRecord(item.bridge, [
    'sha', 'deploymentEvidenceSha256', 'versionId', 'r2SigningTokenId',
    'revocationEvidenceSha256', 'revocationReceiptSha256', 'statusObservationSha256',
  ], 'Production migration bridge evidence');
  if (migration.name !== POST_CUTOVER_MIGRATION) {
    throw new Error(`Production migration evidence must name only ${POST_CUTOVER_MIGRATION}.`);
  }
  const before = exactRecord(item.before, ['ledger', 'schemaSha256'], 'Production migration evidence pre-state');
  const after = validatedObservation(item.after);
  const rollback = exactRecord(item.rollback, [
    'bookmarkSha256', 'bookmarkRecordedAt', 'rollbackOwner',
  ], 'Production migration rollback evidence');
  return {
    kind: 'candidary.production-migration-evidence',
    schemaVersion: 2,
    status: 'passed',
    runId: patternString(item.runId, UUID_PATTERN, 'migration evidence runId'),
    candidate: {
      sha: sha1(candidate.sha, 'evidence candidate sha'),
      approvedMainSha: sha1(candidate.approvedMainSha, 'evidence approved main sha'),
      manifestSha256: sha256Value(candidate.manifestSha256, 'evidence manifest sha256'),
      artifactTreeSha256: sha256Value(candidate.artifactTreeSha256, 'evidence artifact tree sha256'),
      bindingTopologySha256: sha256Value(
        candidate.bindingTopologySha256,
        'evidence binding topology sha256',
      ),
    },
    production: {
      topologySha256: sha256Value(production.topologySha256, 'evidence production topology sha256'),
      accountId: patternString(production.accountId, ACCOUNT_ID_PATTERN, 'evidence accountId'),
      databaseName: exactString(production.databaseName, 'evidence database name'),
      databaseId: patternString(production.databaseId, D1_ID_PATTERN, 'evidence database id'),
    },
    authorizationSha256: sha256Value(item.authorizationSha256, 'evidence authorization sha256'),
    bridge: {
      sha: sha1(bridge.sha, 'evidence bridge sha'),
      deploymentEvidenceSha256: sha256Value(
        bridge.deploymentEvidenceSha256,
        'evidence bridge deployment sha256',
      ),
      versionId: patternString(bridge.versionId, UUID_PATTERN, 'evidence bridge versionId'),
      r2SigningTokenId: patternString(
        bridge.r2SigningTokenId,
        /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u,
        'evidence R2 signing token ID',
      ),
      revocationEvidenceSha256: sha256Value(
        bridge.revocationEvidenceSha256,
        'evidence revocation sha256',
      ),
      revocationReceiptSha256: sha256Value(
        bridge.revocationReceiptSha256,
        'evidence revocation receipt sha256',
      ),
      statusObservationSha256: sha256Value(
        bridge.statusObservationSha256,
        'evidence revocation status sha256',
      ),
    },
    mediaUploadReleaseConfigSha256: sha256Value(
      item.mediaUploadReleaseConfigSha256,
      'evidence media upload release config sha256',
    ),
    legacyMediaScannerConfigSha256: sha256Value(
      item.legacyMediaScannerConfigSha256,
      'evidence legacy media scanner config sha256',
    ),
    canonicalMediaBucketProvisioningEvidenceSha256: sha256Value(
      item.canonicalMediaBucketProvisioningEvidenceSha256,
      'evidence canonical media bucket provisioning sha256',
    ),
    migration: {
      name: POST_CUTOVER_MIGRATION,
      sha256: sha256Value(migration.sha256, 'evidence migration sha256'),
      bundleSha256: sha256Value(migration.bundleSha256, 'evidence bundle sha256'),
    },
    before: {
      ledger: exactStringArray(before.ledger, 'evidence pre-ledger'),
      schemaSha256: sha256Value(before.schemaSha256, 'evidence pre-schema sha256'),
    },
    after,
    rollback: {
      bookmarkSha256: sha256Value(rollback.bookmarkSha256, 'evidence bookmark sha256'),
      bookmarkRecordedAt: instant(rollback.bookmarkRecordedAt, 'evidence bookmark recordedAt'),
      rollbackOwner: patternString(
        rollback.rollbackOwner,
        /^[a-z][a-z0-9._-]{2,63}$/u,
        'evidence rollback owner',
      ),
    },
    observedAt: instant(item.observedAt, 'evidence observedAt'),
  };
}

export function verifyPostCutoverMigrationEvidence(
  path: string,
  candidate: VerifiedReleaseCandidate,
): { artifact: ProductionMigrationEvidenceV2; path: string; sha256: string } {
  if (candidate.migrationCount !== 15 || candidate.manifest.bindings === null
    || candidate.manifest.artifacts === null) {
    throw new Error('Post-cutover migration evidence requires one complete 15-migration candidate.');
  }
  const input = readCanonicalInput<unknown>(path, 'Production migration evidence');
  const artifact = parseProductionMigrationEvidence(input.value);
  const scannerInput = verifyLegacyMediaScannerContract(resolve(
    candidate.candidateRoot,
    LEGACY_MEDIA_SCANNER_CONFIG_PATH,
  ));
  const expectedBefore = expectedLedger(candidate, 14);
  const expectedAfter = expectedLedger(candidate, 15);
  const migration = candidate.migrations.at(-1)!;
  if (artifact.candidate.bindingTopologySha256 !== candidate.manifest.bindings.sourceTopologySha256
    || artifact.production.topologySha256 !== productionTopologySha256(candidate.candidateRoot)
    || artifact.legacyMediaScannerConfigSha256 !== scannerInput.sha256
    || artifact.production.databaseName !== PRODUCTION_DATABASE_NAME
    || artifact.production.databaseId !== PRODUCTION_DATABASE_ID
    || artifact.migration.name !== POST_CUTOVER_MIGRATION
    || artifact.migration.sha256 !== migration.sha256
    || !sameStrings(artifact.before.ledger, expectedBefore)
    || artifact.before.ledger.at(-1) !== PHASE_3_MIGRATION
    || !sameStrings(artifact.after.ledger, expectedAfter)
    || artifact.after.ledger.at(-1) !== POST_CUTOVER_MIGRATION
    || artifact.after.pendingMigrations.length !== 0
    || !sameStrings(artifact.after.triggerNames, [...POST_CUTOVER_PRODUCTION_TRIGGER_NAMES])
    || artifact.before.schemaSha256 === artifact.after.schemaSha256
    || artifact.rollback.bookmarkRecordedAt > artifact.observedAt) {
    throw new Error('Production migration evidence does not bind the exact post-cutover migration closure.');
  }
  return { artifact, path: input.path, sha256: input.digest };
}

export function parseMigrateReleaseArgs(
  args: readonly string[],
  cwd = process.cwd(),
): MigrateReleaseArguments {
  const required = new Set(['--sha', '--manifest', '--authorization', '--bookmark']);
  const accepted = new Set([
    ...required,
    '--bridge-evidence',
    '--revocation-evidence',
    '--canonical-bucket-evidence',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !accepted.has(flag) || values.has(flag)) {
      throw new Error(`Unknown or duplicate production migration argument ${String(flag)}.`);
    }
    if (!value) throw new Error(`Production migration argument ${flag} is missing or empty.`);
    values.set(flag, value);
  }
  for (const flag of required) {
    if (!values.has(flag)) throw new Error(`Production migration argument ${flag} is required.`);
  }
  const sha = sha1(values.get('--sha'), '--sha');
  const result: MigrateReleaseArguments = {
    sha,
    manifestPath: exactRegularFile(resolve(cwd, values.get('--manifest')!), 'Candidate manifest'),
    authorizationPath: exactRegularFile(resolve(cwd, values.get('--authorization')!), 'Production authorization'),
    bookmarkPath: exactRegularFile(resolve(cwd, values.get('--bookmark')!), 'Time Travel bookmark'),
  };
  const bridgeEvidence = values.get('--bridge-evidence');
  const revocationEvidence = values.get('--revocation-evidence');
  const canonicalBucketEvidence = values.get('--canonical-bucket-evidence');
  const evidenceCount = [bridgeEvidence, revocationEvidence, canonicalBucketEvidence]
    .filter((value) => value !== undefined).length;
  if (evidenceCount !== 0 && evidenceCount !== 3) {
    throw new Error('Production bucket, bridge, and revocation evidence arguments must be supplied together.');
  }
  if (bridgeEvidence !== undefined && revocationEvidence !== undefined
    && canonicalBucketEvidence !== undefined) {
    result.bridgeEvidencePath = exactRegularFile(
      resolve(cwd, bridgeEvidence),
      'Media write bridge deployment evidence',
    );
    result.revocationEvidencePath = exactRegularFile(
      resolve(cwd, revocationEvidence),
      'R2 signing token revocation evidence',
    );
    result.canonicalBucketEvidencePath = exactRegularFile(
      resolve(cwd, canonicalBucketEvidence),
      'Canonical media bucket provisioning evidence',
    );
  }
  return result;
}

function migrationCommand(candidate: VerifiedReleaseCandidate, bundlePath: string): ProductionMigrationCommand {
  return {
    executable: process.execPath,
    args: [
      candidate.wranglerCliPath,
      'd1', 'execute', 'DB', '--remote',
      '--config', 'dist/candidary/wrangler.json',
      '--file', bundlePath,
    ],
    cwd: candidate.candidateRoot,
    shell: false,
    bundlePath,
  };
}

export function runMigrateRelease(
  request: MigrateReleaseRequest,
  adapters: MigrateReleaseAdapters = defaultAdapters,
): ProductionMigrationResult {
  const authorizationInput = readCanonicalInput<unknown>(request.authorizationPath, 'Production authorization');
  const authorization = parseAuthorization(authorizationInput.value);
  if (authorization.schemaVersion === 1
    && (request.bridgeEvidencePath !== undefined || request.revocationEvidencePath !== undefined
      || request.canonicalBucketEvidencePath !== undefined)) {
    throw new Error('Historical schema-v1 migration must not accept bucket, bridge, or revocation evidence.');
  }
  const bookmarkInput = readCanonicalInput<unknown>(request.bookmarkPath, 'Time Travel bookmark');
  const bookmark = {
    ...bookmarkInput,
    value: parseBookmark(bookmarkInput.value),
  };
  const verificationRequest: ReleaseCandidateVerificationRequest = {
    candidateRoot: request.candidateRoot,
    sha: request.sha,
    manifestPath: request.manifestPath,
    approvedBaseSha: APPROVED_BASE_SHA,
    expectedMigrationCount: authorization.schemaVersion === 1 ? 14 : 15,
  };
  const candidate = adapters.verifyCandidate(verificationRequest);
  validateCrossReferences(request, candidate, authorization, bookmark, adapters.now());
  validateCandidateCli(candidate);
  const bridgePrerequisites = authorization.schemaVersion === 2
    ? validateBridgePrerequisites(request, candidate, authorization)
    : undefined;
  const evidencePath = authorization.schemaVersion === 2
    ? prepareEvidenceOutput(candidate, authorization.runId)
    : undefined;
  const context = { candidate, authorization };
  const before = validatedObservation(adapters.observeDatabase(context));
  assertPreState(before, candidate, authorization);

  const bundlePath = resolve(
    candidate.candidateRoot,
    'output/production-migration',
    candidate.sha,
    authorization.runId,
    authorization.schemaVersion === 1
      ? '0014-event-cover-invariants.sql'
      : '0015-curated-private-guestbook.sql',
  );
  let bundleCreated = false;
  try {
    const bundle = authorization.schemaVersion === 1
      ? buildAtomicMigrationBundle({
        verifiedCandidate: candidate,
        expectedLedger: before.ledger,
        migration: PHASE_3_MIGRATION,
        outputPath: bundlePath,
      })
      : buildPostCutoverAtomicMigrationBundle({
        verifiedCandidate: candidate,
        expectedLedger: before.ledger,
        migration: POST_CUTOVER_MIGRATION,
        outputPath: bundlePath,
      });
    bundleCreated = true;
    if (bundle.sha256 !== authorization.bundleSha256
      || bundle.migrationHash !== authorization.migrationSha256) {
      throw new Error('Generated atomic migration bundle does not match production authorization.');
    }

    const rechecked = adapters.verifyCandidate(verificationRequest);
    if (rechecked.sha !== candidate.sha || rechecked.tree !== candidate.tree
      || rechecked.manifestSha256 !== candidate.manifestSha256
      || rechecked.wranglerCliPath !== candidate.wranglerCliPath) {
      throw new Error('Exact candidate identity drifted immediately before production migration.');
    }
    validateCandidateCli(rechecked);
    if (adapters.hashFile(bundle.outputPath) !== bundle.sha256) {
      throw new Error('Atomic migration bundle bytes drifted before invocation.');
    }

    const command = migrationCommand(rechecked, bundle.outputPath);
    const exitCode = adapters.run(command);
    if (!Number.isInteger(exitCode) || exitCode !== 0) {
      const afterFailure = validatedObservation(adapters.observeDatabase(context));
      if (!sameObservation(afterFailure, before)) {
        throw new Error('Failed production migration left residual schema or ledger state; rollback proof failed.');
      }
      throw new Error('Atomic production migration command failed; exact pre-state rollback was verified.');
    }
    const after = validatedObservation(adapters.observeDatabase(context));
    assertPostState(after, candidate, authorization);
    const result: ProductionMigrationResult = {
      candidateSha: candidate.sha,
      migrationName: authorization.migrationName,
      migrationSha256: bundle.migrationHash,
      bundleSha256: bundle.sha256,
      preSchemaSha256: before.schemaSha256,
      postSchemaSha256: after.schemaSha256,
    };
    if (authorization.schemaVersion === 1 || evidencePath === undefined) return result;
    if (candidate.manifest.bindings === null || candidate.manifest.artifacts === null) {
      throw new Error('Verified post-cutover candidate lost deployment identity evidence.');
    }
    const evidence: ProductionMigrationEvidenceV2 = {
      kind: 'candidary.production-migration-evidence',
      schemaVersion: 2,
      status: 'passed',
      runId: authorization.runId,
      candidate: {
        sha: candidate.sha,
        approvedMainSha: authorization.approvedMainSha,
        manifestSha256: candidate.manifestSha256,
        artifactTreeSha256: candidate.artifactTreeSha256,
        bindingTopologySha256: candidate.manifest.bindings.sourceTopologySha256,
      },
      production: {
        topologySha256: authorization.productionTopologySha256,
        accountId: authorization.accountId,
        databaseName: authorization.databaseName,
        databaseId: authorization.databaseId,
      },
      authorizationSha256: authorizationInput.digest,
      bridge: {
        sha: bridgePrerequisites!.bridge.bridgeCandidate.sha,
        deploymentEvidenceSha256: bridgePrerequisites!.bridgeSha256,
        versionId: bridgePrerequisites!.bridge.deployment.versionId,
        r2SigningTokenId: authorization.r2SigningTokenId,
        revocationEvidenceSha256: bridgePrerequisites!.revocationSha256,
        revocationReceiptSha256: bridgePrerequisites!.revocation.providerResponses.revocationReceiptSha256,
        statusObservationSha256: bridgePrerequisites!.revocation.providerResponses.statusObservationSha256,
      },
      mediaUploadReleaseConfigSha256: bridgePrerequisites!.mediaUploadReleaseConfigSha256,
      legacyMediaScannerConfigSha256: bridgePrerequisites!.legacyMediaScannerConfigSha256,
      canonicalMediaBucketProvisioningEvidenceSha256: bridgePrerequisites!.bucketSha256,
      migration: {
        name: POST_CUTOVER_MIGRATION,
        sha256: bundle.migrationHash,
        bundleSha256: bundle.sha256,
      },
      before: { ledger: before.ledger, schemaSha256: before.schemaSha256 },
      after,
      rollback: {
        bookmarkSha256: bookmark.digest,
        bookmarkRecordedAt: bookmark.value.recordedAt,
        rollbackOwner: authorization.rollbackOwner,
      },
      observedAt: adapters.now(),
    };
    const written = writeProductionMigrationEvidence(evidencePath, evidence);
    return { ...result, evidencePath: written.path, evidenceSha256: written.sha256 };
  } finally {
    if (bundleCreated) rmSync(bundlePath, { force: true });
  }
}

function gitValue(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function wranglerRows(candidate: VerifiedReleaseCandidate, sql: string): Array<Record<string, unknown>> {
  const output = execFileSync(process.execPath, [
    candidate.wranglerCliPath,
    'd1', 'execute', 'DB', '--remote',
    '--config', 'dist/candidary/wrangler.json',
    '--command', sql,
    '--json',
  ], {
    cwd: candidate.candidateRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Wrangler returned an unexpected D1 JSON result.');
  const first = object(parsed[0], 'Wrangler D1 result');
  return namedEntries(first.results, 'Wrangler D1 rows');
}

function numericCell(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`D1 observation ${name} is invalid.`);
  }
  return value as number;
}

function defaultObservation(context: ProductionObservationContext): ProductionDatabaseObservation {
  const { candidate } = context;
  const ledger = wranglerRows(candidate, 'SELECT name FROM d1_migrations ORDER BY id;')
    .map((row) => exactString(row.name, 'D1 migration name'));
  const schema = wranglerRows(candidate,
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;",
  );
  const integrityRows = wranglerRows(candidate, 'PRAGMA integrity_check;');
  const integrity = integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok' ? 'ok' : 'failed';
  const foreignKeyRows = wranglerRows(candidate, 'PRAGMA foreign_key_check;').length;
  const triggerNames = schema
    .filter((row) => row.type === 'trigger')
    .map((row) => exactString(row.name, 'trigger name'))
    .sort();
  const counts = wranglerRows(candidate, [
    'SELECT',
    "(SELECT count(*) FROM events e WHERE e.deleted_at IS NULL AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL) AS legacyRows,",
    "(SELECT count(*) FROM event_cover_backfill_jobs j JOIN events e ON e.id = j.event_id WHERE j.status IN ('needs_replacement','failed') AND e.deleted_at IS NULL AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL) AS blockingJobs,",
    "(SELECT count(*) FROM event_cover_render_sets s WHERE s.state = 'active' AND (s.manifest_sha256 IS NULL OR s.required_slots <> (SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id) OR s.required_slots <> (SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id AND o.event_id = s.event_id))) AS incompleteActiveSets,",
    "(SELECT count(*) FROM events e WHERE e.deleted_at IS NULL AND json_extract(e.cover_config, '$.source.kind') = 'upload' AND (e.cover_object_key IS NULL OR NOT EXISTS (SELECT 1 FROM event_cover_render_sets s JOIN event_cover_masters m ON m.id = s.master_id WHERE s.id = e.cover_render_set_id AND s.event_id = e.id AND s.state = 'active' AND m.event_id = e.id AND m.object_key = e.cover_object_key))) AS uploadsWithoutActiveSet;",
  ].join(' '));
  if (counts.length !== 1) throw new Error('D1 zero-proof query returned the wrong row count.');
  const names = expectedLedger(candidate, candidate.migrationCount);
  return {
    ledger,
    pendingMigrations: names.filter((name) => !ledger.includes(name)),
    schemaSha256: sha256(canonicalJson(schema)),
    integrity: integrity as 'ok',
    foreignKeyRows: foreignKeyRows as 0,
    triggerNames,
    zeroCounts: {
      legacyRows: numericCell(counts[0]!, 'legacyRows'),
      blockingJobs: numericCell(counts[0]!, 'blockingJobs'),
      incompleteActiveSets: numericCell(counts[0]!, 'incompleteActiveSets'),
      uploadsWithoutActiveSet: numericCell(counts[0]!, 'uploadsWithoutActiveSet'),
    },
  };
}

const defaultAdapters: MigrateReleaseAdapters = {
  now: () => new Date().toISOString(),
  verifyCandidate(request) {
    return verifyExactReleaseCandidate(request, {
      resolveCommit: (root, sha) => gitValue(['rev-parse', '--verify', `${sha}^{commit}`], root),
      head: (root) => gitValue(['rev-parse', '--verify', 'HEAD^{commit}'], root),
      tree: (root) => gitValue(['rev-parse', '--verify', 'HEAD^{tree}'], root),
      status: (root) => gitValue(['status', '--porcelain=v1', '--untracked-files=all'], root),
    });
  },
  observeDatabase: defaultObservation,
  hashFile: (path) => sha256(readFileSync(path)),
  run(command) {
    const result = spawnSync(command.executable, command.args, {
      cwd: command.cwd,
      shell: command.shell,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? -1;
  },
};

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    const candidateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const args = parseMigrateReleaseArgs(process.argv.slice(2));
    runMigrateRelease({ candidateRoot, ...args });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Guarded production migration failed.');
    process.exitCode = 1;
  }
}

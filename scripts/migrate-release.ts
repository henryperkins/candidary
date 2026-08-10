import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
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

import { canonicalJson, sha256 } from './release-evidence';
import {
  PHASE_2_MIGRATION,
  PHASE_3_MIGRATION,
  buildAtomicMigrationBundle,
  verifyExactReleaseCandidate,
  type ReleaseCandidateVerificationRequest,
  type VerifiedReleaseCandidate,
} from './release-candidate';

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
] as const;

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
  authorization: ProductionMigrationAuthorizationV1;
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
}

export interface MigrateReleaseArguments {
  sha: string;
  manifestPath: string;
  authorizationPath: string;
  bookmarkPath: string;
}

export interface ProductionMigrationResult {
  candidateSha: string;
  migrationName: typeof PHASE_3_MIGRATION;
  migrationSha256: string;
  bundleSha256: string;
  preSchemaSha256: string;
  postSchemaSha256: string;
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

function parseAuthorization(value: unknown): ProductionMigrationAuthorizationV1 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'runId', 'approvedMainSha', 'candidateSha', 'manifestSha256',
    'productionTopologySha256', 'accountId', 'databaseName', 'databaseId', 'migrationName',
    'migrationSha256', 'bundleSha256', 'bookmarkSha256', 'preSchemaSha256',
    'postSchemaSha256', 'authorizedAt', 'expiresAt', 'noDeployWindowOwner', 'rollbackOwner',
  ], 'Production migration authorization');
  if (item.kind !== 'candidary.production-migration-authorization' || item.schemaVersion !== 1) {
    throw new Error('Production migration authorization identity is invalid.');
  }
  if (item.migrationName !== PHASE_3_MIGRATION) {
    throw new Error(`Production authorization must name only ${PHASE_3_MIGRATION}.`);
  }
  const owner = (entry: unknown, label: string) =>
    patternString(entry, /^[a-z][a-z0-9._-]{2,63}$/u, label);
  return {
    kind: 'candidary.production-migration-authorization', schemaVersion: 1,
    runId: patternString(item.runId, UUID_PATTERN, 'authorization runId'),
    approvedMainSha: sha1(item.approvedMainSha, 'approvedMainSha'),
    candidateSha: sha1(item.candidateSha, 'candidateSha'),
    manifestSha256: sha256Value(item.manifestSha256, 'manifestSha256'),
    productionTopologySha256: sha256Value(item.productionTopologySha256, 'productionTopologySha256'),
    accountId: patternString(item.accountId, ACCOUNT_ID_PATTERN, 'accountId'),
    databaseName: exactString(item.databaseName, 'databaseName'),
    databaseId: patternString(item.databaseId, D1_ID_PATTERN, 'databaseId'),
    migrationName: PHASE_3_MIGRATION,
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

function productionTopology(candidateRoot: string): Record<string, unknown> {
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
    r2: [{ binding: 'MEDIA_BUCKET', bucketName: 'candidary-media' }],
    images: { binding: 'IMAGES' },
    assets: {
      binding: 'ASSETS', directory: '../client',
      notFoundHandling: 'single-page-application', runWorkerFirst: assets.run_worker_first,
    },
    email: [{ name: 'EMAIL' }],
    rateLimits: [
      { name: 'HOST_AUTH_RATE_LIMIT', namespaceId: '1001', simple: { limit: 20, period: 60 } },
      { name: 'RSVP_LOOKUP_RATE_LIMIT', namespaceId: '1002', simple: { limit: 30, period: 60 } },
    ],
    workflows: [
      { name: 'candidary-export', binding: 'EXPORT_WORKFLOW', className: 'ExportWorkflow' },
      { name: 'candidary-cover-render', binding: 'COVER_RENDER_WORKFLOW', className: 'CoverRenderWorkflow' },
      { name: 'candidary-cover-backfill', binding: 'COVER_BACKFILL_WORKFLOW', className: 'CoverBackfillWorkflow' },
    ],
    crons: ['17 3 * * *', '47 * * * *'],
    vars: {
      APP_ORIGIN: 'https://candidary.app', ALTERNATE_ORIGINS: 'https://candidary.online',
      R2_ACCOUNT_ID: vars.R2_ACCOUNT_ID, R2_BUCKET_NAME: 'candidary-media',
      EMAIL_FROM: 'hello@candidary.app',
    },
    requiredSecrets: [...REQUIRED_SECRET_NAMES],
    observability: { enabled: true },
    placement: { mode: 'smart' },
  };
  if (!ACCOUNT_ID_PATTERN.test(String(vars.R2_ACCOUNT_ID))
    || canonicalJson(topology) !== canonicalJson(expected)) {
    throw new Error('Generated config is not the exact canonical production topology.');
  }
  return topology;
}

export function productionTopologySha256(candidateRoot: string): string {
  return sha256(canonicalJson(productionTopology(candidateRoot)));
}

function productionAccountId(candidateRoot: string): string {
  const topology = productionTopology(candidateRoot);
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
  authorization: ProductionMigrationAuthorizationV1,
): void {
  const expected = expectedLedger(candidate, 13);
  if (expected.at(-1) !== PHASE_2_MIGRATION || !sameStrings(observation.ledger, expected)) {
    throw new Error('Production ledger is not exactly at the Phase-2 boundary.');
  }
  if (!sameStrings(observation.pendingMigrations, [PHASE_3_MIGRATION])) {
    throw new Error('Production must have only the exact Phase-3 migration pending.');
  }
  if (observation.schemaSha256 !== authorization.preSchemaSha256) {
    throw new Error('Production pre-migration schema does not match authorization.');
  }
}

function assertPostState(
  observation: ProductionDatabaseObservation,
  candidate: VerifiedReleaseCandidate,
  authorization: ProductionMigrationAuthorizationV1,
): void {
  if (!sameStrings(observation.ledger, expectedLedger(candidate, 14))) {
    throw new Error('Production post-migration ledger is incomplete or out of order.');
  }
  if (observation.pendingMigrations.length !== 0) {
    throw new Error('Production post-migration state still has a pending migration.');
  }
  if (observation.schemaSha256 !== authorization.postSchemaSha256) {
    throw new Error('Production post-migration schema fingerprint does not match authorization.');
  }
  if (!sameStrings(observation.triggerNames, [...PRODUCTION_TRIGGER_NAMES])) {
    throw new Error('Production post-migration trigger set is incomplete or unexpected.');
  }
}

function sameObservation(left: ProductionDatabaseObservation, right: ProductionDatabaseObservation): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateCrossReferences(
  request: MigrateReleaseRequest,
  candidate: VerifiedReleaseCandidate,
  authorization: ProductionMigrationAuthorizationV1,
  bookmark: CanonicalInput<TimeTravelBookmarkV1>,
  now: string,
): void {
  if (authorization.approvedMainSha !== request.sha || authorization.candidateSha !== request.sha
    || candidate.sha !== request.sha || authorization.manifestSha256 !== candidate.manifestSha256) {
    throw new Error('Production authorization does not bind the exact landed candidate and manifest.');
  }
  const topologySha = productionTopologySha256(candidate.candidateRoot);
  const accountId = productionAccountId(candidate.candidateRoot);
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
  if (candidate.migrationCount !== 14 || basename(migration?.path ?? '') !== PHASE_3_MIGRATION
    || migration?.sha256 !== authorization.migrationSha256) {
    throw new Error('Production authorization does not bind the sole manifest-hashed Phase-3 migration.');
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

export function parseMigrateReleaseArgs(
  args: readonly string[],
  cwd = process.cwd(),
): MigrateReleaseArguments {
  const accepted = new Set(['--sha', '--manifest', '--authorization', '--bookmark']);
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
  for (const flag of accepted) {
    if (!values.has(flag)) throw new Error(`Production migration argument ${flag} is required.`);
  }
  const sha = sha1(values.get('--sha'), '--sha');
  return {
    sha,
    manifestPath: exactRegularFile(resolve(cwd, values.get('--manifest')!), 'Candidate manifest'),
    authorizationPath: exactRegularFile(resolve(cwd, values.get('--authorization')!), 'Production authorization'),
    bookmarkPath: exactRegularFile(resolve(cwd, values.get('--bookmark')!), 'Time Travel bookmark'),
  };
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
    expectedMigrationCount: 14,
  };
  const candidate = adapters.verifyCandidate(verificationRequest);
  validateCrossReferences(request, candidate, authorization, bookmark, adapters.now());
  validateCandidateCli(candidate);
  const context = { candidate, authorization };
  const before = validatedObservation(adapters.observeDatabase(context));
  assertPreState(before, candidate, authorization);

  const bundlePath = resolve(
    candidate.candidateRoot,
    'output/production-migration',
    candidate.sha,
    authorization.runId,
    '0014-event-cover-invariants.sql',
  );
  let bundleCreated = false;
  try {
    const bundle = buildAtomicMigrationBundle({
      verifiedCandidate: candidate,
      expectedLedger: before.ledger,
      migration: PHASE_3_MIGRATION,
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
    return {
      candidateSha: candidate.sha,
      migrationName: PHASE_3_MIGRATION,
      migrationSha256: bundle.migrationHash,
      bundleSha256: bundle.sha256,
      preSchemaSha256: before.schemaSha256,
      postSchemaSha256: after.schemaSha256,
    };
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
    .filter((name) => PRODUCTION_TRIGGER_NAMES.includes(name as typeof PRODUCTION_TRIGGER_NAMES[number]))
    .sort();
  const counts = wranglerRows(candidate, [
    'SELECT',
    "(SELECT count(*) FROM events e WHERE e.deleted_at IS NULL AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL) AS legacyRows,",
    "(SELECT count(*) FROM event_cover_backfill_jobs j JOIN events e ON e.id = j.event_id WHERE j.status IN ('needs_replacement','failed') AND e.deleted_at IS NULL AND e.cover_object_key IS NOT NULL AND e.cover_render_set_id IS NULL) AS blockingJobs,",
    "(SELECT count(*) FROM event_cover_render_sets s WHERE s.state = 'active' AND (s.manifest_sha256 IS NULL OR s.required_slots <> (SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id) OR s.required_slots <> (SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id AND o.event_id = s.event_id))) AS incompleteActiveSets,",
    "(SELECT count(*) FROM events e WHERE e.deleted_at IS NULL AND json_extract(e.cover_config, '$.source.kind') = 'upload' AND (e.cover_object_key IS NULL OR NOT EXISTS (SELECT 1 FROM event_cover_render_sets s JOIN event_cover_masters m ON m.id = s.master_id WHERE s.id = e.cover_render_set_id AND s.event_id = e.id AND s.state = 'active' AND m.event_id = e.id AND m.object_key = e.cover_object_key))) AS uploadsWithoutActiveSet;",
  ].join(' '));
  if (counts.length !== 1) throw new Error('D1 zero-proof query returned the wrong row count.');
  const names = expectedLedger(candidate, 14);
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

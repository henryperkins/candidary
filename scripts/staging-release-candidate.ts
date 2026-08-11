import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  assertRedactedCandidateManifest,
  canonicalJson,
  collectMigrationManifest,
  deployWranglerConfigBytes,
  normalizedBindingTopology,
  sha256,
  type CandidateManifest,
  type HashedFile,
} from './release-evidence.ts';
import {
  RUN_ID_PATTERN,
  STAGING_ORIGIN,
  STAGING_TARGET,
  assertCandidateSha,
  assertSafeStagingTarget,
  type StagingTarget,
} from './staging-release-contract.ts';

const APPROVED_RELEASE_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b' as const;
const WRANGLER_VERSION = '4.113.0' as const;
const PRODUCTION_DATABASE_ID = '60bec5de-c8c7-41b5-a26b-2d3f7d184c71' as const;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;

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

export interface CandidateObservationAdapter {
  readonly head: (projectRoot: string) => string;
  readonly tree: (projectRoot: string) => string;
  readonly status: (projectRoot: string) => string;
  readonly wranglerVersion: (projectRoot: string, executablePath: string) => string;
}

export interface VerifiedCandidate {
  readonly projectRoot: string;
  readonly sha: string;
  readonly tree: string;
  readonly manifest: CandidateManifest;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly migrationManifestSha256: string;
  readonly migrationCount: 13;
  readonly wranglerPath: string;
  readonly wranglerVersion: typeof WRANGLER_VERSION;
}

export interface StagingTargetAuthorization {
  readonly schemaVersion: 1;
  readonly authorization: 'approved';
  readonly accountId: string;
  readonly databaseId: string;
  readonly hostAuthRateLimitNamespaceId: '2001';
  readonly rsvpRateLimitNamespaceId: '2002';
  readonly target: StagingTarget;
}

export interface OwnedDeployRoot {
  readonly root: string;
  readonly configPath: string;
  readonly sourceDigest: string;
}

function git(projectRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const defaultObservationAdapter: CandidateObservationAdapter = {
  head: (projectRoot) => git(projectRoot, ['rev-parse', 'HEAD']),
  tree: (projectRoot) => git(projectRoot, ['rev-parse', 'HEAD^{tree}']),
  status: (projectRoot) => execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
  wranglerVersion: (projectRoot) => {
    const packagePath = resolve(projectRoot, 'node_modules', 'wrangler', 'package.json');
    const value = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    if (typeof value.version !== 'string') throw new Error('Pinned Wrangler package has no version.');
    return value.version;
  },
};

function within(container: string, target: string): boolean {
  const candidate = relative(container, target);
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

function exactRegularFile(root: string, relativePath: string, label: string): string {
  const target = resolve(root, ...relativePath.replaceAll('\\', '/').split('/'));
  if (!within(root, target) || !existsSync(target)) throw new Error(`${label} does not exist inside the candidate.`);
  let cursor = root;
  for (const segment of relative(root, target).split(/[\\/]/u)) {
    cursor = resolve(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} contains a symlink.`);
  }
  if (!statSync(target).isFile()) throw new Error(`${label} must be a regular file.`);
  return target;
}

function parseManifestSidecar(manifestPath: string): string {
  const sidecarPath = `${manifestPath}.sha256`;
  const match = /^([0-9a-f]{64}) {2}candidate-manifest\.json\r?\n$/u.exec(readFileSync(sidecarPath, 'utf8'));
  if (!match) throw new Error('Candidate manifest sidecar has an invalid format.');
  return match[1]!;
}

function locateCandidateManifest(projectRoot: string, candidateSha: string): string {
  const candidateRoot = resolve(projectRoot, 'output', 'release', candidateSha);
  if (!existsSync(candidateRoot) || lstatSync(candidateRoot).isSymbolicLink()) {
    throw new Error('Task 10 candidate evidence directory is missing or symlinked.');
  }
  const candidates = readdirSync(candidateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && RUN_ID_PATTERN.test(entry.name))
    .map((entry) => resolve(candidateRoot, entry.name, 'candidate-manifest.json'))
    .filter((path) => existsSync(path) && existsSync(`${path}.sha256`));
  if (candidates.length !== 1) {
    throw new Error('Task 10 candidate must have exactly one complete manifest run.');
  }
  return candidates[0]!;
}

function verifyHashedFile(projectRoot: string, file: HashedFile, label: string): void {
  const path = exactRegularFile(projectRoot, file.path, label);
  const bytes = readFileSync(path);
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new Error(`${label} artifact bytes do not match the candidate manifest.`);
  }
}

function verifiedPortableWranglerConfig(
  projectRoot: string,
  file: HashedFile,
): { readonly bytes: Buffer; readonly value: unknown } {
  const path = exactRegularFile(projectRoot, file.path, 'Wrangler config');
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const bytes = deployWranglerConfigBytes(value);
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
    throw new Error('Wrangler config artifact bytes do not match the candidate manifest.');
  }
  return { bytes, value };
}

function assertManifestGate(manifest: CandidateManifest, candidateSha: string, tree: string): void {
  if (manifest.status !== 'passed' || manifest.candidate === null
    || manifest.candidate.gitSha !== candidateSha) {
    throw new Error('Task 10 manifest is not passed for the exact candidate SHA.');
  }
  if (manifest.candidate.gitTree !== tree) throw new Error('Task 10 manifest Git tree does not match.');
  if (manifest.candidate.approvedBaseSha !== APPROVED_RELEASE_BASE_SHA) {
    throw new Error('Task 10 manifest approved base does not match.');
  }
  if (manifest.commands.length !== 14 || manifest.commands.some((command) => command.status !== 'passed')) {
    throw new Error('Task 10 manifest does not contain fourteen passed gates.');
  }
  if (manifest.migrations === null || manifest.migrations.verification.migrationCount !== 13) {
    throw new Error('Task 10 manifest must contain exactly thirteen migrations.');
  }
  const terminalKeys = Object.keys(manifest.migrations.verification.terminalSchema).sort();
  if (canonicalJson(terminalKeys) !== canonicalJson([
    'events', 'releaseCertifications', 'rosterBatchReceipts',
  ])) {
    throw new Error('Task 10 terminal schema must contain exactly three approved keys.');
  }
}

export function verifyTask10Candidate(
  projectRootInput: string,
  candidateShaInput: string,
  adapter: CandidateObservationAdapter = defaultObservationAdapter,
): VerifiedCandidate {
  const projectRoot = realpathSync(projectRootInput);
  const candidateSha = assertCandidateSha(candidateShaInput);
  if (adapter.head(projectRoot).trim() !== candidateSha) throw new Error('Candidate HEAD does not match.');
  const tree = adapter.tree(projectRoot).trim();
  if (!/^[0-9a-f]{40}$/u.test(tree)) throw new Error('Candidate Git tree is invalid.');
  if (adapter.status(projectRoot) !== '') throw new Error('Candidate worktree must be clean.');

  const manifestPath = locateCandidateManifest(projectRoot, candidateSha);
  const manifestBytes = readFileSync(manifestPath, 'utf8');
  const manifestSha256 = sha256(manifestBytes);
  if (parseManifestSidecar(manifestPath) !== manifestSha256) {
    throw new Error('Candidate manifest sidecar digest does not match.');
  }
  const parsed = JSON.parse(manifestBytes) as unknown;
  assertRedactedCandidateManifest(parsed);
  const manifest = parsed;
  assertManifestGate(manifest, candidateSha, tree);

  const packageLock = exactRegularFile(projectRoot, 'package-lock.json', 'package lock');
  const sourceConfig = exactRegularFile(projectRoot, 'wrangler.jsonc', 'source Wrangler config');
  if (sha256(readFileSync(packageLock)) !== manifest.candidate!.packageLockSha256) {
    throw new Error('Candidate package-lock hash does not match the manifest.');
  }
  if (sha256(readFileSync(sourceConfig)) !== manifest.candidate!.sourceWranglerConfigSha256) {
    throw new Error('Candidate source Wrangler hash does not match the manifest.');
  }
  const sourceConfigValue = JSON.parse(readFileSync(sourceConfig, 'utf8')) as unknown;
  if (sha256(canonicalJson(normalizedBindingTopology(sourceConfigValue)))
    !== manifest.bindings!.sourceTopologySha256) {
    throw new Error('Candidate source binding topology does not match the manifest.');
  }

  const migrations = collectMigrationManifest(projectRoot);
  if (migrations.files.length !== 13
    || migrations.sha256 !== manifest.candidate!.migrationManifestSha256
    || canonicalJson(migrations.files) !== canonicalJson(manifest.migrations!.manifest)) {
    throw new Error('Candidate migration manifest does not match the Task 10 evidence.');
  }

  verifiedPortableWranglerConfig(projectRoot, manifest.artifacts!.deployWranglerConfig);
  verifyHashedFile(projectRoot, manifest.artifacts!.worker, 'Worker');
  for (const file of manifest.artifacts!.client) verifyHashedFile(projectRoot, file, 'client');

  const wranglerPath = exactRegularFile(
    projectRoot,
    process.platform === 'win32' ? 'node_modules/.bin/wrangler.cmd' : 'node_modules/.bin/wrangler',
    'pinned Wrangler executable',
  );
  const wranglerVersion = adapter.wranglerVersion(projectRoot, wranglerPath).trim();
  if (wranglerVersion !== WRANGLER_VERSION
    || manifest.execution.tools.wrangler !== WRANGLER_VERSION
    || manifest.execution.tools.node !== process.version) {
    throw new Error('Candidate pinned Node or Wrangler version does not match Task 10 evidence.');
  }

  return {
    projectRoot,
    sha: candidateSha,
    tree,
    manifest,
    manifestPath,
    manifestSha256,
    migrationManifestSha256: migrations.sha256,
    migrationCount: 13,
    wranglerPath,
    wranglerVersion: WRANGLER_VERSION,
  };
}

function assertPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertStagingTargetAuthorization(value: unknown): StagingTargetAuthorization {
  const record = assertPlainRecord(value, 'Staging target authorization');
  const keys = Object.keys(record).sort();
  const expected = [
    'accountId', 'authorization', 'databaseId', 'hostAuthRateLimitNamespaceId',
    'rsvpRateLimitNamespaceId', 'schemaVersion', 'target',
  ].sort();
  if (canonicalJson(keys) !== canonicalJson(expected)) {
    throw new Error('Staging target authorization has an unknown or missing field.');
  }
  if (record.schemaVersion !== 1 || record.authorization !== 'approved') {
    throw new Error('Staging target authorization is not approved.');
  }
  if (typeof record.accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(record.accountId)) {
    throw new Error('Staging account ID is invalid.');
  }
  if (typeof record.databaseId !== 'string' || !RUN_ID_PATTERN.test(record.databaseId)
    || record.databaseId === PRODUCTION_DATABASE_ID) {
    throw new Error('Staging database ID is invalid or production.');
  }
  if (record.hostAuthRateLimitNamespaceId !== '2001'
    || record.rsvpRateLimitNamespaceId !== '2002') {
    throw new Error('Staging rate-limit namespace IDs are not approved.');
  }
  assertSafeStagingTarget(record.target);
  return value as StagingTargetAuthorization;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return [...value];
}

export function buildStagingWranglerConfig(
  generatedConfigValue: unknown,
  authorizationValue: unknown,
): Record<string, unknown> {
  const authorization = assertStagingTargetAuthorization(authorizationValue);
  const source = structuredClone(assertPlainRecord(generatedConfigValue, 'Generated Wrangler config'));
  delete source.configPath;
  delete source.userConfigPath;
  delete source.triggers;
  delete source.routes;
  delete source.route;
  source.name = STAGING_TARGET.workerName;
  source.workers_dev = false;
  source.preview_urls = false;
  source.d1_databases = [{
    binding: 'DB',
    database_name: STAGING_TARGET.databaseName,
    database_id: authorization.databaseId,
    migrations_dir: '../../migrations',
  }];
  source.r2_buckets = [{ binding: 'MEDIA_BUCKET', bucket_name: STAGING_TARGET.bucketName }];
  source.workflows = [
    { name: STAGING_TARGET.workflows.export, binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
    { name: STAGING_TARGET.workflows.render, binding: 'COVER_RENDER_WORKFLOW', class_name: 'CoverRenderWorkflow' },
    { name: STAGING_TARGET.workflows.backfill, binding: 'COVER_BACKFILL_WORKFLOW', class_name: 'CoverBackfillWorkflow' },
  ];
  source.ratelimits = [
    {
      name: 'HOST_AUTH_RATE_LIMIT',
      namespace_id: authorization.hostAuthRateLimitNamespaceId,
      simple: { limit: 20, period: 60 },
    },
    {
      name: 'RSVP_LOOKUP_RATE_LIMIT',
      namespace_id: authorization.rsvpRateLimitNamespaceId,
      simple: { limit: 30, period: 60 },
    },
  ];
  source.vars = {
    APP_ORIGIN: STAGING_ORIGIN,
    ALTERNATE_ORIGINS: '',
    R2_ACCOUNT_ID: authorization.accountId,
    R2_BUCKET_NAME: STAGING_TARGET.bucketName,
    EMAIL_FROM: 'hello@staging.candidary.invalid',
  };
  assertSafeStagingWranglerConfig(source, authorization);
  return source;
}

function oneRecordArray(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) throw new Error(`${label} must contain one binding.`);
  return assertPlainRecord(value[0], `${label} binding`);
}

export function assertSafeStagingWranglerConfig(
  value: unknown,
  authorizationValue: unknown,
): Record<string, unknown> {
  const authorization = assertStagingTargetAuthorization(authorizationValue);
  const config = assertPlainRecord(value, 'Staging Wrangler config');
  if (config.name !== STAGING_TARGET.workerName || config.main !== 'index.js') {
    throw new Error('Staging Worker identity or entry point is invalid.');
  }
  if (config.workers_dev !== false) throw new Error('Staging workers_dev must be false.');
  if (config.preview_urls !== false) throw new Error('Staging preview URLs must be false.');
  for (const field of ['route', 'routes', 'custom_domain', 'custom_domains', 'triggers']) {
    if (field in config) throw new Error(`Staging config must not contain ${field}.`);
  }
  const versionMetadata = assertPlainRecord(config.version_metadata, 'Version metadata binding');
  if (versionMetadata.binding !== 'CF_VERSION_METADATA') throw new Error('Version metadata binding is missing.');
  const images = assertPlainRecord(config.images, 'Images binding');
  if (images.binding !== 'IMAGES') throw new Error('Images binding is missing.');
  const d1 = oneRecordArray(config.d1_databases, 'D1');
  if (d1.binding !== 'DB' || d1.database_name !== STAGING_TARGET.databaseName
    || d1.database_id !== authorization.databaseId || d1.migrations_dir !== '../../migrations') {
    throw new Error('Staging D1 binding is unsafe.');
  }
  const r2 = oneRecordArray(config.r2_buckets, 'R2');
  if (r2.binding !== 'MEDIA_BUCKET' || r2.bucket_name !== STAGING_TARGET.bucketName) {
    throw new Error('Staging R2 binding is unsafe.');
  }
  const expectedWorkflows = [
    { name: STAGING_TARGET.workflows.export, binding: 'EXPORT_WORKFLOW', class_name: 'ExportWorkflow' },
    { name: STAGING_TARGET.workflows.render, binding: 'COVER_RENDER_WORKFLOW', class_name: 'CoverRenderWorkflow' },
    { name: STAGING_TARGET.workflows.backfill, binding: 'COVER_BACKFILL_WORKFLOW', class_name: 'CoverBackfillWorkflow' },
  ];
  if (canonicalJson(config.workflows) !== canonicalJson(expectedWorkflows)) {
    throw new Error('Staging Workflow bindings are unsafe.');
  }
  const vars = assertPlainRecord(config.vars, 'Staging variables');
  if (canonicalJson(vars) !== canonicalJson({
    APP_ORIGIN: STAGING_ORIGIN,
    ALTERNATE_ORIGINS: '',
    R2_ACCOUNT_ID: authorization.accountId,
    R2_BUCKET_NAME: STAGING_TARGET.bucketName,
    EMAIL_FROM: 'hello@staging.candidary.invalid',
  })) throw new Error('Staging variables are unsafe.');
  const secrets = assertPlainRecord(config.secrets, 'Staging secret declaration');
  if (canonicalJson(stringArray(secrets.required, 'Required secrets').sort())
    !== canonicalJson([...REQUIRED_SECRET_NAMES].sort())) {
    throw new Error('Staging secret-name set is incomplete or foreign.');
  }
  const expectedRateLimits = [
    { name: 'HOST_AUTH_RATE_LIMIT', namespace_id: '2001', simple: { limit: 20, period: 60 } },
    { name: 'RSVP_LOOKUP_RATE_LIMIT', namespace_id: '2002', simple: { limit: 30, period: 60 } },
  ];
  if (canonicalJson(config.ratelimits) !== canonicalJson(expectedRateLimits)) {
    throw new Error('Staging rate-limit bindings are unsafe.');
  }
  if (!Array.isArray(config.send_email)
    || canonicalJson(config.send_email) !== canonicalJson([{ name: 'EMAIL' }])) {
    throw new Error('Staging Email binding is unsafe.');
  }
  return config;
}

function copyVerifiedFile(
  sourceRoot: string,
  destinationRoot: string,
  file: HashedFile,
): void {
  const source = exactRegularFile(sourceRoot, file.path, `Source ${file.path}`);
  const sourceBytes = readFileSync(source);
  if (sourceBytes.length !== file.bytes || sha256(sourceBytes) !== file.sha256) {
    throw new Error(`Source artifact ${file.path} drifted before copy.`);
  }
  const destination = resolve(destinationRoot, ...file.path.split('/'));
  if (!within(destinationRoot, destination)) throw new Error('Owned deploy path escapes its root.');
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  const copied = readFileSync(destination);
  if (copied.length !== file.bytes || sha256(copied) !== file.sha256) {
    throw new Error(`Copied artifact ${file.path} failed rehashing.`);
  }
}

export function createOwnedDeployRoot(
  candidate: VerifiedCandidate,
  runRootInput: string,
  authorizationValue: unknown,
): OwnedDeployRoot {
  const authorization = assertStagingTargetAuthorization(authorizationValue);
  const runRoot = resolve(runRootInput);
  const root = resolve(runRoot, 'deploy-root');
  if (!within(runRoot, root) || existsSync(root)) {
    throw new Error('Owned deploy root already exists or escapes the run root.');
  }
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(root, { recursive: false });

  const artifacts = candidate.manifest.artifacts!;
  const generatedConfig = verifiedPortableWranglerConfig(
    candidate.projectRoot,
    artifacts.deployWranglerConfig,
  );
  const copiedFiles = [artifacts.worker, ...artifacts.client];
  for (const file of copiedFiles) copyVerifiedFile(candidate.projectRoot, root, file);
  for (const file of candidate.manifest.migrations!.manifest) {
    copyVerifiedFile(candidate.projectRoot, root, file);
  }

  const generatedConfigPath = resolve(root, artifacts.deployWranglerConfig.path);
  if (!within(root, generatedConfigPath)) throw new Error('Owned Wrangler config path escapes its root.');
  mkdirSync(dirname(generatedConfigPath), { recursive: true });
  writeFileSync(generatedConfigPath, generatedConfig.bytes, { flag: 'wx' });
  const stagingConfig = buildStagingWranglerConfig(generatedConfig.value, authorization);
  const configPath = resolve(dirname(generatedConfigPath), 'wrangler.staging.json');
  const configBytes = `${canonicalJson(stagingConfig)}\n`;
  writeFileSync(configPath, configBytes, { encoding: 'utf8', flag: 'wx' });
  const copiedManifest = [artifacts.deployWranglerConfig, ...copiedFiles]
    .concat(candidate.manifest.migrations!.manifest)
    .map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest }));
  const sourceDigest = sha256(canonicalJson({
    candidateSha: candidate.sha,
    files: copiedManifest,
    stagingConfigSha256: sha256(configBytes),
  }));
  return { root, configPath, sourceDigest };
}

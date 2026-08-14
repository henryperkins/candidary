import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRIDGE_CAPABILITIES,
  BRIDGE_SOURCE_MAIN_SHA,
  MEDIA_UPLOAD_RELEASE_CONFIG_PATH,
  verifyMediaWriteBridgeAuthorization,
  verifyMediaWriteBridgeDeploymentEvidence,
  verifyMediaWriteBridgeRuntimeContract,
  verifyMediaWriteBridgeRuntimeContractBytes,
  type MediaWriteBridgeAuthorizationV1,
  type MediaWriteBridgeDeploymentEvidenceV1,
} from './bridge-release-contract.ts';
import {
  withVerifiedDeploySnapshot,
  type DeployReleaseRequest,
} from './deploy-release.ts';
import {
  canonicalJson,
  collectDeployableArtifacts,
  normalizedBindingTopology,
  sha256,
  type BindingTopology,
} from './release-evidence.ts';
import {
  verifyCanonicalMediaBucketProvisioningEvidence,
} from './media-cutover-release-contract.ts';
import {
  verifyExactReleaseCandidate,
  type ReleaseCandidateVerificationRequest,
  type VerifiedReleaseCandidate,
} from './release-candidate.ts';

export {
  BRIDGE_CAPABILITIES,
  BRIDGE_SOURCE_MAIN_SHA,
  verifyMediaWriteBridgeDeploymentEvidence,
};
export type { MediaWriteBridgeAuthorizationV1 };

const LEGACY_RELEASE_BASE_SHA = '0b92387d2e237d568d2514373dcc3044e7960d4b';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const BRIDGE_BINDING_TOPOLOGY: BindingTopology = {
  compatibilityDate: '2026-07-21',
  compatibilityFlags: ['nodejs_compat'],
  workersDev: false,
  assets: {
    binding: 'ASSETS',
    notFoundHandling: 'single-page-application',
    runWorkerFirst: [
      '/api/*', '/create', '/event/*', '/host/events', '/host/login', '/host/register',
      '/host/unsubscribe/*', '/host/verify', '/join', '/join/*', '/manage/*', '/privacy',
      '/recover/event-entry', '/recover/manage', '/terms',
    ],
  },
  bindings: {
    d1: ['DB'], r2: ['MEDIA_BUCKET'], images: ['IMAGES'], sendEmail: ['EMAIL'],
    versionMetadata: 'CF_VERSION_METADATA',
  },
  requiredSecrets: [
    'ENTRY_ENCRYPTION_KEY', 'ENTRY_HMAC_KEY', 'GUEST_TOKEN_ENCRYPTION_KEY',
    'LOGIN_HMAC_KEY', 'RSVP_LOOKUP_HMAC_KEY', 'SESSION_HMAC_KEY', 'TOKEN_HMAC_KEY',
  ],
  variableNames: [
    'ALTERNATE_ORIGINS', 'APP_ORIGIN', 'EMAIL_FROM', 'R2_ACCOUNT_ID', 'R2_BUCKET_NAME',
  ],
  workflows: [
    { binding: 'COVER_BACKFILL_WORKFLOW', className: 'CoverBackfillWorkflow' },
    { binding: 'COVER_RENDER_WORKFLOW', className: 'CoverRenderWorkflow' },
    { binding: 'EXPORT_WORKFLOW', className: 'ExportWorkflow' },
  ],
  rateLimits: [
    { name: 'HOST_AUTH_RATE_LIMIT', limit: 20, period: 60 },
    { name: 'RSVP_LOOKUP_RATE_LIMIT', limit: 30, period: 60 },
  ],
  crons: ['17 3 * * *', '47 * * * *'],
  migrationDirectories: ['migrations'],
  observabilityEnabled: true,
};

const BRIDGE_GENERATED_DEFAULTS: Record<string, unknown> = {
  topLevelName: 'candidary',
  definedEnvironments: [],
  jsx_factory: 'React.createElement',
  jsx_fragment: 'React.Fragment',
  rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
  durable_objects: { bindings: [] },
  migrations: [],
  exports: {},
  kv_namespaces: [],
  cloudchamber: {},
  queues: { producers: [], consumers: [] },
  vectorize: [],
  ai_search_namespaces: [],
  ai_search: [],
  agent_memory: [],
  hyperdrive: [],
  services: [],
  analytics_engine_datasets: [],
  dispatch_namespaces: [],
  mtls_certificates: [],
  pipelines: [],
  secrets_store_secrets: [],
  artifacts: [],
  unsafe_hello_world: [],
  flagship: [],
  worker_loaders: [],
  vpc_services: [],
  vpc_networks: [],
  logfwdr: { bindings: [] },
  python_modules: { exclude: ['**/*.pyc'] },
  dev: {
    ip: '127.0.0.1',
    local_protocol: 'http',
    upstream_protocol: 'http',
    enable_containers: true,
    generate_types: false,
  },
};

const BRIDGE_CONFIG_KEYS = new Set([
  'name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev',
  'preview_urls', 'assets', 'version_metadata', 'd1_databases', 'r2_buckets', 'images',
  'send_email', 'ratelimits', 'workflows', 'triggers', 'vars', 'secrets', 'observability',
  'placement', 'no_bundle', 'configPath', 'userConfigPath',
  ...Object.keys(BRIDGE_GENERATED_DEFAULTS),
]);

export interface BridgeProductionIdentity {
  accountId: string;
  workerName: 'candidary';
  topologySha256: string;
  requiredSecretNames: string[];
  workerSha256: string;
  allowedRemoteBindingsSha256: string[];
  remoteRuntimeSha256: string;
}

export interface BridgeDeploymentObservation {
  versionId: string;
  tagSha: string;
  trafficPercent: 100;
}

export interface BridgeListedVersion {
  versionId: string;
  workerName: 'candidary';
  tagSha: string | null;
  uploadMessage: string | null;
}

export interface BridgeVersionUploadReceipt {
  versionId: string;
  workerName: 'candidary';
  tagSha: string;
}

export interface BridgeUploadedVersionObservation {
  accountId: string;
  workerName: 'candidary';
  versionId: string;
  tagSha: string;
  uploadMessage: string;
  trafficPercent: 0 | 100;
  providerScriptEtag: string;
  localWorkerSha256: string;
  bindingsSha256: string;
  runtimeSha256: string;
  observedAt: string;
}

export type BridgeVersionCommandId = 'upload-version' | 'deploy-version';

export interface BridgeVersionCommand {
  id: BridgeVersionCommandId;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface BridgeVersionCommandPlanInput {
  nodeExecPath: string;
  wranglerCliPath: string;
  deployRoot: string;
  accountId: string;
  sha: string;
  uploadMessage: string;
  versionId: string;
  outputPath: string;
  environment: NodeJS.ProcessEnv;
}

export function bridgeVersionUploadMessage(input: {
  runId: string;
  manifestSha256: string;
  artifactTreeSha256: string;
}): string {
  if (!UUID_PATTERN.test(input.runId) || !SHA256_PATTERN.test(input.manifestSha256)
    || !SHA256_PATTERN.test(input.artifactTreeSha256)) {
    throw new Error('Bridge version upload identity is invalid.');
  }
  return `candidary-bridge:${input.runId}:${input.manifestSha256}:${input.artifactTreeSha256}`;
}

export function buildBridgeVersionCommandPlan(
  input: BridgeVersionCommandPlanInput,
): [BridgeVersionCommand, BridgeVersionCommand] {
  if (!ACCOUNT_ID_PATTERN.test(input.accountId) || !SHA_PATTERN.test(input.sha)
    || !UUID_PATTERN.test(input.versionId)) {
    throw new Error('Bridge version command identity is invalid.');
  }
  const commonEnvironment = {
    ...input.environment,
    CLOUDFLARE_ACCOUNT_ID: input.accountId,
    WRANGLER_SEND_METRICS: 'false',
  };
  return [
    {
      id: 'upload-version',
      executable: input.nodeExecPath,
      args: [
        input.wranglerCliPath,
        'versions', 'upload', '--config', 'dist/candidary/wrangler.json',
        '--name', 'candidary', '--tag', input.sha, '--message', input.uploadMessage,
        '--strict',
      ],
      cwd: input.deployRoot,
      env: { ...commonEnvironment, WRANGLER_OUTPUT_FILE_PATH: input.outputPath },
      shell: false,
    },
    {
      id: 'deploy-version',
      executable: input.nodeExecPath,
      args: [
        input.wranglerCliPath,
        'versions', 'deploy', `${input.versionId}@100%`,
        '--config', 'dist/candidary/wrangler.json', '--name', 'candidary',
        '--message', input.uploadMessage, '--yes',
      ],
      cwd: input.deployRoot,
      env: commonEnvironment,
      shell: false,
    },
  ];
}

export interface SignerSurfaceEvidence {
  xAmzUrlCount: number;
  r2SignerReferenceCount: number;
}

export type ExportDownloadCanaryEvidence =
  MediaWriteBridgeDeploymentEvidenceV1['signerFree']['exportDownloadCanary'];

export interface BridgeReleaseAdapters {
  now(): string;
  verifyCandidate(request: ReleaseCandidateVerificationRequest): VerifiedReleaseCandidate;
  isAncestor(candidateRoot: string, baseSha: string, candidateSha: string): boolean;
  productionIdentity(candidate: VerifiedReleaseCandidate): BridgeProductionIdentity;
  withVerifiedSnapshot<T>(
    request: DeployReleaseRequest,
    action: (candidate: VerifiedReleaseCandidate, deployRoot: string) => T,
  ): T;
  snapshotArtifactIdentity(
    candidate: VerifiedReleaseCandidate,
    deployRoot: string,
  ): { treeSha256: string; workerSha256: string };
  observeWranglerAccount(
    candidate: VerifiedReleaseCandidate,
    deployRoot: string,
    accountId: string,
  ): unknown;
  listVersions(
    candidate: VerifiedReleaseCandidate,
    deployRoot: string,
    accountId: string,
  ): unknown;
  uploadVersion(
    candidate: VerifiedReleaseCandidate,
    deployRoot: string,
    accountId: string,
    uploadMessage: string,
  ): unknown;
  observeUploadedVersion(
    candidate: VerifiedReleaseCandidate,
    deployRoot: string,
    accountId: string,
    versionId: string,
  ): unknown;
  deployVersion(
    candidate: VerifiedReleaseCandidate,
    deployRoot: string,
    accountId: string,
    versionId: string,
    uploadMessage: string,
  ): void;
  observeDeployment(
    candidate: VerifiedReleaseCandidate,
    deployRoot: string,
    accountId: string,
  ): unknown;
  scanSignerSurface(candidate: VerifiedReleaseCandidate): SignerSurfaceEvidence;
  observeExportDownloadCanary(
    candidate: VerifiedReleaseCandidate,
    deployment: BridgeDeploymentObservation,
  ): ExportDownloadCanaryEvidence;
}

export interface BridgeReleaseRequest {
  candidateRoot: string;
  sha: string;
  manifestPath: string;
  authorizationPath: string;
  canonicalBucketEvidencePath: string;
}

export type BridgeReleaseArguments = BridgeReleaseRequest;

export interface BridgeReleaseResult {
  bridgeSha: string;
  versionId: string;
  evidencePath: string;
  evidenceSha256: string;
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

function exactDirectory(path: string, label: string): string {
  try {
    const absolute = resolve(path);
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    return absolute;
  } catch (error) {
    throw new Error(`${label} must be one exact nonsymlinked directory.`, { cause: error });
  }
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unknown or missing field.`);
  }
  return value as Record<string, unknown>;
}

function validatedProductionIdentity(value: BridgeProductionIdentity): BridgeProductionIdentity {
  if (!ACCOUNT_ID_PATTERN.test(value.accountId) || value.workerName !== 'candidary'
    || !SHA256_PATTERN.test(value.topologySha256)
    || !Array.isArray(value.requiredSecretNames)
    || value.requiredSecretNames.some((name) => typeof name !== 'string')
    || !SHA256_PATTERN.test(value.workerSha256)
    || !Array.isArray(value.allowedRemoteBindingsSha256)
    || value.allowedRemoteBindingsSha256.length !== 4
    || new Set(value.allowedRemoteBindingsSha256).size !== 4
    || value.allowedRemoteBindingsSha256.some((digest) => !SHA256_PATTERN.test(digest))
    || !SHA256_PATTERN.test(value.remoteRuntimeSha256)) {
    throw new Error('Bridge production topology identity is invalid.');
  }
  return {
    ...value,
    requiredSecretNames: [...value.requiredSecretNames].sort(),
    allowedRemoteBindingsSha256: [...value.allowedRemoteBindingsSha256].sort(),
  };
}

function validatedWranglerAccount(value: unknown, expectedAccountId: string): void {
  const item = exactRecord(value, ['accountIds'], 'Wrangler account observation');
  if (!Array.isArray(item.accountIds)
    || item.accountIds.length === 0
    || item.accountIds.some((accountId) => typeof accountId !== 'string'
      || !ACCOUNT_ID_PATTERN.test(accountId))
    || new Set(item.accountIds).size !== item.accountIds.length
    || !item.accountIds.includes(expectedAccountId)) {
    throw new Error('Wrangler is not authenticated to the exact authorized production account.');
  }
}

function validatedListedVersions(value: unknown): BridgeListedVersion[] {
  if (!Array.isArray(value)) throw new Error('Wrangler version list must be an array.');
  const versionIds = new Set<string>();
  return value.map((entry, index) => {
    const item = exactRecord(
      entry,
      ['versionId', 'workerName', 'tagSha', 'uploadMessage'],
      `Wrangler listed version ${index + 1}`,
    );
    if (typeof item.versionId !== 'string' || !UUID_PATTERN.test(item.versionId)
      || item.workerName !== 'candidary'
      || !(item.tagSha === null || typeof item.tagSha === 'string')
      || !(item.uploadMessage === null || typeof item.uploadMessage === 'string')
      || versionIds.has(item.versionId)) {
      throw new Error('Wrangler version list contains an invalid or duplicate version.');
    }
    versionIds.add(item.versionId);
    return {
      versionId: item.versionId,
      workerName: 'candidary',
      tagSha: item.tagSha,
      uploadMessage: item.uploadMessage,
    };
  });
}

function exactVersionMatch(
  value: unknown,
  sha: string,
  uploadMessage: string,
): BridgeListedVersion | null {
  const matches = validatedListedVersions(value).filter((version) =>
    version.tagSha === sha && version.uploadMessage === uploadMessage);
  if (matches.length > 1) {
    throw new Error('Bridge upload identity is not unique among remote Worker versions.');
  }
  return matches[0] ?? null;
}

function validatedUploadReceipt(
  value: unknown,
  sha: string,
): BridgeVersionUploadReceipt {
  const item = exactRecord(
    value,
    ['versionId', 'workerName', 'tagSha'],
    'Wrangler version upload receipt',
  );
  if (typeof item.versionId !== 'string' || !UUID_PATTERN.test(item.versionId)
    || item.workerName !== 'candidary' || item.tagSha !== sha) {
    throw new Error('Wrangler version upload did not return the exact tagged Worker version ID.');
  }
  return { versionId: item.versionId, workerName: 'candidary', tagSha: sha };
}

function validatedUploadedVersion(
  value: unknown,
  expected: {
    accountId: string;
    sha: string;
    uploadMessage: string;
    versionId: string;
    production: BridgeProductionIdentity;
  },
): BridgeUploadedVersionObservation {
  const item = exactRecord(value, [
    'accountId', 'workerName', 'versionId', 'tagSha', 'uploadMessage',
    'trafficPercent', 'providerScriptEtag', 'localWorkerSha256', 'bindingsSha256',
    'runtimeSha256', 'observedAt',
  ], 'Uploaded bridge Worker version');
  if (item.accountId !== expected.accountId || item.workerName !== 'candidary'
    || item.versionId !== expected.versionId || item.tagSha !== expected.sha
    || item.uploadMessage !== expected.uploadMessage
    || (item.trafficPercent !== 0 && item.trafficPercent !== 100)
    || typeof item.providerScriptEtag !== 'string'
    || !SHA256_PATTERN.test(item.providerScriptEtag)
    || item.localWorkerSha256 !== expected.production.workerSha256
    || typeof item.bindingsSha256 !== 'string'
    || !expected.production.allowedRemoteBindingsSha256.includes(item.bindingsSha256)
    || item.runtimeSha256 !== expected.production.remoteRuntimeSha256
    || typeof item.observedAt !== 'string' || !ISO_PATTERN.test(item.observedAt)
    || Number.isNaN(Date.parse(item.observedAt))) {
    throw new Error('Uploaded bridge Worker version has remote account, artifact, binding, runtime, or traffic drift.');
  }
  return item as unknown as BridgeUploadedVersionObservation;
}

function validatedSignerSurface(
  value: SignerSurfaceEvidence,
): MediaWriteBridgeDeploymentEvidenceV1['signerFree']['artifactScan'] {
  const item = exactRecord(value, ['xAmzUrlCount', 'r2SignerReferenceCount'], 'Bridge signer scan');
  if (item.xAmzUrlCount !== 0 || item.r2SignerReferenceCount !== 0) {
    throw new Error('Bridge runtime artifact retains an R2 signer surface.');
  }
  return { xAmzUrlCount: 0, r2SignerReferenceCount: 0 };
}

function validatedExportDownloadCanary(
  value: ExportDownloadCanaryEvidence,
): ExportDownloadCanaryEvidence {
  const item = exactRecord(value, [
    'status', 'httpStatus', 'method', 'artifactUrlSha256',
    'expectedArtifactSha256', 'responseSha256',
    'expectedByteLength', 'responseByteLength', 'sameOrigin', 'redirected',
    'cacheControl', 'contentDisposition', 'contentType', 'xContentTypeOptions',
    'observedAt',
  ], 'Bridge authenticated export download canary');
  const expectedByteLength = Number(item.expectedByteLength);
  if (item.status !== 'passed' || item.httpStatus !== 200 || item.method !== 'GET'
    || typeof item.artifactUrlSha256 !== 'string'
    || !SHA256_PATTERN.test(item.artifactUrlSha256)
    || typeof item.expectedArtifactSha256 !== 'string'
    || !SHA256_PATTERN.test(item.expectedArtifactSha256)
    || item.responseSha256 !== item.expectedArtifactSha256
    || !Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0
    || item.responseByteLength !== expectedByteLength
    || item.sameOrigin !== true || item.redirected !== false
    || item.cacheControl !== 'private, no-store'
    || item.contentDisposition !== 'attachment'
    || item.contentType !== 'application/zip'
    || item.xContentTypeOptions !== 'nosniff'
    || typeof item.observedAt !== 'string' || !ISO_PATTERN.test(item.observedAt)
    || Number.isNaN(Date.parse(item.observedAt))) {
    throw new Error('Bridge authenticated export download canary did not return exact same-origin bytes.');
  }
  return value;
}

function validatedDeployment(value: unknown): BridgeDeploymentObservation {
  const item = exactRecord(value, ['versionId', 'tagSha', 'trafficPercent'], 'Bridge deployment');
  if (typeof item.versionId !== 'string' || !UUID_PATTERN.test(item.versionId)
    || typeof item.tagSha !== 'string' || !SHA_PATTERN.test(item.tagSha)
    || item.trafficPercent !== 100) {
    throw new Error('Bridge deployment version, tag, or traffic is invalid.');
  }
  return { versionId: item.versionId, tagSha: item.tagSha, trafficPercent: 100 };
}

function outputPath(candidate: VerifiedReleaseCandidate, runId: string): string {
  const path = resolve(
    candidate.candidateRoot,
    'output/production-bridge',
    candidate.sha,
    runId,
    'media-write-bridge-deployment-evidence.json',
  );
  mkdirSync(dirname(path), { recursive: true });
  for (const target of [path, `${path}.sha256`]) {
    try {
      lstatSync(target);
      throw new Error('Bridge deployment evidence output already exists.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) throw error;
    }
  }
  return path;
}

function writeEvidence(path: string, evidence: MediaWriteBridgeDeploymentEvidenceV1) {
  const bytes = `${canonicalJson(evidence)}\n`;
  const digest = sha256(bytes);
  try {
    writeFileSync(path, bytes, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`, {
      encoding: 'utf8', flag: 'wx',
    });
  } catch (error) {
    rmSync(path, { force: true });
    rmSync(`${path}.sha256`, { force: true });
    throw error;
  }
  return { path, sha256: digest };
}

function requireActiveBridgeAuthorization(
  authorization: MediaWriteBridgeAuthorizationV1,
  now: string,
  boundary: 'release prerequisites' | 'version upload' | 'version deployment' | 'evidence write',
): string {
  if (!ISO_PATTERN.test(now) || Number.isNaN(Date.parse(now))
    || new Date(now).toISOString() !== now) {
    throw new Error(`Bridge authorization clock is invalid before ${boundary}.`);
  }
  if (authorization.authorizedAt > now || now >= authorization.expiresAt) {
    const recovery = boundary === 'evidence write'
      ? ' Refresh the same exact-run authorization and rerun to re-adopt the immutable 100-percent version before writing evidence.'
      : '';
    throw new Error(`Bridge authorization is not active immediately before ${boundary}.${recovery}`);
  }
  return now;
}

export function parseBridgeReleaseArgs(
  args: readonly string[],
  cwd = process.cwd(),
): BridgeReleaseArguments {
  const accepted = new Set([
    '--candidate-root', '--sha', '--manifest', '--authorization',
    '--canonical-bucket-evidence',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !accepted.has(flag) || values.has(flag)) {
      throw new Error(`Unknown or duplicate bridge release argument ${String(flag)}.`);
    }
    if (!value) throw new Error(`Bridge release argument ${flag} is missing.`);
    values.set(flag, value);
  }
  for (const flag of accepted) {
    if (!values.has(flag)) throw new Error(`Bridge release argument ${flag} is required.`);
  }
  const sha = values.get('--sha')!;
  if (!SHA_PATTERN.test(sha)) throw new Error('Bridge --sha is invalid.');
  return {
    candidateRoot: exactDirectory(resolve(cwd, values.get('--candidate-root')!), 'Bridge candidate root'),
    sha,
    manifestPath: exactRegularFile(resolve(cwd, values.get('--manifest')!), 'Bridge candidate manifest'),
    authorizationPath: exactRegularFile(resolve(cwd, values.get('--authorization')!), 'Bridge authorization'),
    canonicalBucketEvidencePath: exactRegularFile(
      resolve(cwd, values.get('--canonical-bucket-evidence')!),
      'Canonical bucket provisioning evidence',
    ),
  };
}

export function runBridgeRelease(
  request: BridgeReleaseRequest,
  adapters: BridgeReleaseAdapters = defaultAdapters,
): BridgeReleaseResult {
  const authorizationInput = verifyMediaWriteBridgeAuthorization(request.authorizationPath);
  const authorization = authorizationInput.artifact;
  const bucketInput = verifyCanonicalMediaBucketProvisioningEvidence(
    request.canonicalBucketEvidencePath,
  );
  const verificationRequest: ReleaseCandidateVerificationRequest = {
    candidateRoot: request.candidateRoot,
    sha: request.sha,
    manifestPath: request.manifestPath,
    approvedBaseSha: LEGACY_RELEASE_BASE_SHA,
    expectedMigrationCount: 14,
  };
  const candidate = adapters.verifyCandidate(verificationRequest);
  const runtime = verifyMediaWriteBridgeRuntimeContract(resolve(
    candidate.candidateRoot,
    MEDIA_UPLOAD_RELEASE_CONFIG_PATH,
  ));
  const production = validatedProductionIdentity(adapters.productionIdentity(candidate));
  const signerSurface = validatedSignerSurface(adapters.scanSignerSurface(candidate));
  requireActiveBridgeAuthorization(authorization, adapters.now(), 'release prerequisites');
  if (!adapters.isAncestor(candidate.candidateRoot, BRIDGE_SOURCE_MAIN_SHA, candidate.sha)) {
    throw new Error('Bridge candidate is not descended from the exact schema-14 source main.');
  }
  if (candidate.migrationCount !== 14 || candidate.sha !== request.sha
    || authorization.approvedMainSha !== BRIDGE_SOURCE_MAIN_SHA
    || authorization.bridgeSha !== request.sha
    || authorization.bridgeManifestSha256 !== candidate.manifestSha256
    || authorization.bridgeArtifactTreeSha256 !== candidate.artifactTreeSha256
    || authorization.runtimeContractSha256 !== runtime.sha256
    || authorization.canonicalBucketProvisioningEvidenceSha256 !== bucketInput.sha256
    || authorization.productionTopologySha256 !== production.topologySha256
    || authorization.accountId !== production.accountId
    || authorization.r2SigningTokenId !== bucketInput.artifact.legacyBucket.r2SigningTokenId
    || bucketInput.artifact.accountId !== production.accountId) {
    throw new Error('Bridge authorization does not bind the exact signer-free candidate, bucket, and topology.');
  }
  const path = outputPath(candidate, authorization.runId);
  const deployRequest: DeployReleaseRequest = {
    candidateRoot: candidate.candidateRoot,
    sha: candidate.sha,
    manifestPath: candidate.manifestPath,
  };
  return adapters.withVerifiedSnapshot(deployRequest, (rechecked, deployRoot) => {
    const runtimeRecheck = verifyMediaWriteBridgeRuntimeContractBytes(runtime.bytes);
    const snapshotCandidate = { ...rechecked, candidateRoot: deployRoot };
    const productionRecheck = validatedProductionIdentity(
      adapters.productionIdentity(snapshotCandidate),
    );
    const signerSurfaceRecheck = validatedSignerSurface(
      adapters.scanSignerSurface(snapshotCandidate),
    );
    const snapshotArtifacts = adapters.snapshotArtifactIdentity(rechecked, deployRoot);
    if (rechecked.tree !== candidate.tree || rechecked.manifestSha256 !== candidate.manifestSha256
      || rechecked.artifactTreeSha256 !== candidate.artifactTreeSha256
      || snapshotArtifacts.treeSha256 !== candidate.artifactTreeSha256
      || snapshotArtifacts.workerSha256 !== productionRecheck.workerSha256
      || runtimeRecheck.sha256 !== runtime.sha256
      || canonicalJson(productionRecheck) !== canonicalJson(production)
      || canonicalJson(signerSurfaceRecheck) !== canonicalJson(signerSurface)) {
      throw new Error('Bridge candidate, immutable snapshot, or signer-free proof drifted before upload.');
    }

    validatedWranglerAccount(
      adapters.observeWranglerAccount(rechecked, deployRoot, production.accountId),
      production.accountId,
    );
    const uploadMessage = bridgeVersionUploadMessage({
      runId: authorization.runId,
      manifestSha256: candidate.manifestSha256,
      artifactTreeSha256: candidate.artifactTreeSha256,
    });
    const existing = exactVersionMatch(
      adapters.listVersions(rechecked, deployRoot, production.accountId),
      candidate.sha,
      uploadMessage,
    );
    let versionId = existing?.versionId;
    if (versionId === undefined) {
      requireActiveBridgeAuthorization(authorization, adapters.now(), 'version upload');
      try {
        versionId = validatedUploadReceipt(
          adapters.uploadVersion(
            rechecked,
            deployRoot,
            production.accountId,
            uploadMessage,
          ),
          candidate.sha,
        ).versionId;
      } catch (uploadError) {
        const adopted = exactVersionMatch(
          adapters.listVersions(rechecked, deployRoot, production.accountId),
          candidate.sha,
          uploadMessage,
        );
        if (adopted === null) {
          throw new Error(
            'Bridge version upload failed without one uniquely adoptable exact remote version.',
            { cause: uploadError },
          );
        }
        versionId = adopted.versionId;
      }
    }
    const uploaded = validatedUploadedVersion(
      adapters.observeUploadedVersion(
        rechecked,
        deployRoot,
        production.accountId,
        versionId,
      ),
      {
        accountId: production.accountId,
        sha: candidate.sha,
        uploadMessage,
        versionId,
        production,
      },
    );

    let deployError: unknown;
    let deploymentDisposition: 'deployed' | 'adopted' = 'adopted';
    if (uploaded.trafficPercent === 0) {
      requireActiveBridgeAuthorization(authorization, adapters.now(), 'version deployment');
      try {
        adapters.deployVersion(
          rechecked,
          deployRoot,
          production.accountId,
          versionId,
          uploadMessage,
        );
        deploymentDisposition = 'deployed';
      } catch (error) {
        deployError = error;
      }
    }
    const deployment = validatedDeployment(
      adapters.observeDeployment(rechecked, deployRoot, production.accountId),
    );
    if (deployment.versionId !== versionId || deployment.tagSha !== candidate.sha) {
      throw new Error('Bridge deployment does not serve the exact uploaded candidate version.', {
        cause: deployError,
      });
    }
    const exportDownloadCanary = validatedExportDownloadCanary(
      adapters.observeExportDownloadCanary(rechecked, deployment),
    );
    const deploymentRecheck = validatedDeployment(
      adapters.observeDeployment(rechecked, deployRoot, production.accountId),
    );
    if (canonicalJson(deploymentRecheck) !== canonicalJson(deployment)) {
      throw new Error('Bridge deployment traffic drifted around the authenticated export canary.');
    }
    const evidenceWithoutObservedAt: Omit<
      MediaWriteBridgeDeploymentEvidenceV1,
      'observedAt'
    > = {
      kind: 'candidary.media-write-bridge-deployment-evidence',
      schemaVersion: 1,
      status: 'passed',
      runId: authorization.runId,
      bridgeCandidate: {
        sha: candidate.sha,
        approvedMainSha: authorization.approvedMainSha,
        manifestSha256: candidate.manifestSha256,
        artifactTreeSha256: candidate.artifactTreeSha256,
        migrationCount: 14,
      },
      runtimeContract: { ...runtime.artifact, sha256: runtime.sha256 },
      production: {
        accountId: production.accountId,
        workerName: 'candidary',
        topologySha256: production.topologySha256,
      },
      canonicalBucketProvisioningEvidenceSha256: bucketInput.sha256,
      authorizationSha256: authorizationInput.sha256,
      upload: {
        versionId: uploaded.versionId,
        tagSha: uploaded.tagSha,
        uploadMessageSha256: sha256(uploadMessage),
        trafficPercent: uploaded.trafficPercent,
        providerScriptEtag: uploaded.providerScriptEtag,
        localWorkerSha256: uploaded.localWorkerSha256,
        bindingsSha256: uploaded.bindingsSha256,
        runtimeSha256: uploaded.runtimeSha256,
        observedAt: uploaded.observedAt,
      },
      deployment: { ...deployment, disposition: deploymentDisposition },
      signerFree: { artifactScan: signerSurface, exportDownloadCanary },
      r2SigningTokenId: authorization.r2SigningTokenId,
    };
    const evidenceObservedAt = requireActiveBridgeAuthorization(
      authorization,
      adapters.now(),
      'evidence write',
    );
    const evidence: MediaWriteBridgeDeploymentEvidenceV1 = {
      ...evidenceWithoutObservedAt,
      observedAt: evidenceObservedAt,
    };
    const written = writeEvidence(path, evidence);
    return {
      bridgeSha: candidate.sha,
      versionId: deployment.versionId,
      evidencePath: written.path,
      evidenceSha256: written.sha256,
    };
  });
}

function gitValue(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function gitIsAncestor(candidateRoot: string, baseSha: string, candidateSha: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', baseSha, candidateSha], {
    cwd: candidateRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error('Bridge source-main ancestry observation failed.');
}

function sortedRemoteBindings(bindings: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return bindings.sort((left, right) => {
    const byName = String(left.name).localeCompare(String(right.name));
    return byName === 0 ? String(left.type).localeCompare(String(right.type)) : byName;
  });
}

function remoteBindingsFromConfig(
  config: Record<string, unknown>,
  secretNames: readonly string[],
): Array<Record<string, unknown>> {
  const bindings: Array<Record<string, unknown>> = [];
  const vars = providerObject(config.vars, 'Bridge local vars');
  for (const [name, text] of Object.entries(vars)) {
    if (typeof text !== 'string') throw new Error('Bridge local vars must be exact strings.');
    bindings.push({ name, type: 'plain_text', text });
  }
  for (const name of secretNames) bindings.push({ name, type: 'secret_text' });
  for (const value of config.d1_databases as unknown[] ?? []) {
    const item = providerObject(value, 'Bridge local D1 binding');
    bindings.push({
      name: String(item.binding), type: 'd1', databaseId: String(item.database_id),
    });
  }
  for (const value of config.r2_buckets as unknown[] ?? []) {
    const item = providerObject(value, 'Bridge local R2 binding');
    bindings.push({
      name: String(item.binding), type: 'r2_bucket', bucketName: String(item.bucket_name),
      jurisdiction: item.jurisdiction === undefined ? null : String(item.jurisdiction),
    });
  }
  const images = providerObject(config.images, 'Bridge local Images binding');
  bindings.push({ name: String(images.binding), type: 'images' });
  for (const value of config.send_email as unknown[] ?? []) {
    const item = providerObject(value, 'Bridge local Send Email binding');
    bindings.push({
      name: String(item.name), type: 'send_email',
      destinationAddress: item.destination_address === undefined
        ? null : String(item.destination_address),
      allowedDestinationAddresses: Array.isArray(item.allowed_destination_addresses)
        ? [...item.allowed_destination_addresses].map(String).sort() : [],
      allowedSenderAddresses: Array.isArray(item.allowed_sender_addresses)
        ? [...item.allowed_sender_addresses].map(String).sort() : [],
    });
  }
  for (const value of config.workflows as unknown[] ?? []) {
    const item = providerObject(value, 'Bridge local Workflow binding');
    bindings.push({
      name: String(item.binding), type: 'workflow', workflowName: String(item.name),
      className: String(item.class_name),
      scriptName: item.script_name === undefined ? null : String(item.script_name),
    });
  }
  for (const value of config.ratelimits as unknown[] ?? []) {
    const item = providerObject(value, 'Bridge local Rate Limit binding');
    const simple = providerObject(item.simple, 'Bridge local Rate Limit simple configuration');
    bindings.push({
      name: String(item.name), type: 'ratelimit', namespaceId: String(item.namespace_id),
      limit: Number(simple.limit), period: Number(simple.period),
    });
  }
  const assets = providerObject(config.assets, 'Bridge local Assets binding');
  bindings.push({ name: String(assets.binding), type: 'assets' });
  const versionMetadata = providerObject(
    config.version_metadata,
    'Bridge local version metadata binding',
  );
  bindings.push({ name: String(versionMetadata.binding), type: 'version_metadata' });
  return sortedRemoteBindings(bindings);
}

function assertProviderKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unrecognized provider fields.`);
  }
}

export function normalizedBridgeRemoteBindings(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('Remote Worker bindings must be an array.');
  const names = new Set<string>();
  const normalized = value.map((entry, index) => {
    const item = providerObject(entry, `Remote Worker binding ${index + 1}`);
    const name = String(item.name ?? '');
    const type = String(item.type ?? '');
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || names.has(name)) {
      throw new Error('Remote Worker binding names must be exact and unique.');
    }
    names.add(name);
    if (type === 'plain_text') {
      assertProviderKeys(item, ['name', 'type', 'text'], 'Remote plain-text binding');
      if (typeof item.text !== 'string') throw new Error('Remote plain-text binding is invalid.');
      return { name, type, text: item.text };
    }
    if (type === 'secret_text') {
      assertProviderKeys(item, ['name', 'type', 'text'], 'Remote secret binding');
      return { name, type };
    }
    if (type === 'd1') {
      assertProviderKeys(
        item,
        ['name', 'type', 'id', 'database_id', 'internalEnv', 'database_internal_env', 'raw'],
        'Remote D1 binding',
      );
      const databaseId = item.id ?? item.database_id;
      if (typeof databaseId !== 'string'
        || (item.id !== undefined && item.database_id !== undefined && item.id !== item.database_id)) {
        throw new Error('Remote D1 binding database identity is invalid.');
      }
      return { name, type, databaseId };
    }
    if (type === 'r2_bucket') {
      assertProviderKeys(
        item,
        ['name', 'type', 'bucket_name', 'jurisdiction', 'raw'],
        'Remote R2 binding',
      );
      if (typeof item.bucket_name !== 'string') throw new Error('Remote R2 binding is invalid.');
      return {
        name, type, bucketName: item.bucket_name,
        jurisdiction: item.jurisdiction === undefined ? null : String(item.jurisdiction),
      };
    }
    if (type === 'workflow') {
      assertProviderKeys(
        item,
        ['name', 'type', 'workflow_name', 'class_name', 'script_name', 'raw'],
        'Remote Workflow binding',
      );
      if (typeof item.workflow_name !== 'string' || typeof item.class_name !== 'string') {
        throw new Error('Remote Workflow binding is invalid.');
      }
      return {
        name, type, workflowName: item.workflow_name, className: item.class_name,
        scriptName: item.script_name === undefined ? null : String(item.script_name),
      };
    }
    if (type === 'ratelimit') {
      assertProviderKeys(
        item,
        ['name', 'type', 'namespace_id', 'simple', 'raw'],
        'Remote Rate Limit binding',
      );
      const simple = providerObject(item.simple, 'Remote Rate Limit simple configuration');
      assertProviderKeys(simple, ['limit', 'period', 'mitigation_timeout'], 'Remote Rate Limit');
      if (typeof item.namespace_id !== 'string' || !Number.isSafeInteger(simple.limit)
        || !Number.isSafeInteger(simple.period)
        || !(simple.mitigation_timeout === undefined || simple.mitigation_timeout === 0)) {
        throw new Error('Remote Rate Limit binding is invalid.');
      }
      return {
        name, type, namespaceId: item.namespace_id,
        limit: simple.limit, period: simple.period,
      };
    }
    if (type === 'send_email') {
      assertProviderKeys(item, [
        'name', 'type', 'destination_address', 'allowed_destination_addresses',
        'allowed_sender_addresses',
      ], 'Remote Send Email binding');
      return {
        name, type,
        destinationAddress: item.destination_address === undefined
          ? null : String(item.destination_address),
        allowedDestinationAddresses: Array.isArray(item.allowed_destination_addresses)
          ? [...item.allowed_destination_addresses].map(String).sort() : [],
        allowedSenderAddresses: Array.isArray(item.allowed_sender_addresses)
          ? [...item.allowed_sender_addresses].map(String).sort() : [],
      };
    }
    if (['images', 'assets', 'version_metadata'].includes(type)) {
      assertProviderKeys(item, ['name', 'type'], `Remote ${type} binding`);
      return { name, type };
    }
    throw new Error(`Remote Worker binding ${name} has an unapproved type.`);
  });
  return sortedRemoteBindings(normalized);
}

export function bridgeVersionTrafficPercent(value: unknown, versionId: string): number {
  if (!UUID_PATTERN.test(versionId)) throw new Error('Bridge traffic version ID is invalid.');
  const status = providerObject(value, 'Wrangler deployment status');
  if (!Array.isArray(status.versions)) {
    throw new Error('Wrangler deployment status versions are invalid.');
  }
  let percentage = 0;
  let found = false;
  const seen = new Set<string>();
  for (const [index, entry] of status.versions.entries()) {
    const traffic = providerObject(entry, `Wrangler deployment traffic ${index + 1}`);
    const id = String(traffic.version_id);
    const value = Number(traffic.percentage);
    if (!UUID_PATTERN.test(id) || seen.has(id) || !Number.isFinite(value)
      || value <= 0 || value > 100) {
      throw new Error('Wrangler deployment traffic contains invalid or duplicate entries.');
    }
    seen.add(id);
    if (id === versionId) {
      found = true;
      percentage = value;
    }
  }
  return found ? percentage : 0;
}

function remoteRuntimeIdentity(): Record<string, unknown> {
  return {
    compatibilityDate: '2026-07-21',
    compatibilityFlags: ['nodejs_compat'],
    handlers: ['fetch', 'scheduled'],
  };
}

export function bridgeProductionIdentity(
  candidate: VerifiedReleaseCandidate,
): BridgeProductionIdentity {
  const config = JSON.parse(readFileSync(exactRegularFile(
    resolve(candidate.candidateRoot, 'dist/candidary/wrangler.json'),
    'Bridge Wrangler config',
  ), 'utf8')) as Record<string, unknown>;
  const vars = config.vars as Record<string, unknown> | undefined;
  const secrets = config.secrets as Record<string, unknown> | undefined;
  const accountId = vars?.R2_ACCOUNT_ID;
  const topology = normalizedBindingTopology(config);
  const unclassified = Object.keys(config).filter((key) => !BRIDGE_CONFIG_KEYS.has(key));
  const generatedDefaults = Object.fromEntries(
    Object.keys(BRIDGE_GENERATED_DEFAULTS).map((key) => [key, config[key]]),
  );
  const invalidProvenance = ['configPath', 'userConfigPath']
    .some((key) => config[key] !== undefined && typeof config[key] !== 'string');
  const exactProductionIdentity = {
    worker: {
      name: config.name,
      main: config.main,
      workersDev: config.workers_dev,
      previewUrls: config.preview_urls,
    },
    d1: config.d1_databases,
    r2: config.r2_buckets,
    vars,
    placement: config.placement,
    topology,
  };
  const expectedProductionIdentity = {
    worker: { name: 'candidary', main: 'index.js', workersDev: false, previewUrls: false },
    d1: [{
      binding: 'DB', database_name: 'candidary-core',
      database_id: '60bec5de-c8c7-41b5-a26b-2d3f7d184c71',
      migrations_dir: '../../migrations',
    }],
    r2: [{ binding: 'MEDIA_BUCKET', bucket_name: 'candidary-media' }],
    vars: {
      APP_ORIGIN: 'https://candidary.app',
      ALTERNATE_ORIGINS: 'https://candidary.online',
      R2_ACCOUNT_ID: accountId,
      R2_BUCKET_NAME: 'candidary-media',
      EMAIL_FROM: 'hello@candidary.app',
    },
    placement: { mode: 'smart' },
    topology: BRIDGE_BINDING_TOPOLOGY,
  };
  if (unclassified.length > 0 || invalidProvenance
    || canonicalJson(generatedDefaults) !== canonicalJson(BRIDGE_GENERATED_DEFAULTS)
    || typeof accountId !== 'string'
    || !ACCOUNT_ID_PATTERN.test(accountId) || !Array.isArray(secrets?.required)
    || canonicalJson(exactProductionIdentity) !== canonicalJson(expectedProductionIdentity)
    || candidate.manifest.bindings === null
    || candidate.manifest.bindings.sourceTopologySha256 !== sha256(canonicalJson(topology))) {
    throw new Error('Bridge generated config is not the exact canonical production topology.');
  }
  const requiredSecretNames = [...secrets.required].map(String).sort();
  const legacySignerSecretNames = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const preprovisionedGuestbookSecretNames = ['GUEST_MESSAGE_HMAC_KEY'];
  const allowedRemoteBindingsSha256 = [
    requiredSecretNames,
    [...requiredSecretNames, ...legacySignerSecretNames].sort(),
    [...requiredSecretNames, ...preprovisionedGuestbookSecretNames].sort(),
    [
      ...requiredSecretNames,
      ...legacySignerSecretNames,
      ...preprovisionedGuestbookSecretNames,
    ].sort(),
  ].map((secretNames) => sha256(canonicalJson(remoteBindingsFromConfig(config, secretNames))));
  return {
    accountId,
    workerName: 'candidary',
    topologySha256: sha256(canonicalJson(exactProductionIdentity)),
    requiredSecretNames,
    workerSha256: sha256(readFileSync(exactRegularFile(
      resolve(candidate.candidateRoot, 'dist/candidary/index.js'),
      'Bridge Worker artifact',
    ))),
    allowedRemoteBindingsSha256,
    remoteRuntimeSha256: sha256(canonicalJson(remoteRuntimeIdentity())),
  };
}

export function scanBridgeSignerSurface(
  candidate: VerifiedReleaseCandidate,
): SignerSurfaceEvidence {
  const worker = readFileSync(exactRegularFile(
    resolve(candidate.candidateRoot, 'dist/candidary/index.js'),
    'Bridge Worker artifact',
  ), 'utf8');
  const xAmzUrlCount = (worker.match(/X-Amz/gu) ?? []).length;
  const r2SignerReferenceCount = (
    worker.match(
      /R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|presignUpload|presignDownload|presignLegacyTestUpload|aws4fetch|AwsClient|signQuery/gu,
    ) ?? []
  ).length;
  return { xAmzUrlCount, r2SignerReferenceCount };
}

export function bridgeExportCanaryRequest(requestUrl: string): {
  url: string;
  method: 'GET';
  accept: 'application/zip';
} {
  const parsedUrl = new URL(requestUrl);
  const match = parsedUrl.pathname.match(
    /^\/api\/manage\/events\/([^/]+)\/exports\/([^/]+)\/artifacts\/parts\/([1-9][0-9]*)$/u,
  );
  if (parsedUrl.origin !== 'https://candidary.app' || match === null
    || !UUID_PATTERN.test(match[1]!) || !UUID_PATTERN.test(match[2]!)
    || parsedUrl.search !== '' || parsedUrl.hash !== '' || parsedUrl.username !== ''
    || parsedUrl.password !== '') {
    throw new Error('Bridge export canary URL is not an exact positive-part production artifact route.');
  }
  return { url: requestUrl, method: 'GET', accept: 'application/zip' };
}

function defaultExportDownloadCanary(): ExportDownloadCanaryEvidence {
  const requestUrl = process.env.CANDIDARY_BRIDGE_EXPORT_CANARY_URL;
  const cookie = process.env.CANDIDARY_BRIDGE_EXPORT_CANARY_COOKIE;
  const expectedArtifactSha256 = process.env.CANDIDARY_BRIDGE_EXPORT_CANARY_EXPECTED_SHA256;
  const expectedByteLength = Number(
    process.env.CANDIDARY_BRIDGE_EXPORT_CANARY_EXPECTED_BYTE_LENGTH,
  );
  if (requestUrl === undefined || cookie === undefined || expectedArtifactSha256 === undefined
    || !SHA256_PATTERN.test(expectedArtifactSha256)
    || !Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0) {
    throw new Error('Bridge export canary environment is missing or invalid.');
  }
  const canaryRequest = bridgeExportCanaryRequest(requestUrl);
  const childScript = `
    import { createHash } from 'node:crypto';
    const requestUrl = process.env.CANDIDARY_BRIDGE_EXPORT_CANARY_URL;
    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: { cookie: process.env.CANDIDARY_BRIDGE_EXPORT_CANARY_COOKIE, accept: 'application/zip' },
      redirect: 'manual',
      cache: 'no-store',
    });
    const body = Buffer.from(await response.arrayBuffer());
    process.stdout.write(JSON.stringify({
      httpStatus: response.status,
      responseSha256: createHash('sha256').update(body).digest('hex'),
      responseByteLength: body.byteLength,
      responseUrl: response.url,
      redirected: response.redirected,
      cacheControl: response.headers.get('cache-control'),
      contentDisposition: response.headers.get('content-disposition'),
      contentType: response.headers.get('content-type'),
      xContentTypeOptions: response.headers.get('x-content-type-options'),
      observedAt: new Date().toISOString(),
    }));
  `;
  const observation = providerObject(JSON.parse(execFileSync(process.execPath, [
    '--input-type=module', '--eval', childScript,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
    maxBuffer: Math.max(1024 * 1024, expectedByteLength + 1024 * 1024),
  })) as unknown, 'Bridge export download canary response');
  const contentDisposition = typeof observation.contentDisposition === 'string'
    && /^attachment(?:;|$)/iu.test(observation.contentDisposition)
    ? 'attachment'
    : 'invalid';
  return {
    status: 'passed',
    httpStatus: Number(observation.httpStatus) as 200,
    method: canaryRequest.method,
    artifactUrlSha256: sha256(canaryRequest.url),
    expectedArtifactSha256,
    responseSha256: String(observation.responseSha256),
    expectedByteLength,
    responseByteLength: Number(observation.responseByteLength),
    sameOrigin: (observation.responseUrl === requestUrl) as true,
    redirected: Boolean(observation.redirected) as false,
    cacheControl: String(observation.cacheControl) as 'private, no-store',
    contentDisposition: contentDisposition as 'attachment',
    contentType: String(observation.contentType) as 'application/zip',
    xContentTypeOptions: String(observation.xContentTypeOptions) as 'nosniff',
    observedAt: String(observation.observedAt),
  };
}

function providerObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function wranglerCommonEnvironment(accountId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    WRANGLER_SEND_METRICS: 'false',
  };
}

function wranglerJson(
  candidate: VerifiedReleaseCandidate,
  deployRoot: string,
  accountId: string,
  args: string[],
): unknown {
  const raw = execFileSync(process.execPath, [candidate.wranglerCliPath, ...args], {
    cwd: deployRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: wranglerCommonEnvironment(accountId),
  });
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Wrangler did not return one exact JSON response.', { cause: error });
  }
}

function defaultWranglerAccountObservation(
  candidate: VerifiedReleaseCandidate,
  deployRoot: string,
  accountId: string,
): { accountIds: string[] } {
  const value = providerObject(wranglerJson(candidate, deployRoot, accountId, [
    'whoami', '--json',
  ]), 'Wrangler whoami response');
  if (value.loggedIn !== true || !Array.isArray(value.accounts)) {
    throw new Error('Wrangler is not authenticated for bridge release.');
  }
  return {
    accountIds: value.accounts.map((account, index) => {
      const item = providerObject(account, `Wrangler account ${index + 1}`);
      if (typeof item.id !== 'string') throw new Error('Wrangler account ID is invalid.');
      return item.id;
    }),
  };
}

export function parseBridgeWranglerVersionList(value: unknown): BridgeListedVersion[] {
  if (!Array.isArray(value)) throw new Error('Wrangler versions list response is invalid.');
  return value.map((entry, index) => {
    const item = providerObject(entry, `Wrangler version ${index + 1}`);
    const annotations = item.annotations === undefined
      ? {} : providerObject(item.annotations, `Wrangler version annotations ${index + 1}`);
    return {
      versionId: String(item.id),
      workerName: 'candidary',
      tagSha: typeof annotations['workers/tag'] === 'string'
        && annotations['workers/tag'].length > 0
        ? annotations['workers/tag'] : null,
      uploadMessage: typeof annotations['workers/message'] === 'string'
        && annotations['workers/message'].length > 0
        ? annotations['workers/message'] : null,
    };
  });
}

function defaultVersionList(
  candidate: VerifiedReleaseCandidate,
  deployRoot: string,
  accountId: string,
): BridgeListedVersion[] {
  return parseBridgeWranglerVersionList(wranglerJson(candidate, deployRoot, accountId, [
    'versions', 'list', '--config', 'dist/candidary/wrangler.json',
    '--name', 'candidary', '--json',
  ]));
}

function freshWranglerOutputPath(deployRoot: string): string {
  const path = resolve(deployRoot, '.bridge-version-upload.ndjson');
  try {
    lstatSync(path);
    throw new Error('Wrangler bridge upload output path already exists.');
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) throw error;
  }
  return path;
}

export function parseBridgeWranglerUploadOutput(raw: string): BridgeVersionUploadReceipt {
  const lines = raw.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 2) throw new Error('Wrangler upload wrote the wrong number of receipts.');
  let values: unknown[];
  try {
    values = lines.map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    throw new Error('Wrangler upload receipt is not exact JSON.', { cause: error });
  }
  const session = providerObject(values[0], 'Wrangler upload session');
  if (session.type !== 'wrangler-session' || session.version !== 1
    || session.wrangler_version !== '4.113.0') {
    throw new Error('Wrangler upload receipt session identity is invalid.');
  }
  const receipt = providerObject(values[1], 'Wrangler upload receipt');
  if (receipt.type !== 'version-upload' || receipt.version !== 1
    || receipt.worker_name !== 'candidary' || receipt.worker_tag === null) {
    throw new Error('Wrangler upload receipt identity is invalid.');
  }
  return {
    versionId: String(receipt.version_id),
    workerName: 'candidary',
    tagSha: String(receipt.worker_tag),
  };
}

function defaultUploadVersion(
  candidate: VerifiedReleaseCandidate,
  deployRoot: string,
  accountId: string,
  uploadMessage: string,
): BridgeVersionUploadReceipt {
  const output = freshWranglerOutputPath(deployRoot);
  const plan = buildBridgeVersionCommandPlan({
    nodeExecPath: process.execPath,
    wranglerCliPath: candidate.wranglerCliPath,
    deployRoot,
    accountId,
    sha: candidate.sha,
    uploadMessage,
    versionId: '00000000-0000-4000-8000-000000000000',
    outputPath: output,
    environment: process.env,
  });
  const command = plan[0];
  let result;
  try {
    result = spawnSync(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: command.shell,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Wrangler versions upload failed.');
    return parseBridgeWranglerUploadOutput(readFileSync(output, 'utf8'));
  } finally {
    rmSync(output, { force: true });
  }
}

function defaultDeploymentTraffic(
  candidate: VerifiedReleaseCandidate,
  deployRoot: string,
  accountId: string,
): BridgeDeploymentObservation {
  const status = providerObject(wranglerJson(candidate, deployRoot, accountId, [
    'deployments', 'status', '--config', 'dist/candidary/wrangler.json',
    '--name', 'candidary', '--json',
  ]), 'Wrangler deployment status');
  if (!Array.isArray(status.versions) || status.versions.length !== 1) {
    throw new Error('Bridge must be the sole deployed production version.');
  }
  const traffic = providerObject(status.versions[0], 'Wrangler deployment traffic');
  if (traffic.percentage !== 100) {
    throw new Error('Bridge must be the sole 100 percent deployed production version.');
  }
  const versionId = String(traffic.version_id);
  const version = providerObject(wranglerJson(candidate, deployRoot, accountId, [
    'versions', 'view', versionId, '--config', 'dist/candidary/wrangler.json',
    '--name', 'candidary', '--json',
  ]), 'Wrangler deployed version');
  const annotations = providerObject(version.annotations, 'Wrangler deployed annotations');
  return {
    versionId,
    tagSha: String(annotations['workers/tag']),
    trafficPercent: 100,
  };
}

export function observeBridgeUploadedVersionFromWrangler(input: {
  accountId: string;
  versionId: string;
  localWorkerSha256: string;
  observedAt: string;
  version: unknown;
  deploymentStatus: unknown;
}): BridgeUploadedVersionObservation {
  const version = providerObject(input.version, 'Wrangler uploaded version');
  const annotations = providerObject(version.annotations, 'Wrangler uploaded version annotations');
  const resources = providerObject(version.resources, 'Wrangler uploaded version resources');
  const script = providerObject(resources.script, 'Wrangler uploaded script');
  const runtime = providerObject(resources.script_runtime, 'Wrangler uploaded runtime');
  const bindings = normalizedBridgeRemoteBindings(resources.bindings);
  const trafficPercent = bridgeVersionTrafficPercent(input.deploymentStatus, input.versionId);
  const handlers = Array.isArray(script.handlers) ? [...script.handlers].map(String).sort() : [];
  const compatibilityFlags = Array.isArray(runtime.compatibility_flags)
    ? [...runtime.compatibility_flags].map(String).sort() : [];
  const runtimeIdentity = {
    compatibilityDate: String(runtime.compatibility_date),
    compatibilityFlags,
    handlers,
  };
  return {
    accountId: input.accountId,
    workerName: 'candidary',
    versionId: String(version.id),
    tagSha: String(annotations['workers/tag']),
    uploadMessage: String(annotations['workers/message']),
    trafficPercent: trafficPercent as 0 | 100,
    providerScriptEtag: String(script.etag),
    localWorkerSha256: input.localWorkerSha256,
    bindingsSha256: sha256(canonicalJson(bindings)),
    runtimeSha256: sha256(canonicalJson(runtimeIdentity)),
    observedAt: input.observedAt,
  };
}

function defaultUploadedVersionObservation(
  candidate: VerifiedReleaseCandidate,
  deployRoot: string,
  accountId: string,
  versionId: string,
): BridgeUploadedVersionObservation {
  const version = wranglerJson(candidate, deployRoot, accountId, [
    'versions', 'view', versionId, '--config', 'dist/candidary/wrangler.json',
    '--name', 'candidary', '--json',
  ]);
  const deploymentStatus = wranglerJson(candidate, deployRoot, accountId, [
    'deployments', 'status', '--config', 'dist/candidary/wrangler.json',
    '--name', 'candidary', '--json',
  ]);
  return observeBridgeUploadedVersionFromWrangler({
    accountId,
    versionId,
    localWorkerSha256: sha256(readFileSync(resolve(deployRoot, 'dist/candidary/index.js'))),
    observedAt: new Date().toISOString(),
    version,
    deploymentStatus,
  });
}

function defaultDeployVersion(
  candidate: VerifiedReleaseCandidate,
  deployRoot: string,
  accountId: string,
  versionId: string,
  uploadMessage: string,
): void {
  const plan = buildBridgeVersionCommandPlan({
    nodeExecPath: process.execPath,
    wranglerCliPath: candidate.wranglerCliPath,
    deployRoot,
    accountId,
    sha: candidate.sha,
    uploadMessage,
    versionId,
    outputPath: resolve(deployRoot, '.bridge-version-deploy.ndjson'),
    environment: process.env,
  });
  const command = plan[1];
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: command.shell,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Wrangler exact bridge version deployment failed.');
}

const defaultAdapters: BridgeReleaseAdapters = {
  now: () => new Date().toISOString(),
  verifyCandidate(request) {
    return verifyExactReleaseCandidate(request, {
      resolveCommit: (root, sha) => gitValue(['rev-parse', '--verify', `${sha}^{commit}`], root),
      head: (root) => gitValue(['rev-parse', '--verify', 'HEAD^{commit}'], root),
      tree: (root) => gitValue(['rev-parse', '--verify', 'HEAD^{tree}'], root),
      status: (root) => gitValue(['status', '--porcelain=v1', '--untracked-files=all'], root),
    });
  },
  isAncestor: gitIsAncestor,
  productionIdentity: bridgeProductionIdentity,
  withVerifiedSnapshot(request, action) {
    return withVerifiedDeploySnapshot(request, (snapshot) =>
      action(snapshot.candidate, snapshot.deployRoot));
  },
  snapshotArtifactIdentity(_candidate, deployRoot) {
    const artifacts = collectDeployableArtifacts(deployRoot);
    return { treeSha256: artifacts.treeSha256, workerSha256: artifacts.worker.sha256 };
  },
  observeWranglerAccount: defaultWranglerAccountObservation,
  listVersions: defaultVersionList,
  uploadVersion: defaultUploadVersion,
  observeUploadedVersion: defaultUploadedVersionObservation,
  deployVersion: defaultDeployVersion,
  observeDeployment: defaultDeploymentTraffic,
  scanSignerSurface: scanBridgeSignerSurface,
  observeExportDownloadCanary: defaultExportDownloadCanary,
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
    runBridgeRelease(parseBridgeReleaseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Guarded bridge deployment failed.');
    process.exitCode = 1;
  }
}

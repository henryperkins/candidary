import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';

import { canonicalJson, sha256 } from './release-evidence.ts';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/u;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const OWNER_PATTERN = /^[a-z][a-z0-9._-]{2,63}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const MEDIA_UPLOAD_RELEASE_CONFIG_PATH = 'config/media-upload-release.json';
export const PRODUCTION_R2_SIGNING_TOKEN_ID = 'c580e42d532fea4f8cf3897a9c637346' as const;
export const BRIDGE_SOURCE_MAIN_SHA = '16d9792f439dc5418272d27e26949ae7f29a70dc' as const;

export const BRIDGE_CAPABILITIES = {
  singleInitiationPresign: false,
  batchInitiationPresign: false,
  storedReplayPresign: false,
  reservedFinalize: false,
  exportDownloadPresign: false,
  authenticatedWorkerIngress: false,
  legacyPromotion: false,
  eventRelationalPurge: false,
} as const;

const BRIDGE_CAPABILITY_NAMES = Object.keys(BRIDGE_CAPABILITIES) as Array<keyof typeof BRIDGE_CAPABILITIES>;

export interface MediaWriteBridgeRuntimeContractV1 {
  kind: 'candidary.media-upload-release';
  schemaVersion: 1;
  mode: 'bridge-disabled';
  capabilities: typeof BRIDGE_CAPABILITIES;
}

export interface MediaWriteBridgeAuthorizationV1 {
  kind: 'candidary.media-write-bridge-authorization';
  schemaVersion: 1;
  runId: string;
  approvedMainSha: string;
  bridgeSha: string;
  bridgeManifestSha256: string;
  bridgeArtifactTreeSha256: string;
  productionTopologySha256: string;
  runtimeContractSha256: string;
  canonicalBucketProvisioningEvidenceSha256: string;
  accountId: string;
  workerName: 'candidary';
  r2SigningTokenId: string;
  authorizedAt: string;
  expiresAt: string;
  operator: string;
}

export interface AuthenticatedExportDownloadCanaryEvidence {
  status: 'passed';
  httpStatus: 200;
  method: 'GET';
  artifactUrlSha256: string;
  expectedArtifactSha256: string;
  responseSha256: string;
  expectedByteLength: number;
  responseByteLength: number;
  sameOrigin: true;
  redirected: false;
  cacheControl: 'private, no-store';
  contentDisposition: 'attachment';
  contentType: 'application/zip';
  xContentTypeOptions: 'nosniff';
  observedAt: string;
}

export interface MediaWriteBridgeDeploymentEvidenceV1 {
  kind: 'candidary.media-write-bridge-deployment-evidence';
  schemaVersion: 1;
  status: 'passed';
  runId: string;
  bridgeCandidate: {
    sha: string;
    approvedMainSha: string;
    manifestSha256: string;
    artifactTreeSha256: string;
    migrationCount: 14;
  };
  runtimeContract: MediaWriteBridgeRuntimeContractV1 & { sha256: string };
  production: {
    accountId: string;
    workerName: 'candidary';
    topologySha256: string;
  };
  canonicalBucketProvisioningEvidenceSha256: string;
  authorizationSha256: string;
  upload: {
    versionId: string;
    tagSha: string;
    uploadMessageSha256: string;
    trafficPercent: 0 | 100;
    providerScriptEtag: string;
    localWorkerSha256: string;
    bindingsSha256: string;
    runtimeSha256: string;
    observedAt: string;
  };
  deployment: {
    versionId: string;
    tagSha: string;
    trafficPercent: 100;
    disposition: 'deployed' | 'adopted';
  };
  signerFree: {
    artifactScan: {
      xAmzUrlCount: 0;
      r2SignerReferenceCount: 0;
    };
    exportDownloadCanary: AuthenticatedExportDownloadCanaryEvidence;
  };
  r2SigningTokenId: string;
  observedAt: string;
}

export interface R2SigningTokenRevocationEvidenceV1 {
  kind: 'candidary.r2-signing-token-revocation-evidence';
  schemaVersion: 1;
  status: 'revoked';
  bridgeDeploymentEvidenceSha256: string;
  canonicalBucketProvisioningEvidenceSha256: string;
  provider: 'cloudflare-r2';
  accountId: string;
  r2SigningTokenId: string;
  providerStatus: {
    tokenId: string;
    state: 'disabled';
    scope: 'all-buckets';
    permission: 'admin-read-write';
    observedAt: string;
  };
  providerResponses: {
    revocationReceiptSha256: string;
    statusObservationSha256: string;
    legacySignedPutProbeObservationSha256: string;
    legacyProbeObjectAbsenceObservationSha256: string;
    canonicalSignedPutProbeObservationSha256: string;
    canonicalPostRevocationEmptyObservationSha256: string;
    bridgeExportDownloadCanaryAfterRevocationObservationSha256: string;
  };
  legacyBucketSignerProbe: {
    status: 'access_denied';
    httpStatus: 403;
    method: 'PUT';
    targetBucket: 'candidary-media';
    signingAccessKeyId: string;
    objectKeySha256: string;
    signedWhileActiveAt: string;
    invokedAt: string;
    expiresAt: string;
  };
  legacyBucketProbeAbsence: {
    status: 'absent';
    httpStatus: 404;
    method: 'HEAD';
    targetBucket: 'candidary-media';
    objectKeySha256: string;
    observedAt: string;
  };
  canonicalBucketSignerProbe: {
    status: 'access_denied';
    httpStatus: 403;
    method: 'PUT';
    targetBucket: 'candidary-media-canonical-v2';
    signingAccessKeyId: string;
    objectKeySha256: string;
    signedWhileActiveAt: string;
    invokedAt: string;
    expiresAt: string;
  };
  canonicalPostRevocationEmpty: {
    operation: 'LIST';
    targetBucket: 'candidary-media-canonical-v2';
    observedAt: string;
    truncated: false;
    objectCount: 0;
    probeObjectKeySha256: string;
  };
  bridgeExportDownloadCanaryAfterRevocation: AuthenticatedExportDownloadCanaryEvidence;
  revokedAt: string;
  operator: string;
}

export interface VerifiedCanonicalArtifact<T> {
  artifact: T;
  path: string;
  sha256: string;
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

function canonicalInstant(value: unknown, label: string): string {
  const result = patternString(value, ISO_PATTERN, label);
  if (new Date(result).toISOString() !== result) {
    throw new Error(`${label} is not a canonical UTC instant.`);
  }
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

function readCanonicalInput<T>(path: string, label: string): VerifiedCanonicalArtifact<T> {
  const inputPath = exactRegularFile(path, label);
  const bytes = readFileSync(inputPath, 'utf8');
  const digest = sha256(bytes);
  const sidecarPath = exactRegularFile(`${inputPath}.sha256`, `${label} sidecar`);
  const sidecar = readFileSync(sidecarPath, 'utf8');
  if (sidecar !== `${digest}  ${basename(inputPath)}\n`) {
    throw new Error(`${label} sidecar digest does not match.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (bytes !== `${canonicalJson(value)}\n`) {
    throw new Error(`${label} JSON is not canonical.`);
  }
  return { artifact: value as T, path: inputPath, sha256: digest };
}

export function parseMediaWriteBridgeRuntimeContract(
  value: unknown,
): MediaWriteBridgeRuntimeContractV1 {
  const item = exactRecord(
    value,
    ['kind', 'schemaVersion', 'mode', 'capabilities'],
    'Media upload bridge runtime contract',
  );
  if (item.kind !== 'candidary.media-upload-release'
    || item.schemaVersion !== 1
    || item.mode !== 'bridge-disabled') {
    throw new Error('Media upload bridge runtime contract identity, schema, or mode is invalid.');
  }
  const capabilities = exactRecord(
    item.capabilities,
    BRIDGE_CAPABILITY_NAMES,
    'Media upload bridge capabilities',
  );
  for (const name of BRIDGE_CAPABILITY_NAMES) {
    if (capabilities[name] !== false) {
      throw new Error(`Media upload bridge capability ${name} must be exactly false.`);
    }
  }
  return {
    kind: 'candidary.media-upload-release',
    schemaVersion: 1,
    mode: 'bridge-disabled',
    capabilities: { ...BRIDGE_CAPABILITIES },
  };
}

export function verifyMediaWriteBridgeRuntimeContract(
  path: string,
): VerifiedCanonicalArtifact<MediaWriteBridgeRuntimeContractV1> & { bytes: string } {
  const inputPath = exactRegularFile(path, 'Media upload bridge runtime contract');
  const bytes = readFileSync(inputPath, 'utf8');
  return {
    ...verifyMediaWriteBridgeRuntimeContractBytes(bytes),
    bytes,
    path: inputPath,
  };
}

export function verifyMediaWriteBridgeRuntimeContractBytes(
  bytes: string,
): Pick<VerifiedCanonicalArtifact<MediaWriteBridgeRuntimeContractV1>, 'artifact' | 'sha256'> {
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error('Media upload bridge runtime contract is not valid JSON.', { cause: error });
  }
  if (bytes !== `${canonicalJson(value)}\n`) {
    throw new Error('Media upload bridge runtime contract JSON is not canonical.');
  }
  return {
    artifact: parseMediaWriteBridgeRuntimeContract(value),
    sha256: sha256(bytes),
  };
}

function parseMediaWriteBridgeAuthorization(value: unknown): MediaWriteBridgeAuthorizationV1 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'runId', 'approvedMainSha', 'bridgeSha',
    'bridgeManifestSha256', 'bridgeArtifactTreeSha256', 'productionTopologySha256',
    'runtimeContractSha256', 'canonicalBucketProvisioningEvidenceSha256',
    'accountId', 'workerName', 'r2SigningTokenId',
    'authorizedAt', 'expiresAt', 'operator',
  ], 'Media write bridge authorization');
  if (item.kind !== 'candidary.media-write-bridge-authorization' || item.schemaVersion !== 1) {
    throw new Error('Media write bridge authorization identity is invalid.');
  }
  if (item.workerName !== 'candidary') {
    throw new Error('Media write bridge authorization workerName is invalid.');
  }
  const authorizedAt = canonicalInstant(item.authorizedAt, 'Bridge authorizedAt');
  const expiresAt = canonicalInstant(item.expiresAt, 'Bridge expiresAt');
  if (authorizedAt >= expiresAt) throw new Error('Bridge authorization time window is invalid.');
  return {
    kind: 'candidary.media-write-bridge-authorization',
    schemaVersion: 1,
    runId: patternString(item.runId, UUID_PATTERN, 'Bridge runId'),
    approvedMainSha: (() => {
      const approvedMainSha = patternString(
        item.approvedMainSha,
        SHA_PATTERN,
        'Bridge approvedMainSha',
      );
      if (approvedMainSha !== BRIDGE_SOURCE_MAIN_SHA) {
        throw new Error('Bridge authorization is not based on the exact schema-14 source main.');
      }
      return approvedMainSha;
    })(),
    bridgeSha: patternString(item.bridgeSha, SHA_PATTERN, 'Bridge SHA'),
    bridgeManifestSha256: patternString(item.bridgeManifestSha256, SHA256_PATTERN, 'Bridge manifest SHA-256'),
    bridgeArtifactTreeSha256: patternString(item.bridgeArtifactTreeSha256, SHA256_PATTERN, 'Bridge artifact tree SHA-256'),
    productionTopologySha256: patternString(item.productionTopologySha256, SHA256_PATTERN, 'Bridge topology SHA-256'),
    runtimeContractSha256: patternString(item.runtimeContractSha256, SHA256_PATTERN, 'Bridge runtime contract SHA-256'),
    canonicalBucketProvisioningEvidenceSha256: patternString(
      item.canonicalBucketProvisioningEvidenceSha256,
      SHA256_PATTERN,
      'Canonical bucket provisioning evidence SHA-256',
    ),
    accountId: patternString(item.accountId, ACCOUNT_ID_PATTERN, 'Bridge accountId'),
    workerName: 'candidary',
    r2SigningTokenId: (() => {
      const tokenId = patternString(item.r2SigningTokenId, TOKEN_ID_PATTERN, 'R2 signing token ID');
      if (tokenId !== PRODUCTION_R2_SIGNING_TOKEN_ID) {
        throw new Error('Bridge authorization does not name the exact observed production R2 signer token.');
      }
      return tokenId;
    })(),
    authorizedAt,
    expiresAt,
    operator: patternString(item.operator, OWNER_PATTERN, 'Bridge operator'),
  };
}

export function verifyMediaWriteBridgeAuthorization(
  path: string,
): VerifiedCanonicalArtifact<MediaWriteBridgeAuthorizationV1> {
  const input = readCanonicalInput<unknown>(path, 'Media write bridge authorization');
  return { ...input, artifact: parseMediaWriteBridgeAuthorization(input.artifact) };
}

function parseAuthenticatedExportDownloadCanary(
  value: unknown,
  label: string,
): AuthenticatedExportDownloadCanaryEvidence {
  const item = exactRecord(value, [
    'status', 'httpStatus', 'method', 'artifactUrlSha256',
    'expectedArtifactSha256', 'responseSha256',
    'expectedByteLength', 'responseByteLength', 'sameOrigin', 'redirected',
    'cacheControl', 'contentDisposition', 'contentType', 'xContentTypeOptions',
    'observedAt',
  ], label);
  const expectedArtifactSha256 = patternString(
    item.expectedArtifactSha256,
    SHA256_PATTERN,
    `${label} expected artifact SHA-256`,
  );
  const artifactUrlSha256 = patternString(
    item.artifactUrlSha256,
    SHA256_PATTERN,
    `${label} artifact URL SHA-256`,
  );
  const responseSha256 = patternString(
    item.responseSha256,
    SHA256_PATTERN,
    `${label} response SHA-256`,
  );
  const expectedByteLength = Number(item.expectedByteLength);
  const responseByteLength = Number(item.responseByteLength);
  if (item.status !== 'passed' || item.httpStatus !== 200 || item.method !== 'GET'
    || expectedArtifactSha256 !== responseSha256
    || !Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0
    || responseByteLength !== expectedByteLength
    || item.sameOrigin !== true || item.redirected !== false
    || item.cacheControl !== 'private, no-store'
    || item.contentDisposition !== 'attachment'
    || item.contentType !== 'application/zip'
    || item.xContentTypeOptions !== 'nosniff') {
    throw new Error(`${label} does not prove exact authenticated same-origin bytes.`);
  }
  return {
    status: 'passed',
    httpStatus: 200,
    method: 'GET',
    artifactUrlSha256,
    expectedArtifactSha256,
    responseSha256,
    expectedByteLength,
    responseByteLength,
    sameOrigin: true,
    redirected: false,
    cacheControl: 'private, no-store',
    contentDisposition: 'attachment',
    contentType: 'application/zip',
    xContentTypeOptions: 'nosniff',
    observedAt: canonicalInstant(item.observedAt, `${label} observedAt`),
  };
}

function parseBridgeDeploymentEvidence(value: unknown): MediaWriteBridgeDeploymentEvidenceV1 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'status', 'runId', 'bridgeCandidate', 'runtimeContract',
    'production', 'canonicalBucketProvisioningEvidenceSha256', 'authorizationSha256', 'upload',
    'deployment', 'signerFree', 'r2SigningTokenId', 'observedAt',
  ], 'Media write bridge deployment evidence');
  if (item.kind !== 'candidary.media-write-bridge-deployment-evidence'
    || item.schemaVersion !== 1
    || item.status !== 'passed') {
    throw new Error('Media write bridge deployment evidence identity or status is invalid.');
  }
  const candidate = exactRecord(item.bridgeCandidate, [
    'sha', 'approvedMainSha', 'manifestSha256', 'artifactTreeSha256', 'migrationCount',
  ], 'Bridge deployment candidate');
  if (candidate.migrationCount !== 14) {
    throw new Error('Bridge deployment evidence must bind exactly 14 migrations.');
  }
  const runtime = exactRecord(item.runtimeContract, [
    'sha256', 'kind', 'schemaVersion', 'mode', 'capabilities',
  ], 'Bridge deployment runtime contract');
  const parsedRuntime = parseMediaWriteBridgeRuntimeContract({
    kind: runtime.kind,
    schemaVersion: runtime.schemaVersion,
    mode: runtime.mode,
    capabilities: runtime.capabilities,
  });
  const production = exactRecord(
    item.production,
    ['accountId', 'workerName', 'topologySha256'],
    'Bridge deployment production identity',
  );
  if (production.workerName !== 'candidary') {
    throw new Error('Bridge deployment production worker is invalid.');
  }
  const upload = exactRecord(item.upload, [
    'versionId', 'tagSha', 'uploadMessageSha256', 'trafficPercent', 'providerScriptEtag',
    'localWorkerSha256', 'bindingsSha256', 'runtimeSha256', 'observedAt',
  ], 'Bridge immutable version observation');
  if (upload.trafficPercent !== 0 && upload.trafficPercent !== 100) {
    throw new Error('Bridge upload evidence must observe the exact immutable version at zero or full traffic.');
  }
  const deployment = exactRecord(
    item.deployment,
    ['versionId', 'tagSha', 'trafficPercent', 'disposition'],
    'Bridge deployment observation',
  );
  const signerFree = exactRecord(
    item.signerFree,
    ['artifactScan', 'exportDownloadCanary'],
    'Bridge signer-free runtime evidence',
  );
  const artifactScan = exactRecord(
    signerFree.artifactScan,
    ['xAmzUrlCount', 'r2SignerReferenceCount'],
    'Bridge signer-free artifact scan',
  );
  const exportCanary = parseAuthenticatedExportDownloadCanary(
    signerFree.exportDownloadCanary,
    'Bridge authenticated export download canary',
  );
  if (artifactScan.xAmzUrlCount !== 0 || artifactScan.r2SignerReferenceCount !== 0
  ) {
    throw new Error('Bridge deployment evidence does not prove a signer-free export runtime.');
  }
  if (deployment.trafficPercent !== 100) {
    throw new Error('Bridge deployment evidence must observe exactly 100 percent traffic.');
  }
  const candidateSha = patternString(candidate.sha, SHA_PATTERN, 'Bridge evidence SHA');
  const approvedMainSha = patternString(
    candidate.approvedMainSha,
    SHA_PATTERN,
    'Bridge evidence approvedMainSha',
  );
  const runtimeSha256 = patternString(
    runtime.sha256,
    SHA256_PATTERN,
    'Bridge evidence runtime contract SHA-256',
  );
  const tagSha = patternString(deployment.tagSha, SHA_PATTERN, 'Bridge version tag');
  const uploadTagSha = patternString(upload.tagSha, SHA_PATTERN, 'Bridge upload version tag');
  const uploadVersionId = patternString(upload.versionId, UUID_PATTERN, 'Bridge upload versionId');
  const deploymentVersionId = patternString(
    deployment.versionId,
    UUID_PATTERN,
    'Bridge versionId',
  );
  const expectedRuntimeSha256 = sha256(`${canonicalJson(parsedRuntime)}\n`);
  const runId = patternString(item.runId, UUID_PATTERN, 'Bridge evidence runId');
  const manifestSha256 = patternString(
    candidate.manifestSha256,
    SHA256_PATTERN,
    'Bridge evidence manifest SHA-256',
  );
  const artifactTreeSha256 = patternString(
    candidate.artifactTreeSha256,
    SHA256_PATTERN,
    'Bridge evidence artifact tree SHA-256',
  );
  const uploadMessageSha256 = patternString(
    upload.uploadMessageSha256,
    SHA256_PATTERN,
    'Bridge upload message SHA-256',
  );
  const providerScriptEtag = patternString(
    upload.providerScriptEtag,
    SHA256_PATTERN,
    'Bridge provider script ETag',
  );
  const localWorkerSha256 = patternString(
    upload.localWorkerSha256,
    SHA256_PATTERN,
    'Bridge local worker SHA-256',
  );
  if (approvedMainSha !== BRIDGE_SOURCE_MAIN_SHA || tagSha !== candidateSha
    || uploadTagSha !== candidateSha || uploadVersionId !== deploymentVersionId
    || (deployment.disposition !== 'deployed' && deployment.disposition !== 'adopted')
    || uploadMessageSha256 !== sha256(
      `candidary-bridge:${runId}:${manifestSha256}:${artifactTreeSha256}`,
    )) {
    throw new Error('Bridge deployment evidence candidate and version tag are inconsistent.');
  }
  if (runtimeSha256 !== expectedRuntimeSha256) {
    throw new Error('Bridge deployment evidence runtime contract digest is inconsistent.');
  }
  const observedAt = canonicalInstant(item.observedAt, 'Bridge observedAt');
  const uploadObservedAt = canonicalInstant(upload.observedAt, 'Bridge upload observedAt');
  if (uploadObservedAt > exportCanary.observedAt || exportCanary.observedAt > observedAt) {
    throw new Error('Bridge export canary must be observed before bridge evidence is finalized.');
  }
  return {
    kind: 'candidary.media-write-bridge-deployment-evidence',
    schemaVersion: 1,
    status: 'passed',
    runId,
    bridgeCandidate: {
      sha: candidateSha,
      approvedMainSha,
      manifestSha256,
      artifactTreeSha256,
      migrationCount: 14,
    },
    runtimeContract: {
      ...parsedRuntime,
      sha256: runtimeSha256,
    },
    production: {
      accountId: patternString(production.accountId, ACCOUNT_ID_PATTERN, 'Bridge evidence accountId'),
      workerName: 'candidary',
      topologySha256: patternString(production.topologySha256, SHA256_PATTERN, 'Bridge evidence topology SHA-256'),
    },
    canonicalBucketProvisioningEvidenceSha256: patternString(
      item.canonicalBucketProvisioningEvidenceSha256,
      SHA256_PATTERN,
      'Bridge canonical bucket provisioning evidence SHA-256',
    ),
    authorizationSha256: patternString(item.authorizationSha256, SHA256_PATTERN, 'Bridge authorization SHA-256'),
    upload: {
      versionId: uploadVersionId,
      tagSha: uploadTagSha,
      uploadMessageSha256,
      trafficPercent: upload.trafficPercent,
      providerScriptEtag,
      localWorkerSha256,
      bindingsSha256: patternString(
        upload.bindingsSha256,
        SHA256_PATTERN,
        'Bridge remote bindings SHA-256',
      ),
      runtimeSha256: patternString(
        upload.runtimeSha256,
        SHA256_PATTERN,
        'Bridge remote runtime SHA-256',
      ),
      observedAt: uploadObservedAt,
    },
    deployment: {
      versionId: deploymentVersionId,
      tagSha,
      trafficPercent: 100,
      disposition: deployment.disposition,
    },
    signerFree: {
      artifactScan: { xAmzUrlCount: 0, r2SignerReferenceCount: 0 },
      exportDownloadCanary: exportCanary,
    },
    r2SigningTokenId: patternString(item.r2SigningTokenId, TOKEN_ID_PATTERN, 'Bridge R2 signing token ID'),
    observedAt,
  };
}

export function verifyMediaWriteBridgeDeploymentEvidence(
  path: string,
): VerifiedCanonicalArtifact<MediaWriteBridgeDeploymentEvidenceV1> {
  const input = readCanonicalInput<unknown>(path, 'Media write bridge deployment evidence');
  return { ...input, artifact: parseBridgeDeploymentEvidence(input.artifact) };
}

function parseR2SigningTokenRevocationEvidence(
  value: unknown,
): R2SigningTokenRevocationEvidenceV1 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'status', 'bridgeDeploymentEvidenceSha256',
    'canonicalBucketProvisioningEvidenceSha256', 'provider', 'accountId',
    'r2SigningTokenId', 'providerStatus', 'providerResponses', 'legacyBucketSignerProbe',
    'legacyBucketProbeAbsence', 'canonicalBucketSignerProbe',
    'canonicalPostRevocationEmpty', 'bridgeExportDownloadCanaryAfterRevocation',
    'revokedAt', 'operator',
  ], 'R2 signing token revocation evidence');
  if (item.kind !== 'candidary.r2-signing-token-revocation-evidence'
    || item.schemaVersion !== 1
    || item.status !== 'revoked'
    || item.provider !== 'cloudflare-r2') {
    throw new Error('R2 signing token revocation evidence identity, provider, or status is invalid.');
  }
  const responses = exactRecord(item.providerResponses, [
    'revocationReceiptSha256', 'statusObservationSha256',
    'legacySignedPutProbeObservationSha256',
    'legacyProbeObjectAbsenceObservationSha256',
    'canonicalSignedPutProbeObservationSha256',
    'canonicalPostRevocationEmptyObservationSha256',
    'bridgeExportDownloadCanaryAfterRevocationObservationSha256',
  ], 'R2 signing token provider responses');
  const providerStatus = exactRecord(
    item.providerStatus,
    ['tokenId', 'state', 'scope', 'permission', 'observedAt'],
    'R2 provider token status',
  );
  const tokenId = patternString(item.r2SigningTokenId, TOKEN_ID_PATTERN, 'R2 signing token ID');
  if (tokenId !== PRODUCTION_R2_SIGNING_TOKEN_ID
    || providerStatus.tokenId !== tokenId || providerStatus.state !== 'disabled'
    || providerStatus.scope !== 'all-buckets'
    || providerStatus.permission !== 'admin-read-write') {
    throw new Error('R2 provider status does not prove the exact all-bucket write token is disabled.');
  }
  const legacyProbe = exactRecord(
    item.legacyBucketSignerProbe,
    ['status', 'httpStatus', 'method', 'targetBucket', 'signingAccessKeyId', 'objectKeySha256',
      'signedWhileActiveAt', 'invokedAt', 'expiresAt'],
    'Revoked legacy-bucket signer probe',
  );
  const legacyAbsence = exactRecord(
    item.legacyBucketProbeAbsence,
    ['status', 'httpStatus', 'method', 'targetBucket', 'objectKeySha256', 'observedAt'],
    'Legacy-bucket signer probe absence observation',
  );
  const canonicalProbe = exactRecord(
    item.canonicalBucketSignerProbe,
    ['status', 'httpStatus', 'method', 'targetBucket', 'signingAccessKeyId', 'objectKeySha256',
      'signedWhileActiveAt', 'invokedAt', 'expiresAt'],
    'Canonical-bucket signer isolation probe',
  );
  if (legacyProbe.status !== 'access_denied' || legacyProbe.httpStatus !== 403
    || legacyProbe.method !== 'PUT'
    || legacyProbe.targetBucket !== 'candidary-media'
    || legacyProbe.signingAccessKeyId !== tokenId
    || legacyAbsence.status !== 'absent' || legacyAbsence.httpStatus !== 404
    || legacyAbsence.method !== 'HEAD' || legacyAbsence.targetBucket !== 'candidary-media'
    || legacyAbsence.objectKeySha256 !== legacyProbe.objectKeySha256
    || canonicalProbe.status !== 'access_denied' || canonicalProbe.httpStatus !== 403
    || canonicalProbe.method !== 'PUT'
    || canonicalProbe.targetBucket !== 'candidary-media-canonical-v2'
    || canonicalProbe.signingAccessKeyId !== tokenId) {
    throw new Error('R2 revocation probes do not prove denial and exact-key absence in both buckets.');
  }
  const empty = exactRecord(
    item.canonicalPostRevocationEmpty,
    ['operation', 'targetBucket', 'observedAt', 'truncated', 'objectCount',
      'probeObjectKeySha256'],
    'Canonical post-revocation empty-bucket observation',
  );
  if (empty.operation !== 'LIST' || empty.targetBucket !== 'candidary-media-canonical-v2'
    || empty.truncated !== false || empty.objectCount !== 0
    || empty.probeObjectKeySha256 !== canonicalProbe.objectKeySha256) {
    throw new Error('Canonical post-revocation proof must be one complete zero-object listing including the probe key.');
  }
  const revokedAt = canonicalInstant(item.revokedAt, 'R2 token revokedAt');
  const statusObservedAt = canonicalInstant(
    providerStatus.observedAt,
    'R2 provider status observedAt',
  );
  const legacySignedAt = canonicalInstant(
    legacyProbe.signedWhileActiveAt,
    'Legacy signer probe signedWhileActiveAt',
  );
  const legacyInvokedAt = canonicalInstant(legacyProbe.invokedAt, 'Legacy signer probe invokedAt');
  const legacyExpiresAt = canonicalInstant(legacyProbe.expiresAt, 'Legacy signer probe expiresAt');
  const legacyAbsentAt = canonicalInstant(legacyAbsence.observedAt, 'Legacy probe absence observedAt');
  const canonicalSignedAt = canonicalInstant(
    canonicalProbe.signedWhileActiveAt,
    'Canonical signer probe signedWhileActiveAt',
  );
  const canonicalInvokedAt = canonicalInstant(
    canonicalProbe.invokedAt,
    'Canonical signer probe invokedAt',
  );
  const canonicalExpiresAt = canonicalInstant(
    canonicalProbe.expiresAt,
    'Canonical signer probe expiresAt',
  );
  const emptyObservedAt = canonicalInstant(
    empty.observedAt,
    'Canonical post-revocation empty observedAt',
  );
  const postRevocationExportCanary = parseAuthenticatedExportDownloadCanary(
    item.bridgeExportDownloadCanaryAfterRevocation,
    'Post-revocation bridge export download canary',
  );
  if (legacyProbe.objectKeySha256 === canonicalProbe.objectKeySha256
    || legacySignedAt >= revokedAt || canonicalSignedAt >= revokedAt
    || revokedAt > statusObservedAt
    || statusObservedAt > legacyInvokedAt || statusObservedAt > canonicalInvokedAt
    || legacyInvokedAt >= legacyExpiresAt || canonicalInvokedAt >= canonicalExpiresAt
    || legacyInvokedAt > legacyAbsentAt || canonicalInvokedAt > emptyObservedAt
    || revokedAt > postRevocationExportCanary.observedAt) {
    throw new Error('R2 provider status, legacy revocation probe, or canonical isolation proof is out of order.');
  }
  return {
    kind: 'candidary.r2-signing-token-revocation-evidence',
    schemaVersion: 1,
    status: 'revoked',
    bridgeDeploymentEvidenceSha256: patternString(
      item.bridgeDeploymentEvidenceSha256,
      SHA256_PATTERN,
      'Bridge deployment evidence SHA-256',
    ),
    canonicalBucketProvisioningEvidenceSha256: patternString(
      item.canonicalBucketProvisioningEvidenceSha256,
      SHA256_PATTERN,
      'Canonical bucket provisioning evidence SHA-256',
    ),
    provider: 'cloudflare-r2',
    accountId: patternString(item.accountId, ACCOUNT_ID_PATTERN, 'R2 revocation accountId'),
    r2SigningTokenId: tokenId,
    providerStatus: {
      tokenId,
      state: 'disabled',
      scope: 'all-buckets',
      permission: 'admin-read-write',
      observedAt: statusObservedAt,
    },
    providerResponses: {
      revocationReceiptSha256: patternString(
        responses.revocationReceiptSha256,
        SHA256_PATTERN,
        'R2 revocation receipt SHA-256',
      ),
      statusObservationSha256: patternString(
        responses.statusObservationSha256,
        SHA256_PATTERN,
        'R2 revocation status observation SHA-256',
      ),
      legacySignedPutProbeObservationSha256: patternString(
        responses.legacySignedPutProbeObservationSha256,
        SHA256_PATTERN,
        'Legacy signed PUT probe observation SHA-256',
      ),
      legacyProbeObjectAbsenceObservationSha256: patternString(
        responses.legacyProbeObjectAbsenceObservationSha256,
        SHA256_PATTERN,
        'Legacy probe object absence observation SHA-256',
      ),
      canonicalSignedPutProbeObservationSha256: patternString(
        responses.canonicalSignedPutProbeObservationSha256,
        SHA256_PATTERN,
        'Canonical signed PUT probe observation SHA-256',
      ),
      canonicalPostRevocationEmptyObservationSha256: patternString(
        responses.canonicalPostRevocationEmptyObservationSha256,
        SHA256_PATTERN,
        'Canonical post-revocation empty observation SHA-256',
      ),
      bridgeExportDownloadCanaryAfterRevocationObservationSha256: patternString(
        responses.bridgeExportDownloadCanaryAfterRevocationObservationSha256,
        SHA256_PATTERN,
        'Post-revocation bridge export download canary observation SHA-256',
      ),
    },
    legacyBucketSignerProbe: {
      status: 'access_denied',
      httpStatus: 403,
      method: 'PUT',
      targetBucket: 'candidary-media',
      signingAccessKeyId: patternString(
        legacyProbe.signingAccessKeyId,
        TOKEN_ID_PATTERN,
        'Legacy signer probe access key ID',
      ),
      objectKeySha256: patternString(
        legacyProbe.objectKeySha256,
        SHA256_PATTERN,
        'Legacy signer probe object key SHA-256',
      ),
      signedWhileActiveAt: legacySignedAt,
      invokedAt: legacyInvokedAt,
      expiresAt: legacyExpiresAt,
    },
    legacyBucketProbeAbsence: {
      status: 'absent',
      httpStatus: 404,
      method: 'HEAD',
      targetBucket: 'candidary-media',
      objectKeySha256: patternString(
        legacyAbsence.objectKeySha256,
        SHA256_PATTERN,
        'Legacy probe absence object key SHA-256',
      ),
      observedAt: legacyAbsentAt,
    },
    canonicalBucketSignerProbe: {
      status: 'access_denied',
      httpStatus: 403,
      method: 'PUT',
      targetBucket: 'candidary-media-canonical-v2',
      signingAccessKeyId: patternString(
        canonicalProbe.signingAccessKeyId,
        TOKEN_ID_PATTERN,
        'Canonical signer probe access key ID',
      ),
      objectKeySha256: patternString(
        canonicalProbe.objectKeySha256,
        SHA256_PATTERN,
        'Canonical signer probe object key SHA-256',
      ),
      signedWhileActiveAt: canonicalSignedAt,
      invokedAt: canonicalInvokedAt,
      expiresAt: canonicalExpiresAt,
    },
    canonicalPostRevocationEmpty: {
      operation: 'LIST',
      targetBucket: 'candidary-media-canonical-v2',
      observedAt: emptyObservedAt,
      truncated: false,
      objectCount: 0,
      probeObjectKeySha256: patternString(
        empty.probeObjectKeySha256,
        SHA256_PATTERN,
        'Canonical empty observation probe key SHA-256',
      ),
    },
    bridgeExportDownloadCanaryAfterRevocation: postRevocationExportCanary,
    revokedAt,
    operator: patternString(item.operator, OWNER_PATTERN, 'R2 revocation operator'),
  };
}

export function verifyR2SigningTokenRevocationEvidence(
  path: string,
): VerifiedCanonicalArtifact<R2SigningTokenRevocationEvidenceV1> {
  const input = readCanonicalInput<unknown>(path, 'R2 signing token revocation evidence');
  return { ...input, artifact: parseR2SigningTokenRevocationEvidence(input.artifact) };
}

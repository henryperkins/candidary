import { lstatSync, readFileSync } from 'node:fs';
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
export const LEGACY_MEDIA_BINDING = 'MEDIA_BUCKET' as const;
export const LEGACY_MEDIA_BUCKET_NAME = 'candidary-media' as const;
export const CANONICAL_MEDIA_BINDING = 'CANONICAL_MEDIA_BUCKET' as const;
export const CANONICAL_MEDIA_BUCKET_NAME = 'candidary-media-canonical-v2' as const;
export const LEGACY_MEDIA_SCANNER_CONFIG_PATH = 'config/legacy-media-scanner.json';

export const CUTOVER_DISABLED_CAPABILITIES = {
  singleInitiationPresign: false,
  batchInitiationPresign: false,
  storedReplayPresign: false,
  reservedFinalize: false,
  exportDownloadPresign: false,
  authenticatedWorkerIngress: false,
  legacyPromotion: false,
  eventRelationalPurge: false,
} as const;

export const BRIDGE_DISABLED_CAPABILITIES = { ...CUTOVER_DISABLED_CAPABILITIES } as const;

export const CANONICAL_LIVE_CAPABILITIES = {
  singleInitiationPresign: false,
  batchInitiationPresign: false,
  storedReplayPresign: false,
  reservedFinalize: false,
  exportDownloadPresign: false,
  authenticatedWorkerIngress: true,
  legacyPromotion: true,
  eventRelationalPurge: true,
} as const;

const CAPABILITY_NAMES = Object.keys(CUTOVER_DISABLED_CAPABILITIES);

export const LEGACY_MEDIA_SCANNER_CONTRACT = {
  kind: 'candidary.legacy-media-scanner',
  schemaVersion: 1,
  enabled: true,
  bucketGeneration: 'legacy',
  binding: LEGACY_MEDIA_BINDING,
  prefix: 'events/',
  namespaces: {
    guestMedia: {
      segments: ['uploads', 'media', 'previews'],
      unowned: 'suppress-before-cursor',
    },
    exports: {
      segment: 'exports',
      owned: [
        'queued-current-attempt',
        'running-current-attempt',
        'ready-unexpired-exact-inventory',
      ],
      unowned: 'suppress-before-cursor',
    },
    cover: {
      segment: 'cover',
      liveEvent: 'preserve-whole-namespace',
      absentOrDeletedEvent: 'suppress-before-cursor',
    },
  },
  retention: {
    tombstones: 'permanent',
    completedEpoch: 'wrap',
    absence: 'telemetry-only',
    cursorAdvance: 'after-durable-inventory',
    errors: 'rotate-without-retirement',
    runtimeModes: ['canonical-cutover-disabled', 'canonical-live'],
  },
} as const;

export type LegacyMediaScannerContractV1 = typeof LEGACY_MEDIA_SCANNER_CONTRACT;

export interface CanonicalCutoverDisabledRuntimeContractV2 {
  kind: 'candidary.media-upload-release';
  schemaVersion: 2;
  mode: 'canonical-cutover-disabled';
  capabilities: typeof CUTOVER_DISABLED_CAPABILITIES;
}

export interface MediaWriteBridgeRuntimeContractV1 {
  kind: 'candidary.media-upload-release';
  schemaVersion: 1;
  mode: 'bridge-disabled';
  capabilities: typeof BRIDGE_DISABLED_CAPABILITIES;
}

export interface CanonicalLiveRuntimeContractV2 {
  kind: 'candidary.media-upload-release';
  schemaVersion: 2;
  mode: 'canonical-live';
  capabilities: typeof CANONICAL_LIVE_CAPABILITIES;
}

export type MediaUploadReleaseContractV2 =
  | CanonicalCutoverDisabledRuntimeContractV2
  | CanonicalLiveRuntimeContractV2;

export interface CanonicalMediaBucketProvisioningEvidenceV1 {
  kind: 'candidary.canonical-media-bucket-provisioning-evidence';
  schemaVersion: 1;
  status: 'ready';
  runId: string;
  provider: 'cloudflare-r2';
  accountId: string;
  legacyBucket: {
    binding: typeof LEGACY_MEDIA_BINDING;
    bucketName: typeof LEGACY_MEDIA_BUCKET_NAME;
    r2SigningTokenId: string;
  };
  canonicalBucket: {
    binding: typeof CANONICAL_MEDIA_BINDING;
    bucketName: typeof CANONICAL_MEDIA_BUCKET_NAME;
  };
  providerResponses: {
    bucketCreateReceiptSha256: string;
    bucketStatusObservationSha256: string;
    corsPolicyObservationSha256: string;
    publicAccessObservationSha256: string;
    initialEmptyBucketObservationSha256: string;
  };
  canonicalAccess: {
    publicAccess: 'disabled';
    developmentUrl: 'disabled';
    cors: 'none';
  };
  createdAt: string;
  observedAt: string;
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

export function readCanonicalCutoverInput<T>(
  path: string,
  label: string,
): VerifiedCanonicalArtifact<T> {
  const inputPath = exactRegularFile(path, label);
  const bytes = readFileSync(inputPath, 'utf8');
  const digest = sha256(bytes);
  const sidecar = readFileSync(
    exactRegularFile(`${inputPath}.sha256`, `${label} sidecar`),
    'utf8',
  );
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

export function parseMediaUploadReleaseContract(value: unknown): MediaUploadReleaseContractV2 {
  const item = exactRecord(
    value,
    ['kind', 'schemaVersion', 'mode', 'capabilities'],
    'Media upload release contract',
  );
  if (item.kind !== 'candidary.media-upload-release' || item.schemaVersion !== 2
    || (item.mode !== 'canonical-cutover-disabled' && item.mode !== 'canonical-live')) {
    throw new Error('Media upload release contract identity, schema, or mode is invalid.');
  }
  const capabilities = exactRecord(
    item.capabilities,
    CAPABILITY_NAMES,
    'Media upload release capabilities',
  );
  const expected = item.mode === 'canonical-cutover-disabled'
    ? CUTOVER_DISABLED_CAPABILITIES
    : CANONICAL_LIVE_CAPABILITIES;
  for (const [name, required] of Object.entries(expected)) {
    if (capabilities[name] !== required) {
      throw new Error(`Media upload release capability ${name} is invalid for ${item.mode}.`);
    }
  }
  return item.mode === 'canonical-cutover-disabled'
    ? {
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-cutover-disabled',
      capabilities: { ...CUTOVER_DISABLED_CAPABILITIES },
    }
    : {
      kind: 'candidary.media-upload-release',
      schemaVersion: 2,
      mode: 'canonical-live',
      capabilities: { ...CANONICAL_LIVE_CAPABILITIES },
    };
}

export function parseMediaWriteBridgeRuntimeContract(
  value: unknown,
): MediaWriteBridgeRuntimeContractV1 {
  const item = exactRecord(
    value,
    ['kind', 'schemaVersion', 'mode', 'capabilities'],
    'Media write bridge runtime contract',
  );
  if (item.kind !== 'candidary.media-upload-release'
    || item.schemaVersion !== 1 || item.mode !== 'bridge-disabled') {
    throw new Error('Media write bridge runtime contract identity, schema, or mode is invalid.');
  }
  const capabilities = exactRecord(
    item.capabilities,
    CAPABILITY_NAMES,
    'Media write bridge capabilities',
  );
  for (const name of CAPABILITY_NAMES) {
    if (capabilities[name] !== false) {
      throw new Error(`Media write bridge capability ${name} must be false.`);
    }
  }
  return {
    kind: 'candidary.media-upload-release',
    schemaVersion: 1,
    mode: 'bridge-disabled',
    capabilities: { ...BRIDGE_DISABLED_CAPABILITIES },
  };
}

export function verifyMediaWriteBridgeRuntimeContract(
  path: string,
): VerifiedCanonicalArtifact<MediaWriteBridgeRuntimeContractV1> {
  const inputPath = exactRegularFile(path, 'Media write bridge runtime contract');
  const bytes = readFileSync(inputPath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error('Media write bridge runtime contract is not valid JSON.', { cause: error });
  }
  if (bytes !== `${canonicalJson(value)}\n`) {
    throw new Error('Media write bridge runtime contract JSON is not canonical.');
  }
  return {
    artifact: parseMediaWriteBridgeRuntimeContract(value),
    path: inputPath,
    sha256: sha256(bytes),
  };
}

export function verifyMediaUploadReleaseContract(
  path: string,
  expectedMode?: MediaUploadReleaseContractV2['mode'],
): VerifiedCanonicalArtifact<MediaUploadReleaseContractV2> {
  const inputPath = exactRegularFile(path, 'Media upload release contract');
  const bytes = readFileSync(inputPath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch (error) {
    throw new Error('Media upload release contract is not valid JSON.', { cause: error });
  }
  if (bytes !== `${canonicalJson(value)}\n`) {
    throw new Error('Media upload release contract JSON is not canonical.');
  }
  const artifact = parseMediaUploadReleaseContract(value);
  if (expectedMode !== undefined && artifact.mode !== expectedMode) {
    throw new Error(`Media upload release contract must be ${expectedMode}.`);
  }
  return { artifact, path: inputPath, sha256: sha256(bytes) };
}

export function verifyLegacyMediaScannerContract(
  path: string,
): VerifiedCanonicalArtifact<LegacyMediaScannerContractV1> {
  const input = readCanonicalCutoverInput<unknown>(path, 'Legacy media scanner contract');
  if (canonicalJson(input.artifact) !== canonicalJson(LEGACY_MEDIA_SCANNER_CONTRACT)) {
    throw new Error('Legacy media scanner contract does not match the exact permanent scanner invariants.');
  }
  return { ...input, artifact: LEGACY_MEDIA_SCANNER_CONTRACT };
}

function parseCanonicalMediaBucketProvisioningEvidence(
  value: unknown,
): CanonicalMediaBucketProvisioningEvidenceV1 {
  const item = exactRecord(value, [
    'kind', 'schemaVersion', 'status', 'runId', 'provider', 'accountId',
    'legacyBucket', 'canonicalBucket', 'providerResponses', 'canonicalAccess',
    'createdAt', 'observedAt', 'operator',
  ], 'Canonical media bucket provisioning evidence');
  if (item.kind !== 'candidary.canonical-media-bucket-provisioning-evidence'
    || item.schemaVersion !== 1 || item.status !== 'ready' || item.provider !== 'cloudflare-r2') {
    throw new Error('Canonical media bucket provisioning evidence identity or status is invalid.');
  }
  const legacy = exactRecord(
    item.legacyBucket,
    ['binding', 'bucketName', 'r2SigningTokenId'],
    'Legacy media bucket identity',
  );
  const canonical = exactRecord(
    item.canonicalBucket,
    ['binding', 'bucketName'],
    'Canonical media bucket identity',
  );
  if (legacy.binding !== LEGACY_MEDIA_BINDING || legacy.bucketName !== LEGACY_MEDIA_BUCKET_NAME
    || canonical.binding !== CANONICAL_MEDIA_BINDING
    || canonical.bucketName !== CANONICAL_MEDIA_BUCKET_NAME) {
    throw new Error('Canonical media bucket evidence does not bind the isolated bucket generation.');
  }
  const responses = exactRecord(item.providerResponses, [
    'bucketCreateReceiptSha256', 'bucketStatusObservationSha256',
    'corsPolicyObservationSha256', 'publicAccessObservationSha256',
    'initialEmptyBucketObservationSha256',
  ], 'Canonical bucket provider responses');
  const access = exactRecord(
    item.canonicalAccess,
    ['publicAccess', 'developmentUrl', 'cors'],
    'Canonical bucket access policy',
  );
  if (access.publicAccess !== 'disabled' || access.developmentUrl !== 'disabled'
    || access.cors !== 'none') {
    throw new Error('Canonical media bucket must have no public access, development URL, or CORS policy.');
  }
  const createdAt = canonicalInstant(item.createdAt, 'Canonical bucket createdAt');
  const observedAt = canonicalInstant(item.observedAt, 'Canonical bucket observedAt');
  if (createdAt > observedAt) {
    throw new Error('Canonical bucket provisioning evidence timing is invalid.');
  }
  const responseSha = (name: string) => patternString(
    responses[name],
    SHA256_PATTERN,
    `Canonical bucket ${name}`,
  );
  return {
    kind: 'candidary.canonical-media-bucket-provisioning-evidence',
    schemaVersion: 1,
    status: 'ready',
    runId: patternString(item.runId, UUID_PATTERN, 'Canonical bucket runId'),
    provider: 'cloudflare-r2',
    accountId: patternString(item.accountId, ACCOUNT_ID_PATTERN, 'Canonical bucket accountId'),
    legacyBucket: {
      binding: LEGACY_MEDIA_BINDING,
      bucketName: LEGACY_MEDIA_BUCKET_NAME,
      r2SigningTokenId: patternString(
        legacy.r2SigningTokenId,
        TOKEN_ID_PATTERN,
        'Legacy R2 signing token ID',
      ),
    },
    canonicalBucket: {
      binding: CANONICAL_MEDIA_BINDING,
      bucketName: CANONICAL_MEDIA_BUCKET_NAME,
    },
    providerResponses: {
      bucketCreateReceiptSha256: responseSha('bucketCreateReceiptSha256'),
      bucketStatusObservationSha256: responseSha('bucketStatusObservationSha256'),
      corsPolicyObservationSha256: responseSha('corsPolicyObservationSha256'),
      publicAccessObservationSha256: responseSha('publicAccessObservationSha256'),
      initialEmptyBucketObservationSha256: responseSha('initialEmptyBucketObservationSha256'),
    },
    canonicalAccess: {
      publicAccess: 'disabled',
      developmentUrl: 'disabled',
      cors: 'none',
    },
    createdAt,
    observedAt,
    operator: patternString(item.operator, OWNER_PATTERN, 'Canonical bucket operator'),
  };
}

export function verifyCanonicalMediaBucketProvisioningEvidence(
  path: string,
): VerifiedCanonicalArtifact<CanonicalMediaBucketProvisioningEvidenceV1> {
  const input = readCanonicalCutoverInput<unknown>(
    path,
    'Canonical media bucket provisioning evidence',
  );
  return {
    ...input,
    artifact: parseCanonicalMediaBucketProvisioningEvidence(input.artifact),
  };
}

export const cutoverPatterns = {
  sha: SHA_PATTERN,
  sha256: SHA256_PATTERN,
  uuid: UUID_PATTERN,
  accountId: ACCOUNT_ID_PATTERN,
  tokenId: TOKEN_ID_PATTERN,
  owner: OWNER_PATTERN,
  instant: ISO_PATTERN,
} as const;

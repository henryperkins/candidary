import releaseConfig from '../config/release.json';

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!isPositiveSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

assertPositiveSafeInteger(releaseConfig.evidenceSchemaVersion, 'evidenceSchemaVersion');
assertPositiveSafeInteger(releaseConfig.guestJourneyVersion, 'guestJourneyVersion');

export const RELEASE_EVIDENCE_SCHEMA_VERSION: number = releaseConfig.evidenceSchemaVersion;
export const GUEST_JOURNEY_VERSION: number = releaseConfig.guestJourneyVersion;

export interface RuntimeReleaseIdentity {
  buildSha: string;
  workerVersionId: string;
  guestJourneyVersion: number;
  migrationManifestSha256: string;
}

export type PhysicalEvidenceCategory =
  | 'printed-entry-ios'
  | 'printed-entry-android'
  | 'server-time-lifecycle'
  | 'guest-session-rotation'
  | 'household-rsvp'
  | 'native-picker-ios'
  | 'private-delivery'
  | 'degraded-network-recovery'
  | 'gallery-export-recovery'
  | 'load-scale'
  | 'printed-entry-disable-recovery'
  | 'voiceover'
  | 'talkback';

export interface PhysicalEvidenceReference {
  category: PhysicalEvidenceCategory;
  evidenceId: string;
  manifestSha256: string;
  capturedAt: string;
}

export interface ReleaseCertification extends RuntimeReleaseIdentity {
  evidenceManifestSha256: string;
  physicalEvidenceRefs: PhysicalEvidenceReference[];
  certifiedAt: string;
}

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UTC_ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const PHYSICAL_EVIDENCE_CATEGORIES: ReadonlySet<string> = new Set([
  'printed-entry-ios',
  'printed-entry-android',
  'server-time-lifecycle',
  'guest-session-rotation',
  'household-rsvp',
  'native-picker-ios',
  'private-delivery',
  'degraded-network-recovery',
  'gallery-export-recovery',
  'load-scale',
  'printed-entry-disable-recovery',
  'voiceover',
  'talkback',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isWorkerVersionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value;
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && GIT_SHA_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isUtcIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_ISO_INSTANT_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isPhysicalEvidenceCategory(value: unknown): value is PhysicalEvidenceCategory {
  return typeof value === 'string' && PHYSICAL_EVIDENCE_CATEGORIES.has(value);
}

function parsePhysicalEvidenceReference(input: unknown): PhysicalEvidenceReference | null {
  if (!isRecord(input) || !hasExactKeys(input, [
    'category',
    'evidenceId',
    'manifestSha256',
    'capturedAt',
  ])) return null;

  if (!isPhysicalEvidenceCategory(input.category)
    || typeof input.evidenceId !== 'string'
    || !UUID_PATTERN.test(input.evidenceId)
    || !isSha256(input.manifestSha256)
    || !isUtcIsoInstant(input.capturedAt)) return null;

  return {
    category: input.category,
    evidenceId: input.evidenceId,
    manifestSha256: input.manifestSha256,
    capturedAt: input.capturedAt,
  };
}

export function parseRuntimeReleaseIdentity(input: {
  buildSha?: unknown;
  workerVersionId?: unknown;
  workerVersionTag?: unknown;
  migrationManifestSha256?: unknown;
}): RuntimeReleaseIdentity | null {
  if (!hasExactKeys(input, [
    'buildSha',
    'workerVersionId',
    'workerVersionTag',
    'migrationManifestSha256',
  ])) return null;

  if (!isGitSha(input.buildSha)
    || !isWorkerVersionId(input.workerVersionId)
    || input.workerVersionTag !== input.buildSha
    || !isSha256(input.migrationManifestSha256)) return null;

  return {
    buildSha: input.buildSha,
    workerVersionId: input.workerVersionId,
    guestJourneyVersion: GUEST_JOURNEY_VERSION,
    migrationManifestSha256: input.migrationManifestSha256,
  };
}

export function parseReleaseCertification(input: unknown): ReleaseCertification | null {
  if (!isRecord(input) || !hasExactKeys(input, [
    'buildSha',
    'workerVersionId',
    'guestJourneyVersion',
    'migrationManifestSha256',
    'evidenceManifestSha256',
    'physicalEvidenceRefs',
    'certifiedAt',
  ])) return null;

  if (!isGitSha(input.buildSha)
    || !isWorkerVersionId(input.workerVersionId)
    || !isPositiveSafeInteger(input.guestJourneyVersion)
    || !isSha256(input.migrationManifestSha256)
    || !isSha256(input.evidenceManifestSha256)
    || !Array.isArray(input.physicalEvidenceRefs)
    || input.physicalEvidenceRefs.length === 0
    || !isUtcIsoInstant(input.certifiedAt)) return null;

  const physicalEvidenceRefs: PhysicalEvidenceReference[] = [];
  const categories = new Set<PhysicalEvidenceCategory>();
  for (const candidate of input.physicalEvidenceRefs) {
    const reference = parsePhysicalEvidenceReference(candidate);
    if (!reference || categories.has(reference.category)) return null;
    categories.add(reference.category);
    physicalEvidenceRefs.push(reference);
  }

  return {
    buildSha: input.buildSha,
    workerVersionId: input.workerVersionId,
    guestJourneyVersion: input.guestJourneyVersion,
    migrationManifestSha256: input.migrationManifestSha256,
    evidenceManifestSha256: input.evidenceManifestSha256,
    physicalEvidenceRefs,
    certifiedAt: input.certifiedAt,
  };
}

export function releaseCertificationMatches(
  identity: RuntimeReleaseIdentity | null,
  certification: ReleaseCertification | null,
): boolean {
  return identity !== null
    && certification !== null
    && identity.buildSha === certification.buildSha
    && identity.workerVersionId === certification.workerVersionId
    && identity.guestJourneyVersion === certification.guestJourneyVersion
    && identity.migrationManifestSha256 === certification.migrationManifestSha256;
}

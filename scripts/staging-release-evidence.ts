import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256 } from './release-evidence.ts';
import { PHASE_2_MIGRATION, PHASE_3_MIGRATION } from './release-candidate.ts';
import {
  POST_CUTOVER_PRODUCTION_TRIGGER_NAMES,
  PRODUCTION_TRIGGER_NAMES,
} from './migrate-release.ts';
import {
  RUN_ID_PATTERN,
  SHA256_PATTERN,
  assertCandidateSha,
  assertCanonicalRunId,
  assertSanitizedValue,
  parseMode,
  type CleanupObservation,
  type PhaseReceipt,
} from './staging-release-contract.ts';

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function assertPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unknown or missing field.`);
  }
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertRecordedAt(value: unknown): string {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)
    || new Date(value).toISOString() !== value) {
    throw new Error('Receipt recordedAt must be one canonical UTC instant.');
  }
  return value;
}

function within(container: string, target: string): boolean {
  const candidate = relative(container, target);
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

export function task11Root(projectRoot: string, candidateSha: string, runId: string): string {
  const root = resolve(projectRoot);
  const target = resolve(
    root,
    'output',
    'operations',
    'event-cover',
    assertCandidateSha(candidateSha),
    'task-11',
    assertCanonicalRunId(runId),
  );
  if (!within(root, target)) throw new Error('Task 11 evidence root escapes the project root.');
  return target;
}

export interface MakePhaseReceiptInput<Result> {
  readonly phase: PhaseReceipt<Result>['phase'];
  readonly candidateSha: string;
  readonly runId: string;
  readonly predecessorSha256: string | null;
  readonly recordedAt: string;
  readonly result: Result;
}

export function makePhaseReceipt<Result>(input: MakePhaseReceiptInput<Result>): PhaseReceipt<Result> {
  const receipt: PhaseReceipt<Result> = {
    schemaVersion: 1,
    phase: parseMode(input.phase),
    candidateSha: assertCandidateSha(input.candidateSha),
    runId: assertCanonicalRunId(input.runId),
    predecessorSha256: input.predecessorSha256 === null
      ? null
      : assertSha256(input.predecessorSha256, 'Receipt predecessor'),
    recordedAt: assertRecordedAt(input.recordedAt),
    result: input.result,
  };
  assertSanitizedValue(receipt);
  return receipt;
}

export interface VerifiedReceipt<Result = unknown> {
  readonly receipt: PhaseReceipt<Result>;
  readonly sha256: string;
}

export function verifyReceipt<Result>(
  value: unknown,
  expectedPredecessorSha256: string | null,
): VerifiedReceipt<Result> {
  const record = assertPlainRecord(value, 'Phase receipt');
  assertExactKeys(record, [
    'schemaVersion',
    'phase',
    'candidateSha',
    'runId',
    'predecessorSha256',
    'recordedAt',
    'result',
  ], 'Phase receipt');
  if (record.schemaVersion !== 1) throw new Error('Phase receipt schemaVersion must be 1.');
  const receipt = makePhaseReceipt({
    phase: parseMode(record.phase),
    candidateSha: assertCandidateSha(record.candidateSha),
    runId: assertCanonicalRunId(record.runId),
    predecessorSha256: record.predecessorSha256 === null
      ? null
      : assertSha256(record.predecessorSha256, 'Receipt predecessor'),
    recordedAt: assertRecordedAt(record.recordedAt),
    result: record.result as Result,
  });
  if (receipt.predecessorSha256 !== expectedPredecessorSha256) {
    throw new Error('Phase receipt predecessor digest does not match.');
  }
  const bytes = `${canonicalJson(receipt)}\n`;
  return { receipt, sha256: sha256(bytes) };
}

function sidecarBytes(path: string, digest: string): string {
  return `${digest}  ${basename(path)}\n`;
}

function assertDestinationsAbsent(path: string): void {
  if (existsSync(path) || existsSync(`${path}.sha256`)) {
    throw new Error(`Evidence destination already exists: ${path}`);
  }
}

export function writeExclusiveCanonical(path: string, value: unknown): string {
  assertSanitizedValue(value);
  assertDestinationsAbsent(path);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${canonicalJson(value)}\n`;
  const digest = sha256(bytes);
  writeFileSync(path, bytes, { encoding: 'utf8', flag: 'wx' });
  try {
    writeFileSync(`${path}.sha256`, sidecarBytes(path, digest), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  return digest;
}

export interface WrittenEvidence {
  readonly path: string;
  readonly sha256: string;
}

export function writePhaseReceipt<Result>(
  runRoot: string,
  sequence: number,
  receipt: PhaseReceipt<Result>,
): WrittenEvidence {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 99) {
    throw new Error('Phase receipt sequence must be an integer from 1 through 99.');
  }
  verifyReceipt(receipt, receipt.predecessorSha256);
  const path = resolve(runRoot, `${String(sequence).padStart(2, '0')}-${receipt.phase}.json`);
  if (!within(resolve(runRoot), path)) throw new Error('Phase receipt path escapes the run root.');
  return { path, sha256: writeExclusiveCanonical(path, receipt) };
}

function parseSidecar(path: string, bytes: string): string {
  const match = /^([0-9a-f]{64}) {2}([^\r\n]+)\r?\n$/u.exec(bytes);
  if (!match || match[2] !== basename(path)) {
    throw new Error('Evidence sidecar has an invalid format or filename.');
  }
  return match[1]!;
}

export function verifyReceiptFile<Result>(
  path: string,
  expectedPredecessorSha256: string | null,
): VerifiedReceipt<Result> {
  const bytes = readFileSync(path, 'utf8');
  const sidecarDigest = parseSidecar(path, readFileSync(`${path}.sha256`, 'utf8'));
  if (sha256(bytes) !== sidecarDigest) throw new Error('Phase receipt sidecar digest does not match.');
  const parsed = JSON.parse(bytes) as unknown;
  const verified = verifyReceipt<Result>(parsed, expectedPredecessorSha256);
  if (verified.sha256 !== sidecarDigest) {
    throw new Error('Phase receipt canonical bytes do not match the sidecar.');
  }
  return verified;
}

const CLEANUP_FIELDS = [
  'fixturesAbsent',
  'workerAbsent',
  'databaseAbsent',
  'bucketAbsent',
  'workflowsAbsent',
  'callersAbsent',
  'probeAbsent',
] as const satisfies readonly (keyof CleanupObservation)[];

export function assertCompleteCleanup(value: unknown): CleanupObservation {
  const record = assertPlainRecord(value, 'Cleanup observation');
  assertExactKeys(record, CLEANUP_FIELDS, 'Cleanup observation');
  for (const field of CLEANUP_FIELDS) {
    if (record[field] !== true) throw new Error(`Cleanup observation ${field} must be true.`);
  }
  return value as CleanupObservation;
}

export function writeFinalArtifact(
  path: string,
  value: unknown,
): WrittenEvidence {
  const artifact = assertPlainRecord(value, 'Task 11 final artifact');
  if (artifact.status !== 'passed') throw new Error('Task 11 final artifact status must be passed.');
  assertCandidateSha(artifact.candidateSha);
  assertCanonicalRunId(artifact.runId);
  assertCompleteCleanup(artifact.cleanup);
  assertSanitizedValue(artifact);
  assertDestinationsAbsent(path);
  mkdirSync(dirname(path), { recursive: true });

  const bytes = `${canonicalJson(artifact)}\n`;
  const digest = sha256(bytes);
  const nonce = randomUUID();
  const tempPath = resolve(dirname(path), `.${basename(path)}.${nonce}.tmp`);
  const tempSidecarPath = `${tempPath}.sha256`;
  writeFileSync(tempPath, bytes, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(tempSidecarPath, sidecarBytes(path, digest), { encoding: 'utf8', flag: 'wx' });
  try {
    linkSync(tempPath, path);
    try {
      linkSync(tempSidecarPath, `${path}.sha256`);
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
  } finally {
    rmSync(tempPath, { force: true });
    rmSync(tempSidecarPath, { force: true });
  }
  return { path, sha256: digest };
}

export const STAGING_IMAGES_CASE_IDS = [
  'jpeg',
  'opaque-png',
  'transparent-png',
  'webp',
  'iphone-heic',
  'heif-sequence-rejected',
  'upload-limit',
  'master-quality-ladder',
  'preview-quality-ladder',
  'output-quality-ladder',
  'complete-2x',
  'partial-2x',
  'orientation',
  'metadata-gps-removal',
  'crop-profiles',
  'effect-natural',
  'effect-warm',
  'effect-film',
  'effect-soft',
  'effect-monochrome',
  'matte-parity',
  'mime-dimensions-checksums',
  'no-upscaling',
  'byte-ceilings',
] as const;

export const STAGING_WORKFLOW_CASE_IDS = [
  'creation',
  'initial-confirmation',
  'automatic-step-retry',
  'retained-id-replay',
  'deterministic-profile-replay',
  'conditional-object-adoption',
  'early-revision-conflict',
  'final-revision-conflict',
  'status-reconciliation',
  'missing-reconciliation',
  'unknown-reconciliation',
  'same-instance-restart',
  'termination',
  'purge-fencing',
  'zero-post-fence-writes',
  'complete-terminal-graph',
] as const;

export const STAGING_ROUTE_CASE_IDS = [
  'nested-manager-projection',
  'nested-guest-projection',
  'current-revision-webp',
  'current-revision-jpeg',
  'stale-revision-rejected',
  'preset-immutable-redirect',
  'preset-static-headers',
  'upload-no-store',
  'missing-webp-recovery',
  'missing-jpeg-recovery',
  'private-master-denied',
  'delivery-does-not-call-images',
] as const;

export const STAGING_BROWSER_CASE_IDS = [
  'desktop-manager-studio',
  'mobile-manager-studio',
  'desktop-guest-hero',
  'mobile-guest-hero',
  'interruption-recovery',
  'same-operation-retry',
  'access-recovery',
  'single-polling-owner',
  'cover-only-event-refresh',
] as const;

export interface StagingMatrixResult {
  caseId: string;
  status: 'passed';
  observationCode: string;
}

export interface StagingResourceDestruction {
  fixturesAbsent: boolean;
  workerAbsent: boolean;
  databaseAbsent: boolean;
  r2Absent: boolean;
  imagesAbsent: boolean;
  emailAbsent: boolean;
  rateLimitsAbsent: boolean;
  workflowsAbsent: boolean;
  assetsAbsent: boolean;
}

export interface StagingConformanceArtifactV1 {
  kind: 'candidary.staging-conformance';
  schemaVersion: 1;
  status: 'passed';
  candidateSha: string;
  runId: string;
  approvedMainSha: string;
  sources: {
    phase2: { sha: string; manifestSha256: string; migrationManifestSha256: string };
    phase3: { sha: string; manifestSha256: string; migrationManifestSha256: string };
  };
  authorizations: { reviewSha256: string; stagingSha256: string };
  targets: { workflowConformanceSha256: string; cutoverSha256: string };
  migrations: {
    phase2Ledger: string[];
    phase3Ledger: string[];
    bootstrapSha256: string;
    phase3MigrationSha256: string;
    phase3BundleSha256: string;
    triggerNames: string[];
    zeroCounts: {
      legacyRows: number;
      blockingJobs: number;
      incompleteActiveSets: number;
      uploadsWithoutActiveSet: number;
    };
    integrity: 'ok';
    foreignKeyRows: 0;
  };
  deployments: {
    workflowConformance: StagingDeploymentEvidence;
    phase2Cutover: StagingDeploymentEvidence;
    phase3Cutover: StagingDeploymentEvidence;
  };
  matrices: {
    images: StagingMatrixResult[];
    backfillWorkflow: StagingMatrixResult[];
    renderWorkflow: StagingMatrixResult[];
    routes: StagingMatrixResult[];
    browser: StagingMatrixResult[];
  };
  cleanup: {
    workflowConformance: StagingResourceDestruction;
    cutover: StagingResourceDestruction;
  };
  startedAt: string;
  finishedAt: string;
}

export interface StagingConformanceArtifactV2 extends Omit<StagingConformanceArtifactV1,
  'schemaVersion' | 'sources' | 'migrations' | 'deployments'> {
  schemaVersion: 2;
  sources: {
    phase2: StagingConformanceArtifactV1['sources']['phase2'];
    postCutover: StagingConformanceArtifactV1['sources']['phase3'];
  };
  migrations: {
    phase2Ledger: string[];
    postCutoverLedger: string[];
    bootstrapSha256: string;
    postCutoverMigrationsSha256: string;
    postCutoverBundleSha256: string;
    triggerNames: string[];
    zeroCounts: StagingConformanceArtifactV1['migrations']['zeroCounts'];
    integrity: 'ok';
    foreignKeyRows: 0;
  };
  deployments: {
    workflowConformance: StagingDeploymentEvidence;
    phase2Cutover: StagingDeploymentEvidence;
    postCutoverCutover: StagingDeploymentEvidence;
  };
}

export type StagingConformanceArtifact = StagingConformanceArtifactV1 | StagingConformanceArtifactV2;

export interface StagingDeploymentEvidence {
  versionId: string;
  tagSha: string;
  metadataSha: string;
  trafficPercent: number;
}

export const MEDIA_CUTOVER_READINESS_QUERY = `SELECT
  count(*) AS live_legacy_count,
  COALESCE(sum(CASE WHEN NOT EXISTS (
    SELECT 1 FROM media_object_promotions AS p
    WHERE p.media_id = m.id AND p.event_id = m.event_id
      AND p.source_bucket_generation = m.object_bucket_generation
      AND p.source_object_key = m.object_key
      AND p.source_mime_type = m.mime_type
      AND p.source_byte_size = m.byte_size
      AND p.source_width = m.width AND p.source_height = m.height
      AND p.state = 'target_verified'
      AND p.source_etag IS NOT NULL AND p.source_sha256 IS NOT NULL
      AND p.final_etag IS NOT NULL AND p.target_verified_at IS NOT NULL
      AND p.final_object_key = ('events/' || m.event_id || '/media/final/' || m.id)
      AND EXISTS (
        SELECT 1 FROM media_object_write_tombstones AS t
        WHERE t.bucket_generation = p.final_bucket_generation
          AND t.object_key = p.final_object_key
          AND t.event_id = p.event_id AND t.media_id = p.media_id
          AND t.object_kind = 'final' AND t.suppression_started_at IS NULL
      )
  ) THEN 1 ELSE 0 END), 0) AS unverified_live_legacy_count
FROM media AS m
JOIN events AS e ON e.id = m.event_id AND e.deleted_at IS NULL
WHERE m.upload_state = 'stored' AND m.deleted_at IS NULL
  AND m.object_bucket_generation = 'legacy';`;

export const MEDIA_CUTOVER_READINESS_QUERY_SHA256 = sha256(MEDIA_CUTOVER_READINESS_QUERY);

export interface MediaCutoverReadinessEvidence {
  querySha256: string;
  liveLegacyCount: number;
  unverifiedLiveLegacyCount: 0;
  observedAt: string;
}

interface MediaCutoverCandidateEvidenceBase {
  candidateSha: string;
  candidateManifestSha256: string;
  mediaUploadReleaseConfigSha256: string;
  migrationCount: 15;
  deployment: StagingDeploymentEvidence;
  observedAt: string;
}

export interface MediaCutoverPhaseEvidenceV1 {
  kind: 'candidary.media-cutover-phase-evidence';
  schemaVersion: 1;
  status: 'passed';
  runId: string;
  candidateA: MediaCutoverCandidateEvidenceBase & {
    mode: 'canonical-cutover-disabled';
    productionMigrationEvidenceSha256: string;
  };
  copyOnly: MediaCutoverCandidateEvidenceBase & {
    mode: 'canonical-copy-only';
    readiness: MediaCutoverReadinessEvidence;
  };
  candidateB: MediaCutoverCandidateEvidenceBase & {
    mode: 'canonical-live';
    readinessBeforePointerCutover: MediaCutoverReadinessEvidence;
    readinessAfterPointerCutover: MediaCutoverReadinessEvidence & { liveLegacyCount: 0 };
  };
  legacyMediaScannerConfigSha256: string;
  startedAt: string;
  finishedAt: string;
}

export interface StagingArtifactBindings {
  schemaVersion?: 1;
  candidateSha: string;
  phase2Sha: string;
  approvedMainSha: string;
  phase2ManifestSha256: string;
  candidateManifestSha256: string;
  phase2MigrationManifestSha256: string;
  phase3MigrationManifestSha256: string;
  reviewAuthorizationSha256: string;
  stagingAuthorizationSha256: string;
  workflowTargetSha256: string;
  cutoverTargetSha256: string;
  bootstrapSha256: string;
  phase3MigrationSha256: string;
  phase3BundleSha256: string;
}

export interface PostCutoverStagingArtifactBindings {
  schemaVersion: 2;
  candidateSha: string;
  phase2Sha: string;
  approvedMainSha: string;
  phase2ManifestSha256: string;
  candidateManifestSha256: string;
  phase2MigrationManifestSha256: string;
  postCutoverMigrationManifestSha256: string;
  reviewAuthorizationSha256: string;
  stagingAuthorizationSha256: string;
  workflowTargetSha256: string;
  cutoverTargetSha256: string;
  bootstrapSha256: string;
  postCutoverMigrationsSha256: string;
  postCutoverBundleSha256: string;
}

export type AnyStagingArtifactBindings = StagingArtifactBindings | PostCutoverStagingArtifactBindings;

const PHASE_2_LEDGER = [
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
] as const;
const POST_CUTOVER_LEDGER = [...PHASE_2_LEDGER, PHASE_3_MIGRATION, '0015_curated_private_guestbook.sql'] as const;

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return [...value];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function assertMatrix(
  value: unknown,
  expectedCaseIds: readonly string[],
  label: string,
): StagingMatrixResult[] {
  if (!Array.isArray(value) || value.length !== expectedCaseIds.length) {
    throw new Error(`${label} is incomplete.`);
  }
  const results = value.map((entry, index) => {
    const result = assertPlainRecord(entry, `${label}[${index}]`);
    assertExactKeys(result, ['caseId', 'status', 'observationCode'], `${label}[${index}]`);
    if (result.caseId !== expectedCaseIds[index] || result.status !== 'passed') {
      throw new Error(`${label} case order or status is incomplete.`);
    }
    return {
      caseId: exactString(result.caseId, `${label}.caseId`),
      status: 'passed' as const,
      observationCode: exactString(result.observationCode, `${label}.observationCode`),
    };
  });
  return results;
}

const DESTRUCTION_FIELDS = [
  'fixturesAbsent',
  'workerAbsent',
  'databaseAbsent',
  'r2Absent',
  'imagesAbsent',
  'emailAbsent',
  'rateLimitsAbsent',
  'workflowsAbsent',
  'assetsAbsent',
] as const satisfies readonly (keyof StagingResourceDestruction)[];

function assertDestroyed(value: unknown, label: string): StagingResourceDestruction {
  const result = assertPlainRecord(value, label);
  assertExactKeys(result, DESTRUCTION_FIELDS, label);
  for (const field of DESTRUCTION_FIELDS) {
    if (result[field] !== true) throw new Error(`${label}.${field} must be verified true.`);
  }
  return value as StagingResourceDestruction;
}

function assertSource(value: unknown, label: string): StagingConformanceArtifactV1['sources']['phase2'] {
  const source = assertPlainRecord(value, label);
  assertExactKeys(source, ['sha', 'manifestSha256', 'migrationManifestSha256'], label);
  return {
    sha: assertCandidateSha(source.sha),
    manifestSha256: assertSha256(source.manifestSha256, `${label}.manifestSha256`),
    migrationManifestSha256: assertSha256(source.migrationManifestSha256, `${label}.migrationManifestSha256`),
  };
}

function assertDeployment(value: unknown, label: string): StagingDeploymentEvidence {
  const deployment = assertPlainRecord(value, label);
  assertExactKeys(deployment, ['versionId', 'tagSha', 'metadataSha', 'trafficPercent'], label);
  if (typeof deployment.versionId !== 'string' || !RUN_ID_PATTERN.test(deployment.versionId)) {
    throw new Error(`${label}.versionId is invalid.`);
  }
  if (deployment.trafficPercent !== 100) throw new Error(`${label} must be at 100 percent traffic.`);
  return {
    versionId: deployment.versionId,
    tagSha: assertCandidateSha(deployment.tagSha),
    metadataSha: assertCandidateSha(deployment.metadataSha),
    trafficPercent: 100,
  };
}

function assertMediaCutoverReadiness(
  value: unknown,
  label: string,
  requireNoLegacyPointers: boolean,
): MediaCutoverReadinessEvidence {
  const readiness = assertPlainRecord(value, label);
  assertExactKeys(readiness, [
    'querySha256', 'liveLegacyCount', 'unverifiedLiveLegacyCount', 'observedAt',
  ], label);
  if (assertSha256(readiness.querySha256, `${label}.querySha256`)
    !== MEDIA_CUTOVER_READINESS_QUERY_SHA256) {
    throw new Error(`${label} does not bind the primary D1 readiness query.`);
  }
  if (!Number.isSafeInteger(readiness.liveLegacyCount)
    || (readiness.liveLegacyCount as number) < 0) {
    throw new Error(`${label}.liveLegacyCount must be a nonnegative integer.`);
  }
  if (readiness.unverifiedLiveLegacyCount !== 0) {
    throw new Error(`${label} must have zero unverified live legacy rows.`);
  }
  if (requireNoLegacyPointers && readiness.liveLegacyCount !== 0) {
    throw new Error(`${label} must have zero remaining live legacy pointers.`);
  }
  assertRecordedAt(readiness.observedAt);
  return value as MediaCutoverReadinessEvidence;
}

function assertMediaCutoverCandidate(
  value: unknown,
  label: string,
  mode: 'canonical-cutover-disabled' | 'canonical-copy-only' | 'canonical-live',
  extraKeys: readonly string[],
): { record: Record<string, unknown>; candidateSha: string; observedAt: string } {
  const candidate = assertPlainRecord(value, label);
  assertExactKeys(candidate, [
    'candidateSha', 'candidateManifestSha256', 'mediaUploadReleaseConfigSha256',
    'mode', 'migrationCount', 'deployment', 'observedAt', ...extraKeys,
  ], label);
  if (candidate.mode !== mode || candidate.migrationCount !== 15) {
    throw new Error(`${label} has the wrong runtime mode or migration boundary.`);
  }
  const candidateSha = assertCandidateSha(candidate.candidateSha);
  assertSha256(candidate.candidateManifestSha256, `${label}.candidateManifestSha256`);
  assertSha256(
    candidate.mediaUploadReleaseConfigSha256,
    `${label}.mediaUploadReleaseConfigSha256`,
  );
  const deployment = assertDeployment(candidate.deployment, `${label}.deployment`);
  if (deployment.tagSha !== candidateSha || deployment.metadataSha !== candidateSha) {
    throw new Error(`${label} deployment does not bind its exact candidate SHA.`);
  }
  return {
    record: candidate,
    candidateSha,
    observedAt: assertRecordedAt(candidate.observedAt),
  };
}

export function assertMediaCutoverPhaseEvidence(value: unknown): MediaCutoverPhaseEvidenceV1 {
  const artifact = assertPlainRecord(value, 'Media cutover phase evidence');
  assertExactKeys(artifact, [
    'kind', 'schemaVersion', 'status', 'runId', 'candidateA', 'copyOnly', 'candidateB',
    'legacyMediaScannerConfigSha256', 'startedAt', 'finishedAt',
  ], 'Media cutover phase evidence');
  if (artifact.kind !== 'candidary.media-cutover-phase-evidence'
    || artifact.schemaVersion !== 1 || artifact.status !== 'passed') {
    throw new Error('Media cutover phase evidence identity or status is invalid.');
  }
  assertCanonicalRunId(artifact.runId);
  const candidateA = assertMediaCutoverCandidate(
    artifact.candidateA,
    'Candidate A disabled phase',
    'canonical-cutover-disabled',
    ['productionMigrationEvidenceSha256'],
  );
  assertSha256(
    candidateA.record.productionMigrationEvidenceSha256,
    'Candidate A production migration evidence SHA-256',
  );
  const copyOnly = assertMediaCutoverCandidate(
    artifact.copyOnly,
    'Canonical copy-only phase',
    'canonical-copy-only',
    ['readiness'],
  );
  const copyReadiness = assertMediaCutoverReadiness(
    copyOnly.record.readiness,
    'Canonical copy-only readiness',
    false,
  );
  const candidateB = assertMediaCutoverCandidate(
    artifact.candidateB,
    'Candidate B live phase',
    'canonical-live',
    ['readinessBeforePointerCutover', 'readinessAfterPointerCutover'],
  );
  const beforePointerCutover = assertMediaCutoverReadiness(
    candidateB.record.readinessBeforePointerCutover,
    'Candidate B pre-pointer readiness',
    false,
  );
  const afterPointerCutover = assertMediaCutoverReadiness(
    candidateB.record.readinessAfterPointerCutover,
    'Candidate B post-pointer readiness',
    true,
  );
  const candidateShas = [candidateA.candidateSha, copyOnly.candidateSha, candidateB.candidateSha];
  if (new Set(candidateShas).size !== candidateShas.length) {
    throw new Error('Media cutover phases must use three separate candidate SHAs.');
  }
  const configShas = [
    candidateA.record.mediaUploadReleaseConfigSha256,
    copyOnly.record.mediaUploadReleaseConfigSha256,
    candidateB.record.mediaUploadReleaseConfigSha256,
  ];
  if (new Set(configShas).size !== configShas.length) {
    throw new Error('Media cutover phases must bind three distinct runtime contract byte sets.');
  }
  assertSha256(
    artifact.legacyMediaScannerConfigSha256,
    'Legacy media scanner config SHA-256',
  );
  const startedAt = assertRecordedAt(artifact.startedAt);
  const finishedAt = assertRecordedAt(artifact.finishedAt);
  const instants = [
    startedAt,
    candidateA.observedAt,
    copyOnly.observedAt,
    copyReadiness.observedAt,
    candidateB.observedAt,
    beforePointerCutover.observedAt,
    afterPointerCutover.observedAt,
    finishedAt,
  ];
  if (instants.some((instant, index) => index > 0 && instant < instants[index - 1]!)) {
    throw new Error('Media cutover phase evidence chronology is invalid.');
  }
  assertSanitizedValue(artifact);
  return value as MediaCutoverPhaseEvidenceV1;
}

export function writeMediaCutoverPhaseEvidence(
  path: string,
  value: unknown,
): WrittenEvidence {
  const artifact = assertMediaCutoverPhaseEvidence(value);
  return { path, sha256: writeExclusiveCanonical(path, artifact) };
}

function assertZeroProof(value: unknown): StagingConformanceArtifactV1['migrations']['zeroCounts'] {
  const counts = assertPlainRecord(value, 'Staging zero counts');
  assertExactKeys(counts, [
    'legacyRows', 'blockingJobs', 'incompleteActiveSets', 'uploadsWithoutActiveSet',
  ], 'Staging zero counts');
  for (const [name, count] of Object.entries(counts)) {
    if (count !== 0) throw new Error(`Staging zero count ${name} must be exactly zero.`);
  }
  return value as StagingConformanceArtifactV1['migrations']['zeroCounts'];
}

function assertStagingConformanceArtifactV1(value: unknown): StagingConformanceArtifactV1 {
  const artifact = assertPlainRecord(value, 'Staging conformance artifact');
  assertExactKeys(artifact, [
    'kind', 'schemaVersion', 'status', 'candidateSha', 'runId', 'approvedMainSha',
    'sources', 'authorizations', 'targets', 'migrations', 'deployments', 'matrices',
    'cleanup', 'startedAt', 'finishedAt',
  ], 'Staging conformance artifact');
  if (artifact.kind !== 'candidary.staging-conformance'
    || artifact.schemaVersion !== 1 || artifact.status !== 'passed') {
    throw new Error('Staging conformance artifact is not one passing v1 artifact.');
  }
  const candidateSha = assertCandidateSha(artifact.candidateSha);
  const runId = assertCanonicalRunId(artifact.runId);
  const approvedMainSha = assertCandidateSha(artifact.approvedMainSha);
  const sources = assertPlainRecord(artifact.sources, 'Staging sources');
  assertExactKeys(sources, ['phase2', 'phase3'], 'Staging sources');
  const phase2 = assertSource(sources.phase2, 'Phase-2 source');
  const phase3 = assertSource(sources.phase3, 'Phase-3 source');
  if (phase3.sha !== candidateSha) throw new Error('Staging artifact candidate does not match its Phase-3 source.');

  const authorizations = assertPlainRecord(artifact.authorizations, 'Staging authorizations');
  assertExactKeys(authorizations, ['reviewSha256', 'stagingSha256'], 'Staging authorizations');
  const parsedAuthorizations = {
    reviewSha256: assertSha256(authorizations.reviewSha256, 'reviewSha256'),
    stagingSha256: assertSha256(authorizations.stagingSha256, 'stagingSha256'),
  };
  const targets = assertPlainRecord(artifact.targets, 'Staging targets');
  assertExactKeys(targets, ['workflowConformanceSha256', 'cutoverSha256'], 'Staging targets');
  const parsedTargets = {
    workflowConformanceSha256: assertSha256(targets.workflowConformanceSha256, 'workflow target digest'),
    cutoverSha256: assertSha256(targets.cutoverSha256, 'cutover target digest'),
  };

  const migrations = assertPlainRecord(artifact.migrations, 'Staging migrations');
  assertExactKeys(migrations, [
    'phase2Ledger', 'phase3Ledger', 'bootstrapSha256', 'phase3MigrationSha256',
    'phase3BundleSha256', 'triggerNames', 'zeroCounts', 'integrity', 'foreignKeyRows',
  ], 'Staging migrations');
  const phase2Ledger = exactStringArray(migrations.phase2Ledger, 'Phase-2 ledger');
  const phase3Ledger = exactStringArray(migrations.phase3Ledger, 'Phase-3 ledger');
  if (!sameStrings(phase2Ledger, PHASE_2_LEDGER)
    || !sameStrings(phase3Ledger, [...PHASE_2_LEDGER, PHASE_3_MIGRATION])) {
    throw new Error('Staging migration ledgers are incomplete or out of order.');
  }
  const triggerNames = exactStringArray(migrations.triggerNames, 'Phase-3 trigger names');
  if (!sameStrings(triggerNames, [...PRODUCTION_TRIGGER_NAMES])) {
    throw new Error('Staging Phase-3 trigger evidence is incomplete or unexpected.');
  }
  if (migrations.integrity !== 'ok' || migrations.foreignKeyRows !== 0) {
    throw new Error('Staging migration integrity evidence is not green.');
  }
  const parsedMigrations = {
    phase2Ledger,
    phase3Ledger,
    bootstrapSha256: assertSha256(migrations.bootstrapSha256, 'bootstrapSha256'),
    phase3MigrationSha256: assertSha256(migrations.phase3MigrationSha256, 'phase3MigrationSha256'),
    phase3BundleSha256: assertSha256(migrations.phase3BundleSha256, 'phase3BundleSha256'),
    triggerNames,
    zeroCounts: assertZeroProof(migrations.zeroCounts),
    integrity: 'ok' as const,
    foreignKeyRows: 0 as const,
  };

  const deployments = assertPlainRecord(artifact.deployments, 'Staging deployments');
  assertExactKeys(deployments, [
    'workflowConformance', 'phase2Cutover', 'phase3Cutover',
  ], 'Staging deployments');
  const parsedDeployments = {
    workflowConformance: assertDeployment(deployments.workflowConformance, 'Workflow-conformance deployment'),
    phase2Cutover: assertDeployment(deployments.phase2Cutover, 'Phase-2 cutover deployment'),
    phase3Cutover: assertDeployment(deployments.phase3Cutover, 'Phase-3 cutover deployment'),
  };
  if (parsedDeployments.workflowConformance.tagSha !== candidateSha
    || parsedDeployments.workflowConformance.metadataSha !== candidateSha
    || parsedDeployments.phase2Cutover.tagSha !== phase2.sha
    || parsedDeployments.phase2Cutover.metadataSha !== phase2.sha
    || parsedDeployments.phase3Cutover.tagSha !== candidateSha
    || parsedDeployments.phase3Cutover.metadataSha !== candidateSha) {
    throw new Error('Staging deployment tags or CF_VERSION_METADATA do not bind the source candidates.');
  }

  const matrices = assertPlainRecord(artifact.matrices, 'Staging matrices');
  assertExactKeys(matrices, [
    'images', 'backfillWorkflow', 'renderWorkflow', 'routes', 'browser',
  ], 'Staging matrices');
  const parsedMatrices = {
    images: assertMatrix(matrices.images, STAGING_IMAGES_CASE_IDS, 'Images matrix'),
    backfillWorkflow: assertMatrix(matrices.backfillWorkflow, STAGING_WORKFLOW_CASE_IDS, 'Backfill Workflow matrix'),
    renderWorkflow: assertMatrix(matrices.renderWorkflow, STAGING_WORKFLOW_CASE_IDS, 'Render Workflow matrix'),
    routes: assertMatrix(matrices.routes, STAGING_ROUTE_CASE_IDS, 'Route matrix'),
    browser: assertMatrix(matrices.browser, STAGING_BROWSER_CASE_IDS, 'Browser matrix'),
  };
  const cleanup = assertPlainRecord(artifact.cleanup, 'Staging cleanup');
  assertExactKeys(cleanup, ['workflowConformance', 'cutover'], 'Staging cleanup');
  const parsedCleanup = {
    workflowConformance: assertDestroyed(cleanup.workflowConformance, 'Workflow-conformance destruction'),
    cutover: assertDestroyed(cleanup.cutover, 'Cutover destruction'),
  };
  const startedAt = assertRecordedAt(artifact.startedAt);
  const finishedAt = assertRecordedAt(artifact.finishedAt);
  if (finishedAt < startedAt) throw new Error('Staging artifact finishes before it starts.');
  assertSanitizedValue(artifact);
  return {
    kind: 'candidary.staging-conformance', schemaVersion: 1, status: 'passed',
    candidateSha, runId, approvedMainSha,
    sources: { phase2, phase3 }, authorizations: parsedAuthorizations, targets: parsedTargets,
    migrations: parsedMigrations, deployments: parsedDeployments, matrices: parsedMatrices,
    cleanup: parsedCleanup, startedAt, finishedAt,
  };
}

function assertStagingConformanceArtifactV2(value: unknown): StagingConformanceArtifactV2 {
  const artifact = assertPlainRecord(value, 'Post-cutover staging conformance artifact');
  assertExactKeys(artifact, [
    'kind', 'schemaVersion', 'status', 'candidateSha', 'runId', 'approvedMainSha',
    'sources', 'authorizations', 'targets', 'migrations', 'deployments', 'matrices',
    'cleanup', 'startedAt', 'finishedAt',
  ], 'Post-cutover staging conformance artifact');
  if (artifact.kind !== 'candidary.staging-conformance'
    || artifact.schemaVersion !== 2 || artifact.status !== 'passed') {
    throw new Error('Staging conformance artifact is not one passing post-cutover v2 artifact.');
  }
  const sources = assertPlainRecord(artifact.sources, 'Post-cutover staging sources');
  assertExactKeys(sources, ['phase2', 'postCutover'], 'Post-cutover staging sources');
  const phase2 = assertSource(sources.phase2, 'Phase-2 source');
  const postCutover = assertSource(sources.postCutover, 'Post-cutover source');
  if (postCutover.sha !== artifact.candidateSha) {
    throw new Error('Staging candidate does not match its post-cutover source.');
  }
  const migrations = assertPlainRecord(artifact.migrations, 'Post-cutover migrations');
  assertExactKeys(migrations, [
    'phase2Ledger', 'postCutoverLedger', 'bootstrapSha256', 'postCutoverMigrationsSha256',
    'postCutoverBundleSha256', 'triggerNames', 'zeroCounts', 'integrity', 'foreignKeyRows',
  ], 'Post-cutover migrations');
  const phase2Ledger = exactStringArray(migrations.phase2Ledger, 'Phase-2 ledger');
  const postCutoverLedger = exactStringArray(migrations.postCutoverLedger, 'Post-cutover ledger');
  if (!sameStrings(phase2Ledger, PHASE_2_LEDGER)
    || !sameStrings(postCutoverLedger, POST_CUTOVER_LEDGER)) {
    throw new Error('Post-cutover staging migration ledgers are incomplete or out of order.');
  }
  const deployments = assertPlainRecord(artifact.deployments, 'Post-cutover deployments');
  assertExactKeys(deployments, [
    'workflowConformance', 'phase2Cutover', 'postCutoverCutover',
  ], 'Post-cutover deployments');
  const postCutoverTriggerNames = exactStringArray(
    migrations.triggerNames,
    'Post-cutover trigger names',
  );
  if (!sameStrings(postCutoverTriggerNames, [...POST_CUTOVER_PRODUCTION_TRIGGER_NAMES])) {
    throw new Error('Post-cutover trigger evidence is incomplete or unexpected.');
  }
  const synthetic: StagingConformanceArtifactV1 = {
    ...(artifact as unknown as StagingConformanceArtifactV2),
    schemaVersion: 1,
    sources: { phase2, phase3: postCutover },
    migrations: {
      phase2Ledger,
      phase3Ledger: postCutoverLedger.slice(0, 14),
      bootstrapSha256: assertSha256(migrations.bootstrapSha256, 'bootstrapSha256'),
      phase3MigrationSha256: assertSha256(migrations.postCutoverMigrationsSha256, 'postCutoverMigrationsSha256'),
      phase3BundleSha256: assertSha256(migrations.postCutoverBundleSha256, 'postCutoverBundleSha256'),
      // Reuse every v1 structural check while preserving its historical
      // twelve-trigger contract; the exact v2 set was checked immediately above.
      triggerNames: [...PRODUCTION_TRIGGER_NAMES],
      zeroCounts: assertZeroProof(migrations.zeroCounts),
      integrity: migrations.integrity as 'ok', foreignKeyRows: migrations.foreignKeyRows as 0,
    },
    deployments: {
      workflowConformance: deployments.workflowConformance as StagingDeploymentEvidence,
      phase2Cutover: deployments.phase2Cutover as StagingDeploymentEvidence,
      phase3Cutover: deployments.postCutoverCutover as StagingDeploymentEvidence,
    },
  };
  assertStagingConformanceArtifactV1(synthetic);
  assertSanitizedValue(artifact);
  return value as StagingConformanceArtifactV2;
}

export function assertStagingConformanceArtifact(value: unknown): StagingConformanceArtifact {
  const record = assertPlainRecord(value, 'Staging conformance artifact');
  return record.schemaVersion === 2
    ? assertStagingConformanceArtifactV2(value)
    : assertStagingConformanceArtifactV1(value);
}

export function writeStagingConformanceArtifact(
  path: string,
  value: unknown,
): WrittenEvidence {
  const artifact = assertStagingConformanceArtifact(value);
  return { path, sha256: writeExclusiveCanonical(path, artifact) };
}

function assertRegularEvidenceFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular nonsymlinked file.`);
  return absolute;
}

function assertArtifactBindings(
  artifact: StagingConformanceArtifact,
  expected: AnyStagingArtifactBindings,
): void {
  const actual: AnyStagingArtifactBindings = artifact.schemaVersion === 2 ? {
    schemaVersion: 2,
    candidateSha: artifact.candidateSha,
    phase2Sha: artifact.sources.phase2.sha,
    approvedMainSha: artifact.approvedMainSha,
    phase2ManifestSha256: artifact.sources.phase2.manifestSha256,
    candidateManifestSha256: artifact.sources.postCutover.manifestSha256,
    phase2MigrationManifestSha256: artifact.sources.phase2.migrationManifestSha256,
    postCutoverMigrationManifestSha256: artifact.sources.postCutover.migrationManifestSha256,
    reviewAuthorizationSha256: artifact.authorizations.reviewSha256,
    stagingAuthorizationSha256: artifact.authorizations.stagingSha256,
    workflowTargetSha256: artifact.targets.workflowConformanceSha256,
    cutoverTargetSha256: artifact.targets.cutoverSha256,
    bootstrapSha256: artifact.migrations.bootstrapSha256,
    postCutoverMigrationsSha256: artifact.migrations.postCutoverMigrationsSha256,
    postCutoverBundleSha256: artifact.migrations.postCutoverBundleSha256,
  } : {
    candidateSha: artifact.candidateSha,
    phase2Sha: artifact.sources.phase2.sha,
    approvedMainSha: artifact.approvedMainSha,
    phase2ManifestSha256: artifact.sources.phase2.manifestSha256,
    candidateManifestSha256: artifact.sources.phase3.manifestSha256,
    phase2MigrationManifestSha256: artifact.sources.phase2.migrationManifestSha256,
    phase3MigrationManifestSha256: artifact.sources.phase3.migrationManifestSha256,
    reviewAuthorizationSha256: artifact.authorizations.reviewSha256,
    stagingAuthorizationSha256: artifact.authorizations.stagingSha256,
    workflowTargetSha256: artifact.targets.workflowConformanceSha256,
    cutoverTargetSha256: artifact.targets.cutoverSha256,
    bootstrapSha256: artifact.migrations.bootstrapSha256,
    phase3MigrationSha256: artifact.migrations.phase3MigrationSha256,
    phase3BundleSha256: artifact.migrations.phase3BundleSha256,
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('Staging artifact does not bind the independently verified source digests.');
  }
}

export function verifyStagingConformanceArtifactFile(
  path: string,
  expected: AnyStagingArtifactBindings,
): { artifact: StagingConformanceArtifact; sha256: string } {
  const artifactPath = assertRegularEvidenceFile(path, 'Staging artifact');
  const sidecarPath = assertRegularEvidenceFile(`${artifactPath}.sha256`, 'Staging artifact sidecar');
  const bytes = readFileSync(artifactPath, 'utf8');
  const digest = sha256(bytes);
  const sidecarDigest = parseSidecar(artifactPath, readFileSync(sidecarPath, 'utf8'));
  if (digest !== sidecarDigest) throw new Error('Staging artifact sidecar digest does not match.');
  const parsed = JSON.parse(bytes) as unknown;
  const artifact = assertStagingConformanceArtifact(parsed);
  if (bytes !== `${canonicalJson(artifact)}\n`) throw new Error('Staging artifact bytes are not canonical.');
  assertArtifactBindings(artifact, expected);
  return { artifact, sha256: digest };
}

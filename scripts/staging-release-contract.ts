import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';

export { STAGING_ORIGIN } from '../shared/staging-conformance.ts';

export const STAGING_RELEASE_MODES = [
  'probe',
  'deploy',
  'conform',
  'cleanup',
  'finalize',
  'verify',
] as const;

export type StagingReleaseMode = typeof STAGING_RELEASE_MODES[number];

export const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const SHA1_PATTERN = /^[0-9a-f]{40}$/u;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const STAGING_TARGET = {
  workerName: 'candidary-staging-conformance',
  databaseName: 'candidary-core-staging',
  bucketName: 'candidary-media-staging',
  workflows: {
    export: 'candidary-staging-export',
    render: 'candidary-staging-cover-render',
    backfill: 'candidary-staging-cover-backfill',
  },
  workersDev: false,
  previewUrls: false,
  routes: [] as readonly string[],
  customDomains: [] as readonly string[],
  crons: [] as readonly string[],
} as const;

export interface StagingTarget {
  readonly workerName: string;
  readonly databaseName: string;
  readonly bucketName: string;
  readonly workflows: {
    readonly export: string;
    readonly render: string;
    readonly backfill: string;
  };
  readonly workersDev: boolean;
  readonly previewUrls: boolean;
  readonly routes: readonly string[];
  readonly customDomains: readonly string[];
  readonly crons: readonly string[];
}

export interface StagingReleaseArgs {
  readonly mode: StagingReleaseMode;
  readonly candidateSha: string;
  readonly runId: string;
  readonly targetPath: string;
}

export type ConformancePhase = StagingReleaseMode;
export type ConformanceStatus = 'partial' | 'failed' | 'passed';
export type ClosedOutcome = 'accepted' | 'adopted' | 'rejected' | 'blocked' | 'complete';
export type WorkflowDisposition =
  | 'active'
  | 'complete'
  | 'errored'
  | 'terminated'
  | 'missing'
  | 'invalid'
  | 'unknown';

export interface RuntimeIdentityResult {
  readonly versionId: string;
  readonly versionTag: string | null;
  readonly versionTimestamp: string;
}

export interface ImageCaseResult {
  readonly caseId: string;
  readonly outcome: ClosedOutcome;
  readonly resultCode: string | null;
  readonly detectedType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | null;
  readonly format: 'webp' | 'jpeg' | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly byteSize: number | null;
  readonly sha256: string | null;
  readonly qualityRung: number | null;
  readonly adopted: boolean;
}

export interface WorkflowCaseResult {
  readonly caseId: string;
  readonly disposition: WorkflowDisposition;
  readonly retainedInstance: boolean;
  readonly mutationCount: number;
}

export interface ZeroProofCounts {
  readonly legacyRows: number;
  readonly blockingJobs: number;
  readonly incompleteActiveSets: number;
  readonly uploadsWithoutActiveSet: number;
}

export interface CleanupObservation {
  readonly fixturesAbsent: boolean;
  readonly workerAbsent: boolean;
  readonly databaseAbsent: boolean;
  readonly bucketAbsent: boolean;
  readonly workflowsAbsent: boolean;
  readonly callersAbsent: boolean;
  readonly probeAbsent: boolean;
}

export interface PhaseReceipt<Result = unknown> {
  readonly schemaVersion: 1;
  readonly phase: ConformancePhase;
  readonly candidateSha: string;
  readonly runId: string;
  readonly predecessorSha256: string | null;
  readonly recordedAt: string;
  readonly result: Result;
}

export function parseMode(value: unknown): StagingReleaseMode {
  if (typeof value !== 'string' || !STAGING_RELEASE_MODES.includes(value as StagingReleaseMode)) {
    throw new Error('Task 11 mode is missing or unknown.');
  }
  return value as StagingReleaseMode;
}

export function assertCanonicalRunId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new Error('Task 11 run ID must be one canonical lowercase UUID.');
  }
  return value;
}

export function assertCandidateSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA1_PATTERN.test(value)) {
    throw new Error('Candidate SHA must contain exactly 40 lowercase hexadecimal characters.');
  }
  return value;
}

export function conformancePrefix(runId: string): string {
  return `conformance/${assertCanonicalRunId(runId)}/`;
}

export function assertOwnedConformanceId(runId: string, value: unknown): string {
  const canonicalRunId = assertCanonicalRunId(runId);
  const pattern = new RegExp(`^c11-${canonicalRunId}-[a-z][a-z0-9-]{0,63}$`, 'u');
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error('Identifier does not belong to the Task 11 run namespace.');
  }
  return value;
}

function assertStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertSafeStagingTarget(value: unknown): StagingTarget {
  const target = assertRecord(value, 'Staging target');
  const workflows = assertRecord(target.workflows, 'Staging workflows');
  const productionValues = new Set([
    'candidary',
    'candidary-core',
    'candidary-media',
    'candidary-export',
    'candidary-cover-render',
    'candidary-cover-backfill',
  ]);

  for (const [label, candidate] of [
    ['worker', target.workerName],
    ['database', target.databaseName],
    ['bucket', target.bucketName],
    ['export workflow', workflows.export],
    ['render workflow', workflows.render],
    ['backfill workflow', workflows.backfill],
  ] as const) {
    if (typeof candidate !== 'string') throw new Error(`${label} identity must be a string.`);
    if (productionValues.has(candidate)) throw new Error(`${label} uses a production identity.`);
  }

  if (target.workerName !== STAGING_TARGET.workerName
    || target.databaseName !== STAGING_TARGET.databaseName
    || target.bucketName !== STAGING_TARGET.bucketName
    || workflows.export !== STAGING_TARGET.workflows.export
    || workflows.render !== STAGING_TARGET.workflows.render
    || workflows.backfill !== STAGING_TARGET.workflows.backfill) {
    throw new Error('Staging target does not match the approved isolated identities.');
  }
  if (target.workersDev !== false) throw new Error('Staging workers_dev must be false.');
  if (target.previewUrls !== false) throw new Error('Staging preview URLs must be disabled.');
  if (assertStringArray(target.routes, 'Staging routes').length !== 0) {
    throw new Error('Staging routes must be empty.');
  }
  if (assertStringArray(target.customDomains, 'Staging custom domains').length !== 0) {
    throw new Error('Staging custom domains must be empty.');
  }
  if (assertStringArray(target.crons, 'Staging crons').length !== 0) {
    throw new Error('Staging cron triggers must be empty.');
  }

  return value as StagingTarget;
}

function assertSafeTargetPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Target path cannot be empty.');
  }
  if (value.includes('\0') || isAbsolute(value)) {
    throw new Error('Target path must be a relative, non-NUL path.');
  }
  const normalized = normalize(value).replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Target path escapes the project root.');
  }
  if (!normalized.startsWith('output/staging-input/')) {
    throw new Error('Target path must be beneath output/staging-input.');
  }
  return normalized;
}

export function resolveSafeExistingInput(projectRoot: string, relativePath: string): string {
  const safeRelativePath = assertSafeTargetPath(relativePath);
  const canonicalRoot = realpathSync(projectRoot);
  const absolute = resolve(canonicalRoot, safeRelativePath);
  const fromRoot = relative(canonicalRoot, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..\\`) || isAbsolute(fromRoot)) {
    throw new Error('Input path escapes the project root.');
  }
  if (!existsSync(absolute)) throw new Error('Input path does not exist.');

  let cursor = canonicalRoot;
  for (const segment of safeRelativePath.split('/')) {
    cursor = resolve(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error('Input path contains a symlink.');
    }
  }
  const canonicalInput = realpathSync(absolute);
  const canonicalRelative = relative(canonicalRoot, canonicalInput);
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..\\`) || isAbsolute(canonicalRelative)) {
    throw new Error('Input path resolves outside the project root.');
  }
  return canonicalInput;
}

export function parseStagingArgs(argv: readonly string[]): StagingReleaseArgs {
  if (argv.length === 0) throw new Error('Task 11 mode is missing.');
  const mode = parseMode(argv[0]);
  const acceptedFlags = new Map([
    ['--candidate-sha', 'candidateSha'],
    ['--run-id', 'runId'],
    ['--target', 'targetPath'],
  ] as const);
  const values = new Map<string, string>();

  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const candidate = argv[index + 1];
    if (flag === undefined || !acceptedFlags.has(flag as '--candidate-sha')) {
      throw new Error(`Task 11 CLI received an unknown flag: ${String(flag)}`);
    }
    if (values.has(flag)) throw new Error(`Task 11 CLI received duplicate flag ${flag}.`);
    if (candidate === undefined || candidate.length === 0) {
      throw new Error(`Task 11 CLI value for ${flag} cannot be empty.`);
    }
    values.set(flag, candidate);
  }

  for (const flag of acceptedFlags.keys()) {
    if (!values.has(flag)) throw new Error(`Task 11 CLI is missing ${flag}.`);
  }

  return {
    mode,
    candidateSha: assertCandidateSha(values.get('--candidate-sha')),
    runId: assertCanonicalRunId(values.get('--run-id')),
    targetPath: assertSafeTargetPath(values.get('--target')),
  };
}

const FORBIDDEN_EVIDENCE_FIELDS = new Set([
  'bytes',
  'cause',
  'error',
  'errormessage',
  'fixturebytes',
  'key',
  'message',
  'objectkey',
  'payload',
  'privateurl',
  'secret',
  'sql',
  'stack',
  'token',
  'url',
]);

function normalizedFieldName(value: string): string {
  return value.replaceAll(/[^a-z0-9]/giu, '').toLowerCase();
}

function assertSanitizedString(value: string): void {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    throw new Error('Evidence contains a URL value.');
  }
  if (/STAGING-CONFORMANCE-NOT-A-REAL-R2-KEY/iu.test(value)
    || /-----BEGIN [A-Z ]+PRIVATE KEY-----/u.test(value)
    || /(?:secret|token|password)\s*[:=]/iu.test(value)) {
    throw new Error('Evidence contains a secret-shaped value.');
  }
}

export function assertSanitizedValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    assertSanitizedString(value);
    return;
  }
  if (typeof value !== 'object') throw new Error('Evidence contains a non-JSON value.');
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error('Evidence contains binary data.');
  }
  if (seen.has(value)) throw new Error('Evidence contains a cycle.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertSanitizedValue(entry, seen);
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Evidence contains a non-plain object.');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_EVIDENCE_FIELDS.has(normalizedFieldName(key))) {
      throw new Error(`Evidence contains forbidden evidence field ${key}.`);
    }
    assertSanitizedValue(entry, seen);
  }
  seen.delete(value);
}

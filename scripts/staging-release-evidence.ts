import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256 } from './release-evidence';
import {
  SHA256_PATTERN,
  assertCandidateSha,
  assertCanonicalRunId,
  assertSanitizedValue,
  parseMode,
  type CleanupObservation,
  type PhaseReceipt,
} from './staging-release-contract';

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
  const match = /^([0-9a-f]{64})  ([^\r\n]+)\r?\n$/u.exec(bytes);
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

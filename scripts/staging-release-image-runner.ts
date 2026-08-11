import { assertCanonicalRunId } from './staging-release-contract.ts';
import {
  assertCompleteFixturePlan,
  type Task11FixturePlanEntry,
} from './staging-release-fixtures.ts';
import {
  assertCompleteImageMatrix,
  buildImageMatrix,
  type Task11ImageMatrixCase,
} from './staging-release-images.ts';
import type { StagingRpcMethod } from './staging-release-rpc.ts';

export interface SanitizedImageResult {
  readonly caseId: string;
  readonly outcome: 'accepted' | 'rejected';
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

export interface StoredImageVerification {
  readonly checksumMatches: boolean;
  readonly metadataStripped: boolean;
}

export interface Task11ImageExecutionAdapter {
  readonly uploadFixture: (
    runId: string,
    caseId: string,
    fixture: Task11FixturePlanEntry,
  ) => Promise<void>;
  readonly rpc: (
    method: StagingRpcMethod,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly verifyStoredResult: (
    runId: string,
    matrixCase: Task11ImageMatrixCase,
    result: SanitizedImageResult,
  ) => Promise<StoredImageVerification>;
}

export interface Task11ImageObservation {
  readonly caseId: string;
  readonly status: 'passed';
  readonly observationCode: string;
}

function imageResult(value: unknown, caseId: string): SanitizedImageResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Task 11 image case ${caseId} returned a non-object result.`);
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'adopted', 'byteSize', 'caseId', 'detectedType', 'format', 'height', 'outcome',
    'qualityRung', 'resultCode', 'sha256', 'width',
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Task 11 image case ${caseId} returned an open result shape.`);
  }
  if (record.caseId !== caseId || (record.outcome !== 'accepted' && record.outcome !== 'rejected')
    || typeof record.adopted !== 'boolean') {
    throw new Error(`Task 11 image case ${caseId} returned an invalid identity or outcome.`);
  }
  if (record.outcome === 'accepted') {
    if (record.resultCode !== null || !Number.isSafeInteger(record.width) || (record.width as number) < 1
      || !Number.isSafeInteger(record.height) || (record.height as number) < 1
      || !Number.isSafeInteger(record.byteSize) || (record.byteSize as number) < 1
      || typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(record.sha256)) {
      throw new Error(`Task 11 image case ${caseId} returned incomplete accepted evidence.`);
    }
  } else if (typeof record.resultCode !== 'string'
    || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(record.resultCode)) {
    throw new Error(`Task 11 image case ${caseId} returned incomplete rejection evidence.`);
  }
  return value as SanitizedImageResult;
}

function fixtureFor(
  plan: readonly Task11FixturePlanEntry[],
  caseId: string,
): Task11FixturePlanEntry {
  const fixture = plan.find((entry) => entry.caseId === caseId);
  if (!fixture) throw new Error(`Task 11 image case ${caseId} has no fixture.`);
  return fixture;
}

export function task11ProfileInput(
  runId: string,
  matrixCase: Task11ImageMatrixCase,
  master: SanitizedImageResult,
): Record<string, unknown> {
  let profile = matrixCase.profile ?? 'standard-default';
  let density = matrixCase.density ?? '1x';
  if (matrixCase.caseId === 'deterministic-trim-focus') density = '2x';
  if (matrixCase.caseId === 'partial-two-x') {
    profile = 'short-lookup';
    density = '2x';
  }
  if (matrixCase.caseId === 'no-upscale') {
    profile = 'standard-default';
    density = '1x';
  }
  if (matrixCase.caseId === 'density-2x') profile = 'short-lookup';
  return {
    runId,
    caseId: matrixCase.caseId,
    effect: matrixCase.effect ?? 'natural',
    profile,
    density,
    format: matrixCase.format ?? 'webp',
    focus: { x: 0.5, y: 0.5, zoom: 1 },
    master: { width: master.width, height: master.height },
  };
}

async function normalize(
  runId: string,
  matrixCase: Task11ImageMatrixCase,
  fixture: Task11FixturePlanEntry,
  adapter: Task11ImageExecutionAdapter,
): Promise<SanitizedImageResult> {
  return imageResult(await adapter.rpc('normalizeImageCase', {
    runId,
    caseId: matrixCase.caseId,
    declaredMimeType: fixture.declaredMimeType,
  }), matrixCase.caseId);
}

async function executeCase(
  runId: string,
  matrixCase: Task11ImageMatrixCase,
  fixture: Task11FixturePlanEntry,
  adapter: Task11ImageExecutionAdapter,
): Promise<SanitizedImageResult> {
  if (matrixCase.operation === 'inspect') {
    return imageResult(await adapter.rpc('inspectImageCase', {
      runId, caseId: matrixCase.caseId,
    }), matrixCase.caseId);
  }
  const master = await normalize(runId, matrixCase, fixture, adapter);
  if (master.outcome !== 'accepted') return master;
  if (matrixCase.operation === 'normalize') return master;
  if (matrixCase.operation === 'preview') {
    return imageResult(await adapter.rpc('renderPreviewCase', {
      runId,
      caseId: matrixCase.caseId,
      effect: matrixCase.effect ?? 'natural',
    }), matrixCase.caseId);
  }
  const input = task11ProfileInput(runId, matrixCase, master);
  const first = imageResult(await adapter.rpc('renderProfileCase', input), matrixCase.caseId);
  if (matrixCase.operation !== 'inventory' || first.outcome !== 'accepted') return first;
  return imageResult(await adapter.rpc('renderProfileCase', input), matrixCase.caseId);
}

function expectedOutcome(matrixCase: Task11ImageMatrixCase, result: SanitizedImageResult): void {
  if (matrixCase.expectedResult === 'rejected' || matrixCase.expectedResult === 'not-eligible') {
    if (result.outcome !== 'rejected') {
      throw new Error(`Task 11 image case ${matrixCase.caseId} was expected to reject.`);
    }
    return;
  }
  if (result.outcome !== 'accepted') {
    throw new Error(`Task 11 image case ${matrixCase.caseId} was expected to materialize.`);
  }
  if (matrixCase.expectedRung !== undefined && result.qualityRung !== matrixCase.expectedRung) {
    throw new Error(`Task 11 image case ${matrixCase.caseId} selected the wrong quality rung.`);
  }
  if (matrixCase.expectedResult === 'adopted' && result.adopted !== true) {
    throw new Error(`Task 11 image case ${matrixCase.caseId} did not adopt the retained object.`);
  }
}

export async function executeTask11ImageMatrix(
  runIdInput: string,
  fixturePlanInput: readonly Task11FixturePlanEntry[],
  adapter: Task11ImageExecutionAdapter,
): Promise<Task11ImageObservation[]> {
  const runId = assertCanonicalRunId(runIdInput);
  const fixturePlan = assertCompleteFixturePlan(fixturePlanInput);
  const matrix = buildImageMatrix(fixturePlan);
  assertCompleteImageMatrix(matrix);
  const observations: Task11ImageObservation[] = [];
  for (const matrixCase of matrix) {
    const fixture = fixtureFor(fixturePlan, matrixCase.fixtureCaseId);
    await adapter.uploadFixture(runId, matrixCase.caseId, fixture);
    const result = await executeCase(runId, matrixCase, fixture, adapter);
    expectedOutcome(matrixCase, result);
    if (result.outcome === 'accepted') {
      const stored = await adapter.verifyStoredResult(runId, matrixCase, result);
      if (!stored.checksumMatches
        || (matrixCase.coverage.includes('metadata-removal') && !stored.metadataStripped)) {
        throw new Error(`Task 11 image case ${matrixCase.caseId} failed stored output verification.`);
      }
    }
    observations.push({
      caseId: matrixCase.caseId,
      status: 'passed',
      observationCode: matrixCase.expectedResult === 'rejected'
        ? 'expected-rejection'
        : matrixCase.expectedResult === 'not-eligible'
          ? 'no-upscale-rejection'
          : matrixCase.expectedResult === 'adopted'
            ? 'conditional-adoption'
            : 'materialized-and-verified',
    });
  }
  return observations;
}

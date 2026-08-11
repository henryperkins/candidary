import { canonicalJson, sha256 } from './release-evidence.ts';
import {
  STAGING_TARGET,
  assertCanonicalRunId,
} from './staging-release-contract.ts';

export const TASK11_WORKFLOW_CASE_IDS = [
  'creation-confirmation',
  'automatic-step-retry',
  'deterministic-profile-replay',
  'retained-id-replay',
  'pause-resume',
  'same-instance-restart',
  'platform-status-observations',
  'failed-lookup-materialization',
  'status-unknown-preservation',
  'creation-minute-bound',
  'inflight-bound',
  'active-run-bound',
  'batch-bound',
  'delete-before-dispatch',
  'delete-after-dispatch',
  'delete-before-preflight',
  'delete-after-preflight',
  'purge-resumability',
  'purge-terminal-ordering',
  'needs-replacement-resolution',
  'verification-closure',
] as const;

export type Task11WorkflowCaseId = typeof TASK11_WORKFLOW_CASE_IDS[number];
type WorkflowCoverage =
  | 'lifecycle'
  | 'reconciliation'
  | 'bounds'
  | 'deletion-and-purge'
  | 'replacement-resolution'
  | 'verification-closure';

export interface Task11WorkflowMatrixCase {
  readonly caseId: Task11WorkflowCaseId;
  readonly coverage: readonly WorkflowCoverage[];
}

const WORKFLOW_MATRIX: readonly Task11WorkflowMatrixCase[] = [
  { caseId: 'creation-confirmation', coverage: ['lifecycle'] },
  { caseId: 'automatic-step-retry', coverage: ['lifecycle'] },
  { caseId: 'deterministic-profile-replay', coverage: ['lifecycle'] },
  { caseId: 'retained-id-replay', coverage: ['lifecycle', 'reconciliation'] },
  { caseId: 'pause-resume', coverage: ['lifecycle'] },
  { caseId: 'same-instance-restart', coverage: ['lifecycle', 'reconciliation'] },
  { caseId: 'platform-status-observations', coverage: ['reconciliation'] },
  { caseId: 'failed-lookup-materialization', coverage: ['reconciliation'] },
  { caseId: 'status-unknown-preservation', coverage: ['reconciliation'] },
  { caseId: 'creation-minute-bound', coverage: ['bounds'] },
  { caseId: 'inflight-bound', coverage: ['bounds'] },
  { caseId: 'active-run-bound', coverage: ['bounds'] },
  { caseId: 'batch-bound', coverage: ['bounds'] },
  { caseId: 'delete-before-dispatch', coverage: ['deletion-and-purge'] },
  { caseId: 'delete-after-dispatch', coverage: ['deletion-and-purge'] },
  { caseId: 'delete-before-preflight', coverage: ['deletion-and-purge'] },
  { caseId: 'delete-after-preflight', coverage: ['deletion-and-purge'] },
  { caseId: 'purge-resumability', coverage: ['deletion-and-purge', 'reconciliation'] },
  { caseId: 'purge-terminal-ordering', coverage: ['deletion-and-purge', 'reconciliation'] },
  { caseId: 'needs-replacement-resolution', coverage: ['replacement-resolution'] },
  { caseId: 'verification-closure', coverage: ['verification-closure'] },
];

export interface Task11WorkflowMatrixSummary {
  readonly lifecycle: true;
  readonly reconciliation: true;
  readonly bounds: true;
  readonly deletionAndPurge: true;
  readonly replacementResolution: true;
  readonly verificationClosure: true;
}

export function buildWorkflowMatrix(): Task11WorkflowMatrixCase[] {
  return WORKFLOW_MATRIX.map((entry) => ({
    caseId: entry.caseId,
    coverage: [...entry.coverage],
  }));
}

export function assertCompleteWorkflowMatrix(
  value: readonly Task11WorkflowMatrixCase[],
): Task11WorkflowMatrixSummary {
  if (!Array.isArray(value)) throw new Error('Task 11 Workflow matrix must be an array.');
  const expected = new Set<string>(TASK11_WORKFLOW_CASE_IDS);
  const observed = new Set<string>();
  const coverage = new Set<WorkflowCoverage>();
  for (const entry of value) {
    if (!expected.has(entry.caseId)) {
      throw new Error(`Task 11 Workflow matrix contains unknown case ${String(entry.caseId)}.`);
    }
    if (observed.has(entry.caseId)) {
      throw new Error(`Task 11 Workflow matrix contains duplicate case ${entry.caseId}.`);
    }
    observed.add(entry.caseId);
    const canonical = WORKFLOW_MATRIX.find((candidate) => candidate.caseId === entry.caseId)!;
    if (canonicalJson(entry.coverage) !== canonicalJson(canonical.coverage)) {
      throw new Error(`Task 11 Workflow matrix case ${entry.caseId} has foreign coverage.`);
    }
    for (const item of entry.coverage) coverage.add(item);
  }
  for (const caseId of TASK11_WORKFLOW_CASE_IDS) {
    if (!observed.has(caseId)) throw new Error(`Task 11 Workflow matrix is missing ${caseId}.`);
  }
  for (const item of [
    'lifecycle',
    'reconciliation',
    'bounds',
    'deletion-and-purge',
    'replacement-resolution',
    'verification-closure',
  ] as const) {
    if (!coverage.has(item)) throw new Error(`Task 11 Workflow matrix is missing ${item} coverage.`);
  }
  return {
    lifecycle: true,
    reconciliation: true,
    bounds: true,
    deletionAndPurge: true,
    replacementResolution: true,
    verificationClosure: true,
  };
}

export interface Task11OperationUnit {
  readonly schemaVersion: 1;
  readonly databaseName: typeof STAGING_TARGET.databaseName;
  readonly runId: string;
  readonly caseId: Task11WorkflowCaseId;
  readonly sequence: number;
  readonly mutationPath: string;
  readonly observationPath: string;
  readonly mutationSql: string;
  readonly observationSql: string;
  readonly mutationSha256: string;
  readonly observationSha256: string;
  readonly expectedObservedCount: number;
}

export interface MakeOperationUnitInput {
  readonly runId: string;
  readonly caseId: Task11WorkflowCaseId;
  readonly sequence: number;
  readonly mutationSql: string;
  readonly observationSql: string;
  readonly expectedObservedCount: number;
}

function canonicalSql(value: string, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') || value.trim().length === 0) {
    throw new Error(`${label} SQL is empty or invalid.`);
  }
  return `${value.trimEnd()}\n`;
}

function operationPath(sequence: number, caseId: string, suffix: 'mutate' | 'observe'): string {
  return `operations/${String(sequence).padStart(2, '0')}-${caseId}-${suffix}.sql`;
}

export function makeOperationUnit(input: MakeOperationUnitInput): Task11OperationUnit {
  const runId = assertCanonicalRunId(input.runId);
  if (!TASK11_WORKFLOW_CASE_IDS.includes(input.caseId)) {
    throw new Error('Task 11 operation case is unknown.');
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > 99) {
    throw new Error('Task 11 operation sequence must be between 1 and 99.');
  }
  if (!Number.isSafeInteger(input.expectedObservedCount)
    || input.expectedObservedCount < 0 || input.expectedObservedCount > 10_000) {
    throw new Error('Task 11 expected observation count is invalid.');
  }
  const mutationSql = canonicalSql(input.mutationSql, 'Mutation');
  const observationSql = canonicalSql(input.observationSql, 'Observation');
  const unit: Task11OperationUnit = {
    schemaVersion: 1,
    databaseName: STAGING_TARGET.databaseName,
    runId,
    caseId: input.caseId,
    sequence: input.sequence,
    mutationPath: operationPath(input.sequence, input.caseId, 'mutate'),
    observationPath: operationPath(input.sequence, input.caseId, 'observe'),
    mutationSql,
    observationSql,
    mutationSha256: sha256(mutationSql),
    observationSha256: sha256(observationSql),
    expectedObservedCount: input.expectedObservedCount,
  };
  return assertSafeOperationUnit(unit, runId);
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Task 11 operation unit must be an object.');
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [
    'caseId', 'databaseName', 'expectedObservedCount', 'mutationPath', 'mutationSha256',
    'mutationSql', 'observationPath', 'observationSha256', 'observationSql', 'runId',
    'schemaVersion', 'sequence',
  ].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('Task 11 operation unit has an unknown or missing field.');
  }
  return record;
}

function assertRunGuard(sql: string, runId: string, label: string): void {
  if (!sql.includes(runId)) throw new Error(`${label} SQL is missing its run guard.`);
  if (!/\b(?:WHERE|VALUES|SELECT)\b/iu.test(sql)) {
    throw new Error(`${label} SQL is missing its guarded predicate.`);
  }
}

export function assertSafeOperationUnit(
  value: unknown,
  expectedRunId: string,
): Task11OperationUnit {
  const record = exactRecord(value);
  const runId = assertCanonicalRunId(expectedRunId);
  if (record.schemaVersion !== 1) throw new Error('Task 11 operation schema version is invalid.');
  if (record.databaseName === 'candidary-core') {
    throw new Error('Task 11 operation unit uses a production database identity.');
  }
  if (record.databaseName !== STAGING_TARGET.databaseName) {
    throw new Error('Task 11 operation unit uses an unapproved staging database identity.');
  }
  if (record.runId !== runId) throw new Error('Task 11 operation run ID does not match.');
  if (typeof record.caseId !== 'string'
    || !TASK11_WORKFLOW_CASE_IDS.includes(record.caseId as Task11WorkflowCaseId)) {
    throw new Error('Task 11 operation case is unknown.');
  }
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1
    || (record.sequence as number) > 99) {
    throw new Error('Task 11 operation sequence is invalid.');
  }
  const expectedMutationPath = operationPath(
    record.sequence as number,
    record.caseId,
    'mutate',
  );
  const expectedObservationPath = operationPath(
    record.sequence as number,
    record.caseId,
    'observe',
  );
  if (record.mutationPath !== expectedMutationPath || record.observationPath !== expectedObservationPath) {
    throw new Error('Task 11 operation path is noncanonical.');
  }
  const mutationSql = canonicalSql(record.mutationSql as string, 'Mutation');
  const observationSql = canonicalSql(record.observationSql as string, 'Observation');
  assertRunGuard(mutationSql, runId, 'Mutation');
  assertRunGuard(observationSql, runId, 'Observation');
  if (!/^\s*SELECT\b/iu.test(observationSql) || !/\bobserved_count\b/iu.test(observationSql)) {
    throw new Error('Task 11 observation SQL must return observed_count directly.');
  }
  if (record.mutationSha256 !== sha256(mutationSql)
    || record.observationSha256 !== sha256(observationSql)) {
    throw new Error('Task 11 operation SQL digest does not match.');
  }
  if (!Number.isSafeInteger(record.expectedObservedCount)
    || (record.expectedObservedCount as number) < 0
    || (record.expectedObservedCount as number) > 10_000) {
    throw new Error('Task 11 expected observation count is invalid.');
  }
  return value as Task11OperationUnit;
}

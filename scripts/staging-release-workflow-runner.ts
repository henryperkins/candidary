import { assertCanonicalRunId } from './staging-release-contract.ts';
import {
  TASK11_WORKFLOW_CASE_IDS,
  assertCompleteWorkflowMatrix,
  buildWorkflowMatrix,
  type Task11WorkflowCaseId,
} from './staging-release-workflows.ts';
import type { Task11MatrixObservation } from './task11-staging-release.ts';

export interface Task11ZeroProof {
  readonly legacyRows: 0;
  readonly blockingJobs: 0;
  readonly incompleteActiveSets: 0;
  readonly uploadsWithoutActiveSet: 0;
}

export interface Task11WorkflowExecutionAdapter {
  readonly lifecycle: (runId: string) => Promise<{
    readonly creationConfirmed: boolean;
    readonly automaticRetry: boolean;
    readonly deterministicProfileReplay: boolean;
    readonly retainedIdReplay: boolean;
    readonly pauseResume: boolean;
    readonly sameInstanceRestart: boolean;
    readonly platformStatuses: readonly string[];
  }>;
  readonly failedLookupMaterialization: (runId: string) => Promise<{
    readonly materialized: boolean;
    readonly retainedInstance: boolean;
  }>;
  readonly statusUnknownPreservation: (runId: string) => Promise<{
    readonly mutationCount: number;
    readonly recovery: string;
  }>;
  readonly bounds: (runId: string) => Promise<{
    readonly creationMinuteBlocked: boolean;
    readonly inFlightBlocked: boolean;
    readonly activeRunBlocked: boolean;
    readonly batchBlocked: boolean;
  }>;
  readonly deletionAndPurge: (runId: string) => Promise<{
    readonly deleteBeforeDispatch: boolean;
    readonly deleteAfterDispatch: boolean;
    readonly deleteBeforePreflight: boolean;
    readonly deleteAfterPreflight: boolean;
    readonly resumedFromCursor: boolean;
    readonly terminalBeforeR2: boolean;
    readonly r2BeforeRelational: boolean;
  }>;
  readonly replacementResolution: (runId: string) => Promise<{
    readonly enteredNeedsReplacement: boolean;
    readonly resolvedAfterSourceChanged: boolean;
  }>;
  readonly verificationClosure: (runId: string) => Promise<{
    readonly proof: Record<string, number>;
    readonly verifiedAt: string;
  }>;
}

export interface Task11WorkflowMatrixExecution {
  readonly observations: readonly Task11MatrixObservation[];
  readonly proof: Task11ZeroProof;
  readonly verifiedAt: string;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function allTrue(value: Record<string, unknown>): boolean {
  return Object.values(value).every((entry) => entry === true);
}

function exactZeroProof(value: Record<string, number>): Task11ZeroProof {
  const keys = Object.keys(value).sort();
  const expected = [
    'blockingJobs', 'incompleteActiveSets', 'legacyRows', 'uploadsWithoutActiveSet',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)
    || expected.some((key) => value[key] !== 0)) {
    throw new Error('TASK11_WORKFLOW_ZERO_PROOF_INCOMPLETE');
  }
  return value as unknown as Task11ZeroProof;
}

function observation(
  caseId: Task11WorkflowCaseId,
  observationCode: string,
): Task11MatrixObservation {
  return { caseId, status: 'passed', observationCode };
}

export async function executeTask11WorkflowMatrix(
  runIdInput: string,
  adapter: Task11WorkflowExecutionAdapter,
): Promise<Task11WorkflowMatrixExecution> {
  const runId = assertCanonicalRunId(runIdInput);
  assertCompleteWorkflowMatrix(buildWorkflowMatrix());

  const lifecycle = await adapter.lifecycle(runId);
  const lifecycleFlags = {
    creationConfirmed: lifecycle.creationConfirmed,
    automaticRetry: lifecycle.automaticRetry,
    deterministicProfileReplay: lifecycle.deterministicProfileReplay,
    retainedIdReplay: lifecycle.retainedIdReplay,
    pauseResume: lifecycle.pauseResume,
    sameInstanceRestart: lifecycle.sameInstanceRestart,
  };
  if (!allTrue(lifecycleFlags)) throw new Error('TASK11_WORKFLOW_LIFECYCLE_PROOF_INCOMPLETE');
  const statuses = new Set(lifecycle.platformStatuses);
  for (const status of ['running', 'paused', 'terminated', 'complete']) {
    if (!statuses.has(status)) throw new Error('TASK11_WORKFLOW_STATUS_PROOF_INCOMPLETE');
  }

  const failedLookup = await adapter.failedLookupMaterialization(runId);
  if (failedLookup.materialized !== true || failedLookup.retainedInstance !== true) {
    throw new Error('TASK11_WORKFLOW_FAILED_LOOKUP_PROOF_INCOMPLETE');
  }
  const statusUnknown = await adapter.statusUnknownPreservation(runId);
  if (statusUnknown.mutationCount !== 0 || statusUnknown.recovery !== 'none') {
    throw new Error('TASK11_WORKFLOW_STATUS_UNKNOWN_MUTATED');
  }

  const bounds = await adapter.bounds(runId);
  if (!allTrue({ ...bounds })) throw new Error('TASK11_WORKFLOW_BOUND_PROOF_INCOMPLETE');

  const purge = await adapter.deletionAndPurge(runId);
  if (!allTrue({ ...purge })) throw new Error('TASK11_WORKFLOW_PURGE_PROOF_INCOMPLETE');

  const replacement = await adapter.replacementResolution(runId);
  if (!allTrue({ ...replacement })) throw new Error('TASK11_WORKFLOW_REPLACEMENT_PROOF_INCOMPLETE');

  const verification = await adapter.verificationClosure(runId);
  const proof = exactZeroProof(verification.proof);
  if (!ISO_INSTANT.test(verification.verifiedAt)
    || new Date(verification.verifiedAt).toISOString() !== verification.verifiedAt) {
    throw new Error('TASK11_WORKFLOW_VERIFICATION_TIME_INVALID');
  }

  const byCase = new Map<Task11WorkflowCaseId, string>([
    ['creation-confirmation', 'real-create-confirmed'],
    ['automatic-step-retry', 'real-fail-once-retried'],
    ['deterministic-profile-replay', 'real-profile-replay-stable'],
    ['retained-id-replay', 'real-retained-id-skipped'],
    ['pause-resume', 'real-instance-paused-resumed'],
    ['same-instance-restart', 'real-instance-terminated-restarted'],
    ['platform-status-observations', 'real-and-deployed-status-map-closed'],
    ['failed-lookup-materialization', 'real-failed-lookup-idempotently-materialized'],
    ['status-unknown-preservation', 'deployed-status-unknown-preserved'],
    ['creation-minute-bound', 'd1-minute-bound-refused'],
    ['inflight-bound', 'd1-inflight-bound-refused'],
    ['active-run-bound', 'd1-active-run-bound-refused'],
    ['batch-bound', 'deployed-batch-bound-refused'],
    ['delete-before-dispatch', 'deployed-delete-before-dispatch-closed'],
    ['delete-after-dispatch', 'deployed-delete-after-dispatch-closed'],
    ['delete-before-preflight', 'deployed-delete-before-preflight-closed'],
    ['delete-after-preflight', 'deployed-delete-after-preflight-closed'],
    ['purge-resumability', 'deployed-purge-cursor-resumed'],
    ['purge-terminal-ordering', 'deployed-terminal-r2-relational-order'],
    ['needs-replacement-resolution', 'deployed-replacement-resolved'],
    ['verification-closure', 'worker-written-four-zero-closure'],
  ]);
  const observations = TASK11_WORKFLOW_CASE_IDS.map((caseId) => (
    observation(caseId, byCase.get(caseId)!)
  ));
  return { observations, proof, verifiedAt: verification.verifiedAt };
}

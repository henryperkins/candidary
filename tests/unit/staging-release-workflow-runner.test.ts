import { describe, expect, it, vi } from 'vitest';

import {
  executeTask11WorkflowMatrix,
  type Task11WorkflowExecutionAdapter,
} from '../../scripts/staging-release-workflow-runner';
import { TASK11_WORKFLOW_CASE_IDS } from '../../scripts/staging-release-workflows';

const RUN_ID = '12345678-1234-4123-8123-123456789abc';
const VERIFIED_AT = '2026-08-11T03:00:00.000Z';

function passingAdapter(): Task11WorkflowExecutionAdapter {
  return {
    lifecycle: vi.fn(async () => ({
      creationConfirmed: true,
      automaticRetry: true,
      deterministicProfileReplay: true,
      retainedIdReplay: true,
      pauseResume: true,
      sameInstanceRestart: true,
      platformStatuses: ['running', 'paused', 'terminated', 'complete'],
    })),
    failedLookupMaterialization: vi.fn(async () => ({
      materialized: true,
      retainedInstance: true,
    })),
    statusUnknownPreservation: vi.fn(async () => ({
      mutationCount: 0,
      recovery: 'none',
    })),
    bounds: vi.fn(async () => ({
      creationMinuteBlocked: true,
      inFlightBlocked: true,
      activeRunBlocked: true,
      batchBlocked: true,
    })),
    deletionAndPurge: vi.fn(async () => ({
      deleteBeforeDispatch: true,
      deleteAfterDispatch: true,
      deleteBeforePreflight: true,
      deleteAfterPreflight: true,
      resumedFromCursor: true,
      terminalBeforeR2: true,
      r2BeforeRelational: true,
    })),
    replacementResolution: vi.fn(async () => ({
      enteredNeedsReplacement: true,
      resolvedAfterSourceChanged: true,
    })),
    verificationClosure: vi.fn(async () => ({
      proof: {
        legacyRows: 0,
        blockingJobs: 0,
        incompleteActiveSets: 0,
        uploadsWithoutActiveSet: 0,
      },
      verifiedAt: VERIFIED_AT,
    })),
  };
}

describe('Task 11 live Workflow matrix reducer', () => {
  it('emits the exact closed case set only after every live proof closes', async () => {
    const result = await executeTask11WorkflowMatrix(RUN_ID, passingAdapter());

    expect(result.observations.map(({ caseId }) => caseId)).toEqual(TASK11_WORKFLOW_CASE_IDS);
    expect(result.proof).toEqual({
      legacyRows: 0,
      blockingJobs: 0,
      incompleteActiveSets: 0,
      uploadsWithoutActiveSet: 0,
    });
    expect(result.verifiedAt).toBe(VERIFIED_AT);
  });

  it('fails closed instead of converting a partial remote result into passed evidence', async () => {
    const adapter: Task11WorkflowExecutionAdapter = {
      ...passingAdapter(),
      deletionAndPurge: vi.fn(async () => ({
      deleteBeforeDispatch: true,
      deleteAfterDispatch: true,
      deleteBeforePreflight: true,
      deleteAfterPreflight: true,
      resumedFromCursor: true,
      terminalBeforeR2: false,
      r2BeforeRelational: true,
      })),
    };

    await expect(executeTask11WorkflowMatrix(RUN_ID, adapter))
      .rejects.toThrow('TASK11_WORKFLOW_PURGE_PROOF_INCOMPLETE');
  });
});

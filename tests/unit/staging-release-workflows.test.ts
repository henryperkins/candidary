import { describe, expect, it } from 'vitest';

import {
  TASK11_WORKFLOW_CASE_IDS,
  assertCompleteWorkflowMatrix,
  assertSafeOperationUnit,
  buildWorkflowMatrix,
  makeOperationUnit,
} from '../../scripts/staging-release-workflows';

const RUN_ID = '12345678-1234-4123-8123-123456789abc';

describe('Task 11 Workflow and ledger matrix', () => {
  it('covers every deployed lifecycle, bound, purge, and proof requirement exactly once', () => {
    const matrix = buildWorkflowMatrix();
    expect(matrix.map((entry) => entry.caseId)).toEqual(TASK11_WORKFLOW_CASE_IDS);
    expect(assertCompleteWorkflowMatrix(matrix)).toEqual({
      lifecycle: true,
      reconciliation: true,
      bounds: true,
      deletionAndPurge: true,
      replacementResolution: true,
      verificationClosure: true,
    });
  });

  it('rejects a missing, duplicate, or foreign case', () => {
    const matrix = buildWorkflowMatrix();
    expect(() => assertCompleteWorkflowMatrix(matrix.slice(1))).toThrow(/missing/u);
    expect(() => assertCompleteWorkflowMatrix([...matrix, matrix[0]!])).toThrow(/duplicate/u);
    expect(() => assertCompleteWorkflowMatrix([
      ...matrix,
      { ...matrix[0]!, caseId: 'foreign-case' },
    ] as never)).toThrow(/unknown/u);
  });
});

describe('Task 11 manifest-bound operation units', () => {
  it('accepts only canonical run-owned SQL files with a direct observation', () => {
    const unit = makeOperationUnit({
      runId: RUN_ID,
      caseId: 'creation-confirmation',
      sequence: 1,
      mutationSql: "UPDATE event_cover_backfill_jobs SET dispatch_state = 'creating' WHERE run_id = '12345678-1234-4123-8123-123456789abc';",
      observationSql: "SELECT count(*) AS observed_count FROM event_cover_backfill_jobs WHERE run_id = '12345678-1234-4123-8123-123456789abc' AND dispatch_state = 'creating';",
      expectedObservedCount: 1,
    });

    expect(assertSafeOperationUnit(unit, RUN_ID)).toEqual(unit);
    expect(unit.mutationPath).toBe('operations/01-creation-confirmation-mutate.sql');
    expect(unit.observationPath).toBe('operations/01-creation-confirmation-observe.sql');
    expect(unit.mutationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(unit.observationSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects production identities, unguarded mutation, arbitrary commands, and digest drift', () => {
    const base = makeOperationUnit({
      runId: RUN_ID,
      caseId: 'creation-confirmation',
      sequence: 1,
      mutationSql: "DELETE FROM event_cover_backfill_jobs WHERE run_id = '12345678-1234-4123-8123-123456789abc';",
      observationSql: "SELECT count(*) AS observed_count FROM event_cover_backfill_jobs WHERE run_id = '12345678-1234-4123-8123-123456789abc';",
      expectedObservedCount: 0,
    });

    expect(() => assertSafeOperationUnit({ ...base, databaseName: 'candidary-core' }, RUN_ID))
      .toThrow(/production/u);
    expect(() => assertSafeOperationUnit({
      ...base,
      mutationSql: 'DELETE FROM event_cover_backfill_jobs;',
    }, RUN_ID)).toThrow(/run guard/u);
    expect(() => assertSafeOperationUnit({
      ...base,
      command: ['npx', 'wrangler', 'd1', 'execute'],
    } as never, RUN_ID)).toThrow(/field/u);
    expect(() => assertSafeOperationUnit({ ...base, mutationSha256: '0'.repeat(64) }, RUN_ID))
      .toThrow(/digest/u);
  });
});

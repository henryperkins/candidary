import { describe, expect, it } from 'vitest';

import * as stagingLive from '../../scripts/staging-release-live';

type FreshnessContract = {
  readonly LOCAL_CALLER_HEADERS?: Readonly<Record<string, string>>;
  readonly STAGING_DATABASE_FRESHNESS_SQL?: string;
  readonly WORKFLOW_SOURCE_CASE_ID?: string;
  readonly assertFreshStagingDatabase?: (
    rows: readonly Readonly<Record<string, unknown>>[],
  ) => void;
  readonly workflowWaitDecision?: (
    status: string,
    expected: readonly string[],
  ) => 'expected' | 'continue';
  readonly controlWorkflowBeforeTerminal?: (
    caller: { call(method: string, input: Record<string, unknown>): Promise<unknown> },
    runId: string,
    caseId: string,
    method: 'pauseBackfill' | 'terminateBackfill',
    controlledStatus: 'paused' | 'terminated',
  ) => Promise<{ status: string; observed: string[] }>;
};

describe('Task 11 live staging preflight', () => {
  it('does not reuse Wrangler remote-preview proxy connections between RPCs', () => {
    const contract = stagingLive as FreshnessContract;
    expect(contract.LOCAL_CALLER_HEADERS).toEqual({
      connection: 'close',
      'content-type': 'application/json',
    });
  });

  it('uses D1-supported quick_check and refuses any non-clean staging database', () => {
    const contract = stagingLive as FreshnessContract;
    expect(contract.STAGING_DATABASE_FRESHNESS_SQL).toBeDefined();
    expect(contract.STAGING_DATABASE_FRESHNESS_SQL).toContain('PRAGMA quick_check;');
    expect(contract.STAGING_DATABASE_FRESHNESS_SQL).not.toMatch(/integrity_check/u);
    expect(contract.assertFreshStagingDatabase).toBeTypeOf('function');

    expect(() => contract.assertFreshStagingDatabase!([
      { quick_check: 'ok' },
      { event_count: 0 },
    ])).not.toThrow();
    for (const rows of [
      [{ integrity: 'ok' }, { event_count: 0 }],
      [{ quick_check: 'corrupt' }, { event_count: 0 }],
      [{ quick_check: 'ok' }, { event_count: 1 }],
    ]) {
      expect(() => contract.assertFreshStagingDatabase!(rows))
        .toThrow(/STAGING_DATABASE_NOT_FRESH/u);
    }
  });

  it('uses the fixture already proven across every render profile for Workflow cases', () => {
    const contract = stagingLive as FreshnessContract;
    expect(contract.WORKFLOW_SOURCE_CASE_ID).toBe('geometry-complete-2x');
  });

  it('stops immediately when a Workflow reports a terminal error', () => {
    const contract = stagingLive as FreshnessContract;
    expect(contract.workflowWaitDecision).toBeTypeOf('function');
    expect(contract.workflowWaitDecision!('running', ['complete'])).toBe('continue');
    expect(contract.workflowWaitDecision!('complete', ['complete'])).toBe('expected');
    expect(() => contract.workflowWaitDecision!('errored', ['complete']))
      .toThrow(/TASK11_WORKFLOW_ERRORED/u);
    expect(() => contract.workflowWaitDecision!('complete', ['paused']))
      .toThrow(/TASK11_WORKFLOW_COMPLETED_BEFORE_CONTROL/u);
  });

  it('issues Workflow control while active-state observation is still pending', async () => {
    const contract = stagingLive as FreshnessContract;
    expect(contract.controlWorkflowBeforeTerminal).toBeTypeOf('function');
    let releaseLookup!: () => void;
    const controlStarted = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const calls: string[] = [];
    const caller = {
      async call(method: string) {
        calls.push(method);
        if (method === 'workflowLookup') {
          await controlStarted;
          return { status: 'paused' };
        }
        if (method === 'pauseBackfill') {
          releaseLookup();
          return {};
        }
        throw new Error(`Unexpected method ${method}`);
      },
    };

    await expect(contract.controlWorkflowBeforeTerminal!(
      caller, 'run', 'case', 'pauseBackfill', 'paused',
    )).resolves.toMatchObject({ status: 'paused', observed: ['paused'] });
    expect(calls.slice(0, 2)).toEqual(['workflowLookup', 'pauseBackfill']);
  });
});

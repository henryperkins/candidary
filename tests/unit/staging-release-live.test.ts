import { describe, expect, it } from 'vitest';

import * as stagingLive from '../../scripts/staging-release-live';

type FreshnessContract = {
  readonly STAGING_DATABASE_FRESHNESS_SQL?: string;
  readonly assertFreshStagingDatabase?: (
    rows: readonly Readonly<Record<string, unknown>>[],
  ) => void;
};

describe('Task 11 live staging preflight', () => {
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
});

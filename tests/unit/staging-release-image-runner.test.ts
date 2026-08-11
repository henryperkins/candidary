import { describe, expect, it, vi } from 'vitest';

import { buildImageMatrix } from '../../scripts/staging-release-images';
import { task11FixturePlan } from '../../scripts/staging-release-fixtures';
import {
  executeTask11ImageMatrix,
  type Task11ImageExecutionAdapter,
} from '../../scripts/staging-release-image-runner';

const RUN_ID = '12345678-1234-4123-8123-123456789abc';

function accepted(caseId: string, rung = 1, adopted = false) {
  return {
    caseId,
    outcome: 'accepted' as const,
    resultCode: null,
    detectedType: null,
    format: 'webp' as const,
    width: 1200,
    height: 800,
    byteSize: 1234,
    sha256: 'a'.repeat(64),
    qualityRung: rung,
    adopted,
  };
}

describe('Task 11 deployed Images executor', () => {
  it('executes and validates every planned case through the closed RPC surface', async () => {
    const plan = task11FixturePlan();
    const matrix = buildImageMatrix(plan);
    const rung = new Map(matrix.map((entry) => [entry.caseId, entry.expectedRung ?? 1]));
    const profileCalls = new Map<string, number>();
    const adapter: Task11ImageExecutionAdapter = {
      uploadFixture: vi.fn(async () => undefined),
      verifyStoredResult: vi.fn(async () => ({ checksumMatches: true, metadataStripped: true })),
      rpc: vi.fn(async (method, input) => {
        const caseId = input.caseId as string;
        if (method === 'inspectImageCase') {
          if (caseId === 'boundary-over-19000001' || caseId.startsWith('reject-')) {
            return { ...accepted(caseId), outcome: 'rejected', resultCode: 'COVER_SOURCE_UNSUPPORTED',
              detectedType: null, format: null, width: null, height: null, byteSize: null,
              sha256: null, qualityRung: null, adopted: false };
          }
          return { ...accepted(caseId), detectedType: 'image/jpeg', format: null, qualityRung: null };
        }
        if (method === 'normalizeImageCase') return accepted(caseId, rung.get(caseId));
        if (method === 'renderPreviewCase') return accepted(caseId, rung.get(caseId));
        const calls = (profileCalls.get(caseId) ?? 0) + 1;
        profileCalls.set(caseId, calls);
        if (caseId === 'no-upscale') {
          return { ...accepted(caseId), outcome: 'rejected', resultCode: 'COVER_OUTPUT_BUDGET_EXHAUSTED',
            format: null, width: null, height: null, byteSize: null, sha256: null,
            qualityRung: null, adopted: false };
        }
        return accepted(caseId, rung.get(caseId), caseId === 'conditional-create-adoption' && calls > 1);
      }),
    };

    const results = await executeTask11ImageMatrix(RUN_ID, plan, adapter);
    expect(results).toHaveLength(matrix.length);
    expect(results.every((result) => result.status === 'passed')).toBe(true);
    expect(adapter.uploadFixture).toHaveBeenCalledTimes(matrix.length);
    expect(profileCalls.get('conditional-create-adoption')).toBe(2);
  });

  it('fails closed on a wrong rung, checksum, metadata, or adoption observation', async () => {
    const plan = task11FixturePlan();
    const adapter: Task11ImageExecutionAdapter = {
      uploadFixture: async () => undefined,
      verifyStoredResult: async () => ({ checksumMatches: false, metadataStripped: true }),
      rpc: async (_method, input) => accepted(input.caseId as string, 99),
    };
    await expect(executeTask11ImageMatrix(RUN_ID, plan, adapter)).rejects.toThrow(/image case/u);
  });
});

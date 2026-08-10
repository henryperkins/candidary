import { describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../../worker/env';
import {
  StagingConformanceService,
  scopedConformanceBucket,
  type StagingConformanceDependencies,
} from '../../worker/staging-conformance';
import { STAGING_ORIGIN } from '../../shared/staging-conformance';
import { testEnv } from './helpers';

const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const TEST_BUILD_SHA = '0123456789abcdef0123456789abcdef01234567';
const VERSION_ID = '1000000a-0000-4000-8000-000000000002';

function env(origin: string = STAGING_ORIGIN): AppEnv {
  return new Proxy(testEnv, {
    get(target, property, receiver) {
      if (property === 'APP_ORIGIN') return origin;
      if (property === 'CF_VERSION_METADATA') {
        return {
          id: VERSION_ID,
          tag: TEST_BUILD_SHA,
          timestamp: '2026-08-10T12:00:00.000Z',
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function dependencies(overrides: Partial<StagingConformanceDependencies> = {}): StagingConformanceDependencies {
  return {
    async readSourceInfo() { return { format: 'image/png', width: 2400, height: 1600 }; },
    async normalizeMaster() {
      return {
        objectKey: 'must-not-escape', byteSize: 1234, width: 2400, height: 1600,
        sha256: 'a'.repeat(64), rung: 2, normalizationVersion: 1,
      };
    },
    async renderPreview() {
      return {
        objectKey: 'must-not-escape', byteSize: 777, width: 1200, height: 800,
        sha256: 'b'.repeat(64), rung: 3, recipeVersion: 1,
      };
    },
    async renderProfile() {
      return {
        objectKey: 'must-not-escape', profile: 'short-lookup', density: '1x',
        format: 'webp', contentType: 'image/webp', byteSize: 456, width: 360,
        height: 168, sha256: 'c'.repeat(64), rung: 1, adopted: false,
      };
    },
    backfillWorkflow() {
      return {
        async lookup() { return { kind: 'status' as const, status: 'running' }; },
        async createBatch() {},
        async resume() {},
        async restart() {},
        async terminate() {},
      };
    },
    async scheduledCleanup() {},
    async readSummary() {
      return {
        legacyCovers: 0, unresolvedJobs: 0, unresolvedFences: 0,
        needsReplacement: 0, purgeRows: 0,
      };
    },
    ...overrides,
  };
}

describe('staging conformance RPC service', () => {
  it('maps every logical R2 operation beneath the physical run prefix', async () => {
    const scoped = scopedConformanceBucket(testEnv.MEDIA_BUCKET, RUN_ID);
    const logicalKey = 'events/owned/cover/master.webp';
    const physicalKey = `conformance/${RUN_ID}/${logicalKey}`;
    await scoped.put(logicalKey, new Uint8Array([1, 2, 3]));

    expect(await testEnv.MEDIA_BUCKET.head(logicalKey)).toBeNull();
    expect((await testEnv.MEDIA_BUCKET.head(physicalKey))?.size).toBe(3);
    expect((await scoped.head(logicalKey))?.key).toBe(logicalKey);
    const listed = await scoped.list({ prefix: 'events/' });
    expect(listed.objects.map((object) => object.key)).toContain(logicalKey);

    await scoped.delete(logicalKey);
    expect(await testEnv.MEDIA_BUCKET.head(physicalKey)).toBeNull();
    expect(() => scoped.put('../foreign', new Uint8Array([1]))).toThrow(/R2_SCOPE/u);
    expect(() => scoped.createMultipartUpload(logicalKey)).toThrow(/METHOD_DISABLED/u);
  });

  it('fails closed on production origin before calling any dependency or binding', async () => {
    const normalizeMaster = vi.fn(dependencies().normalizeMaster);
    const backfillWorkflow = vi.fn(dependencies().backfillWorkflow);
    const service = new StagingConformanceService(
      env('https://candidary.app'),
      dependencies({ normalizeMaster, backfillWorkflow }),
    );

    await expect(service.normalizeImageCase({
      runId: RUN_ID, caseId: 'opaque-png', declaredMimeType: 'image/png',
    })).rejects.toThrow('STAGING_CONFORMANCE_DISABLED');
    await expect(service.workflowLookup({ runId: RUN_ID, caseId: 'lookup-active' }))
      .rejects.toThrow('STAGING_CONFORMANCE_DISABLED');
    expect(normalizeMaster).not.toHaveBeenCalled();
    expect(backfillWorkflow).not.toHaveBeenCalled();
  });

  it('rejects malformed run and case identifiers before calling dependencies', async () => {
    const normalizeMaster = vi.fn(dependencies().normalizeMaster);
    const service = new StagingConformanceService(env(), dependencies({ normalizeMaster }));
    await expect(service.normalizeImageCase({
      runId: RUN_ID.toUpperCase(), caseId: 'opaque-png', declaredMimeType: 'image/png',
    })).rejects.toThrow('STAGING_CONFORMANCE_INPUT_INVALID');
    await expect(service.normalizeImageCase({
      runId: RUN_ID, caseId: '../foreign', declaredMimeType: 'image/png',
    })).rejects.toThrow('STAGING_CONFORMANCE_INPUT_INVALID');
    expect(normalizeMaster).not.toHaveBeenCalled();
  });

  it('rejects profile zoom beyond the product maximum before rendering', async () => {
    const renderProfile = vi.fn(dependencies().renderProfile);
    const service = new StagingConformanceService(env(), dependencies({ renderProfile }));
    await expect(service.renderProfileCase({
      runId: RUN_ID, caseId: 'zoom-over-limit', effect: 'natural',
      profile: 'short-lookup', density: '1x', format: 'webp',
      focus: { x: 0.5, y: 0.5, zoom: 2.01 },
      master: { width: 2400, height: 1600 },
    })).rejects.toThrow('STAGING_CONFORMANCE_INPUT_INVALID');
    expect(renderProfile).not.toHaveBeenCalled();
  });

  it('correlates runtime version metadata with the immutable build identity', () => {
    const service = new StagingConformanceService(env(), dependencies());
    expect(service.runtimeIdentity({ runId: RUN_ID })).toEqual({
      versionId: VERSION_ID,
      versionTag: TEST_BUILD_SHA,
      versionTimestamp: '2026-08-10T12:00:00.000Z',
    });
  });

  it('delegates normalization to the shared pipeline with a physically scoped R2 binding', async () => {
    const normalizeMaster = vi.fn(dependencies().normalizeMaster);
    const service = new StagingConformanceService(env(), dependencies({ normalizeMaster }));
    const result = await service.normalizeImageCase({
      runId: RUN_ID, caseId: 'opaque-png', declaredMimeType: 'image/png',
    });

    expect(normalizeMaster).toHaveBeenCalledOnce();
    const [scopedEnv, input] = normalizeMaster.mock.calls[0]!;
    expect(scopedEnv.MEDIA_BUCKET).not.toBe(testEnv.MEDIA_BUCKET);
    expect(input).toMatchObject({ declaredMimeType: 'image/png' });
    expect(input.rawKey).toBe('fixtures/opaque-png');
    expect(result).toEqual({
      caseId: 'opaque-png', outcome: 'accepted', detectedType: null,
      resultCode: null,
      format: 'webp', width: 2400, height: 1600, byteSize: 1234,
      sha256: 'a'.repeat(64), qualityRung: 2, adopted: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/objectKey|must-not-escape|message|url/iu);
  });

  it('delegates preview and profile work and returns only closed measurements', async () => {
    const renderPreview = vi.fn(dependencies().renderPreview);
    const renderProfile = vi.fn(dependencies().renderProfile);
    const service = new StagingConformanceService(
      env(), dependencies({ renderPreview, renderProfile }),
    );
    const preview = await service.renderPreviewCase({
      runId: RUN_ID, caseId: 'preview-rung-3', effect: 'warm',
    });
    const profile = await service.renderProfileCase({
      runId: RUN_ID, caseId: 'profile-short', effect: 'natural',
      profile: 'short-lookup', density: '1x', format: 'webp',
      focus: { x: 0.5, y: 0.5, zoom: 1 },
      master: { width: 2400, height: 1600 },
    });
    expect(renderPreview).toHaveBeenCalledOnce();
    expect(renderProfile).toHaveBeenCalledOnce();
    expect(preview).toMatchObject({ caseId: 'preview-rung-3', qualityRung: 3 });
    expect(profile).toMatchObject({ caseId: 'profile-short', qualityRung: 1, adopted: false });
    expect(JSON.stringify([preview, profile])).not.toMatch(/objectKey|must-not-escape/iu);
  });

  it('reduces expected image failures to codes and hides every raw error detail', async () => {
    const expected = Object.assign(new Error('private fixture path and platform detail'), {
      code: 'COVER_SOURCE_UNSUPPORTED',
    });
    const service = new StagingConformanceService(env(), dependencies({
      async normalizeMaster() { throw expected; },
    }));
    const rejected = await service.normalizeImageCase({
      runId: RUN_ID, caseId: 'rejected-heif', declaredMimeType: 'image/heif',
    });
    expect(rejected).toEqual({
      caseId: 'rejected-heif', outcome: 'rejected',
      resultCode: 'COVER_SOURCE_UNSUPPORTED', detectedType: null, format: null,
      width: null, height: null, byteSize: null, sha256: null,
      qualityRung: null, adopted: false,
    });
    expect(JSON.stringify(rejected)).not.toMatch(/private|fixture path|platform detail|message/iu);

    const unknown = new StagingConformanceService(env(), dependencies({
      async normalizeMaster() { throw new Error('raw platform failure'); },
    }));
    await expect(unknown.normalizeImageCase({
      runId: RUN_ID, caseId: 'unknown-failure', declaredMimeType: 'image/png',
    })).rejects.toThrow('STAGING_CONFORMANCE_CASE_FAILED');
  });

  it('uses the shared Workflow accessor for closed lifecycle operations', async () => {
    const accessor = dependencies().backfillWorkflow(env());
    const createBatch = vi.spyOn(accessor, 'createBatch');
    const resume = vi.spyOn(accessor, 'resume');
    const restart = vi.spyOn(accessor, 'restart');
    const terminate = vi.spyOn(accessor, 'terminate');
    const service = new StagingConformanceService(
      env(), dependencies({ backfillWorkflow: () => accessor }),
    );

    await expect(service.workflowLookup({ runId: RUN_ID, caseId: 'lookup-active' }))
      .resolves.toEqual({ caseId: 'lookup-active', status: 'running' });
    await service.createBackfillBatch({ runId: RUN_ID, caseId: 'batch-recovery', count: 2 });
    await service.resumeBackfill({ runId: RUN_ID, caseId: 'pause-resume' });
    await service.restartBackfill({ runId: RUN_ID, caseId: 'restart-retained' });
    await service.terminateBackfill({ runId: RUN_ID, caseId: 'terminate-retained' });
    expect(createBatch).toHaveBeenCalledOnce();
    expect(createBatch.mock.calls[0]![0]).toHaveLength(2);
    expect(resume).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('invokes the shared scheduled cleanup path and returns aggregate counts only', async () => {
    const scheduledCleanup = vi.fn(dependencies().scheduledCleanup);
    const readSummary = vi.fn(dependencies().readSummary);
    const service = new StagingConformanceService(
      env(), dependencies({ scheduledCleanup, readSummary }),
    );
    const result = await service.runScheduledCleanup({
      runId: RUN_ID, now: '2026-08-10T12:00:00.000Z',
    });
    expect(scheduledCleanup).toHaveBeenCalledOnce();
    expect(readSummary).toHaveBeenCalledOnce();
    expect(result).toEqual({
      legacyCovers: 0, unresolvedJobs: 0, unresolvedFences: 0,
      needsReplacement: 0, purgeRows: 0,
    });
  });
});

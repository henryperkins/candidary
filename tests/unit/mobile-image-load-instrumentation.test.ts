import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node rehearsal script is exercised through its runtime interface.
import { buildLoadPlan, assessLoadEvidence, verifyLoadArtifacts, REQUIRED_METRICS } from '../../scripts/mobile-image-load-harness.mjs';
// @ts-expect-error Node rehearsal script is exercised through its runtime interface.
import { PRICING, PREVIEW_SCOPE, analyticsEngineQueries, graphqlQuery, buildInstrumentation, exportDeploymentMetrics, scopeFromAuthorizations } from '../../scripts/mobile-image-load-instrumentation.mjs';
// @ts-expect-error Node rehearsal script is exercised through its runtime interface.
import { bundleObservations, buildLoadReport } from '../../scripts/mobile-image-load-report.mjs';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
type Row = Record<string, unknown>;
type Scenario = { name: string; metrics: Record<string, number>; window: { startedAt: string; endedAt: string } };
const identity = { buildFingerprint: 'a'.repeat(64), imageRef: `registry.example/decoder@sha256:${'b'.repeat(64)}` };
const versions = { harness: 'sha256:unit', worker: 'unit-version', decoder: 'unit-decoder' };
const events = (prefix: string) => Array.from({ length: 6 }, (_, index) => `${prefix}_event_${index}`);
const scope = { kind: 'candidary.image-load-scope', environment: 'preview', imageDataset: 'candidary_image_metrics_preview',
  decoderDataset: 'candidary_image_decoder_preview', mainScript: 'candidary-preview', buckets: ['candidary-preview-media', 'candidary-preview-media-canonical'],
  containers: { instanceType: 'standard-2', pools: { upload: 2, preview: 2 }, sleepAfterSeconds: 600 },
  eventIds: { cold: events('gallery'), warm: events('gallery'), mixed: [...events('gallery'), ...events('upload')] } };
const windows: Record<string, { startedAt: string; endedAt: string }> = {
  cold: { startedAt: '2026-09-25T00:00:00.000Z', endedAt: '2026-09-25T04:00:00.000Z' },
  warm: { startedAt: '2026-09-25T05:00:00.000Z', endedAt: '2026-09-25T06:00:00.000Z' },
  mixed: { startedAt: '2026-09-25T07:00:00.000Z', endedAt: '2026-09-25T11:00:00.000Z' } };

/** SCHEMA PROOF ONLY: fabricated observations/exports exercise the pipeline shape. They are never qualification evidence. */
function syntheticObservations(name: string) {
  const plan = { ...buildLoadPlan({ scenario: name }), live: true };
  const uploads = name === 'warm' ? 0 : 10000;
  return { kind: 'mobile-image-load-observations', harnessVersion: 1, complete: false, qualification: 'missing', plan, window: windows[name],
    concurrency: { upload: { configured: 4, maxActive: 4, meanActive: 3.9 }, preview: { configured: 8, maxActive: 8, meanActive: 7.5 },
      control: { configured: 1, maxActive: 1, meanActive: 0.2 }, probe: { configured: 1, maxActive: 1, meanActive: 0.1 } },
    uploads: Array.from({ length: uploads }, (_, index) => ({ index, ok: true, elapsedMs: 20000 + index % 97, verificationMs: 30000 + index % 89,
      sourceBytes: [25, 50, 75][index % 3]! * MiB, receiptVerified: true, hashVerified: true })),
    previews: Array.from({ length: 48000 }, (_, index) => ({ index, ok: !(name === 'mixed' && index === 7), elapsedMs: 120 + index % 50,
      previewHit: !(name === 'mixed' && index === 7), previewPrivate: !(name === 'mixed' && index === 7) })),
    controls: Array.from({ length: 200 }, (_, index) => ({ index, ok: true, elapsedMs: 900 + index % 20, phase: index < 100 ? 'baseline' : 'during' })),
    probes: [...Array(50).fill('privacy'), ...Array(10).fill('deletion'), ...Array(10).fill('cancellation'), ...Array(plan.controls.regenerationSeeds).fill('regeneration-seed')]
      .map((kind, index) => ({ index, kind, ok: true, elapsedMs: 300, violation: false })) };
}
function syntheticExport(name: string, changes: { image?: Row[]; decoder?: Row[]; main?: Row[]; window?: object } = {}) {
  const originals = name === 'warm' ? 0 : 10000;
  const hits = name === 'mixed' ? 47999 : 48000;
  const image = changes.image ?? [{ kind: 'preview-read', label: 'persisted-hit', points: String(hits), bytes: String(hits * 200_000), maxSampleInterval: '1' },
    ...(name === 'mixed' ? [{ kind: 'preview-read', label: 'miss-regeneration', points: '1', bytes: '0', maxSampleInterval: '1' }] : []),
    ...(originals ? [{ kind: 'original-read', label: 'native-decode', points: String(originals), bytes: String(499_975 * MiB), maxSampleInterval: '1' },
      { kind: 'original-read', label: 'original-download', points: String(originals), bytes: String(499_975 * MiB), maxSampleInterval: '1' }] : []),
    { kind: 'preview-read', label: 'denied', points: '35', bytes: '0', maxSampleInterval: '1' }];
  const decoder = changes.decoder ?? (originals ? [
    { poolLane: 'upload/upload', path: 'preview', outcome: 'ok', jobs: String(originals), nativeMs: String(originals * 9000), peakRssBytes: String(2.5 * GiB), peakScratchBytes: String(300 * MiB), sourceBytes: String(499_975 * MiB), maxSampleInterval: '1' },
    { poolLane: 'upload/upload', path: 'preview', outcome: 'busy', jobs: '40', nativeMs: '0', peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' },
    ...(name === 'mixed' ? [{ poolLane: 'preview/preview', path: 'preview', outcome: 'ok', jobs: '20', nativeMs: '100000', peakRssBytes: String(GiB), peakScratchBytes: String(30 * MiB), sourceBytes: String(20 * 20 * MiB), maxSampleInterval: '1' }] : []),
  ] : []);
  const r2 = [{ sum: { requests: originals * 12 }, dimensions: { actionType: 'UploadPart' } },
    { sum: { requests: 48000 + originals * 4 }, dimensions: { actionType: 'GetObject' } },
    { sum: { requests: 100 }, dimensions: { actionType: 'DeleteObject' } }];
  const window = changes.window ?? windows[name];
  return { name, window, queries: { ...analyticsEngineQueries({ scope, name, window }), graphql: graphqlQuery({ scope, window }) },
    imageMetrics: { meta: [], data: image, rows: image.length },
    decoderMetrics: { meta: [], data: decoder, rows: decoder.length },
    graphql: { data: { viewer: { accounts: [{ main: changes.main ?? [{ sum: { requests: 48000 + originals * 16 + 290, errors: 3 } }],
      legacy: r2, canonical: r2 }] } }, errors: null } };
}
const exportsFor = (overrides: Record<string, object> = {}) => ({ kind: 'mobile-image-load-deployment-export', exportedAt: '2026-09-25T12:00:00.000Z', scope,
  scenarios: ['cold', 'warm', 'mixed'].map(name => overrides[name] ?? syntheticExport(name)) });
// Built lazily so a defect in the report module fails individual tests rather than module loading.
let cachedBundle: ReturnType<typeof bundleObservations> | undefined;
const synthetic = () => (cachedBundle ??= bundleObservations(identity, ['cold', 'warm', 'mixed'].map(syntheticObservations)));
const chain = (overrides: Record<string, object> = {}) => {
  const bundle = synthetic();
  const instrumentation = buildInstrumentation({ bundle, exports: exportsFor(overrides), scope, pricing: PRICING });
  const report = buildLoadReport({ bundle, instrumentation, versions });
  return { instrumentation, report, metrics: (name: string) => report.scenarios.find((item: Scenario) => item.name === name).metrics };
};

describe('deployment instrumentation and load report', () => {
  it('SCHEMA PROOF ONLY: a complete synthetic chain binds observations, exports and report and passes the unchanged gate', () => {
    const bundle = synthetic();
    const { instrumentation, report, metrics } = chain();
    expect(instrumentation).toMatchObject({ kind: 'mobile-image-load-instrumentation', source: 'deployment-instrumentation', harnessVersion: 1, ...identity });
    for (const item of instrumentation.scenarios) {
      expect(Object.keys(item.metrics).sort()).toEqual([...REQUIRED_METRICS].sort());
      expect(item.window).toEqual(windows[item.name]);
    }
    expect(metrics('cold')).toMatchObject({ uploadRequests: 10000, deliveredOriginals: 10000, previewHits: 48000, previewMisses: 0, nativeDecodes: 10000,
      nativeSeconds: 90000, busyFailoverChecks: 40, peakRssBytes: 2.5 * GiB, peakScratchBytes: 300 * MiB, originalBytesFetched: 2 * 499_975 * MiB,
      uploadPoolPreviewJobs: 0, previewPoolUploadJobs: 0 });
    expect(metrics('cold').busyRate).toBeCloseTo(40 / 10040);
    expect(metrics('cold').regenerationDecodes).toBe(0);
    expect(metrics('mixed')).toMatchObject({ previewHits: 47999, previewMisses: 1, nativeDecodes: 10020, regenerationDecodes: 20, busyFailoverChecks: 40, peakRssBytes: 2.5 * GiB });
    expect(metrics('warm')).toMatchObject({ uploadRequests: 0, previewHits: 48000, previewMisses: 0, nativeDecodes: 0, nativeSeconds: 0, peakRssBytes: 0,
      peakScratchBytes: 0, busyFailoverChecks: 0, originalBytesFetched: 0 });
    for (const name of ['cold', 'warm', 'mixed']) {
      expect(metrics(name).costPer10000Originals).toBeGreaterThan(0);
      expect(metrics(name).throughputPerSecond).toBeGreaterThan(0);
    }
    // Cold pays for decode containers and one month of the delivered originals; warm pays for neither.
    expect(metrics('cold').costPer10000Originals).toBeGreaterThan(metrics('warm').costPer10000Originals);
    const cold = instrumentation.scenarios.find((item: Scenario) => item.name === 'cold');
    expect(cold.cost.components.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(
      ['workers-requests', 'r2-class-a', 'r2-class-b', 'r2-storage-month', 'containers-upper-bound', 'durable-objects', 'analytics-engine-points']));
    expect(cold.cost.excluded.map((item: { name: string }) => item.name)).toEqual(expect.arrayContaining(['workers-cpu-time', 'd1-rows']));
    expect(report).toMatchObject({ kind: 'mobile-image-load', source: 'live-rehearsal', harnessVersion: 1, versions, ...identity });
    expect(report.scenarios.map((item: { complete: boolean }) => item.complete)).toEqual([true, true, true]);
    expect(report.scenarios[0].concurrency.upload).toEqual({ configured: 4, maxActive: 4, meanActive: 3.9 });
    expect(report.observationsSha256).toBe(createHash('sha256').update(JSON.stringify(bundle, null, 2) + '\n').digest('hex'));
    expect(report.instrumentationSha256).toBe(createHash('sha256').update(JSON.stringify(instrumentation, null, 2) + '\n').digest('hex'));
    expect(verifyLoadArtifacts(report, bundle, instrumentation)).toBe(true);
    expect(assessLoadEvidence(report, identity)).toEqual({ pass: true, issues: [] });
    // Round trip through the serialized evidence bytes keeps every metric exactly.
    expect(verifyLoadArtifacts(JSON.parse(JSON.stringify(report)), JSON.parse(JSON.stringify(bundle)), JSON.parse(JSON.stringify(instrumentation)))).toBe(true);
  });

  it('fails closed on empty, sampled, malformed, mismatched or incomplete exports', () => {
    const bundle = synthetic();
    const bad = [syntheticExport('cold', { image: [] }),
      syntheticExport('cold', { image: [{ kind: 'preview-read', label: 'persisted-hit', points: '24000', bytes: '0', maxSampleInterval: '2' }] }),
      syntheticExport('cold', { image: [{ kind: 'preview-read', label: 'persisted-hit', points: '48000', bytes: '0', maxSampleInterval: '1' },
        { kind: 'preview-read', label: 'persisted-hit', points: '1', bytes: '0', maxSampleInterval: '1' }] }),
      syntheticExport('cold', { image: [{ kind: 'preview-read', label: 'forged-hit', points: '48000', bytes: '0', maxSampleInterval: '1' }] }),
      syntheticExport('cold', { decoder: [{ poolLane: 'upload/upload', path: 'preview', outcome: 'ok', jobs: 'NaN', nativeMs: '0', peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' }] }),
      syntheticExport('cold', { decoder: [{ poolLane: 'shared/upload', path: 'preview', outcome: 'ok', jobs: '1', nativeMs: '0', peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' }] }),
      syntheticExport('cold', { decoder: [{ poolLane: 'upload/upload', path: 'preview', outcome: 'ok', jobs: '-1', nativeMs: '0', peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' }] }),
      syntheticExport('cold', { main: [] }),
      { ...syntheticExport('cold'), graphql: { data: null, errors: [{ message: 'denied' }] } },
      { ...syntheticExport('cold'), window: windows.warm },
      { ...syntheticExport('cold'), imageMetrics: { meta: [], data: syntheticExport('cold').imageMetrics.data, rows: 1 } },
      { ...syntheticExport('cold'), queries: { ...syntheticExport('cold').queries, image: syntheticExport('cold').queries.image.replace("index1 = 'gallery_event_4' OR ", '') } }]
      .map(cold => () => buildInstrumentation({ bundle, exports: exportsFor({ cold }), scope, pricing: PRICING }));
    bad.push(() => buildInstrumentation({ bundle, exports: { ...exportsFor(), scope: { ...scope, imageDataset: 'production_metrics' } }, scope, pricing: PRICING }));
    bad.push(() => buildInstrumentation({ bundle, exports: { ...exportsFor(), scenarios: exportsFor().scenarios.slice(0, 2) }, scope, pricing: PRICING }));
    bad.push(() => buildInstrumentation({ bundle, exports: { ...exportsFor(), exportedAt: '2026-09-25T11:01:00.000Z' }, scope, pricing: PRICING }));
    bad.push(() => buildInstrumentation({ bundle, exports: exportsFor(), scope: { ...scope, mainScript: 'candidary' }, pricing: PRICING }));
    bad.push(() => buildInstrumentation({ bundle: { ...bundle, scenarios: bundle.scenarios.map((item: { plan: object }) => ({ ...item, plan: { ...item.plan, live: false } })) },
      exports: exportsFor(), scope, pricing: PRICING }));
    for (const attempt of bad) expect(attempt).toThrow();
    expect(() => bundleObservations(identity, ['cold', 'warm'].map(syntheticObservations))).toThrow();
    expect(() => bundleObservations({ ...identity, imageRef: 'registry.example/decoder:latest' }, ['cold', 'warm', 'mixed'].map(syntheticObservations))).toThrow();
    expect(() => buildLoadReport({ bundle, instrumentation: chain().instrumentation, versions: { ...versions, worker: '' } })).toThrow();
  });

  it('an all-zero export cannot pass, yet throughput and cost are still recorded', () => {
    const zero = syntheticExport('cold', { image: [{ kind: 'preview-read', label: 'persisted-hit', points: '0', bytes: '0', maxSampleInterval: '1' }], decoder: [] });
    const { report, metrics } = chain({ cold: zero });
    expect(metrics('cold')).toMatchObject({ nativeDecodes: 0, originalBytesFetched: 0, previewHits: 0, peakRssBytes: 0 });
    expect(Number.isFinite(metrics('cold').costPer10000Originals)).toBe(true);
    expect(metrics('cold').throughputPerSecond).toBeGreaterThan(0);
    const { pass, issues } = assessLoadEvidence(report, identity);
    expect(pass).toBe(false);
    expect(issues).toContain('cold: measurements do not account for the declared workload.');
  });

  it('fails warm with any original read, native decode or decoder activity', () => {
    const hit = { kind: 'preview-read', label: 'persisted-hit', points: '48000', bytes: '1', maxSampleInterval: '1' };
    const job = (outcome: string, jobs: string, rss: string) => ({ poolLane: 'preview/preview', path: 'preview', outcome, jobs, nativeMs: outcome === 'ok' ? '10' : '0',
      peakRssBytes: rss, peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' });
    for (const warm of [
      syntheticExport('warm', { image: [hit, { kind: 'original-read', label: 'images-transform', points: '1', bytes: '4096', maxSampleInterval: '1' }] }),
      syntheticExport('warm', { image: [hit, { kind: 'original-read', label: 'native-decode', points: '1', bytes: '4096', maxSampleInterval: '1' }] }),
      syntheticExport('warm', { decoder: [job('ok', '1', '1024')] }),
      syntheticExport('warm', { decoder: [job('busy', '1', '0')] })]) {
      const { report } = chain({ warm });
      expect(assessLoadEvidence(report, identity).issues).toContain('warm: go/no-go target failed.');
    }
  });

  it('fails cross-pool jobs, resource breaches and slow warm previews', () => {
    const cold = syntheticExport('cold');
    const crossed = { ...cold, decoderMetrics: { meta: [], rows: 3, data: [...cold.decoderMetrics.data,
      { poolLane: 'upload/preview', path: 'preview', outcome: 'ok', jobs: '1', nativeMs: '10', peakRssBytes: '1', peakScratchBytes: '0', sourceBytes: '1', maxSampleInterval: '1' }] } };
    const heavy = syntheticExport('cold', { decoder: [{ poolLane: 'upload/upload', path: 'preview', outcome: 'ok', jobs: '10000', nativeMs: '90000000',
      peakRssBytes: String(3 * GiB + 1), peakScratchBytes: '0', sourceBytes: String(499_975 * MiB), maxSampleInterval: '1' },
    { poolLane: 'upload/upload', path: 'preview', outcome: 'busy', jobs: '1', nativeMs: '0', peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' }] });
    for (const bad of [crossed, heavy]) expect(assessLoadEvidence(chain({ cold: bad }).report, identity).issues).toContain('cold: go/no-go target failed.');
  });

  it('requires mixed regeneration decodes in the preview pool, not upload retries', () => {
    const retried = syntheticExport('mixed', { decoder: [
      { poolLane: 'upload/upload', path: 'preview', outcome: 'ok', jobs: '10000', nativeMs: '90000000', peakRssBytes: String(2 * GiB), peakScratchBytes: '0', sourceBytes: String(499_975 * MiB), maxSampleInterval: '1' },
      { poolLane: 'upload/upload', path: 'preview', outcome: 'unavailable', jobs: '20', nativeMs: '0', peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' },
      { poolLane: 'upload/upload', path: 'preview', outcome: 'busy', jobs: '40', nativeMs: '0', peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' }] });
    const { report, metrics } = chain({ mixed: retried });
    expect(metrics('mixed')).toMatchObject({ nativeDecodes: 10020, regenerationDecodes: 0 });
    expect(assessLoadEvidence(report, identity).issues).toContain('mixed: measurements do not account for the declared workload.');
  });

  it('counts only successful, measured preview-pool jobs as mixed regeneration decodes', () => {
    const upload = syntheticExport('mixed').decoderMetrics.data.filter((row: Row) => row.poolLane === 'upload/upload');
    const regeneration = (outcome: string, nativeMs: string) => ({ poolLane: 'preview/preview', path: 'preview', outcome, jobs: '20', nativeMs,
      peakRssBytes: '0', peakScratchBytes: '0', sourceBytes: '0', maxSampleInterval: '1' });
    // A preview pool whose every regeneration fails (or reports no native work) proves no regeneration decode.
    for (const failed of [regeneration('unavailable', '0'), regeneration('resource_limit', '0'), regeneration('malformed', '0'), regeneration('ok', '0')]) {
      const { report, metrics } = chain({ mixed: syntheticExport('mixed', { decoder: [...upload, failed] }) });
      expect(metrics('mixed')).toMatchObject({ nativeDecodes: 10020, regenerationDecodes: 0 });
      expect(assessLoadEvidence(report, identity).issues).toContain('mixed: measurements do not account for the declared workload.');
    }
    // Failed preview-pool jobs beside successful ones never inflate the regeneration count.
    const { report, metrics } = chain({ mixed: syntheticExport('mixed', { decoder: [...upload, regeneration('ok', '100000'), regeneration('unavailable', '0')] }) });
    expect(metrics('mixed')).toMatchObject({ nativeDecodes: 10040, regenerationDecodes: 20 });
    expect(assessLoadEvidence(report, identity).issues).not.toContain('mixed: measurements do not account for the declared workload.');
  });

  it('queries only the scoped datasets and window, and never touches the network without credentials', async () => {
    const queries = analyticsEngineQueries({ scope, name: 'cold', window: windows.cold });
    expect(queries.image).toContain('FROM candidary_image_metrics_preview');
    expect(queries.image).toContain("timestamp >= toDateTime('2026-09-25 00:00:00')");
    expect(queries.image).toContain("timestamp < toDateTime('2026-09-25 04:00:01')");
    expect(queries.image).toContain("index1 = 'gallery_event_5'");
    expect(queries.image).toContain("blob1 = 'preview'");
    expect(queries.image).not.toContain('decoder');
    expect(queries.decoder).toContain('FROM candidary_image_decoder_preview');
    expect(queries.decoder).toContain("index1 = 'preview'");
    for (const query of [queries.image, queries.decoder]) expect(query).toMatch(/_sample_interval/u);
    expect(() => analyticsEngineQueries({ scope: { ...scope, eventIds: { ...scope.eventIds, cold: ["x' OR 1=1 --"] } }, name: 'cold', window: windows.cold })).toThrow();
    const fetch = vi.fn();
    await expect(exportDeploymentMetrics({ scope, windows, fetch, env: {} })).rejects.toThrow();
    await expect(exportDeploymentMetrics({ scope, windows, fetch, env: { CLOUDFLARE_ACCOUNT_ID: 'not-an-account', CLOUDFLARE_API_TOKEN: 'test-token' } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    const accountId = 'f'.repeat(32);
    const replay = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token');
      const recorded = syntheticExport('cold');
      if (url.endsWith('/graphql')) {
        const body = JSON.parse(String(init.body));
        expect(body.variables).toMatchObject({ accountTag: accountId, mainScript: 'candidary-preview', start: '2026-09-25T00:00:00Z', end: '2026-09-25T04:00:01Z' });
        return Response.json(recorded.graphql);
      }
      const data = String(init.body).includes('decoder') ? recorded.decoderMetrics.data : recorded.imageMetrics.data;
      return Response.json({ meta: [], data, rows: data.length });
    });
    const env = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'test-token' };
    const exported = await exportDeploymentMetrics({ scope, windows: { cold: windows.cold }, fetch: replay, env, now: () => Date.parse('2026-09-25T04:30:00.000Z') });
    expect(replay.mock.calls.map(([url]) => url)).toEqual([
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
      'https://api.cloudflare.com/client/v4/graphql']);
    const text = JSON.stringify(exported);
    expect(text).not.toContain('test-token');
    expect(text).not.toContain(accountId);
    expect(exported).toMatchObject({ kind: 'mobile-image-load-deployment-export', exportedAt: '2026-09-25T04:30:00.000Z', scope });
    expect(exported.scenarios[0].queries).toEqual(syntheticExport('cold').queries);
    expect(exported.scenarios[0].imageMetrics.data).toEqual(syntheticExport('cold').imageMetrics.data);
    const denied = vi.fn(async () => new Response('{"errors":[{"message":"token test-token rejected"}]}', { status: 403 }));
    const failure = await exportDeploymentMetrics({ scope, windows: { cold: windows.cold }, fetch: denied, env }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure.message)).not.toContain('test-token');
    expect(denied).toHaveBeenCalledOnce();
  });

  it('documents pricing constants with sources and retrieval date', () => {
    expect(PRICING.retrievedAt).toBe('2026-09-25');
    expect(PRICING).toMatchObject({ workersRequestsPerMillion: 0.3, workersCpuMsPerMillion: 0.02, r2ClassAPerMillion: 4.5, r2ClassBPerMillion: 0.36,
      r2StorageGbMonth: 0.015, containerMemoryGiBSecond: 0.0000025, containerVcpuSecond: 0.00002, containerDiskGbSecond: 0.00000007,
      durableObjectRequestsPerMillion: 0.15, durableObjectGbSecondsPerMillion: 12.5, durableObjectBilledGb: 0.128,
      analyticsEnginePointsPerMillion: 0.25, imagesTransformationsPerThousand: 0.5 });
    expect(PRICING.instanceTypes['standard-2']).toEqual({ vcpu: 1, memoryGiB: 6, diskGB: 12 });
    expect(PRICING.r2ClassA).toEqual(expect.arrayContaining(['PutObject', 'UploadPart', 'CreateMultipartUpload', 'CompleteMultipartUpload', 'CopyObject', 'ListObjects']));
    expect(PRICING.r2ClassB).toEqual(expect.arrayContaining(['GetObject', 'HeadObject']));
    expect(PRICING.r2Free).toEqual(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
    expect(Object.values(PRICING.sources).every((url) => String(url).startsWith('https://developers.cloudflare.com/'))).toBe(true);
  });

  it('pins its scope to the preview deployment configuration and the authorized rehearsal events', () => {
    const main = JSON.parse(readFileSync('wrangler.jsonc', 'utf8')).env.preview;
    const decoder = JSON.parse(readFileSync('services/image-decoder/worker/wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gmu, '')).env.preview;
    expect(PREVIEW_SCOPE.mainScript).toBe(main.name);
    expect(PREVIEW_SCOPE.imageDataset).toBe(main.analytics_engine_datasets[0].dataset);
    expect(PREVIEW_SCOPE.buckets).toEqual(main.r2_buckets.map((item: { bucket_name: string }) => item.bucket_name));
    expect(PREVIEW_SCOPE.decoderDataset).toBe(decoder.analytics_engine_datasets[0].dataset);
    expect(PREVIEW_SCOPE.environment).toBe(decoder.vars.DECODER_ENVIRONMENT);
    expect(PREVIEW_SCOPE.containers.pools).toEqual({ upload: Number(decoder.vars.UPLOAD_POOL_SIZE), preview: Number(decoder.vars.PREVIEW_POOL_SIZE) });
    expect(decoder.containers.map((item: { instance_type: string; max_instances: number }) => [item.instance_type, item.max_instances]))
      .toEqual([[PREVIEW_SCOPE.containers.instanceType, 2], [PREVIEW_SCOPE.containers.instanceType, 2]]);
    expect(readFileSync('services/image-decoder/worker/index.ts', 'utf8').match(/sleepAfter = '10m'/gu)).toHaveLength(2);
    expect(PREVIEW_SCOPE.containers.sleepAfterSeconds).toBe(600);
    const authorization = (scenario: string) => ({ kind: 'candidary.image-load-authorization', scenario, eventIds: [...events('gallery'), 'spare_gallery_event'],
      uploadEventIds: scenario === 'mixed' ? events('upload') : [], isolationEventId: 'isolation_event_0' });
    expect(scopeFromAuthorizations({ cold: authorization('cold'), warm: authorization('warm'), mixed: authorization('mixed') })).toEqual(scope);
    expect(() => scopeFromAuthorizations({ cold: authorization('warm'), warm: authorization('warm'), mixed: authorization('mixed') })).toThrow();
  });

  it('runs the offline command sequence: bundle, dry-run export plan, instrumentation build and SHA-named report evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'candidary-load-report-'));
    const write = (name: string, value: unknown) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const node = (script: string, args: string[], env: Record<string, string> = {}) => {
      try { return { status: 0, stdout: execFileSync(process.execPath, [resolve('scripts', script), ...args], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', ...env } }) }; }
      catch (error) { const failure = error as { status: number; stdout: string }; return { status: failure.status, stdout: failure.stdout }; }
    };
    const observed = ['cold', 'warm', 'mixed'].map(name => write(`${name}.json`, syntheticObservations(name)));
    const bundlePath = join(dir, 'bundle.json');
    expect(node('mobile-image-load-report.mjs', ['bundle', '--identity', write('identity.json', identity), '--out', bundlePath, ...observed]).status).toBe(0);
    expect(readFileSync(bundlePath, 'utf8')).toBe(JSON.stringify(synthetic(), null, 2) + '\n');
    const scopePath = write('scope.json', scope);
    const plan = node('mobile-image-load-instrumentation.mjs', ['export', '--scope', scopePath, '--observations', bundlePath, '--out', join(dir, 'export.json')]);
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({ live: false, scenarios: [{ name: 'cold' }, { name: 'warm' }, { name: 'mixed' }] });
    expect(readdirSync(dir)).not.toContain('export.json');
    const refused = node('mobile-image-load-instrumentation.mjs', ['export', '--scope', scopePath, '--observations', bundlePath, '--out', join(dir, 'export.json'), '--live-export']);
    expect(refused.status).toBe(1);
    expect(readdirSync(dir)).not.toContain('export.json');
    const instrumentationPath = join(dir, 'instrumentation.json');
    expect(node('mobile-image-load-instrumentation.mjs', ['build', '--scope', scopePath, '--observations', bundlePath, '--export', write('export.json', exportsFor()),
      '--out', instrumentationPath]).status).toBe(0);
    const evidence = join(dir, 'evidence');
    const built = node('mobile-image-load-report.mjs', ['build', '--observations', bundlePath, '--instrumentation', instrumentationPath,
      '--versions', write('versions.json', { worker: 'unit-version', decoder: 'unit-decoder' }), '--evidence-root', evidence]);
    expect(built.status).toBe(0);
    const result = JSON.parse(built.stdout);
    expect(result).toMatchObject({ artifactsVerified: true, pass: true, issues: [] });
    const files = readdirSync(evidence).sort();
    expect(files).toEqual([result.observationsSha256, result.instrumentationSha256, result.reportSha256].map(sha => `${sha}.json`).sort());
    for (const file of files) expect(createHash('sha256').update(readFileSync(join(evidence, file))).digest('hex')).toBe(file.slice(0, 64));
    const report = JSON.parse(readFileSync(join(evidence, `${result.reportSha256}.json`), 'utf8'));
    expect(report.versions.harness).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.observationsSha256).toBe(result.observationsSha256);
  });
});

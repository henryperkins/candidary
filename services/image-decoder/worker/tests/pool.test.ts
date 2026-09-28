import { describe, expect, it, vi } from 'vitest';
import { requiredCasesFor } from '../../../../shared/image-decoder-contract';
import { qualifiedDecoderFingerprints } from '../../../../shared/image-decoder-release';
import { decoderMetricsPoint, routeDecoderRequest, type DecoderPool, type DecoderStub } from '../pool';

const fingerprint = 'b'.repeat(64);
const release = { protocolVersion: 1, previewProfile: 'mobile-preview-v1', releases: [{
  imageRef: `registry.example.test/decoder@sha256:${'a'.repeat(64)}`, buildFingerprint: fingerprint,
  protocolVersion: 1, verifiedCaseIds: requiredCasesFor('jpeg', false), previewProfile: 'mobile-preview-v1', evidenceSha256: 'c'.repeat(64),
}] };
const inspection = { family: 'jpeg', width: 4, height: 3, frameCount: 1, primaryIndex: 0, isSequence: false,
  sourceSha256: 'd'.repeat(64), byteSize: 4, buildFingerprint: fingerprint, decoderVersion: 'test-1', previewProfile: 'mobile-preview-v1' };

function request(lane = 'upload', excluded?: string) {
  return new Request('https://private.internal/v1/inspect', { method: 'POST', body: Uint8Array.of(1, 2, 3, 4), headers: {
    'Content-Type': 'application/octet-stream', 'X-Decoder-Protocol': '1', 'X-Decoder-Lane': lane,
    'X-Image-Family': 'jpeg', 'X-Image-Sequence': '0', 'X-Source-Length': '4',
    ...(excluded ? { 'X-Decoder-Exclude-Instances': excluded } : {}),
  } });
}
function stub(id: string, options: { busy?: boolean; buildFingerprint?: string; result?: object } = {}) {
  return { id: { toString: () => id }, fetch: vi.fn(async (incoming: Request) => {
    if (new URL(incoming.url).pathname === '/health') return Response.json({ protocolVersion: 1,
      buildFingerprint: options.buildFingerprint ?? fingerprint, decoderVersion: 'test-1' });
    if (options.busy) return Response.json({ code: 'busy' }, { status: 429 });
    expect(new Uint8Array(await incoming.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4));
    return Response.json(options.result ?? inspection, { headers: { 'X-Decoder-Protocol': '1' } });
  }) } satisfies DecoderStub;
}
function pool(...stubs: DecoderStub[]): DecoderPool {
  let index = 0;
  return { size: stubs.length, draw: vi.fn(async () => stubs[Math.min(index++, stubs.length - 1)]!) };
}

describe('private decoder pools', () => {
  it('returns identity-only health for qualification without admitting an unqualified build', async () => {
    const instance = stub('qualification'); const upload = pool(instance);
    const health = new Request('https://private.internal/health', { headers: { 'X-Decoder-Protocol': '1', 'X-Decoder-Lane': 'upload' } });
    const response = await routeDecoderRequest(health, { upload, preview: pool(stub('unused')) }, { ...release, releases: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ protocolVersion: 1, buildFingerprint: fingerprint, decoderVersion: 'test-1' });
    expect(instance.fetch).toHaveBeenCalledOnce();
    expect((await routeDecoderRequest(request(), { upload, preview: upload }, { ...release, releases: [] })).status).toBe(503);
    expect(instance.fetch).toHaveBeenCalledOnce();
  });
  it('routes upload and preview work to independent pools', async () => {
    const upload = stub('upload-1'); const preview = stub('preview-1');
    const pools = { upload: pool(upload), preview: pool(preview) };
    const uploadResponse = await routeDecoderRequest(request(), pools, release);
    expect(uploadResponse.status).toBe(200);
    expect(uploadResponse.headers.get('X-Decoder-Instance')).toBe('upload-1');
    expect(preview.fetch).not.toHaveBeenCalled();
    expect((await routeDecoderRequest(request('preview'), pools, release)).status).toBe(200);
    expect(upload.fetch).toHaveBeenCalledTimes(2);
    expect(preview.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns an instance hint on busy and routes a fresh retry past that instance', async () => {
    const busy = stub('busy-1', { busy: true }); const available = stub('ready-2');
    const upload = pool(busy, busy, available);
    const pools = { upload, preview: pool(stub('unused')) };
    const first = await routeDecoderRequest(request(), pools, release);
    expect(first.status).toBe(429);
    expect(first.headers.get('X-Decoder-Instance')).toBe('busy-1');
    expect(await first.json()).toEqual({ code: 'busy' });
    const next = await routeDecoderRequest(request('upload', 'busy-1'), pools, release);
    expect(next.status).toBe(200);
    expect(available.fetch).toHaveBeenCalledTimes(2);
    expect(busy.fetch).toHaveBeenCalledTimes(2); // Health + one decode request only; no internal replay.
  });

  it('bounds draws when only excluded duplicates are returned', async () => {
    const excluded = stub('excluded'); const upload = { ...pool(excluded), size: 2 };
    const response = await routeDecoderRequest(request('upload', 'excluded'), { upload, preview: upload }, release);
    expect(response.status).toBe(503);
    expect(upload.draw).toHaveBeenCalledTimes(16);
    expect(excluded.fetch).not.toHaveBeenCalled();
  });

  it.each(['a,b,c,d', 'same,same', 'bad instance', 'x'.repeat(129)])('refuses unbounded or invalid exclusion hints %s', async (hint) => {
    const upload = pool(stub('never'));
    expect((await routeDecoderRequest(request('upload', hint), { upload, preview: upload }, release)).status).toBe(503);
    expect(upload.draw).not.toHaveBeenCalled();
  });

  it('does not send original bytes to a mixed, unqualified build', async () => {
    const unqualified = stub('old-build', { buildFingerprint: 'e'.repeat(64) });
    const response = await routeDecoderRequest(request(), { upload: pool(unqualified), preview: pool(stub('unused')) }, release);
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Decoder-Instance')).toBe('old-build');
    expect(unqualified.fetch).toHaveBeenCalledOnce();
  });

  it('checks the actual family against external evidence after decoding', async () => {
    const instance = stub('decoder', { result: { ...inspection, family: 'dng' } });
    expect((await routeDecoderRequest(request(), { upload: pool(instance), preview: pool(stub('unused')) }, release)).status).toBe(503);
  });

  it('checks actual animation evidence even when ordinary WebP was provisionally qualified', async () => {
    const instance = stub('decoder', { result: { ...inspection, family: 'webp', frameCount: 3, isSequence: true } });
    const incoming = request(); incoming.headers.set('X-Image-Family', 'webp');
    const stillOnly = { ...release, releases: [{ ...release.releases[0], verifiedCaseIds: requiredCasesFor('webp', false) }] };
    expect((await routeDecoderRequest(incoming, { upload: pool(instance), preview: pool(stub('unused')) }, stillOnly)).status).toBe(503);
    expect(instance.fetch).toHaveBeenCalledTimes(2);
  });

  it('forwards only fixed raw-byte headers and paths, never guest credentials or a source URL', async () => {
    const instance = stub('decoder'); const incoming = request();
    incoming.headers.set('Authorization', 'guest-secret'); incoming.headers.set('Cookie', 'private-session');
    incoming.headers.set('X-Image-URL', 'https://private-source.example/secret'); incoming.headers.set('X-Command', 'run');
    expect((await routeDecoderRequest(incoming, { upload: pool(instance), preview: pool(stub('unused')) }, release)).status).toBe(200);
    const forwarded = instance.fetch.mock.calls[1]![0];
    expect(forwarded.url).toBe('http://localhost:8080/v1/inspect');
    expect([...forwarded.headers.keys()].sort()).toEqual(['content-type', 'x-decoder-lane', 'x-decoder-protocol', 'x-image-family', 'x-image-sequence', 'x-source-length']);
  });

  it('never routes jobs without an external release or with invalid pool/lane configuration', async () => {
    const upload = pool(stub('unused'));
    expect((await routeDecoderRequest(request(), { upload, preview: upload }, { ...release, releases: [] })).status).toBe(503);
    expect((await routeDecoderRequest(request('arbitrary'), { upload, preview: upload }, release)).status).toBe(503);
    expect((await routeDecoderRequest(request(), { upload: { ...upload, size: 0 }, preview: upload }, release)).status).toBe(503);
    expect(upload.draw).not.toHaveBeenCalled();
  });

  it('records one private measurement per forwarded native job and never forwards the metrics header', async () => {
    const metrics = { nativeMs: 13, peakRssBytes: 7 * 1024 ** 2, peakScratchBytes: 4096, sourceBytes: 4 };
    const measured = { id: { toString: () => 'measured' }, fetch: vi.fn(async (incoming: Request) => {
      if (new URL(incoming.url).pathname === '/health') return Response.json({ protocolVersion: 1, buildFingerprint: fingerprint, decoderVersion: 'test-1' });
      await incoming.arrayBuffer();
      const headers = { 'X-Decoder-Protocol': '1', 'X-Decoder-Metrics': JSON.stringify(metrics) };
      if (new URL(incoming.url).pathname === '/v1/inspect') return Response.json(inspection, { headers });
      return new Response(Uint8Array.of(9, 9), { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': '2',
        'X-Decoder-Inspection': JSON.stringify(inspection), 'X-Preview-Width': '4', 'X-Preview-Height': '3', 'X-Preview-Frames': '1' } });
    }) } satisfies DecoderStub;
    const record = vi.fn();
    for (const [lane, path] of [['upload', 'inspect'], ['preview', 'preview']] as const) {
      const incoming = request(lane);
      const routed = new Request(incoming.url.replace('/v1/inspect', `/v1/${path}`), { method: 'POST', body: Uint8Array.of(1, 2, 3, 4), headers: incoming.headers });
      const response = await routeDecoderRequest(routed, { upload: { ...pool(measured), name: 'upload' }, preview: { ...pool(measured), name: 'preview' } }, release, record);
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Decoder-Metrics')).toBeNull();
      expect([...response.headers.keys()].sort()).toEqual(path === 'inspect'
        ? ['content-type', 'x-decoder-instance', 'x-decoder-protocol']
        : ['content-length', 'content-type', 'x-decoder-inspection', 'x-decoder-instance', 'x-decoder-protocol', 'x-preview-frames', 'x-preview-height', 'x-preview-width']);
      await response.arrayBuffer();
      expect(record).toHaveBeenLastCalledWith({ pool: lane, lane, path, outcome: 'ok', family: 'jpeg', metrics });
    }
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('records busy and closed native failures, strips their metrics and ignores invalid measurements', async () => {
    const record = vi.fn();
    const busy = stub('busy-1', { busy: true });
    expect((await routeDecoderRequest(request(), { upload: { ...pool(busy), name: 'upload' }, preview: pool(stub('unused')) }, release, record)).status).toBe(429);
    expect(record).toHaveBeenLastCalledWith({ pool: 'upload', lane: 'upload', path: 'inspect', outcome: 'busy', family: 'jpeg', metrics: null });
    for (const [raw, expected] of [
      ['{"nativeMs":5,"peakRssBytes":6,"peakScratchBytes":7,"sourceBytes":4}', { nativeMs: 5, peakRssBytes: 6, peakScratchBytes: 7, sourceBytes: 4 }],
      ['{"nativeMs":5,"peakRssBytes":6,"peakScratchBytes":7}', null],
      ['{"nativeMs":5,"peakRssBytes":6,"peakScratchBytes":7,"sourceBytes":4,"eventId":1}', null],
      ['{"nativeMs":5.5,"peakRssBytes":6,"peakScratchBytes":7,"sourceBytes":4}', null],
      ['{"nativeMs":-1,"peakRssBytes":6,"peakScratchBytes":7,"sourceBytes":4}', null],
      [`{"nativeMs":5,"peakRssBytes":6,"peakScratchBytes":7,"sourceBytes":4${' '.repeat(512)}}`, null],
      ['[5,6,7,4]', null], ['not json', null],
    ] as const) {
      const failing = { id: { toString: () => 'failing' }, fetch: vi.fn(async (incoming: Request) => {
        if (new URL(incoming.url).pathname === '/health') return Response.json({ protocolVersion: 1, buildFingerprint: fingerprint, decoderVersion: 'test-1' });
        await incoming.arrayBuffer();
        return Response.json({ code: 'malformed' }, { status: 422, headers: { 'X-Decoder-Metrics': raw } });
      }) } satisfies DecoderStub;
      const response = await routeDecoderRequest(request(), { upload: { ...pool(failing), name: 'upload' }, preview: pool(stub('unused')) }, release, record);
      expect(response.status).toBe(422);
      expect(response.headers.get('X-Decoder-Metrics')).toBeNull();
      expect(record).toHaveBeenLastCalledWith({ pool: 'upload', lane: 'upload', path: 'inspect', outcome: 'malformed', family: 'jpeg', metrics: expected });
    }
  });

  it('writes no measurement for requests that never reach a native job and survives recorder failure', async () => {
    const record = vi.fn(() => { throw new Error('analytics unavailable'); });
    const unqualified = stub('old-build', { buildFingerprint: 'e'.repeat(64) });
    expect((await routeDecoderRequest(request(), { upload: pool(unqualified), preview: pool(stub('unused')) }, release, record)).status).toBe(503);
    expect((await routeDecoderRequest(request('upload', 'a,b,c'), { upload: pool(stub('x')), preview: pool(stub('y')) }, release, record)).status).toBe(503);
    expect(record).not.toHaveBeenCalled();
    const response = await routeDecoderRequest(request(), { upload: pool(stub('decoder')), preview: pool(stub('unused')) }, release, record);
    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledOnce();
  });

  it('shapes one identifier-free Analytics Engine data point per native job', () => {
    expect(decoderMetricsPoint('preview', { pool: 'preview', lane: 'preview', path: 'preview', outcome: 'resource_limit', family: 'dng',
      metrics: { nativeMs: 1, peakRssBytes: 2, peakScratchBytes: 3, sourceBytes: 4 } })).toEqual({
      indexes: ['preview'], blobs: ['preview', 'preview/preview', 'preview', 'resource_limit', 'dng'], doubles: [1, 2, 3, 4, 1] });
    expect(decoderMetricsPoint('preview', { pool: 'upload', lane: 'upload', path: 'inspect', outcome: 'busy', family: 'heic', metrics: null }))
      .toEqual({ indexes: ['preview'], blobs: ['preview', 'upload/upload', 'inspect', 'busy', 'heic'], doubles: [0, 0, 0, 0, 1] });
  });

  it('requires an external immutable image/evidence record for every required variant', () => {
    expect(qualifiedDecoderFingerprints(release, 'jpeg', false)).toEqual([fingerprint]);
    const partial = { ...release, releases: [{ ...release.releases[0], verifiedCaseIds: ['jpeg-baseline'] }] };
    expect(qualifiedDecoderFingerprints(partial, 'jpeg', false)).toEqual([]);
    const selfClaim = { ...release, releases: [{ ...release.releases[0], imageRef: 'decoder:latest' }] };
    expect(qualifiedDecoderFingerprints(selfClaim, 'jpeg', false)).toEqual([]);
    expect(qualifiedDecoderFingerprints(release, 'dng', false)).toEqual([]);
  });
});

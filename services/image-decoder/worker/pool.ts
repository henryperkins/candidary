export type DecoderStub = { id: { toString(): string }; fetch(request: Request): Promise<Response> };
export type DecoderLane = 'upload' | 'preview';
/** `name` is the Container binding actually drawn from; index.ts sets it beside that binding. */
export type DecoderPool = { name?: DecoderLane; size: number; draw(): Promise<DecoderStub> };
export type DecoderPools = { upload: DecoderPool; preview: DecoderPool };
export type DecoderJobMetrics = { nativeMs: number; peakRssBytes: number; peakScratchBytes: number; sourceBytes: number };
/** One private measurement per request forwarded to a native job. No event, media, guest or source identity. */
export type DecoderJobRecord = { pool: DecoderLane; lane: DecoderLane; path: 'inspect' | 'preview';
  outcome: 'ok' | DecoderFailureCode; family: ImageFamily; metrics: DecoderJobMetrics | null };

const statuses: Record<DecoderFailureCode, number> = { unsupported: 415, malformed: 422, resource_limit: 413, busy: 429, unavailable: 503 };
const instancePattern = /^[A-Za-z0-9_-]{1,128}$/u;
const nativeOrigin = 'http://localhost:8080';
const metricKeys = ['nativeMs', 'peakRssBytes', 'peakScratchBytes', 'sourceBytes'] as const;

/** Strict private header parser: anything other than four non-negative safe integers is ignored. */
export function parseDecoderMetrics(raw: string | null): DecoderJobMetrics | null {
  if (raw === null || new TextEncoder().encode(raw).byteLength > 512) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== metricKeys.length || !metricKeys.every((key) => keys.includes(key))) return null;
    const record = value as Record<string, unknown>;
    if (!metricKeys.every((key) => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0)) return null;
    return Object.fromEntries(metricKeys.map((key) => [key, record[key]])) as DecoderJobMetrics;
  } catch { return null; }
}
export function decoderMetricsPoint(environment: string, job: DecoderJobRecord): AnalyticsEngineDataPoint {
  const m = job.metrics;
  return { indexes: [environment], blobs: [environment, `${job.pool}/${job.lane}`, job.path, job.outcome, job.family],
    doubles: [m?.nativeMs ?? 0, m?.peakRssBytes ?? 0, m?.peakScratchBytes ?? 0, m?.sourceBytes ?? 0, 1] };
}

function failure(code: DecoderFailureCode, instance?: string) {
  return Response.json({ code }, { status: statuses[code], headers: {
    'X-Decoder-Protocol': '1', ...(instance ? { 'X-Decoder-Instance': instance } : {}),
  } });
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') throw new Error('Invalid private JSON.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(DECODER_MAX_PROOF_BYTES);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)));
      if (value.byteLength > bytes.length - length) throw new Error('Private JSON exceeded its byte limit.');
      bytes.set(value, length); length += value.byteLength;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function routeDecoderRequest(request: Request, pools: DecoderPools, release: unknown,
  record?: (job: DecoderJobRecord) => void): Promise<Response> {
  let selected: string | undefined;
  let forwarded = false;
  let response: Response | undefined;
  let handedOff = false;
  let job: Omit<DecoderJobRecord, 'outcome' | 'metrics'> | undefined;
  let outcome: DecoderJobRecord['outcome'] = 'unavailable';
  const failed = (code: DecoderFailureCode) => { outcome = code; return failure(code, selected); };
  try {
    const url = new URL(request.url);
    const lane = request.headers.get('X-Decoder-Lane');
    const family = request.headers.get('X-Image-Family');
    const sequence = request.headers.get('X-Image-Sequence');
    const rawLength = request.headers.get('X-Source-Length');
    const healthOnly = request.method === 'GET' && url.pathname === '/health' && !request.body;
    if (url.search || request.headers.get('X-Decoder-Protocol') !== '1' || (lane !== 'upload' && lane !== 'preview')) return failure('unavailable');
    if (!healthOnly && (request.method !== 'POST' || !['/v1/inspect', '/v1/preview'].includes(url.pathname)
      || !request.body || request.headers.get('Content-Type') !== 'application/octet-stream'
      || !family || !Object.hasOwn(KNOWN_IMAGE_FORMATS, family)
      || (sequence !== '0' && sequence !== '1') || !rawLength || !/^[1-9][0-9]*$/u.test(rawLength))) return failure('unavailable');
    const byteSize = Number(rawLength);
    if (!healthOnly && (!Number.isSafeInteger(byteSize) || byteSize > DECODER_MAX_SOURCE_BYTES)) return failure('unavailable');
    const declared = healthOnly ? undefined : { family: family as ImageFamily, mimeType: KNOWN_IMAGE_FORMATS[family as ImageFamily].mimeType, requiresSequence: sequence === '1' };
    const eligible = declared ? qualifiedDecoderFingerprints(release, declared.family, declared.requiresSequence) : [];
    if (!healthOnly && !eligible.length) return failure('unavailable');
    const pool = pools[lane];
    if (declared) job = { pool: pool.name ?? lane, lane, path: url.pathname === '/v1/preview' ? 'preview' : 'inspect', family: declared.family };
    if (!Number.isInteger(pool.size) || pool.size < 1 || pool.size > 128) return failure('unavailable');
    const rawExcluded = request.headers.get('X-Decoder-Exclude-Instances');
    if (rawExcluded !== null && (!rawExcluded || rawExcluded.length > 386)) return failure('unavailable');
    const excluded = rawExcluded?.split(',') ?? [];
    if (excluded.length > 3 || new Set(excluded).size !== excluded.length || excluded.some((id) => !instancePattern.test(id))) return failure('unavailable');
    if (excluded.length === 3) return failure('unavailable');
    let instance: DecoderStub | undefined;
    for (let draw = 0; draw < 16; draw++) {
      const candidate = await pool.draw();
      const id = candidate.id.toString();
      if (!instancePattern.test(id)) return failure('unavailable');
      if (!excluded.includes(id)) { instance = candidate; selected = id; break; }
    }
    if (!instance) return failure('unavailable');
    // One selected instance per request; the main adapter owns fresh-source retries.
    const healthResponse = await instance.fetch(new Request(`${nativeOrigin}/health`, { signal: request.signal }));
    if (healthResponse.status !== 200) { await healthResponse.body?.cancel(); return failure('unavailable', selected); }
    const health = parseDecoderHealth(await boundedJson(healthResponse));
    if (healthOnly) return Response.json(health, { headers: { 'X-Decoder-Protocol': '1' } });
    if (!eligible.includes(health.buildFingerprint)) return failure('unavailable', selected);
    const headers = new Headers();
    for (const name of ['Content-Type', 'X-Decoder-Protocol', 'X-Decoder-Lane', 'X-Image-Family', 'X-Image-Sequence', 'X-Source-Length']) {
      headers.set(name, request.headers.get(name)!);
    }
    // Node's fake-stub tests require duplex; workerd ignores this Fetch-compatible hint.
    const init = { method: 'POST', headers, body: request.body, signal: request.signal, duplex: 'half' };
    forwarded = true;
    response = await instance.fetch(new Request(`${nativeOrigin}${url.pathname}`, init));
    if (!response.ok) {
      const code = parseDecoderFailure(await boundedJson(response));
      return failed(statuses[code] === response.status ? code : 'unavailable');
    }
    if (response.status !== 200 || response.headers.get('X-Decoder-Protocol') !== '1') return failed('unavailable');
    const preview = url.pathname === '/v1/preview';
    const rawProof = preview ? response.headers.get('X-Decoder-Inspection') : null;
    if (preview && (!rawProof || new TextEncoder().encode(rawProof).byteLength > DECODER_MAX_PROOF_BYTES)) return failed('unavailable');
    const proof = parseDecoderInspection(preview ? JSON.parse(rawProof!) : await boundedJson(response));
    if (proof.byteSize !== byteSize || proof.buildFingerprint !== health.buildFingerprint || proof.decoderVersion !== health.decoderVersion
      || !declared || !imageDeclarationMatches(declared, proof)
      || !qualifiedDecoderFingerprints(release, proof.family, proof.isSequence).includes(proof.buildFingerprint)) return failed('unavailable');
    outcome = 'ok';
    if (!preview) return Response.json(proof, { headers: { 'X-Decoder-Protocol': '1', 'X-Decoder-Instance': selected! } });
    const responseHeaders = new Headers({ 'X-Decoder-Protocol': '1', 'X-Decoder-Instance': selected!, 'X-Decoder-Inspection': JSON.stringify(proof) });
    for (const name of ['Content-Type', 'Content-Length', 'X-Preview-Width', 'X-Preview-Height', 'X-Preview-Frames']) {
      const value = response.headers.get(name);
      if (value === null) return failed('unavailable');
      responseHeaders.set(name, value);
    }
    handedOff = true;
    return new Response(response.body, { headers: responseHeaders });
  } catch {
    return failed('unavailable');
  } finally {
    if (!forwarded && request.body && !request.body.locked) await request.body.cancel().catch(() => {});
    if (!handedOff && response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    // The native header is read here and never copied into any returned response.
    if (forwarded && job) {
      try { record?.({ ...job, outcome, metrics: parseDecoderMetrics(response?.headers.get('X-Decoder-Metrics') ?? null) }); } catch { /* Measurement never changes routing. */ }
    }
  }
}
import { DECODER_MAX_PROOF_BYTES, DECODER_MAX_SOURCE_BYTES, parseDecoderFailure, parseDecoderHealth,
  parseDecoderInspection, type DecoderFailureCode } from '../../../shared/image-decoder-contract';
import { qualifiedDecoderFingerprints } from '../../../shared/image-decoder-release';
import { imageDeclarationMatches, KNOWN_IMAGE_FORMATS, type ImageFamily } from '../../../shared/image-formats';

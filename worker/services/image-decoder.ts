import {
  DecoderError, DECODER_ANIMATED_PREVIEW_BYTES, DECODER_MAX_PROOF_BYTES, DECODER_MAX_SOURCE_BYTES,
  DECODER_STILL_PREVIEW_BYTES, parseDecoderFailure, parseDecoderInspection,
  type DecoderFailureCode, type DecoderInspection, type DecoderPreview, type DecoderSource, type ImageDecoder,
} from '../../shared/image-decoder-contract';
import { imageDeclarationMatches, KNOWN_IMAGE_FORMATS } from '../../shared/image-formats';

export { DecoderError };
const PRIVATE_ORIGIN = 'https://image-decoder.internal';
const ATTEMPT_TIMEOUT_MS = 135_000; // Native 120 s job limit plus the private transport boundary.
const FAILURE_STATUS: Record<DecoderFailureCode, number> = {
  unsupported: 415, malformed: 422, resource_limit: 413, busy: 429, unavailable: 503,
};
const aborted = () => new DOMException('Image processing was cancelled.', 'AbortError');
const unavailable = () => new DecoderError('unavailable');

/** Owns its reader, enforces exact lengths without buffering the original, and propagates cancellation. */
function guardedStream(input: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal, exact?: number, onFinish = () => {}) {
  const reader = input.getReader();
  let ended = false;
  let complete = false;
  let count = 0;
  let onAbort: () => void;
  const cleanup = () => { signal.removeEventListener('abort', onAbort); reader.releaseLock(); onFinish(); };
  const cancel = async (reason?: unknown) => {
    if (ended) return;
    ended = true;
    try { await reader.cancel(reason); } catch { /* Native errors stay private. */ }
    finally { cleanup(); }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => { if (!ended) { controller.error(aborted()); void cancel(aborted()); } };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (ended) return;
        if (done) {
          if (exact !== undefined && count !== exact) throw unavailable();
          ended = true; complete = true; cleanup(); controller.close(); return;
        }
        if (!(value instanceof Uint8Array) || value.byteLength > limit - count) throw unavailable();
        count += value.byteLength;
        controller.enqueue(value);
      } catch {
        if (!ended) controller.error(signal.aborted ? aborted() : unavailable());
        await cancel();
      }
    },
    cancel,
  }, { highWaterMark: 0 });
  return { body, cancel, get complete() { return complete; } };
}

async function privateJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') throw unavailable();
  const guarded = guardedStream(response.body, DECODER_MAX_PROOF_BYTES, signal);
  const reader = guarded.body.getReader();
  const bytes = new Uint8Array(DECODER_MAX_PROOF_BYTES);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes.set(value, offset); offset += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
  } catch { throw signal.aborted ? aborted() : unavailable(); }
  finally { await guarded.cancel(); reader.releaseLock(); }
}

function headerInteger(headers: Headers, name: string, maximum: number): number {
  const value = headers.get(name);
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw unavailable();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw unavailable();
  return parsed;
}

function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 25 * (attempt + 1));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export class ImageDecoderClient implements ImageDecoder {
  constructor(
    private readonly fetcher: (request: Request) => Promise<Response>,
    private readonly acceptedFingerprints: readonly string[],
    private readonly lane: 'upload' | 'preview',
  ) {}
  inspectOriginal(source: DecoderSource): Promise<DecoderInspection> { return this.execute(source, false); }
  renderOriginalPreview(source: DecoderSource): Promise<DecoderPreview> { return this.execute(source, true); }

  private proof(value: unknown, source: DecoderSource): DecoderInspection {
    const proof = parseDecoderInspection(value);
    if (!this.acceptedFingerprints.includes(proof.buildFingerprint) || proof.byteSize !== source.byteSize
      || !imageDeclarationMatches(source.declared, proof)) throw unavailable();
    return proof;
  }

  private execute(source: DecoderSource, preview: false): Promise<DecoderInspection>;
  private execute(source: DecoderSource, preview: true): Promise<DecoderPreview>;
  private async execute(source: DecoderSource, preview: boolean): Promise<DecoderInspection | DecoderPreview> {
    if (source.signal?.aborted) throw aborted();
    if (!Number.isSafeInteger(source.byteSize) || source.byteSize < 1 || source.byteSize > DECODER_MAX_SOURCE_BYTES
      || !Object.hasOwn(KNOWN_IMAGE_FORMATS, source.declared.family) || typeof source.declared.requiresSequence !== 'boolean'
      || this.acceptedFingerprints.length === 0) throw unavailable();
    const excluded: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const parentAbort = () => controller.abort();
      source.signal?.addEventListener('abort', parentAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
      const dispose = () => { clearTimeout(timeout); source.signal?.removeEventListener('abort', parentAbort); };
      let input: ReturnType<typeof guardedStream> | undefined;
      let response: Response | undefined;
      let handedOff = false;
      let failure: DecoderError | undefined;
      try {
        const stream = await source.open();
        input = guardedStream(stream, source.byteSize, controller.signal, source.byteSize);
        if (source.signal?.aborted) controller.abort();
        if (controller.signal.aborted) throw aborted();
        const headers = new Headers({
          'Content-Type': 'application/octet-stream', 'X-Decoder-Protocol': '1', 'X-Image-Family': source.declared.family,
          'X-Image-Sequence': source.declared.requiresSequence ? '1' : '0', 'X-Source-Length': String(source.byteSize),
          'X-Decoder-Lane': this.lane,
        });
        if (excluded.length) headers.set('X-Decoder-Exclude-Instances', excluded.join(','));
        response = await this.fetcher(new Request(`${PRIVATE_ORIGIN}/v1/${preview ? 'preview' : 'inspect'}`, {
          method: 'POST', headers, body: input.body, signal: controller.signal,
        }));
        if (controller.signal.aborted) throw aborted();
        // A 200 response can still be unusable for this transfer's pinned build.
        // Remember its instance before validating proof so retries select another.
        const instance = response.headers.get('X-Decoder-Instance');
        if (instance !== null) {
          if (!/^[A-Za-z0-9_-]{1,128}$/u.test(instance) || excluded.includes(instance)) throw unavailable();
          excluded.push(instance);
        }
        if (response.headers.get('X-Decoder-Protocol') !== '1') throw unavailable();
        if (!response.ok) {
          const code = parseDecoderFailure(await privateJson(response, controller.signal));
          throw new DecoderError(FAILURE_STATUS[code] === response.status ? code : 'unavailable');
        }
        if (response.status !== 200 || !input.complete) throw unavailable();
        if (!preview) return this.proof(await privateJson(response, controller.signal), source);

        const rawProof = response.headers.get('X-Decoder-Inspection');
        if (!rawProof || new TextEncoder().encode(rawProof).byteLength > DECODER_MAX_PROOF_BYTES) throw unavailable();
        const inspection = this.proof(JSON.parse(rawProof), source);
        const mimeType = response.headers.get('Content-Type');
        if (mimeType !== 'image/webp' && mimeType !== 'image/jpeg') throw unavailable();
        if (inspection.isSequence && mimeType !== 'image/webp') throw unavailable();
        const width = headerInteger(response.headers, 'X-Preview-Width', Math.min(1600, inspection.width));
        const height = headerInteger(response.headers, 'X-Preview-Height', Math.min(1600, inspection.height));
        const frameCount = headerInteger(response.headers, 'X-Preview-Frames', inspection.frameCount);
        if (frameCount !== inspection.frameCount) throw unavailable();
        const byteSize = headerInteger(response.headers, 'Content-Length',
          inspection.isSequence ? DECODER_ANIMATED_PREVIEW_BYTES : DECODER_STILL_PREVIEW_BYTES);
        if (!response.body) throw unavailable();
        const output = guardedStream(response.body, byteSize, controller.signal, byteSize, dispose);
        handedOff = true;
        return { body: output.body, byteSize, mimeType, width, height, frameCount, inspection };
      } catch (error) {
        if (source.signal?.aborted) throw aborted();
        failure = error instanceof DecoderError ? error : unavailable();
      } finally {
        await input?.cancel();
        if (!handedOff) {
          if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
          controller.abort(); dispose();
        }
      }
      if (!failure || (failure.code !== 'busy' && failure.code !== 'unavailable') || attempt === 2) throw failure ?? unavailable();
      await retryDelay(attempt, source.signal);
    }
    throw unavailable();
  }
}

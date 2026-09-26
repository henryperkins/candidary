import { type DecoderFailureCode, type DecoderInspection } from '../../../shared/image-decoder-contract';

// Protocol orchestration double only. No response here proves a codec can decode.
export function decoderInspection(overrides: Partial<DecoderInspection> = {}): DecoderInspection {
  return {
    family: 'jpeg', width: 4032, height: 3024, frameCount: 1, primaryIndex: 0, isSequence: false,
    sourceSha256: 'a'.repeat(64), byteSize: 4, buildFingerprint: 'b'.repeat(64),
    decoderVersion: 'test-double-1', previewProfile: 'mobile-preview-v1', ...overrides,
  };
}

export function createDecoderDouble(options: {
  inspection: DecoderInspection;
  previewBytes: Uint8Array;
  failure?: DecoderFailureCode;
  transformResponse?: (response: Response, request: Request, index: number) => Response | Promise<Response>;
}) {
  const requests: Array<{ path: string; headers: Headers; byteSize: number }> = [];
  let barrier: Promise<void> | undefined;
  let release: (() => void) | undefined;
  return {
    requests,
    get requestCount() { return requests.length; },
    hold() { barrier = new Promise<void>((resolve) => { release = resolve; }); },
    release() { release?.(); barrier = undefined; release = undefined; },
    async fetch(request: Request): Promise<Response> {
      const entry = { path: new URL(request.url).pathname, headers: new Headers(request.headers), byteSize: 0 };
      requests.push(entry);
      if (barrier) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          request.signal.addEventListener('abort', abort, { once: true });
          void barrier!.then(resolve).finally(() => request.signal.removeEventListener('abort', abort));
          if (request.signal.aborted) abort();
        });
      }
      if (request.body) {
        const reader = request.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            entry.byteSize += value.byteLength;
          }
        } finally { reader.releaseLock(); }
      }
      let response: Response;
      if (options.failure) {
        const status = { unsupported: 415, malformed: 422, resource_limit: 413, busy: 429, unavailable: 503 }[options.failure];
        response = Response.json({ code: options.failure }, { status, headers: { 'X-Decoder-Protocol': '1' } });
      } else if (entry.path === '/v1/preview') {
        response = new Response(Uint8Array.from(options.previewBytes), { headers: {
          'X-Decoder-Protocol': '1', 'Content-Type': 'image/webp', 'Content-Length': String(options.previewBytes.length),
          'X-Decoder-Inspection': JSON.stringify(options.inspection),
          'X-Preview-Width': '1600', 'X-Preview-Height': '1200', 'X-Preview-Frames': String(options.inspection.frameCount),
        } });
      } else if (entry.path === '/health') {
        response = Response.json({ protocolVersion: 1, buildFingerprint: options.inspection.buildFingerprint,
          decoderVersion: options.inspection.decoderVersion }, { headers: { 'X-Decoder-Protocol': '1' } });
      } else {
        response = Response.json(options.inspection, { headers: { 'X-Decoder-Protocol': '1' } });
      }
      return options.transformResponse?.(response, request, requests.length - 1) ?? response;
    },
  };
}

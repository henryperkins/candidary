import { describe, expect, it, vi } from 'vitest';
import { ImageDecoderClient } from '../../worker/services/image-decoder';
import { type DecoderSource } from '../../shared/image-decoder-contract';
import { createDecoderDouble, decoderInspection } from './fixtures/image-decoder';

const proof = decoderInspection();
const previewBytes = Uint8Array.of(1, 2, 3);
function source(signal?: AbortSignal): DecoderSource {
  return {
    byteSize: 4, declared: { family: 'jpeg', mimeType: 'image/jpeg', requiresSequence: false }, signal,
    open: vi.fn(async () => new Response(Uint8Array.of(10, 20, 30, 40)).body!),
  };
}
function client(double: ReturnType<typeof createDecoderDouble>, lane: 'upload' | 'preview' = 'upload') {
  return new ImageDecoderClient((request) => double.fetch(request), [proof.buildFingerprint], lane);
}

describe('private decoder streaming adapter', () => {
  it('sends the bounded private request and accepts a valid inspect/preview control', async () => {
    const double = createDecoderDouble({ inspection: proof, previewBytes });
    expect(await client(double).inspectOriginal(source())).toEqual(proof);
    const preview = await client(double, 'preview').renderOriginalPreview(source());
    expect(preview).toMatchObject({ byteSize: 3, width: 1600, height: 1200, frameCount: 1, inspection: proof });
    expect(new Uint8Array(await new Response(preview.body).arrayBuffer())).toEqual(previewBytes);
    expect(double.requests.map((item) => item.path)).toEqual(['/v1/inspect', '/v1/preview']);
    expect(double.requests.map((item) => item.byteSize)).toEqual([4, 4]);
    expect(Object.fromEntries(double.requests[1]!.headers)).toMatchObject({
      'x-decoder-protocol': '1', 'x-decoder-lane': 'preview', 'x-image-family': 'jpeg',
      'x-image-sequence': '0', 'x-source-length': '4', 'content-type': 'application/octet-stream',
    });
  });

  it('rejects an empty preview when all other protocol and proof headers remain valid', async () => {
    const double = createDecoderDouble({ inspection: proof, previewBytes, transformResponse(response) {
      const headers = new Headers(response.headers); headers.set('Content-Length', '0');
      return new Response(new Uint8Array(0), { headers });
    } });
    await expect(client(double).renderOriginalPreview(source())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each([20 * 1024 * 1024, 20 * 1024 * 1024 + 1])('bounds animated preview transport at 20 MiB: %i bytes', async (byteSize) => {
    const animation = decoderInspection({ family: 'webp', frameCount: 2, isSequence: true });
    const double = createDecoderDouble({ inspection: animation, previewBytes, transformResponse(response) {
      const headers = new Headers(response.headers); headers.set('Content-Length', String(byteSize));
      let sent = 0;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (sent === byteSize) { controller.close(); return; }
        const count = Math.min(65536, byteSize - sent); sent += count;
        controller.enqueue(new Uint8Array(count));
      } }), { headers });
    } });
    const original = source(); original.declared = { family: 'webp', mimeType: 'image/webp', requiresSequence: false };
    if (byteSize > 20 * 1024 * 1024) {
      await expect(client(double).renderOriginalPreview(original)).rejects.toMatchObject({ code: 'unavailable' });
    } else {
      const preview = await client(double).renderOriginalPreview(original);
      expect(preview.byteSize).toBe(byteSize);
      const reader = preview.body.getReader(); let received = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; received += part.value.byteLength; }
      reader.releaseLock(); expect(received).toBe(byteSize);
    }
  });

  it.each(['X-Decoder-Protocol', 'Content-Type', 'Content-Length', 'X-Decoder-Inspection', 'X-Preview-Width', 'X-Preview-Height', 'X-Preview-Frames'])('rejects missing %s on a preview', async (name) => {
    const double = createDecoderDouble({ inspection: proof, previewBytes, transformResponse(response) {
      response.headers.delete(name); return response;
    } });
    await expect(client(double).renderOriginalPreview(source())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each([
    ['X-Decoder-Protocol', '2'], ['Content-Type', 'image/svg+xml'], ['Content-Length', '8388609'],
    ['X-Decoder-Inspection', ' '.repeat(2049)], ['X-Preview-Width', '0'], ['X-Preview-Height', '1601'],
    ['X-Preview-Frames', '2'], ['Content-Length', '3.0'],
  ])('rejects invalid preview %s=%s', async (name, value) => {
    const double = createDecoderDouble({ inspection: proof, previewBytes, transformResponse(response) {
      response.headers.set(name!, value!); return response;
    } });
    await expect(client(double).renderOriginalPreview(source())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each([
    { buildFingerprint: 'c'.repeat(64) }, { byteSize: 5 }, { family: 'avif' as const }, { width: 0 },
  ])('refuses mismatched inspection identity: %j', async (change) => {
    const double = createDecoderDouble({ inspection: { ...proof, ...change }, previewBytes });
    await expect(client(double).inspectOriginal(source())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it.each(['unsupported', 'malformed', 'resource_limit'] as const)('does not retry a permanent %s refusal', async (failure) => {
    const double = createDecoderDouble({ inspection: proof, previewBytes, failure });
    await expect(client(double).inspectOriginal(source())).rejects.toMatchObject({ code: failure, message: `Image decoder ${failure}.` });
    expect(double.requestCount).toBe(1);
  });

  it('reopens inputs and excludes prior busy instances for at most three attempts', async () => {
    const double = createDecoderDouble({ inspection: proof, previewBytes, failure: 'busy', transformResponse(response, _request, index) {
      response.headers.set('X-Decoder-Instance', `instance-${index}`); return response;
    } });
    const original = source();
    await expect(client(double).inspectOriginal(original)).rejects.toMatchObject({ code: 'busy' });
    expect(double.requestCount).toBe(3);
    expect(original.open).toHaveBeenCalledTimes(3);
    expect(double.requests.map((item) => item.headers.get('X-Decoder-Exclude-Instances')))
      .toEqual([null, 'instance-0', 'instance-0,instance-1']);
  });

  it.each(['inspect','preview'] as const)('excludes a successful but differently pinned build before retrying %s', async (operation) => {
    const wrong = createDecoderDouble({inspection:{...proof,buildFingerprint:'e'.repeat(64)},previewBytes,
      transformResponse(response) {response.headers.set('X-Decoder-Instance','build-b'); return response;}});
    const matching = createDecoderDouble({inspection:proof,previewBytes,
      transformResponse(response) {response.headers.set('X-Decoder-Instance','build-a'); return response;}});
    const original = source();
    const adapter = new ImageDecoderClient(request => request.headers.get('X-Decoder-Exclude-Instances')==='build-b'
      ? matching.fetch(request) : wrong.fetch(request),[proof.buildFingerprint],'upload');
    if (operation==='inspect') expect(await adapter.inspectOriginal(original)).toEqual(proof);
    else expect(new Uint8Array(await new Response((await adapter.renderOriginalPreview(original)).body).arrayBuffer())).toEqual(previewBytes);
    expect(wrong.requestCount).toBe(1); expect(matching.requestCount).toBe(1); expect(original.open).toHaveBeenCalledTimes(2);
  });

  it('cleans up an unread input before opening the next attempt', async () => {
    const events: string[] = [];
    const original = source();
    original.open = async () => {
      events.push('open');
      return new ReadableStream({ cancel() { events.push('cancel'); } });
    };
    const adapter = new ImageDecoderClient(async () => { throw new Error('private native details'); }, [proof.buildFingerprint], 'upload');
    await expect(adapter.inspectOriginal(original)).rejects.toMatchObject({ code: 'unavailable', message: 'Image decoder unavailable.' });
    expect(events).toEqual(['open', 'cancel', 'open', 'cancel', 'open', 'cancel']);
  });

  it('aborts held work and opens no retry input after cancellation', async () => {
    const double = createDecoderDouble({ inspection: proof, previewBytes }); double.hold();
    const controller = new AbortController(); const original = source(controller.signal);
    const pending = client(double).inspectOriginal(original);
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(double.requestCount).toBe(1));
    controller.abort(); await result; double.release();
    expect(original.open).toHaveBeenCalledOnce();
  });

  it.each([2, 4])('detects a preview stream whose declared length %i differs from bytes', async (length) => {
    const double = createDecoderDouble({ inspection: proof, previewBytes, transformResponse(response) {
      response.headers.set('Content-Length', String(length)); return response;
    } });
    const preview = await client(double).renderOriginalPreview(source());
    await expect(new Response(preview.body).arrayBuffer()).rejects.toMatchObject({ code: 'unavailable' });
    expect(double.requestCount).toBe(1); // Never replay a response after handing its stream to a caller.
  });

  it('detects input length mismatch without forwarding native diagnostics', async () => {
    const double = createDecoderDouble({ inspection: proof, previewBytes });
    const original = source(); original.byteSize = 5;
    await expect(client(double).inspectOriginal(original)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

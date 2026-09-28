import { env } from 'cloudflare:workers';
import { routeDecoderRequest, type DecoderPools, type DecoderStub } from '../../../services/image-decoder/worker/pool';
import { DECODER_PREVIEW_PROFILE, parseDecoderHealth, requiredCasesFor, type DecoderHealth } from '../../../shared/image-decoder-contract';
import type { ImageFamily } from '../../../shared/image-formats';

/** Test-only bindings from vitest.worker.config.ts; the app's Env never names them. */
export const bridgeEnv = env as unknown as { MOBILE_IMAGE_NATIVE_BRIDGE: Fetcher; MOBILE_IMAGE_NATIVE_BRIDGE_ENABLED: string };
export const nativeBridgeEnabled = bridgeEnv.MOBILE_IMAGE_NATIVE_BRIDGE_ENABLED === '1';
export type NativeIdentity = { imageId: string; imageName: string | null; isolation: Record<string, unknown>; logsEmpty: boolean };
export type NativeCall = {
  lane: 'upload' | 'preview'; method: string; path: string; status: number; ms: number;
  preview?: { contentType: string | null; contentLength: number; width: number; height: number; frames: number };
};

export const bridgeFetch = (path: string, init?: RequestInit) => bridgeEnv.MOBILE_IMAGE_NATIVE_BRIDGE.fetch(`http://native-bridge${path}`, init);

/** Waits for the disposable container's private health route and reads its Docker identity. */
export async function nativeReadiness(): Promise<{ health: DecoderHealth; identity: NativeIdentity }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await bridgeFetch('/health');
    if (response.status === 200) {
      const health = parseDecoderHealth(await response.json());
      const identity = await bridgeFetch('/identity');
      if (identity.status !== 200) throw new Error('Native bridge identity is unavailable.');
      const value = await identity.json<NativeIdentity>();
      // Same isolation the native qualification harness requires; a differently started
      // container must not produce local-integration evidence.
      const i = value.isolation as { network?: string; readOnlyRoot?: boolean; user?: string; memoryBytes?: number;
        pidsLimit?: number; capDrop?: string[]; securityOptions?: string[] };
      if (i.network !== 'none' || i.readOnlyRoot !== true || i.user !== '10001:10001' || i.memoryBytes !== 4 * 1024 ** 3
        || i.pidsLimit !== 64 || !i.capDrop?.includes('ALL') || !i.securityOptions?.some((option) => option.startsWith('no-new-privileges'))
        || value.logsEmpty !== true) throw new Error('Native bridge container isolation differs from the qualification harness.');
      return { health, identity: value };
    }
    await response.body?.cancel();
    if (Date.now() > deadline) throw new Error('Native bridge health is unavailable.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** A local release record naming the actual build for exactly the declaration's implicated cases. */
export function nativeRelease(buildFingerprint: string, imageId: string, evidenceSha256: string, family: ImageFamily, isSequence = false) {
  return { protocolVersion: 1, previewProfile: DECODER_PREVIEW_PROFILE, releases: [{ imageRef: `candidary-image-decoder@${imageId}`, buildFingerprint,
    protocolVersion: 1, verifiedCaseIds: [...requiredCasesFor(family, isSequence)], previewProfile: DECODER_PREVIEW_PROFILE, evidenceSha256 }] };
}

/**
 * IMAGE_DECODER for the main Worker: the actual private router with separate upload and
 * preview pools, one stub each, forwarding to the actual native server through the bridge.
 */
export function createNativeDecoder(options: { release: unknown; environment: 'production' | 'preview' }) {
  const calls: NativeCall[] = [];
  const stub = (lane: NativeCall['lane']): DecoderStub => ({
    id: { toString: () => `${lane}-native-0` },
    async fetch(request: Request) {
      const call: NativeCall = { lane, method: request.method, path: new URL(request.url).pathname, status: 0, ms: Date.now() };
      calls.push(call);
      const response = await bridgeEnv.MOBILE_IMAGE_NATIVE_BRIDGE.fetch(request);
      call.status = response.status; call.ms = Date.now() - call.ms;
      if (call.path === '/v1/preview' && response.status === 200) {
        const header = (name: string) => Number(response.headers.get(name));
        call.preview = { contentType: response.headers.get('Content-Type'), contentLength: header('Content-Length'),
          width: header('X-Preview-Width'), height: header('X-Preview-Height'), frames: header('X-Preview-Frames') };
      }
      return response;
    },
  });
  const upload = stub('upload'); const preview = stub('preview');
  const pools: DecoderPools = { upload: { name: 'upload', size: 1, draw: async () => upload }, preview: { name: 'preview', size: 1, draw: async () => preview } };
  return {
    calls,
    decodes: (lane: NativeCall['lane']) => calls.filter((call) => call.lane === lane && call.method === 'POST'),
    // Mirrors services/image-decoder/worker/index.ts around the real router.
    async fetch(request: Request): Promise<Response> {
      const response = await routeDecoderRequest(request, pools, options.release);
      const headers = new Headers(response.headers);
      headers.set('X-Decoder-Environment', options.environment);
      return new Response(response.body, { status: response.status, headers });
    },
  };
}

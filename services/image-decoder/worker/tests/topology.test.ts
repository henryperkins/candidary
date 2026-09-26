import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/containers', () => ({ Container: class {}, getRandom: vi.fn() }));
// Only the measurement wiring test needs a qualified record; committed releases stay empty.
vi.mock('../../../../config/image-decoder-release.json', async () => {
  const { requiredCasesFor } = await import('../../../../shared/image-decoder-contract');
  return { default: { protocolVersion: 1, previewProfile: 'mobile-preview-v1', releases: [{ imageRef: `registry.example.test/decoder@sha256:${'c'.repeat(64)}`,
    buildFingerprint: 'a'.repeat(64), protocolVersion: 1, verifiedCaseIds: requiredCasesFor('jpeg', false), previewProfile: 'mobile-preview-v1', evidenceSha256: 'd'.repeat(64) }] } };
});
import service, { UploadImageDecoder, PreviewImageDecoder } from '../index';
import { getRandom } from '@cloudflare/containers';

function config(path: string) {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
  if (parsed.error) throw new Error('Invalid JSONC fixture.');
  return parsed.config;
}

describe('private service topology', () => {
  it('identifies the deployed environment without changing the strict health body', async () => {
    const identity = {protocolVersion:1,buildFingerprint:'a'.repeat(64),decoderVersion:'test-double-1'};
    vi.mocked(getRandom).mockReturnValue({id:{toString:() => 'instance-1'},fetch:async () => Response.json(identity)} as unknown as ReturnType<typeof getRandom>);
    for (const environment of ['production','preview']) {
      const response = await service.fetch(new Request('https://private/health',{headers:{'X-Decoder-Protocol':'1','X-Decoder-Lane':'upload','X-Decoder-Environment':'guest-controlled'}}),{
        DECODER_ENVIRONMENT:environment,UPLOAD_POOL_SIZE:'2',PREVIEW_POOL_SIZE:'2',UPLOAD_DECODERS:{},PREVIEW_DECODERS:{},
      } as unknown as Env);
      expect(response.headers.get('X-Decoder-Environment')).toBe(environment);
      expect(await response.json()).toEqual(identity);
    }
  });

  it('writes exactly one data point per native job only when the preview dataset exists', async () => {
    const metrics = { nativeMs: 13, peakRssBytes: 7340032, peakScratchBytes: 4096, sourceBytes: 4 };
    const inspection = { family: 'jpeg', width: 4, height: 3, frameCount: 1, primaryIndex: 0, isSequence: false, sourceSha256: 'e'.repeat(64),
      byteSize: 4, buildFingerprint: 'a'.repeat(64), decoderVersion: 'test-double-1', previewProfile: 'mobile-preview-v1' };
    const instance = { id: { toString: () => 'instance-1' }, fetch: async (incoming: Request) => new URL(incoming.url).pathname === '/health'
      ? Response.json({ protocolVersion: 1, buildFingerprint: 'a'.repeat(64), decoderVersion: 'test-double-1' })
      : Response.json(inspection, { headers: { 'X-Decoder-Protocol': '1', 'X-Decoder-Metrics': JSON.stringify(metrics) } }) };
    vi.mocked(getRandom).mockReset().mockResolvedValue(instance as unknown as Awaited<ReturnType<typeof getRandom>>);
    const job = () => new Request('https://private/v1/inspect', { method: 'POST', body: Uint8Array.of(1, 2, 3, 4), headers: {
      'Content-Type': 'application/octet-stream', 'X-Decoder-Protocol': '1', 'X-Decoder-Lane': 'upload', 'X-Image-Family': 'jpeg',
      'X-Image-Sequence': '0', 'X-Source-Length': '4' } });
    const pools = { UPLOAD_DECODERS: { pool: 'upload' }, PREVIEW_DECODERS: { pool: 'preview' } };
    const writeDataPoint = vi.fn();
    const measured = await service.fetch(job(), { DECODER_ENVIRONMENT: 'preview', UPLOAD_POOL_SIZE: '2', PREVIEW_POOL_SIZE: '2', ...pools,
      DECODER_METRICS: { writeDataPoint } } as unknown as Env);
    expect(measured.status).toBe(200);
    expect(measured.headers.get('X-Decoder-Metrics')).toBeNull();
    expect(vi.mocked(getRandom)).toHaveBeenCalledWith(pools.UPLOAD_DECODERS, 2);
    expect(writeDataPoint).toHaveBeenCalledOnce();
    expect(writeDataPoint).toHaveBeenCalledWith({ indexes: ['preview'], blobs: ['preview', 'upload/upload', 'inspect', 'ok', 'jpeg'], doubles: [13, 7340032, 4096, 4, 1] });
    const unmeasured = await service.fetch(job(), { DECODER_ENVIRONMENT: 'production', UPLOAD_POOL_SIZE: '2', PREVIEW_POOL_SIZE: '2', ...pools } as unknown as Env);
    expect(unmeasured.status).toBe(200);
    expect(await unmeasured.json()).toEqual(await measured.json());
  });

  it('adds the private metrics dataset to the preview twin only', () => {
    const production = config(resolve('wrangler.jsonc'));
    expect(production.analytics_engine_datasets).toBeUndefined();
    expect(production.env.preview.analytics_engine_datasets).toEqual([{ binding: 'DECODER_METRICS', dataset: 'candidary_image_decoder_preview' }]);
  });

  it('keeps prod/preview private with separate Worker-owned pool bindings', () => {
    const production = config(resolve('wrangler.jsonc'));
    const preview = production.env.preview;
    expect(production.name).toBe('candidary-image-decoder');
    expect(preview.name).toBe('candidary-image-decoder-preview');
    for (const environment of [production, preview]) {
      expect(environment.workers_dev).toBe(false);
      expect(environment.preview_urls).toBe(false);
      expect(environment.routes).toEqual([]);
      expect(environment.durable_objects.bindings).toEqual([
        { name: 'UPLOAD_DECODERS', class_name: 'UploadImageDecoder' },
        { name: 'PREVIEW_DECODERS', class_name: 'PreviewImageDecoder' },
      ]);
      expect(environment.containers.map((container: { max_instances: number }) => container.max_instances)).toEqual([2, 2]);
      expect(environment.containers[0].image).toBe(environment.containers[1].image);
    }
  });

  it('has no Internet exceptions, process recipes or guest environment variables', () => {
    for (const Type of [UploadImageDecoder, PreviewImageDecoder]) {
      const instance = Reflect.construct(Type, []);
      expect(instance.enableInternet).toBe(false);
      expect(instance.defaultPort).toBe(8080);
      expect(instance.envVars).toBeUndefined();
      expect(instance.entrypoint).toBeUndefined();
      for (const property of ['outbound', 'outboundByHost', 'outboundHandlers', 'outboundProxies', 'outboundProxy']) {
        expect(Reflect.get(Type, property)).toBeUndefined();
      }
    }
  });

  it('does not add Container/DO ownership to the application Worker', () => {
    const root = config(resolve('../../../wrangler.jsonc'));
    expect(root.containers).toBeUndefined();
    const index = readFileSync(resolve('../../../worker/index.ts'), 'utf8');
    expect(index).not.toContain('@cloudflare/containers');
    expect(readFileSync(resolve('../../../package.json'), 'utf8')).not.toContain('@cloudflare/containers');
  });
});

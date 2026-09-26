// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeBridge, nativeBridgeEnabled, type BridgeExec } from '../../scripts/mobile-image-native-bridge.mjs';

const CONTAINER = `candidary-image-bridge-${'0123456789abcdef'.repeat(2)}`;
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function corpus(files: Record<string, Uint8Array | null>) {
  const root = mkdtempSync(join(tmpdir(), 'candidary-bridge-')); scratch.push(root);
  const fixtures = join(root, 'tests/fixtures/mobile-images'); mkdirSync(join(fixtures, 'originals'), { recursive: true });
  const cases = Object.entries(files).map(([id, bytes]) => {
    if (bytes) writeFileSync(join(fixtures, 'originals', `${id}.dng`), bytes);
    return { id: 'dng-linear', fixtures: [{ id, path: `originals/${id}.dng`, sha256: createHash('sha256').update(bytes ?? new Uint8Array([7])).digest('hex') }] };
  });
  writeFileSync(join(fixtures, 'manifest.json'), JSON.stringify({ version: 1, cases }));
  return { root, fixtures };
}
function fakeExec(running = true) {
  const calls: string[][] = [];
  const exec: BridgeExec = async (args) => {
    calls.push(args);
    if (args[0] === 'inspect') return { code: 0, stdout: Buffer.from(JSON.stringify([{ Image: `sha256:${'1'.repeat(64)}`, Config: { Image: 'candidary-image-decoder:verification', User: '10001:10001' },
      State: { Running: running }, HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Memory: 4 * 1024 ** 3, NanoCpus: 2e9, PidsLimit: 64,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': 'rw,size=2147483648,uid=10001,gid=10001' } } }])), stderr: Buffer.alloc(0) };
    if (args[0] === 'logs') return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    const body = Buffer.from('preview');
    return { code: 0, stdout: Buffer.concat([Buffer.from(`${JSON.stringify({ status: 200, headers: { 'Content-Type': 'image/webp', 'Content-Length': String(body.length),
      'X-Decoder-Protocol': '1', 'X-Preview-Width': '1600', Server: 'BaseHTTP/0.6', Connection: 'close' } })}\n`), body]), stderr: Buffer.alloc(0) };
  };
  return { calls, exec };
}
const routes = [['GET', '/health'], ['POST', '/v1/preview'], ['POST', '/v1/inspect'], ['GET', '/fixture/raw-pixls-iphone-12-pro'], ['POST', '/evidence/real-original-local'], ['GET', '/identity']] as const;
const call = (bridge: (request: Request) => Promise<Response>, method: string, path: string, init: RequestInit = {}) =>
  bridge(new Request(`http://bridge${path}`, { method, ...(method === 'POST' ? { body: init.body ?? '{}' } : {}), headers: init.headers }));

describe('mobile image native bridge', () => {
  it.each(['', 'candidary-image-bridge-XYZ; docker rm -f x', 'other-container', `${CONTAINER}0`])('closes every route without a valid disposable container (%j)', async (container) => {
    const { root } = corpus({ 'raw-pixls-iphone-12-pro': new Uint8Array([1, 2, 3]) }); const fake = fakeExec();
    const bridge = createNativeBridge({ container, root, exec: fake.exec });
    for (const [method, path] of routes) {
      const response = await call(bridge, method, path);
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'unavailable' });
    }
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(root, 'output'))).toBe(false);
  });

  it('closes every route when the named container is not running', async () => {
    const { root } = corpus({}); const fake = fakeExec(false);
    const bridge = createNativeBridge({ container: CONTAINER, root, exec: fake.exec });
    for (const [method, path] of routes) expect((await call(bridge, method, path)).status).toBe(503);
    expect(fake.calls.every((args) => args[0] === 'inspect')).toBe(true);
  });

  it('forwards only protocol headers in both directions', async () => {
    const { root } = corpus({}); const fake = fakeExec();
    const bridge = createNativeBridge({ container: CONTAINER, root, exec: fake.exec });
    const response = await call(bridge, 'POST', '/v1/preview', { body: new Uint8Array([9, 9]), headers: { 'Content-Type': 'application/octet-stream',
      'X-Decoder-Protocol': '1', 'X-Image-Family': 'dng', cookie: 'secret=1', 'X-Decoder-Exclude-Instances': 'a' } });
    expect(response.status).toBe(200); expect(await response.text()).toBe('preview');
    expect([...response.headers.keys()].sort()).toEqual(['content-length', 'content-type', 'x-decoder-protocol', 'x-preview-width']);
    const native = fake.calls.find((args) => args[0] === 'exec')!;
    expect(native.slice(0, 3)).toEqual(['exec', '-i', CONTAINER]);
    expect(JSON.parse(Buffer.from(native[8]!, 'base64').toString())).toEqual({ 'Content-Type': 'application/octet-stream', 'X-Decoder-Protocol': '1', 'X-Image-Family': 'dng' });
    expect(native.slice(7)).toEqual(['POST', native[8], '/v1/preview']);
  });

  it('serves a manifest original only when its bytes still match the pinned SHA-256', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { root, fixtures } = corpus({ 'raw-pixls-iphone-12-pro': bytes, 'raw-pixls-galaxy-s23-ultra': null });
    const bridge = createNativeBridge({ container: CONTAINER, root, exec: fakeExec().exec });
    const ok = await call(bridge, 'GET', '/fixture/raw-pixls-iphone-12-pro');
    expect(ok.status).toBe(200); expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);
    writeFileSync(join(fixtures, 'originals/raw-pixls-iphone-12-pro.dng'), new Uint8Array([1, 2, 3, 5]));
    const changed = await call(bridge, 'GET', '/fixture/raw-pixls-iphone-12-pro');
    expect(changed.status).toBe(409); expect(await changed.json()).toEqual({ code: 'mismatch' });
    for (const id of ['raw-pixls-galaxy-s23-ultra', 'unknown-fixture', '..%2Fmanifest.json', 'UPPER']) {
      const response = await call(bridge, 'GET', `/fixture/${id}`); expect([400, 404]).toContain(response.status);
      expect(response.headers.get('content-type')).toBe('application/json');
    }
  });

  it('writes bounded evidence only under an allowlisted name', async () => {
    const { root } = corpus({}); const bridge = createNativeBridge({ container: CONTAINER, root, exec: fakeExec().exec });
    for (const name of ['..%2Fescape', 'Upper', 'a_b', 'x'.repeat(65), 'a.json', 'rendering-wsl', 'raw-wsl', `real-original-${'x'.repeat(51)}`]) {
      expect((await call(bridge, 'POST', `/evidence/${name}`)).status).toBe(400);
    }
    expect((await call(bridge, 'POST', '/evidence/real-original-local', { body: '[1]' })).status).toBe(400);
    expect((await call(bridge, 'POST', '/evidence/real-original-local', { body: JSON.stringify({ pad: 'x'.repeat(64 * 1024) }) })).status).toBe(413);
    expect(existsSync(join(root, 'output'))).toBe(false);
    const written = await call(bridge, 'POST', '/evidence/real-original-local', { body: JSON.stringify({ kind: 'local-integration' }) });
    expect(written.status).toBe(201);
    const evidence = JSON.parse(readFileSync(join(root, 'output/verification/mobile-images/real-original-local.json'), 'utf8'));
    expect(evidence).toMatchObject({ kind: 'local-integration', bridge: { docker: { imageId: `sha256:${'1'.repeat(64)}`, logsEmpty: true, isolation: { network: 'none', readOnlyRoot: true } } } });
  });

  it('enables the Worker suite only for a valid container name and both present originals', () => {
    const complete = corpus({ 'raw-pixls-iphone-12-pro': new Uint8Array([1]), 'raw-pixls-galaxy-s23-ultra': new Uint8Array([2]) });
    const partial = corpus({ 'raw-pixls-iphone-12-pro': new Uint8Array([1]), 'raw-pixls-galaxy-s23-ultra': null });
    expect(nativeBridgeEnabled({ env: { CANDIDARY_NATIVE_BRIDGE_CONTAINER: CONTAINER }, root: complete.root })).toBe(true);
    expect(nativeBridgeEnabled({ env: {}, root: complete.root })).toBe(false);
    expect(nativeBridgeEnabled({ env: { CANDIDARY_NATIVE_BRIDGE_CONTAINER: 'bad name' }, root: complete.root })).toBe(false);
    expect(nativeBridgeEnabled({ env: { CANDIDARY_NATIVE_BRIDGE_CONTAINER: CONTAINER }, root: partial.root })).toBe(false);
  });
});

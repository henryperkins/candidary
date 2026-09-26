/* global Buffer, Headers, Response, URL, clearTimeout, process, setTimeout */
// Test-only Miniflare Node service: forwards the private decoder protocol into one
// disposable local native container. Never logs bodies, headers, filenames or errors.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const BRIDGE_CONTAINER_PATTERN = /^candidary-image-bridge-[0-9a-f]{32}$/u;
export const REAL_ORIGINAL_FIXTURES = ['raw-pixls-iphone-12-pro', 'raw-pixls-galaxy-s23-ultra'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'tests/fixtures/mobile-images/manifest.json';
const EVIDENCE = 'output/verification/mobile-images';
const DISTRIBUTION = 'Ubuntu-26.04';
const NATIVE_SECONDS = 140;
const MAX_HEADER = 8192;
const MAX_BODY = 20 * 1024 * 1024;
const MAX_EVIDENCE = 64 * 1024;
const REQUEST_HEADERS = ['Content-Type', 'X-Decoder-Protocol', 'X-Decoder-Lane', 'X-Image-Family', 'X-Image-Sequence', 'X-Source-Length'];
const RESPONSE_HEADERS = ['content-type', 'content-length', 'x-decoder-protocol', 'x-decoder-inspection', 'x-preview-width', 'x-preview-height', 'x-preview-frames'];
// Same protocol as verify_service.py CLIENT: one JSON status/header line, then the body.
// Base64 arguments keep wsl.exe command-line quoting out of the code and headers.
const CLIENT = Buffer.from(`import base64,http.client,json,sys
connection=http.client.HTTPConnection('127.0.0.1',8080,timeout=135)
headers=json.loads(base64.b64decode(sys.argv[3]))
connection.request(sys.argv[2],sys.argv[4],body=sys.stdin.buffer if sys.argv[2]=='POST' else None,headers=headers)
response=connection.getresponse()
sys.stdout.buffer.write((json.dumps({'status':response.status,'headers':dict(response.getheaders())})+'\\n').encode())
while chunk:=response.read(65536): sys.stdout.buffer.write(chunk)
connection.close()
`).toString('base64');
const LAUNCH = 'import base64,sys;exec(base64.b64decode(sys.argv[1]))';

const closed = (status, code) => Response.json({ code }, { status });
const unavailable = () => closed(503, 'unavailable');

/** Runs `docker <args>` through the WSL Unix socket, bounded in time and captured bytes. */
export const wslDocker = (args, { input = null, timeoutMs = NATIVE_SECONDS * 1000, maxStdout = MAX_HEADER + MAX_BODY } = {}) => new Promise((done) => {
  const [command, argv] = process.platform === 'win32'
    ? ['wsl.exe', ['--distribution', DISTRIBUTION, '--exec', 'env', '-u', 'DOCKER_CONTEXT', 'DOCKER_HOST=unix:///var/run/docker.sock', 'docker', ...args]]
    : ['docker', args];
  const child = spawn(command, argv, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } });
  const stdout = []; const stderr = []; let size = 0; let failed = false; let settled = false;
  const finish = (code) => { if (!settled) { settled = true; clearTimeout(timer); done({ code: failed ? -1 : code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); } };
  const stop = () => { failed = true; child.kill('SIGKILL'); };
  const timer = setTimeout(stop, timeoutMs);
  child.stdout.on('data', (chunk) => { size += chunk.length; if (size > maxStdout) stop(); else stdout.push(chunk); });
  child.stderr.on('data', (chunk) => { if (stderr.reduce((total, part) => total + part.length, 0) + chunk.length <= 4096) stderr.push(chunk); });
  child.on('error', () => { failed = true; finish(-1); });
  child.on('close', finish);
  if (input) {
    child.stdin.on('error', () => {}); // An early native refusal may close stdin first.
    const source = Readable.fromWeb(input);
    source.on('error', () => { child.stdin.destroy(); });
    source.pipe(child.stdin);
  }
});

function manifestFixture(root, id) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  for (const record of manifest.cases ?? []) for (const fixture of record.fixtures ?? []) if (fixture.id === id) return { caseId: record.id, fixture };
  return null;
}
function inside(base, target) {
  const part = relative(base, target);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function fixtureFile(root, fixture) {
  const base = dirname(join(root, MANIFEST));
  const target = resolve(base, String(fixture.path ?? ''));
  return typeof fixture.path === 'string' && inside(base, target) ? target : null;
}

/** Worker tests run only when a disposable container is named and both real originals are present. */
export function nativeBridgeEnabled({ env = process.env, root = ROOT } = {}) {
  if (!BRIDGE_CONTAINER_PATTERN.test(env.CANDIDARY_NATIVE_BRIDGE_CONTAINER ?? '')) return false;
  try {
    return REAL_ORIGINAL_FIXTURES.every((id) => {
      const entry = manifestFixture(root, id); const path = entry && fixtureFile(root, entry.fixture);
      return Boolean(path && existsSync(path));
    });
  } catch { return false; }
}

async function boundedBody(request, limit) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader(); const parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) return null;
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}

export function createNativeBridge({ container = process.env.CANDIDARY_NATIVE_BRIDGE_CONTAINER ?? '', root = ROOT, exec = wslDocker } = {}) {
  let running;
  const inspect = async () => {
    const result = await exec(['inspect', container], { timeoutMs: 30_000, maxStdout: 1024 * 1024 });
    if (result.code !== 0) throw new Error('inspect');
    const info = JSON.parse(result.stdout.toString('utf8'))[0];
    if (!info || info.State?.Running !== true) throw new Error('inspect');
    return info;
  };
  // Only a positive check is cached; a later docker exec failure still fails closed.
  const ready = () => (running ??= inspect().then(() => true, () => { running = undefined; return false; }));

  async function identity() {
    const info = await inspect(); const host = info.HostConfig ?? {};
    const logs = await exec(['logs', container], { timeoutMs: 30_000, maxStdout: 4096 });
    return { imageId: info.Image, imageName: info.Config?.Image ?? null, running: true,
      isolation: { network: host.NetworkMode, readOnlyRoot: host.ReadonlyRootfs, user: info.Config?.User, memoryBytes: host.Memory,
        nanoCpus: host.NanoCpus, pidsLimit: host.PidsLimit, capDrop: host.CapDrop, securityOptions: host.SecurityOpt, tmpfs: host.Tmpfs },
      logsEmpty: logs.code === 0 && logs.stdout.length === 0 && logs.stderr.length === 0 };
  }

  async function native(request, path) {
    const headers = {};
    for (const name of REQUEST_HEADERS) { const value = request.headers.get(name); if (value !== null) headers[name] = value; }
    const method = path === '/health' ? 'GET' : 'POST';
    const result = await exec(['exec', '-i', container, 'python', '-c', LAUNCH, CLIENT, method, Buffer.from(JSON.stringify(headers)).toString('base64'), path],
      { input: method === 'POST' ? request.body : null });
    if (result.code !== 0) return unavailable();
    const newline = result.stdout.indexOf(0x0a);
    if (newline < 1 || newline > MAX_HEADER) return unavailable();
    const head = JSON.parse(result.stdout.subarray(0, newline).toString('utf8'));
    const body = result.stdout.subarray(newline + 1);
    if (!Number.isInteger(head.status) || head.status < 200 || head.status > 599 || body.length > MAX_BODY) return unavailable();
    const forwarded = new Headers();
    for (const [name, value] of Object.entries(head.headers ?? {})) {
      if (RESPONSE_HEADERS.includes(name.toLowerCase()) && typeof value === 'string') forwarded.set(name, value);
    }
    if (forwarded.has('content-length') && Number(forwarded.get('content-length')) !== body.length) return unavailable();
    return new Response(body.length ? body : null, { status: head.status, headers: forwarded });
  }

  async function fixture(id) {
    if (!/^[a-z0-9-]{1,80}$/u.test(id)) return closed(400, 'invalid');
    const entry = manifestFixture(root, id); const path = entry && fixtureFile(root, entry.fixture);
    if (!path || !/^[a-f0-9]{64}$/u.test(entry.fixture.sha256 ?? '')) return closed(404, 'missing');
    let bytes;
    try {
      const real = await realpath(path);
      if (!inside(await realpath(dirname(join(root, MANIFEST))), real) || !(await stat(real)).isFile()) return closed(404, 'missing');
      bytes = await readFile(real);
    } catch { return closed(404, 'missing'); }
    // The manifest pins no byte count; the pinned SHA-256 binds content and length.
    if (createHash('sha256').update(bytes).digest('hex') !== entry.fixture.sha256) return closed(409, 'mismatch');
    return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) } });
  }

  async function evidence(request, name) {
    // A fixed prefix keeps this route away from the harness's *-wsl.json qualification reports.
    if (!/^real-original-[a-z0-9-]{1,50}$/u.test(name)) return closed(400, 'invalid');
    const bytes = await boundedBody(request, MAX_EVIDENCE);
    if (!bytes) return closed(413, 'too_large');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { return closed(400, 'invalid'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return closed(400, 'invalid');
    const versions = {};
    for (const name of ['vitest', '@cloudflare/vitest-pool-workers', 'miniflare', 'wrangler']) {
      try { versions[name] = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { versions[name] = null; }
    }
    const record = { ...value, bridge: { recordedAt: new Date().toISOString(), container, docker: await identity(), runtime: { node: process.version, ...versions } } };
    const directory = join(root, EVIDENCE);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return Response.json({ written: `${EVIDENCE}/${name}.json` }, { status: 201 });
  }

  return async function handle(request) {
    try {
      if (!BRIDGE_CONTAINER_PATTERN.test(container) || !await ready()) return unavailable();
      const { pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname === '/health') return await native(request, pathname);
      if (request.method === 'POST' && (pathname === '/v1/inspect' || pathname === '/v1/preview')) return await native(request, pathname);
      if (request.method === 'GET' && pathname === '/identity') return Response.json(await identity());
      if (request.method === 'GET' && pathname.startsWith('/fixture/')) return await fixture(pathname.slice('/fixture/'.length));
      if (request.method === 'POST' && pathname.startsWith('/evidence/')) return await evidence(request, pathname.slice('/evidence/'.length));
      return closed(404, 'not_found');
    } catch {
      return unavailable();
    }
  };
}

let bridge;
/** Miniflare service-binding handler; reads the container name when first used. */
export function nativeBridge(request) {
  return (bridge ??= createNativeBridge())(request);
}

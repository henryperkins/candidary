/* global AbortSignal, Buffer, URL, console, fetch, process */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const native = 'services/image-decoder/native';
const cache = 'output/verification/mobile-image-build-sources';
// Candidate resolution starts from the reviewed explicit lock, never moving releases.
const reviewedLock = JSON.parse(await readFile(`${native}/dependencies.lock.json`, 'utf8'));
const { baseImage, dependencies: candidates } = reviewedLock;

async function digestFile(path) {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex');
}
async function source(entry) {
  if (!/^[a-z0-9-]+$/u.test(entry.name) || !entry.url.startsWith('https://') || !entry.revision || !entry.license || !Array.isArray(entry.flags)) throw new Error('Invalid lock entry.');
  await mkdir(cache, { recursive: true });
  const path = join(cache, `${entry.name}-${basename(new URL(entry.url).pathname)}`);
  try {
    const existing = await digestFile(path);
    if (!entry.sha256 || existing === entry.sha256) return existing;
    throw new Error(`Cached source hash mismatch: ${entry.name}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Source download failed: ${entry.name} (${response.status})`);
  const hash = createHash('sha256');
  let count = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(bytes, _encoding, callback) {
    count += bytes.length;
    if (count > 256 * 1024 * 1024) { callback(new Error('Source archive exceeds download budget.')); return; }
    hash.update(bytes); callback(null, bytes);
  } }), createWriteStream(path, { flags: 'wx' }));
  return hash.digest('hex');
}
const canonical = (value) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
async function fingerprint() {
  const files = (await readdir(native)).filter((path) => path === 'Dockerfile' || /\.(py|cpp|h|txt|xml|json)$/u.test(path))
    .filter((path) => path !== 'build-identity.json').map((path) => `${native}/${path}`);
  files.push('shared/image-decoder-contract.ts', 'shared/image-formats.ts', 'shared/mobile-image-cases.json');
  const hashes = {};
  for (const path of files.sort()) {
    let bytes = await readFile(path);
    if (path.endsWith('.json')) bytes = Buffer.from(canonical(JSON.parse(bytes.toString('utf8'))));
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
  }
  return { protocolVersion: 1, buildFingerprint: createHash('sha256').update(canonical(hashes)).digest('hex'), decoderVersion: 'candidary-native-1', inputs: hashes };
}

const args = process.argv.slice(2);
if (args.includes('--resolve')) {
  const dependencies = [];
  for (const entry of candidates) {
    const sha256 = await source(entry);
    if (entry.sha256 && entry.sha256 !== sha256) throw new Error(`Published source digest mismatch: ${entry.name}`);
    dependencies.push({ ...entry, sha256 });
    console.log(`Resolved ${entry.name} ${entry.revision}: ${sha256}`);
  }
  const path = join(cache, 'dependencies.candidate.json');
  await writeFile(path, JSON.stringify({ version: 1, baseImage, dependencies }, null, 2) + '\n');
  console.log(`Review candidate before locking: ${path}`);
} else if (args.includes('--verify')) {
  const lock = JSON.parse(await readFile(`${native}/dependencies.lock.json`, 'utf8'));
  if (lock.version !== 1 || !/^python@sha256:[a-f0-9]{64}$/u.test(lock.baseImage.ref) || lock.baseImage.platform !== 'linux/amd64') throw new Error('Missing immutable Linux AMD64 base image.');
  const dockerfile = await readFile(`${native}/Dockerfile`, 'utf8');
  if (!dockerfile.includes(`FROM ${lock.baseImage.ref}`)) throw new Error('Dockerfile base differs from lock.');
  const names = new Set();
  for (const entry of lock.dependencies) {
    if (names.has(entry.name) || !/^[a-f0-9]{64}$/u.test(entry.sha256) || await source(entry) !== entry.sha256) throw new Error(`Invalid source pin: ${entry.name}`);
    names.add(entry.name);
    console.log(`Verified ${entry.name} ${entry.revision}`);
  }
  const identity = await fingerprint();
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  console.log(`Source/build fingerprint: ${identity.buildFingerprint}`);
} else {
  throw new Error('Use --resolve for reviewable candidates, or --verify for existing immutable pins.');
}

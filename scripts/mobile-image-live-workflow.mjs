/* global AbortSignal, Buffer, Headers, TextDecoder, URL, URLSearchParams, console, performance, process, setTimeout */
/**
 * Live-workflow recorder for the deployed PREVIEW original/privacy/deletion lane.
 *
 * It produces the `live-workflow` evidence document that
 * scripts/verify-mobile-image-corpus.mjs accepts through a fixture's
 * `evidence.live` pointer. Inside one dedicated preview event it uploads every
 * selected fixture as a guest exactly as the browser does (the server negotiates
 * direct or parts-v1), requires a delivered receipt only after delivery, proves
 * the private preview is visible to its owner and the manager and denied to
 * another guest and to a signed-out reader, closes guest intake, then proves the
 * manager original, the frozen ZIP member and the original restored from Recently
 * deleted are byte-identical to the pinned fixture, and that the guest's
 * permanent deletion is enforced everywhere.
 *
 * The default is a request-free dry run. Live mode requires --live,
 * CANDIDARY_LIVE_WORKFLOW_CONFIRM=I_UNDERSTAND and --authorization <absolute path>
 * to a separately issued, expiring authorization whose private files Git does not
 * track; every selected original is re-hashed before the first request. It speaks
 * only Candidary's public HTTP API to the one authorized preview origin, never
 * logs, fails message-free, and writes one allowlisted document (no identifiers,
 * credentials, cookies, filenames or paths), named by its own SHA-256, into an
 * existing Git-ignored directory inside the evidence root.
 *
 *   node scripts/mobile-image-live-workflow.mjs [--manifest <path>] [--fixture-root <dir>] [--cases <id,id>]
 *   CANDIDARY_LIVE_WORKFLOW_CONFIRM=I_UNDERSTAND node scripts/mobile-image-live-workflow.mjs --live \
 *     --authorization <absolute path> --out <dir> [--manifest <path>] [--fixture-root <dir>] [--evidence-root <dir>]
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredCaseIds } from './verify-mobile-image-corpus.mjs';

export const RECORDER_VERSION = 1;
const MiB = 1024 ** 2;
/** Mirrors shared/mobile-image-contract.ts MOBILE_IMAGE_PART_BYTES; a unit test pins the pair. */
export const PART_BYTES = 8 * MiB;
/** Mirrors shared/constants.ts MAX_IMAGE_BYTES, the direct-transport ceiling; a unit test pins the pair. */
export const DIRECT_MAX_BYTES = 20 * MiB;
/** Mirrors shared/origins.ts PREVIEW_APPLICATION_ROOT_ORIGIN; a unit test pins the pair. */
export const PREVIEW_ROOT_ORIGIN = 'https://candidary-preview.lfd.workers.dev';
/**
 * The declared MIME type for each fixture extension: shared/image-formats.ts
 * KNOWN_IMAGE_FORMATS, extension -> canonical type, plus one explicit alias. A unit
 * test pins every other entry to that table so the two cannot drift; an extension
 * in neither cannot be declared and is recorded as not admitted.
 */
export const MIME_BY_EXTENSION = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', apng: 'image/png',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', dng: 'image/dng', avif: 'image/avif', gif: 'image/gif',
  tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', jp2: 'image/jp2', jxl: 'image/jxl',
  // Explicit alias outside KNOWN_IMAGE_FORMATS (controller ruling): an AVIF image sequence is declared with the
  // IANA-registered, sequence-unspecified `image/avif`, which is what browsers report for animated AVIF. The server
  // resolves it as a still AVIF declaration and requires the avif-sequence case from the decoded frames at
  // completion. It is never declared `image/avif-sequence`, and shared/image-formats.ts (a decoder fingerprint
  // input) is deliberately left unchanged.
  avifs: 'image/avif',
});
/** Alias extensions the capabilities never list: admitted on their declared MIME type alone, as the browser does. */
const DECLARATION_ALIASES = Object.freeze(['avifs']);
/** The still types of shared/image-formats.ts LEGACY_UPLOAD_MIME_TYPES: the only declarations the direct path carries. */
export const DIRECT_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const MAX_JSON_BYTES = 1024 * 1024; // The corpus verifier's evidence bound; private inputs share it.
const MAX_MANIFEST_BYTES = 8 * MiB;
const MAX_CREDENTIALS_BYTES = 64 * 1024;
const MAX_FIXTURES = 200;
const MAX_API_JSON_BYTES = 4 * MiB;
const MAX_CSV_BYTES = 64 * MiB;
const MAX_PREVIEW_BYTES = 64 * MiB;
const MAX_DENIAL_BYTES = 64 * 1024;
const MAX_SCAN_BYTES = 16 * MiB;
const MAX_TRASH_PAGES = 400;
const GUEST_NAME = 'Live workflow recorder';
const DEFAULT_MANIFEST = 'tests/fixtures/mobile-images/manifest.json';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_ROOT_HOST = new URL(PREVIEW_ROOT_ORIGIN).hostname;
// shared/origins.ts PREVIEW_ALIAS_PATTERN: branch aliases and hexadecimal version prefixes.
const PREVIEW_ALIAS = /^[a-z0-9][a-z0-9-]{0,44}$/u;
const CSRF_HEADERS = Object.freeze({ candidary_csrf: 'x-candidary-csrf', candidary_host_csrf: 'x-candidary-host-csrf', candidary_rsvp_csrf: 'x-candidary-rsvp-csrf' });
const INTAKE_STATES = Object.freeze(['scheduled', 'open-early', 'open', 'paused']);
// Legal photo-intake transitions: before the event starts scheduled <-> open-early, afterwards paused <-> open.
const OPEN_ACTIONS = Object.freeze({ scheduled: 'open_early', paused: 'reopen' });
const CLOSE_ACTIONS = Object.freeze({ 'open-early': 'return_to_schedule', open: 'pause' });
const TRANSIENT_READS = new Set([429, 502, 503, 504]);
const credentialPattern = /^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{1,512}$/u;
const eventIdPattern = /^[a-zA-Z0-9_-]{8,128}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (root, path) => { const part = relative(root, path); return part === '' || !(part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pick = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null);
const mimeFor = (extension) => pick(MIME_BY_EXTENSION, extension);
const retryable = (status) => status === 429 || status >= 500;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const attempted = async (operation) => { try { return await operation(); } catch { return null; } };
// verify-mobile-image-release.mjs `image`: an externally obtained registry digest. A containerd-local
// `name@sha256:` reference or a loopback registry cannot stand in for it.
const externalImageRef = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(value)
  && /^(?!localhost(?::|$))(?!127\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]{1,5})?\/[^@]+@/iu.test(value);

const REFUSALS = Object.freeze({
  'confirmation-required': 'Live mode requires --live, CANDIDARY_LIVE_WORKFLOW_CONFIRM=I_UNDERSTAND and --authorization <absolute path>.',
  'private-path': 'The authorization and credentials must be existing absolute files that Git does not track (ignored, or outside the repository).',
  'authorization-invalid': 'A current, explicit mobile-image live authorization for one dedicated preview event is required.',
  'output-invalid': 'The output directory must already exist inside the evidence root and be ignored by Git.',
  'cases-invalid': 'Select one or more required case IDs that have manifest fixtures.',
  'fixtures-invalid': 'The selected cases must name manifest fixtures whose local originals match their pinned SHA-256.',
  'credentials-invalid': 'The live credentials file does not match the authorized event.',
  'document-too-large': "The evidence document exceeds the corpus verifier's 1 MiB bound; split the run.",
  'write-failed': 'Could not create the evidence file without replacing different content.',
});

/** A refusal carries only a fixed code and its fixed sentence. */
export class LiveRefusal extends Error {
  constructor(code) {
    const known = Object.hasOwn(REFUSALS, code) ? code : 'authorization-invalid';
    super(REFUSALS[known]);
    this.name = 'LiveRefusal';
    this.code = known;
  }
}
/** Deliberately message-free: nothing request-, response- or credential-derived can escape in an exception. */
class LiveFailure extends Error { constructor() { super('Live workflow operation failed.'); this.name = 'LiveFailure'; } }
const fail = () => { throw new LiveFailure(); };

/** shared/origins.ts isPreviewApplicationOrigin, restricted to the bare form an authorization must name. */
export function isPreviewOrigin(value) {
  if (typeof value !== 'string') return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.origin !== value) return false;
  if (url.hostname === PREVIEW_ROOT_HOST) return true;
  const suffix = `-${PREVIEW_ROOT_HOST}`;
  return url.hostname.endsWith(suffix) && PREVIEW_ALIAS.test(url.hostname.slice(0, -suffix.length));
}

/* ------------------------------------------------------------ local files */

async function digestFile(path) {
  const hash = createHash('sha256'); let byteSize = 0;
  for await (const bytes of createReadStream(path)) { hash.update(bytes); byteSize += bytes.length; }
  return { sha256: hash.digest('hex'), byteSize };
}

/** A manifest-relative original that stays inside its root after links resolve; null when absent or escaping. */
async function containedFile(root, path) {
  if (!text(path) || isAbsolute(path) || path.includes('\0')) return null;
  const target = resolve(root, path);
  if (!inside(root, target)) return null;
  try {
    const real = await realpath(target);
    return inside(await realpath(root), real) && (await stat(real)).isFile() ? real : null;
  } catch { return null; }
}

async function readJsonFile(path, code, limit = MAX_JSON_BYTES) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limit) throw new LiveRefusal(code);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { throw new LiveRefusal(code); }
}

function defaultIgnored(path) {
  const result = spawnSync('git', ['check-ignore', '-q', path], { cwd: dirname(path), stdio: 'ignore', timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return result.status === 0;
}
/** Like mobile-image-load-harness.mjs authorizeLoad: an existing absolute file outside the repository or ignored by it. */
function privateFile(value, context) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return false;
  try {
    const real = realpathSync(value);
    if (!statSync(real).isFile()) return false;
    return !inside(realpathSync(context.repoRoot), real) || (context.isIgnored ?? defaultIgnored)(real) === true;
  } catch { return false; }
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000 });
  if (result.error) throw new LiveRefusal('output-invalid');
  return result;
}
/** The only write target, as in record-mobile-device-evidence.mjs: existing, inside the evidence root, never trackable. */
async function outputTarget(outputDir, evidenceRoot) {
  if (!text(outputDir) || !text(evidenceRoot)) throw new LiveRefusal('output-invalid');
  let out, root;
  try {
    out = await realpath(resolve(outputDir));
    root = await realpath(resolve(evidenceRoot));
    if (!(await stat(out)).isDirectory()) throw new LiveRefusal('output-invalid');
  } catch { throw new LiveRefusal('output-invalid'); }
  if (!inside(root, out)) throw new LiveRefusal('output-invalid');
  const top = git(['rev-parse', '--show-toplevel'], out);
  if (top.status === 0) {
    let repository;
    try { repository = await realpath(top.stdout.trim()); } catch { throw new LiveRefusal('output-invalid'); }
    const probe = relative(repository, join(out, `${'0'.repeat(64)}.json`)).split(sep).join('/');
    if (git(['check-ignore', '-q', '--no-index', '--', probe], repository).status !== 0) throw new LiveRefusal('output-invalid');
  } else if (!/not a git repository/iu.test(top.stderr ?? '')) throw new LiveRefusal('output-invalid');
  return { out, root };
}

async function writeEvidence(document, out, root) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_JSON_BYTES) throw new LiveRefusal('document-too-large');
  const digest = sha256(bytes);
  const target = join(out, `${digest}.json`);
  let written = true;
  try { await writeFile(target, bytes, { flag: 'wx' }); } catch (error) {
    written = error?.code === 'EEXIST' && (await readFile(target).catch(() => null))?.equals(bytes) === true;
  }
  if (!written) throw new LiveRefusal('write-failed');
  return { path: relative(root, target).split(sep).join('/'), sha256: digest };
}

/* ---------------------------------------------------- manifest and fixtures */

const validCases = (cases) => Array.isArray(cases) && cases.length > 0 && cases.length <= requiredCaseIds.length
  && new Set(cases).size === cases.length && cases.every((id) => requiredCaseIds.includes(id));

/** Every fixture of the selected cases, in manifest order. */
function selectFixtures(manifest, caseIds) {
  if (!object(manifest) || manifest.version !== 1 || !Array.isArray(manifest.cases)) throw new LiveRefusal('fixtures-invalid');
  const wanted = new Set(caseIds);
  const selected = [];
  for (const record of manifest.cases) {
    if (!object(record) || !wanted.has(record.id)) continue;
    wanted.delete(record.id);
    if (!Array.isArray(record.fixtures) || !record.fixtures.length) throw new LiveRefusal('fixtures-invalid');
    for (const fixture of record.fixtures) {
      if (!object(fixture) || !text(fixture.id) || !text(fixture.path) || !sha(fixture.sha256)) throw new LiveRefusal('fixtures-invalid');
      selected.push({ caseId: record.id, fixtureId: fixture.id, sha256: fixture.sha256, path: fixture.path, extension: extname(fixture.path).slice(1).toLowerCase() });
    }
  }
  const keys = selected.map((fixture) => `${fixture.caseId}\0${fixture.fixtureId}`);
  if (wanted.size || !selected.length || selected.length > MAX_FIXTURES || new Set(keys).size !== keys.length) throw new LiveRefusal('fixtures-invalid');
  return selected;
}

/** Re-hashes every selected original under the fixture root before anything leaves this process. */
async function verifyOriginals(selected, fixtureRoot) {
  const verified = [];
  for (const fixture of selected) {
    const file = await containedFile(fixtureRoot, fixture.path);
    const digest = file ? await attempted(() => digestFile(file)) : null;
    if (!digest || digest.sha256 !== fixture.sha256 || digest.byteSize < 1) throw new LiveRefusal('fixtures-invalid');
    verified.push({ caseId: fixture.caseId, fixtureId: fixture.fixtureId, sha256: fixture.sha256, extension: fixture.extension, byteSize: digest.byteSize, file });
  }
  return verified;
}

/** The request-free default: what a live run would send and fetch, from local metadata only. */
export async function planLiveWorkflow({ manifestPath = DEFAULT_MANIFEST, fixtureRoot, caseIds } = {}) {
  const manifestFile = resolve(manifestPath);
  const root = resolve(fixtureRoot ?? dirname(manifestFile));
  const manifest = await readJsonFile(manifestFile, 'fixtures-invalid', MAX_MANIFEST_BYTES);
  const cases = caseIds ?? (Array.isArray(manifest?.cases) ? manifest.cases
    .filter((record) => object(record) && requiredCaseIds.includes(record.id) && Array.isArray(record.fixtures) && record.fixtures.length)
    .map((record) => record.id) : []);
  if (!validCases(cases)) throw new LiveRefusal('cases-invalid');
  const fixtures = [];
  for (const fixture of selectFixtures(manifest, cases)) {
    const file = await containedFile(root, fixture.path);
    const byteSize = file ? (await attempted(() => stat(file)))?.size ?? null : null;
    const declaredMimeType = mimeFor(fixture.extension);
    const expectedTransport = byteSize === null || !declaredMimeType ? null
      : DIRECT_MIME_TYPES.includes(declaredMimeType) && byteSize <= DIRECT_MAX_BYTES ? 'direct' : 'parts-v1';
    fixtures.push({ caseId: fixture.caseId, fixtureId: fixture.fixtureId, byteSize, declaredMimeType, expectedTransport,
      parts: expectedTransport === 'parts-v1' ? Math.ceil(byteSize / PART_BYTES) : expectedTransport === 'direct' ? 1 : null });
  }
  const uploadBytes = fixtures.reduce((sum, fixture) => sum + (fixture.expectedTransport ? fixture.byteSize : 0), 0);
  return {
    mode: 'dry-run', requests: 0, environment: 'preview', directMaxBytes: DIRECT_MAX_BYTES, partBytes: PART_BYTES, fixtures,
    totals: { fixtures: fixtures.length, planned: fixtures.filter((fixture) => fixture.expectedTransport).length, uploadBytes, downloadBytes: uploadBytes * 3 },
    downloadBasis: 'Each planned original is read back three times: manager original, frozen ZIP member and restored original. Previews and other archive members are extra.',
  };
}

/* ------------------------------------------------ authorization and credentials */

function validateAuthorization(authorization, context) {
  const now = context.now();
  const expires = Date.parse(authorization?.expiresAt);
  const identity = authorization?.identity;
  if (!object(authorization) || authorization.kind !== 'candidary.mobile-image-live-authorization' || authorization.version !== 1
    || authorization.environment !== 'preview' || !isPreviewOrigin(authorization.target) || !text(authorization.owner)
    || typeof authorization.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(authorization.expiresAt)
    || !Number.isFinite(expires) || expires <= now || expires - now > 72 * 3600_000
    || typeof authorization.eventId !== 'string' || !eventIdPattern.test(authorization.eventId) || authorization.dedicatedLiveEvent !== true
    || !object(identity) || !sha(identity.buildFingerprint) || !externalImageRef(identity.imageRef)
    || typeof identity.workerVersionId !== 'string' || !uuidPattern.test(identity.workerVersionId)
    || !validCases(authorization.caseIds)) throw new LiveRefusal('authorization-invalid');
  if (!privateFile(authorization.credentialsPath, context)) throw new LiveRefusal('private-path');
  return {
    target: authorization.target, eventId: authorization.eventId, credentialsPath: authorization.credentialsPath, caseIds: [...authorization.caseIds],
    identity: { buildFingerprint: identity.buildFingerprint, imageRef: identity.imageRef, workerVersionId: identity.workerVersionId },
  };
}

function validateCredentials(data, eventId) {
  if (!object(data) || data.kind !== 'candidary.image-live-credentials' || data.eventId !== eventId
    || typeof data.entryCredential !== 'string' || !credentialPattern.test(data.entryCredential)
    || typeof data.managementToken !== 'string' || !credentialPattern.test(data.managementToken)) throw new LiveRefusal('credentials-invalid');
  return { eventId, entryCredential: data.entryCredential, managementToken: data.managementToken };
}

/* ------------------------------------------------------------ ZIP and CSV */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(crc, bytes) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes, at) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
const SIGNATURE = Object.freeze({ local: 0x04034b50, central: 0x02014b50, descriptor: 0x08074b50, end: 0x06054b50 });
const names = new TextDecoder('utf-8', { fatal: true });
function zip64Extra(extra) {
  for (let at = 0; at + 4 <= extra.length; at += 4 + u16(extra, at + 2)) if (u16(extra, at) === 0x0001) return true;
  return false;
}

/** Sequential reader over a byte stream that never holds more than one chunk, plus one bounded scan buffer. */
class ByteReader {
  #iterator; #chunk = new Uint8Array(0); #position = 0; #finished = false;
  offset = 0;
  constructor(stream) { this.#iterator = stream[Symbol.asyncIterator](); }
  async #ready() {
    while (this.#position >= this.#chunk.length) {
      if (this.#finished) return false;
      const next = await this.#iterator.next();
      if (next.done) { this.#finished = true; return false; }
      if (!ArrayBuffer.isView(next.value)) fail();
      this.#chunk = new Uint8Array(next.value.buffer, next.value.byteOffset, next.value.byteLength);
      this.#position = 0;
    }
    return true;
  }
  async bytes(length) {
    const out = new Uint8Array(length); let filled = 0;
    while (filled < length) {
      if (!(await this.#ready())) fail();
      const take = Math.min(length - filled, this.#chunk.length - this.#position);
      out.set(this.#chunk.subarray(this.#position, this.#position + take), filled);
      this.#position += take; filled += take;
    }
    this.offset += length;
    return out;
  }
  async each(length, visit) {
    let left = length;
    while (left > 0) {
      if (!(await this.#ready())) fail();
      const take = Math.min(left, this.#chunk.length - this.#position);
      visit(this.#chunk.subarray(this.#position, this.#position + take));
      this.#position += take; left -= take;
    }
    this.offset += length;
  }
  /** One stored entry of unknown length, ended by the signed data descriptor whose sizes and CRC-32 match it. */
  async descriptor(limit) {
    let buffer = new Uint8Array(64 * 1024); let length = 0; let from = 0; let crc = 0; let crcAt = 0;
    for (;;) {
      if (!(await this.#ready())) fail();
      const piece = this.#chunk.subarray(this.#position);
      this.#position = this.#chunk.length;
      if (length + piece.length > buffer.length) {
        const grown = new Uint8Array(Math.max(buffer.length * 2, length + piece.length));
        grown.set(buffer.subarray(0, length)); buffer = grown;
      }
      buffer.set(piece, length); length += piece.length;
      for (let at = from; at + 16 <= length; at++) {
        if (u32(buffer, at) !== SIGNATURE.descriptor || u32(buffer, at + 8) !== at || u32(buffer, at + 12) !== at) continue;
        crc = crc32(crc, buffer.subarray(crcAt, at)); crcAt = at;
        if (u32(buffer, at + 4) !== crc) continue;
        this.#chunk = buffer.slice(at + 16, length); this.#position = 0;
        this.offset += at + 16;
        return { size: at, crc };
      }
      from = Math.max(from, length - 15);
      if (length > limit + 16) fail();
    }
  }
  async atEnd() { return !(await this.#ready()); }
  async close() { try { await this.#iterator.return?.(); } catch { /* the stream is already closed */ } }
}

/**
 * Streams one store-mode export part (worker/export/zip-stream.ts: fflate's streaming
 * Zip with ZipPassThrough members) and returns the SHA-256 of each target member.
 * Members carry signed 32-bit data descriptors, so each photo's length comes from
 * `sizes` (the run manifest's byte_size) and is proven by its descriptor; the
 * trailing media.csv is found by content within `maxScanBytes`. Every local entry
 * must reappear exactly in the central directory and end record. Encryption,
 * compression, duplicate names, ZIP64 records (the writer never emits them: parts
 * stay under 2 GiB and 65,535 entries) and trailing bytes fail closed.
 */
export async function readStoredZip(stream, { sizes = new Map(), targets = new Set(), maxScanBytes = MAX_SCAN_BYTES } = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') fail();
  const reader = new ByteReader(stream);
  try {
    const found = new Map(); const locals = []; const byOffset = new Map(); const seen = new Set();
    let signature = u32(await reader.bytes(4), 0);
    while (signature === SIGNATURE.local) {
      const offset = reader.offset - 4;
      const header = await reader.bytes(26);
      const flags = u16(header, 2), method = u16(header, 4);
      const name = names.decode(await reader.bytes(u16(header, 22)));
      const extra = await reader.bytes(u16(header, 24));
      if ((flags & 1) || method !== 0 || !name || seen.has(name) || zip64Extra(extra)) fail();
      seen.add(name);
      const target = targets.has(name);
      const hash = createHash('sha256'); let computed = 0;
      const take = target ? (piece) => { hash.update(piece); computed = crc32(computed, piece); } : () => {};
      let size, crc;
      if (flags & 8) {
        if (sizes.has(name)) {
          size = sizes.get(name);
          if (!Number.isSafeInteger(size) || size < 0) fail();
          await reader.each(size, take);
          const descriptor = await reader.bytes(16);
          crc = u32(descriptor, 4);
          if (u32(descriptor, 0) !== SIGNATURE.descriptor || u32(descriptor, 8) !== size || u32(descriptor, 12) !== size) fail();
        } else {
          if (target) fail();
          ({ size, crc } = await reader.descriptor(maxScanBytes));
        }
      } else {
        size = u32(header, 14); crc = u32(header, 10);
        if (size !== u32(header, 18) || (sizes.has(name) && sizes.get(name) !== size)) fail();
        await reader.each(size, take);
      }
      if (target && computed !== crc) fail();
      const entry = { name, size, crc, listed: false };
      locals.push(entry); byOffset.set(offset, entry);
      if (target) found.set(name, { sha256: hash.digest('hex'), byteSize: size });
      signature = u32(await reader.bytes(4), 0);
    }
    const directoryOffset = reader.offset - 4;
    let count = 0;
    while (signature === SIGNATURE.central) {
      const header = await reader.bytes(42);
      const flags = u16(header, 4), method = u16(header, 6), crc = u32(header, 12), compressed = u32(header, 16), size = u32(header, 20);
      const name = names.decode(await reader.bytes(u16(header, 24)));
      const extra = await reader.bytes(u16(header, 26));
      await reader.bytes(u16(header, 28));
      const entry = byOffset.get(u32(header, 38));
      if ((flags & 1) || method !== 0 || u16(header, 30) !== 0 || zip64Extra(extra) || !entry || entry.listed || entry.name !== name
        || entry.crc !== crc || entry.size !== compressed || entry.size !== size) fail();
      entry.listed = true; count += 1;
      signature = u32(await reader.bytes(4), 0);
    }
    const directorySize = reader.offset - 4 - directoryOffset;
    if (signature !== SIGNATURE.end || !locals.length || count !== locals.length) fail();
    const end = await reader.bytes(18);
    if (u16(end, 0) !== 0 || u16(end, 2) !== 0 || u16(end, 4) !== count || u16(end, 6) !== count
      || u32(end, 8) !== directorySize || u32(end, 12) !== directoryOffset) fail();
    await reader.bytes(u16(end, 16));
    if (!(await reader.atEnd())) fail();
    return found;
  } catch { return fail(); } finally { await reader.close(); }
}

/** RFC 4180 as shared/csv.ts csvCell writes it; null when malformed. */
function parseCsv(source) {
  const rows = []; let row = []; let field = ''; let quoted = false; let closed = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (source[index + 1] === '"') { field += '"'; index++; }
      else { quoted = false; closed = true; }
      continue;
    }
    if (character === '"') { if (field !== '' || closed) return null; quoted = true; continue; }
    if (character === ',') { row.push(field); field = ''; closed = false; continue; }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false; continue;
    }
    if (closed) return null;
    field += character;
  }
  if (quoted) return null;
  if (field !== '' || closed || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// worker/export/csv.ts buildExportManifest: `candidary-export-manifest.csv` maps every archive member to its media row.
const MANIFEST_COLUMNS = Object.freeze(['part_number', 'archive_name', 'archive_index', 'archive_path', 'media_id', 'original_filename',
  'guest_name', 'caption', 'mime_type', 'byte_size', 'width', 'height', 'uploaded_at', 'publication_status']);
/** The run manifest as { partNumber, archivePath, mediaId, byteSize } rows; null when it is not that exact file. */
export function parseExportManifest(source) {
  if (typeof source !== 'string') return null;
  const rows = parseCsv(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  if (!rows) return null;
  const [header, ...data] = rows.filter((row) => !(row.length === 1 && row[0] === ''));
  if (!header || header.length !== MANIFEST_COLUMNS.length || header.some((column, index) => column !== MANIFEST_COLUMNS[index])) return null;
  const entries = [];
  for (const row of data) {
    if (row.length !== MANIFEST_COLUMNS.length || !/^[1-9][0-9]{0,8}$/u.test(row[0]) || !/^[0-9]{1,15}$/u.test(row[9]) || !row[3] || !row[4]) return null;
    entries.push({ partNumber: Number(row[0]), archivePath: row[3], mediaId: row[4], byteSize: Number(row[9]) });
  }
  return entries;
}

/* ------------------------------------------------------------ HTTP client */

class CookieJar {
  #cookies = new Map();
  absorb(headers) {
    const lines = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';');
      const split = pair.indexOf('=');
      if (split < 1) continue;
      const name = pair.slice(0, split).trim(), value = pair.slice(split + 1).trim();
      if (!value || attributes.some((item) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/iu.test(item))) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
  header() { return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  get(name) { return this.#cookies.get(name); }
  clear() { this.#cookies.clear(); }
}
function decoded(value) { try { return decodeURIComponent(value); } catch { return fail(); } }

/**
 * The public-API client for one authorized preview origin: a manager (management
 * link), an owning guest and a second guest (two printed-entry exchanges), and a
 * signed-out reader, each with its own cookie jar, exactly as mobile-image-load-adapter.mjs
 * speaks to Candidary. Every request is pinned to `origin` and never follows a
 * redirect; writes carry Origin plus every scope's CSRF token. Product outcomes come
 * back as small observations; only transport or protocol breakage throws, message-free.
 */
export function createLiveClient({ origin, credentials, fetch: fetchImpl = globalThis.fetch, sleep = delay, now = () => performance.now(), timeouts = {} } = {}) {
  if (!isPreviewOrigin(origin) || typeof fetchImpl !== 'function' || typeof sleep !== 'function' || typeof now !== 'function' || !object(credentials)
    || typeof credentials.eventId !== 'string' || !eventIdPattern.test(credentials.eventId)
    || typeof credentials.entryCredential !== 'string' || !credentialPattern.test(credentials.entryCredential)
    || typeof credentials.managementToken !== 'string' || !credentialPattern.test(credentials.managementToken)) fail();
  const limits = { requestMs: 120_000, downloadMs: 1_800_000, deliveryMs: 900_000, exportMs: 1_800_000, pollMs: 2_000, ...(object(timeouts) ? timeouts : {}) };
  const { eventId, entryCredential, managementToken } = credentials;
  const jars = { manager: new CookieJar(), owner: new CookieJar(), other: new CookieJar() };
  const managed = `/api/manage/events/${encodeURIComponent(eventId)}`;
  let slug = null;
  const uploads = () => (slug === null ? fail() : `/api/event/${encodeURIComponent(slug)}/uploads`);
  const media = (mediaId, kind) => `/api/media/${encodeURIComponent(mediaId)}/${kind}`;

  async function call(jar, method, path, { json, body, headers = {}, timeoutMs = limits.requestMs } = {}) {
    let url;
    try { url = new URL(path, origin); } catch { fail(); }
    if (url.origin !== origin) fail();
    const outgoing = new Headers(headers);
    const cookie = jar?.header();
    if (cookie) outgoing.set('cookie', cookie);
    // The browser sends Origin on same-origin writes, never on GET; api.ts offers every scope's CSRF token.
    if (method !== 'GET' && method !== 'HEAD') {
      outgoing.set('origin', origin);
      for (const [name, header] of Object.entries(CSRF_HEADERS)) {
        const value = jar?.get(name);
        if (value) outgoing.set(header, decoded(value));
      }
    }
    let payload = body;
    if (json !== undefined) { payload = JSON.stringify(json); outgoing.set('content-type', 'application/json'); }
    let response;
    try {
      response = await fetchImpl(url.href, { method, headers: outgoing, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch { fail(); }
    if (!response || typeof response.status !== 'number' || !response.headers) fail();
    jar?.absorb(response.headers);
    return response;
  }
  async function discard(response) { try { await response.body?.cancel(); } catch { /* already consumed */ } }
  /** A bounded body; null when it is larger than `limit` (the stream is cancelled). */
  async function readBody(response, limit) {
    if (!response.body) return Buffer.alloc(0);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > limit) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  async function readJson(response) {
    const bytes = await attempted(() => readBody(response, MAX_API_JSON_BYTES));
    if (!bytes) return undefined;
    try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
  }
  async function envelope(response, statuses) {
    if (!statuses.includes(response.status)) { await discard(response); fail(); }
    const value = await readJson(response);
    if (!object(value) || !('data' in value)) fail();
    return value.data;
  }
  /** A product answer. It never throws for an HTTP status; an error `code` is kept only for allowlist comparison. */
  async function answer(response, statuses) {
    const value = await readJson(response);
    const ok = statuses.includes(response.status) && object(value) && 'data' in value;
    return { status: response.status, data: ok ? value.data : null, code: !ok && object(value) && typeof value.code === 'string' ? value.code : null };
  }
  /** What a private read returned. A denial must be a closed envelope: no digest, object key, decoder header or oversized body. */
  async function access(response) {
    const headers = response.headers;
    const observed = {
      status: response.status, contentType: headers.get('content-type') ?? '', cacheControl: headers.get('cache-control') ?? '',
      nosniff: (headers.get('x-content-type-options') ?? '').trim().toLowerCase() === 'nosniff', setCookie: headers.has('set-cookie'),
      decoderHeader: [...headers.keys()].some((name) => name.toLowerCase().startsWith('x-decoder')), bytes: 0, lengthMatches: true, leak: false,
    };
    if (response.status >= 200 && response.status < 300) {
      const body = await attempted(() => readBody(response, MAX_PREVIEW_BYTES));
      const declared = headers.get('content-length');
      observed.bytes = body ? body.byteLength : 0;
      observed.lengthMatches = Boolean(body) && (declared === null || Number(declared) === body.byteLength);
    } else {
      const body = await attempted(() => readBody(response, MAX_DENIAL_BYTES));
      const content = body ? body.toString('latin1') : null;
      observed.leak = content === null || /[a-f0-9]{64}/iu.test(content) || /media\//u.test(content);
    }
    return observed;
  }
  const receiptOf = (value) => (object(value) ? { mediaId: typeof value.id === 'string' ? value.id : null, uploadState: typeof value.uploadState === 'string' ? value.uploadState : null } : null);
  function intakeOf(event) {
    if (!object(event) || event.id !== eventId || typeof event.photosOpen !== 'boolean' || !INTAKE_STATES.includes(event.photoIntakeState)) fail();
    return { photosOpen: event.photosOpen, state: event.photoIntakeState };
  }
  async function readEvent() {
    const event = (await envelope(await call(jars.manager, 'GET', managed), [200]))?.event;
    if (!object(event) || event.id !== eventId || typeof event.slug !== 'string' || !event.slug || event.slug.length > 200) fail();
    return event;
  }
  async function sendPart(path, index, bytes) {
    const digest = sha256(bytes);
    for (let attempt = 0; ; attempt++) {
      const response = await attempted(() => call(jars.owner, 'PUT', `${path}/parts/${index}`, { body: bytes, headers: {
        'content-type': 'application/octet-stream', 'x-part-sha256': digest, 'content-length': String(bytes.byteLength) } }));
      if (response?.status === 200) {
        const ack = await answer(response, [200]);
        return ack.data?.index === index && ack.data.accepted === true;
      }
      if (response) await discard(response);
      if (response && !retryable(response.status)) return false;
      // A lost acknowledgement may still have accepted this exact part.
      const status = await attempted(async () => answer(await call(jars.owner, 'GET', path), [200]));
      if (Array.isArray(status?.data?.transfer?.acceptedParts) && status.data.transfer.acceptedParts.includes(index)) return true;
      if (attempt === 2) return false;
      await sleep(350 * 2 ** attempt);
    }
  }
  async function sendParts(path, source, partCount) {
    const handle = await open(source.file, 'r');
    try {
      for (let index = 0; index < partCount; index++) {
        const size = Math.min(PART_BYTES, source.byteSize - index * PART_BYTES);
        const bytes = Buffer.alloc(size);
        for (let filled = 0; filled < size;) {
          const { bytesRead } = await handle.read(bytes, filled, size - filled, index * PART_BYTES + filled);
          if (!bytesRead) fail();
          filled += bytesRead;
        }
        if (!(await sendPart(path, index, bytes))) return false;
      }
      return true;
    } finally { await handle.close(); }
  }
  /** parts-v1: every 8 MiB part with its SHA-256, a processing acknowledgement, then status polls until a terminal answer. */
  async function resumable(trace, source, transfer) {
    const mediaId = trace.mediaId;
    const partCount = Math.ceil(source.byteSize / PART_BYTES);
    if (typeof transfer.id !== 'string' || !transfer.id || transfer.mediaId !== mediaId || transfer.partBytes !== PART_BYTES
      || transfer.partCount !== partCount || transfer.state !== 'receiving' || !Array.isArray(transfer.acceptedParts) || transfer.acceptedParts.length) return trace;
    Object.assign(trace, { reservation: 'accepted', transport: 'parts-v1' });
    const path = `${uploads()}/${encodeURIComponent(mediaId)}/transfers/${encodeURIComponent(transfer.id)}`;
    trace.partsAccepted = await sendParts(path, source, partCount);
    if (!trace.partsAccepted) return trace;
    const completed = await answer(await call(jars.owner, 'POST', `${path}/complete`, { json: {} }), [200, 202]);
    trace.complete = { status: completed.status };
    if (completed.status !== 200 && completed.status !== 202) return trace;
    const observe = (data) => ({
      state: typeof data?.transfer?.state === 'string' ? data.transfer.state : null,
      transferMatches: object(data?.transfer) ? data.transfer.id === transfer.id && data.transfer.mediaId === mediaId : null,
      receipt: receiptOf(data?.media),
    });
    let latest = observe(completed.data);
    trace.observations.push(latest);
    const started = now();
    while (latest.transferMatches === true && !latest.receipt && (latest.state === 'processing' || latest.state === 'retryable')) {
      if (now() - started > limits.deliveryMs) { trace.timedOut = true; break; }
      await sleep(limits.pollMs);
      const polled = await attempted(async () => answer(await call(jars.owner, 'GET', path), [200]));
      if (!polled || (polled.status !== 200 && retryable(polled.status))) continue;
      latest = polled.status === 200 ? observe(polled.data) : { state: null, transferMatches: true, receipt: null };
      trace.observations.push(latest);
    }
    return trace;
  }
  /** Direct (legacy) path: the bytes to the server's content URL, then the idempotent confirmation, as the browser queue does. */
  async function direct(trace, source, item) {
    let target;
    try { target = new URL(item.uploadUrl, origin); } catch { fail(); }
    if (target.origin !== origin) fail();
    Object.assign(trace, { reservation: 'accepted', transport: 'direct' });
    const bytes = await readFile(source.file);
    if (bytes.byteLength !== source.byteSize) fail();
    const contentType = typeof item.media.mimeType === 'string' && item.media.mimeType ? item.media.mimeType : source.mimeType;
    let put = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      put = await attempted(async () => answer(await call(jars.owner, 'PUT', target.href, { body: bytes, headers: {
        'content-type': contentType, 'content-length': String(bytes.byteLength) } }), [200]));
      if (put && (put.status === 200 || !retryable(put.status))) break;
      if (attempt < 2) await sleep(350 * 2 ** attempt);
    }
    trace.content = { status: put?.status ?? 0, receipt: receiptOf(put?.data?.media) };
    if (put?.status !== 200) return trace;
    const confirmed = await attempted(async () => answer(await call(jars.owner, 'POST', `${uploads()}/${encodeURIComponent(trace.mediaId)}/finalize`, { json: {} }), [200]));
    trace.finalize = { status: confirmed?.status ?? 0, receipt: receiptOf(confirmed?.data?.media) };
    return trace;
  }

  return {
    async connect() {
      const link = await call(jars.manager, 'GET', `/manage/${encodeURIComponent(managementToken)}`);
      await discard(link);
      if (link.status !== 302 || !jars.manager.get('candidary_session')) fail();
      const event = await readEvent();
      slug = event.slug;
      for (const jar of [jars.owner, jars.other]) {
        await envelope(await call(jar, 'POST', '/api/entry/exchange', { json: { token: entryCredential } }), [200]);
        if (!jar.get('candidary_session') || !jar.get('candidary_csrf')) fail();
      }
      if (jars.owner.get('candidary_session') === jars.other.get('candidary_session')) fail();
      return { intake: intakeOf(event) };
    },

    async photoIntake(action) {
      if (!Object.values(OPEN_ACTIONS).includes(action) && !Object.values(CLOSE_ACTIONS).includes(action)) fail();
      const result = await answer(await call(jars.manager, 'POST', `${managed}/photo-intake`, { json: { action } }), [200]);
      if (result.status === 200 && object(result.data?.event)) return { changed: true, intake: intakeOf(result.data.event) };
      // A stale or illegal transition: report the event as it now stands.
      return { changed: false, intake: intakeOf(await readEvent()) };
    },

    async capabilities() {
      const data = await envelope(await call(jars.owner, 'GET', `${uploads()}/capabilities`), [200]);
      const list = (value) => Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === 'string' && item.length <= 100);
      const size = (value) => Number.isSafeInteger(value) && value > 0;
      if (!object(data) || !list(data.mimeTypes) || !list(data.extensions) || !size(data.directMaxBytes) || !size(data.maxOriginalBytes) || !size(data.partBytes)) fail();
      return { mimeTypes: [...data.mimeTypes], extensions: data.extensions.map((extension) => extension.replace(/^\./u, '').toLowerCase()),
        directMaxBytes: data.directMaxBytes, maxOriginalBytes: data.maxOriginalBytes, partBytes: data.partBytes };
    },

    /** One browser-equivalent upload as the owning guest. The returned trace is classified by runLiveWorkflow. */
    async upload(source, { key, index, onReserved } = {}) {
      const trace = { reservation: 'invalid', rejectionCode: null, transport: null, mediaId: null, alreadyDelivered: false,
        partsAccepted: null, complete: null, observations: [], content: null, finalize: null, timedOut: false };
      const file = { filename: `live-workflow-${index}.${source.extension}`, mimeType: source.mimeType, byteSize: source.byteSize,
        idempotencyKey: key, caption: null, transport: 'parts-v1' };
      const reserved = await answer(await call(jars.owner, 'POST', `${uploads()}/batch`, { json: { guestName: GUEST_NAME, files: [file] } }), [201]);
      if (reserved.status !== 201) return Object.assign(trace, { reservation: 'rejected', rejectionCode: reserved.code });
      const items = reserved.data?.items;
      const item = Array.isArray(items) && items.length === 1 ? items[0] : null;
      if (!object(item) || item.idempotencyKey !== key) return trace;
      if (item.status === 'rejected') return Object.assign(trace, { reservation: 'rejected', rejectionCode: typeof item.error?.code === 'string' ? item.error.code : null });
      if (item.status !== 'accepted' || !object(item.media) || typeof item.media.id !== 'string' || !item.media.id) return trace;
      trace.mediaId = item.media.id;
      onReserved?.(trace.mediaId);
      // A fresh idempotency key can never already be delivered: that is a receipt before any byte was sent.
      if (item.alreadyDelivered !== false) return Object.assign(trace, { reservation: 'accepted', alreadyDelivered: true });
      if (item.transport === 'parts-v1' && object(item.transfer)) return resumable(trace, source, item.transfer);
      // The direct path is bounded by the 20 MiB ceiling; a larger original offered it is not an actionable answer.
      if (item.transport === undefined && typeof item.uploadUrl === 'string' && source.byteSize <= DIRECT_MAX_BYTES) return direct(trace, source, item);
      return trace;
    },

    async preview(principal, mediaId, { retries = 0 } = {}) {
      const principals = { owner: jars.owner, manager: jars.manager, 'other-guest': jars.other, 'signed-out': null };
      if (!Object.hasOwn(principals, principal)) fail();
      const jar = principals[principal];
      for (let attempt = 0; ; attempt++) {
        const response = await call(jar, 'GET', media(mediaId, 'preview'));
        if (attempt < retries && TRANSIENT_READS.has(response.status)) { await discard(response); await sleep(1_000 * 2 ** attempt); continue; }
        return access(response);
      }
    },

    /** The manager original, streamed and hashed; a denial is summarized like any other private read. */
    async original(mediaId, expectedBytes, { retries = 0 } = {}) {
      for (let attempt = 0; ; attempt++) {
        const response = await call(jars.manager, 'GET', media(mediaId, 'original'), { timeoutMs: limits.downloadMs });
        if (attempt < retries && TRANSIENT_READS.has(response.status)) { await discard(response); await sleep(1_000 * 2 ** attempt); continue; }
        const decoderHeader = [...response.headers.keys()].some((name) => name.toLowerCase().startsWith('x-decoder'));
        if (response.status !== 200 || !response.body) {
          const observed = await access(response);
          return { status: response.status, sha256: null, byteSize: 0, leak: observed.leak, decoderHeader };
        }
        const hash = createHash('sha256'); let byteSize = 0;
        try {
          for await (const chunk of response.body) {
            byteSize += chunk.byteLength;
            if (byteSize > expectedBytes) break;
            hash.update(chunk);
          }
        } catch { return { status: 0, sha256: null, byteSize: 0, leak: false, decoderHeader }; }
        return { status: 200, sha256: byteSize > expectedBytes ? null : hash.digest('hex'), byteSize, leak: false, decoderHeader };
      }
    },

    /**
     * One complete export of the (already closed) event: create, poll until Ready,
     * read the download descriptor and the run manifest, then stream only the parts
     * holding a target and hash each target's member.
     */
    async exportMembers(targets) {
      const members = new Map();
      const everyTarget = (failure) => {
        for (const { mediaId } of targets) if (!members.has(mediaId)) members.set(mediaId, { failure });
        return { failure, members };
      };
      const created = await answer(await call(jars.manager, 'POST', `${managed}/exports`, { json: {} }), [202]);
      const job = created.data?.export;
      if (created.status !== 202 || !object(job) || typeof job.id !== 'string' || !job.id) return everyTarget('export-unavailable');
      const jobPath = `${managed}/exports/${encodeURIComponent(job.id)}`;
      let state = job.state; const started = now();
      while (state !== 'ready') {
        if (state === 'failed' || state === 'expired') return everyTarget('export-failed');
        if (now() - started > limits.exportMs) return everyTarget('export-timeout');
        await sleep(limits.pollMs);
        const polled = await attempted(async () => answer(await call(jars.manager, 'GET', jobPath), [200]));
        if (!polled || (polled.status !== 200 && retryable(polled.status))) continue;
        if (polled.status !== 200 || !object(polled.data?.export) || polled.data.export.id !== job.id) return everyTarget('export-failed');
        state = polled.data.export.state;
      }
      const descriptor = await answer(await call(jars.manager, 'POST', `${jobPath}/download`, { json: {} }), [200]);
      const numbers = Array.isArray(descriptor.data?.parts) ? descriptor.data.parts.map((part) => part?.partNumber) : [];
      if (descriptor.status !== 200 || !object(descriptor.data?.manifest) || !numbers.length
        || numbers.some((number) => !Number.isSafeInteger(number) || number < 1) || new Set(numbers).size !== numbers.length) return everyTarget('export-descriptor-invalid');
      const manifest = await call(jars.manager, 'GET', `${jobPath}/artifact/manifest`, { timeoutMs: limits.downloadMs });
      const csv = manifest.status === 200 ? await attempted(() => readBody(manifest, MAX_CSV_BYTES)) : (await discard(manifest), null);
      const rows = csv ? parseExportManifest(csv.toString('utf8')) : null;
      if (!rows) return everyTarget('manifest-invalid');
      const parts = new Map();
      for (const row of rows) {
        if (!numbers.includes(row.partNumber)) return everyTarget('manifest-invalid');
        const part = parts.get(row.partNumber) ?? { sizes: new Map(), targets: new Map() };
        if (part.sizes.has(row.archivePath)) return everyTarget('manifest-invalid');
        part.sizes.set(row.archivePath, row.byteSize); parts.set(row.partNumber, part);
      }
      for (const { mediaId } of targets) {
        const matches = rows.filter((row) => row.mediaId === mediaId);
        if (matches.length !== 1) members.set(mediaId, { failure: 'zip-member-missing' });
        else parts.get(matches[0].partNumber).targets.set(matches[0].archivePath, mediaId);
      }
      for (const [partNumber, part] of parts) {
        if (!part.targets.size) continue;
        const response = await call(jars.manager, 'GET', `${jobPath}/artifact/part/${partNumber}`, { timeoutMs: limits.downloadMs });
        let found = null;
        if (response.status === 200 && response.body) found = await attempted(() => readStoredZip(response.body, { sizes: part.sizes, targets: new Set(part.targets.keys()) }));
        else await discard(response);
        for (const [path, mediaId] of part.targets) {
          const member = found?.get(path);
          members.set(mediaId, member ? { sha256: member.sha256, byteSize: member.byteSize }
            : { failure: found ? 'zip-member-missing' : response.status === 200 ? 'zip-invalid' : 'zip-part-unavailable' });
        }
      }
      return { failure: null, members };
    },

    async trash(mediaId) {
      const result = await answer(await call(jars.manager, 'POST', `${managed}/media/${encodeURIComponent(mediaId)}/trash`), [200]);
      return { status: result.status, ok: result.status === 200 && result.data?.media?.id === mediaId };
    },
    async restore(mediaId) {
      const result = await answer(await call(jars.manager, 'POST', `${managed}/media/${encodeURIComponent(mediaId)}/restore`), [200]);
      return { status: result.status, ok: result.status === 200 && result.data?.media?.id === mediaId };
    },
    async trashListing() {
      const ids = []; let cursor = null;
      for (let page = 0; page < MAX_TRASH_PAGES; page++) {
        const query = new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) });
        const result = await answer(await call(jars.manager, 'GET', `${managed}/media/trash?${query}`), [200]);
        if (result.status !== 200 || !Array.isArray(result.data?.media)) return { ok: false, ids };
        for (const item of result.data.media) if (typeof item?.id === 'string') ids.push(item.id);
        cursor = typeof result.data.nextCursor === 'string' && result.data.nextCursor ? result.data.nextCursor : null;
        if (!cursor) return { ok: true, ids };
      }
      return { ok: false, ids };
    },
    /** The owning guest's permanent deletion. */
    async deleteOwn(mediaId) {
      const result = await answer(await call(jars.owner, 'DELETE', `${uploads()}/${encodeURIComponent(mediaId)}`), [200]);
      return { status: result.status, code: result.code, deleted: result.status === 200 && result.data?.media?.id === mediaId && result.data.media.deleted === true };
    },
    close() { for (const jar of Object.values(jars)) jar.clear(); slug = null; },
  };
}

/* ------------------------------------------------ orchestration and evidence */

const STAGE_FAILURES = Object.freeze({ session: 'session', 'intake-open': 'intake-open', capabilities: 'capabilities', upload: 'upload',
  preview: 'preview', 'intake-close': 'intake-close', original: 'original', export: 'export', trash: 'trash-restore', deletion: 'deletion' });
const ZIP_FAILURES = new Set(['zip-invalid', 'zip-member-missing']);
const denied = (observed) => object(observed) && (observed.status === 401 || observed.status === 403) && observed.leak === false && observed.decoderHeader === false;
const visibleImage = (observed) => object(observed) && observed.status === 200 && /^image\//iu.test(observed.contentType ?? '')
  && observed.bytes > 0 && observed.lengthMatches === true;
const privateImage = (observed) => visibleImage(observed) && observed.cacheControl === 'private, no-store' && observed.nosniff === true
  && observed.setCookie === false && observed.decoderHeader === false;
function denialFailure(observed, visibleReason) {
  if (denied(observed)) return null;
  if (object(observed) && observed.status >= 200 && observed.status < 300) return visibleReason;
  return object(observed) && (observed.leak || observed.decoderHeader) ? 'preview-denial-leak' : 'preview-not-denied';
}
/** Advertised by the capabilities: the declared MIME type, and its extension unless it is a declaration alias. */
function admitted(fixture, mimeType, capabilities) {
  return Boolean(mimeType) && object(capabilities) && Array.isArray(capabilities.mimeTypes) && capabilities.mimeTypes.includes(mimeType)
    && (DECLARATION_ALIASES.includes(fixture.extension) || (Array.isArray(capabilities.extensions) && capabilities.extensions.includes(fixture.extension)))
    && Number.isSafeInteger(capabilities.maxOriginalBytes) && fixture.byteSize <= capabilities.maxOriginalBytes;
}

/**
 * Delivered only through a stored receipt for this exact photo that arrived no earlier than delivery.
 * Only advertised types are ever reserved (see `admitted`), so an unsupported-type refusal contradicts the
 * capabilities and fails, while a size refusal stays not-admitted: per-case limits are not visible in the
 * global maxOriginalBytes.
 */
function classifyUpload(trace) {
  if (!object(trace)) return 'reservation-rejected';
  if (trace.reservation === 'rejected') {
    if (trace.rejectionCode === 'FILE_TOO_LARGE') return 'not-admitted';
    return trace.rejectionCode === 'FILE_TYPE_UNSUPPORTED' ? 'type-refused-despite-capabilities' : 'reservation-rejected';
  }
  if (trace.reservation !== 'accepted' || typeof trace.mediaId !== 'string') return 'reservation-rejected';
  if (trace.alreadyDelivered) return 'premature-receipt';
  const stored = (receipt) => object(receipt) && receipt.mediaId === trace.mediaId && receipt.uploadState === 'stored';
  if (trace.transport === 'parts-v1') {
    if (trace.partsAccepted !== true || (trace.complete?.status !== 200 && trace.complete?.status !== 202)) return 'transfer-failed';
    for (const observation of Array.isArray(trace.observations) ? trace.observations : []) {
      if (!object(observation) || observation.transferMatches === false) return 'receipt-mismatch';
      if (observation.transferMatches !== true) return 'transfer-failed';
      if (observation.receipt && observation.state !== 'delivered') return 'premature-receipt';
      if (observation.state === 'delivered') return stored(observation.receipt) ? 'delivered' : 'receipt-mismatch';
      if (observation.state === 'rejected') return 'transfer-rejected';
      if (observation.state !== 'processing' && observation.state !== 'retryable') return 'transfer-failed';
    }
    return trace.timedOut ? 'delivery-timeout' : 'transfer-failed';
  }
  if (trace.transport === 'direct') {
    for (const step of [trace.content, trace.finalize]) {
      if (step?.status !== 200) return 'transfer-failed';
      if (!stored(step.receipt)) return 'receipt-mismatch';
    }
    return 'delivered';
  }
  return 'transfer-failed';
}

/**
 * Runs the whole lane against `client` (createLiveClient, or a fake with the same
 * methods) and assembles the allowlisted `live-workflow` document. A fixture passes
 * only when every observation held and the harness itself did not fail; a thrown
 * client error becomes a fixed `runtimeFailure` stage code, and anything this run
 * created or opened is removed or closed again, with `cleanupFailure` when it cannot be.
 */
export async function runLiveWorkflow({ client, fixtures, identity, now = () => Date.now() } = {}) {
  if (!object(client) || !Array.isArray(fixtures) || !fixtures.length || fixtures.length > MAX_FIXTURES || !object(identity)
    || !isPreviewOrigin(identity.origin) || !sha(identity.buildFingerprint) || !externalImageRef(identity.imageRef)
    || typeof identity.workerVersionId !== 'string' || !uuidPattern.test(identity.workerVersionId)
    || fixtures.some((fixture) => !object(fixture) || !text(fixture.caseId) || !text(fixture.fixtureId) || !sha(fixture.sha256)
      || !Number.isSafeInteger(fixture.byteSize) || fixture.byteSize < 1 || typeof fixture.extension !== 'string')) fail();
  const startedAt = new Date(now()).toISOString();
  const runId = randomUUID();
  const states = fixtures.map((fixture) => ({ fixture, missing: false, reason: null, transport: null, mediaId: null, removed: false,
    delivered: false, privatePreview: false, deleted: false, direct: null, zip: null, restored: null,
    zipMemberVerified: false, restoredVerified: false, deletionRequiredReopen: false }));
  const flag = (state, reason) => { if (!state.reason) state.reason = reason; };
  const delivered = () => states.filter((state) => state.delivered);
  let intake = null; let connected = false; let reopened = false; let stage = 'session'; let runtimeFailure = null;

  const setIntake = async (open) => {
    for (let attempt = 0; attempt < 2 && intake && intake.photosOpen !== open; attempt++) {
      const action = pick(open ? OPEN_ACTIONS : CLOSE_ACTIONS, intake.state);
      if (!action) break;
      ({ intake } = await client.photoIntake(action));
    }
    return intake?.photosOpen === open;
  };
  const checkPreview = async (state) => {
    const id = state.mediaId;
    const owner = await client.preview('owner', id, { retries: 3 });
    const manager = await client.preview('manager', id, { retries: 3 });
    const other = await client.preview('other-guest', id);
    const signedOut = await client.preview('signed-out', id);
    const reasons = [
      owner?.status !== 200 ? 'preview-owner-unavailable' : privateImage(owner) ? null : 'preview-not-private',
      visibleImage(manager) ? null : 'preview-manager-unavailable',
      denialFailure(other, 'preview-visible-to-other-guest'),
      denialFailure(signedOut, 'preview-visible-signed-out'),
    ].filter(Boolean);
    state.privatePreview = reasons.length === 0;
    if (reasons.length) flag(state, reasons[0]);
  };
  const checkOriginal = async (state) => {
    const { fixture } = state;
    const observed = await client.original(state.mediaId, fixture.byteSize, { retries: 2 });
    state.direct = observed?.status === 200 && sha(observed.sha256) ? observed.sha256 : null;
    if (observed?.status !== 200) flag(state, 'original-unavailable');
    else if (observed.sha256 !== fixture.sha256 || observed.byteSize !== fixture.byteSize) flag(state, 'original-mismatch');
  };
  const checkArchive = async (targets) => {
    const archive = await client.exportMembers(targets.map((state) => ({ mediaId: state.mediaId, byteSize: state.fixture.byteSize })));
    for (const state of targets) {
      const member = typeof archive?.members?.get === 'function' ? archive.members.get(state.mediaId) : undefined;
      if (!object(member) || member.failure || !sha(member.sha256)) {
        flag(state, ZIP_FAILURES.has(member?.failure) ? member.failure : 'zip-export-failed');
        continue;
      }
      state.zip = member.sha256;
      state.zipMemberVerified = member.sha256 === state.fixture.sha256 && member.byteSize === state.fixture.byteSize;
      if (!state.zipMemberVerified) flag(state, 'zip-member-mismatch');
    }
  };
  const checkRecovery = async (state) => {
    const { fixture } = state; const id = state.mediaId;
    if ((await client.trash(id))?.ok !== true) { flag(state, 'trash-failed'); return; }
    if (!denied(await client.preview('owner', id))) flag(state, 'trash-not-denied');
    const listing = await client.trashListing();
    if (listing?.ok !== true || !Array.isArray(listing.ids) || !listing.ids.includes(id)) flag(state, 'trash-not-listed');
    if ((await client.restore(id))?.ok !== true) { flag(state, 'restore-failed'); return; }
    const observed = await client.original(id, fixture.byteSize, { retries: 2 });
    state.restored = observed?.status === 200 && sha(observed.sha256) ? observed.sha256 : null;
    state.restoredVerified = state.restored === fixture.sha256 && observed.byteSize === fixture.byteSize;
    if (!state.restoredVerified) flag(state, 'restore-mismatch');
  };
  /** A deletion refused only because intake is paused may reopen it, once per run. */
  const removeOwn = async (state) => {
    let result = await client.deleteOwn(state.mediaId);
    if (result?.deleted !== true && result?.status === 409 && result.code === 'UPLOADS_DISABLED' && !reopened) {
      reopened = true;
      if (await setIntake(true)) { state.deletionRequiredReopen = true; result = await client.deleteOwn(state.mediaId); }
    }
    state.removed = result?.deleted === true;
    return state.removed;
  };
  const checkDeletion = async (state) => {
    const { fixture } = state; const id = state.mediaId;
    if (!(await removeOwn(state))) { flag(state, 'delete-refused'); return; }
    const original = await client.original(id, fixture.byteSize);
    const preview = await client.preview('owner', id);
    const listing = await client.trashListing();
    state.deleted = denied(original) && denied(preview) && listing?.ok === true && Array.isArray(listing.ids) && !listing.ids.includes(id);
    if (!state.deleted) flag(state, 'deletion-not-enforced');
  };
  const cleanup = async () => {
    let media = false, gate = false;
    if (connected) {
      for (const state of states) {
        if (!state.mediaId || state.removed) continue;
        try {
          let result = await client.deleteOwn(state.mediaId);
          if (result?.deleted !== true && result?.status === 409 && result.code === 'UPLOADS_DISABLED' && (await setIntake(true))) {
            result = await client.deleteOwn(state.mediaId);
          }
          state.removed = result?.deleted === true;
          if (!state.removed) media = true;
        } catch { media = true; }
      }
      try { if (intake?.photosOpen !== false && !(await setIntake(false))) gate = true; } catch { gate = true; }
    }
    try { client.close?.(); } catch { /* sessions are process-local */ }
    return media && gate ? 'media-and-intake' : media ? 'media' : gate ? 'intake' : null;
  };

  try {
    ({ intake } = await client.connect());
    connected = true;
    stage = 'intake-open';
    if (!(await setIntake(true))) fail();
    stage = 'capabilities';
    const capabilities = await client.capabilities();
    for (const [position, state] of states.entries()) {
      const { fixture } = state;
      const mimeType = mimeFor(fixture.extension);
      if (!admitted(fixture, mimeType, capabilities)) { state.missing = true; state.reason = 'not-admitted'; continue; }
      stage = 'upload';
      const trace = await client.upload({ file: fixture.file, byteSize: fixture.byteSize, sha256: fixture.sha256, mimeType, extension: fixture.extension },
        { key: `live-${runId}-${position + 1}`, index: position + 1, onReserved: (mediaId) => { state.mediaId = mediaId; } });
      if (typeof trace?.mediaId === 'string') state.mediaId = trace.mediaId;
      state.transport = trace?.transport === 'direct' || trace?.transport === 'parts-v1' ? trace.transport : null;
      const verdict = classifyUpload(trace);
      if (verdict === 'not-admitted') { state.missing = true; state.reason = verdict; continue; }
      if (verdict !== 'delivered') { flag(state, verdict); continue; }
      state.delivered = true;
      stage = 'preview';
      await checkPreview(state);
    }
    // The originals and the frozen ZIP are read only once guest intake is closed.
    stage = 'intake-close';
    if (!(await setIntake(false))) fail();
    stage = 'original';
    for (const state of delivered()) await checkOriginal(state);
    stage = 'export';
    if (delivered().length) await checkArchive(delivered());
    stage = 'trash';
    for (const state of delivered()) await checkRecovery(state);
    stage = 'deletion';
    for (const state of delivered()) await checkDeletion(state);
  } catch {
    runtimeFailure = STAGE_FAILURES[stage] ?? 'unexpected';
  }
  const cleanupFailure = await cleanup();

  const results = states.map((state) => {
    const { fixture } = state;
    const observed = [state.direct, state.zip, state.restored];
    const roundTrip = observed.every((value) => value === fixture.sha256) ? fixture.sha256 : observed.find((value) => value !== fixture.sha256) ?? null;
    let status = 'missing'; let reason = state.reason;
    if (!state.missing) {
      if (!runtimeFailure && !reason && state.delivered && state.privatePreview && state.deleted && state.zipMemberVerified
        && state.restoredVerified && roundTrip === fixture.sha256) status = 'pass';
      else if (reason) status = 'fail';
      else reason = runtimeFailure ? 'runtime-failure' : 'incomplete';
    }
    return {
      caseId: fixture.caseId, fixtureId: fixture.fixtureId, sourceSha256: fixture.sha256, status, transport: state.transport,
      delivered: state.delivered, privatePreview: state.privatePreview, deleted: state.deleted, originalRoundTripSha256: roundTrip,
      zipMemberVerified: state.zipMemberVerified, restoredVerified: state.restoredVerified, deletionRequiredReopen: state.deletionRequiredReopen,
      ...(status === 'pass' ? {} : { reason }),
    };
  });
  return {
    kind: 'live-workflow', harnessVersion: 1, recorderVersion: RECORDER_VERSION, environment: 'preview', origin: identity.origin,
    buildFingerprint: identity.buildFingerprint, imageRef: identity.imageRef, workerVersionId: identity.workerVersionId,
    startedAt, finishedAt: new Date(now()).toISOString(), results,
    ...(runtimeFailure ? { runtimeFailure } : {}), ...(cleanupFailure ? { cleanupFailure } : {}),
  };
}

/**
 * The command: a dry-run plan by default; with `live` every gate, the private
 * inputs, the output target and every original are checked before the first
 * request, then one evidence document is written. Throws LiveRefusal on a gate.
 */
export async function recordLiveWorkflow({
  live = false, authorizationPath, manifestPath = DEFAULT_MANIFEST, fixtureRoot, evidenceRoot, outputDir, caseIds,
  env = process.env, now = () => Date.now(), repoRoot = REPO_ROOT, isIgnored, fetch, sleep, timeouts,
} = {}) {
  const manifestFile = resolve(manifestPath);
  const fixtures = resolve(fixtureRoot ?? dirname(manifestFile));
  if (!live) return planLiveWorkflow({ manifestPath: manifestFile, fixtureRoot: fixtures, caseIds });
  if (env?.CANDIDARY_LIVE_WORKFLOW_CONFIRM !== 'I_UNDERSTAND' || typeof authorizationPath !== 'string' || !isAbsolute(authorizationPath)) {
    throw new LiveRefusal('confirmation-required');
  }
  const context = { repoRoot, isIgnored, now };
  if (!privateFile(authorizationPath, context)) throw new LiveRefusal('private-path');
  const authorization = validateAuthorization(await readJsonFile(authorizationPath, 'authorization-invalid'), context);
  const { out, root } = await outputTarget(outputDir, evidenceRoot ?? fixtures);
  const manifest = await readJsonFile(manifestFile, 'fixtures-invalid', MAX_MANIFEST_BYTES);
  const selected = await verifyOriginals(selectFixtures(manifest, authorization.caseIds), fixtures);
  const credentials = validateCredentials(await readJsonFile(authorization.credentialsPath, 'credentials-invalid', MAX_CREDENTIALS_BYTES), authorization.eventId);
  const client = createLiveClient({ origin: authorization.target, credentials, fetch, sleep, timeouts });
  const report = await runLiveWorkflow({ client, fixtures: selected, identity: { origin: authorization.target, ...authorization.identity }, now });
  const pointer = await writeEvidence(report, out, root);
  return {
    pointer, results: report.results.map(({ caseId, fixtureId, status }) => ({ caseId, fixtureId, status })),
    ...(report.runtimeFailure ? { runtimeFailure: report.runtimeFailure } : {}), ...(report.cleanupFailure ? { cleanupFailure: report.cleanupFailure } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const cases = value('--cases');
  try {
    const printed = await recordLiveWorkflow({
      live: args.includes('--live'), authorizationPath: value('--authorization'), manifestPath: value('--manifest'),
      fixtureRoot: value('--fixture-root'), evidenceRoot: value('--evidence-root'), outputDir: value('--out'),
      caseIds: cases === undefined ? undefined : cases.split(',').map((id) => id.trim()).filter(Boolean),
    });
    console.log(JSON.stringify(printed, null, 2));
    if (printed.runtimeFailure || printed.cleanupFailure) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify(error instanceof LiveRefusal ? { refused: true, code: error.code, message: error.message }
      : { failed: true, message: 'Live workflow failed; no evidence was recorded.' }, null, 2));
    process.exitCode = 1;
  }
}

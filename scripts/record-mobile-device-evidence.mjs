/* global Buffer, URL, console, process */
/**
 * Offline recorder for physical iOS Safari / Android Chrome observations.
 *
 * It turns an operator's observation form plus files pulled from the device and
 * downloaded from the authorized preview into one `physical-device` evidence
 * document for scripts/verify-mobile-image-corpus.mjs. Every SHA-256 it records
 * is computed here from an actual file; browser-reported hashes are accepted only
 * when they equal one of those computed hashes. It never upgrades a claim, never
 * infers a platform limitation, reads only local files, has no network client,
 * and writes exactly one file, named by its own SHA-256, into an explicitly given
 * directory that is inside the evidence root and ignored by Git (or outside any
 * work tree). Protocol: docs/verification/mobile-image-device-protocol.md.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consentedCaptureRoles, requiredCaseIds } from './verify-mobile-image-corpus.mjs';
import catalog from '../shared/mobile-image-cases.json' with { type: 'json' };

export const RECORDER_VERSION = 1;
const FORM_KIND = 'candidary.mobile-device-observation-form';
const SELECTION_KIND = 'candidary.selection-observation';
const MAX_JSON_BYTES = 1024 * 1024; // Form, selection and output share the corpus verifier's evidence bound.
const BROWSERS = { ios: 'Safari', android: 'Chrome' };
const CAMERA_SETTINGS = { ios: ['cameraFormats', 'proRaw', 'livePhoto', 'hdr'], android: ['cameraApp', 'ultraHdr', 'motionPhoto', 'raw', 'heif'] };
const STATUSES = ['pass', 'fail', 'platform-limited', 'missing'];
const INTERRUPTIONS = ['background', 'offline', 'reload', 'retry'];
const DELETION_STEPS = ['trash', 'restore', 'permanent'];
const LIMITATIONS = ['chooser-conversion', 'paired-resource-not-delivered'];
const MOTION_PHOTO_CASE = 'jpeg-motion-photo-still';
// Mirrors shared/image-formats.ts so an accept attribute can be read without a TS loader.
const EXTENSION_MIME = {
  jpg: ['image/jpeg', 'image/jpg'], jpeg: ['image/jpeg', 'image/jpg'], png: ['image/png', 'image/apng'], apng: ['image/png', 'image/apng'],
  webp: ['image/webp'], heic: ['image/heic', 'image/x-heic'], heif: ['image/heif', 'image/x-heif'], dng: ['image/dng', 'image/x-adobe-dng'],
  avif: ['image/avif'], gif: ['image/gif'], tif: ['image/tiff'], tiff: ['image/tiff'], bmp: ['image/bmp', 'image/x-ms-bmp'],
  jp2: ['image/jp2', 'image/jpeg2000'], jxl: ['image/jxl'],
};

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
const inside = (root, path) => { const part = relative(root, path); return part === '' || !(part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)); };

export class DeviceEvidenceRefusal extends Error {
  constructor(issues) {
    super(`Device evidence refused:\n- ${issues.join('\n- ')}`);
    this.name = 'DeviceEvidenceRefusal';
    this.issues = issues;
  }
}

/* ------------------------------------------------------------------ files */

async function digestFile(path) {
  const hash = createHash('sha256'); let byteSize = 0;
  for await (const bytes of createReadStream(path)) { hash.update(bytes); byteSize += bytes.length; }
  return { sha256: hash.digest('hex'), byteSize };
}

async function containedFile(root, path, label) {
  if (!text(path) || isAbsolute(path) || path.includes('\0')) throw new Error(`${label}: invalid relative input path.`);
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error(`${label}: input path leaves the run directory.`);
  let real;
  try { real = await realpath(target); } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Filesystem causes expose private capture paths.
    throw new Error(`${label}: ${error.code === 'ENOENT' ? 'input file not found' : 'input file unreadable'}.`);
  }
  if (!inside(await realpath(root), real)) throw new Error(`${label}: input path leaves the run directory through a link.`);
  if (!(await stat(real)).isFile()) throw new Error(`${label}: input is not an ordinary file.`);
  return real;
}

async function readJson(path, label) {
  if ((await stat(path)).size > MAX_JSON_BYTES) throw new Error(`${label}: JSON exceeds 1 MiB.`);
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`${label}: invalid JSON.`); }
}

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

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length); let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done);
    if (!bytesRead) throw new Error('ZIP is truncated.');
    done += bytesRead;
  }
  return buffer;
}

/** Locates one stored member through the central directory and hashes exactly its bytes. */
async function zipMember(path, name) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw new Error('ZIP end record missing.');
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readExact(handle, tailLength, size - tailLength);
    let end = -1;
    for (let i = tailLength - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('ZIP end record missing.');
    let count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      if (end < 20 || tail.readUInt32LE(end - 20) !== 0x07064b50) throw new Error('ZIP64 locator missing.');
      const record = await readExact(handle, 56, Number(tail.readBigUInt64LE(end - 12)));
      if (record.readUInt32LE(0) !== 0x06064b50) throw new Error('ZIP64 end record missing.');
      count = Number(record.readBigUInt64LE(32)); directorySize = Number(record.readBigUInt64LE(40)); directoryOffset = Number(record.readBigUInt64LE(48));
    }
    if (directorySize > 64 * 1024 ** 2 || directoryOffset + directorySize > size) throw new Error('ZIP central directory is out of bounds.');
    const directory = await readExact(handle, directorySize, directoryOffset);
    const matches = []; let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP central directory is malformed.');
      const nameLength = directory.readUInt16LE(p + 28), extraLength = directory.readUInt16LE(p + 30), commentLength = directory.readUInt16LE(p + 32);
      if (p + 46 + nameLength + extraLength + commentLength > directory.length) throw new Error('ZIP central directory is malformed.');
      const entry = {
        flags: directory.readUInt16LE(p + 8), method: directory.readUInt16LE(p + 10), crc: directory.readUInt32LE(p + 16),
        compressed: directory.readUInt32LE(p + 20), uncompressed: directory.readUInt32LE(p + 24), local: directory.readUInt32LE(p + 42),
        name: directory.subarray(p + 46, p + 46 + nameLength).toString('utf8'),
      };
      const extra = directory.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      for (let q = 0; q + 4 <= extra.length;) {
        const id = extra.readUInt16LE(q), length = extra.readUInt16LE(q + 2); let r = q + 4;
        if (id === 0x0001) {
          for (const key of ['uncompressed', 'compressed', 'local']) {
            if (entry[key] === 0xffffffff) { if (r + 8 > q + 4 + length) throw new Error('ZIP64 field is malformed.'); entry[key] = Number(extra.readBigUInt64LE(r)); r += 8; }
          }
        }
        q += 4 + length;
      }
      if (entry.name === name) matches.push(entry);
      p += 46 + nameLength + extraLength + commentLength;
    }
    if (matches.length !== 1) throw new Error(matches.length ? `ZIP member ${name} is duplicated.` : `ZIP member ${name} not found.`);
    const member = matches[0];
    if (member.flags & 1) throw new Error(`ZIP member ${name} is encrypted.`);
    if (member.method !== 0 || member.compressed !== member.uncompressed) throw new Error(`ZIP member ${name} is not stored unchanged.`);
    const header = await readExact(handle, 30, member.local);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`ZIP member ${name} has no local header.`);
    const start = member.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + member.compressed > directoryOffset) throw new Error(`ZIP member ${name} is out of bounds.`);
    const hash = createHash('sha256'); let crc = 0;
    if (member.compressed > 0) {
      for await (const bytes of createReadStream(path, { start, end: start + member.compressed - 1 })) { hash.update(bytes); crc = crc32(crc, bytes); }
    }
    if (crc !== member.crc) throw new Error(`ZIP member ${name} fails its CRC-32.`);
    return { name, sha256: hash.digest('hex'), byteSize: member.compressed, crc32Verified: true };
  } finally { await handle.close(); }
}

/** First plausible ISO BMFF `ftyp` box after byte 2: an appended Motion Photo video, if any. */
async function embeddedVideoOffset(path) {
  let carry = Buffer.alloc(0); let position = 0;
  for await (const chunk of createReadStream(path)) {
    const data = Buffer.concat([carry, chunk]); const base = position - carry.length;
    for (let i = 4; i + 8 <= data.length; i++) {
      if (data[i] !== 0x66 || data[i + 1] !== 0x74 || data[i + 2] !== 0x79 || data[i + 3] !== 0x70) continue;
      const start = base + i - 4; const size = data.readUInt32BE(i - 4);
      const brand = data.subarray(i + 4, i + 8);
      if (start > 2 && size >= 8 && size <= 4096 && brand.every((byte) => byte >= 0x20 && byte <= 0x7e)) return start;
    }
    carry = data.subarray(Math.max(0, data.length - 11)); position += chunk.length;
  }
  return null;
}

/* --------------------------------------------------------------- output */

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000 });
  if (result.error) throw new DeviceEvidenceRefusal(['Git is required to prove the output directory is ignored.']);
  return result;
}

/** The only write target: an existing directory inside the evidence root, never tracked or trackable by Git. */
async function outputTarget(outputDir, evidenceRoot) {
  if (!text(outputDir)) throw new DeviceEvidenceRefusal(['An explicit output directory (--out) is required.']);
  if (!text(evidenceRoot)) throw new DeviceEvidenceRefusal(['An evidence root is required.']);
  let out, root;
  try { out = await realpath(resolve(outputDir)); if (!(await stat(out)).isDirectory()) throw new Error(); } catch {
    throw new DeviceEvidenceRefusal(['The output directory must be an existing directory; the recorder never creates one.']);
  }
  try { root = await realpath(resolve(evidenceRoot)); } catch { throw new DeviceEvidenceRefusal(['The evidence root must exist.']); }
  if (!inside(root, out)) throw new DeviceEvidenceRefusal(['The output directory must be inside the evidence root so the manifest pointer stays relative.']);
  const top = git(['rev-parse', '--show-toplevel'], out);
  if (top.status === 0) {
    const repository = await realpath(top.stdout.trim());
    const probe = relative(repository, join(out, `${'0'.repeat(64)}.json`)).split(sep).join('/');
    if (git(['check-ignore', '-q', '--no-index', '--', probe], repository).status !== 0) {
      throw new DeviceEvidenceRefusal(['The output directory is inside a Git work tree but is not ignored; use ignored storage such as tests/fixtures/mobile-images/evidence.']);
    }
  } else if (!/not a git repository/iu.test(top.stderr ?? '')) {
    throw new DeviceEvidenceRefusal(['Could not determine whether the output directory is ignored by Git.']);
  }
  return { out, root };
}

/* ------------------------------------------------------------ validation */

function requireText(issues, value, message) { if (!text(value)) issues.push(message); }

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}

function settingsIssues(settings, required) {
  if (!object(settings) || Object.values(settings).some((value) => !text(value))) return ['settings must be an object of non-empty text values.'];
  return required.filter((key) => !Object.hasOwn(settings, key)).map((key) => `settings.${key} is required (record the exact label, or that the device does not offer it).`);
}

function selectionIssues(selection, label) {
  if (!object(selection) || selection.kind !== SELECTION_KIND || selection.version !== 1 || !['camera', 'library', 'unknown'].includes(selection.source)
    || typeof selection.accept !== 'string' || !Array.isArray(selection.files) || selection.files.length < 1 || selection.files.length > 100
    || selection.files.some((file) => !object(file) || typeof file.name !== 'string' || file.name.length > 1024 || typeof file.type !== 'string'
      || file.type.length > 255 || !Number.isSafeInteger(file.size) || file.size < 0 || !sha(file.sha256))) {
    return [`${label}: not a ${SELECTION_KIND} v1 record with hashed Files.`];
  }
  return [];
}

function acceptOffers(accept, extension) {
  const tokens = accept.split(',').map((token) => token.trim().toLowerCase()).filter(Boolean);
  return tokens.includes(`.${extension}`) || (EXTENSION_MIME[extension] ?? []).some((type) => tokens.includes(type));
}

function transportIssues(check, index) {
  const issues = [];
  if (!object(check) || !['direct', 'resumable'].includes(check.transport) || !text(check.fixtureId)) return [`transportChecks[${index}] needs transport and fixtureId.`];
  for (const key of INTERRUPTIONS) {
    const value = check[key];
    if (!object(value) || !['resumed', 'restarted', 'failed', 'not-exercised'].includes(value.outcome)
      || typeof value.deliveredOnce !== 'boolean' || !text(value.observation)) issues.push(`transportChecks[${index}].${key} needs outcome, deliveredOnce and observation.`);
  }
  const late = check.lateWrite;
  if (!object(late) || !['refused', 'accepted', 'not-exercised'].includes(late.outcome) || !text(late.observation)) {
    issues.push(`transportChecks[${index}].lateWrite needs outcome and observation.`);
  }
  return issues;
}

function transportPassBlockers(checks, transport) {
  const candidates = checks.filter((check) => check.transport === transport);
  if (!candidates.length) return [`No transport resilience checks were recorded for ${transport} transfers in this run.`];
  const blockers = [];
  const ok = candidates.find((check) => INTERRUPTIONS.every((key) => {
    const value = check[key];
    return value.deliveredOnce === true && (value.outcome === 'resumed' || (value.outcome === 'restarted' && transport === 'direct'));
  }));
  if (!ok) {
    for (const key of INTERRUPTIONS) {
      if (!candidates.some((check) => check[key].deliveredOnce === true && (check[key].outcome === 'resumed' || (check[key].outcome === 'restarted' && transport === 'direct')))) {
        blockers.push(`The ${key} interruption for ${transport} transfers must resume (or, for direct transfers, restart) and be delivered exactly once.`);
      }
    }
  }
  if (!candidates.some((check) => check.lateWrite.outcome === 'refused')) blockers.push(`A late write after deletion must be observed as refused for ${transport} transfers.`);
  return blockers;
}

/* ---------------------------------------------------------------- record */

async function hashed(root, path, label, fatal) {
  if (path === undefined || path === null) return null;
  try {
    const file = await containedFile(root, path, label);
    return { ...(await digestFile(file)), file };
  } catch (error) { fatal.push(error.message); return null; }
}

async function recordResult(result, index, context) {
  const { form, inputRoot, manifest, fatal, transportChecks } = context;
  const label = `results[${index}]`;
  const issue = (message) => fatal.push(`${label}: ${message}`);
  if (!object(result)) { issue('must be an object.'); return null; }
  const { caseId, fixtureId } = result;
  if (!requiredCaseIds.includes(caseId)) issue('caseId is not a required case.');
  if (!text(fixtureId) || !sha(result.fixtureSha256)) issue('fixtureId and fixtureSha256 are required.');
  const fixture = manifest.cases?.find((item) => item.id === caseId)?.fixtures?.find((item) => item.id === fixtureId);
  if (!fixture) issue(`fixture ${fixtureId} is not recorded under case ${caseId} in the manifest.`);
  else if (fixture.sha256 !== result.fixtureSha256) issue('fixtureSha256 does not match the manifest.');
  if (!STATUSES.includes(result.claimedStatus)) issue('claimedStatus must be pass, fail, platform-limited or missing.');
  if (result.claimedStatus !== 'pass' && !text(result.reason)) issue('a non-pass result needs a reason.');
  if (!['camera', 'library'].includes(result.path)) issue('path must be camera or library.');
  if (result.path === 'camera' && fixture && fixture.provenance?.kind !== 'consented-capture') {
    issue('a camera capture can only be recorded against a consented-capture fixture.');
  }
  if (!object(result.files)) { issue('files must be an object.'); return null; }
  if (result.claimedStatus !== 'platform-limited' && result.platformLimitation !== undefined && result.platformLimitation !== null) {
    issue('platformLimitation is only valid with claimedStatus platform-limited.');
  }

  const files = result.files;
  const roles = ['deviceOriginal', 'selection', 'downloadedOriginal', 'zip', 'restoredOriginal', 'handoff', 'pairedDeviceResource', 'pairedDownloaded'];
  const digests = await Promise.all(roles.map((role) => hashed(inputRoot, files[role], `${label}.${role}`, fatal)));
  // Fixed role order keeps identical observations byte-identical, whatever order the reads finish in.
  const inputs = roles.flatMap((role, position) => (digests[position] ? [{ role, sha256: digests[position].sha256, byteSize: digests[position].byteSize }] : []));
  const [device, selectionFile, downloaded, zipFile, restored, handoffFile, pairedDevice, pairedDownloaded] = digests;
  let selection = null;
  if (selectionFile) {
    try {
      selection = await readJson(selectionFile.file, `${label}.selection`);
      const invalid = selectionIssues(selection, `${label}.selection`);
      if (invalid.length) { fatal.push(...invalid); selection = null; }
    } catch (error) { fatal.push(error.message); }
  }
  const blockers = [];
  const block = (message) => blockers.push(`${label} (${caseId}/${fixtureId}): ${message}`);
  const fixtureSha = result.fixtureSha256;
  const extension = fixture ? extname(fixture.path).slice(1).toLowerCase() : '';

  // Settings: camera routes need the platform's capture settings, library routes how the original reached the device.
  const settingsProblems = settingsIssues(result.settings, result.path === 'camera' ? CAMERA_SETTINGS[form.platform] ?? [] : ['originTransfer']);
  if (!object(result.settings) || Object.values(result.settings ?? {}).some((value) => !text(value))) issue(settingsProblems[0]);
  else settingsProblems.forEach(block);

  // Selection as the browser delivered it, before Candidary saw the File.
  const chooser = object(result.chooser) ? result.chooser : {};
  const entries = selection?.files ?? [];
  const primary = entries.find((file) => downloaded && file.sha256 === downloaded.sha256) ?? entries[0] ?? null;
  if (!selection) block('the selection observation (selection File name, MIME, size and in-browser SHA-256) is required.');
  else if (selection.source !== result.path) block(`selection source ${selection.source} does not match path ${result.path}.`);
  requireText(blockers, chooser.surface, `${label}: chooser.surface (the picker/camera surface actually shown) is required.`);
  if (!['pulled', 'not-saved-by-platform'].includes(chooser.deviceOriginal)) block('chooser.deviceOriginal must be pulled or not-saved-by-platform.');
  if (chooser.deviceOriginal === 'pulled' && !device) block('chooser.deviceOriginal is pulled but no device original file was given.');
  if (chooser.deviceOriginal === 'not-saved-by-platform' && device) block('a device original was given although chooser.deviceOriginal says none was saved.');
  if (result.path === 'library' && !device) block('a library selection needs the device original pulled from the device.');
  if (device && !text(chooser.originalPull)) block('chooser.originalPull (how the device original was copied off the device) is required.');
  const conversion = device && primary ? (device.sha256 === primary.sha256 ? 'none' : 'converted') : device ? 'unknown' : 'not-observable';
  if (device && device.sha256 !== fixtureSha && result.path === 'library') block('the device original differs from the pinned fixture.');
  if (conversion === 'converted' && result.path === 'library') block('the picker delivered a converted File: the selected File differs from the device original.');

  // Delivered bytes: in-browser selection, direct download, frozen ZIP member, restored copy and device handoff.
  if (!downloaded) block('the downloaded original is required.');
  else if (downloaded.sha256 !== fixtureSha) block('the downloaded original differs from the pinned fixture.');
  const selectedMatches = Boolean(primary && downloaded && primary.sha256 === downloaded.sha256 && primary.size === downloaded.byteSize);
  if (primary && downloaded && !selectedMatches) block('the selected File hash/size reported in the browser differs from the downloaded original.');
  let member = null;
  if (!zipFile || !text(result.zipMember)) block('the frozen ZIP part and its member name are required.');
  else {
    try { member = await zipMember(zipFile.file, result.zipMember); } catch (error) { block(`ZIP: ${error.message}`); }
    if (member && member.sha256 !== fixtureSha) block('the ZIP member differs from the pinned fixture.');
  }
  if (!restored) block('the restored original download is required after Trash and Restore.');
  else if (restored.sha256 !== fixtureSha) block('the restored original differs from the pinned fixture.');

  // Upload behavior.
  if (!['direct', 'resumable'].includes(result.transport)) block('transport (direct or resumable, from the network panel) is required.');
  else transportPassBlockers(transportChecks, result.transport).forEach(block);
  const receipt = object(result.receipt) ? result.receipt : {};
  if (!['observed', 'not-observed'].includes(receipt.confirming)) block('receipt.confirming must be observed or not-observed.');
  if (receipt.delivered !== 'observed' || receipt.prematureReceipt !== false) block('a delivered receipt must be observed only after delivery (receipt.delivered observed, prematureReceipt false).');

  // Private preview and rendering.
  const preview = object(result.preview) ? result.preview : {};
  if (preview.owner !== 'visible') block('the uploading guest must see their private preview.');
  if (preview.manager !== 'visible') block('the manager must see the private preview.');
  if (preview.otherGuest !== 'denied') block("another guest's preview access must be observed as denied.");
  if (preview.signedOut !== 'denied') block('signed-out preview access must be observed as denied.');
  if (preview.rendering !== 'as-expected' || !text(preview.renderingObservation)) block('preview rendering must be observed as expected, with a description.');

  // Export, deletion and handoff.
  const exported = object(form.run?.export) ? form.run.export : {};
  if (exported.intakeClosedBeforeExport !== true) block('guest intake must be closed before the ZIP is frozen (run.export.intakeClosedBeforeExport).');
  const deletion = object(result.deletion) ? result.deletion : {};
  for (const step of DELETION_STEPS) {
    if (!object(deletion[step]) || deletion[step].outcome !== 'pass' || !text(deletion[step].observation)) block(`${step === 'permanent' ? 'permanent deletion' : step} must be observed as pass, with a description.`);
  }
  const handoff = object(result.handoff) ? result.handoff : {};
  if (typeof handoff.canShare !== 'boolean' || !text(handoff.observation)) block('handoff.canShare and handoff.observation are required.');
  if (handoff.outcome === 'shared') {
    if (handoff.canShare !== true || !text(handoff.destination)) block('a shared handoff needs canShare true and its destination.');
    if (!handoffFile) block('the handoff file saved from the share sheet is required.');
    else if (handoffFile.sha256 !== fixtureSha) block('the handoff file differs from the pinned fixture.');
  } else if (handoff.outcome !== 'fallback-zip') block('handoff.outcome must be shared or fallback-zip.');

  // Format-specific resources.
  let motionPhoto;
  if (caseId === MOTION_PHOTO_CASE) {
    const deliveredOffset = downloaded ? await embeddedVideoOffset(downloaded.file) : null;
    const deviceOffset = device ? await embeddedVideoOffset(device.file) : null;
    motionPhoto = { embeddedVideoOffset: deliveredOffset, deviceOriginalEmbeddedVideoOffset: deviceOffset };
    if (deliveredOffset === null) block('Motion Photo embedded video not found in the delivered original.');
    if (device && deviceOffset !== deliveredOffset) block('Motion Photo embedded video position changed between device and delivery.');
  }
  let pairedResources;
  if (catalog.paired.includes(caseId)) {
    const delivered = Boolean(pairedDevice && entries.some((file) => file.sha256 === pairedDevice.sha256));
    pairedResources = !pairedDevice ? 'not-observed'
      : delivered && pairedDownloaded?.sha256 === pairedDevice.sha256 ? 'retained' : delivered ? 'refused-by-app' : 'not-delivered-by-picker';
    if (pairedResources !== 'retained') block(`paired resources are ${pairedResources}; a Live Photo passes only when its paired movie is delivered and retained unchanged.`);
  }

  // A platform limitation is recorded only when it was explicitly observed and the computed files agree.
  const limitation = result.platformLimitation;
  if (result.claimedStatus === 'platform-limited') {
    if (preview.otherGuest !== 'denied' || preview.signedOut !== 'denied') {
      issue('Private-preview denial must be observed before a result can be platform-limited; a Candidary privacy failure is recorded as fail.');
    } else if (!object(limitation) || limitation.observed !== true || !LIMITATIONS.includes(limitation.kind) || !text(limitation.observation)) {
      issue(`platform-limited requires an explicitly observed platform limitation (observed: true, kind ${LIMITATIONS.join(' | ')}, observation).`);
    } else if (limitation.kind === 'chooser-conversion') {
      if (result.path !== 'library' || !device || device.sha256 !== fixtureSha || conversion !== 'converted') {
        issue('chooser-conversion needs a pulled device original equal to the fixture and a different selected File; no conversion was computed.');
      } else if (!selection || !acceptOffers(selection.accept, extension)) {
        issue(`chooser-conversion is not a platform limitation when the page's accept attribute did not offer .${extension}.`);
      }
    } else if (pairedResources !== 'not-delivered-by-picker') {
      issue(`paired-resource-not-delivered needs a pulled paired resource that the picker did not deliver; computed ${pairedResources ?? 'not-applicable'}, which is not a platform limitation.`);
    }
  }
  if (result.claimedStatus === 'pass' && blockers.length) context.passBlockers.push(...blockers);

  const deletedOk = DELETION_STEPS.every((step) => object(deletion[step]) && deletion[step].outcome === 'pass')
    && ['direct', 'resumable'].includes(result.transport) && transportChecks.some((check) => check.transport === result.transport && check.lateWrite.outcome === 'refused');
  return {
    caseId, fixtureId, sourceSha256: fixtureSha, status: result.claimedStatus,
    ...(result.claimedStatus === 'pass' ? {} : { reason: result.reason }),
    originalRoundTripSha256: downloaded?.sha256 ?? null,
    delivered: receipt.delivered === 'observed' && receipt.prematureReceipt === false && selectedMatches,
    privatePreview: preview.owner === 'visible' && preview.manager === 'visible' && preview.otherGuest === 'denied' && preview.signedOut === 'denied',
    deleted: deletedOk,
    ...(pairedResources ? { pairedResources } : {}),
    observations: {
      path: result.path, settings: result.settings ?? null,
      selected: primary ? {
        name: primary.name, mimeType: primary.type, byteSize: primary.size, lastModified: primary.lastModified ?? null, sha256: primary.sha256,
        sha256Source: 'browser-observation', matchesDeliveredOriginal: selectedMatches,
      } : null,
      selectedFiles: entries.map((file) => ({ name: file.name, mimeType: file.type, byteSize: file.size, sha256: file.sha256 })),
      chooser: {
        surface: chooser.surface ?? null, acceptAttribute: selection?.accept ?? null, userAgent: selection?.userAgent ?? null,
        deviceOriginalStatus: chooser.deviceOriginal ?? null, originalPull: chooser.originalPull ?? null,
        deviceOriginal: device ? { sha256: device.sha256, byteSize: device.byteSize } : null, conversion, notes: chooser.notes ?? null,
      },
      downloadedOriginal: downloaded ? { sha256: downloaded.sha256, byteSize: downloaded.byteSize } : null,
      zipMember: member ? { ...member, zipSha256: zipFile.sha256 } : null,
      restoredOriginal: restored ? { sha256: restored.sha256, byteSize: restored.byteSize } : null,
      transport: result.transport ?? null, receipt: result.receipt ?? null, preview: result.preview ?? null, deletion: result.deletion ?? null,
      handoff: { ...handoff, sha256: handoffFile?.sha256 ?? null, byteSize: handoffFile?.byteSize ?? null, fallbackUsed: handoff.outcome === 'fallback-zip' },
      ...(motionPhoto ? { motionPhoto } : {}),
      ...(pairedResources ? { paired: {
        deviceResource: pairedDevice ? { sha256: pairedDevice.sha256, byteSize: pairedDevice.byteSize } : null,
        downloadedResource: pairedDownloaded ? { sha256: pairedDownloaded.sha256, byteSize: pairedDownloaded.byteSize } : null,
      } } : {}),
      platformLimitation: result.claimedStatus === 'platform-limited' ? limitation : null,
      computedIssues: blockers,
      notes: result.notes ?? null,
    },
    inputs,
  };
}

async function recordRoute(route, index, context) {
  const label = `routes[${index}]`;
  const { fatal, form, inputRoot, resultKeys } = context;
  if (!object(route) || !requiredCaseIds.includes(route.caseId) || !['camera', 'library', 'files'].includes(route.path)
    || !['produced', 'unavailable'].includes(route.outcome) || !text(route.observation)) {
    fatal.push(`${label}: a route observation needs caseId, path camera|library|files, outcome produced|unavailable and an observation.`); return null;
  }
  if (route.outcome === 'unavailable' && route.observed !== true) fatal.push(`${label}: an unavailable route is recorded only when explicitly observed (observed: true).`);
  if (route.outcome === 'produced' && !resultKeys.has(route.producedFixtureId)) fatal.push(`${label}: a produced route must name producedFixtureId of a result in this document.`);
  const settings = settingsIssues(route.settings, route.path === 'camera' ? CAMERA_SETTINGS[form.platform] ?? [] : []);
  fatal.push(...settings.map((message) => `${label}: ${message}`));
  const file = await hashed(inputRoot, route.selection, `${label}.selection`, fatal);
  let delivered = null;
  if (file) {
    try {
      const selection = await readJson(file.file, `${label}.selection`);
      const invalid = selectionIssues(selection, `${label}.selection`);
      if (invalid.length) fatal.push(...invalid);
      else delivered = selection.files.map((item) => ({ name: item.name, mimeType: item.type, byteSize: item.size, sha256: item.sha256 }));
    } catch (error) { fatal.push(error.message); }
  }
  return {
    caseId: route.caseId, path: route.path, outcome: route.outcome, observed: route.observed === true, observation: route.observation,
    settings: route.settings ?? null, producedFixtureId: route.producedFixtureId ?? null, delivered, selectionSha256: file?.sha256 ?? null,
  };
}

/**
 * Records one physical-device evidence document. Throws DeviceEvidenceRefusal
 * (with `issues`) instead of writing whenever a claim is not supported.
 */
export async function recordDeviceEvidence({ formPath, inputRoot, manifestPath, evidenceRoot, outputDir }) {
  const { out, root } = await outputTarget(outputDir, evidenceRoot);
  if (!text(formPath)) throw new DeviceEvidenceRefusal(['An observation form (--form) is required.']);
  const formFile = resolve(formPath);
  const inputs = resolve(inputRoot ?? dirname(formFile));
  let form, manifest, formDigest;
  try {
    form = await readJson(formFile, 'form');
    formDigest = await digestFile(formFile);
    manifest = await readJson(resolve(manifestPath), 'manifest');
  } catch (error) { throw new DeviceEvidenceRefusal([error.message]); }
  const fatal = [];
  if (!object(form) || form.kind !== FORM_KIND || form.formVersion !== 1) throw new DeviceEvidenceRefusal([`form must be a ${FORM_KIND} v1 document.`]);
  if (!object(manifest) || manifest.version !== 1 || !Array.isArray(manifest.cases)) throw new DeviceEvidenceRefusal(['manifest is not a v1 corpus manifest.']);
  if (!Object.hasOwn(BROWSERS, form.platform)) fatal.push('platform must be ios or android.');
  const device = object(form.device) ? form.device : {};
  requireText(fatal, device.model, 'Device model is required.');
  requireText(fatal, device.osVersion, 'Device OS version is required.');
  requireText(fatal, device.browserVersion, 'Browser version is required.');
  if (BROWSERS[form.platform] && device.browserName !== BROWSERS[form.platform]) {
    fatal.push(`${form.platform} evidence must come from ${BROWSERS[form.platform]}; other browsers are not a required lane.`);
  }
  const deployment = object(form.deployment) ? form.deployment : {};
  if (!httpsOrigin(deployment.origin)) fatal.push('deployment.origin must be a bare https origin (no path, query, fragment or credentials).');
  if (!sha(deployment.buildFingerprint)) fatal.push('deployment.buildFingerprint must be the 64-hex decoder build fingerprint.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(deployment.imageRef ?? '')) fatal.push('deployment.imageRef must be <registry image>@sha256:<digest>.');
  requireText(fatal, deployment.workerVersionId, 'deployment.workerVersionId (the deployed main Worker version) is required.');
  if (!consentedCaptureRoles.includes(form.operatorRole)) fatal.push(`operatorRole must be one of ${consentedCaptureRoles.join(', ')} (a role, never a name).`);
  const run = object(form.run) ? form.run : {};
  if (!iso(run.startedAt) || !iso(run.finishedAt) || Date.parse(run.startedAt) > Date.parse(run.finishedAt)) fatal.push('run.startedAt and run.finishedAt must be ordered ISO timestamps.');
  const exported = run.export;
  if (!object(exported) || typeof exported.intakeClosedBeforeExport !== 'boolean' || !['photo-export-archive', 'event-export'].includes(exported.kind)
    || !text(exported.observation)) fatal.push('run.export needs intakeClosedBeforeExport, kind photo-export-archive|event-export and an observation.');
  const transportChecks = Array.isArray(form.transportChecks) ? form.transportChecks : null;
  if (!transportChecks) fatal.push('transportChecks must be an array.');
  else transportChecks.forEach((check, index) => fatal.push(...transportIssues(check, index)));
  if (!Array.isArray(form.results) || form.results.length < 1 || form.results.length > 200) fatal.push('results must list 1-200 observed fixtures.');
  if (form.routes !== undefined && !Array.isArray(form.routes)) fatal.push('routes must be an array when present.');
  if (fatal.length) throw new DeviceEvidenceRefusal(fatal);

  const keys = form.results.map((item) => `${item?.caseId}\0${item?.fixtureId}`);
  if (new Set(keys).size !== keys.length) throw new DeviceEvidenceRefusal(['Each case/fixture pair may appear once per document.']);
  const context = { form, inputRoot: inputs, manifest, fatal, transportChecks, passBlockers: [], resultKeys: new Set(form.results.map((item) => item?.fixtureId)) };
  const results = [];
  for (const [index, result] of form.results.entries()) results.push(await recordResult(result, index, context));
  const routes = [];
  for (const [index, route] of (form.routes ?? []).entries()) routes.push(await recordRoute(route, index, context));
  if (fatal.length || context.passBlockers.length) throw new DeviceEvidenceRefusal([...fatal, ...context.passBlockers]);

  const document = {
    kind: 'physical-device', harnessVersion: 1, recorder: { name: 'record-mobile-device-evidence', version: RECORDER_VERSION },
    formSha256: formDigest.sha256,
    buildFingerprint: deployment.buildFingerprint, imageRef: deployment.imageRef,
    deployment: { origin: deployment.origin, workerVersionId: deployment.workerVersionId },
    platform: form.platform, deviceModel: device.model, osVersion: device.osVersion, browserName: device.browserName, browserVersion: device.browserVersion,
    operatorRole: form.operatorRole,
    run: { startedAt: run.startedAt, finishedAt: run.finishedAt, export: exported },
    transportChecks, routes, results,
  };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_JSON_BYTES) throw new DeviceEvidenceRefusal(['The evidence document exceeds the corpus verifier\'s 1 MiB bound; split the run.']);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const target = join(out, `${digest}.json`);
  try { await writeFile(target, bytes, { flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(target)).equals(bytes)) throw new DeviceEvidenceRefusal(['Could not create the evidence file without replacing different content.']);
  }
  return {
    pointer: { path: relative(root, target).split(sep).join('/'), sha256: digest },
    lane: form.platform,
    // A `missing` result documents an unexecuted step; its manifest lane stays null rather than pointing here.
    results: results.map(({ caseId, fixtureId, status }) => ({
      caseId, fixtureId, status, manifestField: status === 'missing' ? null : `cases[${caseId}].fixtures[${fixtureId}].evidence.${form.platform}`,
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const manifestPath = resolve(value('--manifest', 'tests/fixtures/mobile-images/manifest.json'));
  try {
    const recorded = await recordDeviceEvidence({
      formPath: value('--form'), inputRoot: value('--inputs'), manifestPath,
      evidenceRoot: value('--evidence-root', dirname(manifestPath)), outputDir: value('--out'),
    });
    console.log(JSON.stringify(recorded, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ refused: true, issues: error instanceof DeviceEvidenceRefusal ? error.issues : [error.message] }, null, 2));
    process.exitCode = 1;
  }
}

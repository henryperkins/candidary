/* global console, process */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from '../shared/mobile-image-cases.json' with { type: 'json' };

export const requiredCaseIds = [...new Set([
  ...Object.values(catalog.families).flatMap((group) => [...group.still, ...group.sequence]), ...catalog.paired,
])];
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const lanes = ['local', 'live', 'android', 'ios'];
/** Roles, never personal names, attribute a private capture made for release verification. */
export const consentedCaptureRoles = ['release-owner', 'release-delegate'];

async function contained(root, path) {
  if (!text(path) || isAbsolute(path)) throw new Error('Invalid relative fixture/evidence path.');
  const target = resolve(root, path);
  const part = relative(root, target);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Fixture/evidence path leaves its root.');
  const real = await realpath(target);
  const actual = relative(await realpath(root), real);
  if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) throw new Error('Fixture/evidence symlink leaves its root.');
  if (!(await stat(real)).isFile()) throw new Error('Fixture/evidence is not an ordinary file.');
  return real;
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

/**
 * Public fixtures name an https source. A consented capture is instead a private
 * original made on a release test device: it has no URL, is never redistributable,
 * is attributed by role, stays in the ignored originals directory and records the
 * capture it came from. Hashes, encoded expectations, lanes and reference rules are
 * identical for both kinds.
 */
// Plain segments under originals/ only: no dot segments or backslashes can leave the ignored directory.
const ignoredOriginal = (path) => {
  const segments = path.split('/');
  return !path.includes('\\') && segments.length > 1 && segments[0] === 'originals'
    && segments.every((segment) => segment && segment !== '.' && segment !== '..');
};

function provenanceIssue(fixture) {
  const p = fixture.provenance;
  if (object(p) && p.kind === 'consented-capture') {
    const capture = fixture.capture;
    return Object.hasOwn(p, 'url') || p.consent !== true || p.redistributable !== false || !text(p.license)
      || !consentedCaptureRoles.includes(p.attribution) || !ignoredOriginal(fixture.path)
      || !object(capture) || !['device', 'os', 'settings'].every((key) => text(capture[key]) && !/^\s*unknown\b/iu.test(capture[key]))
      ? 'Invalid consented private capture: requires consent, no URL, no redistribution, a license statement, role attribution, an ignored originals/ path and known capture details.'
      : null;
  }
  return !object(p) || Object.hasOwn(p, 'kind') || !text(p.url) || !p.url.startsWith('https://') || !text(p.license) || !text(p.attribution)
    || typeof p.redistributable !== 'boolean' || p.consent !== true ? 'Missing lawful provenance, license or consent.' : null;
}

function fixtureIssues(fixture) {
  const issues = [];
  if (!object(fixture) || !text(fixture.id) || !text(fixture.path) || !sha(fixture.sha256)
    || typeof fixture.synthetic !== 'boolean') return ['Invalid fixture identity, hash or input classification.'];
  const provenance = provenanceIssue(fixture);
  if (provenance) issues.push(provenance);
  if (!object(fixture.capture) || !['device', 'os', 'settings'].every((key) => text(fixture.capture[key]))) issues.push('Missing capture provenance (use unknown explicitly).');
  const encoded = fixture.encoded;
  if (!object(encoded) || !text(encoded.codec) || !text(encoded.container)
    || !['width', 'height', 'frames', 'orientation'].every((key) => positive(encoded[key])) || encoded.orientation > 8) issues.push('Invalid encoded image expectations.');
  if (!object(fixture.evidence) || !lanes.every((key) => Object.hasOwn(fixture.evidence, key))) issues.push('Missing independent outcome slots.');
  if (!Object.hasOwn(fixture, 'reference')) issues.push('Missing reference rendering slot.');
  return issues;
}

async function checkEvidence(pointer, root, caseId, fixture, lane, fixtureRoot) {
  if (pointer === null || pointer === undefined) return { status: 'missing', reason: `${lane}: missing evidence.` };
  try {
    if (!object(pointer) || !sha(pointer.sha256)) throw new Error('Invalid evidence pointer.');
    const path = await contained(root, pointer.path);
    if ((await stat(path)).size > 1024 * 1024 || await hashFile(path) !== pointer.sha256) throw new Error('Evidence hash/size mismatch.');
    const report = JSON.parse(await readFile(path, 'utf8'));
    const kind = lane === 'local' ? 'native-service' : lane === 'live' ? 'live-workflow' : 'physical-device';
    if (report.kind !== kind || report.harnessVersion !== 1 || !sha(report.buildFingerprint)
      || !Array.isArray(report.results)) throw new Error('Not independent native/workflow/device evidence.');
    if (report.runtimeFailure || report.cleanupFailure) throw new Error('Evidence harness failed or could not clean up its runtime.');
    const result = report.results.find((item) => item.caseId === caseId && item.fixtureId === fixture.id && item.sourceSha256 === fixture.sha256);
    if (!result) throw new Error('Evidence does not identify this exact original/case.');
    if (result.status === 'platform-limited') return { status: 'platform-limited', reason: `${lane}: platform-limited.` };
    if (result.status !== 'pass') throw new Error('Evidence records a failed or missing result.');
    if (lane === 'local') {
      if (!object(fixture.reference) || !sha(fixture.reference.sha256)
        || result.preview?.referenceSha256 !== fixture.reference.sha256
        || await hashFile(await contained(fixtureRoot, fixture.reference.path)) !== fixture.reference.sha256) throw new Error('Missing or mismatched pinned reference rendering.');
      if (report.image?.source !== 'docker-inspect' || !/^sha256:[a-f0-9]{64}$/u.test(report.image?.id ?? '')
        || result.preview?.independentlyDecoded !== true || result.preview?.pixelsCompared !== true
        || !sha(result.preview?.sha256) || !text(result.preview?.decoder) || !text(result.preview?.decoderVersion)
        || result.preview?.metadataStripped !== true || result.preview?.orientationVerified !== true
        || result.preview?.colorVerified !== true || result.sourceUnchanged !== true) throw new Error('Incomplete native output/reference evidence.');
    } else {
      if (!/^[^\s]+@sha256:[a-f0-9]{64}$/u.test(report.imageRef ?? '')
        || result.originalRoundTripSha256 !== fixture.sha256 || result.delivered !== true
        || result.privatePreview !== true || result.deleted !== true) throw new Error('Incomplete deployed original/privacy/deletion evidence.');
      if (lane !== 'live' && (report.platform !== lane
        || !['deviceModel', 'osVersion', 'browserName', 'browserVersion'].every((key) => text(report[key])))) throw new Error('Missing physical device/browser identity.');
    }
    if (catalog.paired.includes(caseId) && result.pairedResources !== 'retained') return { status: 'platform-limited', reason: `${lane}: paired resources not retained.` };
    return { status: 'pass', evidenceSha256: pointer.sha256, buildFingerprint: report.buildFingerprint,
      imageRefs: lane === 'local' ? (report.image.registryDigests ?? []) : [report.imageRef] };
  } catch (error) {
    return { status: 'fail', reason: `${lane}: ${error.code === 'ENOENT' ? 'Missing evidence file.' : error.message}` };
  }
}

export async function verifyCorpus({ manifestPath, fixtureRoot = dirname(manifestPath), evidenceRoot = fixtureRoot }) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const issues = [];
  if (manifest.version !== 1 || !Array.isArray(manifest.cases)) throw new Error('Unsupported corpus manifest schema.');
  const ids = manifest.cases.map((item) => item.id);
  if (new Set(ids).size !== ids.length) issues.push('Duplicate required case IDs.');
  for (const id of requiredCaseIds) if (!ids.includes(id)) issues.push(`Missing required case record: ${id}.`);
  const cases = [];
  const qualifiedCaseIds = [];
  for (const record of manifest.cases) {
    const reasons = [];
    const outcomes = [];
    const fixtures = [];
    if (!text(record.id) || !Array.isArray(record.fixtures)) {
      issues.push('Invalid required-case record.'); continue;
    }
    const fixtureIds = new Set();
    for (const fixture of record.fixtures) {
      const invalid = fixtureIssues(fixture);
      if (fixtureIds.has(fixture.id)) invalid.push('Duplicate fixture ID.');
      fixtureIds.add(fixture.id);
      issues.push(...invalid.map((issue) => `${record.id}: ${issue}`));
      if (invalid.length) { reasons.push(...invalid); outcomes.push({ status: 'fail', local: false }); continue; }
      if (fixture.synthetic) { reasons.push('Synthetic input is parser evidence only.'); outcomes.push({ status: 'missing', local: false }); continue; }
      try {
        const path = await contained(fixtureRoot, fixture.path);
        if (await hashFile(path) !== fixture.sha256) throw new Error('Original hash mismatch.');
      } catch (error) {
        reasons.push(error.code === 'ENOENT' ? 'Missing original file.' : error.message);
        outcomes.push({ status: error.code === 'ENOENT' ? 'missing' : 'fail', local: false }); continue;
      }
      const evidence = await Promise.all(lanes.map((lane) => checkEvidence(fixture.evidence[lane], evidenceRoot, record.id, fixture, lane, fixtureRoot)));
      fixtures.push({ id: fixture.id, sourceSha256: fixture.sha256, evidence: Object.fromEntries(lanes.map((lane, index) => [lane, evidence[index]])) });
      reasons.push(...evidence.flatMap((item) => item.reason ? [item.reason] : []));
      const statuses = evidence.map((item) => item.status);
      const status = statuses.includes('fail') ? 'fail' : statuses.includes('platform-limited') ? 'platform-limited' : statuses.includes('missing') ? 'missing' : 'pass';
      outcomes.push({ status, local: evidence[0].status === 'pass' });
    }
    if (!outcomes.length) reasons.push('Missing real-file fixtures.');
    const statuses = outcomes.map((item) => item.status);
    const status = statuses.includes('fail') ? 'fail' : statuses.includes('platform-limited') ? 'platform-limited' : !outcomes.length || statuses.includes('missing') ? 'missing' : 'pass';
    if (outcomes.length && outcomes.every((item) => item.local)) qualifiedCaseIds.push(record.id);
    cases.push({ id: record.id, status, reasons: [...new Set(reasons)], fixtures });
  }
  return { structureValid: issues.length === 0, complete: issues.length === 0 && cases.length > 0 && cases.every((item) => item.status === 'pass'),
    qualifiedCaseIds, cases, issues };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try {
    const manifestPath = resolve(value('--manifest', 'tests/fixtures/mobile-images/manifest.json'));
    const fixtureRoot = resolve(value('--fixture-root', dirname(manifestPath)));
    const report = await verifyCorpus({ manifestPath, fixtureRoot, evidenceRoot: resolve(value('--evidence-root', fixtureRoot)) });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = !report.structureValid || (args.includes('--require-complete') && !report.complete) ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({ structureValid: false, complete: false, qualifiedCaseIds: [], cases: [], issues: [error.message] }, null, 2));
    process.exitCode = 1;
  }
}

/* global console, process */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredCaseIds, verifyCorpus } from './verify-mobile-image-corpus.mjs';
import { assessLoadEvidence, verifyLoadArtifacts } from './mobile-image-load-harness.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
// An external registry digest names a dotted registry host. Docker's containerd store also
// reports RepoDigests like `name@sha256:<id>` for never-pushed images; those, and loopback
// registries, cannot stand in for the externally obtained immutable reference.
const image = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u.test(value)
  && /^(?!localhost(?::|$))(?!127\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::[0-9]{1,5})?\/[^@]+@/iu.test(value);
const bytes = value => Number.isSafeInteger(value) && value > 0 && value <= 512 * 1024 ** 2;
const profile = 'mobile-preview-v1';
// A 58,290-operation load observations bundle is about 30 MiB; keep headroom for real rows.
const MAX_EVIDENCE_BYTES = 128 * 1024 ** 2;

export async function verifyRelease({ decoderRelease, mobileRelease, corpus, manifestSha256, readEvidence }) {
  const issues = [], admitted = new Set();
  const fail = message => { issues.push(message); };
  const list = value => Array.isArray(value) && value.length <= 1024;
  if (!corpus?.structureValid || !sha(manifestSha256) || decoderRelease?.protocolVersion !== 1 || decoderRelease.previewProfile !== profile
    || !list(decoderRelease.releases) || mobileRelease?.kind !== 'candidary.mobile-image-release' || mobileRelease.schemaVersion !== 26
    || mobileRelease.protocolVersion !== 1 || mobileRelease.previewProfile !== profile || !bytes(mobileRelease.maxOriginalBytes)
    || !list(mobileRelease.cases)) return { valid: false, admittedCaseIds: [], universal: false, issues: ['Invalid committed release/corpus schema.'] };
  const documents = new Map();
  async function evidence(digest) {
    if (!sha(digest)) throw new Error('Missing evidence digest.');
    if (!documents.has(digest)) {
      const data = await readEvidence(digest);
      if (!data || data.length > MAX_EVIDENCE_BYTES || hash(data) !== digest) throw new Error('Evidence hash/size mismatch.');
      documents.set(digest, JSON.parse(data.toString('utf8')));
    }
    return documents.get(digest);
  }
  async function qualification(entry) {
    const q = await evidence(entry.evidenceSha256);
    if (q.kind !== 'mobile-image-qualification' || q.harnessVersion !== 1 || q.buildFingerprint !== entry.buildFingerprint
      || !image(q.imageRef) || q.previewProfile !== profile || q.manifestSha256 !== manifestSha256
      || !bytes(q.maxOriginalBytes) || !list(q.caseIds) || !q.caseIds.length || q.caseIds.some(id => !requiredCaseIds.includes(id))
      || new Set(q.caseIds).size !== q.caseIds.length) throw new Error('Qualification identity/manifest mismatch.');
    return q;
  }
  function caseProof(caseId, q, lanes) {
    const candidate = corpus.cases.find(item => item.id === caseId);
    if (!candidate?.fixtures?.length || !q.caseIds.includes(caseId)) return false;
    return candidate.fixtures.every(fixture => sha(fixture.sourceSha256) && lanes.every(lane => {
      const proof = fixture.evidence[lane];
      return proof?.status === 'pass' && proof.buildFingerprint === q.buildFingerprint
        && sha(proof.evidenceSha256) && proof.imageRefs?.includes(q.imageRef);
    }));
  }
  const native = new Map();
  for (const entry of decoderRelease.releases) {
    try {
      if (!sha(entry.buildFingerprint) || !image(entry.imageRef) || entry.protocolVersion !== 1 || entry.previewProfile !== profile
        || !list(entry.verifiedCaseIds) || !entry.verifiedCaseIds.length || new Set(entry.verifiedCaseIds).size !== entry.verifiedCaseIds.length
        || native.has(entry.buildFingerprint)) throw new Error('Invalid or ambiguous native release.');
      const q = await qualification(entry);
      if (q.imageRef !== entry.imageRef || entry.verifiedCaseIds.some(id => !corpus.qualifiedCaseIds.includes(id) || !caseProof(id, q, ['local'])))
        throw new Error('Native cases lack matching external image evidence.');
      native.set(entry.buildFingerprint, entry);
    } catch (error) { fail(error.message); }
  }
  const seen = new Set();
  for (const entry of mobileRelease.cases) {
    try {
      const key = `${entry.caseId}:${entry.buildFingerprint}`;
      if (!requiredCaseIds.includes(entry.caseId) || !bytes(entry.maxOriginalBytes) || seen.has(key)
        || entry.maxOriginalBytes > mobileRelease.maxOriginalBytes) throw new Error('Invalid or duplicate intake case.');
      seen.add(key);
      const decoder = native.get(entry.buildFingerprint), q = await qualification(entry);
      if (!decoder?.verifiedCaseIds.includes(entry.caseId) || q.imageRef !== decoder.imageRef || entry.maxOriginalBytes > q.maxOriginalBytes
        || corpus.cases.find(item => item.id === entry.caseId)?.status !== 'pass'
        || !caseProof(entry.caseId, q, ['local', 'live', 'ios', 'android'])) throw new Error('Intake case lacks complete matching evidence.');
      const load = await evidence(q.loadEvidenceSha256);
      const assessment = assessLoadEvidence(load, q);
      if (!assessment.pass) throw new Error(assessment.issues.join(' '));
      if (!verifyLoadArtifacts(load, await evidence(load.observationsSha256), await evidence(load.instrumentationSha256)))
        throw new Error('Load measurements do not match pinned observations/instrumentation.');
      admitted.add(entry.caseId);
    } catch (error) { fail(error.message); }
  }
  const valid = issues.length === 0;
  return { valid, admittedCaseIds: valid ? [...admitted].sort() : [],
    universal: valid && corpus.complete === true && requiredCaseIds.every(id => corpus.cases.some(item => item.id === id && item.status === 'pass'))
      && requiredCaseIds.filter(id => !id.startsWith('live-photo-')).every(id => admitted.has(id)), issues: [...new Set(issues)] };
}

/** Digest filenames avoid ambiguous report discovery. Realpath containment also
 * keeps ignored/private evidence from accidentally becoming a filesystem reader. */
async function evidenceReader(root, digest) {
  if (!sha(digest)) throw new Error('Invalid evidence digest.');
  const path = await realpath(resolve(root, `${digest}.json`));
  const part = relative(await realpath(root), path);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part) || !(await stat(path)).isFile()
    || (await stat(path)).size > MAX_EVIDENCE_BYTES) throw new Error('Invalid evidence file.');
  return readFile(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  try {
    const manifestPath = resolve(value('--manifest', 'tests/fixtures/mobile-images/manifest.json'));
    const fixtureRoot = resolve(value('--fixture-root', dirname(manifestPath)));
    const evidenceRoot = resolve(value('--evidence-root', fixtureRoot));
    const report = await verifyRelease({
      decoderRelease: JSON.parse(await readFile('config/image-decoder-release.json', 'utf8')),
      mobileRelease: JSON.parse(await readFile('config/mobile-image-release.json', 'utf8')),
      corpus: await verifyCorpus({ manifestPath, fixtureRoot, evidenceRoot }),
      manifestSha256: hash(await readFile(manifestPath)), readEvidence: digest => evidenceReader(evidenceRoot, digest),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.valid && (!args.includes('--require-universal') || report.universal) ? 0 : 1;
  } catch { console.log(JSON.stringify({ valid: false, admittedCaseIds: [], universal: false, issues: ['Missing or invalid release evidence.'] })); process.exitCode = 1; }
}

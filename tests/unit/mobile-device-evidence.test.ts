import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Node recorder script's actual interface is tested here.
import { recordDeviceEvidence } from '../../scripts/record-mobile-device-evidence.mjs';
// @ts-expect-error Node corpus verifier's actual interface is tested here.
import { verifyCorpus } from '../../scripts/verify-mobile-image-corpus.mjs';

type Json = Record<string, any>;
const script = resolve('scripts/record-mobile-device-evidence.mjs');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const movie = Buffer.from('\0\0\0\x14ftypqt  \0\0\0\0qt  \0\0\0\x08free', 'latin1');
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/** Mirrors the export writer: fflate streaming ZIP entries with data descriptors, stored unchanged. */
function zip(members: Record<string, Uint8Array>): Buffer {
  const chunks: Uint8Array[] = [];
  const archive = new Zip((error, data) => { if (error) throw error; chunks.push(data); });
  for (const [name, bytes] of Object.entries(members)) {
    const file = new ZipPassThrough(name);
    archive.add(file);
    file.push(bytes, true);
  }
  archive.end();
  return Buffer.concat(chunks);
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(root, path)).isFile()).map((path) => path.replaceAll('\\', '/')).sort();
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return ((error as { issues?: string[] }).issues ?? [String(error)]).join('\n'); }
  throw new Error('Expected the recorder to refuse.');
}

function run(options: { caseId?: string; original?: Buffer; extension?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'candidary-device-')); scratch.push(root);
  const corpus = join(root, 'corpus'); const evidence = join(corpus, 'evidence'); const inputs = join(root, 'run');
  for (const dir of [join(corpus, 'originals'), evidence, inputs]) mkdirSync(dir, { recursive: true });
  const caseId = options.caseId ?? 'png'; const original = options.original ?? png; const extension = options.extension ?? 'png';
  writeFileSync(join(corpus, 'originals', `photo.${extension}`), original);
  const entry: Json = {
    id: 'device-control', path: `originals/photo.${extension}`, sha256: sha(original), synthetic: false,
    provenance: { url: 'https://example.org/licensed-fixture', license: 'CC0-1.0', attribution: 'Unit fixture', redistributable: true, consent: true },
    capture: { device: 'unknown', os: 'unknown', settings: 'unknown' },
    encoded: { codec: extension, container: extension, width: 1, height: 1, orientation: 1, frames: 1 },
    reference: null, evidence: { local: null, live: null, android: null, ios: null },
  };
  const manifest = JSON.parse(readFileSync('tests/fixtures/mobile-images/manifest.json', 'utf8'));
  // Ignore the operator's local downloaded corpus when constructing unit controls.
  for (const record of manifest.cases) record.fixtures = [];
  manifest.cases.find((item: Json) => item.id === caseId).fixtures.push(entry);
  const manifestPath = join(corpus, 'manifest.json');
  const write = (name: string, bytes: Uint8Array | string) => { writeFileSync(join(inputs, name), bytes); return name; };
  for (const name of ['device', 'download', 'restored', 'handoff']) write(`${name}.${extension}`, original);
  write('export.zip', zip({ [`001-guest-photo.${extension}`]: original, 'media.csv': Buffer.from('id\n') }));
  const selection: Json = {
    kind: 'candidary.selection-observation', version: 1, source: 'library', accept: 'image/jpeg,image/png,image/heic,.jpg,.png,.heic',
    capturedAt: '2026-09-25T10:05:00.000Z',
    files: [{ name: `IMG_0001.${extension.toUpperCase()}`, type: `image/${extension}`, size: original.length, lastModified: 0, sha256: sha(original) }],
  };
  const check = (outcome: string) => ({ outcome, deliveredOnce: true, observation: 'Observed on the physical device.' });
  const passed = (observation: string) => ({ outcome: 'pass', observation });
  const form: Json = {
    kind: 'candidary.mobile-device-observation-form', formVersion: 1, platform: 'ios',
    device: { model: 'iPhone (unit control)', osVersion: 'iOS (unit control)', browserName: 'Safari', browserVersion: 'unit control' },
    deployment: {
      origin: 'https://candidary-preview.example.workers.dev', buildFingerprint: 'b'.repeat(64),
      imageRef: `registry.example/decoder@sha256:${'c'.repeat(64)}`, workerVersionId: 'unit-control-version',
    },
    operatorRole: 'release-owner',
    run: {
      startedAt: '2026-09-25T10:00:00.000Z', finishedAt: '2026-09-25T11:00:00.000Z',
      export: { intakeClosedBeforeExport: true, kind: 'photo-export-archive', observation: 'Guest uploads paused before the ZIP was frozen.' },
    },
    transportChecks: [{
      transport: 'direct', fixtureId: 'device-control',
      background: check('restarted'), offline: check('restarted'), reload: check('restarted'), retry: check('restarted'),
      lateWrite: { outcome: 'refused', observation: 'Replayed content PUT after deletion returned 409; photo stayed deleted.' },
    }],
    routes: [],
    results: [{
      caseId, fixtureId: 'device-control', fixtureSha256: sha(original), claimedStatus: 'pass', path: 'library',
      settings: { originTransfer: 'AirDrop with All Photos Data from the release workstation' },
      files: {
        deviceOriginal: `device.${extension}`, selection: 'selection.json', downloadedOriginal: `download.${extension}`, zip: 'export.zip',
        restoredOriginal: `restored.${extension}`, handoff: `handoff.${extension}`,
      },
      zipMember: `001-guest-photo.${extension}`,
      chooser: { surface: 'Photos picker (Recents)', deviceOriginal: 'pulled', originalPull: 'Image Capture with Transfer to Mac or PC: Keep Originals' },
      transport: 'direct',
      receipt: { confirming: 'observed', delivered: 'observed', prematureReceipt: false },
      preview: {
        owner: 'visible', manager: 'visible', otherGuest: 'denied', signedOut: 'denied',
        rendering: 'as-expected', renderingObservation: 'Upright; colors match the device original.',
      },
      deletion: { trash: passed('Hidden from guests; listed in Recently deleted.'), restore: passed('Restored with its publication state.'), permanent: passed('Guest deletion removed it everywhere.') },
      handoff: { canShare: true, outcome: 'shared', destination: 'Save to Files', observation: 'Saved copy pulled from Files.' },
    }],
  };
  const save = () => {
    write('selection.json', JSON.stringify(selection)); write('form.json', JSON.stringify(form));
    writeFileSync(manifestPath, JSON.stringify(manifest));
  };
  const args = (outputDir: unknown = evidence) => ({ formPath: join(inputs, 'form.json'), manifestPath, evidenceRoot: corpus, outputDir });
  const record = (outputDir: unknown = evidence) => { save(); return recordDeviceEvidence(args(outputDir)); };
  return { root, corpus, evidence, inputs, manifest, manifestPath, entry, form, selection, result: form.results[0] as Json, write, save, args, record };
}

async function iosLane(test: ReturnType<typeof run>, pointer: { path: string; sha256: string }) {
  test.entry.evidence.ios = pointer;
  writeFileSync(test.manifestPath, JSON.stringify(test.manifest));
  const report = await verifyCorpus({ manifestPath: test.manifestPath });
  return report.cases.find((item: Json) => item.fixtures.length).fixtures[0].evidence.ios;
}

describe('physical-device evidence recorder', () => {
  it('records an observed pass, named by its own SHA-256, that the corpus verifier accepts', async () => {
    const test = run();
    const recorded = await test.record();
    const bytes = readFileSync(join(test.corpus, recorded.pointer.path));
    expect(recorded.pointer).toEqual({ path: `evidence/${sha(bytes)}.json`, sha256: sha(bytes) });
    const document = JSON.parse(bytes.toString('utf8'));
    expect(document).toMatchObject({
      kind: 'physical-device', harnessVersion: 1, platform: 'ios', deviceModel: 'iPhone (unit control)', osVersion: 'iOS (unit control)',
      browserName: 'Safari', browserVersion: 'unit control', buildFingerprint: 'b'.repeat(64), operatorRole: 'release-owner',
    });
    expect(document.results[0]).toMatchObject({
      caseId: 'png', fixtureId: 'device-control', sourceSha256: test.entry.sha256, status: 'pass',
      originalRoundTripSha256: test.entry.sha256, delivered: true, privatePreview: true, deleted: true,
      observations: {
        path: 'library', chooser: { conversion: 'none', deviceOriginal: { sha256: test.entry.sha256 } },
        selected: { sha256: test.entry.sha256, mimeType: 'image/png', matchesDeliveredOriginal: true },
        zipMember: { name: '001-guest-photo.png', sha256: test.entry.sha256, crc32Verified: true },
        handoff: { outcome: 'shared', sha256: test.entry.sha256 },
      },
    });
    expect(bytes.toString('utf8')).not.toMatch(/candidary-device-/); // No local paths leak into shareable evidence.
    expect(await iosLane(test, recorded.pointer)).toMatchObject({ status: 'pass', evidenceSha256: recorded.pointer.sha256 });
  });

  it('prints the manifest pointer from the command line and exits non-zero on refusal', () => {
    const test = run(); test.save();
    const cli = () => spawnSync(process.execPath, [script, '--form', join(test.inputs, 'form.json'), '--manifest', test.manifestPath,
      '--evidence-root', test.corpus, '--out', test.evidence], { encoding: 'utf8' });
    const accepted = cli();
    expect(accepted.status).toBe(0);
    const printed = JSON.parse(accepted.stdout);
    expect(printed).toMatchObject({ lane: 'ios', pointer: { path: `evidence/${printed.pointer.sha256}.json` } });
    expect(sha(readFileSync(join(test.corpus, printed.pointer.path)))).toBe(printed.pointer.sha256);
    test.result.preview.signedOut = 'visible'; test.save();
    const refused = cli();
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ refused: true, issues: expect.arrayContaining([expect.stringMatching(/signed-out/i)]) });
    expect(readdirSync(test.evidence)).toHaveLength(1);
  });

  it('refuses a pass when any computed hash differs, and writes nothing', async () => {
    const altered = Buffer.from(png); altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    const mismatches: Array<[string, Buffer, RegExp]> = [
      ['download.png', altered, /downloaded original/i], ['device.png', altered, /device original/i],
      ['restored.png', altered, /restored original/i], ['handoff.png', altered, /handoff/i],
      ['export.zip', zip({ '001-guest-photo.png': altered }), /ZIP member/i],
    ];
    for (const [name, bytes, pattern] of mismatches) {
      const test = run(); test.write(name, bytes);
      expect(await refusal(test.record())).toMatch(pattern);
      expect(readdirSync(test.evidence)).toEqual([]);
    }
    const browser = run(); browser.selection.files[0].sha256 = 'a'.repeat(64);
    expect(await refusal(browser.record())).toMatch(/selected File/i);
    const manifest = run(); manifest.result.fixtureSha256 = 'a'.repeat(64);
    expect(await refusal(manifest.record())).toMatch(/manifest/i);
    const truncated = run(); truncated.write('export.zip', zip({ '001-guest-photo.png': png }).subarray(0, 40));
    expect(await refusal(truncated.record())).toMatch(/ZIP/i);
    expect(readdirSync(truncated.evidence)).toEqual([]);
  });

  it('refuses a pass when any required observation is absent', async () => {
    const omissions: Array<[(test: ReturnType<typeof run>) => void, RegExp]> = [
      [(test) => { delete test.form.device.model; }, /device model/i],
      [(test) => { test.form.device.browserName = 'Chrome'; }, /Safari/],
      [(test) => { test.form.deployment.imageRef = 'registry.example/decoder:latest'; }, /imageRef/],
      [(test) => { test.form.deployment.origin = 'https://candidary-preview.example.workers.dev/manage/secret'; }, /origin/i],
      [(test) => { delete test.result.preview.signedOut; }, /signed-out/i],
      [(test) => { test.result.preview.otherGuest = 'visible'; }, /other guest/i],
      [(test) => { delete test.result.files.zip; }, /ZIP/],
      [(test) => { delete test.result.files.restoredOriginal; }, /restored original/i],
      [(test) => { delete test.result.deletion.permanent; }, /permanent/i],
      [(test) => { test.form.transportChecks = []; }, /transport/i],
      [(test) => { test.form.transportChecks[0].lateWrite.outcome = 'not-exercised'; }, /late write/i],
      [(test) => { test.form.transportChecks[0].offline.deliveredOnce = false; }, /offline/i],
      [(test) => { test.form.run.export.intakeClosedBeforeExport = false; }, /intake/i],
      [(test) => { delete test.result.files.selection; }, /selection/i],
      [(test) => { test.result.settings = {}; }, /originTransfer/],
      [(test) => { test.result.receipt.delivered = 'not-observed'; }, /receipt/i],
      [(test) => { test.result.receipt.prematureReceipt = true; }, /receipt/i],
      [(test) => { delete test.result.files.handoff; }, /handoff/i],
      [(test) => { test.result.preview.rendering = 'wrong'; }, /rendering/i],
      [(test) => { test.selection.source = 'camera'; }, /selection source/i],
    ];
    for (const [omit, pattern] of omissions) {
      const test = run(); omit(test);
      expect(await refusal(test.record())).toMatch(pattern);
      expect(readdirSync(test.evidence)).toEqual([]);
    }
    const motionless = run({ caseId: 'jpeg-motion-photo-still', original: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), extension: 'jpg' });
    expect(await refusal(motionless.record())).toMatch(/Motion Photo/i);
    const trailer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0mp42isom\0\0\0\x08free', 'latin1')]);
    const motion = run({ caseId: 'jpeg-motion-photo-still', original: trailer, extension: 'jpg' });
    const recorded = await motion.record();
    const document = JSON.parse(readFileSync(join(motion.corpus, recorded.pointer.path), 'utf8'));
    expect(document.results[0]).toMatchObject({ status: 'pass', observations: { motionPhoto: { embeddedVideoOffset: 4, deviceOriginalEmbeddedVideoOffset: 4 } } });
  });

  it('records a camera capture only against a consented private capture with its camera settings', async () => {
    const test = run();
    Object.assign(test.result, { path: 'camera', settings: { originTransfer: 'not-applicable' } });
    Object.assign(test.result.chooser, { surface: 'Safari camera capture', deviceOriginal: 'not-saved-by-platform' });
    delete test.result.files.deviceOriginal;
    test.selection.source = 'camera';
    expect(await refusal(test.record())).toMatch(/consented/i);
    Object.assign(test.entry, {
      provenance: { kind: 'consented-capture', consent: true, redistributable: false, attribution: 'release-owner', license: 'Private release verification only.' },
      capture: { device: 'iPhone (unit control)', os: 'iOS (unit control)', settings: 'High Efficiency; Live Photo off' },
    });
    expect(await refusal(test.record())).toMatch(/cameraFormats/);
    Object.assign(test.result.settings, { cameraFormats: 'High Efficiency', proRaw: 'not offered on this model', livePhoto: 'off', hdr: 'HDR photos on' });
    const recorded = await test.record();
    const document = JSON.parse(readFileSync(join(test.corpus, recorded.pointer.path), 'utf8'));
    expect(document.results[0]).toMatchObject({ status: 'pass', observations: { path: 'camera', chooser: { conversion: 'not-observable', deviceOriginal: null } } });
  });

  it('records platform-limited only for an explicitly observed platform limitation', async () => {
    const live = run({ caseId: 'live-photo-library', extension: 'heic' });
    live.write('pair.mov', movie); live.result.files.pairedDeviceResource = 'pair.mov';
    expect(await refusal(live.record())).toMatch(/paired/i); // Never silently relabelled from pass.
    Object.assign(live.result, { claimedStatus: 'platform-limited', reason: 'The picker delivered only the still.' });
    expect(await refusal(live.record())).toMatch(/observed platform limitation/i);
    live.result.platformLimitation = { observed: true, kind: 'chooser-conversion', observation: 'Picker delivered the still only.' };
    expect(await refusal(live.record())).toMatch(/conversion/i);
    live.result.platformLimitation = { observed: true, kind: 'paired-resource-not-delivered', observation: 'Photos picker delivered one HEIC File and no movie.' };
    const limited = await live.record();
    const document = JSON.parse(readFileSync(join(live.corpus, limited.pointer.path), 'utf8'));
    expect(document.results[0]).toMatchObject({ status: 'platform-limited', pairedResources: 'not-delivered-by-picker' });
    expect(await iosLane(live, limited.pointer)).toMatchObject({ status: 'platform-limited' });
    // A visible preview for another guest or a signed-out viewer is Candidary's privacy failure.
    // Denial must be positively observed; any other value, or no observation, is not a platform limitation.
    for (const viewer of ['otherGuest', 'signedOut'] as const) {
      for (const leak of ['visible', 'shown', undefined]) {
        if (leak === undefined) delete live.result.preview[viewer]; else live.result.preview[viewer] = leak;
        expect(await refusal(live.record())).toMatch(/privacy failure/i);
      }
      live.result.preview[viewer] = 'denied';
    }
    // A movie the picker did deliver but Candidary did not keep is Candidary's failure, not the platform's.
    live.selection.files.push({ name: 'IMG_0001.MOV', type: 'video/quicktime', size: movie.length, lastModified: 0, sha256: sha(movie) });
    expect(await refusal(live.record())).toMatch(/not a platform limitation/i);

    const converted = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
    const chooser = run();
    for (const name of ['download.png', 'restored.png', 'handoff.png']) chooser.write(name, converted);
    chooser.write('export.zip', zip({ '001-guest-photo.png': converted }));
    chooser.selection.files[0] = { name: 'IMG_0001.JPG', type: 'image/jpeg', size: converted.length, lastModified: 0, sha256: sha(converted) };
    expect(await refusal(chooser.record())).toMatch(/converted/i);
    Object.assign(chooser.result, { claimedStatus: 'fail', reason: 'The picker delivered a converted JPEG.' });
    const failed = JSON.parse(readFileSync(join(chooser.corpus, (await chooser.record()).pointer.path), 'utf8'));
    expect(failed.results[0]).toMatchObject({ status: 'fail', observations: { chooser: { conversion: 'converted' } } });
    Object.assign(chooser.result, { claimedStatus: 'platform-limited', platformLimitation: { observed: true, kind: 'chooser-conversion', observation: 'Picker delivered JPEG.' } });
    chooser.selection.accept = 'image/jpeg,.jpg';
    expect(await refusal(chooser.record())).toMatch(/accept/i); // Candidary's own accept list caused this conversion.
    chooser.selection.accept = 'image/jpeg,image/png,.jpg,.png';
    const observed = JSON.parse(readFileSync(join(chooser.corpus, (await chooser.record()).pointer.path), 'utf8'));
    expect(observed.results[0]).toMatchObject({ status: 'platform-limited', observations: { platformLimitation: { kind: 'chooser-conversion' } } });

    const route = run();
    route.form.routes = [{ caseId: 'heic-grid', path: 'camera', outcome: 'unavailable', observation: 'Safari camera capture delivered image/jpeg.',
      settings: { cameraFormats: 'High Efficiency', proRaw: 'off', livePhoto: 'off', hdr: 'on' } }];
    expect(await refusal(route.record())).toMatch(/route/i);
    route.form.routes[0].observed = true;
    const routed = JSON.parse(readFileSync(join(route.corpus, (await route.record()).pointer.path), 'utf8'));
    expect(routed.routes[0]).toMatchObject({ caseId: 'heic-grid', path: 'camera', outcome: 'unavailable', observed: true });
  });

  it('writes exactly one evidence file inside an explicitly given ignored output directory', async () => {
    const test = run(); test.save();
    mkdirSync(join(test.root, 'elsewhere'));
    const before = listFiles(test.root);
    expect(await refusal(recordDeviceEvidence(test.args(null)))).toMatch(/output directory/i);
    expect(await refusal(recordDeviceEvidence(test.args(join(test.root, 'elsewhere'))))).toMatch(/evidence root/i);
    expect(await refusal(recordDeviceEvidence(test.args(join(test.evidence, 'absent'))))).toMatch(/existing directory/i);
    // Inside the repository only an ignored directory may receive evidence.
    const tracked = resolve('docs', 'verification'); const trackedBefore = readdirSync(tracked);
    expect(await refusal(recordDeviceEvidence({ ...test.args(tracked), evidenceRoot: resolve('docs') }))).toMatch(/ignored/i);
    expect(readdirSync(tracked)).toEqual(trackedBefore);
    expect(listFiles(test.root)).toEqual(before);
    const recorded = await test.record();
    const added = relative(test.root, join(test.corpus, recorded.pointer.path)).replaceAll('\\', '/');
    expect(listFiles(test.root)).toEqual([...before, added].sort());
    for (let attempt = 0; attempt < 3; attempt++) { // Identical observations reproduce the identical, already-present document.
      expect((await test.record()).pointer).toEqual(recorded.pointer);
      expect(listFiles(test.root)).toEqual([...before, added].sort());
    }
    // Input paths cannot escape the run directory.
    test.result.files.downloadedOriginal = '../corpus/originals/photo.png';
    expect(await refusal(test.record())).toMatch(/leaves/i);
  });

  it('contains no network client', () => {
    const source = readFileSync(script, 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|node:(?:http|https|http2|net|tls|dgram|dns)\b|\bWebSocket\b|XMLHttpRequest|undici/);
    expect([...source.matchAll(/spawnSync\(\s*([^,]+),/g)].map((match) => match[1]!.trim())).toEqual(["'git'"]);
  });
});

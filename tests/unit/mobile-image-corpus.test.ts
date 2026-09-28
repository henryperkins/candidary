import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requiredCasesFor } from '../../shared/image-decoder-contract';

const script = resolve('scripts/verify-mobile-image-corpus.mjs');
const manifestPath = resolve('tests/fixtures/mobile-images/manifest.json');
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'candidary-corpus-')); scratch.push(root);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Ignore the operator's local downloaded corpus when constructing unit controls.
  for (const record of manifest.cases) record.fixtures = [];
  const path = join(root, 'manifest.json');
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  writeFileSync(join(root, 'photo.png'), bytes);
  const entry = {
    id: 'unit-control', path: 'photo.png', sha256: createHash('sha256').update(bytes).digest('hex'), synthetic: false,
    provenance: { url: 'https://example.org/licensed-fixture', license: 'CC0-1.0', attribution: 'Unit fixture', redistributable: true, consent: true },
    capture: { device: 'unknown', os: 'unknown', settings: 'unknown' },
    encoded: { codec: 'png', container: 'png', width: 1, height: 1, orientation: 1, frames: 1 },
    reference: null, evidence: { local: null, live: null, android: null, ios: null },
  };
  manifest.cases.find((item: { id: string }) => item.id === 'png').fixtures.push(entry);
  const run = (mode = '--check-manifest') => {
    writeFileSync(path, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [script, '--manifest', path, mode], { encoding: 'utf8' });
    if (result.error) throw result.error;
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  return { root, manifest, entry, run };
}

describe('mobile image evidence gates', () => {
  it('validates the committed missing-case manifest without claiming qualification', () => {
    const report = JSON.parse(execFileSync(process.execPath, [script, '--check-manifest'], { encoding: 'utf8' }));
    expect(report.structureValid).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.qualifiedCaseIds.every((id: string) => report.cases.some((item: { id: string }) => item.id === id))).toBe(true);
    expect(report.cases.find((item: { id: string }) => item.id === 'dng-proraw-jxl')).toMatchObject({ status: 'missing' });
  });

  it('refuses missing real files and original hash mismatches', () => {
    const test = fixture(); test.entry.path = 'absent.png';
    expect(test.run().report.cases.find((item: { id: string }) => item.id === 'png').reasons.join(' ')).toMatch(/missing/i);
    test.entry.path = 'photo.png'; test.entry.sha256 = 'f'.repeat(64);
    expect(test.run().report.cases.find((item: { id: string }) => item.id === 'png').reasons.join(' ')).toMatch(/hash/i);
    expect(test.run('--require-complete').status).toBe(1);
  });

  it('requires lawful provenance and real encoded input even when a fixture exists', () => {
    const test = fixture(); test.entry.provenance.license = '';
    expect(test.run().report.structureValid).toBe(false);
    test.entry.provenance.license = 'CC0-1.0'; test.entry.synthetic = true;
    const result = test.run();
    expect(result.report.qualifiedCaseIds).not.toContain('png');
    expect(result.report.cases.find((item: { id: string }) => item.id === 'png').reasons.join(' ')).toMatch(/synthetic/i);
  });

  it('cannot qualify a case from a health response or a declared pass without external evidence', () => {
    const test = fixture();
    const fake = { protocolVersion: 1, buildFingerprint: 'b'.repeat(64), decoderVersion: 'test', verifiedCases: ['png'], status: 'pass' };
    const bytes = Buffer.from(JSON.stringify(fake)); writeFileSync(join(test.root, 'health.json'), bytes);
    Object.assign(test.entry.evidence, { local: { path: 'health.json', sha256: createHash('sha256').update(bytes).digest('hex') } });
    const report = test.run().report;
    expect(report.qualifiedCaseIds).not.toContain('png');
    expect(report.complete).toBe(false);
    expect(report.cases.find((item: { id: string }) => item.id === 'png').reasons.join(' ')).toMatch(/evidence|native/i);
  });

  it('keeps required cases independent of supplied files and rejects missing IDs', () => {
    const test = fixture(); test.manifest.cases = test.manifest.cases.filter((item: { id: string }) => item.id !== 'dng-proraw-jxl');
    expect(test.run().report.structureValid).toBe(false);
  });

  it('qualifies a local candidate only with a pinned reference and an independently recorded native result', () => {
    const test = fixture();
    const report = {
      kind: 'native-service', harnessVersion: 1, buildFingerprint: 'b'.repeat(64),
      image: { source: 'docker-inspect', id: `sha256:${'c'.repeat(64)}` },
      results: [{ caseId: 'png', fixtureId: test.entry.id, sourceSha256: test.entry.sha256, status: 'pass', sourceUnchanged: true,
        preview: { sha256: test.entry.sha256, independentlyDecoded: true, pixelsCompared: true, decoder: 'unit-control', decoderVersion: '1',
          metadataStripped: true, orientationVerified: true, colorVerified: true, referenceSha256: test.entry.sha256 } }],
    };
    const bytes = Buffer.from(JSON.stringify(report)); writeFileSync(join(test.root, 'native.json'), bytes);
    Object.assign(test.entry.evidence, { local: { path: 'native.json', sha256: createHash('sha256').update(bytes).digest('hex') } });
    expect(test.run().report.qualifiedCaseIds).not.toContain('png');
    Object.assign(test.entry, { reference: { path: 'photo.png', sha256: test.entry.sha256 } });
    expect(test.run().report.qualifiedCaseIds).toContain('png');
    expect(test.run('--require-complete').status).toBe(1); // Native candidate success never proves device/live coverage.
    for (const failure of [{ runtimeFailure: 'Native service setup failed.' }, { cleanupFailure: true }]) {
      const failedBytes = Buffer.from(JSON.stringify({ ...report, ...failure }));
      writeFileSync(join(test.root, 'native.json'), failedBytes);
      Object.assign(test.entry.evidence, { local: { path: 'native.json', sha256: createHash('sha256').update(failedBytes).digest('hex') } });
      expect(test.run().report.qualifiedCaseIds).not.toContain('png');
    }
  });

  it('requires all RAW variants together, maps animation separately, and excludes paired captures from ordinary JPEG intake', () => {
    expect(requiredCasesFor('dng', false)).toEqual(['dng-bayer', 'dng-linear', 'dng-proraw', 'dng-jpeg', 'dng-proraw-jxl']);
    expect(requiredCasesFor('webp', false)).toEqual(['webp-lossy', 'webp-lossless']);
    expect(requiredCasesFor('webp', true)).toEqual(['webp-lossy', 'webp-lossless', 'webp-animated']);
    expect(requiredCasesFor('jpeg', false)).toContain('jpeg-ultra-hdr-gainmap');
    expect(requiredCasesFor('jpeg', false)).not.toContain('live-photo-camera');
  });

  it('admits a consented private capture without a public URL, never as redistributable or personally attributed', () => {
    const test = fixture();
    mkdirSync(join(test.root, 'originals'));
    writeFileSync(join(test.root, 'originals', 'capture.png'), readFileSync(join(test.root, 'photo.png')));
    const provenance = {
      kind: 'consented-capture', consent: true, redistributable: false, attribution: 'release-owner',
      license: 'Private capture for Candidary release verification only; not licensed for redistribution.',
    };
    const capture = { device: 'Release test iPhone (model pinned in device evidence)', os: 'iOS (version pinned in device evidence)', settings: 'Camera Formats: High Efficiency; Live Photo off' };
    Object.assign(test.entry, { path: 'originals/capture.png', provenance, capture });
    const png = () => test.run().report;
    expect(png().structureValid).toBe(true);
    const withoutConsent: Record<string, unknown> = { ...provenance };
    delete withoutConsent.consent;
    for (const invalid of [
      { ...provenance, redistributable: true }, withoutConsent, { ...provenance, consent: false },
      { ...provenance, url: 'https://example.org/private-capture' }, { ...provenance, url: null },
      { ...provenance, attribution: 'Jane Example' }, { ...provenance, attribution: '' }, { ...provenance, license: ' ' },
      { ...provenance, kind: 'private-capture' },
    ]) {
      Object.assign(test.entry, { provenance: invalid });
      expect(png().structureValid).toBe(false);
    }
    Object.assign(test.entry, { provenance });
    Object.assign(test.entry, { path: 'photo.png' }); // Private captures stay in the ignored originals directory.
    expect(png().structureValid).toBe(false);
    for (const escaped of ['originals/../photo.png', 'originals/./../photo.png', 'originals\\..\\photo.png']) {
      Object.assign(test.entry, { path: escaped });
      expect(png().structureValid).toBe(false);
    }
    Object.assign(test.entry, { path: 'originals/capture.png', capture: { ...capture, device: 'unknown' } });
    expect(png().structureValid).toBe(false);
    Object.assign(test.entry, { capture, sha256: 'f'.repeat(64) }); // Hash pinning is unchanged for private captures.
    expect(png().cases.find((item: { id: string }) => item.id === 'png').reasons.join(' ')).toMatch(/hash/i);
  });

  it('keeps public fixtures on an https source with explicit consent', () => {
    const test = fixture();
    const provenance = { ...test.entry.provenance };
    for (const invalid of [
      { ...provenance, url: 'http://example.org/licensed-fixture' }, { ...provenance, url: undefined },
      { ...provenance, consent: false }, { ...provenance, kind: 'public' },
    ]) {
      Object.assign(test.entry, { provenance: invalid });
      expect(test.run().report.structureValid).toBe(false);
    }
  });

  it('accepts physical-device evidence only with the matching platform and complete device identity', () => {
    const test = fixture();
    const device = {
      kind: 'physical-device', harnessVersion: 1, buildFingerprint: 'b'.repeat(64), imageRef: `registry.example/decoder@sha256:${'c'.repeat(64)}`,
      platform: 'ios', deviceModel: 'iPhone (unit control)', osVersion: 'iOS (unit control)', browserName: 'Safari', browserVersion: 'unit control',
      results: [{ caseId: 'png', fixtureId: test.entry.id, sourceSha256: test.entry.sha256, status: 'pass', originalRoundTripSha256: test.entry.sha256,
        delivered: true, privatePreview: true, deleted: true }],
    };
    const iosLane = (report: object) => {
      const bytes = Buffer.from(JSON.stringify(report)); writeFileSync(join(test.root, 'device.json'), bytes);
      Object.assign(test.entry.evidence, { ios: { path: 'device.json', sha256: createHash('sha256').update(bytes).digest('hex') } });
      return test.run().report.cases.find((item: { id: string }) => item.id === 'png').fixtures[0].evidence.ios;
    };
    expect(iosLane(device)).toMatchObject({ status: 'pass' });
    for (const key of ['deviceModel', 'osVersion', 'browserName', 'browserVersion']) {
      const incomplete: Record<string, unknown> = { ...device };
      delete incomplete[key];
      expect(iosLane(incomplete)).toMatchObject({ status: 'fail', reason: expect.stringMatching(/device\/browser identity/) });
      expect(iosLane({ ...device, [key]: ' ' })).toMatchObject({ status: 'fail' });
    }
    expect(iosLane({ ...device, platform: 'android' })).toMatchObject({ status: 'fail', reason: expect.stringMatching(/identity/) });
    expect(iosLane({ ...device, kind: 'native-service' })).toMatchObject({ status: 'fail' });
  });
});

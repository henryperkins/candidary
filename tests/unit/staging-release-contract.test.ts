import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  STAGING_TARGET,
  assertCanonicalRunId,
  assertOwnedConformanceId,
  assertSafeStagingTarget,
  assertSanitizedValue,
  conformancePrefix,
  parseMode,
  parseStagingArgs,
  resolveSafeExistingInput,
} from '../../scripts/staging-release-contract';

const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const CANDIDATE_SHA = 'a'.repeat(40);
const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

describe('Task 11 staging contract', () => {
  it('accepts only the six closed modes', () => {
    for (const mode of ['probe', 'deploy', 'conform', 'cleanup', 'finalize', 'verify']) {
      expect(parseMode(mode)).toBe(mode);
    }
    expect(() => parseMode('migrate')).toThrow(/mode/u);
    expect(() => parseMode('')).toThrow(/mode/u);
  });

  it('accepts only canonical UUID run IDs and derives one private prefix', () => {
    expect(assertCanonicalRunId(RUN_ID)).toBe(RUN_ID);
    expect(conformancePrefix(RUN_ID)).toBe(`conformance/${RUN_ID}/`);
    expect(() => assertCanonicalRunId(RUN_ID.toUpperCase())).toThrow(/run ID/u);
    expect(() => assertCanonicalRunId('10000000-0000-0000-0000-000000000001')).toThrow(/run ID/u);
  });

  it('accepts only deterministic identifiers owned by the run', () => {
    expect(assertOwnedConformanceId(RUN_ID, `c11-${RUN_ID}-event-01`))
      .toBe(`c11-${RUN_ID}-event-01`);
    expect(() => assertOwnedConformanceId(RUN_ID, 'production-event')).toThrow(/run namespace/u);
    expect(() => assertOwnedConformanceId(RUN_ID, `c11-${RUN_ID}-event/01`)).toThrow(/run namespace/u);
  });

  it('pins the exact private staging topology', () => {
    expect(assertSafeStagingTarget(STAGING_TARGET)).toEqual(STAGING_TARGET);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, workerName: 'candidary' }))
      .toThrow(/production/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, databaseName: 'candidary-core' }))
      .toThrow(/production/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, bucketName: 'candidary-media' }))
      .toThrow(/production/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, workersDev: true }))
      .toThrow(/workers_dev/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, previewUrls: true }))
      .toThrow(/preview/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, routes: ['staging.example.com/*'] }))
      .toThrow(/route/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, customDomains: ['staging.example.com'] }))
      .toThrow(/domain/u);
    expect(() => assertSafeStagingTarget({ ...STAGING_TARGET, crons: ['17 3 * * *'] }))
      .toThrow(/cron/u);
  });

  it('parses a closed, duplicate-free CLI grammar', () => {
    expect(parseStagingArgs([
      'probe',
      '--candidate-sha', CANDIDATE_SHA,
      '--run-id', RUN_ID,
      '--target', 'output/staging-input/target.json',
    ])).toEqual({
      mode: 'probe',
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      targetPath: 'output/staging-input/target.json',
    });

    expect(() => parseStagingArgs([
      'probe', '--run-id', RUN_ID, '--run-id', RUN_ID,
      '--candidate-sha', CANDIDATE_SHA, '--target', 'output/staging-input/target.json',
    ])).toThrow(/duplicate/u);
    expect(() => parseStagingArgs([
      'probe', '--candidate-sha', CANDIDATE_SHA, '--run-id', RUN_ID,
      '--target', 'output/staging-input/target.json', '--remote', 'production',
    ])).toThrow(/unknown/u);
    expect(() => parseStagingArgs([
      'probe', '--candidate-sha', CANDIDATE_SHA, '--run-id', RUN_ID, '--target', '',
    ])).toThrow(/empty/u);
    expect(() => parseStagingArgs([
      'probe', '--candidate-sha', CANDIDATE_SHA, '--run-id', RUN_ID,
      '--target', '../target.json',
    ])).toThrow(/escapes|beneath/u);
    expect(() => parseStagingArgs([
      'probe', '--candidate-sha', CANDIDATE_SHA, '--run-id', RUN_ID,
    ])).toThrow(/missing/u);
  });

  it('resolves only existing, non-symlinked inputs beneath the approved root', () => {
    const root = mkdtempSync(join(tmpdir(), 'candidary-staging-contract-'));
    temporaryRoots.add(root);
    const inputRoot = join(root, 'output', 'staging-input');
    mkdirSync(inputRoot, { recursive: true });
    writeFileSync(join(inputRoot, 'target.json'), '{}\n', 'utf8');
    expect(resolveSafeExistingInput(root, 'output/staging-input/target.json'))
      .toBe(join(inputRoot, 'target.json'));

    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'target.json'), '{}\n', 'utf8');
    symlinkSync(outside, join(inputRoot, 'linked'), 'junction');
    expect(() => resolveSafeExistingInput(root, 'output/staging-input/linked/target.json'))
      .toThrow(/symlink/u);
  });

  it('rejects evidence fields and scalar values that can disclose private material', () => {
    expect(() => assertSanitizedValue({ objectKey: 'conformance/run/file.webp' }))
      .toThrow(/forbidden evidence field/u);
    expect(() => assertSanitizedValue({ url: 'https://example.invalid/private' }))
      .toThrow(/forbidden evidence field/u);
    expect(() => assertSanitizedValue({ message: 'platform detail' }))
      .toThrow(/forbidden evidence field/u);
    expect(() => assertSanitizedValue({ result: 'STAGING-CONFORMANCE-NOT-A-REAL-R2-KEY' }))
      .toThrow(/secret-shaped/u);
    expect(() => assertSanitizedValue({ result: new Uint8Array([1, 2, 3]) }))
      .toThrow(/binary/u);
    expect(() => assertSanitizedValue({ result: 'https://example.invalid/private' }))
      .toThrow(/URL/u);
    expect(assertSanitizedValue({ status: 'passed', count: 0, sha256: 'b'.repeat(64) }))
      .toBeUndefined();
  });
});

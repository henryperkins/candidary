// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../scripts/release-evidence';
import {
  assertCompleteCleanup,
  makePhaseReceipt,
  task11Root,
  verifyReceipt,
  verifyReceiptFile,
  writeExclusiveCanonical,
  writeFinalArtifact,
  writePhaseReceipt,
} from '../../scripts/staging-release-evidence';

const CANDIDATE_SHA = 'a'.repeat(40);
const RUN_ID = '1000000a-0000-4000-8000-000000000001';
const RECORDED_AT = '2026-08-10T12:00:00.000Z';
const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'candidary-staging-evidence-'));
  roots.add(root);
  return root;
}

describe('Task 11 evidence', () => {
  it('derives the run root beneath ignored operations output', () => {
    const root = temporaryRoot();
    expect(task11Root(root, CANDIDATE_SHA, RUN_ID)).toBe(join(
      root,
      'output',
      'operations',
      'event-cover',
      CANDIDATE_SHA,
      'task-11',
      RUN_ID,
    ));
  });

  it('chains every receipt to the exact canonical predecessor digest', () => {
    const probe = makePhaseReceipt({
      phase: 'probe', candidateSha: CANDIDATE_SHA, runId: RUN_ID,
      predecessorSha256: null, recordedAt: RECORDED_AT,
      result: { outcome: 'complete', discriminator: 'code-10091' },
    });
    const probeSha = sha256(`${canonicalJson(probe)}\n`);
    const deploy = makePhaseReceipt({
      phase: 'deploy', candidateSha: CANDIDATE_SHA, runId: RUN_ID,
      predecessorSha256: probeSha, recordedAt: RECORDED_AT,
      result: { outcome: 'complete', migrationCount: 13 },
    });

    expect(verifyReceipt(probe, null).sha256).toBe(probeSha);
    expect(verifyReceipt(deploy, probeSha).receipt.phase).toBe('deploy');
    expect(() => verifyReceipt(deploy, '0'.repeat(64))).toThrow(/predecessor/u);
  });

  it('writes canonical bytes and a matching sidecar exclusively', () => {
    const root = temporaryRoot();
    const path = join(root, 'artifact.json');
    const value = { status: 'partial', candidateSha: CANDIDATE_SHA };
    const digest = writeExclusiveCanonical(path, value);

    const bytes = readFileSync(path, 'utf8');
    expect(bytes).toBe(`${canonicalJson(value)}\n`);
    expect(digest).toBe(sha256(bytes));
    expect(readFileSync(`${path}.sha256`, 'utf8')).toBe(`${digest}  artifact.json\n`);
    expect(() => writeExclusiveCanonical(path, { status: 'failed' })).toThrow(/exists/u);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('writes numbered phase receipts and verifies their files from disk', () => {
    const root = temporaryRoot();
    const receipt = makePhaseReceipt({
      phase: 'probe', candidateSha: CANDIDATE_SHA, runId: RUN_ID,
      predecessorSha256: null, recordedAt: RECORDED_AT,
      result: { outcome: 'complete' },
    });
    const written = writePhaseReceipt(root, 1, receipt);
    expect(written.path).toBe(join(root, '01-probe.json'));
    expect(verifyReceiptFile(written.path, null).sha256).toBe(written.sha256);

    writeFileSync(written.path, '{}\n', 'utf8');
    expect(() => verifyReceiptFile(written.path, null)).toThrow(/sidecar|schema|candidate/u);
  });

  it('rejects private fields and values before creating any file', () => {
    const root = temporaryRoot();
    const path = join(root, 'bad.json');
    expect(() => writeExclusiveCanonical(path, { objectKey: 'events/private/file.webp' }))
      .toThrow(/forbidden evidence field/u);
    expect(() => writeExclusiveCanonical(path, { result: 'https://example.invalid/private' }))
      .toThrow(/URL/u);
    expect(() => writeExclusiveCanonical(path, { result: 'token=private' }))
      .toThrow(/secret-shaped/u);
    expect(() => readFileSync(path)).toThrow();
  });

  it('refuses a passing final artifact until every cleanup observation is true', () => {
    const completeCleanup = {
      fixturesAbsent: true,
      workerAbsent: true,
      databaseAbsent: true,
      bucketAbsent: true,
      workflowsAbsent: true,
      callersAbsent: true,
      probeAbsent: true,
    } as const;
    expect(assertCompleteCleanup(completeCleanup)).toEqual(completeCleanup);
    expect(() => assertCompleteCleanup({ ...completeCleanup, bucketAbsent: false }))
      .toThrow(/bucketAbsent/u);

    const root = temporaryRoot();
    const path = join(root, 'staging-conformance.json');
    const artifact = {
      schemaVersion: 1,
      status: 'passed',
      candidateSha: CANDIDATE_SHA,
      runId: RUN_ID,
      cleanup: completeCleanup,
      receiptSha256: 'b'.repeat(64),
    } as const;
    const written = writeFinalArtifact(path, artifact);
    expect(written.sha256).toBe(sha256(readFileSync(path)));
    expect(() => writeFinalArtifact(join(root, 'second.json'), {
      ...artifact,
      cleanup: { ...completeCleanup, workerAbsent: false },
    })).toThrow(/workerAbsent/u);
  });
});

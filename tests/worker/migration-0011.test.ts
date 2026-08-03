import { beforeEach, describe, expect, it } from 'vitest';

import { resetDatabase, testEnv } from './helpers';

interface StoredCertificationInput {
  workerVersionId: string | null;
  buildSha: string;
  guestJourneyVersion: number;
  migrationManifestSha256: string;
  evidenceManifestSha256: string;
  physicalEvidenceRefsJson: string;
  certifiedAt: string;
}

const valid: StoredCertificationInput = {
  workerVersionId: 'candidary-worker-v1',
  buildSha: '0123456789abcdef0123456789abcdef01234567',
  guestJourneyVersion: 1,
  migrationManifestSha256: 'a'.repeat(64),
  evidenceManifestSha256: 'b'.repeat(64),
  physicalEvidenceRefsJson: JSON.stringify([{
    category: 'printed-entry-ios',
    evidenceId: '11111111-1111-4111-8111-111111111111',
    manifestSha256: 'c'.repeat(64),
    capturedAt: '2026-08-02T12:34:56.789Z',
  }]),
  certifiedAt: '2026-08-02T13:00:00.000Z',
};

function insert(input: StoredCertificationInput) {
  return testEnv.DB.prepare(`
    INSERT INTO release_certifications (
      worker_version_id,
      build_sha,
      guest_journey_version,
      migration_manifest_sha256,
      evidence_manifest_sha256,
      physical_evidence_refs_json,
      certified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.workerVersionId,
    input.buildSha,
    input.guestJourneyVersion,
    input.migrationManifestSha256,
    input.evidenceManifestSha256,
    input.physicalEvidenceRefsJson,
    input.certifiedAt,
  ).run();
}

beforeEach(resetDatabase);

describe('migration 0011', () => {
  // Production break caught: the additive schema cannot persist its one valid canonical row shape.
  it('accepts a valid release certification row', async () => {
    await insert(valid);

    expect(await testEnv.DB.prepare(`
      SELECT COUNT(*) AS count FROM release_certifications
    `).first<number>('count')).toBe(1);
  });

  // Production break caught: the primary Worker version identity is nullable or can be certified twice.
  it.each([
    ['duplicate Worker version ID', { workerVersionId: valid.workerVersionId }, true],
    ['null Worker version ID', { workerVersionId: null }, false],
  ] as const)('rejects a %s', async (_label, override, seedFirst) => {
    if (seedFirst) await insert(valid);
    await expect(insert({ ...valid, ...override })).rejects.toThrow();
  });

  // Production break caught: non-canonical Git SHA values bypass the storage boundary.
  it.each([
    ['uppercase', '0123456789ABCDEF0123456789ABCDEF01234567'],
    ['short', '0123456789abcdef'],
  ])('rejects a %s build SHA', async (_label, buildSha) => {
    await expect(insert({ ...valid, buildSha })).rejects.toThrow();
  });

  // Production break caught: non-canonical SHA-256 values enter either stored manifest column.
  it.each([
    ['uppercase migration', { migrationManifestSha256: 'A'.repeat(64) }],
    ['short migration', { migrationManifestSha256: 'a'.repeat(63) }],
    ['uppercase evidence', { evidenceManifestSha256: 'B'.repeat(64) }],
    ['short evidence', { evidenceManifestSha256: 'b'.repeat(63) }],
  ])('rejects a %s digest', async (_label, override) => {
    await expect(insert({ ...valid, ...override })).rejects.toThrow();
  });

  // Production break caught: zero or fractional journey versions are stored as release dimensions.
  it.each([
    ['zero', 0],
    ['fractional', 1.5],
  ])('rejects a %s guest journey version', async (_label, guestJourneyVersion) => {
    await expect(insert({ ...valid, guestJourneyVersion })).rejects.toThrow();
  });

  // Production break caught: blank or padded Worker IDs are normalized by callers after storage.
  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['left-padded', ' candidary-worker-v1'],
    ['right-padded', 'candidary-worker-v1 '],
  ])('rejects a %s Worker version ID', async (_label, workerVersionId) => {
    await expect(insert({ ...valid, workerVersionId })).rejects.toThrow();
  });

  // Production break caught: malformed, non-array, empty, or oversized evidence JSON bypasses the table checks.
  it.each([
    ['invalid', '{'],
    ['non-array', '{}'],
    ['empty', '[]'],
    ['oversized', JSON.stringify(['x'.repeat(32_768)])],
  ])('rejects %s physical evidence JSON', async (_label, physicalEvidenceRefsJson) => {
    await expect(insert({ ...valid, physicalEvidenceRefsJson })).rejects.toThrow();
  });

  // Production break caught: a timestamp that is not the exact millisecond UTC form enters certification storage.
  it.each([
    ['missing milliseconds', '2026-08-02T13:00:00Z'],
    ['offset', '2026-08-02T08:00:00.000-05:00'],
    ['malformed', 'not-a-timestamp'],
  ])('rejects a %s certification timestamp', async (_label, certifiedAt) => {
    await expect(insert({ ...valid, certifiedAt })).rejects.toThrow();
  });
});

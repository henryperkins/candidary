import { beforeEach, describe, expect, it } from 'vitest';

import type { ReleaseCertification, RuntimeReleaseIdentity } from '../../shared/release';
import { ReleaseCertificationsRepository } from '../../worker/db/release-certifications';
import { resetDatabase, testEnv } from './helpers';

const certification: ReleaseCertification = {
  buildSha: '0123456789abcdef0123456789abcdef01234567',
  workerVersionId: 'candidary-worker-v1',
  guestJourneyVersion: 1,
  migrationManifestSha256: 'a'.repeat(64),
  evidenceManifestSha256: 'b'.repeat(64),
  physicalEvidenceRefs: [{
    category: 'printed-entry-ios',
    evidenceId: '11111111-1111-4111-8111-111111111111',
    manifestSha256: 'c'.repeat(64),
    capturedAt: '2026-08-02T12:34:56.789Z',
  }],
  certifiedAt: '2026-08-02T13:00:00.000Z',
};

const identity: RuntimeReleaseIdentity = {
  buildSha: certification.buildSha,
  workerVersionId: certification.workerVersionId,
  guestJourneyVersion: certification.guestJourneyVersion,
  migrationManifestSha256: certification.migrationManifestSha256,
};

beforeEach(resetDatabase);

describe('ReleaseCertificationsRepository', () => {
  // Production break caught: insert persists a raw manifest or wrapper instead of only the strict reference array.
  it('inserts a parsed certification and serializes only its physical references', async () => {
    const repository = new ReleaseCertificationsRepository(testEnv.DB);
    await repository.insert(certification);

    const row = await testEnv.DB.prepare(`
      SELECT physical_evidence_refs_json FROM release_certifications
      WHERE worker_version_id = ?
    `).bind(certification.workerVersionId).first<{ physical_evidence_refs_json: string }>();

    expect(row).not.toBeNull();
    if (!row) throw new Error('Expected the inserted certification row.');
    expect(JSON.parse(row.physical_evidence_refs_json)).toEqual([{
      category: 'printed-entry-ios',
      evidenceId: '11111111-1111-4111-8111-111111111111',
      manifestSha256: 'c'.repeat(64),
      capturedAt: '2026-08-02T12:34:56.789Z',
    }]);
  });

  // Production break caught: an exact four-dimensional runtime identity cannot retrieve its stored certification.
  it('finds a certification by its exact runtime identity', async () => {
    const repository = new ReleaseCertificationsRepository(testEnv.DB);
    await repository.insert(certification);

    expect(await repository.findExact(identity)).toEqual(certification);
  });

  // Production break caught: any one mismatched runtime dimension can retrieve a certification for another release.
  it.each([
    ['Worker version ID', { workerVersionId: 'different-worker-version' }],
    ['build SHA', { buildSha: 'fedcba9876543210fedcba9876543210fedcba98' }],
    ['guest journey version', { guestJourneyVersion: 2 }],
    ['migration digest', { migrationManifestSha256: 'd'.repeat(64) }],
  ])('does not find a certification with a mismatched %s', async (_label, override) => {
    const repository = new ReleaseCertificationsRepository(testEnv.DB);
    await repository.insert(certification);

    expect(await repository.findExact({ ...identity, ...override })).toBeNull();
  });

  // Production break caught: a row that passes SQL checks but violates the shared redacted parser is trusted.
  it('fails closed when a stored row cannot pass the shared parser', async () => {
    await testEnv.DB.prepare(`
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
      certification.workerVersionId,
      certification.buildSha,
      certification.guestJourneyVersion,
      certification.migrationManifestSha256,
      certification.evidenceManifestSha256,
      JSON.stringify([{
        ...certification.physicalEvidenceRefs[0],
        device: 'unredacted personal device',
      }]),
      certification.certifiedAt,
    ).run();

    const repository = new ReleaseCertificationsRepository(testEnv.DB);
    expect(await repository.findExact(identity)).toBeNull();
  });
});

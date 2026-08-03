import {
  parseReleaseCertification,
  type ReleaseCertification,
  type RuntimeReleaseIdentity,
} from '../../shared/release';
import type { ReleaseCertificationRow } from './types';

export class ReleaseCertificationsRepository {
  constructor(private readonly db: D1Database) {}

  async insert(record: ReleaseCertification): Promise<void> {
    await this.db.prepare(`
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
      record.workerVersionId,
      record.buildSha,
      record.guestJourneyVersion,
      record.migrationManifestSha256,
      record.evidenceManifestSha256,
      JSON.stringify(record.physicalEvidenceRefs),
      record.certifiedAt,
    ).run();
  }

  async findExact(identity: RuntimeReleaseIdentity): Promise<ReleaseCertification | null> {
    const row = await this.db.prepare(`
      SELECT
        worker_version_id,
        build_sha,
        guest_journey_version,
        migration_manifest_sha256,
        evidence_manifest_sha256,
        physical_evidence_refs_json,
        certified_at
      FROM release_certifications
      WHERE worker_version_id = ?
        AND build_sha = ?
        AND guest_journey_version = ?
        AND migration_manifest_sha256 = ?
    `).bind(
      identity.workerVersionId,
      identity.buildSha,
      identity.guestJourneyVersion,
      identity.migrationManifestSha256,
    ).first<ReleaseCertificationRow>();
    if (!row) return null;

    let physicalEvidenceRefs: unknown;
    try {
      physicalEvidenceRefs = JSON.parse(row.physical_evidence_refs_json);
    } catch {
      return null;
    }

    return parseReleaseCertification({
      buildSha: row.build_sha,
      workerVersionId: row.worker_version_id,
      guestJourneyVersion: row.guest_journey_version,
      migrationManifestSha256: row.migration_manifest_sha256,
      evidenceManifestSha256: row.evidence_manifest_sha256,
      physicalEvidenceRefs,
      certifiedAt: row.certified_at,
    });
  }
}

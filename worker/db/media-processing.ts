import { parseDecoderInspection, type DecoderFailureCode, type DecoderInspection } from '../../shared/image-decoder-contract';
import { authorityLivenessBindings, authorityLivenessSql, intakePredicateSql } from './media';
import type { TransferIdentity, WriteClaim } from './upload-transfers';

/** Native proof is recorded only against the current durable completion claim. */
export class MediaProcessingRepository {
  constructor(private readonly db: D1Database) {}

  async recordInspection(identity: TransferIdentity, claim: WriteClaim, proof: DecoderInspection, now: string): Promise<boolean> {
    parseDecoderInspection(proof);
    const result = await this.db.prepare(`INSERT INTO media_processing
      (media_id,transfer_id,generation,attempt,state,actual_family,width,height,frame_count,is_sequence,source_sha256,byte_size,build_fingerprint,preview_profile,updated_at)
      SELECT t.media_id,t.id,t.generation,t.attempt,'ready',?,?,?,?,?,?,?,?,?,? FROM media_upload_transfers t
      JOIN media m ON m.id = t.media_id JOIN events e ON e.id = t.event_id
      WHERE t.id = ? AND t.media_id = ? AND t.event_id = ? AND t.generation = ? AND t.attempt = ? AND t.completion_token = ?
        AND t.completion_lease_expires_at > ? AND t.expires_at > ? AND t.hard_expires_at > ? AND t.state = 'processing'
        AND t.build_fingerprint = ? AND t.byte_size = ? AND m.upload_state = 'reserved' AND m.deleted_at IS NULL AND e.deleted_at IS NULL
        AND (t.family = ? OR (t.family = 'heif' AND ? = 'heic')) AND (t.requires_sequence = 0 OR ? = 1)
        AND ${authorityLivenessSql(identity.authority)} AND ${intakePredicateSql(identity.authority)}
      ON CONFLICT (media_id) DO UPDATE SET state = excluded.state,actual_family = excluded.actual_family,width = excluded.width,height = excluded.height,
        frame_count = excluded.frame_count,is_sequence = excluded.is_sequence,source_sha256 = excluded.source_sha256,byte_size = excluded.byte_size,
        build_fingerprint = excluded.build_fingerprint,preview_profile = excluded.preview_profile,failure_code = NULL,updated_at = excluded.updated_at
      WHERE media_processing.transfer_id = excluded.transfer_id AND media_processing.generation = excluded.generation AND media_processing.attempt = excluded.attempt
        AND media_processing.state <> 'suppressed' AND (media_processing.source_sha256 IS NULL OR media_processing.source_sha256 = excluded.source_sha256)`)
      .bind(proof.family,proof.width,proof.height,proof.frameCount,proof.isSequence ? 1 : 0,proof.sourceSha256,proof.byteSize,proof.buildFingerprint,proof.previewProfile,now,
        identity.transferId,identity.mediaId,identity.eventId,claim.generation,claim.attempt,claim.token,now,now,now,proof.buildFingerprint,proof.byteSize,
        proof.family,proof.family,proof.isSequence ? 1 : 0,...authorityLivenessBindings(identity.authority,identity.eventId,now),now).run();
    return result.meta.changes === 1;
  }

  async recordFailure(identity: TransferIdentity, claim: WriteClaim, failure: DecoderFailureCode, now: string): Promise<boolean> {
    const state = failure === 'busy' || failure === 'unavailable' ? 'unavailable' : 'unsupported';
    const result = await this.db.prepare(`INSERT INTO media_processing (media_id,transfer_id,generation,attempt,state,failure_code,updated_at)
      SELECT media_id,id,generation,attempt,?,?,? FROM media_upload_transfers WHERE id = ? AND media_id = ? AND event_id = ?
        AND generation = ? AND attempt = ? AND completion_token = ? AND state = 'processing' AND completion_lease_expires_at > ?
      ON CONFLICT (media_id) DO UPDATE SET state = excluded.state,failure_code = excluded.failure_code,updated_at = excluded.updated_at
      WHERE media_processing.generation = excluded.generation AND media_processing.attempt = excluded.attempt AND media_processing.state <> 'suppressed'`)
      .bind(state,failure,now,identity.transferId,identity.mediaId,identity.eventId,claim.generation,claim.attempt,claim.token,now).run();
    return result.meta.changes === 1;
  }
}

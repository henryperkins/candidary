import { resolveImageDeclaration, type ImageDeclaration } from '../../shared/image-formats';
import type { UploadAuthority } from '../services/upload-authority';
import { authorityLivenessBindings, authorityLivenessSql, intakePredicateSql } from './media';

import type { PreviewState, TransferState, UploadTransferView } from '../../shared/mobile-image-contract';
export type { PreviewState, TransferState } from '../../shared/mobile-image-contract';
export type TransferIdentity = { transferId: string; mediaId: string; eventId: string; authority: UploadAuthority };
export type PartProof = { index: number; byteSize: number; sha256: string };
export type WriteClaim = { token: string; generation: number; attempt: number; leaseExpiresAt: string };
export type TransferRecord = TransferIdentity & {
  declared: ImageDeclaration; byteSize: number; partBytes: number; partCount: number; state: TransferState;
  generation: number; attempt: number; expiresAt: string; hardExpiresAt: string; acceptedParts: number[];
  previewState: PreviewState; buildFingerprint: string; admissionCase: string;
};
export type TransferOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'forbidden' | 'conflict' | 'expired' };
export const UPLOAD_PART_BYTES = 8 * 1024 ** 2;
const MAX_BYTES = 512 * 1024 ** 2;
const WRITER_LEASE_MS = 180_000;
const SHA = /^[0-9a-f]{64}$/u;
const activeStates = ['receiving', 'processing', 'retryable'];
export function transferWindowSeconds(byteSize: number): number { return Math.max(900, Math.min(7200, Math.ceil(byteSize / 125_000) + 600)); }
export function uploadTransferView(transfer: TransferRecord): UploadTransferView {
  return {id:transfer.transferId,mediaId:transfer.mediaId,state:transfer.state,partBytes:transfer.partBytes,partCount:transfer.partCount,
    acceptedParts:[...transfer.acceptedParts],expiresAt:transfer.expiresAt,hardExpiresAt:transfer.hardExpiresAt,previewState:transfer.previewState};
}
function addSeconds(now: string, seconds: number): string { return new Date(Date.parse(now) + seconds * 1000).toISOString(); }
const conflict = { ok: false, reason: 'conflict' } as const;
const forbidden = { ok: false, reason: 'forbidden' } as const;

interface TransferRow {
  id: string; media_id: string; event_id: string; authority_kind: UploadAuthority['kind']; actor_session_id: string;
  event_session_id: string | null; host_session_id: string | null; account_id: string | null;
  family: ImageDeclaration['family']; mime_type: string; requires_sequence: number; byte_size: number; part_bytes: number;
  part_count: number; generation: number; attempt: number; state: TransferState; expires_at: string; hard_expires_at: string;
  build_fingerprint: string; admission_case: string; completion_token: string | null; completion_lease_expires_at: string | null;
}
export interface UploadAssembly {
  id: string; transferId: string; attempt: number; generation: number; objectKey: string;
  uploadId: string | null; state: 'creating' | 'receiving' | 'completing' | 'completed' | 'suppressed' | 'absent';
}
export type CompletionWork = {transfer:TransferRecord;claim:WriteClaim;assembly:UploadAssembly & {
  completedEtag:string|null;expectedSha256:string|null;writerSettledAt:string|null;
}};

function rowIdentity(row: TransferRow): TransferIdentity {
  const authority: UploadAuthority = row.authority_kind === 'manager-account'
    ? {kind:row.authority_kind,actorSessionId:row.actor_session_id,hostSessionId:row.host_session_id!,accountId:row.account_id!}
    : {kind:row.authority_kind,actorSessionId:row.actor_session_id,eventSessionId:row.event_session_id!};
  return {transferId:row.id,mediaId:row.media_id,eventId:row.event_id,authority};
}

/** SQL authorization is repeated by every mutation, after any caller's reads. */
function owner(identity: TransferIdentity, now: string, writable = false) {
  const a = identity.authority;
  const sql = `t.id = ? AND t.media_id = ? AND t.event_id = ? AND t.authority_kind = ? AND t.actor_session_id = ?
    AND t.event_session_id IS ? AND t.host_session_id IS ? AND t.account_id IS ?
    AND ${authorityLivenessSql(a)}${writable ? `
    AND t.expires_at > ? AND t.hard_expires_at > ?
    AND EXISTS (SELECT 1 FROM media m JOIN events e ON e.id = m.event_id
      WHERE m.id = t.media_id AND m.event_id = t.event_id AND m.upload_state = 'reserved' AND m.deleted_at IS NULL
        AND e.deleted_at IS NULL AND ${intakePredicateSql(a)})` : ''}`;
  const bindings: unknown[] = [identity.transferId, identity.mediaId, identity.eventId, a.kind, a.actorSessionId,
    a.kind === 'manager-account' ? null : a.eventSessionId, a.kind === 'manager-account' ? a.hostSessionId : null,
    a.kind === 'manager-account' ? a.accountId : null, ...authorityLivenessBindings(a, identity.eventId, now)];
  if (writable) bindings.push(now, now, now);
  return { sql, bindings };
}

export class UploadTransferRepository {
  constructor(private readonly db: D1Database, private readonly qualification?: { buildFingerprint: string; caseId: string }) {}

  async findId(mediaId: string): Promise<string | null> {
    return this.db.prepare('SELECT id FROM media_upload_transfers WHERE media_id = ?').bind(mediaId).first<string>('id');
  }

  async getWritable(identity: TransferIdentity, now: string): Promise<TransferOutcome<TransferRecord>> {
    const current = await this.getOwned(identity,now); if (!current.ok) return current;
    const scope = owner(identity,now,true);
    const live = await this.db.prepare(`SELECT t.id FROM media_upload_transfers t WHERE ${scope.sql} AND t.state IN ('receiving','processing','retryable')`).bind(...scope.bindings).first();
    return live ? current : conflict;
  }

  async fenceIfUnwritable(identity: TransferIdentity, now: string): Promise<boolean> {
    const scope = owner(identity,now,true);
    const result = await this.db.prepare(`UPDATE media_upload_transfers SET
      state=CASE WHEN expires_at<=? OR hard_expires_at<=? THEN 'expired' ELSE 'aborted' END,
      generation=generation+1,completion_token=NULL,completion_lease_expires_at=NULL,updated_at=?
      WHERE id=? AND state IN ('receiving','processing','retryable')
        AND NOT EXISTS (SELECT 1 FROM media_upload_transfers t WHERE ${scope.sql}) RETURNING id`)
      .bind(now,now,now,identity.transferId,...scope.bindings).run();
    return result.results.length === 1;
  }

  async getOwned(identity: TransferIdentity, now: string): Promise<TransferOutcome<TransferRecord>> {
    const scope = owner(identity, now);
    const row = await this.db.prepare(`SELECT t.* FROM media_upload_transfers t WHERE ${scope.sql}`).bind(...scope.bindings).first<TransferRow>();
    if (!row) return forbidden;
    if (activeStates.includes(row.state) && (row.expires_at <= now || row.hard_expires_at <= now)) return { ok: false, reason: 'expired' };
    const parts = await this.db.prepare("SELECT part_index FROM media_upload_parts WHERE transfer_id = ? AND state = 'accepted' AND generation = ? AND attempt = ? ORDER BY part_index").bind(row.id,row.generation,row.attempt).all<{ part_index: number }>();
    const preview = await this.db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM media_image_previews p WHERE p.media_id = media_processing.media_id
      AND p.source_sha256 = media_processing.source_sha256 AND p.profile = media_processing.preview_profile AND p.state = 'ready') THEN 'ready'
      WHEN state = 'ready' THEN 'pending' ELSE state END AS state FROM media_processing WHERE media_id = ?`).bind(row.media_id).first<{ state: string }>();
    return { ok: true, value: { ...identity, declared: { family: row.family, mimeType: row.mime_type, requiresSequence: row.requires_sequence === 1 },
      byteSize:row.byte_size,partBytes:row.part_bytes,partCount:row.part_count,state:row.state,generation:row.generation,attempt:row.attempt,
      expiresAt:row.expires_at,hardExpiresAt:row.hard_expires_at,acceptedParts:parts.results.map((part) => part.part_index),
      previewState: preview?.state === 'ready' ? 'ready' : preview?.state === 'unsupported' ? 'unsupported' : preview?.state === 'unavailable' || preview?.state === 'suppressed' ? 'unavailable' : 'pending',
      buildFingerprint:row.build_fingerprint,admissionCase:row.admission_case } };
  }

  async initiate(input: TransferIdentity & { declared: ImageDeclaration; byteSize: number; now: string }): Promise<TransferOutcome<TransferRecord>> {
    const q = this.qualification;
    const declared = resolveImageDeclaration('', input.declared.mimeType);
    if (!q || !SHA.test(q.buildFingerprint) || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_BYTES
      || !declared || declared.family !== input.declared.family || declared.requiresSequence !== input.declared.requiresSequence) return conflict;
    const a = input.authority;
    const expiry = await this.db.prepare(`SELECT min(s.expires_at, token.expires_at, e.${a.kind === 'guest' ? 'guest' : 'management'}_access_expires_at${a.kind === 'manager-account' ? ', h.expires_at' : ''}) AS expires_at
      FROM event_sessions s JOIN event_access_tokens token ON token.id = s.access_token_id JOIN events e ON e.id = s.event_id
      ${a.kind === 'manager-account' ? 'JOIN host_sessions h ON h.id = ?' : ''}
      WHERE s.id = ? AND e.id = ? AND ${authorityLivenessSql(a)} AND ${intakePredicateSql(a)}`)
      .bind(...(a.kind === 'manager-account' ? [a.hostSessionId] : []),a.actorSessionId,input.eventId,...authorityLivenessBindings(a,input.eventId,input.now),input.now).first<{ expires_at: string }>();
    if (!expiry) return forbidden;
    const hard = [addSeconds(input.now, 6 * 3600),expiry.expires_at].sort()[0]!;
    const expires = [addSeconds(input.now,transferWindowSeconds(input.byteSize)),hard].sort()[0]!;
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO media_upload_transfers
        (id,media_id,event_id,authority_kind,actor_session_id,event_session_id,host_session_id,account_id,family,mime_type,requires_sequence,byte_size,part_bytes,part_count,initial_expires_at,expires_at,hard_expires_at,build_fingerprint,admission_case,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${authorityLivenessSql(a)}
          AND EXISTS (SELECT 1 FROM events WHERE id = ? AND deleted_at IS NULL AND ${intakePredicateSql(a)})
          AND EXISTS (SELECT 1 FROM media WHERE id = ? AND event_id = ? AND uploader_session_id = ? AND upload_state = 'reserved' AND deleted_at IS NULL)
          AND EXISTS (SELECT 1 FROM mobile_image_admission WHERE case_id = ? AND enabled = 1 AND max_original_bytes >= ?)
        ON CONFLICT DO NOTHING`).bind(input.transferId,input.mediaId,input.eventId,a.kind,a.actorSessionId,a.kind === 'manager-account' ? null : a.eventSessionId,
        a.kind === 'manager-account' ? a.hostSessionId : null,a.kind === 'manager-account' ? a.accountId : null,declared.family,declared.mimeType,declared.requiresSequence ? 1 : 0,input.byteSize,UPLOAD_PART_BYTES,Math.ceil(input.byteSize/UPLOAD_PART_BYTES),expires,expires,hard,q.buildFingerprint,q.caseId,input.now,input.now,
        ...authorityLivenessBindings(a,input.eventId,input.now),input.eventId,input.now,input.mediaId,input.eventId,a.actorSessionId,q.caseId,input.byteSize),
      ...this.extendReservationStatements(input.transferId),
    ]);
    const current = await this.getOwned(input,input.now);
    if (!current.ok) return results[0]?.meta.changes ? current : conflict;
    if (current.value.byteSize !== input.byteSize || current.value.declared.mimeType !== declared.mimeType || current.value.buildFingerprint !== q.buildFingerprint || current.value.admissionCase !== q.caseId) return conflict;
    return current;
  }

  private extendReservationStatements(transferId: string): D1PreparedStatement[] {
    // The pending promotion capability must advance before its media reservation.
    return [this.db.prepare(`UPDATE media_object_promotions SET source_writable_until = max(source_writable_until,
      (SELECT expires_at FROM media_upload_transfers WHERE id = ?)) WHERE (state = 'pending' OR (state = 'copying' AND source_etag LIKE 'assembly:%'))
      AND media_id = (SELECT media_id FROM media_upload_transfers WHERE id = ? AND state IN ('receiving','processing','retryable'))`).bind(transferId,transferId),
    this.db.prepare(`UPDATE media SET reservation_expires_at = max(reservation_expires_at,(SELECT expires_at FROM media_upload_transfers WHERE id = ?))
      WHERE upload_state = 'reserved' AND deleted_at IS NULL AND id = (SELECT media_id FROM media_upload_transfers WHERE id = ? AND state IN ('receiving','processing','retryable'))`).bind(transferId,transferId)];
  }

  async claimPart(identity: TransferIdentity, proof: PartProof, now: string): Promise<TransferOutcome<{ alreadyAccepted: true } | { alreadyAccepted: false; claim: WriteClaim }>> {
    if (!Number.isSafeInteger(proof.index) || proof.index < 0 || !Number.isSafeInteger(proof.byteSize) || proof.byteSize < 1 || !SHA.test(proof.sha256)) return conflict;
    const current = await this.getWritable(identity,now);
    if (!current.ok) return current;
    const t = current.value;
    if (t.state !== 'receiving' || proof.index >= t.partCount || proof.byteSize !== Math.min(t.partBytes,t.byteSize - proof.index*t.partBytes)) return conflict;
    const existing = await this.db.prepare('SELECT * FROM media_upload_parts WHERE transfer_id = ? AND part_index = ?').bind(identity.transferId,proof.index).first<{sha256:string;byte_size:number;state:string;generation:number;attempt:number}>();
    if (existing && (existing.sha256 !== proof.sha256 || existing.byte_size !== proof.byteSize)) return conflict;
    if (existing?.state === 'accepted' && existing.generation === t.generation && existing.attempt === t.attempt) return {ok:true,value:{alreadyAccepted:true}};
    const claim = {token:crypto.randomUUID(),generation:t.generation,attempt:t.attempt,leaseExpiresAt:[new Date(Date.parse(now)+WRITER_LEASE_MS).toISOString(),t.hardExpiresAt].sort()[0]!};
    const scope = owner(identity,now,true);
    const result = await this.db.prepare(`INSERT INTO media_upload_parts
      (transfer_id,part_index,byte_size,sha256,part_number,claim_token,generation,attempt,state,writer_lease_expires_at,created_at,updated_at)
      SELECT t.id,?,?,?,?,?,?,?,'writing',?,?,? FROM media_upload_transfers t WHERE ${scope.sql} AND t.state = 'receiving' AND t.generation = ? AND t.attempt = ?
      ON CONFLICT (transfer_id,part_index) DO UPDATE SET claim_token = excluded.claim_token, generation = excluded.generation, attempt = excluded.attempt,
        writer_lease_expires_at = excluded.writer_lease_expires_at, writer_settled_at = NULL, updated_at = excluded.updated_at
      WHERE media_upload_parts.state = 'writing' AND media_upload_parts.sha256 = excluded.sha256 AND media_upload_parts.byte_size = excluded.byte_size
        AND media_upload_parts.writer_settled_at IS NOT NULL AND media_upload_parts.writer_lease_expires_at <= excluded.updated_at`)
      .bind(proof.index,proof.byteSize,proof.sha256,proof.index+1,claim.token,claim.generation,claim.attempt,claim.leaseExpiresAt,now,now,...scope.bindings,t.generation,t.attempt).run();
    return result.meta.changes === 1 ? {ok:true,value:{alreadyAccepted:false,claim}} : conflict;
  }

  async acceptPart(identity: TransferIdentity, proof: PartProof, claim: WriteClaim, etag: string, now: string): Promise<TransferOutcome<null>> {
    if (!etag || etag.length > 256) return conflict;
    const current = await this.getOwned(identity,now);
    if (!current.ok) return current;
    const scope = owner(identity,now,true);
    const results = await this.db.batch([
      this.db.prepare(`UPDATE media_upload_parts SET state = 'accepted', etag = ?, writer_settled_at = ?, updated_at = ?
        WHERE transfer_id = ? AND part_index = ? AND sha256 = ? AND byte_size = ? AND claim_token = ? AND generation = ? AND attempt = ?
          AND state IN ('writing','accepted') AND (etag IS NULL OR etag = ?) AND writer_lease_expires_at > ?
          AND EXISTS (SELECT 1 FROM media_upload_transfers t WHERE ${scope.sql} AND t.state = 'receiving' AND t.generation = ? AND t.attempt = ?)`)
        .bind(etag,now,now,identity.transferId,proof.index,proof.sha256,proof.byteSize,claim.token,claim.generation,claim.attempt,etag,now,...scope.bindings,claim.generation,claim.attempt),
      this.db.prepare(`UPDATE media_upload_transfers SET expires_at = min(hard_expires_at,max(expires_at,?)), updated_at = ? WHERE id = ? AND changes() = 1 AND state = 'receiving'`)
        .bind(addSeconds(now,transferWindowSeconds(current.value.byteSize)),now,identity.transferId),
      ...this.extendReservationStatements(identity.transferId),
    ]);
    return results[0]?.meta.changes === 1 ? {ok:true,value:null} : conflict;
  }

  async createAssemblyIntent(identity: TransferIdentity, now: string): Promise<TransferOutcome<UploadAssembly>> {
    const current = await this.getOwned(identity,now); if (!current.ok) return current;
    const t = current.value;
    if (t.state !== 'receiving') return conflict;
    const id = crypto.randomUUID();
    const key = `events/${t.eventId}/media/assemblies/${t.mediaId}/${t.transferId}/${t.attempt}/${id}`;
    const scope = owner(identity,now,true);
    await this.db.prepare(`INSERT INTO media_upload_assemblies (id,transfer_id,attempt,generation,object_key,create_intent_at,state,expected_byte_size,updated_at)
      SELECT ?,t.id,t.attempt,t.generation,?,?,'creating',t.byte_size,? FROM media_upload_transfers t WHERE ${scope.sql} AND t.state = 'receiving' AND t.generation = ? AND t.attempt = ?
      ON CONFLICT (transfer_id,attempt) DO NOTHING`).bind(id,key,now,now,...scope.bindings,t.generation,t.attempt).run();
    const row = await this.db.prepare('SELECT * FROM media_upload_assemblies WHERE transfer_id = ? AND attempt = ?').bind(t.transferId,t.attempt).first<{id:string;object_key:string;multipart_upload_id:string|null;state:UploadAssembly['state'];generation:number}>();
    return row && row.generation === t.generation ? {ok:true,value:{id:row.id,transferId:t.transferId,attempt:t.attempt,generation:row.generation,objectKey:row.object_key,uploadId:row.multipart_upload_id,state:row.state}} : conflict;
  }

  /** Always retain a late create's upload ID, even after a deletion fence. */
  async recordAssemblyCreated(assembly: UploadAssembly, uploadId: string, now: string): Promise<boolean> {
    if (!uploadId || uploadId.length > 2048) return false;
    const result = await this.db.prepare(`UPDATE media_upload_assemblies SET multipart_upload_id = ?, create_settled_at = COALESCE(create_settled_at,?),
      writer_settled_at = CASE WHEN create_settled_at IS NULL THEN ? ELSE writer_settled_at END, updated_at = ?,
      state = CASE WHEN state = 'creating' THEN 'receiving' ELSE state END
      WHERE id = ? AND transfer_id = ? AND attempt = ? AND generation = ? AND object_key = ? AND (multipart_upload_id IS NULL OR multipart_upload_id = ?)`)
      .bind(uploadId,now,now,now,assembly.id,assembly.transferId,assembly.attempt,assembly.generation,assembly.objectKey,uploadId).run();
    return result.meta.changes === 1;
  }

  /** A durable one-shot claim. Unknown create results are never retried as new creates. */
  async claimAssemblyCreate(identity: TransferIdentity, assembly: UploadAssembly, now: string): Promise<boolean> {
    const current = await this.getWritable(identity,now); if (!current.ok) return false;
    const scope = owner(identity,now,true);
    const result = await this.db.prepare(`UPDATE media_upload_assemblies SET completion_token = ?, completion_lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'creating' AND completion_token IS NULL AND multipart_upload_id IS NULL
        AND EXISTS (SELECT 1 FROM media_upload_transfers t WHERE ${scope.sql} AND t.state = 'receiving' AND t.generation = ? AND t.attempt = ?)
      RETURNING id`).bind(crypto.randomUUID(),addSeconds(now,180),now,assembly.id,...scope.bindings,assembly.generation,assembly.attempt).run();
    return result.results.length === 1;
  }

  async settleUnknownCreate(assembly: UploadAssembly, now: string): Promise<void> {
    await this.db.prepare(`UPDATE media_upload_assemblies SET create_settled_at = COALESCE(create_settled_at,?),
      writer_settled_at = COALESCE(writer_settled_at,?), updated_at = ? WHERE id = ? AND multipart_upload_id IS NULL`)
      .bind(now,now,now,assembly.id).run();
  }

  async settlePart(identity: TransferIdentity, proof: PartProof, claim: WriteClaim, now: string): Promise<void> {
    await this.db.prepare(`UPDATE media_upload_parts SET writer_settled_at = COALESCE(writer_settled_at,?),
      writer_lease_expires_at = min(writer_lease_expires_at,?), updated_at = ?
      WHERE transfer_id = ? AND part_index = ? AND claim_token = ? AND generation = ? AND attempt = ?`)
      .bind(now,now,now,identity.transferId,proof.index,claim.token,claim.generation,claim.attempt).run();
  }

  async claimCompletion(identity: TransferIdentity, now: string): Promise<TransferOutcome<WriteClaim>> {
    const current = await this.getOwned(identity,now); if (!current.ok) return current;
    const t = current.value;
    if (t.state !== 'receiving' || t.acceptedParts.length !== t.partCount) return conflict;
    const claim = {token:crypto.randomUUID(),generation:t.generation,attempt:t.attempt,leaseExpiresAt:[new Date(Date.parse(now)+WRITER_LEASE_MS).toISOString(),t.hardExpiresAt].sort()[0]!};
    const scope = owner(identity,now,true);
    const results = await this.db.batch([
      this.db.prepare(`UPDATE media_upload_transfers AS t SET state = 'processing', completion_token = ?, completion_lease_expires_at = ?, updated_at = ?
        WHERE ${scope.sql} AND t.state = 'receiving' AND t.generation = ? AND t.attempt = ?
          AND (SELECT count(*) FROM media_upload_parts p WHERE p.transfer_id = t.id AND p.state = 'accepted' AND p.generation = t.generation AND p.attempt = t.attempt) = t.part_count
          AND EXISTS (SELECT 1 FROM media_upload_assemblies a WHERE a.transfer_id = t.id AND a.attempt = t.attempt AND a.generation = t.generation AND a.state = 'receiving' AND a.multipart_upload_id IS NOT NULL AND a.create_settled_at IS NOT NULL)`)
        .bind(claim.token,claim.leaseExpiresAt,now,...scope.bindings,t.generation,t.attempt),
      this.db.prepare(`UPDATE media_upload_assemblies SET state = 'completing', completion_token = ?, completion_lease_expires_at = ?, writer_settled_at = ?, updated_at = ?
        WHERE transfer_id = ? AND attempt = ? AND generation = ? AND state = 'receiving' AND EXISTS
          (SELECT 1 FROM media_upload_transfers t WHERE t.id = transfer_id AND t.completion_token = ? AND t.state = 'processing')`)
        .bind(claim.token,claim.leaseExpiresAt,now,now,t.transferId,t.attempt,t.generation,claim.token),
    ]);
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1 ? {ok:true,value:claim} : conflict;
  }

  async completionIdentity(transferId:string, attempt:number): Promise<TransferIdentity|null> {
    const row = await this.db.prepare('SELECT * FROM media_upload_transfers WHERE id=? AND attempt=?').bind(transferId,attempt).first<TransferRow>();
    return row ? rowIdentity(row) : null;
  }

  async verifyReselection(identity:TransferIdentity, proof:{byteSize:number;parts:PartProof[]}, now:string):Promise<TransferOutcome<null>> {
    const current=await this.getOwned(identity,now); if (!current.ok) return current;
    const scope=owner(identity,now);
    const found=await this.db.prepare(`SELECT t.id FROM media_upload_transfers t WHERE ${scope.sql}
      AND t.byte_size=? AND t.state IN ('receiving','processing','retryable','delivered')
      AND (t.state='delivered' OR (t.expires_at>? AND t.hard_expires_at>?))
      AND EXISTS (SELECT 1 FROM media m JOIN events e ON e.id=m.event_id WHERE m.id=t.media_id
        AND m.deleted_at IS NULL AND e.deleted_at IS NULL AND m.upload_state IN ('reserved','stored'))
      AND (SELECT count(*) FROM media_upload_parts p WHERE p.transfer_id=t.id AND p.state='accepted'
        AND p.generation=t.generation AND p.attempt=t.attempt)=?
      AND NOT EXISTS (SELECT 1 FROM media_upload_parts p WHERE p.transfer_id=t.id AND p.state='accepted'
        AND p.generation=t.generation AND p.attempt=t.attempt AND NOT EXISTS (SELECT 1 FROM json_each(?) j
          WHERE json_extract(j.value,'$.index')=p.part_index AND json_extract(j.value,'$.byteSize')=p.byte_size
            AND json_extract(j.value,'$.sha256')=p.sha256))`)
      .bind(...scope.bindings,proof.byteSize,now,now,proof.parts.length,JSON.stringify(proof.parts)).first();
    return found ? {ok:true,value:null} : conflict;
  }

  async beginCompletion(identity: TransferIdentity, now:string): Promise<CompletionWork|null> {
    const current = await this.getWritable(identity,now); if (!current.ok) return null;
    const t = current.value; if (t.state !== 'processing' && t.state !== 'retryable') return null;
    const token = crypto.randomUUID(); const lease = [addSeconds(now,180),t.hardExpiresAt].sort()[0]!;
    const scope = owner(identity,now,true);
    try { await this.db.batch([
      this.db.prepare(`UPDATE media_upload_assemblies SET completion_token=?,completion_lease_expires_at=?,writer_settled_at=NULL,updated_at=?
        WHERE transfer_id=? AND attempt=? AND generation=? AND state='completing' AND writer_settled_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM media_upload_transfers t WHERE ${scope.sql} AND t.state IN ('processing','retryable')
            AND t.completion_token=media_upload_assemblies.completion_token) RETURNING id`)
        .bind(token,lease,now,t.transferId,t.attempt,t.generation,...scope.bindings),
      this.db.prepare(`UPDATE media_upload_transfers SET state='processing',completion_token=?,completion_lease_expires_at=?,updated_at=?
        WHERE id=? AND generation=? AND attempt=? AND EXISTS (SELECT 1 FROM media_upload_assemblies a WHERE a.transfer_id=media_upload_transfers.id
          AND a.attempt=media_upload_transfers.attempt AND a.generation=media_upload_transfers.generation AND a.completion_token=?)`)
        .bind(token,lease,now,t.transferId,t.generation,t.attempt,token),
    ]); } catch { /* Reconcile only this execution's unique token, never a different writer. */ }
    const a = await this.db.prepare(`SELECT a.* FROM media_upload_assemblies a JOIN media_upload_transfers t ON t.id=a.transfer_id
      AND t.attempt=a.attempt AND t.generation=a.generation AND t.completion_token=a.completion_token
      WHERE ${scope.sql} AND t.state='processing' AND a.state='completing' AND a.writer_settled_at IS NULL
        AND a.attempt=? AND a.generation=? AND a.completion_token=? AND t.completion_lease_expires_at>?`)
      .bind(...scope.bindings,t.attempt,t.generation,token,now).first<{id:string;object_key:string;multipart_upload_id:string;state:UploadAssembly['state'];completed_etag:string|null;expected_sha256:string|null;writer_settled_at:string|null}>();
    if (!a) return null;
    return {transfer:{...t,state:'processing'},claim:{token,generation:t.generation,attempt:t.attempt,leaseExpiresAt:lease},
      assembly:{id:a.id,transferId:t.transferId,attempt:t.attempt,generation:t.generation,objectKey:a.object_key,uploadId:a.multipart_upload_id,
        state:a.state,completedEtag:a.completed_etag,expectedSha256:a.expected_sha256,writerSettledAt:a.writer_settled_at}};
  }

  async completionParts(work: CompletionWork): Promise<R2UploadedPart[]> {
    const result = await this.db.prepare(`SELECT part_number AS partNumber,etag FROM media_upload_parts WHERE transfer_id=?
      AND attempt=? AND generation=? AND state='accepted' ORDER BY part_number`)
      .bind(work.transfer.transferId,work.claim.attempt,work.claim.generation).all<R2UploadedPart>();
    return result.results;
  }

  async recordAssemblyObject(work:CompletionWork, etag:string, now:string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE media_upload_assemblies SET completed_etag=?,multipart_closed_at=COALESCE(multipart_closed_at,?),updated_at=?
      WHERE id=? AND completion_token=? AND generation=? AND state IN ('completing','suppressed') AND (completed_etag IS NULL OR completed_etag=?) RETURNING id`)
      .bind(etag,now,now,work.assembly.id,work.claim.token,work.claim.generation,etag).run();
    return result.results.length===1;
  }

  async recordAssemblyHash(work:CompletionWork, sha256:string, now:string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE media_upload_assemblies SET expected_sha256=?,updated_at=?
      WHERE id=? AND completion_token=? AND generation=? AND state='completing' AND completed_etag IS NOT NULL
        AND (expected_sha256 IS NULL OR expected_sha256=?) RETURNING id`)
      .bind(sha256,now,work.assembly.id,work.claim.token,work.claim.generation,sha256).run();
    return result.results.length===1;
  }

  async settleCompletion(work:CompletionWork, now:string): Promise<void> {
    await this.db.prepare(`UPDATE media_upload_assemblies SET writer_settled_at=?,updated_at=?,state=CASE WHEN state='completing'
      AND EXISTS (SELECT 1 FROM media_upload_transfers t WHERE t.id=transfer_id AND t.state='delivered') THEN 'completed' ELSE state END
      WHERE id=? AND completion_token=? AND generation=?`)
      .bind(now,now,work.assembly.id,work.claim.token,work.claim.generation).run();
  }

  async failCompletion(work:CompletionWork, retryable:boolean, now:string): Promise<void> {
    await this.db.prepare(`UPDATE media_upload_transfers SET state=?,generation=generation+?,updated_at=?
      WHERE id=? AND completion_token=? AND generation=? AND attempt=? AND state='processing'`)
      .bind(retryable ? 'retryable' : 'rejected',retryable ? 0 : 1,now,work.transfer.transferId,work.claim.token,work.claim.generation,work.claim.attempt).run();
  }

  /** Only a still-live processing claim may extend its transfer, within the original hard cap. */
  async renewCompletionLease(identity: TransferIdentity, claim: WriteClaim, now: string): Promise<TransferOutcome<WriteClaim>> {
    const current = await this.getOwned(identity,now); if (!current.ok) return current;
    const t = current.value; const scope = owner(identity,now,true);
    const leaseExpiresAt = [addSeconds(now,180),t.hardExpiresAt].sort()[0]!;
    const results = await this.db.batch([
      this.db.prepare(`UPDATE media_upload_transfers AS t SET expires_at=min(hard_expires_at,max(expires_at,?)),
        completion_lease_expires_at=?,updated_at=? WHERE ${scope.sql} AND t.state='processing'
        AND t.completion_token=? AND t.generation=? AND t.attempt=? AND t.completion_lease_expires_at>?
        RETURNING id`).bind(addSeconds(now,transferWindowSeconds(t.byteSize)),leaseExpiresAt,now,...scope.bindings,claim.token,claim.generation,claim.attempt,now),
      this.db.prepare(`UPDATE media_upload_assemblies SET completion_lease_expires_at=?,updated_at=?
        WHERE transfer_id=? AND attempt=? AND generation=? AND completion_token=? AND state='completing'
        AND EXISTS (SELECT 1 FROM media_upload_transfers t WHERE t.id=transfer_id AND t.state='processing'
          AND t.completion_token=? AND t.completion_lease_expires_at=?)`)
        .bind(leaseExpiresAt,now,identity.transferId,claim.attempt,claim.generation,claim.token,claim.token,leaseExpiresAt),
      this.db.prepare(`UPDATE media_object_promotions SET lease_expires_at=?,updated_at=?
        WHERE media_id=? AND state='copying' AND claim_token=? AND EXISTS (
          SELECT 1 FROM media_upload_transfers t JOIN media_upload_assemblies a ON a.transfer_id=t.id
            AND a.attempt=t.attempt AND a.generation=t.generation WHERE t.id=? AND t.state='processing'
            AND t.completion_token=media_object_promotions.claim_token AND t.completion_lease_expires_at=?
            AND a.completion_token=t.completion_token AND a.state='completing' AND a.writer_settled_at IS NULL
            AND media_object_promotions.source_etag='assembly:' || a.id || ':' || a.expected_sha256)`)
        .bind(leaseExpiresAt,now,identity.mediaId,claim.token,identity.transferId,leaseExpiresAt),
      ...this.extendReservationStatements(identity.transferId),
    ]);
    return results[0]?.results.length === 1 ? {ok:true,value:{...claim,leaseExpiresAt}} : conflict;
  }

  async fenceOwned(identity: TransferIdentity, reason: 'aborted' | 'expired', now: string): Promise<TransferOutcome<null>> {
    const scope = owner(identity,now);
    const result = await this.db.prepare(`UPDATE media_upload_transfers AS t SET state = ?, generation = generation + 1,
      completion_token = NULL, completion_lease_expires_at = NULL, updated_at = ?
      WHERE ${scope.sql} AND t.state IN ('receiving','processing','retryable') ${reason === 'expired' ? 'AND (t.expires_at <= ? OR t.hard_expires_at <= ?)' : ''} RETURNING id`)
      .bind(reason,now,...scope.bindings,...(reason === 'expired' ? [now,now] : [])).run();
    return result.results.length === 1 ? {ok:true,value:null} : conflict;
  }

  async fenceForMediaMutation(mediaId: string, now: string): Promise<void> {
    // The authorized mutation's SQL triggers normally fence in the same commit.
    // Cleanup can call this after revocation, with no dependency on a live guest.
    await this.db.prepare(`UPDATE media_upload_transfers SET state = 'aborted', generation = generation + 1,
      completion_token = NULL, completion_lease_expires_at = NULL, updated_at = ?
      WHERE media_id = ? AND state IN ('receiving','processing','retryable')`).bind(now,mediaId).run();
  }
}

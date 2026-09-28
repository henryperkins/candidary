export interface ImagePreviewRecord {
  id: string; mediaId: string; eventId: string; sourceSha256: string; profile: string; generation: number;
  objectKey: string; mimeType: 'image/jpeg' | 'image/webp'; state: 'pending' | 'ready' | 'suppressed';
  claimToken: string; writerLeaseExpiresAt: string; writerSettledAt: string | null;
  producerKind:'upload'|'workflow';runCount:number;failureCode:string|null;
  byteSize: number | null; sha256: string | null; etag: string | null; width: number | null; height: number | null; frameCount: number | null;
}
interface PreviewRow {
  id:string;media_id:string;event_id:string;source_sha256:string;profile:string;generation:number;object_key:string;
  mime_type:ImagePreviewRecord['mimeType'];state:ImagePreviewRecord['state'];claim_token:string;writer_lease_expires_at:string;writer_settled_at:string|null;
  producer_kind:ImagePreviewRecord['producerKind'];run_count:number;failure_code:string|null;
  byte_size:number|null;sha256:string|null;etag:string|null;width:number|null;height:number|null;frame_count:number|null;
}
function map(row: PreviewRow): ImagePreviewRecord {
  return {id:row.id,mediaId:row.media_id,eventId:row.event_id,sourceSha256:row.source_sha256,profile:row.profile,generation:row.generation,objectKey:row.object_key,
    mimeType:row.mime_type,state:row.state,claimToken:row.claim_token,writerLeaseExpiresAt:row.writer_lease_expires_at,writerSettledAt:row.writer_settled_at,
    producerKind:row.producer_kind,runCount:row.run_count,failureCode:row.failure_code,
    byteSize:row.byte_size,sha256:row.sha256,etag:row.etag,width:row.width,height:row.height,frameCount:row.frame_count};
}
const retainedOwner = `EXISTS (SELECT 1 FROM media m JOIN events e ON e.id = m.event_id
  WHERE m.id = media_image_previews.media_id AND m.event_id = media_image_previews.event_id AND m.upload_state IN ('reserved','stored')
    AND e.deleted_at IS NULL AND (m.deleted_at IS NULL OR (m.trashed_at IS NOT NULL AND m.deleted_at = m.trashed_at)))`;

export class ImagePreviewRepository {
  constructor(private readonly db: D1Database) {}

  async get(id: string): Promise<ImagePreviewRecord | null> {
    const row = await this.db.prepare('SELECT * FROM media_image_previews WHERE id = ?').bind(id).first<PreviewRow>();
    return row ? map(row) : null;
  }

  async active(mediaId: string, sourceSha256: string, profile: string): Promise<ImagePreviewRecord | null> {
    const row = await this.db.prepare("SELECT * FROM media_image_previews WHERE media_id = ? AND source_sha256 = ? AND profile = ? AND state <> 'suppressed'").bind(mediaId,sourceSha256,profile).first<PreviewRow>();
    return row ? map(row) : null;
  }

  async retireOtherProfiles(mediaId:string, sourceSha256:string, profile:string, now:string): Promise<void> {
    await this.db.prepare(`UPDATE media_image_previews SET state='suppressed',suppression_started_at=coalesce(suppression_started_at,?),updated_at=?
      WHERE media_id=? AND source_sha256=? AND profile<>? AND state<>'suppressed'`)
      .bind(now,now,mediaId,sourceSha256,profile).run();
  }

  async claim(input: {mediaId:string;eventId:string;sourceSha256:string;profile:string;mimeType:ImagePreviewRecord['mimeType'];now:string;leaseExpiresAt:string;queued?:boolean}): Promise<{record:ImagePreviewRecord;claimed:boolean} | null> {
    if (!/^[0-9a-f]{64}$/u.test(input.sourceSha256) || !/^[a-z0-9-]{1,80}$/u.test(input.profile) || input.leaseExpiresAt <= input.now) return null;
    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    // The unique active tuple coalesces all simultaneous misses. No R2 write is
    // legal until this INSERT and its tombstone trigger have committed.
    try {await this.db.prepare(`INSERT INTO media_image_previews
      (id,media_id,event_id,source_sha256,profile,generation,object_key,mime_type,state,claim_token,writer_lease_expires_at,created_at,updated_at,producer_kind,writer_settled_at)
      SELECT ?,?,?,?,?,next_generation,
        'events/' || ? || '/media/previews/' || ? || '/' || ? || '/' || ? || '/' || next_generation || ?,?,'pending',?,?,?,?,?,?
      FROM (SELECT coalesce(max(generation),0) + 1 AS next_generation FROM media_image_previews WHERE media_id = ? AND source_sha256 = ? AND profile = ?)
      WHERE EXISTS (SELECT 1 FROM media m JOIN events e ON e.id = m.event_id WHERE m.id = ? AND m.event_id = ?
        AND m.upload_state IN ('reserved','stored') AND m.deleted_at IS NULL AND e.deleted_at IS NULL)
      ON CONFLICT DO NOTHING`).bind(id,input.mediaId,input.eventId,input.sourceSha256,input.profile,
      input.eventId,input.mediaId,input.sourceSha256,input.profile,input.mimeType === 'image/webp' ? '.webp' : '.jpg',input.mimeType,token,input.leaseExpiresAt,input.now,input.now,input.queued ? 'workflow' : 'upload',input.queued ? input.now : null,
      input.mediaId,input.sourceSha256,input.profile,input.mediaId,input.eventId).run();}
    catch { /* Only this freshly generated id/token can adopt a lost claim response. */ }
    const record = await this.active(input.mediaId,input.sourceSha256,input.profile);
    return record ? {record,claimed:record.id === id && record.claimToken === token} : null;
  }

  async begin(record:ImagePreviewRecord, now:string): Promise<ImagePreviewRecord|null> {
    const token=crypto.randomUUID(); const until=new Date(Date.parse(now)+480_000).toISOString();
    try {await this.db.prepare(`UPDATE media_image_previews SET claim_token=?,run_count=run_count+1,
      writer_settled_at=NULL,writer_lease_expires_at=?,failure_code=NULL,updated_at=?
      WHERE id=? AND state='pending' AND producer_kind='workflow' AND run_count<3 AND writer_settled_at IS NOT NULL
        AND (failure_code IS NULL OR failure_code IN ('busy','unavailable'))
        AND EXISTS (SELECT 1 FROM media m JOIN events e ON e.id=m.event_id WHERE m.id=media_id
          AND m.upload_state='stored' AND m.deleted_at IS NULL AND e.deleted_at IS NULL)`)
      .bind(token,until,now,record.id).run();} catch { /* Re-read the exact execution token. */ }
    const owned=await this.get(record.id);
    return owned?.state==='pending' && owned.claimToken===token && owned.writerSettledAt===null ? owned : null;
  }

  async recordProof(record:ImagePreviewRecord, proof:{byteSize:number;sha256:string;width:number;height:number;frameCount:number}, now:string): Promise<boolean> {
    const result=await this.db.prepare(`UPDATE media_image_previews SET byte_size=?,sha256=?,width=?,height=?,frame_count=?,updated_at=?
      WHERE id=? AND claim_token=? AND state='pending' AND writer_lease_expires_at>? AND writer_settled_at IS NULL
        AND (sha256 IS NULL OR (sha256=? AND byte_size=? AND width=? AND height=? AND frame_count=?)) AND ${retainedOwner}`)
      .bind(proof.byteSize,proof.sha256,proof.width,proof.height,proof.frameCount,now,record.id,record.claimToken,now,
        proof.sha256,proof.byteSize,proof.width,proof.height,proof.frameCount).run();
    return result.meta.changes===1;
  }

  async fail(record:ImagePreviewRecord, code:string, now:string): Promise<void> {
    await this.db.prepare("UPDATE media_image_previews SET failure_code=?,updated_at=? WHERE id=? AND claim_token=? AND state='pending'")
      .bind(code,now,record.id,record.claimToken).run();
  }

  async markReady(record: ImagePreviewRecord, proof: {byteSize:number;sha256:string;etag:string;width:number;height:number;frameCount:number}, now:string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE media_image_previews SET state = 'ready',failure_code=NULL,byte_size = ?,sha256 = ?,etag = ?,width = ?,height = ?,frame_count = ?,writer_settled_at = ?,updated_at = ?
      WHERE id = ? AND claim_token = ? AND generation = ? AND state = 'pending' AND writer_lease_expires_at > ? AND ${retainedOwner}
        AND EXISTS (SELECT 1 FROM media_object_write_tombstones t WHERE t.bucket_generation = 'canonical' AND t.object_key = media_image_previews.object_key
          AND t.media_id = media_image_previews.media_id AND t.event_id = media_image_previews.event_id AND t.object_kind = 'preview' AND t.suppression_started_at IS NULL)`)
      .bind(proof.byteSize,proof.sha256,proof.etag,proof.width,proof.height,proof.frameCount,now,now,record.id,record.claimToken,record.generation,now).run();
    return result.meta.changes === 1;
  }

  async suppress(record: ImagePreviewRecord, now:string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE media_image_previews SET state = 'suppressed',suppression_started_at = coalesce(suppression_started_at,?),updated_at = ?
      WHERE id = ? AND claim_token = ? AND generation = ?`).bind(now,now,record.id,record.claimToken,record.generation).run();
    return result.meta.changes === 1;
  }

  async settleWriter(record: ImagePreviewRecord, now:string): Promise<boolean> {
    const result = await this.db.prepare('UPDATE media_image_previews SET writer_settled_at = coalesce(writer_settled_at,?),updated_at = ? WHERE id = ? AND claim_token = ? AND generation = ?')
      .bind(now,now,record.id,record.claimToken,record.generation).run();
    return result.meta.changes === 1;
  }

  async recordAbsence(record: ImagePreviewRecord, now:string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE media_image_previews SET absence_verified_at = ?,updated_at = ? WHERE id = ? AND state = 'suppressed'
      AND writer_settled_at IS NOT NULL AND writer_settled_at <= ? AND EXISTS (SELECT 1 FROM media_object_write_tombstones t
        WHERE t.bucket_generation = 'canonical' AND t.object_key = media_image_previews.object_key AND t.suppression_started_at IS NOT NULL)`)
      .bind(now,now,record.id,now).run();
    return result.meta.changes === 1;
  }
}

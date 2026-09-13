import { normalizeManagerExportErrorCode, type ExportState } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import {
  canonicalPhotoExportRequest, createPhotoExportSchema, PHOTO_EXPORT_MAX_IDS,
  type CreatePhotoExportRequest, type PhotoExportCapabilities, type PhotoExportEntryView,
  type PhotoExportSource, type PhotoExportView,
} from '../../shared/photo-exports';

const IDLE_MINUTES = 30;
const EXECUTION_MINUTES = 24 * 60;
const FALLBACK_PENDING = 'PHOTO_EXPORT_FALLBACK_PENDING';
const EXPIRING = 'PHOTO_EXPORT_EXPIRING';
const admitted = `EXISTS (SELECT 1 FROM photo_export_admission WHERE singleton=1 AND enabled=1)
  AND EXISTS (SELECT 1 FROM export_protocol_admission WHERE singleton=1 AND state='open')`;
const entryColumns = `media_id, object_key, object_bucket_generation, original_filename, mime_type,
  declared_byte_size, byte_size, width, height, guest_name, caption, publication_status,
  created_at, published_at, album_tail_position`;

/** Server-only capability: routes must never put this object in a public response. */
export interface PhotoExportReadLease {
  eventId: string; jobId: string; mediaId: string; principal: string;
  attempt: number; ownerToken: string; leaseToken: string;
  objectBucketGeneration: 'canonical'; objectKey: string;
  filename: string; mimeType: string; byteSize: number; leaseExpiresAt: string;
}
interface JobRow {
  id: string; event_id: string; destination: 'archive' | 'device'; source_json: string;
  request_digest: string; initiating_principal: string; state: ExportState;
  snapshot_at: string; created_at: string; confirmed_at: string | null; completed_at: string | null;
  media_count: number; total_bytes: number; hold_expires_at: string; absolute_expires_at: string;
  cancel_requested_at: string | null; error_code: string | null; attempt: number;
  execution_started_at: string | null; handed_off_count: number; unavailable_count: number;
}
interface ActiveJobRow {
  id: string;
  kind: NonNullable<PhotoExportCapabilities['activeJob']>['kind'];
  state: 'queued' | 'running';
  destination: NonNullable<PhotoExportCapabilities['activeJob']>['destination'];
  media_count: number;
  total_bytes: number;
  initiating_principal: string | null;
}
interface AdmissionDiagnosticRow {
  count: number;
  authorized: 0 | 1;
  admitted: 0 | 1;
  conflict: 0 | 1;
}
const projection = `SELECT j.*,
  (SELECT count(*) FROM photo_export_deliveries d WHERE d.export_job_id=j.id AND d.state='acknowledged') AS handed_off_count,
  (SELECT count(*) FROM photo_export_deliveries d WHERE d.export_job_id=j.id AND d.state IN ('failed','unresolved')) AS unavailable_count
  FROM export_jobs j`;
function view(row: JobRow): PhotoExportView {
  return { id: row.id, kind: 'selection', destination: row.destination,
    source: (JSON.parse(row.source_json) as { source: PhotoExportSource }).source,
    state: row.state, snapshotAt: row.snapshot_at, createdAt: row.created_at,
    confirmedAt: row.confirmed_at, completedAt: row.completed_at, mediaCount: row.media_count,
    totalBytes: row.total_bytes, handedOffCount: row.handed_off_count, unavailableCount: row.unavailable_count,
    holdExpiresAt: row.hold_expires_at, absoluteExpiresAt: row.absolute_expires_at,
    cancelRequested: row.cancel_requested_at !== null, attempt: row.attempt,
    errorCode: row.error_code === FALLBACK_PENDING || row.error_code === EXPIRING ? null : normalizeManagerExportErrorCode(row.error_code) };
}
function plus(now: string, minutes: number): string {
  if (!Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now) throw new ApiError('VALIDATION_FAILED', 'A valid operation timestamp is required.', 400);
  return new Date(Date.parse(now) + minutes * 60_000).toISOString();
}
const missing = () => new ApiError('RESOURCE_FORBIDDEN', 'This photo export could not be found.', 404);
const busy = () => new ApiError('VALIDATION_FAILED', 'This export is busy or no longer accepts this action. Refresh and try again.', 409);
const changed = () => new ApiError('EXPORT_SOURCE_REMOVED', 'The selected photos are no longer available. Refresh the selection and try again.', 409);
const paused = () => new ApiError('EXPORT_FAILED', 'This photo export destination is temporarily unavailable.', 503);
const activeConflict = () => new ApiError('EXPORT_ALREADY_ACTIVE', 'An export is already active for this event.', 409);
function sourceFailure(error: unknown): never {
  if (error instanceof Error && /source (?:hold|object)|selection (?:source|execution)|NOT NULL constraint failed: export_jobs.media_count/iu.test(error.message)) throw changed();
  throw error;
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Recheck durable event authority inside each mutation, after route authentication. */
function authority(event: string, principal: string, now: string): string {
  return `EXISTS (SELECT 1 FROM events auth_event WHERE auth_event.id=${event}
    AND auth_event.deleted_at IS NULL AND auth_event.management_access_expires_at>${now} AND auth_event.purge_after>${now}
    AND (EXISTS (SELECT 1 FROM event_hosts h JOIN host_accounts a ON a.id=h.account_id
      WHERE h.event_id=auth_event.id AND 'account:' || a.id=${principal} AND a.disabled_at IS NULL)
      OR EXISTS (SELECT 1 FROM event_sessions s JOIN event_access_tokens t ON t.id=s.access_token_id
        WHERE s.event_id=auth_event.id AND t.event_id=auth_event.id AND 'link:' || s.id=${principal}
          AND s.role='manager' AND t.role='manager' AND s.revoked_at IS NULL AND t.revoked_at IS NULL
          AND s.expires_at>${now} AND t.expires_at>${now})))`;
}
// Bound statements uniformly: ?1 job, ?2 event, ?3 principal, ?4 operation time.
const owned = `j.id=?1 AND j.event_id=?2 AND j.kind='selection' AND j.initiating_principal=?3 AND ${authority('j.event_id', '?3', '?4')}`;
const activeDevice = `${owned} AND j.destination='device' AND j.state='running' AND j.confirmed_at IS NOT NULL
  AND j.cancel_requested_at IS NULL AND j.hold_expires_at>?4 AND j.absolute_expires_at>?4`;
const noReads = (job: string) => `NOT EXISTS (SELECT 1 FROM photo_export_deliveries d WHERE d.export_job_id=${job}
  AND d.read_lease_token IS NOT NULL AND julianday(d.read_lease_expires_at)>julianday('now'))`;
const eventCeiling = (event: string) => `(SELECT min(management_access_expires_at, purge_after) FROM events WHERE id=${event})`;
const refreshedHold = (candidate: string) => `max(j.hold_expires_at, min(${candidate}, j.absolute_expires_at, ${eventCeiling('j.event_id')}))`;

/** Source CTE is reused for count, INSERT SELECT and a set/size/position sentinel. */
function sourceCte(source: PhotoExportSource): string {
  const album = source.scope === 'album';
  const descending = source.mode === 'all' && source.scope === 'library' && source.filter.order === 'newest';
  const order = album ? `CASE WHEN album_position IS NULL THEN 1 ELSE 0 END, album_position, timeline_at, id`
    : `timeline_at ${descending ? 'DESC' : 'ASC'}, id ${descending ? 'DESC' : 'ASC'}`;
  const search = source.mode === 'all' && source.scope === 'library' && source.filter.query !== undefined;
  const favorite = album || (source.mode === 'all' && source.scope === 'library' && source.filter.favorites);
  return `WITH eligible AS MATERIALIZED (
    SELECT m.*, ${album ? `(SELECT min(CAST(a.key AS INTEGER)) FROM event_albums album,
      json_each(CASE WHEN json_valid(album.entries) AND json_type(album.entries)='array' THEN album.entries ELSE '[]' END) a
      WHERE album.event_id=?2 AND json_extract(a.value,'$.kind')='photo' AND json_extract(a.value,'$.mediaId')=m.id)` : 'NULL'} AS album_position
    FROM media m WHERE m.event_id=?2 AND m.upload_state='stored' AND m.deleted_at IS NULL AND m.trashed_at IS NULL
      AND m.object_bucket_generation='canonical' AND m.object_key='events/' || ?2 || '/media/final/' || m.id
      AND EXISTS (SELECT 1 FROM media_object_write_tombstones t WHERE t.bucket_generation=m.object_bucket_generation
        AND t.object_key=m.object_key AND t.suppression_started_at IS NULL)
      ${favorite ? 'AND m.favorited_at IS NOT NULL' : ''}
      ${search ? `AND (instr(lower(m.guest_name),lower(?6))>0 OR instr(lower(COALESCE(m.caption,'')),lower(?6))>0
        OR instr(lower(m.original_filename),lower(?6))>0)` : 'AND (?6 IS NULL OR ?6 IS NOT NULL)'}
      AND m.id ${source.mode === 'ids' ? 'IN' : 'NOT IN'} (SELECT value FROM json_each(?5))
    ), source AS MATERIALIZED (SELECT *, ROW_NUMBER() OVER (ORDER BY ${order}) AS position FROM eligible)`;
}

export class PhotoExportsRepository {
  constructor(private readonly db: D1Database) {}
  async capabilities(eventId: string, principal: string): Promise<PhotoExportCapabilities> {
    const results = await this.db.batch([
      this.db.prepare(`SELECT CASE WHEN ${admitted} THEN 1 ELSE 0 END AS enabled`),
      this.db.prepare(`SELECT j.id,j.kind,j.state,j.destination,j.media_count,j.total_bytes,j.initiating_principal
        FROM export_jobs j WHERE j.event_id=?1 AND j.state IN ('queued','running')
        AND ${authority('j.event_id', '?2', "strftime('%Y-%m-%dT%H:%M:%fZ','now')")} LIMIT 1`).bind(eventId,principal),
    ]) as [D1Result<{ enabled: 0 | 1 }>, D1Result<ActiveJobRow>];
    const row = results[1]?.results[0]; const enabled = results[0]?.results[0]?.enabled === 1;
    return { enabled, destinations: enabled ? ['device','archive'] : [], activeJob: row ? {
      id: row.id, kind: row.kind,
      state: row.state, destination: row.destination,
      mediaCount: row.media_count, totalBytes: row.total_bytes,
      ownedByCurrentPrincipal: row.initiating_principal === principal,
    } : null };
  }
  private async row(eventId: string, jobId: string, principal: string, now: string): Promise<JobRow> {
    const row = await this.db.prepare(`${projection} WHERE ${owned}`).bind(jobId,eventId,principal,now).first<JobRow>();
    if (!row) throw missing(); return row;
  }
  private async replay(eventId: string, principal: string, key: string, hash: string, now: string): Promise<PhotoExportView | null> {
    const row = await this.db.prepare(`${projection} WHERE j.event_id=?1 AND j.initiating_principal=?2
      AND j.idempotency_key=?3 AND j.kind='selection' AND ${authority('j.event_id','?2','?4')}`)
      .bind(eventId,principal,key,now).first<JobRow>();
    if (!row) return null;
    if (row.request_digest !== hash) throw new ApiError('VALIDATION_FAILED','This idempotency key already identifies a different selection.',409);
    return view(row);
  }
  async create(input: { eventId: string; principal: string; request: CreatePhotoExportRequest; now: string }): Promise<PhotoExportView> {
    const parsed = createPhotoExportSchema.safeParse(input.request);
    if (!parsed.success) throw new ApiError('VALIDATION_FAILED','Choose a valid photo selection.',400);
    const request = parsed.data; const { eventId,principal,now } = input;
    const hash = await digest(canonicalPhotoExportRequest(request));
    const replay = await this.replay(eventId,principal,request.idempotencyKey,hash,now); if (replay) return replay;
    if (request.destination !== 'device' && request.destination !== 'archive') throw paused();
    const jobId = crypto.randomUUID(); const source = request.source;
    const ids = source.mode === 'ids' ? source.mediaIds : source.excludedMediaIds;
    const query = source.mode === 'all' && source.scope === 'library' ? source.filter.query ?? null : null;
    const cte = sourceCte(source); const bindings = [jobId,eventId,principal,now,JSON.stringify(ids),query];
    const exact = source.mode === 'ids' ? '(SELECT count(*) FROM source)=json_array_length(?5)' : '1';
    const inventory = `SELECT id,object_key,object_bucket_generation,COALESCE(byte_size,declared_byte_size),position FROM source`;
    const frozen = `SELECT media_id,object_key,object_bucket_generation,COALESCE(byte_size,declared_byte_size),album_tail_position
      FROM export_media_entries WHERE export_job_id=?1`;
    let results: D1Result<AdmissionDiagnosticRow>[];
    try {
      results = await this.db.batch<AdmissionDiagnosticRow>([
        this.db.prepare(`${cte} INSERT INTO export_jobs (id,event_id,kind,destination,state,snapshot_at,media_count,total_bytes,
          created_at,execution_protocol,source_json,request_digest,idempotency_key,initiating_principal,hold_expires_at,absolute_expires_at)
          SELECT ?1,e.id,'selection',?10,'queued',?4,(SELECT count(*) FROM source),
            (SELECT sum(COALESCE(byte_size,declared_byte_size)) FROM source),?4,'selection-v1',?8,?9,?7,?3,
            min(?11,e.management_access_expires_at,e.purge_after),min(?12,e.management_access_expires_at,e.purge_after)
          FROM events e WHERE e.id=?2 AND ${authority('e.id','?3','?4')} AND ${admitted}
            AND NOT EXISTS (SELECT 1 FROM export_jobs WHERE event_id=?2 AND state IN ('queued','running'))
            AND NOT EXISTS (SELECT 1 FROM export_jobs WHERE event_id=?2 AND initiating_principal=?3 AND idempotency_key=?7)
            AND (SELECT count(*) FROM source) BETWEEN 1 AND ${PHOTO_EXPORT_MAX_IDS} AND ${exact}`)
          .bind(...bindings,request.idempotencyKey,JSON.stringify({ version: 1,source }),hash,request.destination,
            plus(now,IDLE_MINUTES),request.destination === 'device' ? plus(now,EXECUTION_MINUTES) : '9999-12-31T23:59:59.999Z'),
        this.db.prepare(`${cte} INSERT INTO export_media_entries (export_job_id,${entryColumns})
          SELECT ?1,id,object_key,object_bucket_generation,original_filename,mime_type,declared_byte_size,byte_size,
            width,height,guest_name,caption,publication_status,created_at,published_at,position FROM source
          WHERE EXISTS (SELECT 1 FROM export_jobs WHERE id=?1)`).bind(...bindings),
        this.db.prepare(`INSERT INTO photo_export_deliveries (export_job_id,media_id,state,attempt)
          SELECT e.export_job_id,e.media_id,'pending',1 FROM export_media_entries e JOIN export_jobs j ON j.id=e.export_job_id
          WHERE j.id=?1 AND j.destination='device'`).bind(jobId),
        this.db.prepare(`${cte} UPDATE export_jobs SET media_count=CASE WHEN
          (SELECT count(*) FROM export_media_entries WHERE export_job_id=?1)=media_count
          AND (SELECT sum(COALESCE(byte_size,declared_byte_size)) FROM export_media_entries WHERE export_job_id=?1)=total_bytes
          AND NOT EXISTS (${inventory} EXCEPT ${frozen}) AND NOT EXISTS (${frozen} EXCEPT ${inventory})
          AND ${exact} THEN media_count ELSE NULL END WHERE id=?1`).bind(...bindings),
        this.db.prepare(`${cte} SELECT (SELECT count(*) FROM source) AS count,
          CASE WHEN ${authority('?2','?3','?4')} THEN 1 ELSE 0 END AS authorized,
          CASE WHEN ${admitted} THEN 1 ELSE 0 END AS admitted,
          EXISTS (SELECT 1 FROM export_jobs WHERE event_id=?2 AND state IN ('queued','running') AND id<>?1) AS conflict`).bind(...bindings),
      ]);
    } catch (error) { sourceFailure(error); }
    if (results[0]?.meta.changes === 1) return view(await this.row(eventId,jobId,principal,now));
    const raced = await this.replay(eventId,principal,request.idempotencyKey,hash,now); if (raced) return raced;
    const diagnostic = results.at(-1)!.results[0]!;
    if (!diagnostic.authorized) throw missing(); if (!diagnostic.admitted) throw paused(); if (diagnostic.conflict) throw activeConflict();
    if (diagnostic.count>PHOTO_EXPORT_MAX_IDS) throw new ApiError('EXPORT_LIMIT_EXCEEDED','Select at most 10,000 photos.',400);
    if (source.mode === 'all' && diagnostic.count === 0) throw new ApiError('EXPORT_EMPTY','There are no available photos in this selection.',400);
    throw changed();
  }

  async get(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView> {
    await this.row(eventId,jobId,principal,now); await this.expireOne(jobId,now);
    return view(await this.row(eventId,jobId,principal,now));
  }
  async listEntries(eventId: string, jobId: string, principal: string, after: number, limit: number, now: string): Promise<{ entries: PhotoExportEntryView[]; nextPosition: number | null }> {
    if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(limit) || limit<1 || limit>100) {
      throw new ApiError('VALIDATION_FAILED','Use a valid photo cursor and a page size from 1 to 100.',400);
    }
    await this.row(eventId,jobId,principal,now);
    const result = await this.db.prepare(`SELECT e.media_id AS mediaId,e.album_tail_position AS position,
      e.original_filename AS filename,e.mime_type AS mimeType,COALESCE(e.byte_size,e.declared_byte_size) AS byteSize,
      CASE WHEN d.state='uploading' THEN 'pending' ELSE COALESCE(d.state,'pending') END AS state
      FROM export_jobs j JOIN export_media_entries e ON e.export_job_id=j.id
      LEFT JOIN photo_export_deliveries d ON d.export_job_id=j.id AND d.media_id=e.media_id
      WHERE ${owned} AND e.album_tail_position>?5 ORDER BY e.album_tail_position LIMIT ?6`)
      .bind(jobId,eventId,principal,now,after,limit+1).all<PhotoExportEntryView>();
    const entries = result.results.slice(0,limit);
    return { entries,nextPosition: result.results.length>limit ? entries.at(-1)!.position : null };
  }
  async confirm(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView> {
    const row = await this.row(eventId,jobId,principal,now);
    if (row.confirmed_at !== null && row.cancel_requested_at === null && ['queued','running','handed-off','ready'].includes(row.state)
      && row.hold_expires_at>now && row.absolute_expires_at>now) return view(row);
    const result = await this.db.prepare(`UPDATE export_jobs AS j SET confirmed_at=?4,
      hold_expires_at=${refreshedHold("CASE WHEN j.destination='device' THEN ?5 ELSE ?6 END")},
      state=CASE WHEN destination='device' THEN 'running' ELSE 'queued' END,
      execution_transition=execution_transition + CASE WHEN destination='device' THEN 1 ELSE 0 END,
      execution_started_at=CASE WHEN destination='device' THEN ?4 ELSE NULL END,
      processed_media_count=CASE WHEN destination='device' THEN 0 ELSE NULL END,
      processed_bytes=CASE WHEN destination='device' THEN 0 ELSE NULL END,
      progress_updated_at=CASE WHEN destination='device' THEN ?4 ELSE NULL END
      WHERE ${owned} AND j.state='queued' AND j.confirmed_at IS NULL AND j.cancel_requested_at IS NULL
        AND j.hold_expires_at>?4 AND j.absolute_expires_at>?4`)
      .bind(jobId,eventId,principal,now,plus(now,IDLE_MINUTES),plus(now,EXECUTION_MINUTES)).run();
    if (result.meta.changes !== 1) {
      const current = await this.row(eventId,jobId,principal,now);
      if (current.confirmed_at && !current.cancel_requested_at && current.hold_expires_at>now && ['queued','running'].includes(current.state)) return view(current);
      throw busy();
    }
    return view(await this.row(eventId,jobId,principal,now));
  }
  private finalize(jobId: string, now: string): D1PreparedStatement {
    return this.db.prepare(`UPDATE export_jobs AS j SET state=CASE WHEN error_code=?3 THEN 'expired' ELSE 'cancelled' END,
      execution_transition=execution_transition+1,completed_at=?2,
      error_code=CASE WHEN error_code=?3 THEN NULL ELSE error_code END
      WHERE j.id=?1 AND j.kind='selection' AND j.state IN ('queued','running') AND j.cancel_requested_at IS NOT NULL
        AND COALESCE(j.error_code,'')<>?4 AND ${noReads('j.id')}`).bind(jobId,now,EXPIRING,FALLBACK_PENDING);
  }
  private async expireOne(jobId: string, now: string): Promise<number> {
    const results = await this.db.batch([
      this.db.prepare(`UPDATE export_jobs AS j SET cancel_requested_at=COALESCE(cancel_requested_at,?2),error_code=?3
        WHERE j.id=?1 AND j.kind='selection' AND j.state IN ('queued','running')
          AND (hold_expires_at<=?2 OR absolute_expires_at<=?2 OR NOT ${authority('j.event_id','j.initiating_principal','?2')})`).bind(jobId,now,EXPIRING),
      this.finalize(jobId,now),
    ]);
    return results[1]?.meta.changes ?? 0;
  }
  async expireActive(now: string, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit<1 || limit>100) throw new RangeError('Expire between 1 and 100 selections at a time.');
    const jobs = await this.db.prepare(`SELECT j.id FROM export_jobs j WHERE j.kind='selection' AND j.state IN ('queued','running')
      AND (j.hold_expires_at<=?1 OR j.absolute_expires_at<=?1 OR j.cancel_requested_at IS NOT NULL
        OR NOT ${authority('j.event_id','j.initiating_principal','?1')}) ORDER BY j.hold_expires_at,j.id LIMIT ?2`).bind(now,limit).all<{ id: string }>();
    let count = 0; for (const job of jobs.results) count += await this.expireOne(job.id,now); return count;
  }
  async cancel(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView> {
    await this.row(eventId,jobId,principal,now);
    await this.db.batch([
      this.db.prepare(`UPDATE export_jobs AS j SET cancel_requested_at=COALESCE(cancel_requested_at,?4),error_code=NULL
        WHERE ${owned} AND j.state IN ('queued','running')`).bind(jobId,eventId,principal,now),
      this.finalize(jobId,now),
    ]);
    return view(await this.row(eventId,jobId,principal,now));
  }
  async claimRead(eventId: string, jobId: string, mediaId: string, principal: string, now: string): Promise<PhotoExportReadLease> {
    await this.row(eventId,jobId,principal,now); const token = crypto.randomUUID();
    const result = await this.db.prepare(`UPDATE photo_export_deliveries AS d SET read_lease_token=?6,
      read_lease_expires_at=(SELECT min(?7,j.hold_expires_at,j.absolute_expires_at,${eventCeiling('j.event_id')}) FROM export_jobs j WHERE j.id=?1)
      WHERE d.export_job_id=?1 AND d.media_id=?5 AND d.state<>'acknowledged'
        AND (d.read_lease_token IS NULL OR (d.read_lease_expires_at<=?4 AND julianday(d.read_lease_expires_at)<=julianday('now')))
        AND EXISTS (SELECT 1 FROM export_jobs j WHERE ${activeDevice} AND j.attempt=d.attempt)
        AND (SELECT count(*) FROM photo_export_deliveries live WHERE live.export_job_id=?1
          AND live.read_lease_token IS NOT NULL AND julianday(live.read_lease_expires_at)>julianday('now'))<2
      RETURNING read_lease_expires_at`).bind(jobId,eventId,principal,now,mediaId,token,plus(now,2)).first<{ read_lease_expires_at: string }>();
    if (!result) throw busy();
    const lease = await this.db.prepare(`SELECT j.event_id AS eventId,j.id AS jobId,e.media_id AS mediaId,
      j.initiating_principal AS principal,j.attempt,j.execution_started_at AS ownerToken,
      d.read_lease_token AS leaseToken,d.read_lease_expires_at AS leaseExpiresAt,e.object_bucket_generation AS objectBucketGeneration,
      e.object_key AS objectKey,e.original_filename AS filename,e.mime_type AS mimeType,COALESCE(e.byte_size,e.declared_byte_size) AS byteSize
      FROM export_jobs j JOIN export_media_entries e ON e.export_job_id=j.id
      JOIN photo_export_deliveries d ON d.export_job_id=j.id AND d.media_id=e.media_id
      WHERE j.id=?1 AND e.media_id=?2 AND d.read_lease_token=?3`).bind(jobId,mediaId,token).first<PhotoExportReadLease>();
    if (!lease) throw busy(); return lease;
  }
  async assertReadActive(lease: PhotoExportReadLease, now: string): Promise<boolean> {
    const row = await this.db.prepare(`SELECT 1 AS active FROM export_jobs j JOIN photo_export_deliveries d ON d.export_job_id=j.id
      WHERE ${activeDevice} AND d.media_id=?5 AND j.attempt=?6 AND j.execution_started_at=?7
        AND d.attempt=?6 AND d.read_lease_token=?8 AND d.read_lease_expires_at>?4`)
      .bind(lease.jobId,lease.eventId,lease.principal,now,lease.mediaId,lease.attempt,lease.ownerToken,lease.leaseToken).first();
    return row !== null;
  }
  async releaseRead(lease: PhotoExportReadLease, outcome: 'prepared' | 'failed', now: string): Promise<void> {
    const owner = `EXISTS (SELECT 1 FROM export_jobs j WHERE ${activeDevice} AND j.attempt=?6 AND j.execution_started_at=?7)`;
    const valid = `d.read_lease_expires_at>?4 AND ${owner}`;
    await this.db.batch([
      this.db.prepare(`UPDATE photo_export_deliveries AS d SET
        state=CASE WHEN ${valid} THEN ?9 ELSE state END,
        prepared_at=CASE WHEN ${valid} AND ?9='prepared' THEN ?4 ELSE prepared_at END,
        failed_at=CASE WHEN ${valid} AND ?9='failed' THEN ?4 ELSE failed_at END,
        read_lease_token=NULL,read_lease_expires_at=NULL
        WHERE d.export_job_id=?1 AND d.media_id=?5 AND d.attempt=?6 AND d.read_lease_token=?8
          AND EXISTS (SELECT 1 FROM export_jobs j WHERE j.id=?1 AND j.attempt=?6 AND j.execution_started_at=?7 AND j.state IN ('queued','running'))`)
        .bind(lease.jobId,lease.eventId,lease.principal,now,lease.mediaId,lease.attempt,lease.ownerToken,lease.leaseToken,outcome),
      this.db.prepare(`UPDATE export_jobs AS j SET hold_expires_at=${refreshedHold('?9')}
        WHERE ${activeDevice} AND j.attempt=?6 AND j.execution_started_at=?7 AND ?8='prepared'
          AND changes()=1 AND EXISTS (SELECT 1 FROM photo_export_deliveries d WHERE d.export_job_id=j.id AND d.media_id=?5
            AND d.attempt=?6 AND d.state='prepared' AND d.prepared_at=?4)`)
        .bind(lease.jobId,lease.eventId,lease.principal,now,lease.mediaId,lease.attempt,lease.ownerToken,outcome,plus(now,IDLE_MINUTES)),
      this.finalize(lease.jobId,now),
    ]);
  }
  async recordHandoff(eventId: string, jobId: string, principal: string, mediaIds: string[], now: string): Promise<PhotoExportView> {
    const row = await this.row(eventId,jobId,principal,now); const ids = [...new Set(mediaIds)];
    if (ids.length<1 || ids.length>PHOTO_EXPORT_MAX_IDS) throw busy();
    const eligible = `SELECT count(*) FROM photo_export_deliveries d WHERE d.export_job_id=?1
      AND d.attempt=${row.attempt} AND d.state IN ('prepared','acknowledged') AND d.read_lease_token IS NULL
      AND d.media_id IN (SELECT value FROM json_each(?5))`;
    const sum = `(SELECT COALESCE(sum(COALESCE(e.byte_size,e.declared_byte_size)),0) FROM export_media_entries e
      JOIN photo_export_deliveries d ON d.export_job_id=e.export_job_id AND d.media_id=e.media_id
      WHERE d.export_job_id=j.id AND d.attempt=j.attempt AND d.state='acknowledged')`;
    const count = `(SELECT count(*) FROM photo_export_deliveries d WHERE d.export_job_id=j.id AND d.attempt=j.attempt AND d.state='acknowledged')`;
    const results = await this.db.batch<{ valid: 0 | 1 }>([
      this.db.prepare(`UPDATE photo_export_deliveries AS d SET state='acknowledged',acknowledged_at=?4
        WHERE d.export_job_id=?1 AND d.state='prepared' AND d.media_id IN (SELECT value FROM json_each(?5))
          AND (${eligible})=json_array_length(?5) AND EXISTS (SELECT 1 FROM export_jobs j WHERE ${activeDevice} AND j.attempt=d.attempt)`)
        .bind(jobId,eventId,principal,now,JSON.stringify(ids)),
      this.db.prepare(`UPDATE export_jobs AS j SET processed_media_count=${count},processed_bytes=${sum},progress_updated_at=max(progress_updated_at,?4),
        hold_expires_at=${refreshedHold('?5')} WHERE ${activeDevice} AND ${count}>j.processed_media_count`)
        .bind(jobId,eventId,principal,now,plus(now,IDLE_MINUTES)),
      this.db.prepare(`UPDATE export_jobs AS j SET state='handed-off',execution_transition=execution_transition+1,completed_at=?4
        WHERE ${activeDevice} AND j.processed_media_count=j.media_count AND ${noReads('j.id')}`).bind(jobId,eventId,principal,now),
      this.db.prepare(`SELECT (${eligible})=json_array_length(?5) AS valid FROM export_jobs j WHERE ${owned}
        AND j.destination='device' AND j.state IN ('running','handed-off') AND j.confirmed_at IS NOT NULL
        AND j.cancel_requested_at IS NULL AND j.hold_expires_at>?4 AND j.absolute_expires_at>?4`).bind(jobId,eventId,principal,now,JSON.stringify(ids)),
    ]);
    if (results.at(-1)?.results[0]?.valid !== 1) throw busy();
    return view(await this.row(eventId,jobId,principal,now));
  }
  async retryArchive(eventId: string, jobId: string, principal: string, now: string): Promise<PhotoExportView> {
    await this.row(eventId,jobId,principal,now); let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db.prepare(`UPDATE export_jobs AS j SET state='queued',attempt=attempt+1,
        execution_transition=execution_transition+1,execution_started_at=NULL,confirmed_at=NULL,cancel_requested_at=NULL,
        processed_media_count=NULL,processed_bytes=NULL,progress_updated_at=NULL,completed_at=NULL,error_code=NULL,
        object_key=NULL,manifest_object_key=NULL,part_count=0,expires_at=NULL,
        hold_expires_at=min(?5,absolute_expires_at,${eventCeiling('j.event_id')})
        WHERE ${owned} AND j.destination='archive' AND j.state IN ('failed','expired') AND j.absolute_expires_at>?4
          AND ${admitted} AND NOT EXISTS (SELECT 1 FROM export_jobs active WHERE active.event_id=?2 AND active.state IN ('queued','running'))`)
        .bind(jobId,eventId,principal,now,plus(now,IDLE_MINUTES)),
        this.db.prepare('DELETE FROM export_parts WHERE export_job_id = ? AND changes() = 1').bind(jobId),
      ]);
    } catch (error) { sourceFailure(error); }
    if (results[0]?.meta.changes !== 1) {
      const capabilities = await this.capabilities(eventId,principal);
      if (!capabilities.enabled) throw paused(); if (capabilities.activeJob) throw activeConflict(); throw busy();
    }
    return view(await this.row(eventId,jobId,principal,now));
  }
  async prepareArchiveFallback(eventId: string, jobId: string, principal: string, idempotencyKey: string, now: string): Promise<PhotoExportView> {
    const old = await this.row(eventId,jobId,principal,now);
    const request: CreatePhotoExportRequest = { version: 1,destination: 'archive',idempotencyKey,source: view(old).source };
    if (!createPhotoExportSchema.safeParse(request).success) throw new ApiError('VALIDATION_FAILED','Use a valid fallback idempotency key.',400);
    const hash = await digest(JSON.stringify({ fallbackFrom: jobId,request: canonicalPhotoExportRequest(request) }));
    const replay = await this.replay(eventId,principal,idempotencyKey,hash,now); if (replay) return replay;
    if (old.destination !== 'device' || !['queued','running'].includes(old.state) || old.hold_expires_at<=now || old.absolute_expires_at<=now) throw busy();
    // Persist intent while draining; lease callbacks retain the old source hold.
    await this.db.prepare(`UPDATE export_jobs AS j SET cancel_requested_at=COALESCE(cancel_requested_at,?4),error_code=?5
      WHERE ${owned} AND j.destination='device' AND j.state IN ('queued','running')
        AND (j.cancel_requested_at IS NULL OR j.error_code=?5) AND j.hold_expires_at>?4 AND j.absolute_expires_at>?4 AND ${admitted}`)
      .bind(jobId,eventId,principal,now,FALLBACK_PENDING).run();
    const nextId = crypto.randomUUID(); const bindings = [jobId,eventId,principal,now,FALLBACK_PENDING,nextId,idempotencyKey,hash,plus(now,IDLE_MINUTES)];
    const canClone = `${owned} AND j.destination='device' AND j.state IN ('queued','running') AND j.error_code=?5
      AND j.hold_expires_at>?4 AND j.absolute_expires_at>?4 AND ${noReads('j.id')} AND ${admitted}`;
    let results: D1Result[];
    try {
      results = await this.db.batch([
        this.db.prepare(`UPDATE export_jobs AS j SET state='cancelled',execution_transition=execution_transition+1,completed_at=?4
          WHERE ${canClone}`).bind(...bindings.slice(0,5)),
        this.db.prepare(`INSERT INTO export_jobs (id,event_id,kind,destination,state,snapshot_at,media_count,total_bytes,created_at,
          execution_protocol,source_json,request_digest,idempotency_key,initiating_principal,hold_expires_at,absolute_expires_at)
          SELECT ?6,j.event_id,'selection','archive','queued',j.snapshot_at,j.media_count,j.total_bytes,?4,'selection-v1',
            json_set(j.source_json,'$.fallbackFrom',j.id),?8,?7,j.initiating_principal,
            min(?9,${eventCeiling('j.event_id')}),${eventCeiling('j.event_id')}
          FROM export_jobs j WHERE ${owned} AND changes()=1 AND j.state='cancelled' AND j.error_code=?5 AND j.completed_at=?4
            AND j.hold_expires_at>?4 AND j.absolute_expires_at>?4 AND ${admitted}
            AND NOT EXISTS (SELECT 1 FROM export_jobs WHERE event_id=?2 AND initiating_principal=?3 AND idempotency_key=?7)`)
          .bind(...bindings),
        this.db.prepare(`INSERT INTO export_media_entries (export_job_id,${entryColumns})
          SELECT ?2,${entryColumns} FROM export_media_entries WHERE export_job_id=?1
            AND EXISTS (SELECT 1 FROM export_jobs WHERE id=?2)`).bind(jobId,nextId),
        // Reacquisition checks exact frozen bytes; never evaluate the old filter again.
        this.db.prepare(`UPDATE export_jobs AS j SET media_count=CASE WHEN
          (SELECT count(*) FROM export_media_entries WHERE export_job_id=j.id)=j.media_count
          AND (SELECT sum(COALESCE(byte_size,declared_byte_size)) FROM export_media_entries WHERE export_job_id=j.id)=j.total_bytes
          AND NOT EXISTS (SELECT 1 FROM export_media_entries e WHERE e.export_job_id=j.id AND NOT EXISTS (
            SELECT 1 FROM media m JOIN media_object_write_tombstones t ON t.bucket_generation=m.object_bucket_generation AND t.object_key=m.object_key
            WHERE m.id=e.media_id AND m.event_id=j.event_id AND m.upload_state='stored'
              AND m.object_bucket_generation=e.object_bucket_generation AND m.object_key=e.object_key
              AND ((m.trashed_at IS NULL AND m.deleted_at IS NULL)
                OR (m.trashed_at IS NOT NULL AND m.deleted_at=m.trashed_at))
              AND t.suppression_started_at IS NULL))
          THEN media_count ELSE NULL END WHERE j.id=?1`).bind(nextId),
      ]);
    } catch (error) { sourceFailure(error); }
    if (results[1]?.meta.changes !== 1) {
      const replayed = await this.replay(eventId,principal,idempotencyKey,hash,now); if (replayed) return replayed;
      const capabilities=await this.capabilities(eventId,principal);
      if (!capabilities.enabled) throw paused();
      if (capabilities.activeJob && capabilities.activeJob.id!==jobId) throw activeConflict();
      throw busy();
    }
    return view(await this.row(eventId,nextId,principal,now));
  }
}

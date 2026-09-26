import type { AppEnv } from '../env';
import { MediaRepository } from '../db/media';
import { UploadTransferRepository, type TransferIdentity } from '../db/upload-transfers';
import type { UploadAuthority } from '../services/upload-authority';
import { classifyInstanceStatus } from './cover-platform';

async function schemaPresent(env: AppEnv) {
  return !!await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='media_upload_transfers'").first();
}
interface CleanupTransfer {
  id:string;media_id:string;event_id:string;authority_kind:UploadAuthority['kind'];actor_session_id:string;
  event_session_id:string|null;host_session_id:string|null;account_id:string|null;state:string;
  expires_at:string;hard_expires_at:string;
}
function identity(row: CleanupTransfer): TransferIdentity {
  const authority: UploadAuthority = row.authority_kind === 'manager-account'
    ? {kind:row.authority_kind,actorSessionId:row.actor_session_id,hostSessionId:row.host_session_id!,accountId:row.account_id!}
    : {kind:row.authority_kind,actorSessionId:row.actor_session_id,eventSessionId:row.event_session_id!};
  return {transferId:row.id,mediaId:row.media_id,eventId:row.event_id,authority};
}

/** Bounded and durable. Lease expiry alone is never proof that a writer settled. */
export async function cleanupUploadTransfers(env: AppEnv, now = new Date(), eventId?: string): Promise<number> {
  if (!await schemaPresent(env)) return 0;
  const at = now.toISOString(); const repository = new UploadTransferRepository(env.DB);
  // Retire only the temporary assembly after the final delivery and the entire
  // completion writer have settled. This leaves original and preview ownership.
  await env.DB.prepare(`UPDATE media_upload_assemblies SET state='suppressed',suppression_started_at=COALESCE(suppression_started_at,?),updated_at=?
    WHERE state='completed' AND writer_settled_at IS NOT NULL AND EXISTS (SELECT 1 FROM media_upload_transfers t
      WHERE t.id=transfer_id AND t.state='delivered' ${eventId ? 'AND t.event_id=?' : ''})`).bind(at,at,...(eventId ? [eventId] : [])).run();
  const rows = await env.DB.prepare(`SELECT t.* FROM media_upload_transfers t WHERE ${eventId ? 't.event_id = ? AND' : ''}
    (t.state IN ('receiving','processing','retryable') OR EXISTS (SELECT 1 FROM media_upload_assemblies a WHERE a.transfer_id=t.id AND a.state<>'absent')
      OR (t.state IN ('aborted','expired','rejected') AND EXISTS (SELECT 1 FROM media m WHERE m.id=t.media_id AND m.upload_state='reserved')))
    ORDER BY t.updated_at,t.id LIMIT 100`).bind(...(eventId ? [eventId] : [])).all<CleanupTransfer>();
  let cleaned = 0;
  for (const row of rows.results) {
    if (['receiving','processing','retryable'].includes(row.state)) {
      await repository.fenceIfUnwritable(identity(row),at);
    }
    // Resume quota release if a previous pass died after the generation fence.
    const terminal = await env.DB.prepare("SELECT 1 FROM media_upload_transfers WHERE id=? AND state IN ('aborted','expired','rejected')").bind(row.id).first();
    if (terminal) {
      await new MediaRepository(env.DB).failReservation(row.media_id);
    }
    // Rotate inspected records without extending any reservation or lease.
    await env.DB.prepare('UPDATE media_upload_transfers SET updated_at=? WHERE id=?').bind(at,row.id).run();
    // An unclaimed intent cannot have reached R2. This races the same SQL claim
    // fence, so the external create cannot start after this update.
    await env.DB.prepare(`UPDATE media_upload_assemblies SET state='absent',create_settled_at=?,writer_settled_at=?,
      multipart_closed_at=?,absence_verified_at=?,updated_at=?
      WHERE transfer_id=? AND state='suppressed' AND completion_token IS NULL AND multipart_upload_id IS NULL AND create_settled_at IS NULL`)
      .bind(at,at,at,at,at,row.id).run();
    const assemblies = await env.DB.prepare(`SELECT * FROM media_upload_assemblies WHERE transfer_id=? AND state='suppressed' ORDER BY attempt LIMIT 10`)
      .bind(row.id).all<{id:string;attempt:number;object_key:string;multipart_upload_id:string|null;create_settled_at:string|null;writer_settled_at:string|null;multipart_closed_at:string|null}>();
    for (const assembly of assemblies.results) {
      if (!assembly.multipart_upload_id || !assembly.create_settled_at) continue;
      try {
        if (!assembly.multipart_closed_at) {
          await env.CANONICAL_MEDIA_BUCKET.resumeMultipartUpload(assembly.object_key,assembly.multipart_upload_id).abort();
          await env.DB.prepare("UPDATE media_upload_assemblies SET multipart_closed_at=COALESCE(multipart_closed_at,?),updated_at=? WHERE id=? AND state='suppressed'")
            .bind(at,at,assembly.id).run();
        }
        if (!assembly.writer_settled_at) {
          // Lease age is not termination proof. Only a fresh platform response
          // can settle an interrupted Workflow owner; unknown status is retained.
          try {
            const instance = await env.UPLOAD_COMPLETION_WORKFLOW.get(`image-upload-${row.id}-${assembly.attempt}`);
            let state = classifyInstanceStatus(await instance.status());
            if (state.kind==='status' && ['queued','running','waiting','waitingForPause','paused'].includes(state.status)) {
              await instance.terminate(); state = classifyInstanceStatus(await instance.status());
            }
            if (state.kind==='status' && ['complete','errored','terminated'].includes(state.status)) {
              await env.DB.prepare("UPDATE media_upload_assemblies SET writer_settled_at=COALESCE(writer_settled_at,?),updated_at=? WHERE id=? AND state='suppressed'").bind(at,at,assembly.id).run();
              assembly.writer_settled_at=at;
            }
          } catch { /* Uncertain platform lookup cannot release the writer fence. */ }
        }
        const unfinished = await env.DB.prepare('SELECT 1 FROM media_upload_parts WHERE transfer_id=? AND writer_settled_at IS NULL LIMIT 1').bind(row.id).first();
        if (!assembly.writer_settled_at || unfinished) continue;
        // Completion can land an object after an earlier abort. Delete/head only
        // after explicit settlement; wall-clock age never supplies that proof.
        await env.CANONICAL_MEDIA_BUCKET.delete(assembly.object_key);
        if (await env.CANONICAL_MEDIA_BUCKET.head(assembly.object_key)) continue;
        const marked = await env.DB.prepare(`UPDATE media_upload_assemblies SET state='absent',absence_verified_at=?,updated_at=?
          WHERE id=? AND state='suppressed' AND create_settled_at IS NOT NULL AND writer_settled_at IS NOT NULL AND multipart_closed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM media_upload_parts WHERE transfer_id=? AND writer_settled_at IS NULL) RETURNING id`)
          .bind(at,at,assembly.id,row.id).run();
        cleaned += marked.results.length;
      } catch {
        // Ambiguous abort/delete/head results leave retriable inventory. Even an
        // R2 "not found" exception is not silently promoted to abort proof.
      }
    }
  }
  return cleaned;
}

/** Recheck even if an earlier purge pass recorded its R2/relational phase. */
export async function eventHasUploadInventory(env: AppEnv, eventId: string): Promise<boolean> {
  if (!await schemaPresent(env)) return false;
  return !!await env.DB.prepare(`SELECT 1 FROM media_upload_transfers t WHERE t.event_id=? AND
    (t.state IN ('receiving','processing','retryable')
      OR EXISTS (SELECT 1 FROM media_upload_assemblies a WHERE a.transfer_id=t.id AND a.state<>'absent')
      OR EXISTS (SELECT 1 FROM media_upload_parts p WHERE p.transfer_id=t.id AND p.writer_settled_at IS NULL)) LIMIT 1`)
    .bind(eventId).first();
}

export async function purgeUploadInventory(env: AppEnv, eventId: string): Promise<void> {
  if (!await schemaPresent(env)) return;
  if (await eventHasUploadInventory(env,eventId)) throw new Error('Upload cleanup proof is incomplete.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM media_processing WHERE media_id IN (SELECT id FROM media WHERE event_id=?)').bind(eventId),
    env.DB.prepare('DELETE FROM media_upload_parts WHERE transfer_id IN (SELECT id FROM media_upload_transfers WHERE event_id=?)').bind(eventId),
    env.DB.prepare('DELETE FROM media_upload_assemblies WHERE transfer_id IN (SELECT id FROM media_upload_transfers WHERE event_id=?)').bind(eventId),
    env.DB.prepare('DELETE FROM media_upload_transfers WHERE event_id=?').bind(eventId),
  ]);
}

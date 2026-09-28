import type { AppEnv } from '../env';
import { ApiError } from '../../shared/errors';
import { DecoderError } from '../../shared/image-decoder-contract';
import { KNOWN_IMAGE_FORMATS } from '../../shared/image-formats';
import { MediaRepository, type AssemblyIngressProof } from '../db/media';
import { MediaProcessingRepository } from '../db/media-processing';
import { EventsRepository } from '../db/events';
import { resolveMediaTimelineSource } from '../media-timeline';
import { UploadTransferRepository, type CompletionWork } from '../db/upload-transfers';
import { admittedImageDecoder, pinnedImageQualification } from '../mobile-image-release';
import { openPinnedImage, sha256ImageStream, r2ImageReader } from '../storage/image-source';
import { finalizedMediaObjectKey } from '../storage/media-keys';
import { secureImagePreview } from '../storage/previews';
import { recordOriginalRead } from '../observability/image-metrics';
import { classifyInstanceStatus, classifyWorkflowLookupError, dispositionForLookup } from './cover-platform';
import { cleanupUploadTransfers } from './upload-transfer-cleanup';

export interface UploadCompletionPayload {transferId:string;attempt:number}
const timestamp = () => new Date().toISOString();
export const uploadCompletionId = (payload:UploadCompletionPayload) => `image-upload-${payload.transferId}-${payload.attempt}`;
class CompletionFenced extends Error {}

/** Unknown lookup is never "missing". Replaying this exact createBatch ID is safe. */
export async function dispatchUploadCompletion(env:AppEnv, payload:UploadCompletionPayload): Promise<void> {
  const id = uploadCompletionId(payload);
  try {await env.UPLOAD_COMPLETION_WORKFLOW.createBatch([{id,params:payload}]);}
  catch { /* The durable processing claim remains the recovery inventory. */ }
  try {
    const instance = await env.UPLOAD_COMPLETION_WORKFLOW.get(id);
    const disposition = dispositionForLookup(classifyInstanceStatus(await instance.status()));
    if (disposition.recovery==='resume') await instance.resume();
    // A completed/errored run may be restarted only after its own writer settled.
    if (disposition.recovery==='restart') {
      await env.DB.prepare(`UPDATE media_upload_assemblies SET writer_settled_at=?,updated_at=? WHERE transfer_id=? AND attempt=?
        AND state='completing' AND writer_settled_at IS NULL AND completion_lease_expires_at<=?
        AND EXISTS (SELECT 1 FROM media_upload_transfers t WHERE t.id=transfer_id AND t.state IN ('processing','retryable') AND t.expires_at>? AND t.hard_expires_at>?)`)
        .bind(timestamp(),timestamp(),payload.transferId,payload.attempt,timestamp(),timestamp(),timestamp()).run();
      const settled = await env.DB.prepare(`SELECT 1 FROM media_upload_transfers t JOIN media_upload_assemblies a ON a.transfer_id=t.id
        AND a.attempt=t.attempt WHERE t.id=? AND t.attempt=? AND t.state IN ('processing','retryable')
        AND a.state='completing' AND a.writer_settled_at IS NOT NULL`).bind(payload.transferId,payload.attempt).first();
      if (settled) await instance.restart();
    }
  } catch (error) {classifyWorkflowLookupError(error);}
}

export async function reconcileUploadCompletions(env:AppEnv, now=new Date()): Promise<void> {
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='media_upload_transfers'").first()) return;
  const rows = await env.DB.prepare(`SELECT id,attempt FROM media_upload_transfers WHERE state IN ('processing','retryable')
    AND expires_at>? AND hard_expires_at>? ORDER BY updated_at,id LIMIT 50`).bind(now.toISOString(),now.toISOString()).all<{id:string;attempt:number}>();
  for (const row of rows.results) await dispatchUploadCompletion(env,{transferId:row.id,attempt:row.attempt});
}

async function live(repository:UploadTransferRepository, work:CompletionWork) {
  const current = await repository.getWritable(work.transfer,timestamp());
  if (!current.ok || current.value.generation!==work.claim.generation || current.value.attempt!==work.claim.attempt) throw new CompletionFenced();
}

async function withHeartbeat<T>(repository:UploadTransferRepository, work:CompletionWork, run:(signal:AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController(); let pulse = Promise.resolve(); let stopped = false;
  const timer = setInterval(() => {
    pulse = pulse.then(async () => {
      if (stopped) return;
      const renewed = await repository.renewCompletionLease(work.transfer,work.claim,timestamp());
      if (!renewed.ok) {abort.abort(); return;}
      work.claim.leaseExpiresAt = renewed.value.leaseExpiresAt;
    }).catch(() => {abort.abort();});
  },30_000);
  try {return await run(abort.signal);}
  finally {clearInterval(timer); stopped=true; await pulse; abort.abort();}
}

export async function processUploadCompletion(env: AppEnv, payload: UploadCompletionPayload): Promise<void> {
  if (!/^[a-zA-Z0-9-]{1,100}$/u.test(payload.transferId) || !Number.isSafeInteger(payload.attempt) || payload.attempt<1) return;
  const transfers = new UploadTransferRepository(env.DB); const media = new MediaRepository(env.DB);
  const identity = await transfers.completionIdentity(payload.transferId,payload.attempt); if (!identity) return;
  const work = await transfers.beginCompletion(identity,timestamp()); if (!work) return;
  const processing = new MediaProcessingRepository(env.DB);
  try {
    await withHeartbeat(transfers,work,async (signal) => {
      await live(transfers,work);
      let head = await env.CANONICAL_MEDIA_BUCKET.head(work.assembly.objectKey);
      if (!head) {
        const parts = await transfers.completionParts(work);
        if (parts.length!==work.transfer.partCount || parts.some((part,index) => part.partNumber!==index+1 || !part.etag)) throw new CompletionFenced();
        await live(transfers,work);
        try {await env.CANONICAL_MEDIA_BUCKET.resumeMultipartUpload(work.assembly.objectKey,work.assembly.uploadId!).complete(parts);}
        catch { /* A lost complete response can still have published this unique key. */ }
        head = await env.CANONICAL_MEDIA_BUCKET.head(work.assembly.objectKey);
      }
      if (!head) throw new DecoderError('unavailable');
      if (head.size!==work.transfer.byteSize || (work.assembly.completedEtag && work.assembly.completedEtag!==head.etag)) throw new DecoderError('malformed');
      if (!await transfers.recordAssemblyObject(work,head.etag,timestamp())) throw new CompletionFenced();
      await live(transfers,work);
      const sourceSha256 = work.assembly.expectedSha256 ?? await sha256ImageStream(
        (await openPinnedImage(env.CANONICAL_MEDIA_BUCKET,work.assembly.objectKey,head.etag,head.size)).body,head.size,signal);
      if (!await transfers.recordAssemblyHash(work,sourceSha256,timestamp())) throw new CompletionFenced();
      if (!pinnedImageQualification(work.transfer.declared,work.transfer.buildFingerprint,work.transfer.byteSize)) throw new DecoderError('unavailable');
      const preview = await admittedImageDecoder(env,[work.transfer.buildFingerprint],'upload').renderOriginalPreview({
        declared:work.transfer.declared,byteSize:head.size,signal,
        open:async () => {
          await live(transfers,work); const source=await openPinnedImage(env.CANONICAL_MEDIA_BUCKET,work.assembly.objectKey,head!.etag,head!.size);
          recordOriginalRead(env,identity.eventId,'native-decode',source.size); return source.body;
        },
      });
      const decoded = {family:preview.inspection.family,mimeType:KNOWN_IMAGE_FORMATS[preview.inspection.family].mimeType,requiresSequence:preview.inspection.isSequence};
      if (preview.inspection.sourceSha256!==sourceSha256
        || !pinnedImageQualification(work.transfer.declared,work.transfer.buildFingerprint,head.size,preview.inspection.isSequence)
        || !pinnedImageQualification(decoded,work.transfer.buildFingerprint,head.size)) {
        await preview.body.cancel(); throw new DecoderError('malformed');
      }
      if (!await processing.recordInspection(identity,work.claim,preview.inspection,timestamp())) {await preview.body.cancel(); throw new CompletionFenced();}
      const reserved = await media.getById(identity.mediaId); if (!reserved) {await preview.body.cancel(); throw new CompletionFenced();}
      await secureImagePreview(env,reserved,work.claim.attempt,preview);
      await live(transfers,work);
      const proof:AssemblyIngressProof = {transferId:identity.transferId,assemblyId:work.assembly.id,generation:work.claim.generation,attempt:work.claim.attempt,completionToken:work.claim.token};
      const claim = await media.claimReservationIngress({mediaId:reserved.id,eventId:reserved.eventId,authority:identity.authority,
        sourceObjectKey:reserved.objectKey,mimeType:reserved.mimeType,byteSize:head.size,sha256:sourceSha256,
        width:preview.inspection.width,height:preview.inspection.height,claimToken:work.claim.token,claimedAt:timestamp(),leaseExpiresAt:work.claim.leaseExpiresAt,assemblyProof:proof});
      if (!claim.ok) throw new CompletionFenced();
      const finalKey = finalizedMediaObjectKey(reserved.eventId,reserved.id);
      await media.ensureFinalObjectWriteTombstone(reserved.id,finalKey,timestamp());
      await live(transfers,work);
      const exact = await openPinnedImage(env.CANONICAL_MEDIA_BUCKET,work.assembly.objectKey,head.etag,head.size);
      const digest = Uint8Array.from(sourceSha256.match(/../gu)!.map((hex) => Number.parseInt(hex,16))).buffer;
      try {await env.CANONICAL_MEDIA_BUCKET.put(finalKey,exact.body,{onlyIf:{etagDoesNotMatch:'*'},sha256:digest,httpMetadata:{contentType:reserved.mimeType}});}
      catch { /* Resolve uncertain success by comparing the immutable final below. */ }
      const final = await env.CANONICAL_MEDIA_BUCKET.head(finalKey);
      if (!final || final.size!==head.size || final.httpMetadata?.contentType!==reserved.mimeType) throw new DecoderError('unavailable');
      const finalRead = await openPinnedImage(env.CANONICAL_MEDIA_BUCKET,finalKey,final.etag,final.size);
      if (await sha256ImageStream(finalRead.body,final.size,signal)!==sourceSha256) throw new ApiError('UPLOAD_FINALIZE_CONFLICT','This photo conflicts with bytes already secured.',409);
      await live(transfers,work);
      const event = await new EventsRepository(env.DB).getById(identity.eventId); if (!event) throw new CompletionFenced();
      const timeline = await resolveMediaTimelineSource({mimeType:reserved.mimeType,
        source:r2ImageReader(env.CANONICAL_MEDIA_BUCKET,work.assembly.objectKey,head.etag,head.size),
        eventStartAt:event.eventStartAt,eventTimezone:event.eventTimezone,storedAt:timestamp()});
      // Metadata is another asynchronous R2 read. Never commit using the time
      // from before it: an actor, transfer or completion lease can expire there.
      await live(transfers,work);
      if (signal.aborted) throw new CompletionFenced();
      const at = timestamp();
      try {
        const committed = await media.commitReservationIngress({mediaId:reserved.id,eventId:reserved.eventId,authority:identity.authority,
          claimToken:work.claim.token,finalObjectKey:finalKey,byteSize:head.size,width:preview.inspection.width,height:preview.inspection.height,
          finalEtag:final.etag,committedAt:at,capturedAt:timeline.capturedAt,timelineAt:timeline.timelineSource==='received' ? at : timeline.timelineAt,assemblyProof:proof,sourceSha256});
        if (!committed.ok) throw new CompletionFenced();
      } catch (error) {
        const current = await media.getById(reserved.id);
        if (current?.uploadState!=='stored' || current.deletedAt!==null || current.objectKey!==finalKey) throw error;
      }
    });
  } catch (error) {
    if (error instanceof CompletionFenced || !(await transfers.getWritable(identity,timestamp())).ok) return;
    const failure = error instanceof DecoderError ? error.code : 'unavailable';
    await processing.recordFailure(identity,work.claim,failure,timestamp());
    const retryable = failure==='busy' || failure==='unavailable';
    await transfers.failCompletion(work,retryable,timestamp());
    if (!retryable) await media.failReservation(identity.mediaId);
    else throw new DecoderError(failure);
  } finally {
    await transfers.settleCompletion(work,timestamp());
    await cleanupUploadTransfers(env,new Date(),identity.eventId);
  }
}

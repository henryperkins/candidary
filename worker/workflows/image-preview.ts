import type { AppEnv } from '../env';
import type { MediaRecord } from '../db/types';
import { MediaRepository } from '../db/media';
import { ImagePreviewRepository, type ImagePreviewRecord } from '../db/image-previews';
import { MediaObjectWriteTombstoneRepository } from '../db/media-write-tombstones';
import { DecoderError, DECODER_PREVIEW_PROFILE } from '../../shared/image-decoder-contract';
import { resolveImageDeclaration, KNOWN_IMAGE_FORMATS } from '../../shared/image-formats';
import { admittedImageDecoder, mobileImageSchemaReady, pinnedImageQualification, previewDecoderFingerprints } from '../mobile-image-release';
import { openPinnedImage } from '../storage/image-source';
import { recordOriginalRead } from '../observability/image-metrics';
import { previewUnavailable, storeOwnedPreview, storedImageSourceSha } from '../storage/previews';
import { classifyInstanceStatus, dispositionForLookup } from './cover-platform';

export interface ImagePreviewPayload {mediaId:string;previewId:string;attempt:number}
export const imagePreviewId=(payload:ImagePreviewPayload) => `image-preview-${payload.previewId}-${payload.attempt}`;
const timestamp=() => new Date().toISOString();
const payloadFor=(record:ImagePreviewRecord):ImagePreviewPayload => ({mediaId:record.mediaId,previewId:record.id,attempt:1});

async function dispatch(env:AppEnv, record:ImagePreviewRecord): Promise<void> {
  if (record.producerKind!=='workflow' || record.state!=='pending' || record.runCount>=3
    || (record.failureCode!==null && !['busy','unavailable'].includes(record.failureCode))) return;
  const payload=payloadFor(record); const id=imagePreviewId(payload);
  try {await env.IMAGE_PREVIEW_WORKFLOW.createBatch([{id,params:payload}]);} catch { /* Same id remains in durable inventory. */ }
  try {
    const instance=await env.IMAGE_PREVIEW_WORKFLOW.get(id);
    const disposition=dispositionForLookup(classifyInstanceStatus(await instance.status()));
    if (disposition.recovery==='resume') await instance.resume();
    if (disposition.recovery==='restart') {
      const repository=new ImagePreviewRepository(env.DB); let current=await repository.get(record.id);
      if (current?.state==='pending' && !current.writerSettledAt && current.writerLeaseExpiresAt<=timestamp()) {
        await env.DB.prepare(`UPDATE media_image_previews SET writer_settled_at=?,updated_at=? WHERE id=? AND claim_token=?
          AND state='pending' AND sha256 IS NULL`).bind(timestamp(),timestamp(),current.id,current.claimToken).run();
        current=await repository.get(record.id);
      }
      if (current?.state==='pending' && current.writerSettledAt && current.runCount<3) await instance.restart();
    }
  } catch { /* Unknown lookup never certifies absence or writer settlement. */ }
}

export async function requestImagePreview(env:AppEnv, media:MediaRecord, sourceSha256:string): Promise<void> {
  const declared=resolveImageDeclaration('',media.mimeType);
  if (!declared || !media.byteSize || !previewDecoderFingerprints(declared,media.byteSize).length) return;
  const now=new Date(); const repository=new ImagePreviewRepository(env.DB);
  const owned=await repository.claim({mediaId:media.id,eventId:media.eventId,sourceSha256,profile:DECODER_PREVIEW_PROFILE,
    mimeType:'image/webp',now:now.toISOString(),leaseExpiresAt:new Date(now.getTime()+480_000).toISOString(),queued:true});
  if (owned) {
    await repository.retireOtherProfiles(media.id,sourceSha256,DECODER_PREVIEW_PROFILE,timestamp());
    await dispatch(env,owned.record);
  }
}

export async function processImagePreview(env:AppEnv, payload:ImagePreviewPayload): Promise<void> {
  if (payload.attempt!==1 || typeof payload.previewId!=='string' || typeof payload.mediaId!=='string') return;
  const repository=new ImagePreviewRepository(env.DB); const found=await repository.get(payload.previewId);
  if (!found || found.mediaId!==payload.mediaId || found.profile!==DECODER_PREVIEW_PROFILE) return;
  const record=await repository.begin(found,timestamp()); if (!record) return;
  try {
    const media=await new MediaRepository(env.DB).getById(record.mediaId);
    if (!media || media.uploadState!=='stored' || media.deletedAt || media.trashedAt || !media.byteSize) return;
    const declared=resolveImageDeclaration('',media.mimeType); if (!declared) throw new DecoderError('unsupported');
    const fingerprints=previewDecoderFingerprints(declared,media.byteSize);
    if (!fingerprints.length || await storedImageSourceSha(env,media.id)!==record.sourceSha256) throw new DecoderError('unavailable');
    const bucket=media.objectBucketGeneration==='canonical' ? env.CANONICAL_MEDIA_BUCKET : env.MEDIA_BUCKET;
    const head=await bucket.head(media.objectKey);
    if (!head || head.size!==media.byteSize) throw new DecoderError('unavailable');
    const preview=await admittedImageDecoder(env,fingerprints,'preview').renderOriginalPreview({declared,byteSize:head.size,
      open:async () => {
        const current=await new MediaRepository(env.DB).getById(media.id);
        const ownership=await repository.get(record.id);
        if (!current || current.uploadState!=='stored' || current.deletedAt || current.objectKey!==media.objectKey
          || ownership?.state!=='pending' || ownership.claimToken!==record.claimToken || ownership.writerLeaseExpiresAt<=timestamp()) throw previewUnavailable();
        const source=await openPinnedImage(bucket,media.objectKey,head.etag,head.size);
        recordOriginalRead(env,media.eventId,'native-decode',source.size); return source.body;
      }});
    const actual={family:preview.inspection.family,mimeType:KNOWN_IMAGE_FORMATS[preview.inspection.family].mimeType,requiresSequence:preview.inspection.isSequence};
    if (preview.inspection.sourceSha256!==record.sourceSha256
      || !pinnedImageQualification(declared,preview.inspection.buildFingerprint,head.size,preview.inspection.isSequence)
      || !pinnedImageQualification(actual,preview.inspection.buildFingerprint,head.size)) {
      await preview.body.cancel(); throw new DecoderError('malformed');
    }
    await storeOwnedPreview(env,record,preview);
  } catch (error) {
    const code=error instanceof DecoderError ? error.code : 'unavailable';
    await repository.fail(record,code,timestamp());
    if (code==='busy' || code==='unavailable') throw new DecoderError(code);
  } finally {await repository.settleWriter(record,timestamp());}
}

export async function reconcileImagePreviews(env:AppEnv): Promise<void> {
  if (!await mobileImageSchemaReady(env.DB)) return;
  const rows=await env.DB.prepare("SELECT id FROM media_image_previews WHERE state='pending' AND producer_kind='workflow' AND run_count<3 ORDER BY updated_at,id LIMIT 50").all<{id:string}>();
  const repository=new ImagePreviewRepository(env.DB);
  for (const row of rows.results) {
    const record=await repository.get(row.id); if (record) await dispatch(env,record);
    await env.DB.prepare('UPDATE media_image_previews SET updated_at=? WHERE id=?').bind(timestamp(),row.id).run();
  }
}

export async function cleanupImagePreviews(env:AppEnv, now=new Date(), eventId?:string): Promise<number> {
  if (!await mobileImageSchemaReady(env.DB)) return 0;
  const at=now.toISOString(); const repository=new ImagePreviewRepository(env.DB); const tombstones=new MediaObjectWriteTombstoneRepository(env.DB);
  const rows=await env.DB.prepare(`SELECT id FROM media_image_previews WHERE state='suppressed' ${eventId ? 'AND event_id=?' : ''} ORDER BY updated_at,id LIMIT 50`)
    .bind(...(eventId ? [eventId] : [])).all<{id:string}>();
  let cleaned=0;
  for (const row of rows.results) {
    let record=await repository.get(row.id); if (!record) continue;
    try {
      if (!record.writerSettledAt && record.producerKind==='workflow' && record.writerLeaseExpiresAt<=at) {
        const instance=await env.IMAGE_PREVIEW_WORKFLOW.get(imagePreviewId(payloadFor(record)));
        let state=await instance.status();
        if (['queued','running','waiting','waitingForPause','paused'].includes(state.status)) {await instance.terminate(); state=await instance.status();}
        if (['complete','errored','terminated'].includes(state.status)) {
          // A terminal process does not prove an already-issued R2 PUT settled.
          // Only a pre-PUT claim can be fenced by database proof alone.
          await env.DB.prepare(`UPDATE media_image_previews SET writer_settled_at=?,updated_at=? WHERE id=?
            AND claim_token=? AND state='suppressed' AND sha256 IS NULL`).bind(at,at,record.id,record.claimToken).run();
        }
      }
      record=await repository.get(row.id);
      if (!record?.writerSettledAt || record.state!=='suppressed') continue;
      if (!await tombstones.beginSuppression(record.objectKey,at,'canonical')) continue;
      await env.CANONICAL_MEDIA_BUCKET.delete(record.objectKey);
      if (await env.CANONICAL_MEDIA_BUCKET.head(record.objectKey)) continue;
      if (await repository.recordAbsence(record,at)) cleaned++;
      await tombstones.recordObservation({bucketGeneration:'canonical',objectKey:record.objectKey,observedAt:at,present:false,nextCheckAt:new Date(now.getTime()+3600_000).toISOString()});
    } catch { /* Keep unresolved inventory, including all unknown platform outcomes. */ }
    finally {await env.DB.prepare('UPDATE media_image_previews SET updated_at=? WHERE id=?').bind(at,row.id).run();}
  }
  return cleaned;
}

export async function eventHasImagePreviewInventory(env:AppEnv, eventId:string): Promise<boolean> {
  if (!await mobileImageSchemaReady(env.DB)) return false;
  return !!await env.DB.prepare(`SELECT 1 FROM media_image_previews WHERE event_id=?
    AND (state<>'suppressed' OR writer_settled_at IS NULL OR absence_verified_at IS NULL) LIMIT 1`).bind(eventId).first();
}
export async function purgeImagePreviewInventory(env:AppEnv, eventId:string): Promise<void> {
  if (!await mobileImageSchemaReady(env.DB)) return;
  if (await eventHasImagePreviewInventory(env,eventId)) throw new Error('Preview cleanup proof is incomplete.');
  await env.DB.prepare('DELETE FROM media_image_previews WHERE event_id=?').bind(eventId).run();
}

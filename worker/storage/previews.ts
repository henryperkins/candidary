import { ApiError } from '../../shared/errors';
import { createHash } from 'node:crypto';
import { DECODER_ANIMATED_PREVIEW_BYTES, DECODER_STILL_PREVIEW_BYTES, DECODER_PREVIEW_PROFILE, type DecoderPreview } from '../../shared/image-decoder-contract';
import { isLegacyUploadMimeType } from '../../shared/image-formats';
import { ImagePreviewRepository, type ImagePreviewRecord } from '../db/image-previews';
import type { MediaRecord } from '../db/types';
import type { AppEnv } from '../env';
import { openPinnedImage, sha256ImageStream } from './image-source';
import { mobileImageSchemaReady } from '../mobile-image-release';
import { recordOriginalRead, recordPreviewRead } from '../observability/image-metrics';
import { requestImagePreview } from '../workflows/image-preview';

export const previewUnavailable = () => new ApiError('IMAGE_PREVIEW_UNAVAILABLE','This photo preview is temporarily unavailable.',503);
const timestamp = () => new Date().toISOString();
type PreviewObject = {body:ReadableStream<Uint8Array>;size:number;httpMetadata?:R2HTTPMetadata};

async function boundedBytes(body:ReadableStream<Uint8Array>, limit:number, exact?:number): Promise<Uint8Array<ArrayBuffer>> {
  const bytes=new Uint8Array(exact ?? limit); const reader=body.getReader(); let size=0;
  try {
    for (;;) {
      const part=await reader.read(); if (part.done) break;
      if (part.value.byteLength>bytes.length-size) throw previewUnavailable();
      bytes.set(part.value,size); size+=part.value.byteLength;
    }
    if (size===0 || (exact!==undefined && size!==exact)) throw previewUnavailable();
    return bytes.slice(0,size);
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

export async function readStoredPreview(env:AppEnv, record:ImagePreviewRecord): Promise<PreviewObject|null> {
  if (record.state!=='ready' || !record.byteSize || record.byteSize>DECODER_ANIMATED_PREVIEW_BYTES || !record.etag || !record.sha256) return null;
  const object=await env.CANONICAL_MEDIA_BUCKET.get(record.objectKey,{onlyIf:{etagMatches:record.etag}});
  if (!object || !('body' in object)) return null;
  if (object.etag!==record.etag || object.size!==record.byteSize || object.httpMetadata?.contentType!==record.mimeType) {await object.body.cancel(); return null;}
  // The ready proof was secured against this exact immutable ETag. Warm views
  // keep R2's stream intact, avoiding one preview-sized buffer per gallery tile.
  const checksum=object.checksums.sha256;
  if (checksum && Array.from(new Uint8Array(checksum),byte => byte.toString(16).padStart(2,'0')).join('')!==record.sha256) {
    await object.body.cancel(); return null;
  }
  return {body:object.body,size:record.byteSize,httpMetadata:{contentType:record.mimeType}};
}

/** Persist proof before PUT; the immutable object is adopted only after pinned verification. */
export async function storeOwnedPreview(env:AppEnv, record:ImagePreviewRecord, preview:DecoderPreview): Promise<void> {
  const repository=new ImagePreviewRepository(env.DB);
  const limit=preview.inspection.isSequence ? DECODER_ANIMATED_PREVIEW_BYTES : DECODER_STILL_PREVIEW_BYTES;
  if (preview.byteSize<1 || preview.byteSize>limit || preview.mimeType!==record.mimeType
    || preview.inspection.sourceSha256!==record.sourceSha256 || preview.inspection.previewProfile!==record.profile) {
    await preview.body.cancel(); throw previewUnavailable();
  }
  const bytes=await boundedBytes(preview.body,limit,preview.byteSize);
  const proof={byteSize:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),width:preview.width,height:preview.height,frameCount:preview.frameCount};
  if (!await repository.recordProof(record,proof,timestamp())) throw previewUnavailable();
  const digest=Uint8Array.from(proof.sha256.match(/../gu)!.map(hex => Number.parseInt(hex,16))).buffer;
  try {await env.CANONICAL_MEDIA_BUCKET.put(record.objectKey,bytes,{onlyIf:{etagDoesNotMatch:'*'},sha256:digest,httpMetadata:{contentType:record.mimeType}});}
  catch { /* A lost PUT response is resolved against its pre-recorded digest. */ }
  const head=await env.CANONICAL_MEDIA_BUCKET.head(record.objectKey);
  if (!head || head.size!==proof.byteSize || head.httpMetadata?.contentType!==record.mimeType) throw previewUnavailable();
  const pinned=await openPinnedImage(env.CANONICAL_MEDIA_BUCKET,record.objectKey,head.etag,head.size);
  if (await sha256ImageStream(pinned.body,head.size)!==proof.sha256) throw previewUnavailable();
  let ready=false;
  try {ready=await repository.markReady(record,{...proof,etag:head.etag},timestamp());} catch { /* Re-read a lost database acknowledgement. */ }
  if (!ready) {
    const current=await repository.get(record.id);
    if (current?.state!=='ready' || current.claimToken!==record.claimToken || current.sha256!==proof.sha256
      || current.etag!==head.etag || current.byteSize!==proof.byteSize) throw previewUnavailable();
  }
}

export async function secureImagePreview(env:AppEnv, media:MediaRecord, attempt:number, preview:DecoderPreview): Promise<void> {
  const proof=await env.DB.prepare(`SELECT 1 FROM media_processing WHERE media_id=? AND state='ready'
    AND attempt=? AND source_sha256=? AND build_fingerprint=? AND preview_profile=?`)
    .bind(media.id,attempt,preview.inspection.sourceSha256,preview.inspection.buildFingerprint,preview.inspection.previewProfile).first();
  if (!proof) {await preview.body.cancel(); throw previewUnavailable();}
  const repository=new ImagePreviewRepository(env.DB);
  const previous=await repository.active(media.id,preview.inspection.sourceSha256,preview.inspection.previewProfile);
  if (previous?.state==='ready') {
    const cached=await readStoredPreview(env,previous);
    if (cached) {await cached.body.cancel(); await preview.body.cancel(); return;}
    await repository.suppress(previous,timestamp());
  } else if (previous?.state==='pending' && previous.producerKind==='upload' && previous.writerSettledAt) {
    await repository.suppress(previous,timestamp());
  }
  const now=new Date(); const owned=await repository.claim({mediaId:media.id,eventId:media.eventId,sourceSha256:preview.inspection.sourceSha256,
    profile:preview.inspection.previewProfile,mimeType:preview.mimeType,now:now.toISOString(),leaseExpiresAt:new Date(now.getTime()+180_000).toISOString()});
  if (!owned?.claimed) {await preview.body.cancel(); throw previewUnavailable();}
  try {
    await storeOwnedPreview(env,owned.record,preview);
    await repository.retireOtherProfiles(media.id,owned.record.sourceSha256,owned.record.profile,timestamp());
  }
  finally {await repository.settleWriter(owned.record,timestamp());}
}

/** This identity survives promotion cleanup; old rows can still use a retained promotion proof. */
export async function storedImageSourceSha(env:AppEnv, mediaId:string): Promise<string|null> {
  return env.DB.prepare(`SELECT coalesce(i.source_sha256,p.source_sha256) AS sha FROM media m
    LEFT JOIN media_processing i ON i.media_id=m.id LEFT JOIN media_object_promotions p ON p.media_id=m.id
    WHERE m.id=? AND m.upload_state='stored' AND m.deleted_at IS NULL`).bind(mediaId).first<string>('sha');
}

export async function getOrCreatePreview(env:AppEnv, media:MediaRecord): Promise<PreviewObject> {
  const schema=await mobileImageSchemaReady(env.DB);
  const sha=schema ? await storedImageSourceSha(env,media.id) : null;
  if (sha) {
    const repository=new ImagePreviewRepository(env.DB);
    const canonical=await repository.active(media.id,sha,DECODER_PREVIEW_PROFILE);
    if (canonical?.state==='ready') {
      const cached=await readStoredPreview(env,canonical);
      if (cached) {recordPreviewRead(env,media.eventId,'persisted-hit',cached.size); return cached;}
      await repository.suppress(canonical,timestamp());
    }
    if (canonical) {await requestImagePreview(env,media,sha); recordPreviewRead(env,media.eventId,'miss-regeneration'); throw previewUnavailable();}
  }
  if (media.previewObjectKey) {
    const cached=await env.MEDIA_BUCKET.get(media.previewObjectKey);
    if (cached?.body && cached.size<=DECODER_ANIMATED_PREVIEW_BYTES) {recordPreviewRead(env,media.eventId,'legacy-hit',cached.size); return cached;}
    await cached?.body.cancel();
  }
  // Images accepts 20 decimal MB. Larger/direct or newly admitted originals use
  // the qualified private service; original delivery never depends on this path.
  if (isLegacyUploadMimeType(media.mimeType) && media.byteSize && media.byteSize<=20_000_000 && env.IMAGES) {
    try {
      const bucket=media.objectBucketGeneration==='canonical' ? env.CANONICAL_MEDIA_BUCKET : env.MEDIA_BUCKET;
      const original=await bucket.get(media.objectKey);
      if (!original?.body || original.size!==media.byteSize || original.size>20_000_000) {await original?.body.cancel(); throw previewUnavailable();}
      recordOriginalRead(env,media.eventId,'images-transform',original.size);
      const transformed=await env.IMAGES.input(original.body).transform({width:1600,height:1600,fit:'scale-down'}).output({format:'image/webp',quality:82});
      const bytes=await boundedBytes(transformed.image(),DECODER_ANIMATED_PREVIEW_BYTES);
      recordPreviewRead(env,media.eventId,'legacy-images',bytes.length);
      return {body:new Response(bytes).body!,size:bytes.length,httpMetadata:{contentType:'image/webp'}};
    } catch { /* A private queued recovery may be available; no original fallback. */ }
  }
  if (sha) await requestImagePreview(env,media,sha);
  recordPreviewRead(env,media.eventId,sha ? 'miss-regeneration' : 'unavailable');
  throw previewUnavailable();
}

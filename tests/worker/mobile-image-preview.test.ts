import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransferHarness, barrier, sha256, transportDng, transportPng } from './fixtures/upload-transfer';
import { createDecoderDouble, decoderInspection } from './fixtures/image-decoder';
import { TEST_FINGERPRINT } from './fixtures/mobile-image-db';
import { eventAccess, resetDatabase, testEnv, trashMedia, writeHeaders, png, seedExportJob } from './helpers';
import { ImagePreviewRepository } from '../../worker/db/image-previews';
import { cleanupImagePreviews, processImagePreview, eventHasImagePreviewInventory, type ImagePreviewPayload } from '../../worker/workflows/image-preview';
import { cleanupMediaObjectWriteTombstones } from '../../worker/workflows/cleanup';
import { createApp } from '../../worker/app';
import type { ImageDeclaration } from '../../shared/image-formats';
import { getOrCreatePreview } from '../../worker/storage/previews';
import { MediaRepository } from '../../worker/db/media';

beforeEach(resetDatabase);
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks(); globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__=undefined;});
async function pending(declared:ImageDeclaration=transportDng, customPreview?:{bytes:Uint8Array<ArrayBuffer>;frames:number}) {
  const bytes = new Uint8Array([1,2,3]); const previewBytes = customPreview?.bytes ?? new Uint8Array([4,5,6]);
  const h = await createTransferHarness({realStorage:true}); await h.reserve(bytes,declared); await h.putPart(0,bytes);
  const decoder = createDecoderDouble({inspection:decoderInspection({family:declared.family,byteSize:bytes.length,sourceSha256:await sha256(bytes),buildFingerprint:TEST_FINGERPRINT,
    frameCount:customPreview?.frames ?? 1,isSequence:(customPreview?.frames ?? 1)>1}),previewBytes,
    transformResponse:r => {r.headers.set('X-Decoder-Environment','production'); return r;}});
  h.setDecoder(decoder.fetch);
  const jobs = new Map<string,{payload:ImagePreviewPayload;status:string}>();
  const workflow = {createBatch:vi.fn(async (batch:Array<{id:string;params:ImagePreviewPayload}>) => {
    for (const job of batch) if (!jobs.has(job.id)) jobs.set(job.id,{payload:job.params,status:'queued'});
    return [];
  }),get:vi.fn(async (id:string) => {
    const job=jobs.get(id); if (!job) throw new Error('Unknown workflow');
    return {status:async () => ({status:job.status}),restart:async () => {job.status='queued';},resume:async () => {job.status='queued';},terminate:async () => {job.status='terminated';}};
  })};
  Object.defineProperty(h.environment,'IMAGE_PREVIEW_WORKFLOW',{value:workflow});
  return {...h,bytes,previewBytes,decoder,jobs,workflow,
    preview:() => h.request(`/api/media/${h.identity.mediaId}/preview`,{headers:{cookie:h.credentials.cookie}}),
    previewRow:() => testEnv.DB.prepare('SELECT * FROM media_image_previews WHERE media_id=? ORDER BY generation DESC LIMIT 1').bind(h.identity.mediaId).first<any>(),
    deliver:async () => {await h.complete(); await h.runCompletion();},
  };
}

describe('private canonical mobile previews', () => {
  it('persists and privately serves an exact 20 MiB animated derivative', async () => {
    const h=await pending({family:'avif',mimeType:'image/avif-sequence',requiresSequence:true},{bytes:new Uint8Array(20*1024*1024).fill(42),frames:2});
    await h.deliver();
    expect(await h.previewRow()).toMatchObject({state:'ready',byte_size:20*1024*1024,frame_count:2,sha256:await sha256(h.previewBytes)});
    h.decoder.requests.length=0;
    const response=await h.preview(); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await sha256(new Uint8Array(await response.arrayBuffer()))).toBe(await sha256(h.previewBytes));
    expect(h.decoder.requests).toHaveLength(0);
  });

  it('serves 48 warm reads from the stored derivative without original reads or native decoding', async () => {
    const h = await pending(); await h.deliver(); h.decoder.requests.length=0;
    const p = await h.previewRow(); const get=vi.spyOn(testEnv.CANONICAL_MEDIA_BUCKET,'get');
    for (let index=0;index<48;index++) {
      const response=await h.preview(); expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(h.previewBytes);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toContain('Cookie');
      expect([...response.headers.keys()].some(k => k.startsWith('x-decoder'))).toBe(false);
    }
    expect(get.mock.calls.every(([key]) => key===p.object_key)).toBe(true);
    expect(h.decoder.requests).toHaveLength(0);
  });

  it('streams a warm immutable derivative without allocating another full preview buffer', async () => {
    const h=await pending(); await h.deliver(); const media=await new MediaRepository(testEnv.DB).getById(h.identity.mediaId);
    const readers=vi.spyOn(ReadableStream.prototype,'getReader');
    const preview=await getOrCreatePreview(h.environment,media!);
    expect(readers).not.toHaveBeenCalled(); await preview.body.cancel();
  });

  it('bounds retryable regeneration without undoing an existing receipt or dispatching one job per view', async () => {
    const h=await pending(); await h.deliver(); await testEnv.CANONICAL_MEDIA_BUCKET.delete((await h.previewRow()).object_key);
    await h.preview(); const job=[...h.jobs.values()][0]!;
    const failing=createDecoderDouble({inspection:decoderInspection(),previewBytes:new Uint8Array(3),failure:'busy',transformResponse:r => {r.headers.set('X-Decoder-Environment','production'); return r;}});
    h.setDecoder(failing.fetch);
    for (let run=0;run<3;run++) await expect(processImagePreview(h.environment,job.payload)).rejects.toThrow();
    const count=failing.requests.length; await processImagePreview(h.environment,job.payload);
    await Promise.all(Array.from({length:8},() => h.preview()));
    expect(h.jobs.size).toBe(1); expect(failing.requests).toHaveLength(count);
    expect((await h.previewRow()).run_count).toBe(3); expect((await h.complete()).status).toBe(200);
  });

  it('persists bounded derivative proof and a tombstone before its create-only PUT', async () => {
    const h=await pending(); let proof:any;
    h.hooks.put=async key => {if (key.includes('/media/previews/')) proof=await testEnv.DB.prepare(`SELECT p.*,t.object_kind FROM media_image_previews p JOIN media_object_write_tombstones t ON t.object_key=p.object_key AND t.bucket_generation='canonical' WHERE p.object_key=?`).bind(key).first();};
    await h.deliver();
    expect(proof).toMatchObject({state:'pending',byte_size:3,sha256:await sha256(h.previewBytes),object_kind:'preview',writer_settled_at:null});
  });

  it('adopts a ready preview when its database acknowledgement is lost', async () => {
    const h=await pending(); const mark=ImagePreviewRepository.prototype.markReady;
    vi.spyOn(ImagePreviewRepository.prototype,'markReady').mockImplementationOnce(async function(this:ImagePreviewRepository,...args) {await mark.apply(this,args); throw new Error('Lost ready acknowledgement');});
    await h.deliver(); expect((await h.previewRow()).state).toBe('ready');
    expect((await h.preview()).status).toBe(200);
  });

  it.each(['missing','corrupt'] as const)('coalesces %s previews and regenerates in the isolated preview lane', async (condition) => {
    const h=await pending(); await h.deliver(); const old=await h.previewRow();
    if (condition==='missing') await testEnv.CANONICAL_MEDIA_BUCKET.delete(old.object_key);
    else await testEnv.CANONICAL_MEDIA_BUCKET.put(old.object_key,new Uint8Array([9,9,9]),{httpMetadata:{contentType:'image/webp'}});
    h.decoder.requests.length=0;
    expect((await Promise.all(Array.from({length:8},() => h.preview()))).every(r => r.status===503)).toBe(true);
    expect(h.jobs.size).toBe(1); const job=[...h.jobs.values()][0]!;
    expect(h.decoder.requests).toHaveLength(0); await processImagePreview(h.environment,job.payload);
    const fresh=await h.previewRow(); expect(fresh.generation).toBe(old.generation+1); expect(fresh.state).toBe('ready');
    expect(h.decoder.requests.filter(r => r.path==='/v1/preview')).toHaveLength(1);
    expect(h.decoder.requests[0]!.headers.get('X-Decoder-Lane')).toBe('preview');
    expect((await h.preview()).status).toBe(200);
  });

  it('rechecks access after a delayed private read and denies a different event', async () => {
    const h=await pending(); await h.deliver(); const other=await eventAccess();
    expect((await h.request(`/api/media/${h.identity.mediaId}/preview`,{headers:{cookie:other.guest.cookie}})).status).toBe(403);
    const p=await h.previewRow(); const originalGet=testEnv.CANONICAL_MEDIA_BUCKET.get.bind(testEnv.CANONICAL_MEDIA_BUCKET); const hold=barrier();
    vi.spyOn(testEnv.CANONICAL_MEDIA_BUCKET,'get').mockImplementation(async (...args:any[]) => {const object=await (originalGet as any)(...args); if (args[0]===p.object_key) await hold.wait(); return object;});
    const reading=h.preview(); await hold.entered; await h.revokeSession(); hold.release();
    expect((await reading).status).not.toBe(200);
  });

  it('retains Trash previews for restore and proves absence after permanent deletion', async () => {
    const h=await pending(); await h.deliver(); const p=await h.previewRow();
    await trashMedia(h.access,h.identity.mediaId);
    await cleanupImagePreviews(h.environment); await cleanupMediaObjectWriteTombstones(h.environment);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(p.object_key)).not.toBeNull();
    expect((await h.preview()).status).toBe(403);
    expect((await createApp().request(`/api/manage/events/${h.identity.eventId}/media/${h.identity.mediaId}/restore`,{method:'POST',headers:writeHeaders(h.access.manager),body:'{}'},h.environment)).status).toBe(200);
    expect((await h.preview()).status).toBe(200);
    await h.deleteMedia(); await cleanupImagePreviews(h.environment);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(p.object_key)).toBeNull();
    expect((await h.previewRow()).absence_verified_at).toBeTruthy();
  });

  it('retains an upload preview writer while deletion cleanup runs before its PUT returns', async () => {
    const h=await pending(); const hold=barrier();
    h.hooks.put=async key => {if (key.includes('/media/previews/')) await hold.wait();};
    const running=h.deliver(); await hold.entered; await h.deleteMedia();
    try {
      await cleanupImagePreviews(h.environment); await cleanupMediaObjectWriteTombstones(h.environment);
      expect((await h.previewRow()).writer_settled_at).toBeNull();
      expect((await h.previewRow()).absence_verified_at).toBeNull();
      expect(await eventHasImagePreviewInventory(h.environment,h.identity.eventId)).toBe(true);
    } finally {hold.release(); await running;}
    await cleanupImagePreviews(h.environment);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head((await h.previewRow()).object_key)).toBeNull();
    expect(await eventHasImagePreviewInventory(h.environment,h.identity.eventId)).toBe(false);
  });

  it('adopts an ambiguous preview PUT without a second object or a second decode', async () => {
    const h=await pending(); const put=testEnv.CANONICAL_MEDIA_BUCKET.put.bind(testEnv.CANONICAL_MEDIA_BUCKET);
    vi.spyOn(testEnv.CANONICAL_MEDIA_BUCKET,'put').mockImplementation(async (...args:any[]) => {
      const object=await (put as any)(...args); if (args[0].includes('/media/previews/')) throw new Error('Lost R2 acknowledgement'); return object;
    });
    await h.deliver(); expect((await h.preview()).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT count(*) AS n FROM media_image_previews').first<number>('n')).toBe(1);
    expect(h.decoder.requests.filter(r => r.path==='/v1/preview')).toHaveLength(1);
  });

  it('does not turn an expired workflow lease into proof that an issued PUT settled', async () => {
    const h=await pending(); await h.deliver(); const old=await h.previewRow();
    await testEnv.CANONICAL_MEDIA_BUCKET.delete(old.object_key); await h.preview();
    const job=[...h.jobs.values()][0]!; const hold=barrier();
    h.hooks.put=async key => {if (key.includes('/media/previews/')) await hold.wait();};
    const running=processImagePreview(h.environment,job.payload); await hold.entered;
    try {
      job.status='terminated'; h.advanceClock(9*60_000); await h.preview();
      expect((await h.previewRow()).writer_settled_at).toBeNull();
      await h.deleteMedia(); await cleanupImagePreviews(h.environment);
      expect((await h.previewRow()).absence_verified_at).toBeNull();
      expect(await eventHasImagePreviewInventory(h.environment,h.identity.eventId)).toBe(true);
    } finally {hold.release(); await running.catch(() => {});}
    await cleanupImagePreviews(h.environment);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head((await h.previewRow()).object_key)).toBeNull();
  });

  it('retires an obsolete profile without changing the original or publication', async () => {
    const h=await pending(); const repository=new ImagePreviewRepository(testEnv.DB); const now=new Date();
    const old=await repository.claim({mediaId:h.identity.mediaId,eventId:h.identity.eventId,sourceSha256:await sha256(h.bytes),profile:'mobile-preview-v0',mimeType:'image/webp',now:now.toISOString(),leaseExpiresAt:new Date(now.getTime()+180_000).toISOString()});
    const object=await testEnv.CANONICAL_MEDIA_BUCKET.put(old!.record.objectKey,h.previewBytes);
    await repository.markReady(old!.record,{byteSize:3,sha256:await sha256(h.previewBytes),etag:object!.etag,width:1,height:1,frameCount:1},new Date().toISOString());
    await h.deliver(); await cleanupImagePreviews(h.environment);
    expect((await repository.get(old!.record.id))!.state).toBe('suppressed');
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(old!.record.objectKey)).toBeNull();
    expect(await testEnv.DB.prepare('SELECT upload_state,publication_status,favorited_at FROM media WHERE id=?').bind(h.identity.mediaId).first()).toEqual({upload_state:'stored',publication_status:'unpublished',favorited_at:null});
  });

  it('keeps a direct file above the decimal Images ceiling and queues private preview recovery', async () => {
    const h=await pending(transportPng); const original=new Uint8Array(20_000_001); original.set(png());
    const input=vi.fn(() => {throw new Error('Oversized Images input');}); Object.defineProperty(h.environment,'IMAGES',{value:{input}});
    const base=`/api/event/${h.access.event.slug}/uploads`;
    const response=await h.request(base,{method:'POST',headers:writeHeaders(h.credentials),body:JSON.stringify({filename:'large.png',mimeType:'image/png',byteSize:original.length,idempotencyKey:'large-direct-preview',guestName:'Avery'})});
    expect(response.status).toBe(201); const mediaId=(await response.json<any>()).data.media.id;
    expect((await h.request(`${base}/${mediaId}/content`,{method:'PUT',headers:{...writeHeaders(h.credentials),'content-type':'image/png','content-length':String(original.length)},body:original})).status).toBe(200);
    expect(h.decoder.requests).toHaveLength(0);
    const preview=await h.request(`/api/media/${mediaId}/preview`,{headers:{cookie:h.credentials.cookie}});
    expect(preview.status).toBe(503); expect(input).not.toHaveBeenCalled(); expect(h.jobs.size).toBe(1);
    expect([...h.jobs.values()][0]!.payload.mediaId).toBe(mediaId);
    expect(await testEnv.DB.prepare('SELECT source_sha256 FROM media_processing WHERE media_id=?').bind(mediaId).first<string>('source_sha256')).toBe(await sha256(original));
  });

  it('preserves a frozen export original while its deleted photo preview is cleaned', async () => {
    const h=await pending(); await h.deliver(); const media=await new MediaRepository(testEnv.DB).getById(h.identity.mediaId);
    const jobId=crypto.randomUUID(); await seedExportJob({id:jobId,eventId:h.identity.eventId,snapshotAt:new Date().toISOString(),media:[media!]});
    await h.deleteMedia(); await cleanupImagePreviews(h.environment); await cleanupMediaObjectWriteTombstones(h.environment);
    const original=await testEnv.CANONICAL_MEDIA_BUCKET.get(media!.objectKey);
    expect(new Uint8Array(await original!.arrayBuffer())).toEqual(h.bytes);
    expect(await testEnv.DB.prepare('SELECT object_key FROM export_media_entries WHERE export_job_id=?').bind(jobId).first<string>('object_key')).toBe(media!.objectKey);
  });
});

describe('private rehearsal image metrics', () => {
  const points=(write:ReturnType<typeof vi.fn>) => write.mock.calls.map(([point]) => point as {indexes:string[];blobs:string[];doubles:number[]});
  function meter(h:{environment:typeof testEnv}) {
    const writeDataPoint=vi.fn(); Object.defineProperty(h.environment,'IMAGE_METRICS',{value:{writeDataPoint}}); return writeDataPoint;
  }

  it('counts one native-decode original read per delivered upload and warm hits with zero original reads', async () => {
    const h=await pending(); const write=meter(h); await h.deliver();
    expect(points(write)).toEqual([{indexes:[h.identity.eventId],blobs:['production','original-read','native-decode'],doubles:[h.bytes.length,1]}]);
    write.mockClear(); h.decoder.requests.length=0;
    for (let index=0;index<48;index++) {
      const response=await h.preview(); expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(h.previewBytes);
      expect([...response.headers.keys()].some(k => k.startsWith('x-decoder') || k.includes('metric'))).toBe(false);
    }
    const warm=points(write);
    expect(warm).toHaveLength(48);
    expect(warm.every(p => p.indexes[0]===h.identity.eventId && p.blobs[1]==='preview-read' && p.blobs[2]==='persisted-hit' && p.doubles[0]===h.previewBytes.length)).toBe(true);
    expect(warm.some(p => p.blobs[1]==='original-read')).toBe(false);
    expect(h.decoder.requests).toHaveLength(0);
  });

  it('counts a missing derivative as a regeneration miss and the preview-lane source read', async () => {
    const h=await pending(); await h.deliver(); await testEnv.CANONICAL_MEDIA_BUCKET.delete((await h.previewRow()).object_key);
    const write=meter(h);
    expect((await h.preview()).status).toBe(503);
    expect(points(write)).toEqual([{indexes:[h.identity.eventId],blobs:['production','preview-read','miss-regeneration'],doubles:[0,1]}]);
    write.mockClear(); await processImagePreview(h.environment,[...h.jobs.values()][0]!.payload);
    expect(points(write)).toEqual([{indexes:[h.identity.eventId],blobs:['production','original-read','native-decode'],doubles:[h.bytes.length,1]}]);
  });
});

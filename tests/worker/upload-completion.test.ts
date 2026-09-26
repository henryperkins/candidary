import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256ImageStream } from '../../worker/storage/image-source';
import { createTransferHarness, barrier, sha256, transportDng } from './fixtures/upload-transfer';
import { createDecoderDouble, decoderInspection } from './fixtures/image-decoder';
import { TEST_FINGERPRINT } from './fixtures/mobile-image-db';
import { resetDatabase, testEnv } from './helpers';
import { type DecoderFailureCode } from '../../shared/image-decoder-contract';
import { MediaRepository } from '../../worker/db/media';
import { UploadTransferRepository } from '../../worker/db/upload-transfers';
import type { ImageDeclaration } from '../../shared/image-formats';
import { finalizedMediaObjectKey } from '../../worker/storage/media-keys';
import { cleanupMediaObjectWriteTombstones, promoteLegacyStoredMedia } from '../../worker/workflows/cleanup';

beforeEach(resetDatabase);
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks(); globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = undefined;});

async function pendingPhoto(options:{failure?:DecoderFailureCode;wrongHash?:boolean;declared?:ImageDeclaration;nativeFamily?:ImageDeclaration['family']} = {}) {
  const bytes = new Uint8Array([1,2,3]);
  const h = await createTransferHarness({realStorage:true}); await h.reserve(bytes,options.declared ?? transportDng);
  expect((await h.putPart(0,bytes)).status).toBe(200);
  const decoderOptions:Parameters<typeof createDecoderDouble>[0] = {inspection:decoderInspection({family:options.nativeFamily ?? 'dng',byteSize:bytes.length,sourceSha256:options.wrongHash ? 'f'.repeat(64) : await sha256(bytes),buildFingerprint:TEST_FINGERPRINT}),previewBytes:new Uint8Array([4,5,6]),...(options.failure ? {failure:options.failure} : {}),
    transformResponse:(response) => {response.headers.set('X-Decoder-Environment','production'); return response;}};
  const decoder = createDecoderDouble(decoderOptions);
  h.setDecoder(decoder.fetch);
  return {...h,bytes,decoder,decoderOptions};
}

describe('durable image completion', () => {
  it('hashes a generated original larger than 128 MiB without whole-body buffering', async () => {
    const size = 129*1024**2+7; const chunk = new Uint8Array(256*1024).fill(0x63); let left = size;
    const expected = createHash('sha256'); const body = new ReadableStream<Uint8Array>({pull(c) {
      if (!left) {c.close(); return;}
      const value = chunk.subarray(0,Math.min(left,chunk.length)); left -= value.length; expected.update(value); c.enqueue(value);
    }},{highWaterMark:0});
    const tripwire = vi.spyOn(Response.prototype,'arrayBuffer').mockImplementation(() => {throw new Error('Whole-body buffering is forbidden.');});
    const hash = await sha256ImageStream(body,size);
    expect(left).toBe(0); expect(hash).toBe(expected.digest('hex')); expect(tripwire).not.toHaveBeenCalled();
  });

  it('refuses short, long and canceled source streams', async () => {
    await expect(sha256ImageStream(new Response(new Uint8Array(2)).body!,3)).rejects.toThrow();
    await expect(sha256ImageStream(new Response(new Uint8Array(4)).body!,3)).rejects.toThrow();
    const canceled = vi.fn(); const abort = new AbortController(); abort.abort();
    await expect(sha256ImageStream(new ReadableStream({cancel:canceled}),3,abort.signal)).rejects.toThrow();
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it('returns a processing acknowledgement, then exactly one delivery with unchanged original bytes', async () => {
    const h = await pendingPhoto(); const response = await h.complete(); expect(response.status).toBe(202);
    expect((await response.json<any>()).data.media).toBeUndefined();
    expect(h.instances.keys().next().value).toBe(`image-upload-${h.identity.transferId}-1`);
    await h.runCompletion();
    const state = (await (await h.status()).json<any>()).data;
    expect(state.transfer.state).toBe('delivered'); expect(state.transfer.previewState).toBe('ready');
    const media = await testEnv.DB.prepare('SELECT * FROM media WHERE id=?').bind(h.identity.mediaId).first<any>();
    expect(media.upload_state).toBe('stored'); expect(media.publication_status).toBe('unpublished');
    expect(media.favorited_at).toBeNull(); expect(media.preview_object_key).toBeNull();
    const original = await testEnv.CANONICAL_MEDIA_BUCKET.get(media.object_key);
    expect(new Uint8Array(await original!.arrayBuffer())).toEqual(h.bytes);
    expect(h.decoder.requests.filter((r) => r.path==='/v1/preview')).toHaveLength(1);
    expect(h.decoder.requests.filter((r) => r.path==='/v1/inspect')).toHaveLength(0);
    const receipt = await h.complete(); expect(receipt.status).toBe(200); expect((await receipt.json<any>()).data.media.id).toBe(media.id);
    await h.runCompletion();
    expect(await testEnv.DB.prepare('SELECT reserved_media_count,stored_media_count,stored_bytes FROM events WHERE id=?').bind(h.access.event.id).first()).toEqual({reserved_media_count:0,stored_media_count:1,stored_bytes:3});
    expect((await testEnv.DB.prepare('SELECT delivery_sequence FROM media WHERE id=?').bind(media.id).first<any>()).delivery_sequence).toBe(1);
  });

  it('does not dispatch until every part is durably accepted', async () => {
    const h = await createTransferHarness(); await h.reserve(3,transportDng);
    expect((await h.complete()).status).toBe(409); expect(h.workflow.createBatch).not.toHaveBeenCalled();
  });

  it('replays the same workflow after an ambiguous dispatch without guessing lookup absence', async () => {
    const h = await pendingPhoto(); h.hooks.dispatch = async () => {throw new Error('Lost dispatch acknowledgement');};
    expect((await h.complete()).status).toBe(202);
    h.workflow.get.mockRejectedValue(new Error('lookup unavailable'));
    expect((await h.complete()).status).toBe(202); expect(h.instances.size).toBe(1);
    expect(h.workflow.createBatch.mock.calls.every(([batch]) => batch[0]?.id===`image-upload-${h.identity.transferId}-1`)).toBe(true);
  });

  it('reconciles a lost multipart-complete response from the unique assembly object', async () => {
    const h = await pendingPhoto(); expect((await h.complete()).status).toBe(202);
    h.hooks.completeAfter = async () => {throw new Error('Lost completion acknowledgement');};
    await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('delivered');
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('keeps a deletion fence while an already-started multipart completion settles', async () => {
    const h = await pendingPhoto(); expect((await h.complete()).status).toBe(202);
    const hold = barrier(); h.hooks.completeAfter = hold.wait;
    const running = h.runCompletion(); await hold.entered;
    expect((await h.deleteMedia()).status).toBe(200); hold.release();
    await running;
    expect((await testEnv.DB.prepare('SELECT upload_state FROM media WHERE id=?').bind(h.identity.mediaId).first<any>()).upload_state).toBe('deleted');
    expect(h.decoder.requests).toHaveLength(0);
  });

  it.each(['busy','unavailable'] as const)('retries %s processing on the same assembly without a receipt or duplicate quota', async (failure) => {
    const h = await pendingPhoto({failure}); expect((await h.complete()).status).toBe(202);
    await expect(h.runCompletion()).rejects.toThrow();
    const pending = (await (await h.status()).json<any>()).data;
    expect(pending.transfer.state).toBe('retryable'); expect(pending.media).toBeUndefined();
    const firstAssembly = await h.assembly(); expect(firstAssembly.completed_etag).toBeTruthy();
    delete h.decoderOptions.failure;
    expect((await h.complete()).status).toBe(202); await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('delivered');
    expect(h.create).toHaveBeenCalledTimes(1);
    expect([...h.handles.values()][0]!.complete).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT stored_media_count,reserved_media_count FROM events WHERE id=?').bind(h.access.event.id).first()).toEqual({stored_media_count:1,reserved_media_count:0});
  });

  it.each(['unsupported','malformed','resource_limit'] as const)('rejects a native %s refusal and releases reserved quota', async (failure) => {
    const h = await pendingPhoto({failure}); await h.complete(); await h.runCompletion();
    const state = (await (await h.status()).json<any>()).data;
    expect(state.transfer.state).toBe('rejected'); expect(state.media).toBeUndefined();
    expect(await testEnv.DB.prepare('SELECT stored_media_count,reserved_media_count FROM events WHERE id=?').bind(h.access.event.id).first()).toEqual({stored_media_count:0,reserved_media_count:0});
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalizedMediaObjectKey(h.access.event.id,h.identity.mediaId))).toBeNull();
  });

  it('does not deliver a mismatched native source digest', async () => {
    const h = await pendingPhoto({wrongHash:true}); await h.complete(); await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('rejected');
    expect(await testEnv.DB.prepare('SELECT count(*) AS n FROM media_image_previews').first<number>('n')).toBe(0);
  });

  it('coalesces simultaneous completion requests and workers', async () => {
    const h = await pendingPhoto();
    expect((await Promise.all([h.complete(),h.complete()])).map((r) => r.status)).toEqual([202,202]);
    const hold = barrier(); h.hooks.complete = hold.wait;
    const first = h.runCompletion(); await hold.entered; await h.runCompletion(); hold.release(); await first;
    expect(h.decoder.requests.filter((r) => r.path==='/v1/preview')).toHaveLength(1);
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('delivered');
  });

  it('reconstructs a committed receipt after a lost D1 response', async () => {
    const h = await pendingPhoto(); await h.complete();
    const batch = testEnv.DB.batch.bind(testEnv.DB);
    h.hooks.put = async (key) => {
      if (!key.includes('/media/final/')) return;
      vi.spyOn(testEnv.DB,'batch').mockImplementationOnce(async (statements) => {await batch(statements); throw new Error('Lost D1 commit response');});
    };
    await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('delivered');
    expect((await h.complete()).status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT stored_media_count,last_delivery_sequence FROM events WHERE id=?').bind(h.access.event.id).first()).toEqual({stored_media_count:1,last_delivery_sequence:1});
  });

  it('reconciles a completion ownership claim when its D1 response is lost', async () => {
    const h = await pendingPhoto(); await h.complete();
    const batch = testEnv.DB.batch.bind(testEnv.DB);
    vi.spyOn(testEnv.DB,'batch').mockImplementationOnce(async (statements) => {await batch(statements); throw new Error('Lost D1 owner response');});
    await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('delivered');
    expect([...h.handles.values()][0]!.complete).toHaveBeenCalledTimes(1);
  });

  it('finishes pinned qualification after the new-intake switch closes', async () => {
    const h = await pendingPhoto();
    await testEnv.DB.prepare('UPDATE mobile_image_admission SET enabled=0,revision=revision+1').run();
    await h.complete(); await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('delivered');
  });

  it('refuses an unqualified sequence hidden under an ordinary declaration', async () => {
    const h = await pendingPhoto();
    h.decoderOptions.inspection = {...h.decoderOptions.inspection,isSequence:true,frameCount:2};
    await h.complete(); await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('rejected');
  });

  it('requires qualification for the actual HEIC family under a generic HEIF declaration', async () => {
    const h = await pendingPhoto({declared:{family:'heif',mimeType:'image/heif',requiresSequence:false},nativeFamily:'heic'});
    await h.complete(); await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('rejected');
  });

  it('cannot commit an assembly through the legacy buffer-only path', async () => {
    const h = await pendingPhoto(); await h.complete(); const hold = barrier();
    h.hooks.put = async (key) => {if (key.includes('/media/final/')) await hold.wait();};
    const running = h.runCompletion(); await hold.entered;
    try {
      const a = await h.assembly(); const at = new Date().toISOString();
      const result = await new MediaRepository(testEnv.DB).commitReservationIngress({mediaId:h.identity.mediaId,eventId:h.identity.eventId,
        authority:h.identity.authority,claimToken:a.completion_token,finalObjectKey:finalizedMediaObjectKey(h.identity.eventId,h.identity.mediaId),
        byteSize:3,width:h.decoderOptions.inspection!.width!,height:h.decoderOptions.inspection!.height!,finalEtag:'not-a-proof',committedAt:at,capturedAt:null,timelineAt:at});
      expect(result.ok).toBe(false);
    } finally {hold.release(); await running;}
  });

  it('renews the final promotion lease during a slow immutable write', async () => {
    const h = await pendingPhoto(); await h.complete(); const hold = barrier();
    h.hooks.put = async (key) => {if (key.includes('/media/final/')) await hold.wait();};
    const running = h.runCompletion(); await hold.entered;
    try {
      const a = await h.assembly();
      h.advanceClock(170_000);
      const renewed = await new UploadTransferRepository(testEnv.DB).renewCompletionLease(h.identity,
        {token:a.completion_token,generation:a.generation,attempt:a.attempt,leaseExpiresAt:a.completion_lease_expires_at},new Date().toISOString());
      expect(renewed.ok).toBe(true);
      h.advanceClock(30_000);
    } finally {hold.release(); await running;}
    expect((await (await h.status()).json<any>()).data.transfer.state).toBe('delivered');
  });

  it.each(['intake','revocation','expiry'] as const)('rechecks %s after native processing before final delivery', async (fence) => {
    const h = await pendingPhoto(); await h.complete();
    h.setDecoder(async (request) => {
      if (fence==='intake') await h.closeIntake();
      else if (fence==='revocation') await h.revokeSession();
      else h.advanceClock(7*3600_000);
      return h.decoder.fetch(request);
    });
    await h.runCompletion();
    expect((await new MediaRepository(testEnv.DB).getById(h.identity.mediaId))!.uploadState).not.toBe('stored');
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalizedMediaObjectKey(h.access.event.id,h.identity.mediaId))).toBeNull();
  });

  it.each(['hard-expiry','lease-expiry','still-live'] as const)('rechecks %s after asynchronous timeline metadata before receipt', async (fence) => {
    const h = await pendingPhoto({declared:{family:'jpeg',mimeType:'image/jpeg',requiresSequence:false},nativeFamily:'jpeg'});
    await h.complete();
    const get = testEnv.CANONICAL_MEDIA_BUCKET.get.bind(testEnv.CANONICAL_MEDIA_BUCKET);
    let ranged = 0; let receiptAt = '';
    vi.spyOn(testEnv.CANONICAL_MEDIA_BUCKET,'get').mockImplementation(async (...args) => {
      if (args[1]?.range) {
        ranged++;
        h.advanceClock(fence==='hard-expiry' ? 7*3600_000 : fence==='lease-expiry' ? 4*60_000 : 1000);
        receiptAt = new Date().toISOString();
      }
      return get(...args);
    });
    await h.runCompletion();
    expect(ranged).toBeGreaterThan(0);
    const media = await new MediaRepository(testEnv.DB).getById(h.identity.mediaId);
    if (fence==='still-live') {
      expect(media!.uploadState).toBe('stored'); expect(media!.storedAt).toBe(receiptAt); expect(media!.timelineAt).toBe(receiptAt);
    } else expect(media!.uploadState).not.toBe('stored');
  });

  it.each(['decode','preview','final'] as const)('preserves deletion during %s and retires every late original alias', async (stage) => {
    const h = await pendingPhoto(); await h.complete(); const hold = barrier();
    if (stage==='decode') h.setDecoder(async (request) => {await hold.wait(); return h.decoder.fetch(request);});
    else h.hooks.put = async (key) => {if (key.includes(stage==='preview' ? '/media/previews/' : '/media/final/')) await hold.wait();};
    const running = h.runCompletion(); await hold.entered;
    expect((await h.deleteMedia()).status).toBe(200); hold.release(); await running;
    expect((await new MediaRepository(testEnv.DB).getById(h.identity.mediaId))!.uploadState).toBe('deleted');
    expect((await (await h.status()).json<any>()).data.media).toBeUndefined();
    const later = new Date(Date.now()+7*3600_000);
    await promoteLegacyStoredMedia(h.environment,later);
    await cleanupMediaObjectWriteTombstones(h.environment,later);
    expect(await testEnv.CANONICAL_MEDIA_BUCKET.head(finalizedMediaObjectKey(h.access.event.id,h.identity.mediaId))).toBeNull();
  });

  it('never overwrites or compensation-deletes conflicting final bytes', async () => {
    const h = await pendingPhoto(); const key = finalizedMediaObjectKey(h.access.event.id,h.identity.mediaId);
    await testEnv.CANONICAL_MEDIA_BUCKET.put(key,new Uint8Array([9,9,9]),{httpMetadata:{contentType:'image/dng'}});
    await h.complete(); await expect(h.runCompletion()).rejects.toThrow();
    expect(new Uint8Array(await (await testEnv.CANONICAL_MEDIA_BUCKET.get(key))!.arrayBuffer())).toEqual(new Uint8Array([9,9,9]));
    expect((await (await h.status()).json<any>()).data.media).toBeUndefined();
  });
});

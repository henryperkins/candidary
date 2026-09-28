import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { unzipSync } from 'fflate';
import { createApp } from '../../worker/app';
import { AuthService } from '../../worker/auth/service';
import { PhotoExportsRepository } from '../../worker/db/photo-exports';
import { ExportsRepository } from '../../worker/db/exports';
import { processExport } from '../../worker/workflows/export';
import { sha256ImageStream } from '../../worker/storage/image-source';
import { createTransferHarness,sha256 } from './fixtures/upload-transfer';
import { createDecoderDouble,decoderInspection } from './fixtures/image-decoder';
import { TEST_FINGERPRINT } from './fixtures/mobile-image-db';
import { mobileImageTestRaster } from '../fixtures/mobile-image-original';
import { resetDatabase,testEnv,writeHeaders } from './helpers';
import { isReadableOriginal,MAX_READABLE_ORIGINAL_BYTES } from '../../shared/image-formats';

beforeEach(resetDatabase);
afterEach(() => {vi.restoreAllMocks(); globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__=undefined;});
describe('stored mobile originals remain readable',() => {
  it('has a versioned read contract independent of new-intake limits',() => {
    expect(isReadableOriginal('image/dng',512*1024**2)).toBe(true);
    expect(isReadableOriginal('image/tiff',MAX_READABLE_ORIGINAL_BYTES)).toBe(true);
    for (const [type,size] of [['text/html',1],['image/tiff',0],['image/tiff',Infinity],['image/tiff',MAX_READABLE_ORIGINAL_BYTES+1]] as const) expect(isReadableOriginal(type,size)).toBe(false);
  });
  it('downloads and exports the same complete 21.6 MB TIFF after intake closes',async () => {
    const bytes=mobileImageTestRaster(); const digest=await sha256(bytes);
    expect(digest).toBe('1867057d66151c6462eb438bc6a06e3b12be01a00b22235f4012cca8106a6bbd');
    const h=await createTransferHarness({realStorage:true});
    await h.reserve(bytes,{family:'tiff',mimeType:'image/tiff',requiresSequence:false});
    for (let index=0;index<Math.ceil(bytes.length/(8*1024**2));index++) expect((await h.putPart(index,bytes.slice(index*8*1024**2,(index+1)*8*1024**2))).status).toBe(200);
    const decoder=createDecoderDouble({inspection:decoderInspection({family:'tiff',width:3000,height:2400,byteSize:bytes.length,sourceSha256:digest,buildFingerprint:TEST_FINGERPRINT}),previewBytes:new Uint8Array([4,5,6]),
      transformResponse:response => {response.headers.set('X-Decoder-Environment','production'); return response;}});
    h.setDecoder(decoder.fetch); await h.complete(); await h.runCompletion();
    expect((await (await h.status()).json<any>()).data.media.uploadState).toBe('stored');
    await testEnv.DB.prepare('UPDATE mobile_image_admission SET enabled=0,revision=revision+1').run();
    await testEnv.DB.prepare('UPDATE events SET uploads_enabled=0 WHERE id=?').bind(h.access.event.id).run();
    const original=await h.request(`/api/media/${h.identity.mediaId}/original`,{headers:{cookie:h.access.manager.cookie}});
    expect(original.status).toBe(200); expect(await sha256ImageStream(original.body!,bytes.length)).toBe(digest);
    const token=/candidary_session=([^;]+)/u.exec(h.access.manager.cookie)![1]!;
    const auth=await new AuthService(testEnv).resolve(token); const principal=`link:${auth.session.id}`;
    const now=new Date(); const repo=new PhotoExportsRepository(testEnv.DB);
    await testEnv.DB.prepare('UPDATE photo_export_admission SET enabled=1,worker_version_id=?,admitted_at=?').bind(crypto.randomUUID(),now.toISOString()).run();
    const create=async (destination:'archive'|'device') => repo.create({eventId:h.access.event.id,principal,now:now.toISOString(),request:{version:1,destination,idempotencyKey:crypto.randomUUID(),source:{mode:'ids',scope:'library',mediaIds:[h.identity.mediaId]}}});
    const device=await create('device'); await repo.confirm(h.access.event.id,device.id,principal,now.toISOString());
    const file=await createApp().request(`/api/manage/events/${h.access.event.id}/photo-exports/${device.id}/entries/${h.identity.mediaId}/file`,{headers:{cookie:h.access.manager.cookie}},testEnv);
    expect(file.status).toBe(200); expect(await sha256ImageStream(file.body!,bytes.length)).toBe(digest);
    await repo.cancel(h.access.event.id,device.id,principal,new Date().toISOString());
    const archive=await create('archive'); await repo.confirm(h.access.event.id,archive.id,principal,now.toISOString());
    const result=await processExport(testEnv,{jobId:archive.id,attempt:1},now); expect(result?.state).toBe('ready');
    const part=(await new ExportsRepository(testEnv.DB).listParts(archive.id))[0]!;
    const zip=await testEnv.MEDIA_BUCKET.get(part.objectKey);
    const members=unzipSync(new Uint8Array(await zip!.arrayBuffer()));
    expect(await sha256(Uint8Array.from(members['photos/001-original.tif']!))).toBe(digest);
    expect(Object.keys(members)).toEqual(['photos/001-original.tif','media.csv']);
    const unauthorized=await h.request(`/api/media/${h.identity.mediaId}/original`,{headers:writeHeaders(h.access.guest)});
    expect(unauthorized.status).toBe(403);
  // Includes two authorized 21.6 MB streams and an uncompressed ZIP in workerd.
  },60_000);
});

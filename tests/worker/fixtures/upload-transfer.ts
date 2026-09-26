import { vi } from 'vitest';
import { createApp } from '../../../worker/app';
import { UploadTransferRepository, type TransferIdentity } from '../../../worker/db/upload-transfers';
import { requiredCasesFor } from '../../../shared/image-decoder-contract';
import { isLegacyUploadMimeType, type ImageDeclaration } from '../../../shared/image-formats';
import { eventAccess, testEnv, writeHeaders } from '../helpers';
import { TEST_FINGERPRINT } from './mobile-image-db';
import { processUploadCompletion, type UploadCompletionPayload } from '../../../worker/workflows/upload-completion';

export const transportPng = {family:'png',mimeType:'image/png',requiresSequence:false} as const;
export const transportDng = {family:'dng',mimeType:'image/dng',requiresSequence:false} as const;
export async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map((n) => n.toString(16).padStart(2,'0')).join('');
}
export function barrier() {
  let release!: () => void; let signal!: () => void;
  const entered = new Promise<void>((resolve) => { signal = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  return {entered,release,wait:async () => { signal(); await waiting; }};
}

/** Real auth, reservation, D1 and routes; R2 multipart double is protocol evidence only. */
export async function createTransferHarness(options: {manager?:boolean;realStorage?:boolean;fingerprint?:string} = {}) {
  // An actual native build can be named instead of the protocol double's fingerprint.
  const fingerprint = options.fingerprint ?? TEST_FINGERPRINT;
  const access = await eventAccess();
  const credentials = options.manager ? access.manager : access.guest;
  const base = options.manager ? `/api/manage/events/${access.event.id}/uploads` : `/api/event/${access.event.slug}/uploads`;
  const app = createApp();
  const hooks = {create:async () => {},part:async () => {},partAfter:async () => {},abort:async () => {},complete:async () => {},completeAfter:async () => {},dispatch:async () => {},put:async (_key:string) => {}};
  const storageErrors: unknown[] = [];
  const handles = new Map<string,R2MultipartUpload>();
  const create = vi.fn(async (key:string) => {
    const actual = options.realStorage ? await testEnv.CANONICAL_MEDIA_BUCKET.createMultipartUpload(key).catch((error) => {storageErrors.push(error); throw error;}) : undefined;
    const uploadId = actual?.uploadId ?? crypto.randomUUID();
    const handle = {key,uploadId,
      uploadPart:vi.fn(async (partNumber:number, bytes:ArrayBuffer) => {
        await hooks.part();
        const result = actual ? await actual.uploadPart(partNumber,bytes).catch((error) => {storageErrors.push(error); throw error;}) : {partNumber,etag:`part-${partNumber}`};
        await hooks.partAfter(); return result;
      }),
      abort:vi.fn(async () => { await hooks.abort(); await actual?.abort(); }),
      complete:vi.fn(async (parts:R2UploadedPart[]) => {
        if (!actual) throw new Error('Use the real storage option for multipart completion.');
        await hooks.complete(); const result = await actual.complete(parts); await hooks.completeAfter(); return result;
      }),
    } as R2MultipartUpload;
    handles.set(uploadId,handle);
    await hooks.create(); // A thrown/lost response here models an already-created upload.
    return handle;
  });
  const resume = vi.fn((key:string, uploadId:string) => {
    const handle = handles.get(uploadId);
    if (!handle || handle.key !== key) throw new Error('Unknown multipart fixture.');
    return handle;
  });
  const bucket = new Proxy(testEnv.CANONICAL_MEDIA_BUCKET,{get(target,prop) {
    if (prop === 'createMultipartUpload') return create;
    if (prop === 'resumeMultipartUpload') return resume;
    if (prop === 'put') return async (...args:Parameters<R2Bucket['put']>) => {await hooks.put(args[0]); return target.put(...args);};
    const value = Reflect.get(target,prop,target); return typeof value === 'function' ? value.bind(target) : value;
  }});
  const instances = new Map<string,{payload:UploadCompletionPayload;status:string}>();
  const workflow = {
    createBatch:vi.fn(async (batch:Array<{id:string;params:UploadCompletionPayload}>) => {
      for (const item of batch) if (!instances.has(item.id)) instances.set(item.id,{payload:item.params,status:'queued'});
      await hooks.dispatch(); return [];
    }),
    get:vi.fn(async (id:string) => {
      const instance = instances.get(id); if (!instance) throw new Error('Unknown workflow');
      return {status:async () => ({status:instance.status}),restart:async () => {instance.status='queued';},resume:async () => {instance.status='queued';},terminate:async () => {instance.status='terminated';}};
    }),
  };
  // The workerd Env proxy's inherited setters can write to its original target.
  // Define own overrides so this fixture never replaces the actual test bucket.
  const environment = Object.defineProperties(Object.create(testEnv),{
    CANONICAL_MEDIA_BUCKET:{value:bucket}, IMAGE_DECODER_ENVIRONMENT:{value:'production'},
    UPLOAD_COMPLETION_WORKFLOW:{value:workflow},
    IMAGE_DECODER:{configurable:true,value:{fetch:async () => Response.json({protocolVersion:1,buildFingerprint:fingerprint,decoderVersion:'protocol-double'},
      {headers:{'X-Decoder-Protocol':'1','X-Decoder-Environment':'production'}})}},
  }) as typeof testEnv;
  let mediaId = ''; let transferId = ''; let identity!: TransferIdentity;
  const request = (path:string, init:RequestInit = {}) => app.request(path,init,environment);
  async function reserve(bytes:Uint8Array<ArrayBuffer>|number,declared:ImageDeclaration = transportPng) {
    const byteSize = typeof bytes === 'number' ? bytes : bytes.byteLength;
    const required = requiredCasesFor(declared.family,declared.requiresSequence);
    globalThis.__CANDIDARY_TEST_MOBILE_IMAGE_RELEASE_OVERRIDE__ = {
      decoderRelease:{protocolVersion:1,previewProfile:'mobile-preview-v1',releases:[{imageRef:`registry.example/decoder@sha256:${'b'.repeat(64)}`,buildFingerprint:fingerprint,protocolVersion:1,previewProfile:'mobile-preview-v1',verifiedCaseIds:required,evidenceSha256:'c'.repeat(64)}]},
      mobileRelease:{kind:'candidary.mobile-image-release',schemaVersion:26,protocolVersion:1,previewProfile:'mobile-preview-v1',maxOriginalBytes:512*1024**2,
        cases:required.map((caseId) => ({caseId,buildFingerprint:fingerprint,evidenceSha256:'d'.repeat(64),maxOriginalBytes:512*1024**2}))},
    };
    for (const id of required) await testEnv.DB.prepare('UPDATE mobile_image_admission SET enabled = 1,revision = revision+1 WHERE case_id = ?').bind(id).run();
    const file = {filename:'original',mimeType:declared.mimeType,byteSize,idempotencyKey:crypto.randomUUID(),transport:'parts-v1',...(!options.manager ? {guestName:'Avery'} : {})};
    const response = await request(options.manager ? `${base}/batch` : base,{method:'POST',headers:writeHeaders(credentials),body:JSON.stringify(options.manager ? {files:[file]} : file)});
    if (response.status !== 201) throw new Error(`Reservation failed: ${await response.text()}`);
    const envelope = (await response.json<any>()).data;
    const data = options.manager ? envelope.items[0] : envelope;
    mediaId = data.media.id;
    const actor = await testEnv.DB.prepare('SELECT uploader_session_id AS id FROM media WHERE id = ?').bind(mediaId).first<string>('id');
    identity = {mediaId,eventId:access.event.id,transferId:data.transfer?.id ?? crypto.randomUUID(),authority:{kind:options.manager ? 'manager-link' : 'guest',actorSessionId:actor!,eventSessionId:actor!}};
    // Tiny baseline files keep their production direct route. Only this fixture
    // explicitly installs the repository transfer to exercise multipart protocol.
    if (!data.transfer && isLegacyUploadMimeType(declared.mimeType) && byteSize <= 20*1024**2) {
      const result = await new UploadTransferRepository(testEnv.DB,{buildFingerprint:fingerprint,caseId:required[0]!})
        .initiate({...identity,declared,byteSize,now:new Date().toISOString()});
      if (!result.ok) throw new Error(`Fixture transfer failed: ${result.reason}`);
    }
    transferId = identity.transferId;
    return data;
  }
  const path = () => `${base}/${mediaId}/transfers/${transferId}`;
  return {access,environment,request,hooks,create,resume,handles,reserve,path,credentials,storageErrors,workflow,instances,
    get identity() {return identity;},
    start:() => request(`${base}/${mediaId}/transfers`,{method:'POST',headers:writeHeaders(credentials)}),
    status:() => request(path(),{headers:{cookie:credentials.cookie}}),
    complete:() => request(`${path()}/complete`,{method:'POST',headers:writeHeaders(credentials)}),
    setDecoder:(fetch:(request:Request) => Promise<Response>) => Object.defineProperty(environment,'IMAGE_DECODER',{value:{fetch},configurable:true}),
    runCompletion:async () => {
      const attempt = await testEnv.DB.prepare('SELECT attempt FROM media_upload_transfers WHERE id=?').bind(transferId).first<number>('attempt');
      const instance = instances.get(`image-upload-${transferId}-${attempt}`); if (instance) instance.status='running';
      try {await processUploadCompletion(environment,{transferId,attempt:attempt!}); if (instance) instance.status='complete';}
      catch (error) {if (instance) instance.status='errored'; throw error;}
    },
    putPart:async (index:number,bytes:Uint8Array<ArrayBuffer>,headers:Record<string,string> = {}) => request(`${path()}/parts/${index}`,{method:'PUT',headers:{...writeHeaders(credentials),'content-type':'application/octet-stream','content-length':String(bytes.byteLength),'x-part-sha256':await sha256(bytes),...headers},body:bytes}),
    abort:() => request(path(),{method:'DELETE',headers:writeHeaders(credentials)}),
    deleteMedia:() => request(`${base}/${mediaId}`,{method:'DELETE',headers:writeHeaders(credentials)}),
    advanceClock:(ms:number) => vi.setSystemTime(new Date(Date.now()+ms)),
    closeIntake:() => testEnv.DB.prepare('UPDATE events SET uploads_enabled = 0 WHERE id = ?').bind(access.event.id).run(),
    revokeSession:() => testEnv.DB.prepare('UPDATE event_sessions SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(),identity.authority.actorSessionId).run(),
    assembly:() => testEnv.DB.prepare('SELECT * FROM media_upload_assemblies WHERE transfer_id = ?').bind(transferId).first<any>(),
  };
}

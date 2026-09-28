import { File as RuntimeFile } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendResumableFile, confirmResumableFile } from '../../src/features/uploads/resumable-upload-transport';
import type { UploadTransferOutcome, UploadTransferView } from '../../shared/mobile-image-contract';

const PART=8*1024**2; const root='/api/event/example/uploads';
const file=(bytes:Uint8Array) => new RuntimeFile([bytes as Uint8Array<ArrayBuffer>],'original.dng',{type:'image/dng'}) as unknown as File;
const hash=(bytes:Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const response=(data:unknown,status=200) => Response.json({data,requestId:'test'}, {status});
beforeEach(() => vi.stubGlobal('crypto',webcrypto));
afterEach(() => {vi.unstubAllGlobals(); vi.restoreAllMocks();});
function harness(bytes=new Uint8Array([1,2,3]), accepted:number[] = []) {
  const transfer:UploadTransferView={id:'transfer-1',mediaId:'media-1',state:'receiving',partBytes:PART,partCount:Math.ceil(bytes.length/PART),acceptedParts:[...accepted],
    expiresAt:new Date(Date.now()+3600_000).toISOString(),hardExpiresAt:new Date(Date.now()+6*3600_000).toISOString(),previewState:'pending'};
  const sent:Array<{index:number;body:Uint8Array}> = []; const verified:any[]=[];
  let loseAcknowledgement=false; let processingGets=0; let deliver=true;
  const outcome=():UploadTransferOutcome => ({transfer:structuredClone(transfer),...(transfer.state==='delivered' ? {media:{id:transfer.mediaId,mimeType:'image/dng',uploadState:'stored'}} : {})});
  const fetch=vi.fn(async (path:string,init:RequestInit={}) => {
    if (init.signal?.aborted) throw new DOMException('Canceled','AbortError');
    const method=init.method ?? 'GET';
    if (method==='GET') {
      if (transfer.state==='processing') {processingGets++; if (deliver) {transfer.state='delivered'; transfer.previewState='ready';}}
      return response(outcome());
    }
    if (path.endsWith('/verify')) {
      const proof=JSON.parse(init.body as string); verified.push(proof);
      if (proof.byteSize!==bytes.length || proof.parts.length!==transfer.acceptedParts.length
        || proof.parts.some((part:any) => hash(bytes.subarray(part.index*PART,(part.index+1)*PART))!==part.sha256)) {
        return Response.json({code:'UPLOAD_FINALIZE_CONFLICT',message:'Choose the same original photo.',requestId:'test'},{status:409});
      }
      return response({verifiedParts:transfer.acceptedParts});
    }
    if (path.includes('/parts/')) {
      const index=Number(path.split('/').at(-1)); const body=new Uint8Array(init.body as ArrayBuffer);
      expect(body.byteLength).toBeLessThanOrEqual(PART);
      expect(new Headers(init.headers).get('x-part-sha256')).toBe(hash(body));
      expect(hash(body)).toBe(hash(bytes.subarray(index*PART,(index+1)*PART)));
      sent.push({index,body}); transfer.acceptedParts=[...new Set([...transfer.acceptedParts,index])].sort();
      if (loseAcknowledgement) {loseAcknowledgement=false; throw new TypeError('Offline after acceptance');}
      return response({index,accepted:true});
    }
    if (path.endsWith('/complete')) {transfer.state='processing'; return response(outcome(),202);}
    throw new Error(`Unexpected ${method} ${path}`);
  });
  vi.stubGlobal('fetch',fetch);
  return {transfer,bytes,sent,verified,fetch,outcome,get processingGets(){return processingGets;},
    loseAck:() => {loseAcknowledgement=true;},hold:() => {deliver=false;},deliver:() => {deliver=true;}};
}

describe('bounded resumable originals', () => {
  it('slices the unchanged File, reports accepted progress once and waits for a stored receipt', async () => {
    const h=harness(new Uint8Array(PART+3).fill(0x52)); const original=file(h.bytes);
    const whole=vi.spyOn(original,'arrayBuffer').mockRejectedValue(new Error('Whole original buffer'));
    const progress:number[]=[]; const processing=vi.fn();
    const result=await sendResumableFile(original,h.transfer,{root,onProgress:n => progress.push(n),onProcessing:processing});
    expect(h.sent.map(p => p.index)).toEqual([0,1]); expect(whole).not.toHaveBeenCalled();
    expect(progress.at(-1)).toBe(100); expect(progress.every((p,i) => i===0 || p>=progress[i-1]!)).toBe(true);
    expect(processing).toHaveBeenCalledTimes(1); expect(h.processingGets).toBe(1);
    expect(result.media?.uploadState).toBe('stored');
  });

  it('reconciles an accepted part after losing its acknowledgement', async () => {
    const h=harness(); h.loseAck();
    await sendResumableFile(file(h.bytes),h.transfer,{root,onProgress:vi.fn()});
    expect(h.sent).toHaveLength(1); expect(h.transfer.state).toBe('delivered');
  });

  it('verifies every accepted part of a reselected File and sends only the missing indexes', async () => {
    const h=harness(new Uint8Array(PART+5).fill(3),[0]);
    await sendResumableFile(file(h.bytes),h.transfer,{root,onProgress:vi.fn()});
    expect(h.verified[0]).toEqual({byteSize:h.bytes.length,parts:[{index:0,byteSize:PART,sha256:hash(h.bytes.subarray(0,PART))}]});
    expect(h.sent.map(p => p.index)).toEqual([1]);
  });

  it('refuses a different original even when its previous transfer is already processing', async () => {
    const h=harness(new Uint8Array([1,2,3]),[0]); h.transfer.state='processing'; h.hold();
    await expect(sendResumableFile(file(new Uint8Array([9,9,9])),h.transfer,{root,onProgress:vi.fn()})).rejects.toMatchObject({code:'UPLOAD_FINALIZE_CONFLICT'});
    expect(h.sent).toHaveLength(0); expect(h.fetch.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false);
  });

  it('keeps a processing acknowledgement pending and cancels polling without aborting the server transfer', async () => {
    const h=harness(); h.hold(); const controller=new AbortController(); let settled=false;
    const sending=sendResumableFile(file(h.bytes),h.transfer,{root,signal:controller.signal,onProgress:vi.fn()});
    const result=sending.then(() => {settled=true;},e => e);
    await vi.waitFor(() => expect(h.processingGets).toBe(1)); expect(settled).toBe(false); controller.abort();
    expect(await result).toMatchObject({name:'AbortError'});
    expect(h.fetch.mock.calls.some(([,init]) => init?.method==='DELETE')).toBe(false);
  });

  it('refreshes confirming status when the network returns', async () => {
    const h=harness(); h.transfer.acceptedParts=[0]; h.hold();
    const promise=confirmResumableFile(h.transfer,{root,onProgress:vi.fn()}); void promise.catch(() => {});
    await vi.waitFor(() => expect(h.processingGets).toBe(1)); h.deliver(); window.dispatchEvent(new Event('online'));
    expect((await promise).media?.id).toBe('media-1');
  });

  it('does not produce a receipt after the hard expiry or a rejected transfer', async () => {
    const h=harness(); h.transfer.state='rejected';
    await expect(sendResumableFile(file(h.bytes),h.transfer,{root,onProgress:vi.fn()})).rejects.toThrow();
    h.transfer.state='receiving'; h.transfer.hardExpiresAt=new Date(Date.now()-1).toISOString();
    await expect(sendResumableFile(file(h.bytes),h.transfer,{root,onProgress:vi.fn()})).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
  });
});

import type { UploadTransferOutcome, UploadTransferView } from '../../../shared/mobile-image-contract';
import { MOBILE_IMAGE_PART_BYTES, MAX_MOBILE_ORIGINAL_BYTES } from '../../../shared/mobile-image-contract';
import { api, ClientApiError } from '../../app/api';

export interface ResumableContext {root:string;signal?:AbortSignal;onProgress:(percent:number)=>void;onProcessing?:()=>void}
type PartProof={index:number;byteSize:number;sha256:string};
type FileProof={verified:Set<number>;hashes:Map<number,PartProof>;initialized:boolean};
const fileProofs=new WeakMap<File,Map<string,FileProof>>();
const aborted=() => new DOMException('Sending was cancelled.','AbortError');
const unavailable=() => new ClientApiError('IMAGE_PROCESSING_UNAVAILABLE','This photo is still being confirmed. Try again in a moment.',undefined,undefined,503);
function checkAbort(signal?:AbortSignal) {if (signal?.aborted) throw aborted();}
function retryable(error:unknown) {
  return !(error instanceof ClientApiError) || error.status===429 || (error.status!==undefined && error.status>=500);
}
function pause(ms:number,signal?:AbortSignal):Promise<void> {
  return new Promise((resolve,reject) => {
    checkAbort(signal);
    const clear=() => {clearTimeout(timer); signal?.removeEventListener('abort',cancel); window.removeEventListener('online',wake); document.removeEventListener('visibilitychange',visible);};
    const wake=() => {clear(); resolve();};
    const visible=() => {if (document.visibilityState==='visible') wake();};
    const cancel=() => {clear(); reject(aborted());};
    const timer=setTimeout(wake,ms);
    window.addEventListener('online',wake); document.addEventListener('visibilitychange',visible);
    signal?.addEventListener('abort',cancel,{once:true});
    if (signal?.aborted) cancel();
  });
}
async function request<T>(path:string, init:RequestInit, signal?:AbortSignal):Promise<T> {
  for (let attempt=0;;attempt++) {
    checkAbort(signal);
    try {return await api<T>(path,{...init,signal});}
    catch (error) {checkAbort(signal); if (attempt===2 || !retryable(error)) throw error; await pause(350*2**attempt,signal);}
  }
}
function pathFor(transfer:UploadTransferView, context:ResumableContext) {
  if (!context.root.startsWith('/api/') || context.root.includes('?') || context.root.includes('#')) throw unavailable();
  return `${context.root}/${encodeURIComponent(transfer.mediaId)}/transfers/${encodeURIComponent(transfer.id)}`;
}
function checked(outcome:UploadTransferOutcome, expected:UploadTransferView):UploadTransferOutcome {
  const t=outcome?.transfer;
  if (!t || t.id!==expected.id || t.mediaId!==expected.mediaId || t.partBytes!==MOBILE_IMAGE_PART_BYTES
    || !Number.isInteger(t.partCount) || t.partCount<1 || t.partCount>64 || !Array.isArray(t.acceptedParts)
    || new Set(t.acceptedParts).size!==t.acceptedParts.length
    || t.acceptedParts.some(index => !Number.isInteger(index) || index<0 || index>=t.partCount)
    || !Number.isFinite(Date.parse(t.expiresAt)) || !Number.isFinite(Date.parse(t.hardExpiresAt))) throw unavailable();
  if (['aborted','expired','rejected'].includes(t.state)) {
    throw new ClientApiError(t.state==='rejected' ? 'FILE_TYPE_UNSUPPORTED' : 'UPLOAD_TRANSFER_EXPIRED',
      t.state==='rejected' ? 'This photo could not be accepted. Choose another original.' : 'This upload expired or was canceled. Choose the photo again.',undefined,undefined,409);
  }
  if (!['receiving','processing','retryable','delivered'].includes(t.state)) throw unavailable();
  if (t.state!=='delivered' && Math.min(Date.parse(t.expiresAt),Date.parse(t.hardExpiresAt))<=Date.now()) {
    throw new ClientApiError('UPLOAD_TRANSFER_EXPIRED','This upload expired. Choose the photo again.',undefined,undefined,409);
  }
  if (t.state==='delivered' && (outcome.media?.id!==t.mediaId || outcome.media.uploadState!=='stored')) throw unavailable();
  return outcome;
}
async function part(file:File,index:number,signal?:AbortSignal) {
  checkAbort(signal);
  const bytes=await file.slice(index*MOBILE_IMAGE_PART_BYTES,Math.min(file.size,(index+1)*MOBILE_IMAGE_PART_BYTES)).arrayBuffer();
  const digest=await crypto.subtle.digest('SHA-256',bytes); checkAbort(signal);
  return {bytes,proof:{index,byteSize:bytes.byteLength,sha256:Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,'0')).join('')}};
}
async function proveSelection(file:File,t:UploadTransferView,cache:FileProof,path:string,signal?:AbortSignal) {
  if (cache.initialized && t.acceptedParts.every(index => cache.verified.has(index))) return;
  const parts:PartProof[]=[];
  for (const index of t.acceptedParts) {
    if (!cache.hashes.has(index)) cache.hashes.set(index,(await part(file,index,signal)).proof);
    parts.push(cache.hashes.get(index)!);
  }
  const result=await request<{verifiedParts:number[]}>(`${path}/verify`,{method:'POST',body:JSON.stringify({byteSize:file.size,parts})},signal);
  if (!Array.isArray(result?.verifiedParts) || result.verifiedParts.length!==parts.length
    || parts.some(p => !result.verifiedParts.includes(p.index))) throw unavailable();
  cache.initialized=true; t.acceptedParts.forEach(index => cache.verified.add(index));
}

/** A new File identity must prove all accepted slices before adopting an old receipt. */
export async function sendResumableFile(file:File, transfer:UploadTransferView, context:ResumableContext):Promise<UploadTransferOutcome> {
  const path=pathFor(transfer,context); const signal=context.signal;
  let outcome=checked(await request<UploadTransferOutcome>(path,{},signal),transfer);
  if (file.size<1 || file.size>MAX_MOBILE_ORIGINAL_BYTES || Math.ceil(file.size/MOBILE_IMAGE_PART_BYTES)!==outcome.transfer.partCount) {
    throw new ClientApiError('UPLOAD_FINALIZE_CONFLICT','Choose the same original photo to resume this upload.',undefined,undefined,409);
  }
  let files=fileProofs.get(file); if (!files) {files=new Map(); fileProofs.set(file,files);}
  let cache=files.get(path); if (!cache) {cache={verified:new Set(),hashes:new Map(),initialized:false}; files.set(path,cache);}
  await proveSelection(file,outcome.transfer,cache,path,signal);
  const progress=() => context.onProgress(100*outcome.transfer.acceptedParts.reduce((sum,index) => sum+Math.min(MOBILE_IMAGE_PART_BYTES,file.size-index*MOBILE_IMAGE_PART_BYTES),0)/file.size);
  progress();
  if (outcome.transfer.state==='delivered') return outcome;
  if (outcome.transfer.state==='receiving') {
    for (let index=0;index<outcome.transfer.partCount;index++) {
      if (outcome.transfer.acceptedParts.includes(index)) continue;
      checked(outcome,transfer); const chunk=await part(file,index,signal); cache.hashes.set(index,chunk.proof);
      for (let attempt=0;;attempt++) {
        try {
          const ack=await api<{index:number;accepted:boolean}>(`${path}/parts/${index}`,{method:'PUT',signal,
            headers:{'content-type':'application/octet-stream','x-part-sha256':chunk.proof.sha256},body:chunk.bytes});
          if (ack?.index!==index || ack.accepted!==true) throw unavailable();
          cache.verified.add(index); break;
        } catch (error) {
          checkAbort(signal); if (!retryable(error)) throw error;
          outcome=checked(await request<UploadTransferOutcome>(path,{},signal),transfer);
          if (outcome.transfer.acceptedParts.includes(index)) {await proveSelection(file,outcome.transfer,cache,path,signal); break;}
          if (attempt===2) throw error; await pause(350*2**attempt,signal);
        }
      }
      outcome=checked(await request<UploadTransferOutcome>(path,{},signal),transfer); progress();
      if (outcome.transfer.state!=='receiving') break;
    }
  }
  return confirmResumableFile(outcome.transfer,context);
}

/** A 202 or a transfer state alone is never a delivery receipt. */
export async function confirmResumableFile(transfer:UploadTransferView, context:ResumableContext):Promise<UploadTransferOutcome> {
  const path=pathFor(transfer,context); const signal=context.signal;
  context.onProcessing?.();
  let outcome=checked(await request<UploadTransferOutcome>(`${path}/complete`,{method:'POST',body:'{}'},signal),transfer);
  let processed=outcome.transfer.state==='processing'; let retryablePolls=0; let polls=0;
  while (outcome.transfer.state!=='delivered') {
    checkAbort(signal);
    outcome=checked(await request<UploadTransferOutcome>(path,{},signal),transfer);
    if (outcome.transfer.state==='delivered') break;
    if (outcome.transfer.state==='processing') processed=true;
    if (outcome.transfer.state==='rejected' || outcome.transfer.state==='receiving') throw unavailable();
    if (outcome.transfer.state==='retryable' && (processed || ++retryablePolls>=3)) throw unavailable();
    await pause(++polls<10 ? 1_000 : 5_000,signal);
  }
  context.onProgress(100); return outcome;
}

import { ApiError } from '../../shared/errors';
import { MediaRepository, uploadMediaView } from '../db/media';
import { UploadTransferRepository, uploadTransferView, type TransferIdentity, type TransferOutcome } from '../db/upload-transfers';
import type { AppEnv } from '../env';
import { readUploadPart } from '../storage/upload-parts';
import { cleanupUploadTransfers } from '../workflows/upload-transfer-cleanup';
import { dispatchUploadCompletion } from '../workflows/upload-completion';
import { z } from 'zod';

const reselectionProof=z.object({byteSize:z.number().int().min(1).max(512*1024**2),
  parts:z.array(z.object({index:z.number().int().min(0).max(63),byteSize:z.number().int().min(1).max(8*1024**2),
    sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()).max(64)}).strict();

function take<T>(outcome: TransferOutcome<T>, conflictCode:'UPLOAD_FINALIZE_CONFLICT'|'UPLOAD_PART_CONFLICT'='UPLOAD_FINALIZE_CONFLICT'): T {
  if (outcome.ok) return outcome.value;
  if (outcome.reason === 'forbidden') throw new ApiError('RESOURCE_FORBIDDEN','This upload belongs to a different session or event.',403);
  if (outcome.reason === 'expired') throw new ApiError('UPLOAD_TRANSFER_EXPIRED','This upload expired. Choose the photo again.',409);
  throw new ApiError(conflictCode,'This upload can no longer receive these bytes. Choose the same original to resume.',409);
}
const unavailable = () => new ApiError('IMAGE_PROCESSING_UNAVAILABLE','This photo upload is busy. Try again in a moment.',503);
const timestamp = () => new Date().toISOString();

export class UploadTransferService {
  private readonly transfers: UploadTransferRepository;
  constructor(private readonly env: AppEnv) { this.transfers = new UploadTransferRepository(env.DB); }

  async start(identity: Omit<TransferIdentity,'transferId'>) {
    // Reservation performs negotiated admission and creates the one transfer.
    // This replay endpoint cannot move a direct legacy reservation to parts-v1.
    const transferId = await this.transfers.findId(identity.mediaId);
    if (!transferId) throw new ApiError('UPLOAD_FINALIZE_CONFLICT','Start this photo with resumable upload enabled.',409);
    return this.status({...identity,transferId});
  }

  async status(identity: TransferIdentity) {
    const transfer = take(await this.transfers.getOwned(identity,timestamp()));
    const media = transfer.state==='delivered' ? await new MediaRepository(this.env.DB).getById(identity.mediaId) : null;
    return {transfer:uploadTransferView(transfer),...(media?.uploadState==='stored' && media.deletedAt===null ? {media:uploadMediaView(media)} : {})};
  }

  async complete(identity: TransferIdentity) {
    let current = take(await this.transfers.getOwned(identity,timestamp()));
    if (current.state==='delivered') {
      const data = await this.status(identity);
      if (data.media) return {status:200 as const,data};
    }
    take(await this.transfers.getWritable(identity,timestamp()));
    if (current.state==='receiving') {
      const claimed = await this.transfers.claimCompletion(identity,timestamp());
      current = take(await this.transfers.getOwned(identity,timestamp()));
      if (!claimed.ok && current.state!=='processing' && current.state!=='retryable') take(claimed);
    }
    if (current.state!=='processing' && current.state!=='retryable') throw new ApiError('UPLOAD_FINALIZE_CONFLICT','This upload cannot be completed.',409);
    await dispatchUploadCompletion(this.env,{transferId:identity.transferId,attempt:current.attempt});
    return {status:202 as const,data:await this.status(identity)};
  }

  async verifyReselection(identity:TransferIdentity, request:Request) {
    take(await this.transfers.getOwned(identity,timestamp()));
    const invalid=() => new ApiError('VALIDATION_FAILED','This photo verification request is invalid.',422);
    if (!request.body) throw invalid();
    const reader=request.body.getReader(); const bytes=new Uint8Array(12*1024); let size=0;
    try {
      for (;;) {const next=await reader.read(); if (next.done) break;
        if (next.value.length>bytes.length-size) throw invalid(); bytes.set(next.value,size); size+=next.value.length;}
    } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    let value:unknown;
    try {value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes.subarray(0,size)));} catch {throw invalid();}
    const parsed=reselectionProof.safeParse(value);
    if (!parsed.success || new Set(parsed.data.parts.map(p => p.index)).size!==parsed.data.parts.length) throw invalid();
    take(await this.transfers.verifyReselection(identity,parsed.data,timestamp()),'UPLOAD_PART_CONFLICT');
    return {verifiedParts:parsed.data.parts.map(part => part.index).sort((a,b) => a-b)};
  }

  async putPart(identity: TransferIdentity, indexText: string, request: Request) {
    const current = take(await this.transfers.getWritable(identity,timestamp()));
    if (!/^(0|[1-9][0-9]*)$/u.test(indexText)) throw new ApiError('VALIDATION_FAILED','That photo part does not exist.',422);
    const index = Number(indexText);
    if (!Number.isSafeInteger(index) || index >= current.partCount) throw new ApiError('VALIDATION_FAILED','That photo part does not exist.',422);
    const {bytes,sha256} = await readUploadPart(request,Math.min(current.partBytes,current.byteSize-index*current.partBytes));
    const proof = {index,byteSize:bytes.byteLength,sha256};
    take(await this.transfers.getWritable(identity,timestamp()));
    const assembly = take(await this.transfers.createAssemblyIntent(identity,timestamp()));
    let uploadId = assembly.uploadId;
    if (!uploadId) {
      if (!await this.transfers.claimAssemblyCreate(identity,assembly,timestamp())) throw unavailable();
      try {
        const created = await this.env.CANONICAL_MEDIA_BUCKET.createMultipartUpload(assembly.objectKey);
        uploadId = created.uploadId;
        if (!await this.transfers.recordAssemblyCreated(assembly,uploadId,timestamp())) throw unavailable();
      } catch {
        // A rejected promise does not tell us whether R2 created the upload.
        // Keep the intent forever until an authoritative reconciliation resolves it.
        await this.transfers.settleUnknownCreate(assembly,timestamp());
        throw unavailable();
      }
    }
    const claimed = take(await this.transfers.claimPart(identity,proof,timestamp()),'UPLOAD_PART_CONFLICT');
    if (claimed.alreadyAccepted) return {index,accepted:true as const};
    try {
      const part = await this.env.CANONICAL_MEDIA_BUCKET.resumeMultipartUpload(assembly.objectKey,uploadId).uploadPart(index+1,bytes);
      if (part.partNumber !== index+1) throw unavailable();
      take(await this.transfers.acceptPart(identity,proof,claimed.claim,part.etag,timestamp()),'UPLOAD_PART_CONFLICT');
      return {index,accepted:true as const};
    } catch (error) { if (error instanceof ApiError) throw error; throw unavailable(); }
    finally { await this.transfers.settlePart(identity,proof,claimed.claim,timestamp()); }
  }

  async abort(identity: TransferIdentity) {
    const current = take(await this.transfers.getOwned(identity,timestamp()));
    if (current.state !== 'aborted' && current.state !== 'expired') take(await this.transfers.fenceOwned(identity,'aborted',timestamp()));
    await new MediaRepository(this.env.DB).failReservation(identity.mediaId);
    await cleanupUploadTransfers(this.env,new Date(),identity.eventId);
    return this.status(identity);
  }
}

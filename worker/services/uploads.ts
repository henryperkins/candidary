import {
  MAX_IMAGE_BYTES,
  UPLOAD_BATCH_SIZE,
  UPLOAD_RESERVATION_TTL_SECONDS,
  type SupportedImageType,
} from '../../shared/constants';
import type { UploadBatchItemView } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { isLegacyUploadMimeType, resolveImageDeclaration, type KnownImageMimeType } from '../../shared/image-formats';
import { resolvePhotoIntake } from '../../shared/rsvp';
import { MediaRepository, uploadMediaView, type ReserveMediaRecord } from '../db/media';
import type { EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { assertWorkerIngressEnabled } from '../media-upload-release';
import { sanitizeFilename } from '../security/filenames';
import { mediaReservationObjectKey } from '../storage/media-keys';
import type { UploadAuthority } from './upload-authority';
import { getDeclarationAdmission } from '../mobile-image-release';
import { UploadTransferRepository, uploadTransferView } from '../db/upload-transfers';
import { MAX_MOBILE_ORIGINAL_BYTES } from '../../shared/mobile-image-contract';

export interface InitiateUploadInput {
  filename: string;
  mimeType: string;
  byteSize: number;
  idempotencyKey: string;
  guestName?: string;
  caption?: string | null;
  transport?: 'parts-v1';
}

export type BatchUploadFile = Omit<InitiateUploadInput, 'guestName'>;

export type BatchUploadResult = UploadBatchItemView;

export function resolveSupportedImageType(filename: string, mimeType: string): SupportedImageType {
  const declaration = resolveImageDeclaration(filename, mimeType);
  if (declaration && isLegacyUploadMimeType(declaration.mimeType)) return declaration.mimeType;
  throw new ApiError('FILE_TYPE_UNSUPPORTED', 'Choose a JPG, PNG, WebP, HEIC, or HEIF photo.', 415);
}

export class UploadService {
  constructor(private readonly env: AppEnv) {}

  // Photo delivery has to be *open*, not merely permitted. Since 0010 an event
  // carries `uploads_enabled = 1` from creation and the schedule decides when it
  // opens, so testing the flag alone would accept a photo months before the day.
  private assertCanUpload(authority: UploadAuthority, event: EventRecord, now: Date) {
    if (event.deletedAt) {
      throw new ApiError('EVENT_DELETED', 'This event has been deleted.', 410);
    }
    if (authority.kind === 'guest' && !resolvePhotoIntake(event, now).photosOpen) {
      throw new ApiError('UPLOADS_DISABLED', 'Photo uploads are paused for this event.', 409);
    }
    if (authority.kind !== 'guest'
      && Date.parse(event.managementAccessExpiresAt) <= now.getTime()) {
      throw new ApiError('EVENT_EXPIRED', 'This event access has expired.', 410);
    }
  }

  private attribution(authority: UploadAuthority, guestName: string | undefined): string {
    if (authority.kind !== 'guest') return 'Host';
    const attribution = guestName?.trim() ?? '';
    if (!attribution || attribution.length > 80) {
      throw new ApiError('VALIDATION_FAILED', 'Enter your name before adding photos.', 422, {
        guestName: 'Your name is required.',
      });
    }
    return attribution;
  }

  private uploadUrl(authority: UploadAuthority, event: EventRecord, mediaId: string): string {
    if (authority.kind === 'guest') {
      return `/api/event/${encodeURIComponent(event.slug)}/uploads/${encodeURIComponent(mediaId)}/content`;
    }
    return `/api/manage/events/${encodeURIComponent(event.id)}/uploads/${encodeURIComponent(mediaId)}/content`;
  }

  private prepareReservation(
    authority: UploadAuthority,
    event: EventRecord,
    input: InitiateUploadInput,
    attribution: string,
    now: Date,
    admitted?: {mimeType:KnownImageMimeType;maxBytes:number},
  ): ReserveMediaRecord {
    const mimeType = admitted?.mimeType ?? resolveSupportedImageType(input.filename, input.mimeType);
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > (admitted?.maxBytes ?? MAX_IMAGE_BYTES)) {
      throw new ApiError('FILE_TOO_LARGE', 'Choose a photo no larger than 20 MB.', 413);
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
      throw new ApiError('VALIDATION_FAILED', 'The upload key is missing or invalid.', 422, { idempotencyKey: 'Choose the file again.' });
    }

    const mediaId = crypto.randomUUID();
    return {
      id: mediaId,
      eventId: event.id,
      uploaderSessionId: authority.actorSessionId,
      authority,
      objectKey: mediaReservationObjectKey(event.id, mediaId),
      originalFilename: sanitizeFilename(input.filename),
      mimeType,
      declaredByteSize: input.byteSize,
      guestName: attribution,
      caption: input.caption?.trim().slice(0, 300) || null,
      idempotencyKey: input.idempotencyKey,
      reservationExpiresAt: new Date(now.getTime() + UPLOAD_RESERVATION_TTL_SECONDS * 1000).toISOString(),
      createdAt: now.toISOString(),
    };
  }

  async initiate(
    authority: UploadAuthority,
    event: EventRecord,
    input: InitiateUploadInput,
    now = new Date(),
  ) {
    assertWorkerIngressEnabled();
    this.assertCanUpload(authority, event, now);
    const attribution = this.attribution(authority, input.guestName);
    const declared = resolveImageDeclaration(input.filename,input.mimeType);
    const extended = declared !== null && (!isLegacyUploadMimeType(declared.mimeType) || input.byteSize > MAX_IMAGE_BYTES);
    if (extended && input.transport === 'parts-v1') {
      const repository = new MediaRepository(this.env.DB);
      const prepared = this.prepareReservation(authority,event,input,attribution,now,{
        mimeType:declared.mimeType as KnownImageMimeType,maxBytes:MAX_MOBILE_ORIGINAL_BYTES,
      });
      // New-intake controls must not strand an already admitted transfer. A replay
      // still checks its current actor, immutable metadata, deletion and expiry.
      // Include the transfer even after delivery so a reselected File is verified.
      const existing = await repository.getIdempotent(prepared);
      const priorTransfers = new UploadTransferRepository(this.env.DB);
      const priorId = existing ? await priorTransfers.findId(existing.id) : null;
      if (existing && priorId) {
        const prior = await priorTransfers.getOwned({transferId:priorId,mediaId:existing.id,eventId:event.id,authority},now.toISOString());
        if (!prior.ok) throw new ApiError('UPLOAD_FINALIZE_CONFLICT','This upload can no longer be resumed. Choose the photo again.',409);
        return {media:uploadMediaView(existing),alreadyDelivered:existing.uploadState === 'stored',transport:'parts-v1' as const,transfer:uploadTransferView(prior.value)};
      }
      const admission = await getDeclarationAdmission(declared,this.env);
      if (!admission.enabled || !admission.currentFingerprint) {
        if (admission.reason === 'unavailable') throw new ApiError('IMAGE_PROCESSING_UNAVAILABLE','Photo processing is temporarily unavailable. Try again shortly.',503);
        throw new ApiError('FILE_TYPE_UNSUPPORTED','This photo format or size is not available for this event yet.',415);
      }
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > admission.maxOriginalBytes)
        throw new ApiError('FILE_TOO_LARGE','This photo exceeds the current upload limit.',413);
      prepared.mobileAdmission = {caseIds:admission.caseIds};
      const transfers = new UploadTransferRepository(this.env.DB,{buildFingerprint:admission.currentFingerprint,caseId:admission.caseIds[0]!});
      const media = await repository.reserve(prepared);
      if (media.uploadState === 'stored') {
        const winner = await transfers.findId(media.id);
        const prior = winner && await transfers.getOwned({transferId:winner,mediaId:media.id,eventId:event.id,authority},now.toISOString());
        if (!prior || !prior.ok) throw new ApiError('UPLOAD_FINALIZE_CONFLICT','This upload changed. Choose the photo again.',409);
        return {media:uploadMediaView(media),alreadyDelivered:true as const,transport:'parts-v1' as const,transfer:uploadTransferView(prior.value)};
      }
      const transferId = await transfers.findId(media.id) ?? crypto.randomUUID();
      let outcome = await transfers.initiate({transferId,mediaId:media.id,eventId:event.id,authority,declared,byteSize:input.byteSize,now:now.toISOString()});
      if (!outcome.ok) {
        const winner = await transfers.findId(media.id);
        if (winner) outcome = await transfers.getOwned({transferId:winner,mediaId:media.id,eventId:event.id,authority},now.toISOString());
        else if (media.id === prepared.id) await repository.failReservation(media.id);
      }
      if (!outcome.ok) throw new ApiError('UPLOAD_FINALIZE_CONFLICT','This upload changed while it was being prepared. Try again.',409);
      return {media:uploadMediaView(media),alreadyDelivered:false as const,transport:'parts-v1' as const,transfer:uploadTransferView(outcome.value)};
    }
    const repository = new MediaRepository(this.env.DB);
    const media = await repository.reserve(
      this.prepareReservation(authority, event, input, attribution, now),
    );
    if (media.uploadState === 'stored') {
      return { media: uploadMediaView(media), alreadyDelivered: true as const };
    }
    return {
      media: uploadMediaView(media),
      alreadyDelivered: false as const,
      uploadUrl: this.uploadUrl(authority, event, media.id),
      uploadUrlExpiresAt: media.reservationExpiresAt,
    };
  }

  async initiateBatch(
    authority: UploadAuthority,
    event: EventRecord,
    input: { guestName?: string; files: BatchUploadFile[] },
    now = new Date(),
  ): Promise<{ items: BatchUploadResult[] }> {
    assertWorkerIngressEnabled();
    this.assertCanUpload(authority, event, now);
    const attribution = this.attribution(authority, input.guestName);
    if (input.files.length < 1 || input.files.length > UPLOAD_BATCH_SIZE) {
      throw new ApiError('VALIDATION_FAILED', `Choose between 1 and ${UPLOAD_BATCH_SIZE} photos.`, 422);
    }

    const prepared: Array<{ index: number; reservation: ReserveMediaRecord }> = [];
    const items: Array<BatchUploadResult | undefined> = new Array(input.files.length);
    for (const [index, file] of input.files.entries()) {
      try {
        const declared = resolveImageDeclaration(file.filename,file.mimeType);
        if (file.transport === 'parts-v1' && declared && (!isLegacyUploadMimeType(declared.mimeType) || file.byteSize > MAX_IMAGE_BYTES)) {
          const result = await this.initiate(authority,event,{...file,guestName:input.guestName},now);
          items[index] = {idempotencyKey:file.idempotencyKey,status:'accepted',...result};
          continue;
        }
        prepared.push({
          index,
          reservation: this.prepareReservation(
            authority,
            event,
            { ...file, guestName: input.guestName },
            attribution,
            now,
          ),
        });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        items[index] = {
          idempotencyKey: file.idempotencyKey,
          status: 'rejected',
          error: { code: error.code, message: error.message },
        };
      }
    }

    const reservations = await new MediaRepository(this.env.DB)
      .reserveBatch(prepared.map(({ reservation }) => reservation));
    await Promise.all(prepared.map(async ({ index }, resultIndex) => {
      const file = input.files[index]!;
      const result = reservations[resultIndex]!;
      if (result.status === 'rejected') {
        items[index] = {
          idempotencyKey: file.idempotencyKey,
          status: 'rejected',
          error: { code: result.error.code, message: result.error.message },
        };
        return;
      }
      if (result.media.uploadState === 'stored') {
        items[index] = {
          idempotencyKey: file.idempotencyKey,
          status: 'accepted',
          media: uploadMediaView(result.media),
          alreadyDelivered: true,
        };
        return;
      }
      items[index] = {
        idempotencyKey: file.idempotencyKey,
        status: 'accepted',
        media: uploadMediaView(result.media),
        alreadyDelivered: false,
        uploadUrl: this.uploadUrl(authority, event, result.media.id),
        uploadUrlExpiresAt: result.media.reservationExpiresAt,
      };
    }));
    return { items: items as BatchUploadResult[] };
  }
}

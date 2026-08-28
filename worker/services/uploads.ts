import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
  UPLOAD_BATCH_SIZE,
  UPLOAD_RESERVATION_TTL_SECONDS,
  type SupportedImageType,
} from '../../shared/constants';
import type { UploadBatchItemView } from '../../shared/contracts';
import { ApiError } from '../../shared/errors';
import { resolvePhotoIntake } from '../../shared/rsvp';
import { MediaRepository, uploadMediaView, type ReserveMediaRecord } from '../db/media';
import type { EventRecord } from '../db/types';
import type { AppEnv } from '../env';
import { assertWorkerIngressEnabled } from '../media-upload-release';
import { sanitizeFilename } from '../security/filenames';
import { mediaReservationObjectKey } from '../storage/media-keys';
import type { UploadAuthority } from './upload-authority';

export interface InitiateUploadInput {
  filename: string;
  mimeType: string;
  byteSize: number;
  idempotencyKey: string;
  guestName?: string;
  caption?: string | null;
}

export type BatchUploadFile = Omit<InitiateUploadInput, 'guestName'>;

export type BatchUploadResult = UploadBatchItemView;

const PROVISIONAL_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const VENDOR_HEIF_TYPES = new Map<string, SupportedImageType>([
  ['image/x-heic', 'image/heic'],
  ['image/x-heic-sequence', 'image/heic-sequence'],
  ['image/x-heif', 'image/heif'],
  ['image/x-heif-sequence', 'image/heif-sequence'],
]);

export function resolveSupportedImageType(filename: string, mimeType: string): SupportedImageType {
  const normalized = mimeType.trim().toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.includes(normalized as SupportedImageType)) return normalized as SupportedImageType;
  if (normalized === 'image/jpg') return 'image/jpeg';
  const extension = filename.trim().toLowerCase().split('.').pop();
  const vendorType = VENDOR_HEIF_TYPES.get(normalized);
  if (vendorType && ((vendorType.includes('heic') && extension === 'heic') || (vendorType.includes('heif') && extension === 'heif'))) {
    return vendorType;
  }
  if (PROVISIONAL_MIME_TYPES.has(normalized)) {
    if (extension === 'heic') return 'image/heic';
    if (extension === 'heif') return 'image/heif';
  }
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
  ): ReserveMediaRecord {
    const mimeType = resolveSupportedImageType(input.filename, input.mimeType);
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_IMAGE_BYTES) {
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

import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
  UPLOAD_RESERVATION_TTL_SECONDS,
  type SupportedImageType,
} from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import { MediaRepository } from '../db/media';
import type { AppEnv, AuthenticatedSession } from '../env';
import { sanitizeFilename } from '../security/filenames';
import { presignUpload } from '../storage/presign';

export interface InitiateUploadInput {
  filename: string;
  mimeType: string;
  byteSize: number;
  idempotencyKey: string;
  guestName?: string | null;
  caption?: string | null;
}

export class UploadService {
  constructor(private readonly env: AppEnv) {}

  async initiate(auth: AuthenticatedSession, input: InitiateUploadInput, now = new Date()) {
    if (auth.session.role !== 'guest') throw new ApiError('ROLE_FORBIDDEN', 'Only guests can add event photos.', 403);
    if (!auth.event.uploadsEnabled) throw new ApiError('UPLOADS_DISABLED', 'Photo uploads are paused for this event.', 409);
    if (!SUPPORTED_IMAGE_TYPES.includes(input.mimeType as SupportedImageType)) {
      throw new ApiError('FILE_TYPE_UNSUPPORTED', 'Choose a JPG, PNG, or WebP image.', 415);
    }
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_IMAGE_BYTES) {
      throw new ApiError('FILE_TOO_LARGE', 'Choose an image no larger than 10 MB.', 413);
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
      throw new ApiError('VALIDATION_FAILED', 'The upload key is missing or invalid.', 422, { idempotencyKey: 'Choose the file again.' });
    }

    const mediaId = crypto.randomUUID();
    const repository = new MediaRepository(this.env.DB);
    const media = await repository.reserve({
      id: mediaId,
      eventId: auth.event.id,
      uploaderSessionId: auth.session.id,
      objectKey: `events/${auth.event.id}/media/${mediaId}`,
      originalFilename: sanitizeFilename(input.filename),
      mimeType: input.mimeType as SupportedImageType,
      declaredByteSize: input.byteSize,
      guestName: input.guestName?.trim().slice(0, 80) || '',
      caption: input.caption?.trim().slice(0, 300) || null,
      idempotencyKey: input.idempotencyKey,
      reservationExpiresAt: new Date(now.getTime() + UPLOAD_RESERVATION_TTL_SECONDS * 1000).toISOString(),
      createdAt: now.toISOString(),
    });
    const signed = await presignUpload(this.env, media.objectKey, media.mimeType);
    return { media, uploadUrl: signed.url, uploadUrlExpiresAt: signed.expiresAt };
  }
}

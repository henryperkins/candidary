import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
  UPLOAD_BATCH_SIZE,
  UPLOAD_RESERVATION_TTL_SECONDS,
  type SupportedImageType,
} from '../../shared/constants';
import { ApiError, type ApiErrorCode } from '../../shared/errors';
import { MediaRepository } from '../db/media';
import type { AppEnv, AuthenticatedSession } from '../env';
import { sanitizeFilename } from '../security/filenames';
import { presignUpload } from '../storage/presign';

export interface InitiateUploadInput {
  filename: string;
  mimeType: string;
  byteSize: number;
  idempotencyKey: string;
  guestName: string;
  caption?: string | null;
}

export type BatchUploadFile = Omit<InitiateUploadInput, 'guestName'>;

export type BatchUploadResult =
  | ({ idempotencyKey: string; status: 'accepted' } & Awaited<ReturnType<UploadService['initiate']>>)
  | { idempotencyKey: string; status: 'rejected'; error: { code: ApiErrorCode; message: string } };

const PROVISIONAL_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export function resolveSupportedImageType(filename: string, mimeType: string): SupportedImageType {
  const normalized = mimeType.trim().toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.includes(normalized as SupportedImageType)) return normalized as SupportedImageType;
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (PROVISIONAL_MIME_TYPES.has(normalized)) {
    const extension = filename.trim().toLowerCase().split('.').pop();
    if (extension === 'heic') return 'image/heic';
    if (extension === 'heif') return 'image/heif';
  }
  throw new ApiError('FILE_TYPE_UNSUPPORTED', 'Choose a JPG, PNG, WebP, HEIC, or HEIF photo.', 415);
}

export class UploadService {
  constructor(private readonly env: AppEnv) {}

  async initiate(auth: AuthenticatedSession, input: InitiateUploadInput, now = new Date()) {
    if (auth.session.role !== 'guest') throw new ApiError('ROLE_FORBIDDEN', 'Only guests can add event photos.', 403);
    if (!auth.event.uploadsEnabled) throw new ApiError('UPLOADS_DISABLED', 'Photo uploads are paused for this event.', 409);
    const guestName = input.guestName.trim();
    if (!guestName || guestName.length > 80) {
      throw new ApiError('VALIDATION_FAILED', 'Enter your name before adding photos.', 422, {
        guestName: 'Your name is required.',
      });
    }
    const mimeType = resolveSupportedImageType(input.filename, input.mimeType);
    if (!Number.isInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > MAX_IMAGE_BYTES) {
      throw new ApiError('FILE_TOO_LARGE', 'Choose a photo no larger than 20 MB.', 413);
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
      mimeType,
      declaredByteSize: input.byteSize,
      guestName,
      caption: input.caption?.trim().slice(0, 300) || null,
      idempotencyKey: input.idempotencyKey,
      reservationExpiresAt: new Date(now.getTime() + UPLOAD_RESERVATION_TTL_SECONDS * 1000).toISOString(),
      createdAt: now.toISOString(),
    });
    const signed = await presignUpload(this.env, media.objectKey, media.mimeType);
    return { media, uploadUrl: signed.url, uploadUrlExpiresAt: signed.expiresAt };
  }

  async initiateBatch(
    auth: AuthenticatedSession,
    input: { guestName: string; files: BatchUploadFile[] },
    now = new Date(),
  ): Promise<{ items: BatchUploadResult[] }> {
    const guestName = input.guestName.trim();
    if (!guestName || guestName.length > 80) {
      throw new ApiError('VALIDATION_FAILED', 'Enter your name before adding photos.', 422, {
        guestName: 'Your name is required.',
      });
    }
    if (input.files.length < 1 || input.files.length > UPLOAD_BATCH_SIZE) {
      throw new ApiError('VALIDATION_FAILED', `Choose between 1 and ${UPLOAD_BATCH_SIZE} photos.`, 422);
    }

    const items: BatchUploadResult[] = [];
    for (const file of input.files) {
      try {
        const accepted = await this.initiate(auth, { ...file, guestName }, now);
        items.push({ idempotencyKey: file.idempotencyKey, status: 'accepted', ...accepted });
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        items.push({
          idempotencyKey: file.idempotencyKey,
          status: 'rejected',
          error: { code: error.code, message: error.message },
        });
      }
    }
    return { items };
  }
}

import { MAX_IMAGE_BYTES } from '../../shared/constants';
import { ApiError } from '../../shared/errors';
import type { MediaRecord } from '../db/types';
import type { MediaRepository } from '../db/media';
import { inspectImageHeader } from '../security/image-metadata';

export async function finalizeStoredMedia(
  bucket: R2Bucket,
  repository: MediaRepository,
  media: MediaRecord,
  expirationCheckTime = new Date(),
): Promise<MediaRecord> {
  if (media.uploadState === 'stored') return media;
  if (media.uploadState !== 'reserved') {
    throw new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This upload can no longer be finalized.', 409);
  }
  if (Date.parse(media.reservationExpiresAt) <= expirationCheckTime.getTime()) {
    await bucket.delete(media.objectKey);
    await repository.failReservation(media.id);
    throw new ApiError('UPLOAD_RESERVATION_EXPIRED', 'This upload reservation expired. Choose the file again.', 409);
  }

  const object = await bucket.head(media.objectKey);
  if (!object) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The uploaded object has not arrived yet.', 409);

  if (object.size > media.declaredByteSize || object.size > MAX_IMAGE_BYTES) {
    await bucket.delete(media.objectKey);
    await repository.failReservation(media.id);
    throw new ApiError('FILE_TOO_LARGE', 'The uploaded image is larger than the reserved size.', 413);
  }
  if (object.httpMetadata?.contentType !== media.mimeType) {
    await bucket.delete(media.objectKey);
    await repository.failReservation(media.id);
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded image type does not match its reservation.', 415);
  }

  const headBytes = await bucket.get(media.objectKey, { range: { offset: 0, length: Math.min(object.size, 65_536) } });
  if (!headBytes?.body) throw new ApiError('UPLOAD_OBJECT_MISSING', 'The uploaded object could not be read.', 409);
  let metadata;
  try {
    metadata = inspectImageHeader(new Uint8Array(await new Response(headBytes.body).arrayBuffer()));
  } catch {
    await bucket.delete(media.objectKey);
    await repository.failReservation(media.id);
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded file is not a supported image.', 415);
  }
  const signatureMatches = metadata.mimeType === media.mimeType
    || (media.mimeType === 'image/heic-sequence' && metadata.mimeType === 'image/heic')
    || (media.mimeType === 'image/heif-sequence' && metadata.mimeType === 'image/heif');
  if (!signatureMatches) {
    await bucket.delete(media.objectKey);
    await repository.failReservation(media.id);
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'The uploaded image signature does not match its type.', 415);
  }

  return repository.finalize(media.id, {
    byteSize: object.size,
    width: metadata.width,
    height: metadata.height,
  });
}

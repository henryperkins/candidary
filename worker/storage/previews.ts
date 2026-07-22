import { ApiError } from '../../shared/errors';
import type { MediaRepository } from '../db/media';
import type { MediaRecord } from '../db/types';
import type { AppEnv } from '../env';
import { MediaRepository as DefaultMediaRepository } from '../db/media';

const BROWSER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function getOrCreatePreview(
  env: AppEnv,
  media: MediaRecord,
  repository: MediaRepository = new DefaultMediaRepository(env.DB),
): Promise<R2ObjectBody> {
  const previewObjectKey = media.previewObjectKey ?? `events/${media.eventId}/previews/${media.id}.webp`;
  const cached = await env.MEDIA_BUCKET.get(previewObjectKey);
  if (cached?.body) {
    if (!media.previewObjectKey) await repository.setPreviewObjectKey(media.id, previewObjectKey);
    return cached;
  }

  const original = await env.MEDIA_BUCKET.get(media.objectKey);
  if (!original?.body) {
    throw new ApiError('UPLOAD_OBJECT_MISSING', 'This photo preview is temporarily unavailable.', 404);
  }

  const originalBytes = await original.arrayBuffer();
  let previewBytes: ArrayBuffer | null = null;
  let contentType = 'image/webp';
  if (env.IMAGES) {
    const transformed = await env.IMAGES
      .input(new Response(originalBytes).body!)
      .transform({ width: 1600, height: 1600, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: 82 });
    const transformedBytes = await new Response(transformed.image()).arrayBuffer();
    if (transformedBytes.byteLength > 0) previewBytes = transformedBytes;
  }
  if (!previewBytes && BROWSER_IMAGE_TYPES.has(media.mimeType)) {
    previewBytes = originalBytes;
    contentType = media.mimeType;
  }
  if (!previewBytes) {
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'This photo needs the image-preview service before it can be displayed.', 503);
  }

  await env.MEDIA_BUCKET.put(previewObjectKey, previewBytes, {
    httpMetadata: { contentType, cacheControl: 'private, max-age=31536000, immutable' },
    customMetadata: { sourceMediaId: media.id },
  });
  await repository.setPreviewObjectKey(media.id, previewObjectKey);
  const stored = await env.MEDIA_BUCKET.get(previewObjectKey);
  if (!stored?.body) throw new Error('Stored photo preview could not be read.');
  return stored;
}

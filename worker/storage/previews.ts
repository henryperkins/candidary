import { ApiError } from '../../shared/errors';
import type { MediaRecord } from '../db/types';
import type { AppEnv } from '../env';

export async function getOrCreatePreview(
  env: AppEnv,
  media: MediaRecord,
): Promise<{ body: ReadableStream; size: number; httpMetadata?: R2HTTPMetadata }> {
  if (media.previewObjectKey) {
    const cached = await env.MEDIA_BUCKET.get(media.previewObjectKey);
    if (cached?.body) return cached;
  }

  const originalBucket = media.objectBucketGeneration === 'canonical'
    ? env.CANONICAL_MEDIA_BUCKET
    : env.MEDIA_BUCKET;
  const original = await originalBucket.get(media.objectKey);
  if (!original?.body) {
    throw new ApiError('UPLOAD_OBJECT_MISSING', 'This photo preview is temporarily unavailable.', 404);
  }

  const originalBytes = await original.arrayBuffer();
  let previewBytes: ArrayBuffer | null = null;
  if (env.IMAGES) {
    const transformed = await env.IMAGES
      .input(new Response(originalBytes).body!)
      .transform({ width: 1600, height: 1600, fit: 'scale-down' })
      .output({ format: 'image/webp', quality: 82 });
    const transformedBytes = await new Response(transformed.image()).arrayBuffer();
    if (transformedBytes.byteLength > 0) previewBytes = transformedBytes;
  }
  if (!previewBytes) {
    throw new ApiError('FILE_TYPE_UNSUPPORTED', 'This photo needs the image-preview service before it can be displayed.', 503);
  }

  // New previews are deliberately ephemeral. Persisting a derivative creates a
  // second cross-store writer whose R2 PUT can finish after media/event deletion.
  // Existing recorded previews remain readable for backward compatibility.
  return {
    body: new Response(previewBytes).body!,
    size: previewBytes.byteLength,
    httpMetadata: { contentType: 'image/webp' },
  };
}

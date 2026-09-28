import type { ImageRangeReader } from '../security/image-range-reader';
import { assertImageRange } from '../security/image-reader-core';
import { ApiError } from '../../shared/errors';
import { createHash } from 'node:crypto';

export async function sha256ImageStream(body: ReadableStream<Uint8Array>, expectedBytes: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) {await body.cancel(); throw changed();}
  const reader = body.getReader(); const hash = createHash('sha256'); let bytes = 0;
  const abort = () => {void reader.cancel(signal?.reason).catch(() => {});};
  signal?.addEventListener('abort',abort,{once:true});
  try {
    if (signal?.aborted) {await reader.cancel(signal.reason); throw new DOMException('Aborted','AbortError');}
    for (;;) {
      const chunk = await reader.read();
      if (signal?.aborted) throw new DOMException('Aborted','AbortError');
      if (chunk.done) break;
      if (chunk.value.byteLength > expectedBytes-bytes) {await reader.cancel(); throw changed();}
      bytes += chunk.value.byteLength; hash.update(chunk.value);
    }
    if (bytes !== expectedBytes) throw changed();
    return hash.digest('hex');
  } finally {signal?.removeEventListener('abort',abort); reader.releaseLock();}
}

export async function openPinnedImage(bucket:R2Bucket,key:string,etag:string,byteSize:number): Promise<R2ObjectBody> {
  const object = await bucket.get(key,{onlyIf:{etagMatches:etag}});
  if (!object || !('body' in object) || object.etag !== etag || object.size !== byteSize) {
    if (object && 'body' in object) await object.body.cancel();
    throw changed();
  }
  return object;
}

function changed(): ApiError {
  return new ApiError('UPLOAD_FINALIZE_CONFLICT', 'This image changed while it was being inspected. Try again.', 409);
}

export function r2ImageReader(bucket: R2Bucket, key: string, etag: string, size: number): ImageRangeReader {
  assertImageRange(size, 0, 0);
  return { size, read: async (offset, length) => {
    assertImageRange(size, offset, length);
    if (!length) return new Uint8Array(0);
    const object = await bucket.get(key, { onlyIf: { etagMatches: etag }, range: { offset, length } });
    if (!object || !('body' in object) || object.etag !== etag || object.size !== size) throw changed();
    const bytes = new Uint8Array(length);
    const stream = object.body.getReader();
    let written = 0;
    try {
      while (true) {
        const chunk = await stream.read();
        if (chunk.done) break;
        if (chunk.value.length > length - written) { await stream.cancel(); throw changed(); }
        bytes.set(chunk.value, written);
        written += chunk.value.length;
      }
    } finally { stream.releaseLock(); }
    if (written !== length) throw changed();
    return bytes;
  } };
}

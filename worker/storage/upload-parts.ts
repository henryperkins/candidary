import { ApiError } from '../../shared/errors';
import { UPLOAD_PART_BYTES } from '../db/upload-transfers';

/** A dishonest Content-Length cannot turn an 8 MiB part into an unbounded buffer. */
export async function readUploadPart(request: Request, expectedBytes: number): Promise<{bytes:Uint8Array<ArrayBuffer>;sha256:string}> {
  const length = request.headers.get('content-length');
  const digest = request.headers.get('x-part-sha256');
  const invalid = () => new ApiError('VALIDATION_FAILED','This photo part could not be read. Try again.',422);
  if (length === null) throw new ApiError('VALIDATION_FAILED','This photo part needs its size.',411);
  if (!/^[1-9][0-9]*$/u.test(length) || Number(length) !== expectedBytes || expectedBytes < 1 || expectedBytes > UPLOAD_PART_BYTES
    || !digest || !/^[0-9a-f]{64}$/u.test(digest) || !request.body) throw invalid();
  const bytes = new Uint8Array(expectedBytes);
  const reader = request.body.getReader(); let offset = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      if (part.value.byteLength > bytes.length-offset) { await reader.cancel(); throw invalid(); }
      bytes.set(part.value,offset); offset += part.value.byteLength;
    }
  } catch (error) { if (error instanceof ApiError) throw error; throw invalid(); }
  finally { reader.releaseLock(); }
  if (offset !== expectedBytes) throw invalid();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map((n) => n.toString(16).padStart(2,'0')).join('');
  if (digest !== hash) throw invalid();
  return {bytes,sha256:hash};
}

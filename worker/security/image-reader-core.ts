export interface ImageRangeReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export type ImageReadRequest = { offset: number; length: number };
export type ImageParser<T> = Generator<ImageReadRequest, T, Uint8Array>;
export const IMAGE_METADATA_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 256;
const MAX_STRUCTURES = 16_384;

export class ImageInspectionError extends Error {
  constructor(readonly code: 'IMAGE_MALFORMED' | 'IMAGE_METADATA_LIMIT' | 'IMAGE_TYPE_UNSUPPORTED', message: string) {
    super(message);
    this.name = 'ImageInspectionError';
  }
}
export function malformed(message = 'Image structure is malformed or truncated.'): never {
  throw new ImageInspectionError('IMAGE_MALFORMED', message);
}
export function assertImageRange(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(length) || length < 0 || offset > size || length > size - offset) {
    malformed('Image range is outside safe source bounds.');
  }
}
export function imageView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
export function imageAscii(bytes: Uint8Array, start = 0, length = bytes.length - start): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Shared work policy for buffered and R2 parsing, with a small forward cache. */
export class ImageReadCursor {
  private cache: Uint8Array = new Uint8Array(0);
  private cacheOffset = 0;
  private bytes = 0;
  private requests = 0;
  private structures = 0;
  constructor(readonly size: number) { assertImageRange(size, 0, 0); }

  structure(): void {
    if (++this.structures > MAX_STRUCTURES) this.limit();
  }
  private limit(): never {
    throw new ImageInspectionError('IMAGE_METADATA_LIMIT', 'Image metadata inspection exceeds the supported work budget.');
  }
  *read(offset: number, length: number): ImageParser<Uint8Array> {
    assertImageRange(this.size, offset, length);
    if (length === 0) return new Uint8Array(0);
    if (offset >= this.cacheOffset && offset + length <= this.cacheOffset + this.cache.length) {
      return this.cache.subarray(offset - this.cacheOffset, offset - this.cacheOffset + length);
    }
    const requestLength = Math.min(this.size - offset, Math.max(length, 4096));
    if (++this.requests > MAX_REQUESTS || requestLength > IMAGE_METADATA_MAX_BYTES - this.bytes) this.limit();
    this.bytes += requestLength;
    const bytes = yield { offset, length: requestLength };
    if (bytes.length !== requestLength) malformed('Image range response is truncated.');
    this.cache = bytes;
    this.cacheOffset = offset;
    return bytes.subarray(0, length);
  }
}

export function runBufferedParser<T>(parser: ImageParser<T>, bytes: Uint8Array): T {
  let step = parser.next();
  while (!step.done) {
    assertImageRange(bytes.length, step.value.offset, step.value.length);
    step = parser.next(bytes.subarray(step.value.offset, step.value.offset + step.value.length));
  }
  return step.value;
}
export async function runImageParser<T>(parser: ImageParser<T>, reader: ImageRangeReader): Promise<T> {
  let step = parser.next();
  while (!step.done) step = parser.next(await reader.read(step.value.offset, step.value.length));
  return step.value;
}

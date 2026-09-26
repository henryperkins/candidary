import type { ImageEvidence } from '../../shared/image-formats';
import { assertImageRange, imageAscii, ImageReadCursor, runImageParser, type ImageParser, type ImageRangeReader } from './image-reader-core';
import { inspectBmffStructure } from './image-containers';
import { inspectRaster } from './image-raster';
export type { ImageRangeReader } from './image-reader-core';
export function memoryImageReader(bytes: Uint8Array): ImageRangeReader {
  return { size: bytes.length, read: async (offset, length) => {
    assertImageRange(bytes.length, offset, length);
    return bytes.subarray(offset, offset + length);
  } };
}
export function* inspectImageStructure(cursor: ImageReadCursor): ImageParser<ImageEvidence> {
  const signature = yield* cursor.read(0, Math.min(cursor.size, 12));
  if (imageAscii(signature, 4, 4) === 'ftyp') {
    return yield* inspectBmffStructure(cursor);
  }
  return yield* inspectRaster(cursor);
}
export function inspectImageSource(reader: ImageRangeReader): Promise<ImageEvidence> {
  return runImageParser(inspectImageStructure(new ImageReadCursor(reader.size)), reader);
}

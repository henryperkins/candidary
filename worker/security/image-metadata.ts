import { ImageReadCursor, runBufferedParser } from './image-reader-core';
import { inspectImageStructure } from './image-range-reader';

export interface ImageMetadata {
  /** Recognition does not authorize this type for upload. */
  mimeType: string;
  width: number;
  height: number;
}

/** Buffered compatibility API, using the same bounded parser as R2 sources. */
export function inspectImageHeader(bytes: Uint8Array): ImageMetadata {
  const evidence = runBufferedParser(inspectImageStructure(new ImageReadCursor(bytes.length)), bytes);
  return { mimeType: `image/${evidence.family}`, width: evidence.width, height: evidence.height };
}

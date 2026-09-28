export interface JpegCaptureTime {
  dateTimeOriginal: string;
  offsetTimeOriginal: string | null;
}

const EXIF_SIGNATURE = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const DATE_TIME_ORIGINAL = 0x9003;
const OFFSET_TIME_ORIGINAL = 0x9011;
const EXIF_IFD_POINTER = 0x8769;
const TIFF_TYPE_ASCII = 2;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;
const MAX_ASCII_COUNT = 100;

function readAscii(
  view: DataView,
  offset: number,
  count: number,
): string | null {
  if (offset < 0 || offset + count > view.byteLength || count < 1) return null;
  let text = '';
  for (let index = offset; index < offset + count; index += 1) {
    text += String.fromCharCode(view.getUint8(index));
  }
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code === 0 || code === 32 || code === 9 || code === 13 || code === 10) end -= 1;
    else break;
  }
  return text.slice(0, end);
}

function scanAsciiEntries(
  view: DataView,
  littleEndian: boolean,
  ifdOffset: number,
): {
  dateTimeOriginal: string | null;
  offsetTimeOriginal: string | null;
  exifIfdPointer: number | null;
} {
  const none = {
    dateTimeOriginal: null,
    offsetTimeOriginal: null,
    exifIfdPointer: null,
  };
  if (ifdOffset < 0 || ifdOffset + 2 > view.byteLength) return none;
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  if (ifdOffset + 2 + entryCount * 12 + 4 > view.byteLength) return none;

  let dateTimeOriginal: string | null = null;
  let offsetTimeOriginal: string | null = null;
  let exifIfdPointer: number | null = null;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    const tag = view.getUint16(entry, littleEndian);
    if (tag === EXIF_IFD_POINTER) {
      const type = view.getUint16(entry + 2, littleEndian);
      if (view.getUint32(entry + 4, littleEndian) === 1) {
        if (type === TIFF_TYPE_LONG) exifIfdPointer = view.getUint32(entry + 8, littleEndian);
        else if (type === TIFF_TYPE_SHORT) exifIfdPointer = view.getUint16(entry + 8, littleEndian);
      }
      continue;
    }
    if (tag !== DATE_TIME_ORIGINAL && tag !== OFFSET_TIME_ORIGINAL) continue;
    if (view.getUint16(entry + 2, littleEndian) !== TIFF_TYPE_ASCII) continue;

    const count = view.getUint32(entry + 4, littleEndian);
    if (count < 1 || count > MAX_ASCII_COUNT) continue;
    const value = count <= 4
      ? readAscii(view, entry + 8, count)
      : readAscii(view, view.getUint32(entry + 8, littleEndian), count);
    if (value === null) continue;
    if (tag === DATE_TIME_ORIGINAL) dateTimeOriginal = value;
    else offsetTimeOriginal = value;
  }
  return { dateTimeOriginal, offsetTimeOriginal, exifIfdPointer };
}

function parseTiff(bytes: Uint8Array): JpegCaptureTime | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8) return null;

  let littleEndian: boolean;
  if (bytes[0] === 0x49 && bytes[1] === 0x49) littleEndian = true;
  else if (bytes[0] === 0x4d && bytes[1] === 0x4d) littleEndian = false;
  else return null;
  if (view.getUint16(2, littleEndian) !== 0x002a) return null;

  const ifdOffset = view.getUint32(4, littleEndian);
  const root = scanAsciiEntries(view, littleEndian, ifdOffset);
  // Cameras store the capture tags in the Exif SubIFD referenced by IFD0, not
  // in IFD0 itself. Follow that one-hop pointer and prefer its values while
  // keeping direct IFD0 entries as a fallback for nonstandard writers.
  const sub = root.exifIfdPointer === null
    ? { dateTimeOriginal: null, offsetTimeOriginal: null }
    : scanAsciiEntries(view, littleEndian, root.exifIfdPointer);
  const dateTimeOriginal = sub.dateTimeOriginal ?? root.dateTimeOriginal;
  const offsetTimeOriginal = sub.offsetTimeOriginal ?? root.offsetTimeOriginal;

  if (dateTimeOriginal === null) return null;
  return { dateTimeOriginal, offsetTimeOriginal };
}

/**
 * Best-effort `DateTimeOriginal` / `OffsetTimeOriginal` reader.
 *
 * Skips payloads by their segment lengths and reads bounded APP1 metadata
 * before Start of Scan. An explicit maxBytes retains the caller's window.
 * Malformed JPEG structure, unsupported EXIF, and every
 * bounds-violating TIFF offset return null rather than throwing; a delivery
 * must never fail because its metadata could not be read.
 */
export function inspectJpegCaptureTime(
  bytes: Uint8Array,
  maxBytes?: number,
): JpegCaptureTime | null {
  try {
    const size = maxBytes === undefined ? bytes.length : Math.min(bytes.length, maxBytes);
    return runBufferedParser(inspectCaptureTime(new ImageReadCursor(size)), bytes);
  } catch {
    return null;
  }
}

export async function inspectJpegCaptureTimeSource(source:ImageRangeReader): Promise<JpegCaptureTime|null> {
  try {return await runImageParser(inspectCaptureTime(new ImageReadCursor(source.size)),source);}
  catch {return null;}
}

function* inspectCaptureTime(reader: ImageReadCursor): ImageParser<JpegCaptureTime | null> {
  const header = yield* reader.read(0, 2);
  if (header[0] !== 0xff || header[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < reader.size) {
    reader.structure();
    if ((yield* reader.read(offset++, 1))[0] !== 0xff) return null;
    let marker: number;
    do { reader.structure(); marker = (yield* reader.read(offset++, 1))[0]!; } while (marker === 0xff);
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0 || marker === 0xd8) return null;
    const segmentLength = imageView(yield* reader.read(offset, 2)).getUint16(0);
    if (segmentLength < 2 || segmentLength > reader.size - offset) return null;
    if (marker === 0xe1) {
      if (segmentLength >= 8) {
        const signature = yield* reader.read(offset + 2, 6);
        if (EXIF_SIGNATURE.every((byte, index) => signature[index] === byte)) {
          const parsed = parseTiff(yield* reader.read(offset + 8, segmentLength - 8));
          if (parsed) return parsed;
        }
      }
    }
    offset += segmentLength;
  }

  return null;
}
import { ImageReadCursor, imageView, runBufferedParser, runImageParser, type ImageParser, type ImageRangeReader } from './image-reader-core';

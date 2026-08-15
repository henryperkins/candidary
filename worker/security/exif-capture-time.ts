export interface JpegCaptureTime {
  dateTimeOriginal: string;
  offsetTimeOriginal: string | null;
}

/** No more than the first 1 MiB of an original is ever inspected. */
export const JPEG_EXIF_SCAN_BYTES = 1_048_576;

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
 * Scans bounded APP1 segments before Start of Scan and never reads past
 * `maxBytes`. Malformed JPEG structure, unsupported EXIF, and every
 * bounds-violating TIFF offset return null rather than throwing; a delivery
 * must never fail because its metadata could not be read.
 */
export function inspectJpegCaptureTime(
  bytes: Uint8Array,
  maxBytes = JPEG_EXIF_SCAN_BYTES,
): JpegCaptureTime | null {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const limit = Math.min(bytes.length, maxBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset < limit) {
    if (bytes[offset] !== 0xff) return null;
    let markerOffset = offset + 1;
    while (markerOffset < limit && bytes[markerOffset] === 0xff) markerOffset += 1;
    if (markerOffset >= limit) return null;
    const marker = bytes[markerOffset];
    if (marker === undefined) return null;
    offset = markerOffset + 1;

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > limit) return null;

    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > limit) return null;

    if (marker === 0xe1) {
      const payload = bytes.subarray(offset + 2, offset + segmentLength);
      if (payload.length >= 6 && EXIF_SIGNATURE.every((byte, index) => payload[index] === byte)) {
        const parsed = parseTiff(payload.subarray(6));
        if (parsed) return parsed;
      }
    }
    offset += segmentLength;
  }

  return null;
}

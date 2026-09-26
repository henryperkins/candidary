import type { ImageEvidence, ImageFamily } from '../../shared/image-formats';
import { imageAscii, imageView, ImageInspectionError, ImageReadCursor, malformed, type ImageParser } from './image-reader-core';

export function imageEvidence(family: ImageFamily, width: number, height: number, frameCount = 1, isSequence = false, primaryIndex = 0): ImageEvidence {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) malformed('Image dimensions are invalid.');
  return { family, width, height, frameCount, isSequence, primaryIndex };
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
export function* inspectJpegStructure(reader: ImageReadCursor): ImageParser<ImageEvidence> {
  let offset = 2;
  while (offset < reader.size) {
    reader.structure();
    const start = yield* reader.read(offset++, 1);
    if (start[0] !== 0xff) malformed('JPEG marker is malformed.');
    let marker: number;
    do { reader.structure(); marker = (yield* reader.read(offset++, 1))[0]!; } while (marker === 0xff);
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0 || marker === 0xd8) malformed('JPEG marker is invalid.');
    const length = imageView(yield* reader.read(offset, 2)).getUint16(0);
    if (length < 2 || length > reader.size - offset) malformed('JPEG segment is truncated.');
    if (SOF.has(marker)) {
      if (length < 8) malformed('JPEG dimensions are truncated.');
      const frame = yield* reader.read(offset + 2, 6);
      if (!frame[5] || length !== 8 + 3 * frame[5]) malformed('JPEG frame components are truncated.');
      return imageEvidence('jpeg', imageView(frame).getUint16(3), imageView(frame).getUint16(1));
    }
    offset += length;
  }
  return malformed('JPEG header is truncated or has no dimensions.');
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function* inspectPng(reader: ImageReadCursor): ImageParser<ImageEvidence> {
  const header = yield* reader.read(0, 33);
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
    || imageView(header).getUint32(8) !== 13 || imageAscii(header, 12, 4) !== 'IHDR'
    || crc32(header.subarray(12, 29)) !== imageView(header).getUint32(29)) malformed('PNG IHDR is invalid.');
  const depth = header[24]!;
  const color = header[25]!;
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || header[26] !== 0 || header[27] !== 0 || header[28]! > 1) malformed('PNG IHDR fields are invalid.');
  const dimensions = imageEvidence('png', imageView(header).getUint32(16), imageView(header).getUint32(20));
  if (dimensions.width > 0x7fffffff || dimensions.height > 0x7fffffff) malformed('PNG dimensions are invalid.');
  let offset = 33;
  let frames = 0;
  let declaredFrames = 0;
  let nextSequence = 0;
  let hasData = false;
  while (offset < reader.size) {
    reader.structure();
    const chunk = yield* reader.read(offset, 8);
    const length = imageView(chunk).getUint32(0);
    const type = imageAscii(chunk, 4, 4);
    if (length > 0x7fffffff || length + 12 > reader.size - offset) malformed('PNG chunk is truncated.');
    if (type === 'IHDR') malformed('PNG contains multiple IHDR chunks.');
    if (type === 'acTL') {
      if (hasData || declaredFrames || length !== 8) malformed('PNG animation control is invalid.');
      declaredFrames = imageView(yield* reader.read(offset + 8, 8)).getUint32(0);
      if (!declaredFrames) malformed('PNG animation has no frames.');
    } else if (type === 'fcTL') {
      if (!declaredFrames || length !== 26) malformed('PNG frame control is invalid.');
      const frame = imageView(yield* reader.read(offset + 8, 26));
      if (frame.getUint32(0) !== nextSequence++) malformed('PNG animation sequence is invalid.');
      const width = frame.getUint32(4), height = frame.getUint32(8);
      if (!width || !height || width + frame.getUint32(12) > dimensions.width || height + frame.getUint32(16) > dimensions.height) malformed('PNG frame dimensions are invalid.');
      frames++;
    } else if (type === 'fdAT') {
      if (!declaredFrames || !frames || length < 4 || imageView(yield* reader.read(offset + 8, 4)).getUint32(0) !== nextSequence++) malformed('PNG animation data is invalid.');
    } else if (type === 'IDAT') hasData = true;
    else if (type === 'IEND') {
      if (length !== 0 || !hasData || (declaredFrames && frames !== declaredFrames)) malformed('PNG end or frame count is invalid.');
      return { ...dimensions, frameCount: declaredFrames || 1, isSequence: declaredFrames > 0 };
    }
    offset += length + 12;
  }
  return malformed('PNG image is truncated before IEND.');
}

const uint24 = (bytes: Uint8Array, offset: number) => bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
function* inspectWebp(reader: ImageReadCursor, header: Uint8Array): ImageParser<ImageEvidence> {
  const end = imageView(header).getUint32(4, true) + 8;
  if (end < 20 || end > reader.size || end % 2 !== 0) malformed('WebP RIFF size is invalid.');
  let offset = 12;
  let canvas: ImageEvidence | null = null;
  let still: ImageEvidence | null = null;
  let animated = false;
  let animationControl = false;
  let frames = 0;
  while (offset < end) {
    reader.structure();
    if (end - offset < 8) malformed('WebP chunk is truncated.');
    const chunk = yield* reader.read(offset, 8);
    const type = imageAscii(chunk, 0, 4);
    const length = imageView(chunk).getUint32(4, true);
    if (length + 8 + (length % 2) > end - offset) malformed('WebP chunk exceeds RIFF size.');
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10) malformed('WebP extended header is invalid.');
      const data = yield* reader.read(offset + 8, 10);
      canvas = imageEvidence('webp', uint24(data, 4) + 1, uint24(data, 7) + 1);
      animated = (data[0]! & 2) !== 0;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (still || animated || length < (type === 'VP8 ' ? 10 : 5)) malformed('WebP bitstream header is invalid.');
      const data = yield* reader.read(offset + 8, type === 'VP8 ' ? 10 : 5);
      if (type === 'VP8 ') {
        if (data[3] !== 0x9d || data[4] !== 1 || data[5] !== 0x2a || (data[0]! & 1)) malformed('WebP key frame header is invalid.');
        still = imageEvidence('webp', imageView(data).getUint16(6, true) & 0x3fff, imageView(data).getUint16(8, true) & 0x3fff);
      } else {
        if (data[0] !== 0x2f || data[4]! >> 5 !== 0) malformed('WebP lossless header is invalid.');
        const bits = imageView(data).getUint32(1, true);
        still = imageEvidence('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
    } else if (type === 'ANIM') {
      if (!animated || animationControl || frames || length !== 6) malformed('WebP animation control is invalid.');
      animationControl = true;
    } else if (type === 'ANMF') {
      if (!animated || !canvas || !animationControl || length < 16) malformed('WebP animation frame is invalid.');
      const data = yield* reader.read(offset + 8, 16);
      if (uint24(data, 0) * 2 + uint24(data, 6) + 1 > canvas.width
        || uint24(data, 3) * 2 + uint24(data, 9) + 1 > canvas.height) malformed('WebP frame exceeds its canvas.');
      frames++;
    }
    offset += 8 + length + length % 2;
  }
  if (animated && canvas && frames) return { ...canvas, frameCount: frames, isSequence: true };
  if (!still || (canvas && (canvas.width !== still.width || canvas.height !== still.height))) malformed('WebP dimensions or frame data are missing.');
  return canvas ?? still;
}

export function* inspectRaster(reader: ImageReadCursor): ImageParser<ImageEvidence> {
  const header = yield* reader.read(0, Math.min(12, reader.size));
  if (header[0] === 0xff && header[1] === 0xd8) return yield* inspectJpegStructure(reader);
  if (header[0] === 137 && imageAscii(header, 1, 3) === 'PNG') return yield* inspectPng(reader);
  if (imageAscii(header, 0, 4) === 'RIFF' && imageAscii(header, 8, 4) === 'WEBP') return yield* inspectWebp(reader, header);
  if (reader.size < 4) malformed('Image header is truncated.');
  throw new ImageInspectionError('IMAGE_TYPE_UNSUPPORTED', 'Image type is unsupported.');
}

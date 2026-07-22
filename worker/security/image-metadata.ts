import type { SupportedImageType } from '../../shared/constants';

export interface ImageMetadata {
  mimeType: SupportedImageType;
  width: number;
  height: number;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function assertDimensions(width: number, height: number, mimeType: SupportedImageType): ImageMetadata {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Image dimensions are invalid.');
  }
  return { mimeType, width, height };
}

function inspectJpeg(bytes: Uint8Array): ImageMetadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    if (marker === undefined) break;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    const segmentLength = view.getUint16(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
    if (startOfFrameMarkers.has(marker)) {
      return assertDimensions(view.getUint16(offset + 7), view.getUint16(offset + 5), 'image/jpeg');
    }
    offset += 2 + segmentLength;
  }

  throw new Error('JPEG header is truncated or has no dimensions.');
}

function inspectWebp(bytes: Uint8Array): ImageMetadata {
  if (bytes.length < 30) throw new Error('WebP header is truncated.');
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    return assertDimensions(width, height, 'image/webp');
  }

  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const width = ((bytes[27] ?? 0) << 8 | (bytes[26] ?? 0)) & 0x3fff;
    const height = ((bytes[29] ?? 0) << 8 | (bytes[28] ?? 0)) & 0x3fff;
    return assertDimensions(width, height, 'image/webp');
  }

  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
    return assertDimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, 'image/webp');
  }

  throw new Error('WebP header is unsupported or truncated.');
}

export function inspectImageHeader(bytes: Uint8Array): ImageMetadata {
  if (bytes.length < 4) throw new Error('Image header is truncated.');

  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
    if (bytes.length < 24) throw new Error('PNG header is truncated.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return assertDimensions(view.getUint32(16), view.getUint32(20), 'image/png');
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return inspectWebp(bytes);

  throw new Error('Image type is unsupported.');
}


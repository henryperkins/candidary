import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

import type { EventCoverEffectId } from '../../../shared/event-cover';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function solidPng(red: number, green: number, blue: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rasterPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const offset = row + 1 + x * 3;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const PURE_WHITE_COVER = solidPng(255, 255, 255);
export const PURE_BLACK_COVER = solidPng(0, 0, 0);
export const PHOTOGRAPHIC_COVER = readFileSync('public/assets/candidary-hero.png');

/** Dark left edge and warm subject near the right third: deterministic crop evidence. */
export const PORTRAIT_EDGE_DARK_COVER = rasterPng(480, 720, (x, y) => {
  const horizontal = x / 479;
  const vertical = y / 719;
  const subject = Math.max(0, 1 - Math.hypot(horizontal - 0.74, vertical - 0.43) * 3.2);
  return [
    Math.round(18 + horizontal * 48 + subject * 150),
    Math.round(22 + vertical * 44 + subject * 92),
    Math.round(30 + horizontal * 34 + subject * 40),
  ] as const;
});

/** Pale centered subject with darker corners: the opposite directional fixture. */
export const LANDSCAPE_CENTERED_LIGHT_COVER = rasterPng(960, 540, (x, y) => {
  const horizontal = x / 959;
  const vertical = y / 539;
  const center = Math.max(0, 1 - Math.hypot(horizontal - 0.5, vertical - 0.5) * 1.8);
  return [
    Math.round(118 + center * 124),
    Math.round(132 + center * 112),
    Math.round(142 + center * 105),
  ] as const;
});

function effectSourcePixel(x: number, y: number): readonly [number, number, number] {
  const horizontal = x / 959;
  const vertical = y / 539;
  const subject = Math.max(0, 1 - Math.hypot(horizontal - 0.58, vertical - 0.46) * 2.4);
  return [
    Math.round(38 + horizontal * 100 + subject * 96),
    Math.round(66 + vertical * 88 + subject * 72),
    Math.round(112 + (1 - horizontal) * 72 + subject * 48),
  ];
}

function effectPixel(
  effect: EventCoverEffectId,
  x: number,
  y: number,
): readonly [number, number, number] {
  const [red, green, blue] = effectSourcePixel(x, y);
  if (effect === 'warm') {
    return [Math.min(255, red + 42), Math.min(255, green + 18), Math.max(0, blue - 34)];
  }
  if (effect === 'soft') {
    return [
      Math.round(red * 0.68 + 255 * 0.32),
      Math.round(green * 0.68 + 248 * 0.32),
      Math.round(blue * 0.68 + 242 * 0.32),
    ];
  }
  if (effect === 'monochrome') {
    const value = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    return [value, value, value];
  }
  return [red, green, blue];
}

/** Deterministic, already-composited slot bytes for browser-only effect evidence. */
export const UPLOAD_EFFECT_COVERS: Record<EventCoverEffectId, Buffer> = {
  natural: rasterPng(960, 540, (x, y) => effectPixel('natural', x, y)),
  warm: rasterPng(960, 540, (x, y) => effectPixel('warm', x, y)),
  soft: rasterPng(960, 540, (x, y) => effectPixel('soft', x, y)),
  monochrome: rasterPng(960, 540, (x, y) => effectPixel('monochrome', x, y)),
  film: rasterPng(960, 540, (x, y) => effectPixel('natural', x, y)),
};

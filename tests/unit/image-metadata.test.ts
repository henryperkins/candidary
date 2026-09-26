import { describe, expect, it } from 'vitest';

import { inspectImageHeader } from '../../worker/security/image-metadata';
import { structuralPng, structuralWebp } from '../fixtures/raster-builders';
import { primaryHeif } from '../fixtures/image-container-builders';

function png(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number) {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function webp(width: number, height: number) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  bytes.set([
    widthMinusOne & 0xff,
    (widthMinusOne >> 8) & 0xff,
    (widthMinusOne >> 16) & 0xff,
  ], 24);
  bytes.set([
    heightMinusOne & 0xff,
    (heightMinusOne >> 8) & 0xff,
    (heightMinusOne >> 16) & 0xff,
  ], 27);
  return bytes;
}

function isoBmff(brand: 'heic' | 'mif1', width: number, height: number) {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  const encoder = new TextEncoder();

  view.setUint32(0, 20);
  bytes.set(encoder.encode('ftyp'), 4);
  bytes.set(encoder.encode(brand), 8);
  view.setUint32(12, 0);
  bytes.set(encoder.encode(brand), 16);

  view.setUint32(20, 20);
  bytes.set(encoder.encode('ispe'), 24);
  view.setUint32(28, 0);
  view.setUint32(32, width);
  view.setUint32(36, height);
  return bytes;
}

describe('image header inspection', () => {
  it.each([
    [structuralPng(1600, 900), 'image/png', 1600, 900],
    [jpeg(1200, 800), 'image/jpeg', 1200, 800],
    [structuralWebp(1080, 1350), 'image/webp', 1080, 1350],
    [primaryHeif({ primaryId: 1, items: [{ id: 1, width: 4032, height: 3024 }] }), 'image/heic', 4032, 3024],
    [primaryHeif({ primaryId: 1, items: [{ id: 1, width: 3024, height: 4032 }], genericBrand: true }), 'image/heic', 3024, 4032],
  ] as const)('recognizes supported signatures and dimensions', (bytes, mimeType, width, height) => {
    expect(inspectImageHeader(bytes)).toEqual({ mimeType, width, height });
  });

  it('rejects unsupported and truncated data', () => {
    expect(() => inspectImageHeader(new TextEncoder().encode('GIF89a'))).toThrow('unsupported');
    expect(() => inspectImageHeader(new Uint8Array([0x89, 0x50, 0x4e]))).toThrow('truncated');
    expect(() => inspectImageHeader(primaryHeif({ primaryId: 1, items: [{ id: 1, width: 0, height: 0 }] }))).toThrow('dimensions');
  });

  it('rejects PNG dimensions carried in a wrong or truncated IHDR chunk', () => {
    const bad = png(10, 8);
    expect(() => inspectImageHeader(bad)).toThrow();
    const wrong = new Uint8Array(33);
    wrong.set(bad);
    new DataView(wrong.buffer).setUint32(8, 13);
    wrong.set(new TextEncoder().encode('tEXt'), 12);
    expect(() => inspectImageHeader(wrong)).toThrow();
  });

  it('rejects WebP chunks that claim bytes outside the file', () => {
    const bad = webp(10, 8);
    new DataView(bad.buffer).setUint32(4, 22, true);
    new DataView(bad.buffer).setUint32(16, 999, true);
    expect(() => inspectImageHeader(bad)).toThrow();
  });
});

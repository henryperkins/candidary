import { describe, expect, it } from 'vitest';
import { inspectImageSource, memoryImageReader } from '../../worker/security/image-range-reader';

function lateJpeg(segments = 2): Uint8Array {
  const bytes = new Uint8Array(2 + segments * 60_004 + 15);
  bytes.set([0xff, 0xd8]);
  for (let i = 0; i < segments; i++) bytes.set([0xff, 0xe2, 0xea, 0x62], 2 + i * 60_004);
  bytes.set([0xff, 0xc0, 0, 11, 8, 0, 8, 0, 10, 1, 1, 0x11, 0, 0xff, 0xd9], 2 + segments * 60_004);
  return bytes;
}

describe('bounded image sources', () => {
  it('finds JPEG dimensions beyond 64 KiB without reading large APP payloads', async () => {
    const bytes = lateJpeg();
    let readBytes = 0;
    let requests = 0;
    const source = memoryImageReader(bytes);
    const metadata = await inspectImageSource({ size: bytes.length, read: async (offset, length) => {
      readBytes += length; requests += 1;
      return source.read(offset, length);
    } });
    expect(metadata).toMatchObject({ family: 'jpeg', width: 10, height: 8, frameCount: 1, isSequence: false });
    expect(readBytes).toBeLessThan(16_384);
    expect(requests).toBeLessThan(8);
  });

  it('refuses requests outside the source and safe integer range', async () => {
    const reader = memoryImageReader(new Uint8Array([1, 2, 3]));
    expect([...await reader.read(1, 2)]).toEqual([2, 3]);
    for (const [offset, length] of [[-1, 1], [1, 3], [1.5, 1], [0, -1], [Number.MAX_SAFE_INTEGER, 2]]) {
      await expect(reader.read(offset!, length!)).rejects.toThrow(/range|bounds/i);
    }
  });

  it('distinguishes work-budget refusal from malformed JPEG bytes', async () => {
    await expect(inspectImageSource(memoryImageReader(lateJpeg(260)))).rejects.toMatchObject({ code: 'IMAGE_METADATA_LIMIT' });
    const bytes = lateJpeg();
    bytes[4] = 0xff; bytes[5] = 0xff;
    await expect(inspectImageSource(memoryImageReader(bytes))).rejects.toMatchObject({ code: 'IMAGE_MALFORMED' });
  });

  it('does not accept a truncated range response', async () => {
    await expect(inspectImageSource({ size: 100, read: async () => Uint8Array.of(0xff, 0xd8) }))
      .rejects.toMatchObject({ code: 'IMAGE_MALFORMED' });
  });

  it('bounds JPEG marker work even when reads stay in a small cache', async () => {
    const bytes = new Uint8Array(34_002);
    bytes.set([0xff, 0xd8]);
    for (let offset = 2; offset < bytes.length; offset += 2) bytes.set([0xff, 0x01], offset);
    await expect(inspectImageSource(memoryImageReader(bytes))).rejects.toMatchObject({ code: 'IMAGE_METADATA_LIMIT' });
  });
});

import { describe, expect, it } from 'vitest';
import { inspectBmff } from '../../worker/security/image-containers';
import { inspectImageSource, memoryImageReader } from '../../worker/security/image-range-reader';
import { imageDeclarationMatches } from '../../shared/image-formats';
import { box, concat, primaryHeif, u32 } from '../fixtures/image-container-builders';

const items = [{ id: 1, width: 640, height: 480 }, { id: 2, width: 4032, height: 3024 }];

describe('HEIF primary images and sequences', () => {
  it('does not mistake compatible hevc branding on a still collection for timed samples', async () => {
    const bytes = primaryHeif({ primaryId: 2, items });
    bytes.set(new TextEncoder().encode('hevc'), 20);
    expect(await inspectBmff(memoryImageReader(bytes))).toMatchObject({ family: 'heic', width: 4032, height: 3024, isSequence: false });
  });

  it('uses the primary item property association rather than the first thumbnail ispe', async () => {
    const evidence = await inspectBmff(memoryImageReader(primaryHeif({ primaryId: 2, items })));
    expect(evidence).toMatchObject({ family: 'heic', width: 4032, height: 3024, frameCount: 1, isSequence: false });
  });

  it('finds late metadata while skipping a large mdat body', async () => {
    const bytes = primaryHeif({ primaryId: 2, items, lateBytes: 200_000 });
    let readBytes = 0;
    const evidence = await inspectImageSource({ size: bytes.length, read: async (offset, length) => {
      readBytes += length; return bytes.subarray(offset, offset + length);
    } });
    expect(evidence).toMatchObject({ width: 4032, height: 3024 });
    expect(readBytes).toBeLessThan(16_384);
  });

  it('HEIF rejects an AVIF primary with mif1 compatibility', async () => {
    const avif = await inspectBmff(memoryImageReader(primaryHeif({ primaryId: 2, items, family: 'avif' })));
    expect(avif.family).toBe('avif');
    expect(imageDeclarationMatches({ family: 'heif', mimeType: 'image/heif', requiresSequence: false }, avif)).toBe(false);
    const hevc = await inspectBmff(memoryImageReader(primaryHeif({ primaryId: 2, items, genericBrand: true })));
    expect(imageDeclarationMatches({ family: 'heif', mimeType: 'image/heif', requiresSequence: false }, hevc)).toBe(true);
  });

  it('validates a grid descriptor against the primary ispe and referenced tiles', async () => {
    const gridItems = [1, 2, 3, 4].map((id) => ({ id, width: 640, height: 480 }));
    gridItems.push({ id: 5, width: 1000, height: 700 });
    expect(await inspectBmff(memoryImageReader(primaryHeif({ primaryId: 5, items: gridItems, grid: { width: 1000, height: 700 } }))))
      .toMatchObject({ width: 1000, height: 700, frameCount: 1, isSequence: false });
    await expect(inspectBmff(memoryImageReader(primaryHeif({ primaryId: 5, items: gridItems, grid: { width: 999, height: 700 } }))))
      .rejects.toThrow(/grid|dimensions/i);
  });

  it('requires timed sample evidence instead of treating a collection as an animation', async () => {
    const evidence = await inspectBmff(memoryImageReader(primaryHeif({ primaryId: 2, items, sequence: true })));
    expect(evidence).toMatchObject({ family: 'heic', width: 4032, height: 3024, frameCount: 3, isSequence: true });
    const still = await inspectBmff(memoryImageReader(primaryHeif({ primaryId: 2, items })));
    expect(imageDeclarationMatches({ family: 'heic', mimeType: 'image/heic-sequence', requiresSequence: true }, still)).toBe(false);
  });

  it('rejects overflowing boxes, excessive nesting and absent primary associations', async () => {
    const huge = concat(u32(1), new TextEncoder().encode('ftyp'), new Uint8Array(8).fill(255));
    await expect(inspectBmff(memoryImageReader(huge))).rejects.toThrow();
    let nested = box('free', new Uint8Array());
    for (let i = 0; i < 35; i++) nested = box('moov', nested);
    const valid = primaryHeif({ primaryId: 2, items });
    await expect(inspectBmff(memoryImageReader(concat(valid, nested)))).rejects.toThrow(/depth|budget/i);
    await expect(inspectBmff(memoryImageReader(primaryHeif({ primaryId: 99, items })))).rejects.toThrow(/primary/i);
  });

  it('rejects contradictory codec-specific brands', async () => {
    const bytes = primaryHeif({ primaryId: 2, items, family: 'avif' });
    bytes.set(new TextEncoder().encode('heic'), 8);
    await expect(inspectBmff(memoryImageReader(bytes))).rejects.toThrow(/brand|codec/i);
  });
});

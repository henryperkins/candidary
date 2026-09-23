import { describe, expect, it } from 'vitest';
import * as printPack from '../../src/features/print/print-pack';

describe('event print layouts', () => {
  it('fits two 4 by 6 cards on A4 and rounds an odd count up to a complete sheet', () => {
    expect(printPack.getPrintLayout).toBeTypeOf('function');
    const layout = printPack.getPrintLayout({ kind: 'cards', style: '4x6', paper: 'a4', count: 7 });
    expect(layout.sheetCount).toBe(4);
    expect(layout.itemCount).toBe(8);
    expect(layout.pageWidth).toBeCloseTo(595.2756, 3);
    expect(layout.pageHeight).toBeCloseTo(841.8898, 3);
    expect(layout.pieces).toHaveLength(2);
    for (const piece of layout.pieces) {
      expect(piece.width).toBe(432);
      expect(piece.height).toBe(288);
      expect(piece.x).toBeGreaterThan(18);
      expect(piece.y).toBeGreaterThan(18);
      expect(piece.x + piece.width).toBeLessThan(layout.pageWidth - 18);
      expect(piece.y + piece.height).toBeLessThan(layout.pageHeight - 18);
    }
  });

  it('keeps Avery stock on Letter paper with the actual label positions and no cut marks', () => {
    expect(printPack.getPrintLayout).toBeTypeOf('function');
    const wide = printPack.getPrintLayout({ kind: 'stickers', layout: '5163', sheets: 3 });
    expect(wide).toMatchObject({ pageWidth: 612, pageHeight: 792, sheetCount: 3, itemCount: 30, cutMarks: false });
    expect(wide.pieces).toHaveLength(10);
    expect(wide.pieces[0]).toMatchObject({ x: 11.25, y: 36, width: 288, height: 144 });
    expect(wide.pieces[9]).toMatchObject({ x: 312.75, y: 612, width: 288, height: 144 });
    const square = printPack.getPrintLayout({ kind: 'stickers', layout: '22806', sheets: 2 });
    expect(square.itemCount).toBe(24);
    expect(square.pieces).toHaveLength(12);
    expect(square.pieces[0]).toMatchObject({ x: 45, y: 45, width: 144, height: 144 });
    expect(square.pieces[11]).toMatchObject({ x: 423, y: 603, width: 144, height: 144 });
  });

  it('caps malformed quantities and gives the poster its own physical page size', () => {
    expect(printPack.getPrintLayout).toBeTypeOf('function');
    expect(printPack.getPrintLayout({ kind: 'cards', style: 'tent', paper: 'letter', count: 1000 }).sheetCount).toBe(40);
    expect(printPack.getPrintLayout({ kind: 'stickers', layout: '5163', sheets: -5 }).sheetCount).toBe(1);
    expect(printPack.getPrintLayout({ kind: 'stickers', layout: '22806', sheets: Infinity }).sheetCount).toBe(3);
    expect(printPack.getPrintLayout({ kind: 'sign', size: 'poster' })).toMatchObject({ pageWidth: 1296, pageHeight: 1728, sheetCount: 1, itemCount: 1 });
  });
});

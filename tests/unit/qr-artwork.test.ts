import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { QR_MARGIN, qrModulePath } from '../../src/features/print/qr-artwork';

const LINK = 'https://candidary.app/join#Ab3dEf6hIj9kLm2nOp5qRs.Tu8vWx1yZa4bCd7eFg0hIj3kLm6nOp9qRs2tUv5wXy8';

/** Nonzero-winding fill test for the rectilinear SVG subset a module path may use. */
function fills(path: string, x: number, y: number): boolean {
  const polygons: [number, number][][] = [];
  let point: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  let polygon: [number, number][] = [];
  for (const [, command, rawArgs] of path.matchAll(/([MmHhVvLlZz])([^MmHhVvLlZz]*)/gu)) {
    const args = (rawArgs!.match(/-?\d*\.?\d+(?:e-?\d+)?/giu) ?? []).map(Number);
    if (command === 'M' || command === 'm') {
      if (polygon.length) polygons.push(polygon);
      point = command === 'M' ? [args[0]!, args[1]!] : [point[0] + args[0]!, point[1] + args[1]!];
      start = point;
      polygon = [point];
      continue;
    }
    if (command === 'Z' || command === 'z') {
      if (polygon.length) polygons.push(polygon);
      polygon = [];
      point = start;
      continue;
    }
    if (!polygon.length) polygon = [point];
    for (let index = 0; index < args.length; index++) {
      if (command === 'H') point = [args[index]!, point[1]];
      if (command === 'h') point = [point[0] + args[index]!, point[1]];
      if (command === 'V') point = [point[0], args[index]!];
      if (command === 'v') point = [point[0], point[1] + args[index]!];
      if (command === 'L') point = [args[index]!, args[++index]!];
      if (command === 'l') point = [point[0] + args[index]!, point[1] + args[++index]!];
      polygon.push(point);
    }
  }
  if (polygon.length) polygons.push(polygon);
  let winding = 0;
  for (const vertices of polygons) {
    for (let index = 0; index < vertices.length; index++) {
      const [x1, y1] = vertices[index]!;
      const [x2, y2] = vertices[(index + 1) % vertices.length]!;
      const cross = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
      if (y1 <= y && y2 > y && cross > 0) winding++;
      if (y1 > y && y2 <= y && cross < 0) winding--;
    }
  }
  return winding !== 0;
}

describe('printed QR module path', () => {
  it('fills exactly the dark modules of the guest link and keeps the quiet zone clear', () => {
    const { modules } = QRCode.create(LINK, { errorCorrectionLevel: 'M' });
    const { size, path } = qrModulePath(LINK);
    expect(size).toBe(modules.size + 2 * QR_MARGIN);
    const mismatches: string[] = [];
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const inside = row >= QR_MARGIN && column >= QR_MARGIN && row < size - QR_MARGIN && column < size - QR_MARGIN;
        const dark = inside && modules.get(row - QR_MARGIN, column - QR_MARGIN) === 1;
        if (fills(path, column + .5, row + .5) !== dark) mismatches.push(row + ',' + column);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps every module edge on the whole-module grid', () => {
    const { path } = qrModulePath(LINK);
    const coordinates = path.match(/-?\d*\.?\d+(?:e-?\d+)?/giu) ?? [];
    expect(coordinates.length).toBeGreaterThan(0);
    expect(coordinates.filter((value) => !Number.isInteger(Number(value)))).toEqual([]);
  });
});

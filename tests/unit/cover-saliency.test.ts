import { describe, expect, it } from 'vitest';

import {
  CENTER_FOCUS,
  resolveSaliencyFocus,
  type SaliencySample,
} from '../../src/features/cover/saliency';

/**
 * Pixel logic behind a pure array-in/coordinates-out boundary.
 *
 * jsdom has no canvas, `OffscreenCanvas`, `ImageBitmap`, or `Worker`, and
 * `src/test/setup.ts` is one line, so this is the only place the composition
 * model can be tested at all. The Web Worker wrapper is decode-and-delegate.
 */

function sample(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): SaliencySample {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

/** A flat field with one high-contrast block, centered on the given point. */
function subjectAt(fx: number, fy: number, size = 24): SaliencySample {
  const width = 160;
  const height = 120;
  const cx = Math.round(fx * width);
  const cy = Math.round(fy * height);
  return sample(width, height, (x, y) => {
    const inside = Math.abs(x - cx) < size / 2 && Math.abs(y - cy) < size / 2;
    // A checker inside the block, so the block carries local contrast rather
    // than only differing from the background in average brightness.
    if (!inside) return [128, 128, 128];
    return (x + y) % 2 === 0 ? [255, 255, 255] : [8, 8, 8];
  });
}

describe('cover saliency', () => {
  it('finds a centered subject at the center', () => {
    const focus = resolveSaliencyFocus(subjectAt(0.5, 0.5));
    expect(focus.x).toBeCloseTo(0.5, 1);
    expect(focus.y).toBeCloseTo(0.5, 1);
    expect(focus.confident).toBe(true);
  });

  it('follows an edge subject rather than defaulting to the middle', () => {
    const left = resolveSaliencyFocus(subjectAt(0.2, 0.5));
    expect(left.x).toBeLessThan(0.4);
    expect(left.confident).toBe(true);

    const lowRight = resolveSaliencyFocus(subjectAt(0.8, 0.75));
    expect(lowRight.x).toBeGreaterThan(0.6);
    expect(lowRight.y).toBeGreaterThan(0.6);
  });

  it('returns coordinates inside the normalized range for every corner', () => {
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0]] as const) {
      const focus = resolveSaliencyFocus(subjectAt(x, y));
      expect(focus.x).toBeGreaterThanOrEqual(0);
      expect(focus.x).toBeLessThanOrEqual(1);
      expect(focus.y).toBeGreaterThanOrEqual(0);
      expect(focus.y).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to center below the confidence floor', () => {
    // A flat wall has nothing to prefer, and inventing a point would be worse
    // than the honest middle: the manual correction path stays available either
    // way, and every profile crops around the same coordinates.
    const flat = sample(160, 120, () => [200, 200, 200]);
    const focus = resolveSaliencyFocus(flat);
    expect(focus).toEqual({ ...CENTER_FOCUS });
    expect(focus.confident).toBe(false);
  });

  it('falls back to center for a uniform gradient with no subject', () => {
    const gradient = sample(160, 120, (x) => {
      const value = Math.round((x / 160) * 255);
      return [value, value, value];
    });
    expect(resolveSaliencyFocus(gradient).confident).toBe(false);
  });

  it('is deterministic and refuses an empty sample', () => {
    const subject = subjectAt(0.3, 0.7);
    expect(resolveSaliencyFocus(subject)).toEqual(resolveSaliencyFocus(subject));
    expect(resolveSaliencyFocus({ width: 0, height: 0, data: new Uint8ClampedArray() }).confident)
      .toBe(false);
  });
});

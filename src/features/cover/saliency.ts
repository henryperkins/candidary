/**
 * The composition model, as a pure function over pixels.
 *
 * Deliberately array-in/coordinates-out. The decode — `createImageBitmap`, an
 * `OffscreenCanvas`, `getImageData` — belongs to the Web Worker wrapper beside
 * this file, none of which exists in jsdom; keeping the algorithm on this side
 * of the boundary is what lets `test:unit` cover it at all.
 *
 * No third-party service sees the host's photo. This runs off the main thread,
 * on the natural preview the Worker already returned, and its result is
 * persisted through the guarded composition route rather than trusted as
 * geometry.
 *
 * Deliberately free of `shared/event-cover`: the pinned composition-model
 * version is a server value the draft view already carries, and importing the
 * constant for it pulled Zod into this Web Worker's bundle for nothing.
 */

export interface SaliencySample {
  width: number;
  height: number;
  /** RGBA, four bytes per pixel, as `ImageData.data` provides it. */
  data: Uint8ClampedArray;
}

export interface SaliencyFocus {
  x: number;
  y: number;
  confident: boolean;
}

export const CENTER_FOCUS = { x: 0.5, y: 0.5, confident: false } as const;

// A coarse grid: the subject's location matters, the exact pixel does not, and
// a small grid keeps one preview's analysis far inside a frame budget.
const GRID = 16;
// Below this, the frame has no subject to prefer — a flat wall, a sky, an even
// gradient — and the honest middle beats an invented point.
const CONFIDENCE_FLOOR = 1.6;

function luminance(data: Uint8ClampedArray, offset: number): number {
  return 0.2126 * (data[offset] ?? 0)
    + 0.7152 * (data[offset + 1] ?? 0)
    + 0.0722 * (data[offset + 2] ?? 0);
}

export function resolveSaliencyFocus(sample: SaliencySample): SaliencyFocus {
  const { width, height, data } = sample;
  if (width < GRID || height < GRID || data.length < width * height * 4) {
    return { ...CENTER_FOCUS };
  }

  // Local contrast per cell, as the mean absolute deviation of luminance. Edge
  // energy rather than brightness: a bright sky is not a subject, and a dark
  // suit against a pale wall is.
  const cells = new Float64Array(GRID * GRID);
  const cellWidth = width / GRID;
  const cellHeight = height / GRID;

  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      const x0 = Math.floor(column * cellWidth);
      const x1 = Math.max(x0 + 1, Math.floor((column + 1) * cellWidth));
      const y0 = Math.floor(row * cellHeight);
      const y1 = Math.max(y0 + 1, Math.floor((row + 1) * cellHeight));

      let total = 0;
      let count = 0;
      for (let y = y0; y < y1 && y < height; y += 1) {
        for (let x = x0; x < x1 && x < width; x += 1) {
          total += luminance(data, (y * width + x) * 4);
          count += 1;
        }
      }
      if (count === 0) continue;
      const mean = total / count;

      let deviation = 0;
      for (let y = y0; y < y1 && y < height; y += 1) {
        for (let x = x0; x < x1 && x < width; x += 1) {
          deviation += Math.abs(luminance(data, (y * width + x) * 4) - mean);
        }
      }
      cells[row * GRID + column] = deviation / count;
    }
  }

  let energy = 0;
  let peak = 0;
  for (const cell of cells) {
    energy += cell;
    if (cell > peak) peak = cell;
  }
  if (energy <= 0) return { ...CENTER_FOCUS };

  const average = energy / cells.length;
  // How far the busiest cell stands above the frame's own average. A flat or
  // evenly graded frame sits near 1; a subject against quiet ground sits well
  // above it, whatever the absolute contrast of the photo.
  if (peak / average < CONFIDENCE_FLOOR) return { ...CENTER_FOCUS };

  let weightedX = 0;
  let weightedY = 0;
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      const weight = cells[row * GRID + column] ?? 0;
      // Cell centers, so a subject in the first column resolves inside the
      // frame rather than exactly on its edge.
      weightedX += weight * ((column + 0.5) / GRID);
      weightedY += weight * ((row + 0.5) / GRID);
    }
  }

  return {
    x: clamp(weightedX / energy),
    y: clamp(weightedY / energy),
    confident: true,
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

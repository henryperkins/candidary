import { resolveSaliencyFocus, type SaliencyFocus } from './saliency';

/**
 * Decode-and-delegate, off the main thread.
 *
 * The algorithm itself is in `saliency.ts` behind a pure boundary; everything
 * here is the part jsdom cannot run — `createImageBitmap`, an `OffscreenCanvas`,
 * and `getImageData`. Keeping the split at exactly this line is what makes the
 * composition model testable in `test:unit` without a canvas.
 *
 * The bytes are the authorized natural preview the Worker already produced.
 * They leave this browser for nowhere.
 */

export interface CoverCompositionRequest {
  previewBytes: ArrayBuffer;
}

export type CoverCompositionResponse =
  | { ok: true; focus: SaliencyFocus }
  | { ok: false };

// Analysis resolution, not preview resolution: a coarse grid decides the point,
// so decoding at full preview size would cost frames for no accuracy.
const ANALYSIS_LONG_EDGE = 320;

// Typed structurally rather than as `DedicatedWorkerGlobalScope`: the app
// project's `lib` is DOM, not WebWorker, and widening it for one file would
// hand every component `postMessage` on the global.
interface WorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<CoverCompositionRequest>) => void): void;
  postMessage(message: CoverCompositionResponse): void;
}

const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (event: MessageEvent<CoverCompositionRequest>) => {
  void analyze(event.data.previewBytes)
    .then((focus) => {
      scope.postMessage(focus ? { ok: true, focus } : { ok: false } satisfies CoverCompositionResponse);
    })
    .catch(() => {
      // A decode failure is not a cover failure: the caller falls back to center
      // focus and the manual correction path stays exactly as available.
      scope.postMessage({ ok: false } satisfies CoverCompositionResponse);
    });
});

async function analyze(previewBytes: ArrayBuffer): Promise<SaliencyFocus | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;

  const bitmap = await createImageBitmap(new Blob([previewBytes]));
  try {
    const scale = Math.min(1, ANALYSIS_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return resolveSaliencyFocus({ width, height, data: image.data });
  } finally {
    bitmap.close();
  }
}

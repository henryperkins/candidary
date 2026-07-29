import type { Page } from '@playwright/test';

interface SettleRenderingOptions {
  parkPointer?: boolean;
}

// A face can be requested only after a glyph lays out, starting a fresh loading cycle after an
// earlier `document.fonts.ready` has resolved. Require the set to be loaded after two animation
// frames, so screenshots and console audits include late font work rather than racing it.
export async function settleRendering(
  page: Page,
  { parkPointer = false }: SettleRenderingOptions = {},
) {
  if (parkPointer) await page.mouse.move(10_000, 10_000);
  return page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await document.fonts.ready;
      await frame();
      await frame();
      if (document.fonts.status === 'loaded') {
        return { fontStatus: 'loaded' as const, attempts: attempt, frames: attempt * 2 };
      }
    }
    throw new Error('Document fonts did not settle after 10 two-frame checks.');
  });
}

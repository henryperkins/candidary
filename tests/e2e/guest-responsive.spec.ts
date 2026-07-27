import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

import { stubGuestRoutes } from './fixtures/routes';
import { makeMedia } from './fixtures/ui-data';
import { measureDocument, measureOverflow, measureTarget } from './helpers/geometry';

async function countGridTracks(locator: Locator) {
  return locator.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
}

test('guest secondary sections stay contained at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page, { gallery: makeMedia(6), contributions: makeMedia(4) });

  await page.goto('/event/maya-theo');
  await page.locator('.event-extra summary').filter({ hasText: 'My deliveries' }).click();
  await expect(page.locator('.contributions li')).toHaveCount(4);

  const filenameSize = await measureOverflow(page.locator('.contributions li > span').first());
  expect(filenameSize.scrollWidth).toBeLessThanOrEqual(filenameSize.clientWidth + 1);

  const withDeliveries = await measureDocument(page);
  expect(withDeliveries.scrollWidth).toBeLessThanOrEqual(withDeliveries.clientWidth + 1);

  await page.locator('.event-extra summary').filter({ hasText: 'Shared gallery' }).click();
  await expect(page.locator('.photo-grid figure')).toHaveCount(6);

  const captionSize = await measureOverflow(page.locator('.photo-grid figcaption span').first());
  expect(captionSize.scrollWidth).toBeLessThanOrEqual(captionSize.clientWidth + 1);

  const withGallery = await measureDocument(page);
  expect(withGallery.scrollWidth).toBeLessThanOrEqual(withGallery.clientWidth + 1);
});

test('the full-screen gallery stays contained with a reachable close target at 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await stubGuestRoutes(page, { gallery: makeMedia(3) });

  await page.goto('/event/maya-theo/fullscreen');
  await expect(page.locator('.fullscreen figure')).toHaveCount(3);

  const captionSize = await measureOverflow(page.locator('.fullscreen figcaption').first());
  expect(captionSize.scrollWidth).toBeLessThanOrEqual(captionSize.clientWidth + 1);

  const documentSize = await measureDocument(page);
  expect(documentSize.scrollWidth).toBeLessThanOrEqual(documentSize.clientWidth + 1);

  const closeSize = await measureTarget(page.getByRole('link', { name: 'Close full-screen gallery' }));
  expect(closeSize.width).toBeGreaterThanOrEqual(44);
  expect(closeSize.height).toBeGreaterThanOrEqual(44);
});

test('guest media grids widen at the 761 px enhancement boundary', async ({ page }) => {
  await stubGuestRoutes(page, { gallery: makeMedia(6) });

  for (const width of [761, 768]) {
    await page.setViewportSize({ width, height: 900 });

    await page.goto('/event/maya-theo');
    await page.locator('.event-extra summary').filter({ hasText: 'Shared gallery' }).click();
    await expect(page.locator('.photo-grid figure')).toHaveCount(6);
    expect(await countGridTracks(page.locator('.photo-grid'))).toBe(12);

    const gallerySize = await measureDocument(page);
    expect(gallerySize.scrollWidth).toBeLessThanOrEqual(gallerySize.clientWidth + 1);

    await page.goto('/event/maya-theo/fullscreen');
    await expect(page.locator('.fullscreen figure')).toHaveCount(6);
    expect(await countGridTracks(page.locator('.fullscreen__grid'))).toBe(3);

    const fullscreenSize = await measureDocument(page);
    expect(fullscreenSize.scrollWidth).toBeLessThanOrEqual(fullscreenSize.clientWidth + 1);
  }
});

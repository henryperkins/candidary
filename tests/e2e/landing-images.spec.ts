import { expect, test } from '@playwright/test';
import type { Response } from '@playwright/test';

import { settleRendering } from './helpers/rendering';

test('the approved homepage photographs load as lightweight WebP in every consumer', async ({ page }, testInfo) => {
  const photoResponses = new Map<string, Response>();
  const legacyRequests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (request) => {
    if (/\/assets\/photos\/sq-(03|06)\.png$/u.test(request.url())) legacyRequests.push(request.url());
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (/\/assets\/photos\/sq-(03|06)\.webp$/u.test(path)) photoResponses.set(path, response);
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page).toHaveTitle(/Candidary/u);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);

  const heroPhotos = page.locator('.hero__print img');
  await expect(heroPhotos).toHaveCount(2);
  for (const image of await heroPhotos.all()) {
    await image.evaluate((element) => (element as HTMLImageElement).decode());
    expect(await image.evaluate((element) => ({
      width: (element as HTMLImageElement).naturalWidth,
      height: (element as HTMLImageElement).naturalHeight,
    }))).toEqual({ width: 768, height: 768 });
  }
  await settleRendering(page);
  await page.locator('.hero').screenshot({
    path: testInfo.outputPath('optimized-hero.png'),
    style: '.page-header { visibility: hidden !important; }',
  });

  const demo = page.locator('.journey-demo');
  for (const moment of ['During', 'After']) {
    await demo.getByRole('button', { name: moment, exact: true }).click();
    await expect(demo).toHaveAttribute('data-moment', moment.toLowerCase());
    const scene = demo.locator('.journey-demo__sheet[aria-hidden="false"]');
    const images = scene.locator('img[src$=".webp"]');
    await expect(images).toHaveCount(2);
    for (const image of await images.all()) {
      await image.evaluate((element) => (element as HTMLImageElement).decode());
      await expect(image).toBeVisible();
    }
  }
  await settleRendering(page);
  await demo.screenshot({
    path: testInfo.outputPath('optimized-private-collection.png'),
    style: '.page-header { visibility: hidden !important; } .journey-demo__toolbar { position: relative !important; top: 0 !important; }',
  });

  expect([...photoResponses.keys()].sort()).toEqual(['/assets/photos/sq-03.webp', '/assets/photos/sq-06.webp']);
  let photoBytes = 0;
  for (const response of photoResponses.values()) {
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/webp');
    photoBytes += (await response.body()).length;
  }
  // These decorative prints previously cost 4.32 MB. Keep their combined payload under 300 KB.
  expect(photoBytes).toBeLessThan(300_000);
  expect(legacyRequests).toEqual([]);
  expect(errors).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
